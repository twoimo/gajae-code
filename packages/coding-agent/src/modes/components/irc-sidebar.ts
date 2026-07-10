import {
	type Component,
	padding,
	renderComponentWithViewportAnchors,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
	type ViewportAnchorProvider,
	type ViewportAnchorRender,
	visibleWidth,
	withTerminalGraphicsFallback,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import type { IrcObservationLedger } from "../irc-observation-ledger";

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(11, 19);
}

function renderSidebarRecords(ledger: IrcObservationLedger, width: number): string[] {
	if (width <= 0) return [];

	const lines: string[] = [];
	for (const record of ledger.getSidebarRecords()) {
		const from = replaceTabs(record.from);
		const to = replaceTabs(record.to);
		const prefix = `[${formatTimestamp(record.timestamp)}] ${from}→${to} `;
		const prefixWidth = visibleWidth(prefix);
		const textWidth = Math.max(1, width - prefixWidth);
		const textLines = wrapTextWithAnsi(replaceTabs(record.text || ""), textWidth);
		for (const [index, text] of textLines.entries()) {
			const line = index === 0 ? prefix + text : padding(prefixWidth) + text;
			lines.push(truncateToWidth(line, width));
		}
	}
	return lines;
}

export interface IrcSidebarTheme {
	fg(color: "dim", text: string): string;
	readonly boxSharp: { readonly vertical: string };
}

export type IrcSidebarThemeSource = IrcSidebarTheme | (() => IrcSidebarTheme);

/** Read-only IRC history alongside the active transcript. */
export class IrcSplitViewComponent implements ViewportAnchorProvider {
	#visible = false;

	constructor(
		private readonly leftPane: Component,
		private readonly ledger: IrcObservationLedger,
		private readonly componentTheme: IrcSidebarThemeSource,
	) {}

	get visible(): boolean {
		return this.#visible;
	}

	setVisible(visible: boolean): void {
		if (this.#visible === visible) return;
		this.#visible = visible;
		this.invalidate();
	}

	render(width: number): string[] {
		return this.renderWithViewportAnchors(width).lines;
	}

	renderWithViewportAnchors(width: number): ViewportAnchorRender {
		if (!this.#visible) return renderComponentWithViewportAnchors(this.leftPane, width);

		const componentTheme = typeof this.componentTheme === "function" ? this.componentTheme() : this.componentTheme;
		const leftWidth = Math.floor(width * 0.5);
		const separatorText = componentTheme.fg("dim", ` ${componentTheme.boxSharp.vertical} `);
		const separatorWidth = width - leftWidth > 3 ? visibleWidth(separatorText) : 0;
		const separator = separatorWidth > 0 ? separatorText : "";
		const rightWidth = Math.max(0, width - leftWidth - separatorWidth);
		const leftRender = withTerminalGraphicsFallback(
			() => renderComponentWithViewportAnchors(this.leftPane, leftWidth),
			{ allowCursorNeutralImages: true },
		);
		const rightLines = renderSidebarRecords(this.ledger, rightWidth);
		const lineCount = Math.max(leftRender.lines.length, rightLines.length);
		const lines: string[] = [];
		const anchors: ViewportAnchorRender["anchors"] = [];

		const leftOffset = lineCount - leftRender.lines.length;
		const rightOffset = lineCount - rightLines.length;
		for (let index = 0; index < lineCount; index++) {
			const leftIndex = index - leftOffset;
			const leftRaw = leftRender.lines[leftIndex] ?? "";
			const right = truncateToWidth(rightLines[index - rightOffset] ?? "", rightWidth);
			if (TERMINAL.isImageLine(leftRaw)) {
				lines.push(leftRaw + padding(leftWidth) + separator + right);
			} else {
				const left = truncateToWidth(leftRaw, leftWidth);
				lines.push(left + padding(Math.max(0, leftWidth - visibleWidth(left))) + separator + right);
			}
			anchors.push(leftRender.anchors[leftIndex] ?? null);
		}
		return { lines, anchors };
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
	}
}
