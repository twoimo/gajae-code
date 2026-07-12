import { beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { TUI, type ViewportRowComponent, type ViewportRowWindow } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { Settings } from "../src/config/settings";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { IrcSplitViewComponent } from "../src/modes/components/irc-sidebar";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { IrcObservationLedger } from "../src/modes/irc-observation-ledger";
import { initTheme, theme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

type Counters = { render: number; windows: number };

const EVICTION_REINDEX_BUDGET_BYTES = 1_250_000;

function historyRow(index: number, counters: Counters): ViewportRowComponent {
	const sourceId = `history-${index}`;
	return {
		rowCountIsWidthInvariant: true,
		getLogicalRowCount: () => 1,
		renderRows: (_width, start, end) => (start === 0 && end > 0 ? [sourceId] : []),
		renderRowsWithMetadata: (_width, start, end): ViewportRowWindow => {
			counters.windows++;
			if (start !== 0 || end <= 0) return { lines: [], metadata: [] };
			return {
				lines: [sourceId],
				metadata: [
					{
						identity: sourceId,
						revision: 0,
						sourceId,
						graphemeStart: 0,
						graphemeEnd: sourceId.length,
						cellStart: 0,
						cellEnd: sourceId.length,
					},
				],
			};
		},
		getViewportSourceIds: () => [sourceId],
		render: () => {
			counters.render++;
			return [sourceId];
		},
		invalidate() {},
	};
}

function assistant(text: string): AssistantMessage {
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
		model: "g021-test",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
}

function assistantWithLongThinkingAndLaterText(): AssistantMessage {
	return {
		...assistant(""),
		content: [
			{
				type: "thinking",
				thinking: Array.from({ length: 120 }, (_value, index) => `long-thinking-${index}`).join("\n\n"),
			},
			{
				type: "text",
				text: Array.from({ length: 30 }, (_value, index) => `later-block-${index}`).join("\n\n"),
			},
		],
	};
}

describe("G021 bounded semantic viewport regression", () => {
	test("keeps the same semantic row through streaming, reflow, IRC toggles, and 1K prefix eviction without full rendering", async () => {
		const term = new VirtualTerminal(100, 10);
		const ui = new TUI(term);
		const transcript = new TranscriptContainer();
		const counters: Counters = { render: 0, windows: 0 };
		for (let index = 0; index < 10_000; index++) transcript.addChild(historyRow(index, counters));
		const split = new IrcSplitViewComponent(transcript, new IrcObservationLedger(), () => theme);
		ui.addChild(split);
		ui.setViewportAnchorComponent(split);
		try {
			ui.start();
			await term.waitForRender();
			for (let page = 0; page < 500; page++) expect(ui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			const anchored = term.getViewport()[0]?.trimEnd();
			expect(anchored).toBe("history-5490");

			const streaming = new AssistantMessageComponent(assistant("stream token"), false, undefined, "assistant:g021");
			transcript.addChild(streaming);
			streaming.updateContent(assistant("stream token more"), { streaming: true });
			transcript.markChildDirty(streaming);
			streaming.updateContent(assistant("stream token finalized"), { streaming: false });
			transcript.markChildDirty(streaming);
			for (const width of [80, 120]) {
				term.resize(width, 10);
				await term.waitForRender();
				expect(term.getViewport()[0]?.trimEnd()).toBe(anchored);
			}
			split.setVisible(true);
			ui.requestRender();
			await term.waitForRender();
			expect(
				Bun.stripANSI(term.getViewport()[0] ?? "")
					.trimEnd()
					.startsWith(anchored ?? ""),
			).toBe(true);
			split.setVisible(false);
			ui.requestRender();
			await term.waitForRender();

			counters.render = 0;
			counters.windows = 0;
			ui.requestRender();
			await term.waitForRender();
			expect(counters.render).toBe(0);
			expect(counters.windows).toBeLessThanOrEqual(32);
			expect(ui.getLastFrameAllocationBytes()).toBeLessThan(10_000);

			for (const child of transcript.children.slice(0, 1_000)) transcript.detachChild(child);
			ui.requestRender();
			await term.waitForRender();
			expect(term.getViewport()[0]?.trimEnd()).toBe(anchored);
			expect(counters.render).toBe(0);
			// Prefix detach rebuilds row/source maps for the 9K retained rows. This is
			// deliberately a separate, explicit one-time rebuild budget rather than a
			// claim that eviction has the steady-frame allocation bound above.
			expect(ui.getLastFrameAllocationBytes()).toBeLessThan(EVICTION_REINDEX_BUDGET_BYTES);
		} finally {
			ui.stop();
		}
	}, 60_000);

	test("keeps an anchor in a later assistant block through reflow and 1K prefix eviction", async () => {
		const term = new VirtualTerminal(100, 10);
		const ui = new TUI(term);
		const transcript = new TranscriptContainer();
		const counters: Counters = { render: 0, windows: 0 };
		for (let index = 0; index < 1_000; index++) transcript.addChild(historyRow(index, counters));
		transcript.addChild(
			new AssistantMessageComponent(
				assistantWithLongThinkingAndLaterText(),
				false,
				undefined,
				"assistant:g021-multisource",
			),
		);
		const split = new IrcSplitViewComponent(transcript, new IrcObservationLedger(), () => theme);
		ui.addChild(split);
		ui.setViewportAnchorComponent(split);
		try {
			ui.start();
			await term.waitForRender();
			expect(ui.scrollViewportPages(-1)).toBe(true);
			await term.flush();
			const anchored = Bun.stripANSI(term.getViewport()[0] ?? "").trim();
			expect(anchored).toStartWith("later-block-");

			for (const width of [80, 120]) {
				term.resize(width, 10);
				await term.waitForRender();
				expect(Bun.stripANSI(term.getViewport()[0] ?? "").trim()).toBe(anchored);
			}

			const rows = transcript.renderRowsWithMetadata(120, 0, transcript.getLogicalRowCount(120));
			const anchoredMetadata = rows.metadata.find(
				(metadata, index) =>
					Bun.stripANSI(rows.lines[index] ?? "").trim() === anchored && metadata?.sourceId !== undefined,
			);
			expect(anchoredMetadata?.sourceId).toBe("assistant:g021-multisource:content:1:text");
			expect(anchoredMetadata?.graphemeStart).toBeDefined();
			const anchoredGrapheme = anchoredMetadata!.graphemeStart!;
			expect(transcript.resolveViewportAnchor(anchoredMetadata!.sourceId!, anchoredGrapheme, 120)).toBeDefined();

			for (const child of transcript.children.slice(0, 1_000)) transcript.detachChild(child);
			ui.requestRender();
			await term.waitForRender();
			expect(transcript.resolveViewportAnchor(anchoredMetadata!.sourceId!, anchoredGrapheme, 120)).toBeDefined();
			expect(Bun.stripANSI(term.getViewport()[0] ?? "").trim()).toBe(anchored);
		} finally {
			ui.stop();
		}
	}, 60_000);
});
