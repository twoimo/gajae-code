import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	boundedAwaitTurnTimeoutMs,
	boundedEventWatchTimeoutMs,
	boundedPollIntervalMs,
	COORDINATOR_AWAIT_TURN_TIMEOUT_MAX_MS,
	COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS,
	COORDINATOR_MCP_TOOL_NAMES,
	COORDINATOR_POLL_INTERVAL_MAX_MS,
	createCoordinatorMcpServer,
} from "../src/coordinator-mcp/server";
import type { SdkClient } from "../src/sdk/client/client";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coordinator-mcp-"));
	tempDirs.push(root);
	return root;
}

type Control = { operation: string; input: Record<string, unknown>; idempotencyKey?: string };

async function sdkServer(root: string, controls: Control[], commands: string[][] = []) {
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
			commandRunner: async command => {
				commands.push(command);
				if (command[1] === "has-session" || command[1] === "display-message")
					return { exitCode: 0, stdout: "%1\n", stderr: "" };
				if (command[1] === "capture-pane") return { exitCode: 0, stdout: "running\n", stderr: "" };
				return { exitCode: 1, stdout: "", stderr: "unexpected tmux command" };
			},
			connectSdk: async () =>
				({
					control: async (operation: string, input: Record<string, unknown>, options: { idempotencyKey?: string }) => {
						controls.push({ operation, input, idempotencyKey: options.idempotencyKey });
						return { accepted: true, turn_id: `sdk-${controls.length}` };
					},
					global: async (operation: string, input: Record<string, unknown>, options: { idempotencyKey?: string } = {}) => {
						controls.push({ operation, input, idempotencyKey: options.idempotencyKey });
						if (operation === "session.list") return { ok: true, result: { sessions: [{ sessionId: "visible-session", locator: { repo: root } }] } };
						if (operation === "session.create") {
							const sessionId = `created-session-${++createdSessions}`;
							await Bun.write(path.join(root, ".gjc", "state", "sdk", `${sessionId}.json`), JSON.stringify({ url: "ws://sdk.example.test", token: "test-token" }));
							return { ok: true, result: { sessionId } };
						}
						return { ok: true, result: { sessionId: String(input.sessionId ?? "visible-session") } };
					},
					close: async () => {},
				}) as unknown as SdkClient,
		},
	});
	await fs.mkdir(path.join(root, ".gjc", "state", "sdk"), { recursive: true });
	await fs.mkdir(path.join(root, ".gjc", "agent", "sdk"), { recursive: true });
	await Bun.write(
		path.join(root, ".gjc", "agent", "sdk", "broker.json"),
		JSON.stringify({ version: 1, protocolVersion: 3, packageGeneration: "test", ownerId: "test", pid: process.pid, host: "127.0.0.1", port: 1, url: "ws://sdk.example.test", token: "test-token", startedAt: Date.now(), heartbeatAt: Date.now() }),
	);
	await Bun.write(
		path.join(root, ".gjc", "state", "sdk", "visible-session.json"),
		JSON.stringify({ url: "ws://sdk.example.test", token: "test-token" }),
	);
	return server;
}

async function registerVisibleSession(server: ReturnType<typeof createCoordinatorMcpServer>, root: string) {
	return await server.callTool("gjc_coordinator_register_session", {
		session_id: "visible-session",
		cwd: root,
		tmux_session: "visible-session",
		tmux_target: "visible-session:0.0",
		idempotency_key: "register-1",
		allow_mutation: true,
	});
}

describe("Coordinator MCP server protocol", () => {
	it("advertises the canonical tools and bounded timing helpers", async () => {
		const root = await tempRoot();
		const server = createCoordinatorMcpServer({ env: { GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root } });
		const initialized = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
		expect(initialized.result.capabilities).toEqual({ tools: {}, prompts: {}, resources: {} });
		const listed = await server.handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...COORDINATOR_MCP_TOOL_NAMES]);
		for (const name of [
			"gjc_coordinator_register_session",
			"gjc_coordinator_start_session",
			"gjc_coordinator_send_prompt",
			"gjc_coordinator_submit_question_answer",
			"gjc_coordinator_report_status",
		] as const) {
			const tool = listed.result.tools.find((candidate: { name: string }) => candidate.name === name);
			expect(tool.inputSchema.required).toContain("idempotency_key");
		}
		const registerTool = listed.result.tools.find((candidate: { name: string }) => candidate.name === "gjc_coordinator_register_session");
		expect(registerTool.inputSchema.required).not.toContain("tmux_session");
		expect(registerTool.inputSchema.required).not.toContain("tmux_target");
		expect(boundedAwaitTurnTimeoutMs(99_999_999)).toBe(COORDINATOR_AWAIT_TURN_TIMEOUT_MAX_MS);
		expect(boundedEventWatchTimeoutMs(99_999_999)).toBe(COORDINATOR_EVENT_WATCH_TIMEOUT_MAX_MS);
		expect(boundedPollIntervalMs(99_999_999)).toBe(COORDINATOR_POLL_INTERVAL_MAX_MS);
	});

	it("uses SDK discovery for registered-session authority and leaves tmux as advisory metadata", async () => {
		const root = await tempRoot();
		const controls: Control[] = [];
		const commands: string[][] = [];
		const server = await sdkServer(root, controls, commands);
		const registered = await registerVisibleSession(server, root);
		expect(registered).toMatchObject({ ok: true, registered: true, session_state: { state: "ready_for_input" } });
		const status = await server.callTool("gjc_coordinator_read_status", { session_id: "visible-session" });
		expect(status).toMatchObject({ ok: true, status: { live: true } });
		expect(commands.every(command => !["set-buffer", "paste-buffer", "send-keys", "delete-buffer"].includes(command[1] ?? ""))).toBe(true);
		expect(controls).toEqual([
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" },
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: undefined },
		]);
	});
});

