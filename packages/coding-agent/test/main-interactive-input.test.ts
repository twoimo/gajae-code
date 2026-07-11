import { describe, expect, it, vi } from "bun:test";
import { runInteractiveMode, StartupUpdateOrchestrator, submitInteractiveInput } from "@gajae-code/coding-agent/main";
import type { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import type { SubmittedUserInput } from "@gajae-code/coding-agent/modes/types";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

function createInput(overrides: Partial<SubmittedUserInput> = {}): SubmittedUserInput {
	return {
		text: "hello",
		images: undefined,
		cancelled: false,
		started: false,
		...overrides,
	};
}

describe("submitInteractiveInput", () => {
	it("prompts already-started continue submissions without re-checking optimistic state", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
		};
		const session = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "", started: true });

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).not.toHaveBeenCalled();
		expect(session.prompt).toHaveBeenCalledWith("", { images: undefined });
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("skips prompting when optimistic submission was cancelled before start", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => false),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
		};
		const session = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput();

		await submitInteractiveInput(mode, session, input);

		expect(mode.markPendingSubmissionStarted).toHaveBeenCalledWith(input);
		expect(session.prompt).not.toHaveBeenCalled();
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("routes hidden custom submissions through promptCustomMessage", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
		};
		const session = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "continue goal", customType: "goal-continuation" });

		await submitInteractiveInput(mode, session, input);

		expect(session.prompt).not.toHaveBeenCalled();
		expect(session.promptCustomMessage).toHaveBeenCalledWith({
			customType: "goal-continuation",
			content: "continue goal",
			display: false,
			attribution: "agent",
		});
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});
});

describe("interactive startup input ordering", () => {
	it("runs queued startup messages once after UI initialization instead of continuing the persisted tail", async () => {
		const events: string[] = [];
		const stop = new Error("stop interactive input");
		const session = {
			continuePersistedHistory: async () => events.push("continue"),
			prompt: async (text: string) => events.push(`prompt:${text}`),
		} as unknown as AgentSession;
		const createMode = (): InteractiveMode =>
			({
				init: async () => events.push("init"),
				showNewVersionNotification: () => {},
				renderInitialMessages: () => events.push("render"),
				showError: () => {},
				getUserInput: async () => {
					throw stop;
				},
			}) as unknown as InteractiveMode;

		await expect(
			runInteractiveMode(
				session,
				"test",
				undefined,
				[],
				new StartupUpdateOrchestrator(
					"interactive",
					() => false,
					async () => undefined,
				),
				["first queued", "second queued"],
				() => {},
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				createMode,
				"continue-tail",
			),
		).rejects.toBe(stop);

		expect(events).toEqual(["init", "render", "prompt:first queued", "prompt:second queued"]);
	});
});
