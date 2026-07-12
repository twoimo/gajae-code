import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeBrokerDiscovery } from "../../src/sdk/broker/discovery";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coord-race-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/**
 * Regression for the #1964 blocker: concurrent stdio dispatch let two same-session
 * `send_prompt` calls interleave their read-active-turn → write-new-turn, persisting two
 * "active" turns while only one active-turn pointer survived. The per-session mutation lock
 * must restore the atomicity the former serial read loop provided.
 */
describe("send_prompt same-session concurrency", () => {
	it("serializes concurrent same-session send_prompts to a single active turn", async () => {
		await withTempRoot(async root => {
			const sessionId = "sdk-race-session";
			const brokerUrl = "ws://127.0.0.1:4312";
			const sessionUrl = "ws://127.0.0.1:4313";
			const agentDir = path.join(root, ".gjc", "agent");
			await writeBrokerDiscovery(agentDir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "test-owner",
				pid: process.pid,
				host: "127.0.0.1",
				port: 4312,
				url: brokerUrl,
				token: "broker-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			});
			await fs.mkdir(path.join(root, ".gjc", "state", "sdk"), { recursive: true });
			await Bun.write(
				path.join(root, ".gjc", "state", "sdk", `${sessionId}.json`),
				JSON.stringify({ version: 1, url: sessionUrl, token: "session-token" }),
			);

			const server = await createCoordinatorMcpServer({
				env: {
					GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
					GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".state"),
					GJC_COORDINATOR_MCP_PROFILE: "race-controller",
					GJC_COORDINATOR_MCP_REPO: "repo-race",
				},
				services: {
					connectSdk: async url =>
						url === brokerUrl
							? ({
									global: async (operation: string) => {
										expect(operation).toBe("session.create");
										return { result: { sessionId } };
									},
									close: async () => {},
								} as never)
							: ({
									control: async (operation: string) => {
										expect(operation).toBe("turn.prompt");
										return { accepted: true };
									},
									close: async () => {},
								} as never),
				},
			});

			const started = await server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				idempotency_key: "start-session",
				allow_mutation: true,
			});
			expect(started.ok).toBe(true);
			expect((started.session as { session_id: string }).session_id).toBe(sessionId);

			// The exact race the maintainer reproduced 25/25: two same-session prompts at once.
			const results = await Promise.all([
				server.callTool("gjc_coordinator_send_prompt", {
					session_id: sessionId,
					prompt: "first concurrent prompt",
					idempotency_key: "first-prompt",
					allow_mutation: true,
				}),
				server.callTool("gjc_coordinator_send_prompt", {
					session_id: sessionId,
					prompt: "second concurrent prompt",
					idempotency_key: "second-prompt",
					allow_mutation: true,
				}),
			]);

			const actives = results.filter(r => r.ok === true && r.status === "active");
			const conflicts = results.filter(
				r => r.ok === false && (r.error as { code?: string } | undefined)?.code === "active_turn_exists",
			);

			// Serialized: exactly one wins the active turn; the other observes it and is rejected.
			// Without the lock both persisted `status: "active"` (actives.length === 2).
			expect(actives.length).toBe(1);
			expect(conflicts.length).toBe(1);
			expect(conflicts[0]?.turn_id).toBe(actives[0]?.turn_id);
		});
	});
});
