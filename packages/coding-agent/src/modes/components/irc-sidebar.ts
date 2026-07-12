import {
	isViewportComponent,
	padding,
	recordFrameAllocationRowArray,
	TERMINAL,
	truncateToWidth,
	type ViewportComponent,
	type ViewportRowComponent,
	type ViewportRowMetadata,
	type ViewportRowWindow,
	visibleWidth,
	withTerminalGraphicsFallback,
	wrapTextWithAnsi,
} from "@gajae-code/tui";

import type { IrcObservationLedger, IrcObservationRecord } from "../irc-observation-ledger";
import { formatIrcMessageBlock, projectIrcText } from "../utils/irc-message";

export const IRC_SIDEBAR_WIDTH_RATIO = 0.3;
const IRC_SIDEBAR_MIN_WIDTH = 30;
const IRC_SEPARATOR_WIDTH = 3;
export const IRC_SIDEBAR_MAX_RENDER_ROWS = 2_048;
const IRC_SIDEBAR_MAX_RENDER_SOURCE_UTF8_BYTES = 64 * 1_024;
const IRC_SIDEBAR_OLDER_MESSAGES_ELISION = "… older IRC messages elided …";
const IRC_SIDEBAR_MESSAGE_ELISION = "  … message elided …";

/** Computes transcript/sidebar widths while preserving at least half the terminal for the transcript. */
export function computeIrcSplitWidths(width: number): {
	leftWidth: number;
	separatorWidth: number;
	rightWidth: number;
} {
	const normalizedWidth = Math.max(0, Math.floor(width));
	const transcriptFloor = Math.floor(normalizedWidth * 0.5);
	const preferredSidebar = Math.max(IRC_SIDEBAR_MIN_WIDTH, Math.floor(normalizedWidth * IRC_SIDEBAR_WIDTH_RATIO));
	const sidebarWidth = Math.max(
		0,
		Math.min(preferredSidebar, normalizedWidth - IRC_SEPARATOR_WIDTH - transcriptFloor),
	);

	// The sidebar yields entirely rather than rendering below its readable minimum.
	if (sidebarWidth < IRC_SIDEBAR_MIN_WIDTH) {
		return { leftWidth: normalizedWidth, separatorWidth: 0, rightWidth: 0 };
	}

	return {
		leftWidth: normalizedWidth - IRC_SEPARATOR_WIDTH - sidebarWidth,
		separatorWidth: IRC_SEPARATOR_WIDTH,
		rightWidth: sidebarWidth,
	};
}

function styleSender(componentTheme: IrcSidebarTheme, sender: string): string {
	return componentTheme.fg("accent", componentTheme.bold(sender));
}

function renderSidebarRecord(
	record: IrcObservationRecord,
	width: number,
	componentTheme: IrcSidebarTheme,
	maxRows: number,
	maxSourceUtf8Bytes: number,
): { lines: string[]; sourceUtf8Bytes: number; truncated: boolean } {
	const bodyWidth = Math.max(1, width - 2);
	const sourceLimit = Math.min(maxSourceUtf8Bytes, Math.max(0, maxRows - 1) * bodyWidth);
	const clipped = projectIrcText(record.text, sourceLimit);
	const block = formatIrcMessageBlock({ ...record, text: clipped.text });
	const sender = styleSender(componentTheme, block.sender);
	const time = componentTheme.fg("dim", block.time);
	const lines = [truncateToWidth(`${sender} → ${block.recipient} · ${time}`, width)];
	let truncated = clipped.truncated;

	body: for (const bodyLine of block.bodyLines) {
		for (const wrappedLine of wrapTextWithAnsi(bodyLine, bodyWidth)) {
			if (lines.length >= maxRows) {
				truncated = true;
				break body;
			}
			lines.push(truncateToWidth(`  ${wrappedLine}`, width));
		}
	}
	if (truncated && maxRows > 1) {
		const marker = componentTheme.fg("dim", IRC_SIDEBAR_MESSAGE_ELISION);
		if (lines.length >= maxRows) lines[maxRows - 1] = truncateToWidth(marker, width);
		else lines.push(truncateToWidth(marker, width));
	}
	return { lines, sourceUtf8Bytes: clipped.utf8Bytes, truncated };
}

