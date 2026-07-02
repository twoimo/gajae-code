import { describe, expect, it } from "bun:test";
import { AgentSessionHost, type AppServerEventEmitter } from "../src/modes/app-server/agent-session-host";
import type { AgentSessionEvent } from "../src/session/agent-session";

class FakeSession {
	readonly sessionId = "thr_fake_session";
	readonly events: Array<(event: AgentSessionEvent) => void> = [];
	prompts: Array<{ text: string; options: unknown }> = [];
	state = { status: "idle" };
	messages: unknown[] = [];
	models: unknown[] = [];
	compactions: unknown[] = [];
	todos: unknown[] = [];
	execCalls: Array<{ command: string; options: unknown }> = [];
	abortCount = 0;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.events.push(listener);
		return () => {
			const index = this.events.indexOf(listener);
			if (index !== -1) this.events.splice(index, 1);
		};
	}

	async prompt(text: string, options?: unknown): Promise<void> {
		this.prompts.push({ text, options });
	}

	async steer(): Promise<void> {}
	async abort(): Promise<void> {
		this.abortCount += 1;
	}
	async executeBash(command: string, _onChunk?: unknown, options?: unknown): Promise<unknown> {
		this.execCalls.push({ command, options });
		return { exitCode: 0 };
	}
	async setModel(model: unknown): Promise<void> {
		this.models.push(model);
	}
	async compact(customInstructions?: unknown): Promise<unknown> {
		this.compactions.push(customInstructions);
		return { ok: true };
	}
	async setTodos(todos: unknown): Promise<void> {
		this.todos.push(todos);
	}
	async dispose(): Promise<void> {}
}

