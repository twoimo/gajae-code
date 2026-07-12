import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../src/coordinator-mcp/server";
import type { SdkClient } from "../src/sdk/client/client";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-server-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

type SdkControl = { operation: string; input: Record<string, unknown>; idempotencyKey?: string };

async function createSdkControlServer(
	root: string,
	controls: SdkControl[],
	queries: string[] = [],
	queryResult: (query: string) => unknown = query =>
		query === "context.get"
			? {
					type: "query_response",
					id: "query-1",
					ok: true,
					page: { items: [{ isStreaming: true }], complete: true, revision: "test" },
				}
			: {
					type: "query_response",
					id: "query-1",
					ok: true,
					page: { items: ["first assistant line\nlatest assistant line"], complete: true, revision: "test" },
				},
) {
	const stateRoot = path.join(root, ".gjc", "coordinator-state");
	let createdSessions = 0;
	const server = createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
			GJC_COORDINATOR_MCP_PROFILE: "local",
			GJC_COORDINATOR_MCP_REPO: "repo",
		},
		services: {
			resolveModelProfiles: () => new Map([["codex-eco", { name: "codex-eco" }]]),
			connectSdk: async () =>
				({
					control: async (
						operation: string,
						input: Record<string, unknown>,
						options: { idempotencyKey?: string },
					) => {
						controls.push({ operation, input, idempotencyKey: options.idempotencyKey });
						return { accepted: true, turn_id: `sdk-${controls.length}` };
					},
					global: async (
						operation: string,
						input: Record<string, unknown>,
						options: { idempotencyKey?: string } = {},
					) => {
						controls.push({ operation, input, idempotencyKey: options.idempotencyKey });
						if (operation === "session.create") {
							const sessionId = `created-session-${++createdSessions}`;
							await Bun.write(
								path.join(root, ".gjc", "state", "sdk", `${sessionId}.json`),
								JSON.stringify({ url: "ws://sdk.example.test", token: "test-token" }),
							);
							return { ok: true, result: { sessionId } };
						}
						return { ok: true, result: { sessionId: String(input.sessionId ?? "visible-session") } };
					},
					query: async (query: string) => {
						queries.push(query);
						return queryResult(query);
					},
					close: async () => {},
				}) as unknown as SdkClient,
		},
	});
	await fs.mkdir(path.join(root, ".gjc", "state", "sdk"), { recursive: true });
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
	await Bun.write(
		path.join(root, ".gjc", "state", "sdk", "visible-session.json"),
		JSON.stringify({ url: "ws://sdk.example.test", token: "test-token" }),
	);
	return server;
}

async function registerSdkSession(server: ReturnType<typeof createCoordinatorMcpServer>, root: string) {
	return await server.callTool("gjc_coordinator_register_session", {
		session_id: "visible-session",
		cwd: root,
		tmux_session: "visible-session",
		tmux_target: "visible-session:0.0",
		idempotency_key: "register-1",
		allow_mutation: true,
	});
}

