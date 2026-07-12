import {
	Container,
	Markdown,
	Spacer,
	Text,
	type ViewportRowComponent,
	type ViewportRowMetadata,
	type ViewportRowSource,
	type ViewportRowWindow,
} from "@gajae-code/tui";

import { getMarkdownTheme, theme } from "../../modes/theme/theme";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	#viewportRowSource?: ViewportRowSource;

	constructor(text: string, synthetic = false, viewportAnchorId?: string) {
		super();
		if (viewportAnchorId) this.#viewportRowSource = { id: viewportAnchorId };
		const bgColor = (value: string) => theme.bg("userMessageBg", value);
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", value);
		this.addChild(new Spacer(1));
		const label = synthetic ? "replay" : "user";
		this.addChild(new Text(theme.bold(theme.fg("accent", label)), 1, 0));
		const prompt = new PromptZoneMarkdown(text, bgColor, color);
		this.addChild(prompt);
		if (this.#viewportRowSource) this.setViewportRowSource(prompt, this.#viewportRowSource);
	}
}

class PromptZoneMarkdown implements ViewportRowComponent {
	#markdown: Markdown;

	constructor(text: string, bgColor: (value: string) => string, color: (value: string) => string) {
		this.#markdown = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor,
			color,
		});
	}

	invalidate(): void {
		this.#markdown.invalidate();
	}
	getLogicalRowCount(width: number): number {
		return this.#markdown.getLogicalRowCount(width);
	}

	#withPromptZone(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		const zoned = [...lines];
		zoned[0] = OSC133_ZONE_START + zoned[0];
		zoned[zoned.length - 1] = `${zoned[zoned.length - 1]}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`;
		return zoned;
	}

	renderRows(width: number, start: number, end: number): string[] {
		const count = this.#markdown.getLogicalRowCount(width);
		const from = Math.max(0, Math.min(start, count));
		const to = Math.max(from, Math.min(end, count));
		if (from === to) return [];
		const lines = this.#markdown.renderRows(width, from, to);
		if (from === 0) lines[0] = OSC133_ZONE_START + lines[0];
		if (to === count) lines[lines.length - 1] = `${lines[lines.length - 1]}${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`;
		return lines;
	}

	renderRowsWithMetadata(width: number, start: number, end: number): ViewportRowWindow {
		const count = this.#markdown.getLogicalRowCount(width);
		const from = Math.max(0, Math.min(start, count));
		const to = Math.max(from, Math.min(end, count));
		const rendered = this.#markdown.renderRowsWithMetadata(width, from, to);
		const lines = this.#withPromptZone(rendered.lines);
		const metadata = rendered.metadata.map((item): ViewportRowMetadata | null => (item ? { ...item } : null));
		if (from !== 0 && lines.length > 0) lines[0] = rendered.lines[0]!;
		if (to !== count && lines.length > 0) lines[lines.length - 1] = rendered.lines[rendered.lines.length - 1]!;
		return { lines, metadata };
	}
	render(width: number): string[] {
		return this.#withPromptZone(this.#markdown.render(width));
	}
}
