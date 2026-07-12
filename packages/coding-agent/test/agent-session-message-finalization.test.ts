import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { Settings } from "../src/config/settings";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession assistant message finalization", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("persists and emits one assistant segment for one provider response", async () => {
		const mock = createMockModel({ responses: [{ content: ["finalized once"] }] });
		const agent = new Agent({
			streamFn: mock.stream,
			initialState: { model: mock.model, systemPrompt: ["system prompt"], messages: [], tools: [] },
		});
		const sessionManager = SessionManager.inMemory();
		const appendMessage = vi.spyOn(sessionManager, "appendMessage");
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("hello");

		expect(appendMessage.mock.calls.filter(([message]) => message.role === "assistant")).toHaveLength(1);
		expect(events.filter(event => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			1,
		);
	});

	it("persists and emits one error assistant message when the provider fails before start", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			streamFn: () => {
				const response = new AssistantMessageEventStream();
				queueMicrotask(() => response.fail(new Error("gateway unavailable")));
				return response;
			},
			initialState: { model: mock.model, systemPrompt: ["system prompt"], messages: [], tools: [] },
		});
		const sessionManager = SessionManager.inMemory();
		const appendMessage = vi.spyOn(sessionManager, "appendMessage");
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),

			modelRegistry: { getApiKey: async () => "test-key" } as never,
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("hello");

		expect(appendMessage.mock.calls.filter(([message]) => message.role === "assistant")).toHaveLength(1);
		expect(events.filter(event => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			1,
		);
	});

	it("persists and emits one error assistant message preserving partial content", async () => {
		const mock = createMockModel();
		const partial = createAssistantMessage("partial response");
		const agent = new Agent({
			streamFn: () => {
				const response = new AssistantMessageEventStream();
				response.push({ type: "start", partial });
				queueMicrotask(() => response.fail(new Error("connection lost")));
				return response;
			},
			initialState: { model: mock.model, systemPrompt: ["system prompt"], messages: [], tools: [] },
		});
		const sessionManager = SessionManager.inMemory();
		const appendMessage = vi.spyOn(sessionManager, "appendMessage");
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("hello");

		expect(appendMessage.mock.calls.filter(([message]) => message.role === "assistant")).toHaveLength(1);
		expect(events.filter(event => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			1,
		);
		const assistant = agent.state.messages.find(message => message.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("Expected assistant message");
		expect(assistant.content).toEqual(partial.content);
	});
});
