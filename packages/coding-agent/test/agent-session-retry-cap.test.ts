import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@gajae-code/agent-core";
import { type AssistantMessage, AttemptBudgetExceededError, getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

/**
 * Contract: transient/unknown errors (rate limit, overloaded, 5xx, network)
 * retry forever with exponential backoff. A provider-supplied `retry-after`
 * is honored even when it exceeds `retry.maxDelayMs` (the cap is a ceiling for
 * the exponential backoff, not a give-up trigger). Observability is provided
 * via `auto_retry_start`/`auto_retry_end` events (with `unbounded: true`) so a
 * subagent is never silently hung. Terminal coded errors (auth/400/not-found)
 * and the usage-limit rotation path keep their bounded behavior.
 */
describe("AgentSession retry delay cap", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-cap-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("retries transient rate limits past retry.maxDelayMs, honoring retry-after", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// 11.18M ms == ~3.1 hours, matching the report on the original incident.
		// Under the resilient-retry contract this is honored, not bailed on.
		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit. Please try again later."}} retry-after-ms=11180000';

		const mock = createMockModel({
			responses: [{ throw: rateLimitError }, { content: ["recovered after honoring retry-after"] }],
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.unbounded": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Spy after construction so the constructor's no-op work isn't intercepted.
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger rate limit with long retry-after");
		await session.waitForIdle();

		// The retry loop runs (does NOT bail): original call + one retry.
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].unbounded).toBe(true);
		// The long provider retry-after is honored, not capped to maxDelayMs.
		expect(retryStartEvents[0].delayMs).toBe(11180000);
		expect(waitSpy).toHaveBeenCalledWith(11180000, expect.anything());
		// Successful retry emits a success end event and recovers.
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(session.isRetrying).toBe(false);
	});

	it("fails fast on model-limit 429 instead of entering unbounded retry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const modelLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"model_limit_reached: limit for this model reached"}} retry-after-ms=11180000';

		const mock = createMockModel({
			responses: [{ throw: modelLimitError }, { content: ["unexpected retry"] }],
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger model limit with long retry-after");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false, attempt: 1 });
		expect(retryEndEvents[0].finalError).toContain("retry.maxElapsedMs");
		expect(waitSpy).not.toHaveBeenCalled();

		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(session.isStreaming).toBe(false);
		expect(session.isRetrying).toBe(false);
	});

	it("still retries normally when the delay is under retry.maxDelayMs", async () => {
		// Sanity check: a small retry-after MUST still go through the retry
		// loop so we don't regress the existing transient-error recovery.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=50" },
				{ content: ["recovered after short backoff"] },
			],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger transient with short retry-after");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(5_000);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(waitSpy).toHaveBeenCalled();
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
	});
	it("counts provider-internal retries in the shared total-attempt budget", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ content: ["unexpected"] }] });
		let physicalAttempts = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				options?.consumeAttempt?.();
				physicalAttempts++;
				options?.consumeAttempt?.();
				physicalAttempts++;
				options?.consumeAttempt?.();
				physicalAttempts++;
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"retry.maxTotalAttempts": 2,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Exhaust internal attempts");
		await session.waitForIdle();

		expect(physicalAttempts).toBe(2);
		expect(lastAssistant(session).errorMessage).toContain("Retry total-attempt budget exhausted (2/2)");
	});

	it("bounds unbounded retries in unattended sessions with a diagnostic", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ throw: "503 overloaded" }, { content: ["unexpected"] }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.unbounded": true,
			"retry.maxRetries": 0,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			unattended: true,
		});

		expect(session.configWarnings).toContain(
			"retry.unbounded is disabled for unattended sessions; set retry.allowUnboundedUnattended=true to opt in.",
		);
		await session.prompt("Do not retry forever");
		await session.waitForIdle();
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("uses effective unattended boundedness for bridge delay admission and diagnostics", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({
			responses: [{ throw: "503 overloaded retry-after-ms=11180000" }, { content: ["unexpected"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.unbounded": true,
			"retry.maxRetries": 2,
			"retry.maxElapsedMs": 900_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.setClientBridge({} as never);
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Reject an unattended multi-hour delay");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents[0]?.finalError).toContain("retry.maxElapsedMs");
		expect(waitSpy).not.toHaveBeenCalled();
	});

	it("applies retry cost limits to the current turn rather than prior session cost", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "prior" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		const mock = createMockModel({ responses: [{ content: ["new turn succeeded"] }] });
		let physicalAttempts = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [priorAssistant] },
			streamFn: (requestedModel, context, options) => {
				physicalAttempts++;
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxCostUsd": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("A fresh turn has a fresh retry cost budget");
		await session.waitForIdle();

		expect(physicalAttempts).toBe(1);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it.each([
		["exact ceiling", [0.5, 0.5], 2],
		["crossing ceiling", [0.6, 0.6], 2],
		["normal plus maintenance", [0.4, 0.6], 2],
		["multiple maintenance operations", [0.25, 0.25, 0.5], 3],
	] as const)("denies the next physical attempt at the %s", async (_name, costs, expectedAttempts) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ content: ["unexpected"] }] });
		let physicalAttempts = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				for (const cost of costs) {
					options?.consumeAttempt?.("maintenance");
					physicalAttempts++;
					options?.consumeAttempt?.reportCost?.(cost);
				}
				options?.consumeAttempt?.("provider-http");
				physicalAttempts++;
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"retry.maxCostUsd": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Enforce ledger cost");
		await session.waitForIdle();

		expect(physicalAttempts).toBe(expectedAttempts);
		expect(lastAssistant(session).errorMessage).toContain("Retry cost budget exhausted");
	});

	it("keeps unknown cost explicit while attempt caps still terminate", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ content: ["unexpected"] }] });
		let physicalAttempts = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				options?.consumeAttempt?.("maintenance");
				physicalAttempts++;
				options?.consumeAttempt?.reportCost?.();
				options?.consumeAttempt?.("provider-http");
				physicalAttempts++;
				options?.consumeAttempt?.("provider-http");
				physicalAttempts++;
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"retry.maxCostUsd": 1,
			"retry.maxTotalAttempts": 2,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Unknown cost remains bounded");
		await session.waitForIdle();

		expect(physicalAttempts).toBe(2);
		expect(lastAssistant(session).errorMessage).toContain("Retry total-attempt budget exhausted (2/2)");
	});
	it.each([
		[
			"attempt exhaustion",
			{
				maxTotalAttempts: 1,
				maxElapsedMs: 60_000,
				maxCostUsd: 10,
				reportCost: 0,
				expectedReason: "attempts",
				costKnown: true,
			},
		],
		[
			"cost-known exhaustion",
			{
				maxTotalAttempts: 3,
				maxElapsedMs: 60_000,
				maxCostUsd: 1,
				reportCost: 1,
				expectedReason: "cost",
				costKnown: true,
			},
		],
		[
			"cost-unknown attempt exhaustion",
			{
				maxTotalAttempts: 1,
				maxElapsedMs: 60_000,
				maxCostUsd: 1,
				reportCost: undefined,
				expectedReason: "attempts",
				costKnown: false,
			},
		],
	] as const)("exposes the full AttemptBudgetExceededError diagnostic shape for %s", async (_name, testCase) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ content: ["unexpected"] }] });
		let exhaustion: AttemptBudgetExceededError | undefined;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				options?.consumeAttempt?.("maintenance");
				options?.consumeAttempt?.reportCost?.(testCase.reportCost);
				try {
					options?.consumeAttempt?.("provider-http");
				} catch (error) {
					exhaustion = error as AttemptBudgetExceededError;
					throw error;
				}
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"retry.maxTotalAttempts": testCase.maxTotalAttempts,
			"retry.maxElapsedMs": testCase.maxElapsedMs,
			"retry.maxCostUsd": testCase.maxCostUsd,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		await session.prompt("Expose typed exhaustion diagnostics");
		await session.waitForIdle();
		expect(exhaustion).toBeInstanceOf(AttemptBudgetExceededError);
		expect(exhaustion?.metadata).toMatchObject({
			outerRetryCount: 0,
			totalPhysicalAttempts: 1,
			attemptKind: "provider-http",
			attemptLayer: "provider",
			provider: model.provider,
			model: model.id,
			deadlineMs: testCase.maxElapsedMs,
			costKnown: testCase.costKnown,
			costCeilingUsd: testCase.maxCostUsd,
			terminalReason: testCase.expectedReason,
		});
		expect(exhaustion?.metadata?.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(exhaustion?.metadata?.accumulatedCostUsd).toBe(testCase.costKnown ? testCase.reportCost : undefined);
	});

	it("emits full retry diagnostics when elapsed time is terminal", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ throw: "503 overloaded" }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				options?.consumeAttempt?.("provider-http");
				const startedAt = performance.now();
				while (performance.now() - startedAt < 2) {}
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 3,
			"retry.maxTotalAttempts": 3,
			"retry.maxElapsedMs": 1,
			"retry.maxCostUsd": 2,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});
		await session.prompt("Exhaust elapsed budget");
		await session.waitForIdle();
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0].diagnostics).toMatchObject({
			outerRetryCount: 1,
			totalPhysicalAttempts: 1,
			attemptKind: "provider-http",
			attemptLayer: "provider",
			provider: model.provider,
			model: model.id,
			deadlineMs: 1,
			costKnown: true,
			accumulatedCostUsd: 0,
			costCeilingUsd: 2,
			terminalReason: "deadline",
		});
		expect(retryEndEvents[0].diagnostics?.elapsedMs).toBeGreaterThanOrEqual(0);
	});
	it("honors explicit unbounded retry opt-in for unattended sessions", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ throw: "503 overloaded" }, { content: ["recovered"] }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.unbounded": true,
			"retry.allowUnboundedUnattended": true,
			"retry.maxRetries": 0,
			"retry.baseDelayMs": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			unattended: true,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Retry with explicit opt-in");
		await session.waitForIdle();

		expect(session.configWarnings).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
});
