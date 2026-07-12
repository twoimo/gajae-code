import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import type { ImageContent, SimpleStreamOptions } from "@gajae-code/ai";
import { z } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { createAssistantMessage } from "./helpers";

describe("Agent", () => {
	it("should support steering message queueing", async () => {
		const agent = new Agent();

		const message = { role: "user" as const, content: "Queued message", timestamp: Date.now() };
		agent.steer(message);

		// The message is queued but not yet in state.messages
		expect(agent.state.messages).not.toContainEqual(message);
	});

	it("continue() should process queued follow-up messages after an assistant turn", async () => {
		const mock = createMockModel({ responses: [{ content: ["Processed"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage([{ type: "text", text: "Initial response" }]),
		]);

		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const hasQueuedFollowUp = agent.state.messages.some(message => {
			if (message.role !== "user") return false;
			if (typeof message.content === "string") return message.content === "Queued follow-up";
			return message.content.some(part => part.type === "text" && part.text === "Queued follow-up");
		});

		expect(hasQueuedFollowUp).toBe(true);
		expect(agent.state.messages[agent.state.messages.length - 1].role).toBe("assistant");
	});

	it("appends one finalized assistant message per provider response", async () => {
		const mock = createMockModel({ responses: [{ content: ["once"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		const ended: AgentMessage[] = [];
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") ended.push(event.message);
		});

		await agent.prompt("hello");

		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
		expect(ended).toHaveLength(1);
	});

	it("appends and emits one error assistant message when the provider fails before start", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			streamFn: () => {
				const response = new AssistantMessageEventStream();
				queueMicrotask(() => response.fail(new Error("gateway unavailable")));
				return response;
			},
			initialState: { model: mock.model, systemPrompt: [], messages: [], tools: [] },
		});
		const ended: AgentMessage[] = [];
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") ended.push(event.message);
		});

		await agent.prompt("hello");

		const assistantMessages = agent.state.messages.filter(message => message.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(ended).toHaveLength(1);
		expect(agent.state.error).toBe("gateway unavailable");
	});

	it("appends and emits one error assistant message preserving partial content", async () => {
		const mock = createMockModel();
		const partial = createAssistantMessage([{ type: "text", text: "partial response" }]);
		const agent = new Agent({
			streamFn: () => {
				const response = new AssistantMessageEventStream();
				response.push({ type: "start", partial });
				queueMicrotask(() => response.fail(new Error("connection lost")));
				return response;
			},
			initialState: { model: mock.model, systemPrompt: [], messages: [], tools: [] },
		});
		const ended: AgentMessage[] = [];
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") ended.push(event.message);
		});

		await agent.prompt("hello");

		const assistantMessages = agent.state.messages.filter(message => message.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(ended).toHaveLength(1);
		const finalized = assistantMessages[0];
		if (finalized?.role !== "assistant") throw new Error("Expected assistant message");
		expect(finalized.content).toEqual(partial.content);
		expect(agent.state.error).toBe("connection lost");
	});

	it("uses Cursor splitting instead of appending the finalized assistant message", async () => {
		const preamble = createAssistantMessage([{ type: "text", text: "Before tools" }]);
		const finalMessage = createAssistantMessage([{ type: "text", text: "Before tools after tools" }]);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "cursor-tool",
			toolName: "read",
			content: [{ type: "text" as const, text: "tool output" }],
			isError: false,
			timestamp: Date.now(),
		};
		const agent = new Agent({
			cursorOnToolResult: async () => undefined,
			streamFn: async (_model, _context, options) => {
				const response = new AssistantMessageEventStream();
				void (async () => {
					response.push({ type: "start", partial: preamble });
					response.push({ type: "text_delta", contentIndex: 0, delta: "Before tools", partial: preamble });
					await Bun.sleep(0);
					await options?.cursorOnToolResult?.(toolResult);
					response.push({ type: "done", reason: "stop", message: finalMessage });
				})();
				return response;
			},
		});

		await agent.prompt("hello");

		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(agent.state.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(agent.state.messages).not.toContain(finalMessage);
	});

	it("continue() honors forced one-at-a-time follow-ups even when batching is enabled", async () => {
		const mock = createMockModel({
			responses: [{ content: ["Processed 1"] }, { content: ["Processed 2"] }],
		});
		const agent = new Agent({ streamFn: mock.stream, followUpMode: "all" });

		agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage([{ type: "text", text: "Initial response" }]),
		]);

		agent.followUp(
			{
				role: "user",
				content: [{ type: "text", text: "Queued follow-up 1" }],
				timestamp: Date.now(),
			},
			{ forceOneAtATime: true },
		);
		agent.followUp(
			{
				role: "user",
				content: [{ type: "text", text: "Queued follow-up 2" }],
				timestamp: Date.now() + 1,
			},
			{ forceOneAtATime: true },
		);

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(mock.calls.length).toBe(2);
	});

	it("continue() should keep one-at-a-time steering semantics from assistant tail", async () => {
		const mock = createMockModel({
			responses: [{ content: ["Processed 1"] }, { content: ["Processed 2"] }],
		});
		const agent = new Agent({ streamFn: mock.stream });

		agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			createAssistantMessage([{ type: "text", text: "Initial response" }]),
		]);

		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 1" }],
			timestamp: Date.now(),
		});
		agent.steer({
			role: "user",
			content: [{ type: "text", text: "Steering 2" }],
			timestamp: Date.now() + 1,
		});

		await expect(agent.continue()).resolves.toBeUndefined();

		const recentMessages = agent.state.messages.slice(-4);
		expect(recentMessages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(mock.calls.length).toBe(2);
	});

	it("prompt() rejects image-placeholder-only text without image payload", async () => {
		const mock = createMockModel({ responses: [{ content: ["unreachable"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		await expect(agent.prompt("[image 1]")).rejects.toThrow("#paste-image");
		await expect(agent.prompt("[image 1]\n[image 2]", [])).rejects.toThrow("@path/to/image.png");
		expect(mock.calls).toHaveLength(0);
	});

	it("prompt() allows image-placeholder-only text when image payload is attached", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ streamFn: mock.stream });
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

		await expect(agent.prompt("[image 1]", [image])).resolves.toBeUndefined();

		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0].context.messages[0].content).toEqual([{ type: "text", text: "[image 1]" }, image]);
	});

	it("prompt() allows normal text that mentions an image placeholder", async () => {
		const mock = createMockModel({ responses: [{ content: ["ok"] }] });
		const agent = new Agent({ streamFn: mock.stream });

		await expect(agent.prompt("Please explain why [image 1] is missing.")).resolves.toBeUndefined();

		expect(mock.calls).toHaveLength(1);
	});
	it("prompt() refreshes tools and system prompt between same-turn model calls", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };

		const betaTool: AgentTool<typeof toolSchema, Details> = {
			name: "beta",
			label: "Beta",
			description: "Beta tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `beta:${params.value}` }], details: { value: params.value } };
			},
		};
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["prompt-one"],
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setSystemPrompt(["prompt-two"]);
				agent.setTools([alphaTool, betaTool]);
			}
		});

		await agent.prompt("refresh tools");
		unsubscribe();

		const observed = mock.calls.map(call => ({
			systemPrompt: call.context.systemPrompt?.join("\n\n") ?? "",
			toolNames: (call.context.tools ?? []).map(tool => tool.name),
		}));
		expect(observed).toEqual([
			{ systemPrompt: "prompt-one", toolNames: ["alpha"] },
			{ systemPrompt: "prompt-two", toolNames: ["alpha", "beta"] },
		]);
	});

	it("prompt() drops stale forced toolChoice after same-turn tool refresh", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };

		const betaTool: AgentTool<typeof toolSchema, Details> = {
			name: "beta",
			label: "Beta",
			description: "Beta tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `beta:${params.value}` }], details: { value: params.value } };
			},
		};
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setTools([betaTool]);
			}
		});

		await agent.prompt("refresh tools", { toolChoice: { type: "function", name: "alpha" } });
		unsubscribe();

		const observed = mock.calls.map(call => ({
			toolNames: (call.context.tools ?? []).map(tool => tool.name),
			toolChoice: call.options?.toolChoice,
		}));
		expect(observed).toEqual([
			{ toolNames: ["alpha"], toolChoice: { type: "function", name: "alpha" } },
			{ toolNames: ["beta"], toolChoice: undefined },
		]);
	});

	it("re-reads thinking level for each model call within a run", async () => {
		const toolSchema = z.object({ value: z.string() });
		type Details = { value: string };
		const alphaTool: AgentTool<typeof toolSchema, Details> = {
			name: "alpha",
			label: "Alpha",
			description: "Alpha tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `alpha:${params.value}` }], details: { value: params.value } };
			},
		};

		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "alpha", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});

		const agent = new Agent({
			initialState: {
				model: mock.model,
				thinkingLevel: ThinkingLevel.Low,
				tools: [alphaTool],
				messages: [],
			},
			streamFn: mock.stream,
		});

		// Bump thinking level mid-run, after the first assistant turn finishes
		// and before the second model call (which follows the tool result).
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "toolResult") {
				agent.setThinkingLevel(ThinkingLevel.High);
			}
		});

		await agent.prompt("run");
		unsubscribe();

		const reasoningPerCall: Array<SimpleStreamOptions["reasoning"]> = mock.calls.map(call => call.options?.reasoning);
		expect(reasoningPerCall).toEqual([ThinkingLevel.Low, ThinkingLevel.High]);
	});

	it("returns static metadata via the plain setter", () => {
		const agent = new Agent();
		expect(agent.metadata).toBeUndefined();

		const value = { user_id: "static" };
		agent.metadata = value;
		expect(agent.metadata).toEqual({ user_id: "static" });

		agent.metadata = undefined;
		expect(agent.metadata).toBeUndefined();
	});

	it("metadataForProvider resolves dynamic value at every call when a resolver is installed", () => {
		const agent = new Agent();
		let live = "alpha";
		agent.setMetadataResolver(() => ({ user_id: live }));

		expect(agent.metadataForProvider("anthropic")).toEqual({ user_id: "alpha" });
		live = "beta";
		expect(agent.metadataForProvider("anthropic")).toEqual({ user_id: "beta" });
		// Static getter is unaffected by the resolver.
		expect(agent.metadata).toBeUndefined();
	});

	it("clears any installed resolver when assigning the plain setter", () => {
		const agent = new Agent();
		agent.setMetadataResolver(() => ({ user_id: "from-resolver" }));
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-resolver" });

		agent.metadata = { user_id: "from-static" };
		expect(agent.metadata).toEqual({ user_id: "from-static" });
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-static" });
	});

	it("metadataForProvider returns undefined from the resolver even when a static value is set", () => {
		// Pin the contract that an installed resolver wins unconditionally over
		// `#metadata` in the per-provider path.
		const agent = new Agent();
		agent.metadata = { user_id: "static" };
		agent.setMetadataResolver(() => undefined);
		expect(agent.metadataForProvider("any")).toBeUndefined();
		// The static getter returns the pre-set static value; the resolver does not affect it.
		expect(agent.metadata).toEqual({ user_id: "static" });
	});

	it("reverts to the plain-setter value when the resolver is cleared via setMetadataResolver(undefined)", () => {
		const agent = new Agent();
		agent.metadata = { user_id: "static" };
		agent.setMetadataResolver(() => ({ user_id: "from-resolver" }));
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "from-resolver" });

		agent.setMetadataResolver(undefined);
		expect(agent.metadataForProvider("any")).toEqual({ user_id: "static" });
		expect(agent.metadata).toEqual({ user_id: "static" });
	});
});
