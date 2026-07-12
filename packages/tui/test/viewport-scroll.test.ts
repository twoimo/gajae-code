import { describe, expect, it } from "bun:test";
import {
	Container,
	Text,
	TUI,
	type ViewportComponent,
	type ViewportRowMetadata,
	type ViewportRowWindow,
} from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class SemanticRows implements ViewportComponent {
	readonly isViewportSource = true as const;
	#rows: Array<{ id: string; text: string }>;
	renderCalls = 0;
	renderRowsCalls = 0;
	fail = false;

	constructor(rows: Array<{ id: string; text: string }>) {
		this.#rows = rows;
	}

	removePrefix(count: number): void {
		this.#rows.splice(0, count);
	}

	getLogicalRowCount(): number {
		return this.#rows.length;
	}

	renderRows(width: number, start: number, end: number): string[] {
		return this.renderRowsWithMetadata(width, start, end).lines;
	}

	renderRowsWithMetadata(_width: number, start: number, end: number): ViewportRowWindow {
		if (this.fail) throw new Error("bounded renderer failure");
		this.renderRowsCalls++;
		const rows = this.#rows.slice(Math.max(0, start), Math.max(0, end));
		return {
			lines: rows.map(row => row.text),
			metadata: rows.map(
				(row): ViewportRowMetadata => ({
					identity: row.id,
					revision: row.text,
					sourceId: row.id,
					graphemeStart: 0,
					graphemeEnd: Math.max(1, [...row.text].length),
					cellStart: 0,
					cellEnd: Math.max(1, Bun.stringWidth(row.text)),
				}),
			),
		};
	}

	resolveViewportAnchor(sourceId: string): number | undefined {
		const index = this.#rows.findIndex(row => row.id === sourceId);
		return index < 0 ? undefined : index;
	}

	render(): string[] {
		this.renderCalls++;
		return this.#rows.map(row => row.text);
	}

	invalidate(): void {}
}

async function settle(term: VirtualTerminal): Promise<void> {
	await term.waitForRender();
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("bounded semantic viewport rows", () => {
	it("returns lines and CJK/emoji spans atomically", () => {
		const container = new Container();
		const text = new Text("가가❤️👍🏽", 0, 0);
		container.addChild(text);
		container.setViewportRowSource(text, { id: "message-1" });
		const window = container.renderRowsWithMetadata(4, 0, 4);
		expect(window.lines).toHaveLength(window.metadata.length);
		expect(window.metadata.every(item => item === null || item.sourceId === "message-1")).toBe(true);
		expect(
			window.metadata
				.filter((item): item is ViewportRowMetadata => item !== null)
				.every(item => item.graphemeEnd! > item.graphemeStart!),
		).toBe(true);
	});

	it("keeps a manual semantic row visible after prefix eviction without calling render", async () => {
		const term = new VirtualTerminal(30, 6);
		const ui = new TUI(term);
		const rows = new SemanticRows(
			Array.from({ length: 40 }, (_value, index) => ({ id: `history-${index}`, text: `history-${index}` })),
		);
		ui.addChild(rows);
		ui.setViewportAnchorComponent(rows);
		try {
			ui.start();
			await settle(term);
			expect(ui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			const anchored = visible(term)[0]!;
			rows.removePrefix(10);
			ui.requestRender();
			await settle(term);
			expect(visible(term)[0]).toBe(anchored);
			expect(rows.renderCalls).toBe(0);
			expect(rows.renderRowsCalls).toBeGreaterThan(0);
		} finally {
			ui.stop();
		}
	});

	it("preserves manual intent through resize and does not fall back to a full transcript render", async () => {
		const term = new VirtualTerminal(30, 6);
		const ui = new TUI(term);
		const rows = new SemanticRows(
			Array.from({ length: 60 }, (_value, index) => ({ id: `row-${index}`, text: `row-${index}` })),
		);
		ui.addChild(rows);
		ui.setViewportAnchorComponent(rows);
		try {
			ui.start();
			await settle(term);
			ui.scrollViewportPages(-1);
			await term.flush();
			const anchored = visible(term)[0]!;
			for (const width of [12, 80, 10, 30]) {
				term.resize(width, 6);
				await settle(term);
				expect(visible(term)[0], `width=${width}`).toBe(anchored);
			}
			expect(rows.renderCalls).toBe(0);
		} finally {
			ui.stop();
		}
	});
});
