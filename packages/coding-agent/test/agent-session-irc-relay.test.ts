import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import { Agent } from "@gajae-code/agent-core";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { RalplanIrcCoordinator } from "@gajae-code/coding-agent/gjc-runtime/ralplan-irc-coordinator";
import { AgentRegistry, MAIN_AGENT_ID } from "@gajae-code/coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const sessions: AgentSession[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
});

function createSession(agentId: string, registry: AgentRegistry): AgentSession {
	const session = new AgentSession({
		agent: new Agent({ initialState: { systemPrompt: ["system prompt"], messages: [], tools: [] } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
		agentId,
		agentRegistry: registry,
	});
	sessions.push(session);
	return session;
}

describe("AgentSession IRC relay", () => {
	it("relays real child observations for display only and deduplicates them in the bound pass", async () => {
		const registry = new AgentRegistry();
		const main = createSession(MAIN_AGENT_ID, registry);
		const planner = createSession("planner", registry);
		const critic = createSession("critic", registry);
		const coordinator = new RalplanIrcCoordinator({ registry, cwd: "/tmp" });
		coordinator.startPass({ parentSessionId: "parent", runId: "run", stageN: 1, cursorGeneration: 1 });

		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: main });
		const plannerRegistration = registry.register({
			id: "planner",
			displayName: "planner",
			kind: "sub",
			session: planner,
		});
		const criticRegistration = registry.register({
			id: "critic",
			displayName: "critic",
			kind: "sub",
			session: critic,
		});
		coordinator.bindRegisteredChild("planner", {
			parentSessionId: "parent",
			runId: "run",
			role: "planner",
			token: plannerRegistration.token,
		});
		coordinator.bindRegisteredChild("critic", {
			parentSessionId: "parent",
			runId: "run",
			role: "critic",
			token: criticRegistration.token,
		});

		const mainEvents: AgentSessionEvent[] = [];
		main.subscribe(event => mainEvents.push(event));
		const mainMessageCount = main.messages.length;
		vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");

		await planner.respondAsBackground({ from: "critic", message: "review", awaitReply: false });
		await planner.respondAsBackground({ from: "critic", message: "review", awaitReply: false });
		await Bun.sleep(20);

		const relays = mainEvents.filter(
			(event): event is Extract<AgentSessionEvent, { type: "irc_message" }> =>
				event.type === "irc_message" && event.message.customType === "irc:relay",
		);
		expect(relays).toHaveLength(2);
		expect(relays[0]?.message).toMatchObject({
			display: true,
			details: {
				observationId: "00000000-0000-4000-8000-000000000001",
				from: "critic",
				to: "planner",
				body: "review",
				kind: "message",
			},
		});
		expect(main.messages).toHaveLength(mainMessageCount);
		expect(coordinator.transcript).toEqual([
			{
				observationId: "00000000-0000-4000-8000-000000000001",
				from: "critic",
				to: "planner",
				body: "review",
				kind: "message",
				timestamp: expect.any(Number),
				sequence: 1,
			},
		]);
		coordinator.close();
	});
});
