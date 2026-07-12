import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { gatewayAttemptController, startAuthGateway } from "../src/auth-gateway/server";
import type { AuthGatewayServerHandle } from "../src/auth-gateway/types";
import type { AuthStorage } from "../src/auth-storage";
import { Effort } from "../src/model-thinking";
import { streamPiNative } from "../src/providers/pi-native-client";
import { encodeStream, formatError, parseRequest } from "../src/providers/pi-native-server";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "../src/types";
import { AttemptBudgetExceededError } from "../src/types";
import { AssistantMessageEventStream as EventStream } from "../src/utils/event-stream";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStream;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseLine(line: string): unknown {
	const stripped = line.replace(/^data: /, "");
	if (stripped === "[DONE]") return "[DONE]";
	return JSON.parse(stripped);
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

const GATEWAY_TEST_API = "auth-gateway-pi-native-test" as Api;
const GATEWAY_TEST_SOURCE = "auth-gateway-pi-native-test";

function gatewayTestModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gateway-test-model",
		name: "gateway-test-model",
		api: GATEWAY_TEST_API,
		provider: "gateway-test-provider",
		baseUrl: "mock://gateway-test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 1024,
		...overrides,
	};
}

function trackedAttemptController(turnBudgetId: string, maxAttempts: number): SimpleStreamOptions["consumeAttempt"] {
	let remainingAttempts = maxAttempts;
	return Object.assign(
		() => {
			if (remainingAttempts <= 0) throw new AttemptBudgetExceededError("attempts", "local attempt budget exhausted");
			remainingAttempts -= 1;
		},
		{
			snapshot: () => ({ turnBudgetId, remainingAttempts, remainingDurationMs: 60_000, maxAttempts }),
			// Production-equivalent monotonic reconciliation: remote metadata can
			// never restore locally consumed budget, and mismatched turn identity
			// or attempt maxima are ignored.
			reconcile: (snapshot: { turnBudgetId?: string; remainingAttempts: number; maxAttempts?: number }) => {
				if (snapshot.turnBudgetId !== undefined && snapshot.turnBudgetId !== turnBudgetId) return;
				if (snapshot.maxAttempts !== undefined && snapshot.maxAttempts !== maxAttempts) return;
				remainingAttempts = Math.min(remainingAttempts, snapshot.remainingAttempts);
			},
		},
	);
}

async function withPiNativeGateway(
	storage: AuthStorage,
	resolveModel: () => Model<Api>,
	fn: (gateway: AuthGatewayServerHandle) => Promise<void>,
): Promise<void> {
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		version: "test",
		storage,
		resolveModel,
	});
	try {
		await fn(gateway);
	} finally {
		await gateway.close();
	}
}

afterEach(() => {
	unregisterCustomApis(GATEWAY_TEST_SOURCE);
});

