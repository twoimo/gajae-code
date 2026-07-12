import { beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import {
	Box,
	CappedViewportRows,
	type Component,
	Container,
	createImageSource,
	type FrameAllocationEvent,
	Image,
	Markdown,
	type Terminal,
	TUI,
	type ViewportComponent,
	type ViewportRowComponent,
} from "@gajae-code/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { Settings } from "../../../src/config/settings";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message";
import { CustomMessageComponent } from "../../../src/modes/components/custom-message";
import { ToolExecutionComponent } from "../../../src/modes/components/tool-execution";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";
import { UserMessageComponent } from "../../../src/modes/components/user-message";
import { getMarkdownTheme, initTheme } from "../../../src/modes/theme/theme";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

function message(text: string): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
}

function allocationEventMultiset(events: readonly FrameAllocationEvent[]): string[] {
	return events.map(event => `${event.site}|${event.category}|${event.length}`).sort();
}

function forbidFullRender(component: Component): void {
	component.render = () => {
		throw new Error("off-screen component render() must not run");
	};
}

describe("production transcript viewport rows", () => {
	test("does not full-render large off-screen assistant, user, and tool messages on steady frames or resize", () => {
		const transcript = new TranscriptContainer();
		const largeMarkdown = Array.from(
			{ length: 1_000 },
			(_, index) => `| ${index} | value |\n| --- | --- |\n\n\`\`\`ts\nconst value${index} = ${index};\n\`\`\``,
		).join("\n\n");
		const assistant = new AssistantMessageComponent(message(largeMarkdown));
		const user = new UserMessageComponent(largeMarkdown);
		const expandedToolResult = new Box(1, 1);
		expandedToolResult.addChild(new Markdown(largeMarkdown, 0, 0, getMarkdownTheme()));
		const image = new Image(
			createImageSource(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5l1EAAAAASUVORK5CYII=",
				"image/png",
			),
			"image/png",
			{ fallbackColor: value => value },
		);
		const visible: ViewportRowComponent = {
			rowCountIsWidthInvariant: true,
			getLogicalRowCount: () => 1,
			renderRows: (_width, start, end) => (start === 0 && end > 0 ? ["visible"] : []),
			render: () => ["visible"],
			invalidate: () => {},
		};
		transcript.addChild(visible);
		transcript.addChild(assistant);
		transcript.addChild(user);
		transcript.addChild(expandedToolResult);
		transcript.addChild(image);
		transcript.getLogicalRowCount(100);
		forbidFullRender(assistant);
		forbidFullRender(user);
		forbidFullRender(expandedToolResult);
		forbidFullRender(image);

		expect(transcript.renderRows(100, 0, 1)).toEqual(["visible"]);
		expect(transcript.renderRows(100, 0, 1)).toEqual(["visible"]);
		expect(transcript.renderRows(60, 0, 1)).toEqual(["visible"]);
	});

	test("tail-anchors a resized transcript without recounting off-screen predecessors", () => {
		const transcript = new TranscriptContainer();
		const counts = { predecessor: 0, tail: 0 };
		const widthRows = (label: string, counter: keyof typeof counts): ViewportRowComponent => ({
			getLogicalRowCount: width => {
				counts[counter]++;
				return width < 40 ? 40 : 4;
			},
			renderRows: (width, start, end) =>
				Array.from({ length: Math.max(0, end - start) }, (_value, row) => `${label}:${width}:${start + row}`),
			render: width => Array.from({ length: width < 40 ? 40 : 4 }, (_value, row) => `${label}:${width}:${row}`),
			invalidate: () => {},
		});
		const predecessor = widthRows("predecessor", "predecessor");
		const tail = widthRows("tail", "tail");
		transcript.addChild(predecessor);
		transcript.addChild(tail);
		transcript.getLogicalRowCount(80);
		counts.predecessor = 0;
		counts.tail = 0;

		transcript.prepareBottomViewport(20, 3);
		const total = transcript.getLogicalRowCount(20);
		expect(transcript.renderRows(20, total - 3, total)).toEqual(["tail:20:37", "tail:20:38", "tail:20:39"]);
		expect(counts).toEqual({ predecessor: 0, tail: 1 });
	});

	test("does not render an off-screen custom extension child", () => {
		const transcript = new TranscriptContainer();
		const extensionChild: Component = {
			render: () => {
				throw new Error("off-screen extension render must not run");
			},
			invalidate: () => {},
		};
		const custom = new CustomMessageComponent(
			{ role: "custom", customType: "test", content: "", display: true, timestamp: 0 },
			() => extensionChild,
		);
		const visible: ViewportRowComponent = {
			rowCountIsWidthInvariant: true,
			getLogicalRowCount: () => 1,
			renderRows: () => ["visible"],
			render: () => ["visible"],
			invalidate: () => {},
		};
		transcript.addChild(custom);
		transcript.addChild(visible);
		expect(transcript.getLogicalRowCount(80)).toBe(258);
		expect(transcript.renderRows(80, 257, 258)).toEqual(["visible"]);
	});

	test("does not render an off-screen custom tool child", () => {
		const transcript = new TranscriptContainer();
		const extensionChild: Component = {
			render: () => {
				throw new Error("off-screen extension render must not run");
			},
			invalidate: () => {},
		};
		const tool = new ToolExecutionComponent(
			"extension",
			{},
			{},
			{ renderCall: () => extensionChild } as never,
			{ requestRender() {} } as unknown as TUI,
		);
		const visible: ViewportRowComponent = {
			rowCountIsWidthInvariant: true,
			getLogicalRowCount: () => 1,
			renderRows: () => ["visible"],
			render: () => ["visible"],
			invalidate: () => {},
		};
		transcript.addChild(tool);
		transcript.addChild(visible);
		expect(transcript.getLogicalRowCount(80)).toBe(258);
		expect(transcript.renderRows(80, 257, 258)).toEqual(["visible"]);
	});

	test("reconciles short custom and tool extensions at the visible transcript tail", () => {
		const extension = (line: string): Component => ({ render: () => [line], invalidate() {} });
		const customTranscript = new TranscriptContainer();
		customTranscript.addChild(
			new CustomMessageComponent(
				{ role: "custom", customType: "test", content: "", display: true, timestamp: 0 },
				() => extension("custom tail"),
			),
		);
		customTranscript.prepareBottomViewport(80, 3);
		expect(customTranscript.getLogicalRowCount(80)).toBe(2);
		expect(customTranscript.renderRows(80, 0, 2)).toEqual(["", "custom tail"]);

		const toolTranscript = new TranscriptContainer();
		toolTranscript.addChild(
			new ToolExecutionComponent(
				"extension",
				{},
				{},
				{ renderCall: () => extension("tool tail") } as never,
				{ requestRender() {} } as unknown as TUI,
			),
		);
		toolTranscript.prepareBottomViewport(80, 3);
		expect(toolTranscript.getLogicalRowCount(80)).toBe(2);
		expect(toolTranscript.renderRows(80, 0, 2)[1]).toContain("tool tail");
	});

	test("caps extension output by default and exposes full output explicitly", () => {
		const rows = (count: number): Component => ({
			render: () => Array.from({ length: count }, (_value, row) => `row ${row}`),
			invalidate() {},
		});
		const exact = new CappedViewportRows(rows(256), 256);
		expect(exact.render(80)).toHaveLength(256);
		expect(exact.getLogicalRowCount(80)).toBe(256);

		const capped = new CappedViewportRows(rows(300), 256);
		expect(capped.render(80)).toHaveLength(256);
		expect(capped.renderFull(80)).toHaveLength(300);
		const container = new Container();
		container.addChild(capped);
		expect(container.render(80)).toHaveLength(256);
		const box = new Box();
		box.addChild(capped);
		expect(box.render(80)).toHaveLength(258);
	});

	test("uses the row-addressable extension path without calling render off-screen or on-screen", () => {
		const extension: ViewportRowComponent = {
			rowCountIsWidthInvariant: true,
			getLogicalRowCount: () => 1,
			renderRows: () => ["windowed extension"],
			render: () => {
				throw new Error("row-addressable extension render() must not run");
			},
			invalidate() {},
		};
		const custom = new CustomMessageComponent(
			{ role: "custom", customType: "test", content: "", display: true, timestamp: 0 },
			() => extension,
		);
		expect(custom.renderRows(80, 1, 2)).toEqual(["windowed extension"]);
	});

	test("keeps render-only compatibility output-only, caches per width, and charges full transient output", () => {
		let renders = 0;
		const compatibility: Component = {
			render: () => {
				renders++;
				return ["full", "x", "unused"];
			},
			invalidate() {},
		};
		const capped = new CappedViewportRows(compatibility, 2);
		const tui = new TUI({} as Terminal);
		tui.beginFrameAllocationMeasurement();
		expect(capped.renderRows(7, 0, 2)).toEqual(["full", "x"]);
		// full return: 48 + 11 bytes; capped and renderRows slices: 40 bytes each.
		expect(tui.getLastFrameAllocationBytes()).toBe(139);
		tui.beginFrameAllocationMeasurement();
		capped.renderRows(7, 0, 2);
		expect(renders).toBe(1);
		expect(tui.getLastFrameAllocationBytes()).toBe(45);
	});

	test("audits every row-array materialization before identity deduplication", () => {
		const events: FrameAllocationEvent[] = [];
		TUI.setFrameAllocationEventObserverForTest(event => events.push(event));
		try {
			const tui = new TUI({} as Terminal);
			const compatibility = new CappedViewportRows({ render: () => ["full", "x", "unused"], invalidate() {} }, 2);
			tui.beginFrameAllocationMeasurement();
			compatibility.renderRows(7, 0, 2);
			expect(allocationEventMultiset(events)).toEqual([
				"capped-full-return|array|3",
				"capped-output|array|2",
				"capped-render-rows-slice|array|2",
			]);

			events.length = 0;
			const nested = new Box(0, 0);
			const container = new Container();
			const nestedRow: ViewportRowComponent = {
				rowCountIsWidthInvariant: true,
				getLogicalRowCount: () => 1,
				renderRows: () => ["nested"],
				render: () => ["nested"],
				invalidate() {},
			};
			container.addChild(nestedRow);
			nested.addChild(container);
			tui.beginFrameAllocationMeasurement();
			nested.renderRows(6, 0, 1);
			expect(allocationEventMultiset(events)).toEqual([
				"box-child-return|array|1",
				"box-output|array|1",
				"container-output|array|1",
				"container-viewport-child-return|array|1",
			]);

			events.length = 0;
			const transcript = new TranscriptContainer();
			transcript.addChild(new CappedViewportRows({ render: () => ["full", "x", "unused"], invalidate() {} }, 2));
			transcript.addChild(nested);
			tui.beginFrameAllocationMeasurement();
			transcript.renderRows(6, 0, 3);
			expect(allocationEventMultiset(events)).toEqual([
				"box-child-return|array|1",
				"box-output|array|1",
				"capped-full-return|array|3",
				"capped-output|array|2",
				"capped-render-rows-slice|array|2",
				"container-output|array|1",
				"container-viewport-child-return|array|1",
				"transcript-child-return|array|1",
				"transcript-child-return|array|2",
				"transcript-child-slice|array|1",
				"transcript-child-slice|array|2",
				"transcript-output|array|3",
				"transcript-row-count-cache|object|1",
				"transcript-row-count-cache|object|1",
				"transcript-row-count-cache|object|1",
				"transcript-row-count-cache|object|1",
				"transcript-row-index|object|2",
				"transcript-row-index|object|2",
			]);
			// The bounded result retains only output rows and child windows; the rebuild
			// additionally charges its compact row-count and row-index entries.
			expect(tui.getLastFrameAllocationBytes()).toBe(481);

			events.length = 0;
			const retryTranscript = new TranscriptContainer();
			const reconcilingChild: ViewportRowComponent = {
				rowCountIsWidthInvariant: true,
				getLogicalRowCount: () => 1,
				reconcileLogicalRowCount: () => 2,
				renderRows: () => ["reconciled"],
				render: () => ["reconciled"],
				invalidate() {},
			};
			retryTranscript.addChild(reconcilingChild);
			tui.beginFrameAllocationMeasurement();
			expect(retryTranscript.renderRows(6, 0, 1)).toEqual(["reconciled"]);
			expect(allocationEventMultiset(events)).toEqual([
				"transcript-child-return|array|1",
				"transcript-child-return|array|1",
				"transcript-child-slice|array|1",
				"transcript-child-slice|array|1",
				"transcript-output|array|1",
				"transcript-output|array|1",
			]);
		} finally {
			TUI.setFrameAllocationEventObserverForTest(undefined);
		}
	});

	test("observes viewport metadata, dirty ranges, prefix/tail, and cursor allocation events", async () => {
		const events: FrameAllocationEvent[] = [];
		const previousImeCursor = Bun.env.GJC_TUI_IME_CURSOR;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TUI(terminal);
		const source: ViewportComponent = {
			isViewportSource: true,
			getLogicalRowCount: () => 1,
			renderRows: () => ["source\x1b_pi:c\x07"],
			renderRowsWithMetadata: () => ({
				lines: ["source\x1b_pi:c\x07"],
				metadata: [
					{
						identity: "source:0",
						revision: "1",
						sourceId: "source:0",
						graphemeStart: 0,
						graphemeEnd: 1,
						cellStart: 0,
						cellEnd: 1,
					},
				],
			}),
			resolveViewportAnchor: () => 0,
			render: () => ["source\x1b_pi:c\x07"],
			getDirtyRanges: () => [{ start: 0, end: 1 }],
			invalidate() {},
		};
		TUI.setFrameAllocationEventObserverForTest(event => events.push(event));
		try {
			tui.addChild({ render: () => ["prefix"], invalidate() {} });
			tui.addChild(source);
			tui.addChild({ render: () => ["tail"], invalidate() {} });
			tui.start();
			await new Promise<void>(resolve => process.nextTick(resolve));
			await Bun.sleep(1);
			await terminal.flush();
			expect(allocationEventMultiset(events)).toEqual([
				"cursor-control-string|string|15",
				"viewport-dirty-objects|object|1",
				"viewport-metadata-objects|object|1",
				"viewport-metadata-string|string|1",
				"viewport-metadata-string|string|8",
				"viewport-metadata-string|string|8",
				"viewport-prefix-return|array|1",
				"viewport-tail-return|array|1",
			]);
		} finally {
			tui.stop();
			if (previousImeCursor === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousImeCursor;
			TUI.setFrameAllocationEventObserverForTest(undefined);
		}
	});
});
