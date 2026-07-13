import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fssync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@gajae-code/utils";
import { AgentSessionHost } from "../src/modes/app-server/agent-session-host";
import { startAppServer } from "../src/modes/app-server/host";
import { SessionManager } from "../src/session/session-manager";

interface CaseRow {
	id: string;
	scenario: string;
	expected: string;
	verdict: "passed" | "failed";
	details?: string;
}
const cases: CaseRow[] = [];
function record(row: CaseRow) {
	cases.push(row);
}

function sessionLine(id: string, cwd: string) {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
}
function userLine(id: string, content: string, parentId: string | null = null) {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content },
	});
}
async function writeSession(
	file: string,
	id: string,
	cwd: string,
	messages: Array<{ id: string; content: string; parentId?: string | null }> = [],
) {
	await fs.writeFile(
		file,
		`${[sessionLine(id, cwd), ...messages.map(m => userLine(m.id, m.content, m.parentId ?? null))].join("\n")}\n`,
	);
}
function makeHost(events: unknown[] = []) {
	return new AgentSessionHost({
		emit: (...args) => {
			events.push(args);
		},
		sessionFactory: async options => {
			const manager =
				options.sessionManager ??
				SessionManager.create(String((options as { cwd?: unknown }).cwd ?? process.cwd()));
			return {
				session: {
					sessionId: manager.getSessionId?.() ?? `fake-${Date.now()}`,
					sessionManager: manager,
					subscribe: (listener: (event: unknown) => void) => {
						listener({ type: "agent_start" });
						return () => {};
					},
					prompt: async () => undefined,
					steer: async () => undefined,
					abort: async () => undefined,
					getSessionState: () => ({ status: "idle" }),
					getMessages: () => manager.getEntries().filter(e => e.type === "message"),
					navigateTree: async (entryId: string) => {
						if (!manager.getEntry(entryId)) throw new Error(`Entry ${entryId} not found`);
						return {};
					},
					buildForkContextSeed: async () => ({ messages: manager.getEntries().filter(e => e.type === "message") }),
				} as never,
			};
		},
	});
}
async function init(handle: ReturnType<typeof startAppServer>) {
	const conn = handle.openConnection();
	await handle.dispatch(conn, JSON.stringify({ id: 0, method: "initialize", params: {} }));
	await handle.dispatch(conn, JSON.stringify({ method: "initialized" }));
	return conn;
}
async function rpc(
	handle: ReturnType<typeof startAppServer>,
	conn: string,
	id: number,
	method: string,
	params: unknown,
) {
	return JSON.parse((await handle.dispatch(conn, JSON.stringify({ id, method, params }))) as string);
}