describe("pi-native parseRequest", () => {
	it("accepts modelId + context and returns canonical shape", () => {
		const parsed = parseRequest({
			modelId: "claude-sonnet-4-5",
			context: baseContext,
			options: { temperature: 0.5, reasoning: Effort.High },
			stream: false,
		});
		expect(parsed.modelId).toBe("claude-sonnet-4-5");
		expect(parsed.context).toEqual(baseContext);
		expect(parsed.options.temperature).toBe(0.5);
		expect(parsed.options.reasoning).toBe(Effort.High);
		expect(parsed.stream).toBe(false);
	});

	it("falls back to model.id when modelId is absent (streamProxy compat)", () => {
		const parsed = parseRequest({
			model: { id: "claude-opus-4-1", provider: "anthropic", api: "anthropic-messages" },
			context: baseContext,
		});
		expect(parsed.modelId).toBe("claude-opus-4-1");
	});

	it("accepts top-level string `model` as the id (extra compat)", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			context: baseContext,
		});
		expect(parsed.modelId).toBe("gpt-5");
	});

	it("defaults stream to true when omitted", () => {
		const parsed = parseRequest({ modelId: "x", context: baseContext });
		expect(parsed.stream).toBe(true);
	});

	it("drops server-controlled and unknown option keys", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				temperature: 0.2,
				apiKey: "should-be-stripped",
				signal: {},
				fetch: () => {},
				onPayload: () => {},
				onResponse: () => {},
				onSseEvent: () => {},
				execHandlers: {},
				providerSessionState: new Map(),
				notARealField: "ignored",
			},
		});
		expect(parsed.options).toEqual({ temperature: 0.2 });
		expect("apiKey" in parsed.options).toBe(false);
		expect("signal" in parsed.options).toBe(false);
		expect("fetch" in parsed.options).toBe(false);
		expect("onPayload" in parsed.options).toBe(false);
		expect("notARealField" in parsed.options).toBe(false);
	});

	it("preserves headers, metadata, sessionId, thinkingBudgets", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				headers: { "x-foo": "bar" },
				metadata: { user_id: "u" },
				sessionId: "explicit-session",
				thinkingBudgets: { high: 8192 },
				stopSequences: ["\n\n"],
				toolChoice: "required",
				serviceTier: "priority",
				cacheRetention: "long",
			},
		});
		expect(parsed.options.headers).toEqual({ "x-foo": "bar" });
		expect(parsed.options.metadata).toEqual({ user_id: "u" });
		expect(parsed.options.sessionId).toBe("explicit-session");
		expect(parsed.options.thinkingBudgets).toEqual({ high: 8192 });
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.serviceTier).toBe("priority");
		expect(parsed.options.cacheRetention).toBe("long");
	});

	it("rejects missing required fields", () => {
		expect(() => parseRequest({ context: baseContext })).toThrow(/modelId/);
		expect(() => parseRequest({ modelId: "x" })).toThrow(/context/);
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: [] } })).toThrow(/messages/);
	});

	it("rejects non-object body", () => {
		expect(() => parseRequest(null)).toThrow();
		expect(() => parseRequest("hello")).toThrow();
		expect(() => parseRequest([])).toThrow();
	});

	it("validates systemPrompt and tools shape", () => {
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: "not array", messages: [] } })).toThrow(
			/systemPrompt/,
		);
		expect(() => parseRequest({ modelId: "x", context: { messages: [], tools: "not array" } })).toThrow(/tools/);
	});

	it("skips null and undefined option values", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { temperature: null, topP: undefined, maxTokens: 100 },
		});
		expect("temperature" in parsed.options).toBe(false);
		expect("topP" in parsed.options).toBe(false);
		expect(parsed.options.maxTokens).toBe(100);
	});
});

describe("pi-native gateway turn authority", () => {
	const envelope = (turnBudgetId: string, remainingAttempts: number, maxAttempts: number) => ({
		turnBudgetId,
		remainingAttempts,
		remainingDurationMs: 60_000,
		maxAttempts,
		outerReservationId: crypto.randomUUID(),
	});

	function composedRequests(max: number, requests: readonly number[]): { physical: number; denied: number } {
		const turnBudgetId = crypto.randomUUID();
		let physical = 0;
		let denied = 0;
		for (const innerClaims of requests) {
			try {
				const controller = gatewayAttemptController(envelope(turnBudgetId, max, max));
				physical += 1;
				for (let i = 0; i < innerClaims; i += 1) {
					controller?.("provider-http");
					physical += 1;
				}
			} catch {
				denied += 1;
			}
		}
		return { physical, denied };
	}

	it("denies at 0 before upstream activity", () => {
		expect(composedRequests(0, [1])).toEqual({ physical: 0, denied: 1 });
	});

	it("spends one attempt on the outer admission", () => {
		expect(composedRequests(1, [1])).toEqual({ physical: 1, denied: 1 });
	});

	it("composes outer, credential, provider, and reconnect claims up to max", () => {
		expect(composedRequests(4, [3])).toEqual({ physical: 4, denied: 0 });
	});

	it("denies max+1 inner activity before it becomes physical", () => {
		expect(composedRequests(4, [4])).toEqual({ physical: 4, denied: 1 });
	});

	it("allows repeated outer retries after inner claims without exceeding max", () => {
		expect(composedRequests(4, [1, 0, 1])).toEqual({ physical: 4, denied: 1 });
	});

	it("rejects replayed reservations but not stale client remaining snapshots", () => {
		const turnBudgetId = crypto.randomUUID();
		const first = envelope(turnBudgetId, 3, 3);
		gatewayAttemptController(first);
		expect(() => gatewayAttemptController(first)).toThrow(/replayed/);
		expect(() => gatewayAttemptController(envelope(turnBudgetId, 3, 3))).not.toThrow();
	});
});

