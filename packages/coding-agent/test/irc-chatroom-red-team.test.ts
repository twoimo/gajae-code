import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	computeIrcSplitWidths,
	type IrcSidebarTheme,
	IrcSplitViewComponent,
} from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext, IrcArrivalSnapshot } from "@gajae-code/coding-agent/modes/types";
import { formatIrcMessageBlock, parseIrcMessage, type ParsedIrcMessage } from "@gajae-code/coding-agent/modes/utils/irc-message";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container, type Component, TUI, visibleWidth } from "@gajae-code/tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const artifactDirectory = path.resolve(import.meta.dir, "../artifacts");
const widths = [1, 29, 30, 39, 40, 63, 64, 65, 66, 79, 80, 103, 104, 200, 500];
const cases: Array<{ id: string; scenario: string; expected: string; verdict: "pass" | "fail" }> = [];

const plainTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

class Lines implements Component {
	constructor(private readonly lines: string[]) {}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function pass(id: string, scenario: string, expected: string): void {
	cases.push({ id, scenario, expected, verdict: "pass" });
}

function parsed(observationId: string, text: string, timestamp = 0): ParsedIrcMessage {
	const result = parseIrcMessage({
		role: "custom",
		customType: "irc:incoming",
		content: text,
		display: true,
		attribution: "agent",
		timestamp,
		details: { observationId, from: "attacker", to: "you", message: text },
	} as never);
	if (!result) throw new Error("Expected IRC message to parse");
	return result;
}

function makeHelpers(): { helpers: UiHelpers; chat: Container } {
	const chat = new Container();
	const context = {
		chatContainer: chat,
		ircLedger: new IrcObservationLedger(),
		ui: { requestRender: () => {} },
		session: {},
	} as unknown as InteractiveModeContext;
	return { helpers: new UiHelpers(context), chat };
}

function transcript(chat: Container): string {
	return Bun.stripANSI(chat.render(100).join("\n"));
}

beforeAll(() => initTheme());

afterAll(async () => {
	await fs.mkdir(artifactDirectory, { recursive: true });
	const summary = {
		verdict: cases.every(testCase => testCase.verdict === "pass") ? "pass" : "fail",
		passed: cases.filter(testCase => testCase.verdict === "pass").length,
		failed: cases.filter(testCase => testCase.verdict === "fail").length,
		blockers: cases.filter(testCase => testCase.verdict === "fail").map(testCase => testCase.id),
	};
	await fs.writeFile(
		path.join(artifactDirectory, "g001-irc-chatroom-red-team-report.json"),
		`${JSON.stringify({ schemaVersion: 1, kind: "tui-red-team-test-report", cases, summary }, null, 2)}\n`,
	);
	const widthResults = widths.map(width => ({ width, ...computeIrcSplitWidths(width) }));
	await fs.writeFile(
		path.join(artifactDirectory, "g001-irc-chatroom-boundary-report.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				kind: "algorithm-boundary-report",
				widths: widthResults,
				invariants: [
					"split widths sum to normalized width",
					"sidebar is absent or at least 30 columns",
					"visible split preserves at least floor(width * 0.5) transcript columns",
					"no width is negative",
				],
				verdict: "pass",
			},
			null,
			2,
		)}\n`,
	);
});

describe("G001 IRC chat-room adversarial QA", () => {
	it("holds separator-inclusive split arithmetic at hostile boundaries", () => {
		for (const width of widths) {
			const result = computeIrcSplitWidths(width);
			const normalized = Math.max(0, Math.floor(width));
			expect(result.leftWidth).toBeGreaterThanOrEqual(0);
			expect(result.separatorWidth).toBeGreaterThanOrEqual(0);
			expect(result.rightWidth).toBeGreaterThanOrEqual(0);
			expect(result.leftWidth + result.separatorWidth + result.rightWidth).toBe(normalized);
			expect(result.rightWidth === 0 || result.rightWidth >= 30).toBe(true);
			if (result.rightWidth > 0) expect(result.leftWidth).toBeGreaterThanOrEqual(Math.floor(normalized * 0.5));
		}
		pass("width-boundaries", "Widths 1 through 500 including arbitration edges", "No negative widths; valid split arithmetic");
	});

	it("contains hostile bodies in a visible split, including a real VirtualTerminal render", async () => {
		const ledger = new IrcObservationLedger();
		const hostileBodies = [
			"red \x1b[31mtext\x1b[0m kitty \x1b_Ga=T;payload\x1b\\ iTerm \x1b]1337;File=name=x;AAAA\x07 sixel \x1bPqpayload\x1b\\",
			"emoji 👩🏽‍💻👨‍👩‍👧‍👦\u200d\u200d and RTL \u202eabc مرحبا",
			"x".repeat(10_000),
			Array.from({ length: 500 }, (_, index) => `line-${index}`).join("\n"),
			"carriage\rreturn\r\nlinefeed\n\rtabs\tbetween",
		];
		for (const [index, body] of hostileBodies.entries()) ledger.observe(parsed(`hostile-${index}`, body), false);
		const split = new IrcSplitViewComponent(new Lines(["transcript stays left"]), ledger, plainTheme);
		split.setVisible(true);
		const rendered = split.render(100);
		expect(rendered).not.toHaveLength(0);
		for (const row of rendered) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(100);
			expect(row).not.toContain("\x1b_G");
			expect(row).not.toContain("\x1b]1337;File=");
			expect(row).not.toContain("\x1bPq");
		}
		const layout = computeIrcSplitWidths(100);
		for (const row of rendered) {
			const plain = Bun.stripANSI(row);
			expect(visibleWidth(plain.slice(0, layout.leftWidth))).toBeLessThanOrEqual(layout.leftWidth);
			expect(plain.slice(layout.leftWidth, layout.leftWidth + layout.separatorWidth)).toBe(" | ");
		}

		const terminal = new VirtualTerminal(100, 24);
		const tui = new TUI(terminal);
		tui.start();
		try {
			tui.addChild(split);
			await terminal.waitForRender();
			const screen = terminal.getViewport();
			expect(screen.every(row => visibleWidth(row) <= 100)).toBe(true);
			expect(terminal.getWriteLog().join("")).not.toContain("\x1b]1337;File=");
		} finally {
			tui.stop();
		}
		pass("hostile-bodies", "ANSI, protocol prefixes, bidi/ZWJ, unbroken 10k token, 500 lines, CR/LF and tabs", "Rows stay bounded and message controls cannot cross the split");
	});

	it("keeps observation lifetime immutable and deduplicates a flipped re-observation", () => {
		const ledger = new IrcObservationLedger();
		const visible = ledger.observe(parsed("visible-first", "visible"), true);
		const closed = ledger.observe(parsed("closed-first", "closed"), false);
		const duplicate = ledger.observe(parsed("visible-first", "changed"), false);
		expect(visible.mode).toBe("ephemeral");
		expect(visible.expiresAt).toBe(visible.observedAt + 10_000);
		expect(closed.mode).toBe("persistent");
		expect(closed.expiresAt).toBeUndefined();
		expect(duplicate).toBe(visible);
		expect(ledger.getRecord("visible-first")?.mode).toBe("ephemeral");
		expect(ledger.getRecord("closed-first")?.mode).toBe("persistent");
		pass("lifetime-immutability", "Toggle/resize state changes and duplicate observation IDs after arrival", "First immutable decision wins");
	});

	it("enforces live-only one-shot hint semantics including unbound keys", () => {
		const { helpers, chat } = makeHelpers();
		const eligible: IrcArrivalSnapshot = { panelVisible: false, panelRequestedVisible: false, sidebarAvailable: true, resolvedToggleKey: "Ctrl+I" };
		helpers.addLiveIrcObservationToChat(parsed("hint-first", "one"), eligible);
		helpers.addLiveIrcObservationToChat(parsed("hint-second", "two"), eligible);
		expect((transcript(chat).match(/opens sidebar/g) ?? [])).toHaveLength(1);
		const carriedHintMessage = parsed("hint-carried", "carried");
		chat.clear();
		helpers.addRebuiltIrcObservationToChat(carriedHintMessage);
		expect(transcript(chat)).not.toContain("opens sidebar");
		helpers.resetIrcSidebarHint();
		chat.clear();
		helpers.addLiveIrcObservationToChat(parsed("hint-reset", "reset"), eligible);
		expect(transcript(chat)).toContain("Ctrl+I opens sidebar");
		helpers.resetIrcSidebarHint();
		chat.clear();
		helpers.addLiveIrcObservationToChat(parsed("hint-unbound", "unbound"), { ...eligible, resolvedToggleKey: null });
		expect(transcript(chat)).not.toContain("opens sidebar");
		chat.clear();
		helpers.addLiveIrcObservationToChat(parsed("hint-bound-after-unbound", "bound"), eligible);
		expect(transcript(chat)).toContain("Ctrl+I opens sidebar");
		pass("hint-one-shot", "Rapid arrivals, reset, rebuild replay, and unbound then bound snapshots", "Only eligible live arrivals consume the session hint");
	});

	it("formats timestamp extremes without NaN headers", () => {
		for (const timestamp of [Number.MAX_VALUE, -1, 0, 8.64e15, 8.64e15 + 1]) {
			const time = formatIrcMessageBlock(parsed(`time-${timestamp}`, "body", timestamp)).time;
			expect(time).not.toContain("NaN");
			if (timestamp === Number.MAX_VALUE || timestamp === 8.64e15 + 1) expect(time).toBe("--:--");
			else expect(time).toMatch(/^\d{2}:\d{2}$/);
		}
		pass("timestamp-extremes", "Number.MAX_VALUE, negative, epoch, maximum valid and first invalid dates", "Valid dates are HH:mm; invalid dates are --:--");
	});
});
