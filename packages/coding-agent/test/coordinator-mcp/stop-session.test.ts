import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SdkClient } from "../../src/sdk/client/client";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

type BrokerControl = { operation: string; input: Record<string, unknown>; idempotencyKey?: string };

async function createServer(root: string, options: { forceStop?: boolean; closeFails?: boolean } = {}) {
	const stateRoot = path.join(root, ".gjc", "coordinator-state");
	const controls: BrokerControl[] = [];
	await fs.mkdir(path.join(root, ".gjc", "agent", "sdk"), { recursive: true });
	await Bun.write(
		path.join(root, ".gjc", "agent", "sdk", "broker.json"),
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test",
			pid: process.pid,
			host: "127.0.0.1",
			port: 1,
			url: "ws://sdk.example.test",
			token: "test-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);
	const server = createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
			...(options.forceStop ? { GJC_COORDINATOR_MCP_FORCE_STOP: "1" } : {}),
		},
		services: {
			connectSdk: async () =>
				({
					global: async (
						operation: string,
						input: Record<string, unknown>,
						opts: { idempotencyKey?: string } = {},
					) => {
						controls.push({ operation, input, idempotencyKey: opts.idempotencyKey });
						if (operation === "session.close" && options.closeFails)
							return { ok: false, error: { code: "close_refused", message: "SDK refused close" } };
						return { ok: true, result: { sessionId: input.sessionId } };
					},
					close: async () => {},
				}) as unknown as SdkClient,
		},
	});
	return {
		server,
		controls,
		sessionFile: (id: string) => path.join(stateRoot, "local", "repo", "sessions", `${id}.json`),
	};
}

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-stop-"));
	tempDirs.push(root);
	return root;
}

async function writeSession(
	file: string,
	root: string,
	id: string,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(
		file,
		JSON.stringify({
			session_id: id,
			cwd: root,
			created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
			...overrides,
		}),
	);
}

describe("gjc_coordinator_stop_session SDK lifecycle", () => {
	it("refuses a non-ephemeral session without force and never invokes lifecycle close", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		await writeSession(sessionFile("registered"), root, "registered");

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "registered", allow_mutation: true }),
		).toMatchObject({ ok: false, reason: "not_ephemeral", closed: false });
		expect(controls).toEqual([]);
	});

	it("requires the force-stop capability before closing a non-ephemeral session", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		await writeSession(sessionFile("registered"), root, "registered");

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "registered",
				force: true,
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, reason: "force_not_authorized", closed: false });
		expect(controls).toEqual([]);
	});

	it("closes an idle ephemeral session through the SDK broker and removes only coordinator metadata", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		await writeSession(sessionFile("ephemeral"), root, "ephemeral", { ephemeral: true });

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "ephemeral", allow_mutation: true }),
		).toMatchObject({ ok: true, closed: true, session_id: "ephemeral" });
		expect(controls).toEqual([
			expect.objectContaining({ operation: "session.close", input: { sessionId: "ephemeral" } }),
		]);
		expect(await Bun.file(sessionFile("ephemeral")).exists()).toBe(false);
	});

	it("retains coordinator metadata when the SDK broker cannot verify closure", async () => {
		const root = await tempRoot();
		const { server, sessionFile } = await createServer(root, { closeFails: true });
		await writeSession(sessionFile("wedged"), root, "wedged", { ephemeral: true });

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: "wedged", allow_mutation: true }),
		).toMatchObject({ ok: false, reason: "close_failed", detail: "close_refused", closed: false });
		expect(await Bun.file(sessionFile("wedged")).exists()).toBe(true);
	});

	it("does not close a session with an active durable turn", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		const sessionId = "active";
		const turnId = "turn-00000000-0000-4000-8000-000000000001";
		await writeSession(sessionFile(sessionId), root, sessionId, { ephemeral: true });
		const namespaceDir = path.dirname(path.dirname(sessionFile(sessionId)));
		await fs.mkdir(path.join(namespaceDir, "turns"), { recursive: true });
		await fs.mkdir(path.join(namespaceDir, "active-turns"), { recursive: true });
		await Bun.write(
			path.join(namespaceDir, "active-turns", `${sessionId}.json`),
			JSON.stringify({ session_id: sessionId, turn_id: turnId }),
		);
		await Bun.write(
			path.join(namespaceDir, "turns", `${turnId}.json`),
			JSON.stringify({ session_id: sessionId, turn_id: turnId, status: "active" }),
		);

		expect(
			await server.callTool("gjc_coordinator_stop_session", { session_id: sessionId, allow_mutation: true }),
		).toMatchObject({ ok: false, reason: "active_turn", active_turn_id: turnId, closed: false });
		expect(controls).toEqual([]);
	});

	it("sweeps only idle ephemeral coordinator records", async () => {
		const root = await tempRoot();
		const { server, controls, sessionFile } = await createServer(root);
		await writeSession(sessionFile("idle"), root, "idle", { ephemeral: true });
		await writeSession(sessionFile("registered"), root, "registered");

		expect(await server.sessionReaper.sweepOnce()).toBe(1);
		expect(controls).toEqual([expect.objectContaining({ operation: "session.close", input: { sessionId: "idle" } })]);
		expect(await Bun.file(sessionFile("idle")).exists()).toBe(false);
		expect(await Bun.file(sessionFile("registered")).exists()).toBe(true);
	});
});
