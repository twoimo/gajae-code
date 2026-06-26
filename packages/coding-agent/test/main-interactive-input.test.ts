import { describe, expect, it, vi } from "bun:test";
import { submitInteractiveInput } from "@gajae-code/coding-agent/main";
import {
	createNativeTuiRuntimeBoundary,
	type NativeTuiRpcSdkPipeline,
} from "@gajae-code/coding-agent/modes/native-tui-runtime-boundary";
import type { SubmittedUserInput } from "@gajae-code/coding-agent/modes/types";

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
		const runtimeBoundary = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "", started: true });

		await submitInteractiveInput(mode, runtimeBoundary, input);

		expect(mode.markPendingSubmissionStarted).not.toHaveBeenCalled();
		expect(runtimeBoundary.prompt).toHaveBeenCalledWith("", { images: undefined });
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
		const runtimeBoundary = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput();

		await submitInteractiveInput(mode, runtimeBoundary, input);

		expect(mode.markPendingSubmissionStarted).toHaveBeenCalledWith(input);
		expect(runtimeBoundary.prompt).not.toHaveBeenCalled();
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
		const runtimeBoundary = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
		};
		const input = createInput({ text: "continue goal", customType: "goal-continuation" });

		await submitInteractiveInput(mode, runtimeBoundary, input);

		expect(runtimeBoundary.prompt).not.toHaveBeenCalled();
		expect(runtimeBoundary.promptCustomMessage).toHaveBeenCalledWith({
			customType: "goal-continuation",
			content: "continue goal",
			display: false,
			attribution: "agent",
		});
		expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("defers completion for queued boundary submissions until the boundary dispatch runs", async () => {
		const mode = {
			markPendingSubmissionStarted: vi.fn(() => true),
			finishPendingSubmission: vi.fn(),
			showError: vi.fn(),
			checkShutdownRequested: vi.fn(async () => {}),
		};
		const target = {
			prompt: vi.fn(async () => {}),
			promptCustomMessage: vi.fn(async () => {}),
			sendCustomMessage: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			isStreaming: false,
		};
		const submit = vi.fn(() => (submit.mock.calls.length === 1 ? "queued:1" : "immediate"));
		let completions = 0;
		const pipeline: NativeTuiRpcSdkPipeline = {
			submit,
			completeOrdered: vi.fn(() => (++completions === 1 ? "prompt" : null)),
			isZeroSerialization: vi.fn(() => true),
		};
		const runtimeBoundary = createNativeTuiRuntimeBoundary(target, {
			pipeline,
			principalJson: JSON.stringify({ kind: "test" }),
		});
		const submitted = submitInteractiveInput(mode, runtimeBoundary, createInput({ text: "queued" }));

		await Promise.resolve();

		expect(pipeline.submit).toHaveBeenCalledWith(JSON.stringify({ kind: "test" }), "prompt");
		expect(target.prompt).not.toHaveBeenCalled();
		expect(mode.finishPendingSubmission).not.toHaveBeenCalled();

		await runtimeBoundary.prompt("promoter");
		await submitted;

		expect(target.prompt).toHaveBeenCalledWith("queued", { images: undefined });
		expect(mode.finishPendingSubmission).toHaveBeenCalled();
		expect(mode.showError).not.toHaveBeenCalled();
	});
});
