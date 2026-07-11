import { beforeAll, describe, expect, it, vi } from "bun:test";

import { CommandController } from "@gajae-code/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import { getWelcomeTranscriptReservedRows } from "@gajae-code/coding-agent/modes/interactive-mode";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { Container, Text } from "@gajae-code/tui";

import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";

function createForkContext(fork: () => Promise<boolean>) {
	const chatContainer = new Container();
	const ctx = {
		session: {
			isStreaming: false,
			fork,
			sessionFile: "/tmp/sessions/fork.jsonl",
		},
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		chatContainer,
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		showWarning: vi.fn(),
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	const resetIrcSidebarSession = vi.fn(() => helpers.resetIrcSidebarHint());
	ctx.resetIrcSidebarSession = resetIrcSidebarSession;
	return { ctx, helpers, chatContainer, resetIrcSidebarSession };
}

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

const incoming = {
	observationId: "hint",
	kind: "incoming" as const,
	from: "peer",
	to: "you",
	text: "hello",
	timestamp: 0,
};
const eligibleArrival = { panelVisible: false, panelRequestedVisible: false, sidebarAvailable: true, resolvedToggleKey: "Ctrl+I" };

function transcriptIncludesHint(chatContainer: Container): boolean {
	return Bun.stripANSI(chatContainer.render(100).join("\n")).includes("opens sidebar");
}

describe("IRC lifecycle resets", () => {
	it("resets the IRC sidebar only after a successful fork", async () => {
		const { ctx, resetIrcSidebarSession } = createForkContext(async () => true);

		await new CommandController(ctx).handleForkCommand();

		expect(resetIrcSidebarSession).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("preserves IRC sidebar state when a fork is cancelled or fails", async () => {
		const cancelled = createForkContext(async () => false);
		await new CommandController(cancelled.ctx).handleForkCommand();
		expect(cancelled.resetIrcSidebarSession).not.toHaveBeenCalled();

		const failed = createForkContext(async () => Promise.reject(new Error("disk failure")));
		await expect(new CommandController(failed.ctx).handleForkCommand()).rejects.toThrow("disk failure");
		expect(failed.resetIrcSidebarSession).not.toHaveBeenCalled();
	});
	it("re-arms the live-only sidebar hint after a successful fork reset", async () => {
		const { ctx, helpers, chatContainer } = createForkContext(async () => true);
		helpers.addLiveIrcObservationToChat(incoming, eligibleArrival);
		expect(transcriptIncludesHint(chatContainer)).toBe(true);

		await new CommandController(ctx).handleForkCommand();
		chatContainer.clear();
		helpers.addLiveIrcObservationToChat({ ...incoming, observationId: "hint-after-fork" }, eligibleArrival);
		expect(transcriptIncludesHint(chatContainer)).toBe(true);
	});

	it("preserves consumed hint state when a fork is cancelled or fails", async () => {
		const cancelled = createForkContext(async () => false);
		cancelled.helpers.addLiveIrcObservationToChat(incoming, eligibleArrival);
		await new CommandController(cancelled.ctx).handleForkCommand();
		cancelled.chatContainer.clear();
		cancelled.helpers.addLiveIrcObservationToChat({ ...incoming, observationId: "cancelled" }, eligibleArrival);
		expect(transcriptIncludesHint(cancelled.chatContainer)).toBe(false);

		const failed = createForkContext(async () => Promise.reject(new Error("disk failure")));
		failed.helpers.addLiveIrcObservationToChat(incoming, eligibleArrival);
		await expect(new CommandController(failed.ctx).handleForkCommand()).rejects.toThrow("disk failure");
		failed.chatContainer.clear();
		failed.helpers.addLiveIrcObservationToChat({ ...incoming, observationId: "failed" }, eligibleArrival);
		expect(transcriptIncludesHint(failed.chatContainer)).toBe(false);
	});

	it("reserves welcome rows from the transcript alone despite a large IRC ledger", () => {
		const transcript = new Container();
		transcript.addChild(new Text("transcript\nrow"));
		const emptyReservation = getWelcomeTranscriptReservedRows(transcript, 80);
		const ledger = new IrcObservationLedger();
		for (let index = 0; index < 50; index++) {
			ledger.observe(
				{ observationId: `backlog-${index}`, kind: "incoming", from: "peer", to: "you", text: "one\ntwo", timestamp: index },
				false,
			);
		}

		expect(ledger.getSidebarRecords()).toHaveLength(50);
		expect(transcript.children).toHaveLength(1);
		expect(getWelcomeTranscriptReservedRows(transcript, 80)).toBe(emptyReservation);
	});
});
