import { describe, expect, it } from "bun:test";
import { AgentSessionHost, type AppServerEventEmitter } from "../src/modes/app-server/agent-session-host";
import type { AgentSessionEvent } from "../src/session/agent-session";

class FakeSession {
	readonly sessionId = "thr_fake_session";
	readonly events: Array<(event: AgentSessionEvent) => void> = [];
	prompts: Array<{ text: string; options: unknown }> = [];
	state = { status: "idle" };
	messages: unknown[] = [];

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
	async abort(): Promise<void> {}
	async executeBash(): Promise<unknown> {
		return { exitCode: 0 };
	}
	async setModel(): Promise<void> {}
	async compact(): Promise<unknown> {
		return { ok: true };
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
});
