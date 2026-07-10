import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { parseIrcMessage } from "@gajae-code/coding-agent/modes/utils/irc-message";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { Container } from "@gajae-code/tui";

beforeAll(() => initTheme());

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function message(observationId: string, timestamp: number, text = "hello"): CustomMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: text,
		display: true,
		details: { observationId, from: "peer", message: text },
		attribution: "agent",
		timestamp,
	};
}

function makeContext(settingEnabled: boolean) {
	const chatContainer = new Container();
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender },
		chatContainer,
		settings: { get: () => settingEnabled },
		ircLedger: new IrcObservationLedger(),
		session: {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	const addMessageToChat = vi.fn((item: CustomMessage) => helpers.addMessageToChat(item));
	ctx.addMessageToChat = addMessageToChat;
	return { ctx, chatContainer, requestRender, addMessageToChat };
}

describe("EventController IRC observations", () => {
	it("renders same-timestamp distinct observations and deduplicates persisted delivery", async () => {
		const { ctx, chatContainer, addMessageToChat } = makeContext(false);
		const controller = new EventController(ctx);
		const first = message("one", 1, "first");
		const second = message("two", 1, "second");

		await controller.handleEvent({ type: "irc_message", message: first });
		await controller.handleEvent({ type: "irc_message", message: second });
		await controller.handleEvent({ type: "message_start", message: first });

		expect(addMessageToChat).toHaveBeenCalledTimes(2);
		expect(chatContainer.children).toHaveLength(4);
	});

	it("expires setting-on observations at their original deadline", async () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, chatContainer } = makeContext(true);
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: message("ephemeral", 0) });

		vi.advanceTimersByTime(9_999);
		expect(chatContainer.children).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(chatContainer.children).toHaveLength(0);
	});

	it("does not arm an expiry timer when the setting was off at observation", async () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, chatContainer } = makeContext(false);
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "irc_message", message: message("persistent", 0) });

		vi.advanceTimersByTime(10_000);
		expect(chatContainer.children).toHaveLength(2);
	});
});

describe("parseIrcMessage UI sanitization", () => {
	it("strips terminal controls from fields while preserving tabs and newlines", () => {
		const parsed = parseIrcMessage({
			role: "custom",
			customType: "irc:relay",
			content: "",
			display: true,
			attribution: "agent",
			timestamp: 1,
			details: {
				from: "peer\x1b]8;;https://example.test\x1b\\name\x1b]8;;\x1b\\",
				to: "you\x1bPqpayload\x1b\\",
				body: "first\tline\nsecond\x1b[31m line",
			},
		} as CustomMessage);

		expect(parsed).toMatchObject({ from: "peername", to: "you", text: "first\tline\nsecond line" });
	});

	it("uses the current time when an IRC timestamp is malformed", () => {
		const now = 1_234_567_890;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const parsed = parseIrcMessage({
			role: "custom",
			customType: "irc:incoming",
			content: "",
			display: true,
			attribution: "agent",
			timestamp: Number.NaN,
			details: { from: "peer", message: "hello" },
		} as CustomMessage);

		expect(parsed?.timestamp).toBe(now);
	});
});
