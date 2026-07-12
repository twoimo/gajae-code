import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@gajae-code/ai";
import { streamSimple } from "@gajae-code/ai/stream";
import {
	type Api,
	type AssistantMessage,
	AttemptBudgetExceededError,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@gajae-code/ai/types";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

const SOURCE_ID = "stream-auth-retry-test";
const API = "stream-auth-retry-test" as Api;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantError(errorMessage: string, errorStatus?: number): AssistantMessage {
	return { ...assistant(), stopReason: "error", errorMessage, errorStatus };
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "test-model",
		api: API,
		provider: "test-provider",
		baseUrl: "mock://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 1024,
	};
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

describe("streamSimple auth retry", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("retries once with a fresh key when 401 happens before the first event", async () => {
		const keys: Array<string | undefined> = [];
		let authCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.fail(authError());
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async (provider, oldKey, error) => {
				authCalls += 1;
				expect(provider).toBe("test-provider");
				expect(oldKey).toBe("old-key");
				expect((error as { status?: number }).status).toBe(401);
				return "new-key";
			},
		});

		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(authCalls).toBe(1);
	});

	it("retries when a provider emits start then a 401 error event before content", async () => {
		const keys: Array<string | undefined> = [];
		const eventTypes: string[] = [];
		let authCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError(
								'Error: 401\n{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
							),
						});
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async (provider, oldKey, error) => {
				authCalls += 1;
				expect(provider).toBe("test-provider");
				expect(oldKey).toBe("old-key");
				expect((error as { status?: number }).status).toBe(401);
				return "new-key";
			},
		});

		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(eventTypes).toEqual(["start", "done"]);
		expect(authCalls).toBe(1);
	});

	it("does not retry after replay-unsafe content has been emitted", async () => {
		let authCalls = 0;
		const failure = authError();
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "text_start", contentIndex: 0, partial: assistant([""]) });
					stream.fail(failure);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => {
				authCalls += 1;
				return "new-key";
			},
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(failure);
		expect(authCalls).toBe(0);
	});

	it("retries on 401 carried via errorStatus when the message has no parseable status", async () => {
		const keys: Array<string | undefined> = [];
		let authCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				keys.push(options?.apiKey);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							// Realistic Anthropic SDK shape: message begins with `<status> <body>`
							// and the regex fallback in extractHttpStatusFromError cannot find 401
							// inside the JSON body. Only `errorStatus` carries the signal.
							error: assistantError(
								'{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
								401,
							),
						});
						return;
					}
					const message = assistant(["ok"]);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => {
				authCalls += 1;
				return "new-key";
			},
		});

		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(authCalls).toBe(1);
	});
	it("denies a 401 replay before the second physical transport with a one-attempt budget", async () => {
		const fetchCalls: string[] = [];
		let remainingAttempts = 1;
		registerCustomApi(
			API,
			(_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					try {
						const response = await options!.fetch!("https://provider.test/messages", {
							headers: { Authorization: `Bearer ${options?.apiKey}` },
						});
						fetchCalls.push(options?.apiKey ?? "");
						if (response.status === 401) {
							stream.fail(Object.assign(new Error("authentication failed"), { status: 401 }));
							return;
						}
						const message = assistant(["ok"]);
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					} catch (error) {
						stream.fail(error);
					}
				})();
				return stream;
			},
			SOURCE_ID,
		);

		const transportFetch: NonNullable<SimpleStreamOptions["fetch"]> = async (_input, init) => {
			const auth = new Headers(init?.headers).get("Authorization");
			return new Response(null, { status: auth === "Bearer old-key" ? 401 : 200 });
		};
		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			fetch: transportFetch,
			consumeAttempt: () => {
				if (remainingAttempts <= 0) throw new Error("Maximum total attempts exceeded");
				remainingAttempts -= 1;
			},
			onAuthError: async () => "new-key",
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toEqual(new Error("Maximum total attempts exceeded"));
		expect(fetchCalls).toEqual(["old-key"]);
	});
	it("preserves typed exhaustion from auth credential replay", async () => {
		const exhaustion = new AttemptBudgetExceededError("attempts", "Maximum total attempts exceeded");
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(authError()));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: "old-key",
			onAuthError: async () => {
				throw exhaustion;
			},
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(exhaustion);
	});
});