describe("Coordinator MCP canonical SDK controls", () => {
	it("uses SDK discovery for registered-session authority and leaves tmux as advisory metadata", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const registered = await registerSdkSession(server, root);
		expect(registered).toMatchObject({ ok: true, registered: true, session_state: { state: "ready_for_input" } });
		const status = await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" });
		expect(status).toMatchObject({ ok: true, status: { live: true } });
		expect(controls).toEqual([
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" },
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: undefined },
		]);
	});
	it("reads bounded tail output through the SDK", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);

		await expect(
			server.callTool("gjc_coordinator_read_tail", { session_id: "visible-session", lines: 1 }),
		).resolves.toEqual({ ok: true, source: "sdk", lines: ["latest assistant line"] });
		expect(queries).toEqual(["session.last_assistant"]);
	});
	it("returns SDK query failures without a terminal fallback", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries, () => ({
			type: "query_response",
			id: "query-1",
			ok: false,
			error: { code: "unavailable", message: "session endpoint unavailable" },
		}));
		await registerSdkSession(server, root);

		await expect(
			server.callTool("gjc_coordinator_read_tail", { session_id: "visible-session" }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "unavailable" },
		});
		expect(queries).toEqual(["session.last_assistant"]);
	});
	it("reads active-turn status through SDK context", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});

		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: sent.turn_id })).resolves.toMatchObject({
			ok: true,
			advisory_status: { authority: "sdk", live: true, is_streaming: true },
		});
		expect(queries).toEqual(["context.get"]);
	});
	it("returns an explicit uncertain active-turn view when the SDK endpoint is absent", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const queries: string[] = [];
		const server = await createSdkControlServer(root, controls, queries);
		await registerSdkSession(server, root);
		const sent = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "work",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});
		await fs.rm(path.join(root, ".gjc", "state", "sdk", "visible-session.json"));

		await expect(server.callTool("gjc_coordinator_read_turn", { turn_id: sent.turn_id })).resolves.toMatchObject({
			ok: true,
			advisory_status: { authority: "sdk", live: null, reason: "not_found" },
		});
		expect(queries).toEqual([]);
	});

	it("passes a resolved mpreset into the SDK lifecycle create request and persists it with the session", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const started = await server.callTool("gjc_coordinator_start_session", {
			cwd: root,
			mpreset: "codex-eco",
			idempotency_key: "preset-start",
			allow_mutation: true,
		});
		expect(started).toMatchObject({ ok: true, session: { session_id: "created-session-1", mpreset: "codex-eco" } });
		expect(controls).toEqual([
			{
				operation: "session.create",
				input: { cwd: root, target: { path: root }, modelPreset: "codex-eco" },
				idempotencyKey: "preset-start",
			},
		]);
		await expect(
			fs.readFile(
				path.join(root, ".gjc", "coordinator-state", "local", "repo", "sessions", "created-session-1.json"),
				"utf8",
			),
		).resolves.toContain('"mpreset": "codex-eco"');
	});

	it("routes prompts, follow-ups, abort-and-prompts, and answers through SDK controls with caller keys", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "first",
			idempotency_key: "prompt-1",
			allow_mutation: true,
		});
		expect(first).toMatchObject({ ok: true, operation: "turn.prompt", turn: { status: "active" } });
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session",
			prompt: "follow up",
			queue: true,
			idempotency_key: "prompt-2",
			allow_mutation: true,
		});
		expect(queued).toMatchObject({ ok: true, operation: "turn.follow_up", turn: { status: "queued" } });
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "replace",
				force: true,
				idempotency_key: "prompt-3",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, operation: "turn.abort_and_prompt", turn: { status: "active" } });
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "visible-session",
				question_id: "ask-1",
				answer: { choice: "yes" },
				idempotency_key: "answer-1",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, operation: "ask.answer", result: { accepted: true } });
		expect(controls).toEqual([
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" },
			{ operation: "turn.prompt", input: { text: "first" }, idempotencyKey: "prompt-1" },
			{ operation: "turn.follow_up", input: { text: "follow up" }, idempotencyKey: "prompt-2" },
			{ operation: "turn.abort_and_prompt", input: { text: "replace" }, idempotencyKey: "prompt-3" },
			{ operation: "ask.answer", input: { id: "ask-1", answer: { choice: "yes" } }, idempotencyKey: "answer-1" },
		]);
	});

	it("delivers every delegation workflow through broker lifecycle and SDK control", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		for (const [tool, key] of [
			["gjc_delegate_plan", "plan"],
			["gjc_delegate_execute", "execute"],
			["gjc_delegate_team", "team"],
		] as const) {
			const result = await server.callTool(tool, {
				cwd: root,
				task: `${key} task`,
				idempotency_key: key,
				allow_mutation: true,
			});
			expect(result).toMatchObject({ ok: true, delivered: true, workflow: key });
		}
		expect(controls).toEqual(
			expect.arrayContaining([
				{ operation: "session.create", input: { cwd: root, target: { path: root } }, idempotencyKey: "plan" },
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:ralplan") },
					idempotencyKey: "plan",
				},
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:ultragoal") },
					idempotencyKey: "execute",
				},
				{
					operation: "turn.prompt",
					input: { text: expect.stringContaining("/skill:team") },
					idempotencyKey: "team",
				},
			]),
		);
	});

	it("returns immediately by default and exposes bounded delegation completion when requested", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const immediate = await server.callTool("gjc_delegate_plan", {
			cwd: root,
			task: "immediate",
			idempotency_key: "immediate",
			allow_mutation: true,
		});
		expect(immediate).toMatchObject({ ok: true, delivered: true, turn: { status: "active" } });
		expect(immediate.completion).toBeUndefined();
		const awaited = await server.callTool("gjc_delegate_execute", {
			cwd: root,
			task: "timeout",
			idempotency_key: "timeout",
			allow_mutation: true,
			await_completion: true,
			timeout_ms: 10,
			poll_interval_ms: 10,
			lines: 3,
		});
		expect(awaited).toMatchObject({
			ok: true,
			completion: { ok: false, reason: "timeout", turn: { status: "active" } },
		});
	});

	it("rejects missing caller idempotency keys without invoking the SDK", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "work",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(
			await server.callTool("gjc_coordinator_submit_question_answer", {
				session_id: "visible-session",
				question_id: "ask-1",
				answer: "yes",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(controls).toEqual([
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" },
		]);
	});

	it("returns SDK failures rather than falling back outside SDK control", async () => {
		const root = await tempRoot();
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
		});
		await registerSdkSession(server, root);
		expect(
			await server.callTool("gjc_coordinator_send_prompt", {
				session_id: "visible-session",
				prompt: "work",
				idempotency_key: "key-1",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: false, error: { code: "not_found" } });
	});

	it("keeps coordinator metadata reports and event journals available without turning them into control authority", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		await registerSdkSession(server, root);
		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session",
			status: "blocked",
			summary: "Awaiting SDK turn completion.",
			idempotency_key: "report-1",
			allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, report: { status: "blocked", session_id: "visible-session" } });
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as Array<{ kind: string }>).map(event => event.kind)).toEqual([
			"session.state_changed",
			"session.registered",
			"report.written",
		]);
		expect(controls).toEqual([
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" },
		]);
	});
	it("closes an idle ephemeral coordinator session through broker lifecycle without terminal ownership", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const sessionFile = path.join(
			root,
			".gjc",
			"coordinator-state",
			"local",
			"repo",
			"sessions",
			"visible-session.json",
		);
		await fs.mkdir(path.dirname(sessionFile), { recursive: true });
		await Bun.write(
			sessionFile,
			JSON.stringify({
				session_id: "visible-session",
				cwd: root,
				ephemeral: true,
				created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
			}),
		);

		expect(
			await server.callTool("gjc_coordinator_stop_session", {
				session_id: "visible-session",
				allow_mutation: true,
			}),
		).toMatchObject({ ok: true, closed: true, session_id: "visible-session" });
		expect(controls).toEqual([
			expect.objectContaining({
				operation: "session.close",
				input: { sessionId: "visible-session" },
				idempotencyKey: expect.any(String),
			}),
		]);
		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});

	it("idle reaping selects only stale ephemeral coordinator records and uses SDK session.close", async () => {
		const root = await tempRoot();
		const controls: SdkControl[] = [];
		const server = await createSdkControlServer(root, controls);
		const sessionsDir = path.join(root, ".gjc", "coordinator-state", "local", "repo", "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });
		await Bun.write(
			path.join(sessionsDir, "idle-session.json"),
			JSON.stringify({
				session_id: "idle-session",
				cwd: root,
				ephemeral: true,
				created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
			}),
		);
		await Bun.write(
			path.join(sessionsDir, "registered-session.json"),
			JSON.stringify({
				session_id: "registered-session",
				cwd: root,
				created_at: new Date(Date.now() - 31 * 60_000).toISOString(),
			}),
		);

		expect(await server.sessionReaper.sweepOnce()).toBe(1);
		expect(controls).toEqual([
			expect.objectContaining({
				operation: "session.close",
				input: { sessionId: "idle-session" },
				idempotencyKey: expect.any(String),
			}),
		]);
		expect(await Bun.file(path.join(sessionsDir, "idle-session.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(sessionsDir, "registered-session.json")).exists()).toBe(true);
	});
});