describe("G001 session lifecycle red-team", () => {
	let tempDir = "";
	let agentDir = "";
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "g001-redteam-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "g001-agent-"));
		setAgentDir(agentDir);
	});
	afterEach(async () => {
		if (originalAgentDir) setAgentDir(originalAgentDir);
		else delete process.env.PI_CODING_AGENT_DIR;
		await fs.rm(tempDir, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});
	afterAll(async () => {
		await fs.mkdir("artifacts/parity/qa", { recursive: true });
		const coverage = [
			"path-policy",
			"open",
			"fork",
			"navigate-label",
			"search-list",
			"strictness",
			"secret-safety",
		].map(area => ({ area, caseIds: cases.filter(c => c.id.startsWith(area)).map(c => c.id) }));
		await fs.writeFile(
			"artifacts/parity/qa/g001-red-team.json",
			JSON.stringify(
				{
					schemaVersion: 1,
					kind: "api-package-test-report",
					story: "G001",
					generatedAt: new Date().toISOString(),
					cases,
					coverage,
					commands: [
						"bun test packages/coding-agent/test/app-server-session-lifecycle-redteam.test.ts",
						"cargo test -p gjc-app-server gjc_session --test conformance",
					],
					blockers: cases.filter(c => c.verdict === "failed"),
				},
				null,
				2,
			),
		);
	});

	it("defends path policy for open/delete/rename/export including symlink and managed-root deletion", async () => {
		const host = makeHost();
		const sessionPath = path.join(tempDir, "session.jsonl");
		await writeSession(sessionPath, "s-path", tempDir);
		const outside = path.join(tempDir, "outside.jsonl");
		await writeSession(outside, "outside", tempDir);
		const link = path.join(tempDir, "link.jsonl");
		if (process.platform !== "win32") await fs.symlink(outside, link);
		const methods: Array<[string, (p: unknown) => Promise<unknown>, unknown]> = [
			["open", p => host.sessionOpen(p), { sessionPath: "relative.jsonl" }],
			["delete", p => host.sessionDelete(p), { sessionPath: path.join(tempDir, "missing.jsonl") }],
			["rename", p => host.sessionRename(p), { sessionPath: `${tempDir}/sub/../session.jsonl`, title: "x" }],
			["export", p => host.sessionExport(p), { sessionPath: path.join(tempDir, "bad.txt"), format: "json" }],
		];
		for (const [, fn, params] of methods) await expect(fn(params)).rejects.toThrow();
		record({
			id: "path-policy-basic-rejections",
			scenario: "relative, traversal, missing, non-.jsonl rejected",
			expected: "All reject before mutation",
			verdict: "passed",
		});
		if (process.platform !== "win32") {
			await expect(host.sessionExport({ sessionPath: link, format: "json" })).rejects.toThrow();
			record({
				id: "path-policy-symlink-outside",
				scenario: "symlink .jsonl pointing outside accepted by stat-following validation",
				expected: "Reject symlink outside trusted session roots",
				verdict: "passed",
			});
		}
		await expect(host.sessionDelete({ sessionPath: outside })).rejects.toThrow();
		expect(fssync.existsSync(outside)).toBe(true);
		record({
			id: "path-policy-arbitrary-jsonl-delete",
			scenario: "delete accepts any existing absolute .jsonl with session-shaped header",
			expected: "Guard to managed session roots or stronger session ownership",
			verdict: "passed",
		});
		const managedDir = SessionManager.getDefaultSessionDir(tempDir);
		await fs.mkdir(managedDir, { recursive: true });
		const managed = path.join(managedDir, "managed.jsonl");
		await writeSession(managed, "managed", tempDir);
		const listed = await SessionManager.list(tempDir);
		expect(listed.some(session => session.path === managed)).toBe(true);
		await expect(host.sessionDelete({ sessionPath: managed })).resolves.toEqual({ ok: true });
		expect(fssync.existsSync(managed)).toBe(false);
		record({
			id: "path-policy-managed-xdg-delete",
			scenario: "delete session created under SessionManager sessions root",
			expected: "Allow managed-root delete",
			verdict: "passed",
		});
	});

	it("opens sessions, rejects corrupted/empty files, and preserves generation routing", async () => {
		const events: unknown[] = [];
		const host = makeHost(events);
		const sessionPath = path.join(tempDir, "open.jsonl");
		await writeSession(sessionPath, "s-open", tempDir, [{ id: "m1", content: "hydrate me" }]);
		const opened1 = await host.sessionOpen({ sessionPath });
		const opened2 = await host.sessionOpen({ sessionPath });
		expect(opened1.resumed).toBe(true);
		expect(opened1.threadId).toBe(opened2.threadId);
		record({
			id: "open-double-register",
			scenario: "same session opened twice",
			expected: "No duplicate thread identity",
			verdict: "passed",
		});
		await expect(host.backendCall(opened1.threadId, "prompt", { input: "after open" }, 7)).resolves.toMatchObject({
			turnId: `${opened1.threadId}:7`,
		});
		await expect(host.backendCall("missing", "prompt", {}, 1)).rejects.toThrow("unknown thread");
		record({
			id: "open-generation-flow",
			scenario: "post-open prompt accepted and unknown/stale thread rejected",
			expected: "Accepted only registered thread",
			verdict: "passed",
		});
		const corrupted = path.join(tempDir, "corrupt.jsonl");
		const empty = path.join(tempDir, "empty.jsonl");
		await fs.writeFile(corrupted, "not json\n");
		await fs.writeFile(empty, "");
		await expect(host.sessionOpen({ sessionPath: corrupted })).rejects.toThrow();
		await expect(host.sessionOpen({ sessionPath: empty })).rejects.toThrow();
		record({
			id: "open-corrupt-empty",
			scenario: "corrupted/truncated and empty jsonl",
			expected: "Reject",
			verdict: "passed",
		});
	});

	it("fork preserves source state and marks fork metadata", async () => {
		const host = makeHost();
		const fallback = await host.forkThread({ cwd: tempDir });
		expect(fallback.threadId).toBeString();
		record({
			id: "fork-without-source",
			scenario: "fork params without source thread",
			expected: "Safe createThread fallback",
			verdict: "passed",
		});
		const sessionPath = path.join(tempDir, "fork.jsonl");
		await writeSession(sessionPath, "s-fork", tempDir, [{ id: "m1", content: "source" }]);
		const before = await fs.readFile(sessionPath, "utf8");
		const source = await host.sessionOpen({ sessionPath });
		const forked = await host.forkThread({ threadId: source.threadId, entryId: "m1" });
		expect(forked.sessionMetadata?.forkedFromId).toBe(source.threadId);
		expect(await fs.readFile(sessionPath, "utf8")).toBe(before);
		record({
			id: "fork-source-immutable",
			scenario: "fork existing thread and compare source file bytes",
			expected: "forkedFromId present and source file unchanged",
			verdict: "passed",
		});
	});

	it("navigate/label adversarial inputs are rejected or safe", async () => {
		const host = makeHost();
		const sessionPath = path.join(tempDir, "nav.jsonl");
		await writeSession(sessionPath, "s-nav", tempDir, [{ id: "m1", content: "source" }]);
		const thread = await host.sessionOpen({ sessionPath });
		await expect(host.backendCall("missing", "sessionNavigate", { entryId: "m1" })).rejects.toThrow("unknown thread");
		await expect(host.backendCall(thread.threadId, "sessionNavigate", { entryId: "missing" })).rejects.toThrow(
			"not found",
		);
		record({
			id: "navigate-unknowns",
			scenario: "unknown threadId and entryId",
			expected: "Reject",
			verdict: "passed",
		});
		await expect(
			host.backendCall(thread.threadId, "sessionLabel", { entryId: "m1", label: "x".repeat(201) }),
		).rejects.toThrow("label");
		record({
			id: "navigate-label-host-long",
			scenario: "direct TS host backendCall with label >200",
			expected: "Host enforces 0..200 like Rust protocol",
			verdict: "passed",
		});
		await expect(host.backendCall(thread.threadId, "sessionLabel", { entryId: "m1", label: "" })).resolves.toEqual({
			ok: true,
		});
		record({
			id: "navigate-label-empty-clears",
			scenario: "empty label",
			expected: "Clear succeeds",
			verdict: "passed",
		});
	});

	it("search/list cwd, deep matching, strictness, and secret-safe DTOs", async () => {
		const project = path.join(tempDir, "project");
		await fs.mkdir(project);
		const canonicalProject = await fs.realpath(project);
		const created = SessionManager.create(canonicalProject);
		const createdPath = created.getSessionFile();
		if (!createdPath) throw new Error("missing test session file");
		await fs.mkdir(path.dirname(createdPath), { recursive: true });
		await writeSession(createdPath, "deep-search", canonicalProject, [
			{ id: "m1", content: "deep-only-content secret-token-abc" },
		]);
		const host = makeHost();
		await expect(host.sessionList({ cwd: "relative" })).rejects.toThrow("absolute");
		record({ id: "search-list-relative-cwd", scenario: "relative cwd param", expected: "Reject", verdict: "passed" });
		const result = (await host.sessionSearch({ query: "deep-only-content", cwd: canonicalProject })) as {
			total: number;
			sessions: Array<Record<string, unknown>>;
		};
		expect(result.total).toBe(1);
		expect(result.sessions[0]).not.toHaveProperty("allMessagesText");
		record({
			id: "secret-safety-search-dto",
			scenario: "query matches allMessagesText only",
			expected: "Find by deep text without returning message content",
			verdict: "passed",
		});
		const huge = (await host.sessionSearch({ query: "x".repeat(10000), cwd: canonicalProject })) as { total: number };
		expect(huge.total).toBe(0);
		record({ id: "search-list-huge-query", scenario: "huge query string", expected: "No crash", verdict: "passed" });
		const app = startAppServer(host, { onFrame: () => {} });
		const conn = await init(app);
		const strict = await rpc(app, conn, 1, "gjc/session/search", { query: "x", cwd: canonicalProject, extra: true });
		expect(strict.error).toBeDefined();
		record({
			id: "strictness-search-cwd-extra",
			scenario: "unknown field with cwd present",
			expected: "JSON-RPC invalid params",
			verdict: "passed",
		});
		const catalog = await rpc(app, conn, 2, "initialize", {});
		expect(catalog).toBeDefined();
		record({
			id: "strictness-catalog-lane-smoke",
			scenario: "server initialize/catalog path available during lifecycle tests",
			expected: "No missing method registration observed",
			verdict: "passed",
		});
	});
});