function renderSidebarRecords(ledger: IrcObservationLedger, width: number, componentTheme: IrcSidebarTheme): string[] {
	if (width <= 0) return [];

	const records = ledger.getSidebarRecords();
	const newestFirstBlocks: string[][] = [];
	let renderedRows = 0;
	let renderedSourceUtf8Bytes = 0;
	let omittedOlderRecords = false;
	for (let index = records.length - 1; index >= 0; index--) {
		const separatorRows = newestFirstBlocks.length > 0 ? 1 : 0;
		const availableRows = IRC_SIDEBAR_MAX_RENDER_ROWS - renderedRows - separatorRows - 2;
		const availableSourceUtf8Bytes = IRC_SIDEBAR_MAX_RENDER_SOURCE_UTF8_BYTES - renderedSourceUtf8Bytes;
		const minimumRecordRows = records[index].text.length > 0 ? 2 : 1;
		if (availableRows < minimumRecordRows || (availableSourceUtf8Bytes <= 0 && records[index].text.length > 0)) {
			omittedOlderRecords = true;
			break;
		}

		const rendered = renderSidebarRecord(
			records[index],
			width,
			componentTheme,
			availableRows,
			availableSourceUtf8Bytes,
		);
		newestFirstBlocks.push(rendered.lines);
		renderedRows += separatorRows + rendered.lines.length;
		renderedSourceUtf8Bytes += rendered.sourceUtf8Bytes;
		if (rendered.truncated) {
			omittedOlderRecords = index > 0;
			break;
		}
	}

	const lines: string[] = [];
	if (omittedOlderRecords) {
		lines.push(truncateToWidth(componentTheme.fg("dim", IRC_SIDEBAR_OLDER_MESSAGES_ELISION), width));
	}
	for (const block of newestFirstBlocks.reverse()) {
		if (lines.length > 0) lines.push("");
		lines.push(...block);
	}
	return lines.slice(0, IRC_SIDEBAR_MAX_RENDER_ROWS);
}

export interface IrcSidebarTheme {
	fg(color: "dim" | "accent", text: string): string;
	bold(text: string): string;
	readonly boxSharp: { readonly vertical: string };
}

export type IrcSidebarThemeSource = IrcSidebarTheme | (() => IrcSidebarTheme);

/** Read-only IRC history alongside the active transcript. */
export class IrcSplitViewComponent implements ViewportComponent {
	#visible = false;
	readonly isViewportSource = true as const;

	constructor(
		private readonly leftPane: ViewportRowComponent,
		private readonly ledger: IrcObservationLedger,
		private readonly componentTheme: IrcSidebarThemeSource,
	) {}

	get visible(): boolean {
		return this.#visible;
	}

	effectiveSidebarVisible(width = process.stdout.columns ?? 0): boolean {
		return this.#visible && computeIrcSplitWidths(width).rightWidth > 0;
	}

	setVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	getLogicalRowCount(width: number): number {
		if (!this.effectiveSidebarVisible(width)) return this.leftPane.getLogicalRowCount(width);
		const { leftWidth, rightWidth } = computeIrcSplitWidths(width);
		return Math.max(
			this.#leftLogicalRowCountWithGraphicsFallback(leftWidth),
			renderSidebarRecords(this.ledger, rightWidth, this.#theme()).length,
		);
	}

	renderRows(width: number, start: number, end: number): string[] {
		return this.renderRowsWithMetadata(width, start, end).lines;
	}

	#renderLeftRowsWithMetadata(width: number, start: number, end: number): ViewportRowWindow {
		const rendered = this.leftPane.renderRowsWithMetadata?.(width, start, end);
		if (rendered) return rendered;
		const lines = this.leftPane.renderRows(width, start, end);
		return { lines, metadata: Array<ViewportRowMetadata | null>(lines.length).fill(null) };
	}

