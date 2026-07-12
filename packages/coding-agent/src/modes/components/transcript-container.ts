import {
	type Component,
	Container,
	isViewportRowComponent,
	recordFrameAllocationObjects,
	recordFrameAllocationRowArray,
	type ViewportDirtyRange,
	type ViewportRowMetadata,
	type ViewportRowWindow,
} from "@gajae-code/tui";

type TranscriptRow = {
	component: Component;
	id: number;
	start: number;
	end: number;
	revision: number;
};

/**
 * Row-addressable chat transcript. It retains the component tree as the
 * canonical transcript, while keeping only compact row boundaries for the
 * viewport renderer. Rendered lines are deliberately never cached here.
 */
export class TranscriptContainer extends Container {
	readonly isViewportSource = true as const;
	#rows: TranscriptRow[] = [];
	#width = 0;
	#nextId = 0;
	#dirtyRanges: ViewportDirtyRange[] = [];
	#rowIndexes = new Map<Component, number>();
	#staleRowIndexes = new Set<number>();
	#componentIds = new WeakMap<Component, number>();
	#sourceComponents = new Map<string, Component>();

	#rowCountCache = new Map<Component, Map<number, number>>();
	override addChild(component: Component): void {
		super.addChild(component);
		if (this.#width > 0 || (isViewportRowComponent(component) && component.rowCountIsWidthInvariant)) {
			this.#appendRow(component);
			return;
		}
		// Width-dependent rows cannot be indexed accurately before the first viewport width is known.
		this.#invalidateIndex({ start: 0, end: Math.max(1, this.#rowCount()) });
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index === -1) return;
		const start = this.#rows[index]?.start ?? 0;
		super.removeChild(component);
		this.#invalidateIndex({ start, end: Number.MAX_SAFE_INTEGER });
	}

	override detachChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index === -1) return;
		const start = this.#rows[index]?.start ?? 0;
		super.detachChild(component);
		this.#invalidateIndex({ start, end: Number.MAX_SAFE_INTEGER });
	}

	override clear(): void {
		const end = this.#rowCount();
		super.clear();
		this.#rows = [];
		this.#rowIndexes.clear();
		this.#queueDirtyRange({ start: 0, end });
	}

	override detachAll(): void {
		const end = this.#rowCount();
		super.detachAll();
		this.#rows = [];
		this.#rowIndexes.clear();
		this.#queueDirtyRange({ start: 0, end });
	}

	override invalidate(): void {
		super.invalidate();
		this.#invalidateIndex({ start: 0, end: Math.max(1, this.#rowCount()) });
	}

	/** Notify the row index that a retained child changed without being replaced. */
	markChildDirty(component: Component): void {
		this.#ensureIndex(this.#width || 1);
		const index = this.#rowIndexes.get(component);
		if (index === undefined) return;
		this.#staleRowIndexes.delete(index);
		this.#rowCountCache.delete(component);
		this.#updateRowCount(index, this.#rowCountFor(component, this.#width));
	}

	getLogicalRowCount(width: number): number {
		this.#ensureIndex(width);
		return this.#rowCount();
	}

	prepareBottomViewport(width: number, rows: number): void {
		this.#ensureIndex(width);
		let remaining = Math.max(1, rows);
		for (let index = this.#rows.length - 1; index >= 0 && remaining > 0; index--) {
			const row = this.#rows[index];
			if (this.#staleRowIndexes.delete(index)) {
				this.#updateRowCount(index, this.#rowCountFor(row.component, width));
			}
			const actualCount = isViewportRowComponent(row.component)
				? row.component.reconcileLogicalRowCount?.(width)
				: undefined;
			if (actualCount !== undefined && actualCount !== this.#rows[index].end - this.#rows[index].start) {
				this.#updateRowCount(index, actualCount);
			}
			remaining -= this.#rows[index].end - this.#rows[index].start;
		}
	}

	renderRows(width: number, start: number, end: number): string[] {
		return this.renderRowsWithMetadata(width, start, end).lines;
	}

	renderRowsWithMetadata(width: number, start: number, end: number): ViewportRowWindow {
		return this.#renderRowsWithMetadata(width, start, end, false);
	}

	#renderRowsWithMetadata(width: number, start: number, end: number, reconciled: boolean): ViewportRowWindow {
		this.#ensureIndex(width);
		const boundedStart = Math.max(0, Math.min(start, this.#rowCount()));
		const boundedEnd = Math.max(boundedStart, Math.min(end, this.#rowCount()));
		if (boundedStart === boundedEnd) return { lines: [], metadata: [] };

		let first = this.#findRow(boundedStart);
		let last = this.#findRow(boundedEnd - 1);
		if (first === -1 || last === -1) return { lines: [], metadata: [] };
		this.#refreshRowCounts(width, first, last);
		first = this.#findRow(boundedStart);
		last = this.#findRow(boundedEnd - 1);
		if (first === -1 || last === -1) return { lines: [], metadata: [] };
		const lines: string[] = [];
		const metadata: Array<ViewportRowMetadata | null> = [];

		let rowCountChanged = false;
		for (let index = first; index <= last; index++) {
			const row = this.#rows[index]!;
			const childStart = Math.max(0, boundedStart - row.start);
			const childEnd = Math.max(childStart, boundedEnd - row.start);
			const rendered = isViewportRowComponent(row.component)
				? (row.component.renderRowsWithMetadata?.(width, childStart, childEnd) ?? {
						lines: row.component.renderRows(width, childStart, childEnd),
						metadata: Array<ViewportRowMetadata | null>(childEnd - childStart).fill(null),
					})
				: (() => {
						const allRows = row.component.render(width);
						const slice = allRows.slice(childStart, childEnd);
						return { lines: slice, metadata: Array<ViewportRowMetadata | null>(slice.length).fill(null) };
					})();
			const rowMetadata =
				rendered.lines.length === rendered.metadata.length
					? rendered.metadata
					: rendered.lines.map((_, local) => rendered.metadata[local] ?? null);
			recordFrameAllocationRowArray(rendered.lines, "transcript-child-return");
			recordFrameAllocationRowArray(rendered.lines, "transcript-child-slice");

			const actualCount = isViewportRowComponent(row.component)
				? row.component.reconcileLogicalRowCount?.(width)
				: row.component.render(width).length;
			if (actualCount !== undefined && actualCount !== row.end - row.start) {
				this.#updateRowCount(index, actualCount);
				rowCountChanged = true;
			}
			const current = this.#rows[index]!;
			for (let local = 0; local < rendered.lines.length; local++) {
				lines.push(rendered.lines[local]!);
				const item = rowMetadata[local];
				const next = item
					? {
							...item,
							identity: item.identity ?? `${current.id}:${childStart + local}`,
							revision: item.revision ?? current.revision,
						}
					: {
							identity: `${current.id}:${childStart + local}`,
							revision: current.revision,
						};
				metadata.push(next);
				if (next.sourceId !== undefined) this.#sourceComponents.set(next.sourceId, current.component);
			}
		}
		if (rowCountChanged && !reconciled) {
			recordFrameAllocationRowArray(lines, "transcript-output");
			return this.#renderRowsWithMetadata(width, start, end, true);
		}
		recordFrameAllocationRowArray(lines, "transcript-output");
		return { lines, metadata };
	}

	resolveViewportAnchor(sourceId: string, graphemeIndex: number, width: number): number | undefined {
		this.#ensureIndex(width);
		const component = this.#sourceComponents.get(sourceId);
		if (!component) return undefined;
		const index = this.#rowIndexes.get(component);
		if (index === undefined) return undefined;
		const row = this.#rows[index]!;
		const count = row.end - row.start;
		if (isViewportRowComponent(component)) {
			const local = component.resolveViewportAnchor?.(sourceId, graphemeIndex, width);
			if (local !== undefined && local >= 0 && local < count) return row.start + local;
		}
		let low = 0;
		let high = count - 1;
		while (low <= high) {
			const middle = low + Math.floor((high - low) / 2);
			const window = this.#componentWindow(component, width, middle, middle + 1);
			const metadata = window.metadata[0];
			if (
				metadata?.sourceId !== sourceId ||
				metadata.graphemeStart === undefined ||
				metadata.graphemeEnd === undefined
			) {
				break;
			}
			if (graphemeIndex < metadata.graphemeStart) high = middle - 1;
			else if (graphemeIndex >= metadata.graphemeEnd) low = middle + 1;
			else return row.start + middle;
		}
		const from = Math.max(0, low - 8);
		const to = Math.min(count, Math.max(from + 1, low + 9));
		const window = this.#componentWindow(component, width, from, to);
		for (let local = 0; local < window.metadata.length; local++) {
			const metadata = window.metadata[local];
			if (
				metadata?.sourceId === sourceId &&
				metadata.graphemeStart !== undefined &&
				metadata.graphemeEnd !== undefined &&
				metadata.graphemeStart <= graphemeIndex &&
				graphemeIndex < metadata.graphemeEnd
			) {
				return row.start + from + local;
			}
		}
		return undefined;
	}

	#componentWindow(component: Component, width: number, start: number, end: number): ViewportRowWindow {
		if (!isViewportRowComponent(component)) {
			const lines = component.render(width).slice(start, end);
			return { lines, metadata: Array<ViewportRowMetadata | null>(lines.length).fill(null) };
		}
		return (
			component.renderRowsWithMetadata?.(width, start, end) ?? {
				lines: component.renderRows(width, start, end),
				metadata: Array<ViewportRowMetadata | null>(Math.max(0, end - start)).fill(null),
			}
		);
	}

	getViewportSourceIds(): readonly string[] {
		return [...this.#sourceComponents.keys()];
	}

	getDirtyRanges(): readonly ViewportDirtyRange[] {
		const dirty = this.#dirtyRanges;
		this.#dirtyRanges = [];
		return dirty;
	}

	#ensureIndex(width: number): void {
		const normalizedWidth = Math.max(1, width);
		if (this.#rows.length !== this.children.length) {
			const previousRows = this.#rowCount();
			this.#width = normalizedWidth;
			this.#rows = [];
			this.#rowIndexes.clear();
			this.#staleRowIndexes.clear();
			this.#sourceComponents.clear();

			for (const component of this.children) this.#appendRow(component, true);
			this.#queueDirtyRange({ start: 0, end: Math.max(previousRows, this.#rowCount()) });
			return;
		}
		if (this.#width !== normalizedWidth) {
			this.#width = normalizedWidth;
			for (let index = 0; index < this.#rows.length; index++) {
				const component = this.#rows[index].component;
				if (!isViewportRowComponent(component) || !component.rowCountIsWidthInvariant) {
					this.#staleRowIndexes.add(index);
				}
			}
			this.#queueDirtyRange({ start: 0, end: this.#rowCount() });
		}
	}

	#refreshRowCounts(width: number, first: number, last: number): void {
		for (let index = first; index <= last; index++) {
			if (!this.#staleRowIndexes.delete(index)) continue;
			const row = this.#rows[index];
			this.#updateRowCount(index, this.#rowCountFor(row.component, width));
		}
	}

	#appendRow(component: Component, accountIndexAllocations = false): void {
		const start = this.#rowCount();
		const end = start + this.#rowCountFor(component, this.#width, accountIndexAllocations);
		let id = this.#componentIds.get(component);
		if (id === undefined) {
			id = this.#nextId++;
			this.#componentIds.set(component, id);
		}
		this.#rows.push({ component, id, start, end, revision: 0 });
		if (accountIndexAllocations) recordFrameAllocationObjects(2, "transcript-row-index");
		this.#rowIndexes.set(component, this.#rows.length - 1);
		for (const sourceId of (isViewportRowComponent(component) ? component.getViewportSourceIds?.() : undefined) ??
			[]) {
			this.#sourceComponents.set(sourceId, component);
			if (accountIndexAllocations) recordFrameAllocationObjects(1, "transcript-source-index");
		}
		this.#queueDirtyRange({ start, end });
	}

	#rowCountFor(component: Component, width: number, accountIndexAllocations = false): number {
		const normalizedWidth = Math.max(1, width);
		const cached = this.#rowCountCache.get(component)?.get(normalizedWidth);
		if (cached !== undefined) return cached;
		const count = isViewportRowComponent(component)
			? component.getLogicalRowCount(normalizedWidth)
			: component.render(normalizedWidth).length;
		let cache = this.#rowCountCache.get(component);
		if (!cache) {
			cache = new Map();
			this.#rowCountCache.set(component, cache);
			if (accountIndexAllocations) recordFrameAllocationObjects(1, "transcript-row-count-cache");
		}
		cache.set(normalizedWidth, count);
		if (accountIndexAllocations) recordFrameAllocationObjects(1, "transcript-row-count-cache");
		if (cache.size > 2) cache.delete(cache.keys().next().value!);
		return count;
	}

	#updateRowCount(index: number, count: number): void {
		const row = this.#rows[index];
		const previousEnd = row.end;
		const delta = count - (row.end - row.start);
		row.end = row.start + count;
		row.revision++;
		if (delta !== 0) {
			for (let cursor = index + 1; cursor < this.#rows.length; cursor++) {
				this.#rows[cursor].start += delta;
				this.#rows[cursor].end += delta;
			}
		}
		this.#queueDirtyRange({ start: row.start, end: Math.max(previousEnd, row.end) });
	}

	#findRow(row: number): number {
		let low = 0;
		let high = this.#rows.length - 1;
		while (low <= high) {
			const middle = low + Math.floor((high - low) / 2);
			const candidate = this.#rows[middle];
			if (row < candidate.start) high = middle - 1;
			else if (row >= candidate.end) low = middle + 1;
			else return middle;
		}
		return -1;
	}

	#rowCount(): number {
		return this.#rows.at(-1)?.end ?? 0;
	}

	#queueDirtyRange(range: ViewportDirtyRange): void {
		if (range.end <= range.start) return;
		let index = 0;
		while (index < this.#dirtyRanges.length && this.#dirtyRanges[index].end < range.start) index++;
		let start = range.start;
		let end = range.end;
		while (index < this.#dirtyRanges.length && this.#dirtyRanges[index].start <= end) {
			const dirty = this.#dirtyRanges[index];
			start = Math.min(start, dirty.start);
			end = Math.max(end, dirty.end);
			this.#dirtyRanges.splice(index, 1);
		}
		this.#dirtyRanges.splice(index, 0, { start, end });
	}

	#invalidateIndex(range: ViewportDirtyRange = { start: 0, end: Number.MAX_SAFE_INTEGER }): void {
		this.#rows = [];
		this.#rowIndexes.clear();
		this.#staleRowIndexes.clear();
		this.#sourceComponents.clear();
		this.#rowCountCache.clear();
		this.#width = 0;
		this.#queueDirtyRange(range);
	}
}
