import {
	type Component,
	padding,
	renderComponentWithViewportAnchors,
	TERMINAL,
	truncateToWidth,
	type ViewportAnchorProvider,
	type ViewportAnchorRender,
	visibleWidth,
	withTerminalGraphicsFallback,
	wrapTextWithAnsi,
} from "@gajae-code/tui";
import type { IrcObservationLedger } from "../irc-observation-ledger";
import { formatIrcMessageBlock } from "../utils/irc-message";

export const IRC_SIDEBAR_WIDTH_RATIO = 0.3;
const IRC_SIDEBAR_MIN_WIDTH = 30;
const IRC_SEPARATOR_WIDTH = 3;

/** Computes transcript/sidebar widths while preserving at least half the terminal for the transcript. */
export function computeIrcSplitWidths(width: number): {
	leftWidth: number;
	separatorWidth: number;
	rightWidth: number;
} {
	const normalizedWidth = Math.max(0, Math.floor(width));
	const transcriptFloor = Math.floor(normalizedWidth * 0.5);
	const preferredSidebar = Math.max(IRC_SIDEBAR_MIN_WIDTH, Math.floor(normalizedWidth * IRC_SIDEBAR_WIDTH_RATIO));
	const sidebarWidth = Math.max(0, Math.min(preferredSidebar, normalizedWidth - IRC_SEPARATOR_WIDTH - transcriptFloor));

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

function renderSidebarRecords(ledger: IrcObservationLedger, width: number, componentTheme: IrcSidebarTheme): string[] {
	if (width <= 0) return [];

	const lines: string[] = [];
	for (const [recordIndex, record] of ledger.getSidebarRecords().entries()) {
		if (recordIndex > 0) lines.push("");

		const block = formatIrcMessageBlock(record);
		const sender = styleSender(componentTheme, block.sender);
		const time = componentTheme.fg("dim", block.time);
		lines.push(truncateToWidth(`${sender} → ${block.recipient} · ${time}`, width));

		for (const bodyLine of block.bodyLines) {
			for (const wrappedLine of wrapTextWithAnsi(bodyLine, Math.max(1, width - 2))) {
				lines.push(truncateToWidth(`  ${wrappedLine}`, width));
			}
		}
	}
	return lines;
}

export interface IrcSidebarTheme {
	fg(color: "dim" | "accent", text: string): string;
	bold(text: string): string;
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

	effectiveSidebarVisible(width = process.stdout.columns ?? 0): boolean {
		return this.#visible && computeIrcSplitWidths(width).rightWidth > 0;
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
		const { leftWidth, separatorWidth, rightWidth } = computeIrcSplitWidths(width);
		if (rightWidth === 0) return renderComponentWithViewportAnchors(this.leftPane, width);

		const separatorText = componentTheme.fg("dim", ` ${componentTheme.boxSharp.vertical} `);
		const separator = separatorWidth > 0 ? separatorText : "";
		const leftRender = withTerminalGraphicsFallback(
			() => renderComponentWithViewportAnchors(this.leftPane, leftWidth),
			{ allowCursorNeutralImages: true },
		);
		const rightLines = renderSidebarRecords(this.ledger, rightWidth, componentTheme);
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