	#leftLogicalRowCountWithGraphicsFallback(width: number): number {
		return withTerminalGraphicsFallback(() => this.leftPane.getLogicalRowCount(width), {
			allowCursorNeutralImages: true,
		});
	}

	renderRowsWithMetadata(width: number, start: number, end: number): ViewportRowWindow {
		if (!this.effectiveSidebarVisible(width)) return this.#renderLeftRowsWithMetadata(width, start, end);

		const componentTheme = this.#theme();
		const { leftWidth, separatorWidth, rightWidth } = computeIrcSplitWidths(width);
		const leftCount = this.#leftLogicalRowCountWithGraphicsFallback(leftWidth);
		const rightLines = renderSidebarRecords(this.ledger, rightWidth, componentTheme);
		const lineCount = Math.max(leftCount, rightLines.length);
		const from = Math.max(0, Math.min(start, lineCount));
		const to = Math.max(from, Math.min(end, lineCount));
		if (from === to) return { lines: [], metadata: [] };

		const leftOffset = lineCount - leftCount;
		const rightOffset = lineCount - rightLines.length;
		const leftStart = Math.max(0, from - leftOffset);
		const leftEnd = Math.min(leftCount, to - leftOffset);
		const left =
			leftStart < leftEnd
				? withTerminalGraphicsFallback(() => this.#renderLeftRowsWithMetadata(leftWidth, leftStart, leftEnd), {
						allowCursorNeutralImages: true,
					})
				: { lines: [], metadata: [] };
		if (left.lines.length !== left.metadata.length)
			throw new Error("IRC left-pane metadata does not match rendered rows");
		const separator = separatorWidth > 0 ? componentTheme.fg("dim", ` ${componentTheme.boxSharp.vertical} `) : "";
		const lines: string[] = [];
		const metadata: Array<ViewportRowMetadata | null> = [];
		for (let row = from; row < to; row++) {
			const leftIndex = row - leftOffset;
			const local = leftIndex - leftStart;
			const leftRaw = left.lines[local] ?? "";
			const right = truncateToWidth(rightLines[row - rightOffset] ?? "", rightWidth);
			if (TERMINAL.isImageLine(leftRaw)) {
				lines.push(leftRaw + padding(leftWidth) + separator + right);
			} else {
				const clipped = truncateToWidth(leftRaw, leftWidth);
				lines.push(clipped + padding(Math.max(0, leftWidth - visibleWidth(clipped))) + separator + right);
			}
			metadata.push(left.metadata[local] ?? null);
		}
		recordFrameAllocationRowArray(lines, "irc-split-output");
		return { lines, metadata };
	}

	resolveViewportAnchor(sourceId: string, graphemeIndex: number, width: number): number | undefined {
		const resolver = this.leftPane as Partial<ViewportComponent>;
		if (typeof resolver.resolveViewportAnchor !== "function") return undefined;
		const leftWidth = this.effectiveSidebarVisible(width) ? computeIrcSplitWidths(width).leftWidth : width;
		const row = resolver.resolveViewportAnchor(sourceId, graphemeIndex, leftWidth);
		if (row === undefined) return undefined;
		if (!this.effectiveSidebarVisible(width)) return row;
		return row + this.getLogicalRowCount(width) - this.leftPane.getLogicalRowCount(leftWidth);
	}

	prepareBottomViewport(width: number, rows: number): void {
		if (!isViewportComponent(this.leftPane)) return;
		const { leftWidth } = computeIrcSplitWidths(width);
		this.leftPane.prepareBottomViewport?.(this.effectiveSidebarVisible(width) ? leftWidth : width, rows);
	}

	getViewportSourceIds(): readonly string[] {
		return this.leftPane.getViewportSourceIds?.() ?? [];
	}

	#theme(): IrcSidebarTheme {
		return typeof this.componentTheme === "function" ? this.componentTheme() : this.componentTheme;
	}

	render(width: number): string[] {
		return this.renderRows(width, 0, this.getLogicalRowCount(width));
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
	}
}
