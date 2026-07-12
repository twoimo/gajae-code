import {
	type Component,
	capViewportRows,
	isViewportRowComponent,
	recordFrameAllocationRowArray,
	type ViewportRowComponent,
	type ViewportRowMetadata,
	type ViewportRowWindow,
} from "../tui";

import { applyBackgroundToLine, padding, visibleWidth } from "../utils";

type Cache = {
	key: bigint | number;
	result: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements ViewportRowComponent {
	children: Component[] = [];
	#disposed = false;
	#paddingX: number;
	#paddingY: number;
	#bgFn?: (text: string) => string;

	// Cache for rendered output
	#cached?: Cache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#bgFn = bgFn;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.#invalidateCache();
	}

	/** Register extension-owned render-only content with a bounded viewport estimate. */
	addCappedChild(component: Component, maxRows: number): ViewportRowComponent {
		const capped = capViewportRows(component, maxRows);
		this.addChild(capped);
		return capped;
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#invalidateCache();
			component.dispose?.();
		}
	}

	/** Remove a child without disposing it (for detach-then-readd reuse). */
	detachChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.#invalidateCache();
		}
	}

	clear(): void {
		for (const child of this.children) {
			child.dispose?.();
		}
		this.children = [];
		this.#invalidateCache();
	}

	/** Remove all children without disposing them (for detach-then-readd reuse). */
	detachAll(): void {
		this.children = [];
		this.#invalidateCache();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const child of this.children) {
			child.dispose?.();
		}
		this.#invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.#bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	#invalidateCache(): void {
		this.#cached = undefined;
	}

	static #tmp = new Uint32Array(2);
	#computeCacheKey(width: number, childLines: string[], bgSample: string | undefined): bigint | number {
		Box.#tmp[0] = width;
		Box.#tmp[1] = childLines.length;
		let h = Bun.hash(Box.#tmp);
		for (const line of childLines) {
			h = Bun.hash(line, h);
		}
		if (bgSample) {
			h = Bun.hash(bgSample, h);
		}
		return h;
	}

	#matchCache(cacheKey: bigint | number): boolean {
		return this.#cached?.key === cacheKey;
	}

	invalidate(): void {
		this.#invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	getLogicalRowCount(width: number): number {
		if (this.children.length === 0) return 0;
		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		let rows = 0;
		for (const child of this.children) {
			rows += isViewportRowComponent(child)
				? child.getLogicalRowCount(contentWidth)
				: child.render(contentWidth).length;
		}
		return rows === 0 ? 0 : rows + this.#paddingY * 2;
	}

	renderRows(width: number, start: number, end: number): string[] {
		return this.renderRowsWithMetadata(width, start, end).lines;
	}

	renderRowsWithMetadata(width: number, start: number, end: number): ViewportRowWindow {
		const count = this.getLogicalRowCount(width);
		const from = Math.max(0, Math.min(start, count));
		const to = Math.max(from, Math.min(end, count));
		if (from === to) return { lines: [], metadata: [] };

		const lines: string[] = [];
		const metadata: Array<ViewportRowMetadata | null> = [];
		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		const leftPad = padding(this.#paddingX);
		for (let row = from; row < Math.min(to, this.#paddingY); row++) {
			lines.push(this.#applyBg("", width));
			metadata.push(null);
		}
		let offset = this.#paddingY;
		for (const child of this.children) {
			const childCount = isViewportRowComponent(child)
				? child.getLogicalRowCount(contentWidth)
				: child.render(contentWidth).length;
			const childStart = Math.max(0, from - offset);
			const childEnd = Math.min(childCount, to - offset);
			if (childStart < childEnd) {
				const rendered = isViewportRowComponent(child)
					? (child.renderRowsWithMetadata?.(contentWidth, childStart, childEnd) ?? {
							lines: child.renderRows(contentWidth, childStart, childEnd),
							metadata: Array<ViewportRowMetadata | null>(childEnd - childStart).fill(null),
						})
					: (() => {
							const childLines = child.render(contentWidth).slice(childStart, childEnd);
							return {
								lines: childLines,
								metadata: Array<ViewportRowMetadata | null>(childLines.length).fill(null),
							};
						})();
				const childMetadata =
					rendered.lines.length === rendered.metadata.length
						? rendered.metadata
						: rendered.lines.map((_, row) => rendered.metadata[row] ?? null);

				recordFrameAllocationRowArray(rendered.lines, "box-child-return");
				for (let row = 0; row < rendered.lines.length; row++) {
					lines.push(this.#applyBg(leftPad + rendered.lines[row]!, width));
					metadata.push(childMetadata[row]!);
				}
			}
			offset += childCount;
			if (offset >= to) break;
		}
		for (let row = Math.max(from, offset); row < to; row++) {
			lines.push(this.#applyBg("", width));
			metadata.push(null);
		}
		recordFrameAllocationRowArray(lines, "box-output");
		return { lines, metadata };
	}

	getViewportSourceIds(): readonly string[] {
		return this.children.flatMap(child =>
			isViewportRowComponent(child) ? (child.getViewportSourceIds?.() ?? []) : [],
		);
	}

	reconcileLogicalRowCount(width: number): number {
		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		for (const child of this.children) {
			if (isViewportRowComponent(child)) child.reconcileLogicalRowCount?.(contentWidth);
		}
		return this.getLogicalRowCount(width);
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		const leftPad = padding(this.#paddingX);

		// Render all children
		const childLines: string[] = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.#bgFn ? this.#bgFn("test") : undefined;

		const cacheKey = this.#computeCacheKey(width, childLines, bgSample);

		// Check cache validity
		if (this.#matchCache(cacheKey)) {
			return this.#cached!.result;
		}

		// Apply background and padding
		const result: string[] = [];

		// Top padding
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(this.#applyBg("", width));
		}

		// Content
		for (const line of childLines) {
			result.push(this.#applyBg(line, width));
		}

		// Bottom padding
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(this.#applyBg("", width));
		}

		// Update cache
		this.#cached = { key: cacheKey, result };

		return result;
	}

	#applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + padding(padNeeded);

		if (this.#bgFn) {
			return applyBackgroundToLine(padded, width, this.#bgFn);
		}
		return padded;
	}
}
