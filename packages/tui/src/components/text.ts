import type { ViewportRowComponent, ViewportRowMetadata, ViewportRowWindow } from "../tui";

import {
	annotateViewportAnchorGraphemes,
	applyBackgroundToLine,
	extractViewportAnchorRows,
	padding,
	replaceTabs,
	type ViewportAnchorSpan,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements ViewportRowComponent {
	#text: string;
	#paddingX: number; // Left/right padding
	#paddingY: number; // Top/bottom padding
	#customBgFn?: (text: string) => string;

	// Cache for rendered output
	#cachedText?: string;
	#cachedWidth?: number;
	#cachedLines?: string[];
	#cachedAnchorSpans?: Array<ViewportAnchorSpan | null>;

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
		this.#customBgFn = customBgFn;
	}

	getText(): string {
		return this.#text;
	}

	setText(text: string): void {
		this.#text = text;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#cachedAnchorSpans = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.#customBgFn = customBgFn;
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#cachedAnchorSpans = undefined;
	}

	invalidate(): void {
		this.#cachedText = undefined;
		this.#cachedWidth = undefined;
		this.#cachedLines = undefined;
		this.#cachedAnchorSpans = undefined;
	}

	render(width: number): string[] {
		return this.#render(width, false).lines;
	}

	#render(width: number, includeAnchors: boolean): { lines: string[]; spans?: Array<ViewportAnchorSpan | null> } {
		if (
			this.#cachedLines &&
			this.#cachedText === this.#text &&
			this.#cachedWidth === width &&
			(!includeAnchors || this.#cachedAnchorSpans !== undefined)
		) {
			return { lines: this.#cachedLines, spans: this.#cachedAnchorSpans };
		}

		if (!this.#text || this.#text.trim() === "") {
			const result: string[] = [];
			this.#cachedText = this.#text;
			this.#cachedWidth = width;
			this.#cachedLines = result;
			this.#cachedAnchorSpans = includeAnchors ? [] : undefined;
			return { lines: result, spans: this.#cachedAnchorSpans };
		}

		const normalizedText = replaceTabs(this.#text);
		const contentWidth = Math.max(1, width - this.#paddingX * 2);
		let wrappedLines: string[];
		let wrappedSpans: Array<ViewportAnchorSpan | null> | undefined;
		if (includeAnchors) {
			const markedText = annotateViewportAnchorGraphemes(normalizedText);
			const extracted = extractViewportAnchorRows(wrapTextWithAnsi(markedText.text, contentWidth), markedText.token);
			wrappedLines = extracted.lines;
			wrappedSpans = extracted.spans;
		} else {
			wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);
		}
		if (!normalizedText.includes("\n") && !normalizedText.includes("\r")) {
			const coalesced = this.#coalesceWrappedRows(contentWidth, wrappedLines, wrappedSpans);
			wrappedLines = coalesced.lines;
			wrappedSpans = coalesced.spans;
		}

		const leftMargin = padding(this.#paddingX);
		const rightMargin = padding(this.#paddingX);
		const contentLines: string[] = [];
		for (const line of wrappedLines) {
			const lineWithMargins = leftMargin + line + rightMargin;
			if (this.#customBgFn) contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.#customBgFn));
			else contentLines.push(lineWithMargins + padding(Math.max(0, width - visibleWidth(lineWithMargins))));
		}
		const emptyLine = padding(width);
		const emptyLines = Array.from({ length: this.#paddingY }, () =>
			this.#customBgFn ? applyBackgroundToLine(emptyLine, width, this.#customBgFn) : emptyLine,
		);
		const result = [...emptyLines, ...contentLines, ...emptyLines];
		const spans = wrappedSpans && [...emptyLines.map(() => null), ...wrappedSpans, ...emptyLines.map(() => null)];
		this.#cachedText = this.#text;
		this.#cachedWidth = width;
		this.#cachedLines = result;
		this.#cachedAnchorSpans = spans;
		return { lines: result.length > 0 ? result : [""], spans };
	}

	#coalesceWrappedRows(
		width: number,
		lines: string[],
		spans: Array<ViewportAnchorSpan | null> | undefined,
	): { lines: string[]; spans: Array<ViewportAnchorSpan | null> | undefined } {
		if (lines.length < 2) return { lines, spans };
		const coalescedLines: string[] = [];
		const coalescedSpans = spans ? ([] as Array<ViewportAnchorSpan | null>) : undefined;
		let currentLine = lines[0] ?? "";
		let currentSpan = spans?.[0] ?? null;
		for (let index = 1; index < lines.length; index++) {
			const nextLine = lines[index] ?? "";
			const nextSpan = spans?.[index] ?? null;
			if (
				currentLine.length > 0 &&
				nextLine.length > 0 &&
				visibleWidth(currentLine) + visibleWidth(nextLine) <= width
			) {
				currentLine += nextLine;
				if (currentSpan && nextSpan) {
					currentSpan = {
						graphemeStart: Math.min(currentSpan.graphemeStart, nextSpan.graphemeStart),
						graphemeEnd: Math.max(currentSpan.graphemeEnd, nextSpan.graphemeEnd),
						cellStart: Math.min(currentSpan.cellStart, nextSpan.cellStart),
						cellEnd: Math.max(currentSpan.cellEnd, nextSpan.cellEnd),
					};
				} else {
					currentSpan ??= nextSpan;
				}
				continue;
			}
			coalescedLines.push(currentLine);
			coalescedSpans?.push(currentSpan);
			currentLine = nextLine;
			currentSpan = nextSpan;
		}
		coalescedLines.push(currentLine);
		coalescedSpans?.push(currentSpan);
		return { lines: coalescedLines, spans: coalescedSpans };
	}

	renderRowsWithMetadata(width: number, start: number, end: number): ViewportRowWindow {
		const { lines, spans } = this.#render(width, true);
		if (!spans) throw new Error("Text bounded metadata render completed without row spans");
		const from = Math.max(0, start);
		const to = Math.max(from, end);
		return {
			lines: lines.slice(from, to),
			metadata: spans
				.slice(from, to)
				.map((span): ViewportRowMetadata | null =>
					span ? { identity: undefined, revision: undefined, ...span } : null,
				),
		};
	}

	getLogicalRowCount(width: number): number {
		return this.#render(width, false).lines.length;
	}

	renderRows(width: number, start: number, end: number): string[] {
		return this.#render(width, false).lines.slice(Math.max(0, start), Math.max(0, end));
	}
}
