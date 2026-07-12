import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, AgentBusyError } from "@gajae-code/agent-core";
import { getBundledModel, type Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession, type AgentSessionEvent, type RetryBudgetDiagnostics } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type TerminalReason = RetryBudgetDiagnostics["terminalReason"];

const DEADLINE_MS = 60_000;
const COST_CEILING_USD = 2;

function expectedDiagnostics(
	model: Model,
	elapsedMs: number,
	terminalReason: TerminalReason,
	totalPhysicalAttempts: number,
): RetryBudgetDiagnostics {
	return {
		outerRetryCount: 1,
		totalPhysicalAttempts,
		attemptKind: "provider-http",
		attemptLayer: "provider",
		provider: model.provider,
		model: model.id,
		elapsedMs,
		deadlineMs: DEADLINE_MS,
		costKnown: true,
		accumulatedCostUsd: 0,
		costCeilingUsd: COST_CEILING_USD,
		terminalReason,
	};
}

describe("AgentSession terminal retry diagnostics", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-terminal-diagnostics-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function buildSession(
		responses: NonNullable<Parameters<typeof createMockModel>[0]>["responses"],
		settingsOverrides: Record<string, boolean | number> = {},
	): {
		model: Model;
		retryEndEvents: AutoRetryEndEvent[];
		forwardedRetryEndEvents: AutoRetryEndEvent[];
		agent: Agent;
	} {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				options?.consumeAttempt?.("provider-http");
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5,
			"retry.maxRetries": 3,
			"retry.maxTotalAttempts": 5,
			"retry.maxElapsedMs": DEADLINE_MS,
			"retry.maxCostUsd": COST_CEILING_USD,
			...settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const forwardedRetryEndEvents: AutoRetryEndEvent[] = [];
		const extensionRunner = {
			hasHandlers: () => false,
			emitBeforeAgentStart: vi.fn().mockResolvedValue({}),
			emit: vi.fn(async (event: AgentSessionEvent) => {
				if (event.type === "auto_retry_end") forwardedRetryEndEvents.push(event);
			}),
		};
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});
		return { model, retryEndEvents, forwardedRetryEndEvents, agent };
	}

	function assertForwardedDiagnostics(
		model: Model,
		retryEndEvents: AutoRetryEndEvent[],
		forwardedRetryEndEvents: AutoRetryEndEvent[],
		terminalReason: TerminalReason,
		totalPhysicalAttempts: number,
	): void {
		expect(retryEndEvents).toHaveLength(1);
		expect(forwardedRetryEndEvents).toHaveLength(1);
		const diagnostics = retryEndEvents[0].diagnostics;
		expect(diagnostics).toBeDefined();
		expect(diagnostics?.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(diagnostics).toEqual(
			expectedDiagnostics(model, diagnostics?.elapsedMs ?? -1, terminalReason, totalPhysicalAttempts),
		);
		expect(forwardedRetryEndEvents[0].diagnostics).toBe(diagnostics);
		expect(forwardedRetryEndEvents[0]).toEqual(retryEndEvents[0]);
	}

	it("forwards exact diagnostics when a retry terminates as non-retryable", async () => {
		const harness = buildSession([
			{ throw: "503 service unavailable: overloaded_error" },
			{ throw: "401 unauthorized: invalid api key" },
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session?.prompt("transient then terminal");
		await session?.waitForIdle();

		assertForwardedDiagnostics(
			harness.model,
			harness.retryEndEvents,
			harness.forwardedRetryEndEvents,
			"non_retryable",
			2,
		);
	});

	it("forwards exact diagnostics when the deadline rejects the retry delay", async () => {
		const harness = buildSession([{ throw: "503 overloaded retry-after-ms=60001" }]);
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session?.prompt("deadline before delay");
		await session?.waitForIdle();

		expect(waitSpy).not.toHaveBeenCalled();
		assertForwardedDiagnostics(harness.model, harness.retryEndEvents, harness.forwardedRetryEndEvents, "deadline", 1);
	});

	it("forwards exact diagnostics when cancellation interrupts the retry wait", async () => {
		const harness = buildSession([{ throw: "503 overloaded retry-after-ms=5000" }]);
		let resolveStarted!: () => void;
		const started = new Promise<void>(resolve => {
			resolveStarted = resolve;
		});
		session?.subscribe(event => {
			if (event.type === "auto_retry_start") resolveStarted();
		});

		const prompt = session?.prompt("cancel retry wait");
		await started;
		session?.abortRetry();
		await prompt;
		await session?.waitForIdle();

		assertForwardedDiagnostics(
			harness.model,
			harness.retryEndEvents,
			harness.forwardedRetryEndEvents,
			"cancelled",
			1,
		);
	});

	it("forwards exact diagnostics when retry recovery fails", async () => {
		const harness = buildSession([{ throw: "503 service unavailable: overloaded_error" }]);
		(harness.agent as unknown as { continue: () => Promise<void> }).continue = async () => {
			throw new AgentBusyError();
		};
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session?.prompt("failed retry recovery");
		await session?.waitForIdle();

		assertForwardedDiagnostics(
			harness.model,
			harness.retryEndEvents,
			harness.forwardedRetryEndEvents,
			"recovery_failure",
			1,
		);
	});
});