describe("pi-native gateway production composition", () => {
	it("reconciles admitted errors and SSE authority across shared outer and inner claims", async () => {
		let storageFails = false;
		let credentialActivity = 0;
		let providerActivity = 0;
		registerCustomApi(
			GATEWAY_TEST_API,
			(_model, _context, options) => {
				options?.consumeAttempt?.("provider-http");
				providerActivity += 1;
				const stream = new EventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: baseAssistant() }));
				return stream;
			},
			GATEWAY_TEST_SOURCE,
		);
		const storage = {
			getApiKey: (_provider: string, _credential: undefined, options?: SimpleStreamOptions) => {
				options?.consumeAttempt?.("credential-refresh");
				if (storageFails) throw new Error("unsupported gateway test option");
				credentialActivity += 1;
				return "test-key";
			},
		} as unknown as AuthStorage;
		const gatewayModel = gatewayTestModel();

		await withPiNativeGateway(
			storage,
			() => gatewayModel,
			async gateway => {
				const clientModel = gatewayTestModel({ baseUrl: gateway.url, transport: "pi-native" });
				const controller = trackedAttemptController(crypto.randomUUID(), 6);
				let clientFetches = 0;
				const countingFetch: NonNullable<SimpleStreamOptions["fetch"]> = (input, init) => {
					clientFetches += 1;
					return fetch(input, init);
				};

				// A fresh equality envelope (remaining === max) is admitted. Each pass
				// spends gateway outer admission plus credential and provider activity.
				await streamPiNative(clientModel, baseContext, {
					apiKey: "test-token",
					consumeAttempt: controller,
					fetch: countingFetch,
				}).result();
				// The reconciled snapshot proves the real SSE gateway_authority trailer
				// reached and updated the client controller: 6 local minus gateway
				// admission + credential + provider = 3.
				expect(controller?.snapshot?.().remainingAttempts).toBe(3);
				await streamPiNative(clientModel, baseContext, {
					apiKey: "test-token",
					consumeAttempt: controller,
					fetch: countingFetch,
				}).result();
				expect(controller?.snapshot?.().remainingAttempts).toBe(0);
				expect({ credentialActivity, providerActivity, clientFetches }).toEqual({
					credentialActivity: 2,
					providerActivity: 2,
					clientFetches: 2,
				});

				// The third outer retry is denied locally from the authoritative SSE
				// trailer snapshot, before any HTTP activity, let alone provider work.
				await expect(
					streamPiNative(clientModel, baseContext, {
						apiKey: "test-token",
						consumeAttempt: controller,
						fetch: countingFetch,
					}).result(),
				).rejects.toThrow(/attempt budget exhausted/);
				expect(clientFetches).toBe(2);
				expect(providerActivity).toBe(2);

				// Replaying an admitted reservation is rejected at the real HTTP route.
				const replayEnvelope = {
					turnBudgetId: crypto.randomUUID(),
					remainingAttempts: 3,
					remainingDurationMs: 60_000,
					maxAttempts: 3,
					outerReservationId: crypto.randomUUID(),
				};
				const replayBody = JSON.stringify({
					modelId: gatewayModel.id,
					context: baseContext,
					attemptBudget: replayEnvelope,
					stream: true,
				});
				const replayHeaders = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
				const first = await fetch(`${gateway.url}/v1/pi/stream`, {
					method: "POST",
					headers: replayHeaders,
					body: replayBody,
				});
				await first.body?.cancel();
				const replay = await fetch(`${gateway.url}/v1/pi/stream`, {
					method: "POST",
					headers: replayHeaders,
					body: replayBody,
				});
				expect(replay.status).toBe(400);
				expect(await replay.text()).toContain("replayed outer reservation");

				// An admitted pre-stream credential failure carries the authority header,
				// so the pi-native client reconciles before surfacing the error.
				storageFails = true;
				const failedController = trackedAttemptController(crypto.randomUUID(), 3);
				await expect(
					streamPiNative(clientModel, baseContext, {
						apiKey: "test-token",
						consumeAttempt: failedController,
					}).result(),
				).rejects.toThrow(/unsupported gateway test option/);
				const snapshot = failedController?.snapshot?.();
				expect(snapshot?.remainingAttempts).toBe(1);
			},
		);
	});
});
describe("pi-native encodeStream", () => {
	it("ships every AssistantMessageEvent verbatim, terminated by [DONE]", async () => {
		// Pi-native is gjc-talks-to-gjc: the client feeds parsed events directly
		// into `AssistantMessageEventStream.push()`, so the wire IS the canonical
		// event type. No partial-stripping, no per-event re-shaping.
		const finalMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: { ...ZERO_USAGE, input: 4, output: 2, totalTokens: 6 },
		});
		const partialAfterDelta: AssistantMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
		});
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_start", contentIndex: 0, partial: baseAssistant({ content: [{ type: "text", text: "" }] }) },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial: partialAfterDelta },
			{ type: "text_end", contentIndex: 0, content: "hi", partial: partialAfterDelta },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const chunks = await collectSse(encodeStream(makeEventStream(events, finalMessage)));
		const parsed = chunks.map(parseSseLine);

		// Every payload is the input event verbatim — partials, signatures,
		// usage all intact. Terminator follows `done`/`error`.
		expect(parsed.length).toBe(events.length + 1);
		for (let i = 0; i < events.length; i++) {
			expect(parsed[i]).toEqual(JSON.parse(JSON.stringify(events[i])));
		}
		expect(parsed[parsed.length - 1]).toBe("[DONE]");
	});

	it("preserves the rolling `partial` on every delta (sanity: no shrink)", async () => {
		// Guards against an accidental re-introduction of partial-stripping
		// optimization. Clients depend on `partial` being present.
		const final = baseAssistant({ content: [{ type: "text", text: "abc" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "abc", partial: final },
			{ type: "done", reason: "stop", message: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine) as Array<
			Record<string, unknown>
		>;
		expect(parsed[0]).toHaveProperty("partial");
		expect((parsed[0] as { partial: AssistantMessage }).partial.content).toEqual([{ type: "text", text: "abc" }]);
	});

	it("stops streaming after a terminal `done` and emits [DONE] once", async () => {
		const final = baseAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "done", reason: "stop", message: final },
			// This trailing event must NOT reach the wire — terminal events end
			// the stream so the client iterator resolves cleanly.
			{ type: "text_delta", contentIndex: 0, delta: "ghost", partial: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine);
		expect(parsed.length).toBe(2);
		expect((parsed[0] as { type: string }).type).toBe("done");
		expect(parsed[1]).toBe("[DONE]");
	});

	it("forwards `error` events verbatim, then closes with [DONE]", async () => {
		const errored = baseAssistant({
			stopReason: "error",
			errorMessage: "upstream blew up",
			usage: { ...ZERO_USAGE, input: 3 },
		});
		const events: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, errored)))).map(parseSseLine);
		expect(parsed[0]).toEqual({ type: "error", reason: "error", error: JSON.parse(JSON.stringify(errored)) });
		expect(parsed[1]).toBe("[DONE]");
	});

	it("emits a synthetic error envelope when the source iterator throws", async () => {
		// Source-stream failures (network drop after `streamSimple` returned)
		// must not hang the client. We surface a minimal `error` event followed
		// by `[DONE]` so the iterator on the other end resolves.
		const broken = (async function* () {
			yield { type: "start", partial: baseAssistant() } satisfies AssistantMessageEvent;
			throw new Error("connection reset");
		})() as unknown as AssistantMessageEventStream;
		(broken as { result(): Promise<AssistantMessage> }).result = async () => baseAssistant();

		const parsed = (await collectSse(encodeStream(broken))).map(parseSseLine);
		expect((parsed[0] as { type: string }).type).toBe("start");
		expect(parsed[1]).toEqual({ type: "error", reason: "error", errorMessage: "connection reset" });
		expect(parsed[2]).toBe("[DONE]");
	});
});

describe("pi-native formatError", () => {
	it("emits { error: { type, message } } with the given status", async () => {
		const res = formatError(401, "authentication_error", "no credential");
		expect(res.status).toBe(401);
		expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(await res.json()).toEqual({ error: { type: "authentication_error", message: "no credential" } });
	});
});
