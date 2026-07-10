import {
	type Component,
	padding,
	replaceTabs,
	TERMINAL,
	truncateToWidth,
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
export class IrcSplitViewComponent implements Component {
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
		if (!this.#visible) return this.leftPane.render(width);

		const componentTheme = typeof this.componentTheme === "function" ? this.componentTheme() : this.componentTheme;
		const leftWidth = Math.floor(width * 0.5);
		const separatorText = componentTheme.fg("dim", ` ${componentTheme.boxSharp.vertical} `);
		const separatorWidth = width - leftWidth > 3 ? visibleWidth(separatorText) : 0;
		const separator = separatorWidth > 0 ? separatorText : "";
		const rightWidth = Math.max(0, width - leftWidth - separatorWidth);
		// Cursor-neutral (kitty) image placements are safe inside the split:
		// the escape anchors to its cell without moving the cursor, so the
		// right column still composes correctly. Cursor-advancing protocols
		// (iTerm2/SIXEL) remain suppressed by the fallback scope.
		const leftLines = withTerminalGraphicsFallback(() => this.leftPane.render(leftWidth), {
			allowCursorNeutralImages: true,
		});
		const rightLines = renderSidebarRecords(this.ledger, rightWidth);
		const lineCount = Math.max(leftLines.length, rightLines.length);
		const output: string[] = [];

		const leftOffset = lineCount - leftLines.length;
		const rightOffset = lineCount - rightLines.length;
		for (let index = 0; index < lineCount; index++) {
			const leftRaw = leftLines[index - leftOffset] ?? "";
			const right = truncateToWidth(rightLines[index - rightOffset] ?? "", rightWidth);
			if (TERMINAL.isImageLine(leftRaw)) {
				// Never truncate/measure an image escape: it renders zero visible
				// columns, so pad the full left width after it.
				output.push(leftRaw + padding(leftWidth) + separator + right);
				continue;
			}
			const left = truncateToWidth(leftRaw, leftWidth);
			output.push(left + padding(Math.max(0, leftWidth - visibleWidth(left))) + separator + right);
		}
		return output;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
	}
}