describe("Coordinator MCP canonical SDK controls", () => {
	it("routes prompts, follow-ups, abort-and-prompts, and answers through SDK controls with caller keys", async () => {
		const root = await tempRoot();
		const controls: Control[] = [];
		const commands: string[][] = [];
		const server = await sdkServer(root, controls, commands);
		await registerVisibleSession(server, root);

		const first = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session", prompt: "first", idempotency_key: "prompt-1", allow_mutation: true,
		});
		expect(first).toMatchObject({ ok: true, operation: "turn.prompt", turn: { status: "active", delivery: { prompt_acknowledged: true } } });
		expect(first).toMatchObject({
			active_turn_id: first.turn_id,
			status: "active",
			queued: false,
			delivered: true,
		});
		const firstTurn = first.turn as { turn_id: string; status: string; delivery: { queued: boolean; delivered: boolean } };
		expect({
			active_turn_id: first.active_turn_id,
			status: first.status,
			queued: first.queued,
			delivered: first.delivered,
		}).toEqual({
			active_turn_id: firstTurn.turn_id,
			status: firstTurn.status,
			queued: firstTurn.delivery.queued,
			delivered: firstTurn.delivery.delivered,
		});
		expect(typeof first.turn_id).toBe("string");
		expect(await server.callTool("gjc_coordinator_read_turn", { turn_id: first.turn_id, session_id: "visible-session" })).toMatchObject({
			ok: true, turn: { turn_id: first.turn_id, status: "active" }, session_state: { current_turn_id: first.turn_id, state: "running" },
		});
		expect(await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session", prompt: "must not steer", idempotency_key: "prompt-default", allow_mutation: true,
		})).toMatchObject({ ok: false, error: { code: "active_turn_exists" }, turn_id: first.turn_id });
		const queued = await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session", prompt: "follow up", queue: true, idempotency_key: "prompt-2", allow_mutation: true,
		});
		expect(queued).toMatchObject({ ok: true, operation: "turn.follow_up", turn: { status: "queued", delivery: { queued: true } } });
		expect(queued).toMatchObject({
			active_turn_id: first.turn_id,
			status: "queued",
			queued: true,
			delivered: true,
		});
		const queuedTurn = queued.turn as { status: string; delivery: { queued: boolean; delivered: boolean } };
		expect({
			active_turn_id: queued.active_turn_id,
			status: queued.status,
			queued: queued.queued,
			delivered: queued.delivered,
		}).toEqual({
			active_turn_id: first.turn_id,
			status: queuedTurn.status,
			queued: queuedTurn.delivery.queued,
			delivered: queuedTurn.delivery.delivered,
		});
		expect(await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session", prompt: "replace", force: true, idempotency_key: "prompt-3", allow_mutation: true,
		})).toMatchObject({ ok: true, operation: "turn.abort_and_prompt", turn: { status: "active" } });
		expect(await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session", question_id: "ask-1", answer: { choice: "yes" }, idempotency_key: "answer-1", allow_mutation: true,
		})).toMatchObject({ ok: true, operation: "ask.answer", result: { accepted: true } });

		expect(controls).toEqual([
			{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" },
			{ operation: "turn.prompt", input: { text: "first" }, idempotencyKey: "prompt-1" },
			{ operation: "turn.follow_up", input: { text: "follow up" }, idempotencyKey: "prompt-2" },
			{ operation: "turn.abort_and_prompt", input: { text: "replace" }, idempotencyKey: "prompt-3" },
			{ operation: "ask.answer", input: { id: "ask-1", answer: { choice: "yes" } }, idempotencyKey: "answer-1" },
		]);
		expect(commands.some(command => ["set-buffer", "paste-buffer", "send-keys", "delete-buffer"].includes(command[1] ?? ""))).toBe(false);
	});

	it("delivers every delegation workflow through broker lifecycle and SDK control", async () => {
		const root = await tempRoot();
		const controls: Control[] = [];
		const server = await sdkServer(root, controls);
		for (const [tool, key] of [["gjc_delegate_plan", "plan"], ["gjc_delegate_execute", "execute"], ["gjc_delegate_team", "team"]] as const) {
			const result = await server.callTool(tool, { cwd: root, task: `${key} task`, idempotency_key: key, allow_mutation: true });
			expect(result).toMatchObject({ ok: true, delivered: true, workflow: key === "plan" ? "plan" : key === "execute" ? "execute" : "team" });
		}
		expect(controls).toEqual([
			{ operation: "session.create", input: { cwd: root, target: { path: root } }, idempotencyKey: "plan" },
			{ operation: "turn.prompt", input: { text: expect.stringContaining("/skill:ralplan") }, idempotencyKey: "plan" },
			{ operation: "session.create", input: { cwd: root, target: { path: root } }, idempotencyKey: "execute" },
			{ operation: "turn.prompt", input: { text: expect.stringContaining("/skill:ultragoal") }, idempotencyKey: "execute" },
			{ operation: "session.create", input: { cwd: root, target: { path: root } }, idempotencyKey: "team" },
			{ operation: "turn.prompt", input: { text: expect.stringContaining("/skill:team") }, idempotencyKey: "team" },
		]);
	});

	it("returns immediately by default and exposes bounded delegation completion when requested", async () => {
		const root = await tempRoot();
		const controls: Control[] = [];
		const server = await sdkServer(root, controls);
		const immediate = await server.callTool("gjc_delegate_plan", {
			cwd: root, task: "immediate", idempotency_key: "immediate", allow_mutation: true,
		});
		expect(immediate).toMatchObject({ ok: true, delivered: true, turn: { status: "active" } });
		expect(immediate.completion).toBeUndefined();
		const awaited = await server.callTool("gjc_delegate_execute", {
			cwd: root, task: "timeout", idempotency_key: "timeout", allow_mutation: true,
			await_completion: true, timeout_ms: 10, poll_interval_ms: 10, lines: 3,
		});
		expect(awaited).toMatchObject({ ok: true, completion: { ok: false, reason: "timeout", turn: { status: "active" } } });
	});

	it("rejects missing caller idempotency keys without invoking the SDK", async () => {
		const root = await tempRoot();
		const controls: Control[] = [];
		const server = await sdkServer(root, controls);
		await registerVisibleSession(server, root);
		expect(await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session", prompt: "work", allow_mutation: true,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await server.callTool("gjc_coordinator_submit_question_answer", {
			session_id: "visible-session", question_id: "ask-1", answer: "yes", allow_mutation: true,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(controls).toEqual([{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" }]);
	});

	it("returns SDK failures rather than falling back to local or tmux control", async () => {
		const root = await tempRoot();
		const commands: string[][] = [];
		const server = createCoordinatorMcpServer({
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
				GJC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".gjc", "coordinator-state"),
				GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
				GJC_COORDINATOR_MCP_PROFILE: "local",
				GJC_COORDINATOR_MCP_REPO: "repo",
			},
			services: { commandRunner: async command => { commands.push(command); return { exitCode: 0, stdout: "", stderr: "" }; } },
		});
		await registerVisibleSession(server, root);
		expect(await server.callTool("gjc_coordinator_send_prompt", {
			session_id: "visible-session", prompt: "work", idempotency_key: "key-1", allow_mutation: true,
		})).toMatchObject({ ok: false, error: { code: "not_found" } });
		expect(commands.some(command => ["set-buffer", "paste-buffer", "send-keys", "delete-buffer"].includes(command[1] ?? ""))).toBe(false);
	});
});

describe("Coordinator MCP reports and events", () => {
	it("keeps coordinator metadata reports and event journals available without turning them into control authority", async () => {
		const root = await tempRoot();
		const controls: Control[] = [];
		const server = await sdkServer(root, controls);
		await registerVisibleSession(server, root);
		const report = await server.callTool("gjc_coordinator_report_status", {
			session_id: "visible-session", status: "blocked", summary: "Awaiting SDK turn completion.", idempotency_key: "report-1", allow_mutation: true,
		});
		expect(report).toMatchObject({ ok: true, report: { status: "blocked", session_id: "visible-session" } });
		const events = await server.callTool("gjc_coordinator_watch_events", { after_seq: 0 });
		expect((events.events as Array<{ kind: string }>).map(event => event.kind)).toEqual([
			"session.state_changed", "session.registered", "report.written",
		]);
		expect(controls).toEqual([{ operation: "session.get_endpoint", input: { sessionId: "visible-session" }, idempotencyKey: "register-1" }]);
	});
});