describe("AgentSessionHost", () => {
	it("creates a session-backed thread and subscribes to events", async () => {
		const sessions: FakeSession[] = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => {
				const session = new FakeSession();
				sessions.push(session);
				return { session };
			},
		});

		const created = await host.createThread({ cwd: "/tmp/work" });

		expect(created.threadId).toBe("thr_fake_session");
		expect(created.sessionMetadata).toEqual({ cwd: "/tmp/work", sessionId: "thr_fake_session" });
		expect(sessions).toHaveLength(1);
		expect(sessions[0].events).toHaveLength(1);
	});

	it("maps app-server session metadata into createAgentSession options and returns it", async () => {
		const session = new FakeSession();
		let capturedOptions: any;
		const host = new AgentSessionHost({
			sessionFactory: async options => {
				capturedOptions = options;
				return { session };
			},
		});
		const created = await host.createThread({
			cwd: "/repo",
			sessionId: "provider-session",
			sessionDir: "/sessions/one",
			systemPromptAppend: "extra system",
			model: { provider: "anthropic", modelId: "claude" },
			thinking: { level: "high" },
			todos: [{ text: "ship" }],
		});

		expect(capturedOptions.cwd).toBe("/repo");
		expect(capturedOptions.providerSessionId).toBe("provider-session");
		expect(capturedOptions.model).toBeUndefined();
		expect(capturedOptions.modelPattern).toBe("anthropic/claude");
		expect(capturedOptions.thinkingLevel).toBe("high");
		expect(capturedOptions.systemPrompt(["base"])).toEqual(["base", "extra system"]);
		expect(created).toEqual({
			threadId: "thr_fake_session",
			resumed: false,
			sessionMetadata: {
				cwd: "/repo",
				sessionId: "thr_fake_session",
				sessionDir: "/sessions/one",
				systemPromptAppend: "extra system",
				model: { provider: "anthropic", modelId: "claude" },
				thinking: { level: "high" },
				todos: [{ text: "ship" }],
			},
		});
	});

	it("returns an explicit resume fallback diagnostic when true SDK resume is unavailable", async () => {
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session: new FakeSession() }) });
		const created = await host.resumeThread({ cwd: "/repo", sessionId: "existing", sessionDir: "/sessions/one" });

		expect(created.resumed).toBe(false);
		expect(created.sessionMetadata).toMatchObject({
			cwd: "/repo",
			sessionId: "thr_fake_session",
			sessionDir: "/sessions/one",
			resumed: false,
		});
	});

	it("routes prompt backend calls and returns a turn id", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		const result = await host.backendCall(created.threadId, "prompt", { text: "hello", options: { foo: true } });

		expect(session.prompts).toEqual([{ text: "hello", options: { foo: true } }]);
		expect(result).toEqual({ turnId: "thr_fake_session:1" });
	});

	it("forwards subscribed session events through the configured emitter", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session }),
			emit: (...args) => emitted.push(args),
		});
		await host.createThread({});

		session.events[0]({ type: "agent_start" } as AgentSessionEvent);

		expect(emitted).toEqual([["thr_fake_session", 1, "agent_start", { type: "agent_start" }]]);
	});

	it("updates event generation from backend call context", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session }),
			emit: (...args) => emitted.push(args),
		});
		const created = await host.createThread({});

		await host.backendCall(created.threadId, "prompt", { text: "after resume" }, 2);
		session.events[0]({ type: "agent_start" } as AgentSessionEvent);

		expect(emitted).toEqual([["thr_fake_session", 2, "agent_start", { type: "agent_start" }]]);
	});

	it("routes Rust backend payload shapes to session methods", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});
		const phases = [{ title: "phase 1", items: [{ text: "ship", done: false }] }];

		await host.backendCall(created.threadId, "setModel", { provider: "anthropic", modelId: "claude-opus" });
		await host.backendCall(created.threadId, "compact", { customInstructions: "keep the API contract" });
		await host.backendCall(created.threadId, "setTodos", phases);

		expect(session.models).toEqual([{ provider: "anthropic", modelId: "claude-opus" }]);
		expect(session.compactions).toEqual(["keep the API contract"]);
		expect(session.todos).toEqual([phases]);
	});

	it("keeps compatibility fallbacks for legacy backend payload shapes", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});
		const todos = [{ text: "legacy" }];

		await host.backendCall(created.threadId, "setModel", { provider: "openai", model: "gpt-4.1" });
		await host.backendCall(created.threadId, "compact", { instructions: "legacy compact" });
		await host.backendCall(created.threadId, "setTodos", { todos });

		expect(session.models).toEqual([{ provider: "openai", modelId: "gpt-4.1" }]);
		expect(session.compactions).toEqual(["legacy compact"]);
		expect(session.todos).toEqual([todos]);
	});

	it("accepts exec command payloads as bare strings and string arrays", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		await host.backendCall(created.threadId, "exec", "echo bare");
		await host.backendCall(created.threadId, "exec", ["printf", "%s", "array"]);
		await host.backendCall(created.threadId, "exec", {
			command: "echo object",
			options: { excludeFromContext: true },
		});
		await host.backendCall(created.threadId, "exec", {
			command: ["node", "-e", "console.log(1)"],
			cwd: "/tmp/work",
			timeoutMs: 123,
		});

		expect(session.execCalls).toEqual([
			{ command: "echo bare", options: undefined },
			{ command: "printf %s array", options: undefined },
			{ command: "echo object", options: { excludeFromContext: true } },
			{ command: "node -e console.log(1)", options: { cwd: "/tmp/work", timeoutMs: 123 } },
		]);
	});

	it("does not bump event generation after abort", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session }),
			emit: (...args) => emitted.push(args),
		});
		const created = await host.createThread({});

		await host.backendCall(created.threadId, "abort", {});
		session.events[0]({ type: "agent_stop" } as unknown as AgentSessionEvent);

		expect(session.abortCount).toBe(1);
		expect(emitted).toEqual([["thr_fake_session", 1, "agent_stop", { type: "agent_stop" }]]);
	});

	it("passes registered host tools as custom tools that delegate through the native bridge", async () => {
		const session = new FakeSession();
		let capturedOptions: any;
		const bridge = {
			hostToolNames: () => ["host_echo"],
			activeTurnId: (threadId: string) => {
				expect(threadId).toBe("thr_fake_session");
				return "turn-real";
			},
			callHostTool: async (threadId: string, turnId: string, tool: string, argsJson: string) => {
				expect(threadId).toBe("thr_fake_session");
				expect(turnId).toBe("turn-real");
				expect(tool).toBe("host_echo");
				expect(JSON.parse(argsJson)).toEqual({ value: 7 });
				return JSON.stringify({ ok: true });
			},
		};
		const host = new AgentSessionHost({
			appServer: bridge,
			sessionFactory: async options => {
				capturedOptions = options;
				return { session };
			},
		});

		await host.createThread({
			hostTools: [{ name: "host_echo", description: "Echo", inputSchema: { type: "object" } }],
		});
		const tool = capturedOptions.customTools[0];
		const result = await tool.execute("call_1", { value: 7 }, undefined as never, undefined as never);

		expect(tool.name).toBe("host_echo");
		expect(result).toEqual({
			content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
			details: { ok: true },
		});
	});
});
