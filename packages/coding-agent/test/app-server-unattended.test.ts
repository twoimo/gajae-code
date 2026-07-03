import { describe, expect, it } from "bun:test";
import { type AppServerHost, type CreatedThread, startAppServer } from "../src/modes/app-server/host";

class FakeHost implements AppServerHost {
	calls: Array<{ threadId: string; method: string; params: unknown }> = [];
	abortCount = 0;
	stats = { tokens: 0, cost_usd: 0 };
	constructor(readonly threadId = "thr_unattended") {}
	async createThread(): Promise<CreatedThread> {
		return { threadId: this.threadId, sessionMetadata: { cwd: "/repo" } };
	}
	resumeThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	forkThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	async backendCall(threadId: string, method: string, params: unknown): Promise<unknown> {
		this.calls.push({ threadId, method, params });
		if (method === "prompt" || method === "steer") return { turnId: `turn_${this.calls.length}` };
		if (method === "abort") {
			this.abortCount += 1;
			return { ok: true };
		}
		if (method === "usageSnapshot") return this.stats;
		if (method === "exec") return { ok: true };
		return {};
	}
	async notificationCall(): Promise<unknown> {
		return [];
	}
}

async function init(handle: ReturnType<typeof startAppServer>): Promise<string> {
	const conn = handle.openConnection();
	await handle.dispatch(conn, JSON.stringify({ id: 0, method: "initialize", params: {} }));
	await handle.dispatch(conn, JSON.stringify({ method: "initialized" }));
	return conn;
}

async function request(
	handle: ReturnType<typeof startAppServer>,
	conn: string,
	id: number,
	method: string,
	params: unknown,
) {
	const raw = await handle.dispatch(conn, JSON.stringify({ id, method, params }));
	expect(raw).toBeString();
	return JSON.parse(raw as string);
}

const fullDeclaration = {
	actor: "lane-b-executor",
	budget: { max_tokens: 1000, max_tool_calls: 3, max_wall_time_ms: 60_000, max_cost_usd: 1 },
	scopes: ["command.prompt", "command.bash", "command.host_tools", "command.control"],
	action_allowlist: ["command.prompt", "command.bash", "bash.readonly", "command.host_tools", "command.control"],
};

describe("app-server unattended wire", () => {
	it("negotiates complete declarations and rejects malformed declarations with typed data", async () => {
		const host = new FakeHost();
		const handle = startAppServer(host, { onFrame: () => {} });
		const conn = await init(handle);
		const start = await request(handle, conn, 1, "thread/start", {});
		const threadId = start.result.thread.id as string;

		const accepted = await request(handle, conn, 2, "gjc/unattended/negotiate", {
			threadId,
			declaration: fullDeclaration,
		});
		expect(accepted.error).toBeUndefined();
		expect(accepted.result.run_id).toMatch(/^unattended_/);
		expect(accepted.result.actor).toBe(fullDeclaration.actor);
		expect(accepted.result.budget).toEqual(fullDeclaration.budget);
		expect(accepted.result.scopes).toEqual([...fullDeclaration.scopes].sort());
		expect(accepted.result.action_allowlist).toEqual([...fullDeclaration.action_allowlist].sort());
		expect(accepted.result.accepted_at).toBeString();

		const missingBudget = await request(handle, conn, 3, "gjc/unattended/negotiate", {
			threadId,
			declaration: { ...fullDeclaration, budget: { ...fullDeclaration.budget, max_cost_usd: 0 } },
		});
		expect(missingBudget.error.data.code).toBe("incomplete_budget");

		const unknownScope = await request(handle, conn, 4, "gjc/unattended/negotiate", {
			threadId,
			declaration: { ...fullDeclaration, scopes: ["command.prompt", "nope"] },
		});
		expect(unknownScope.error.data.code).toBe("invalid_unattended_declaration");
		expect(unknownScope.error.data.message).toContain("unknown scope");

		const unknownAction = await request(handle, conn, 5, "gjc/unattended/negotiate", {
			threadId,
			declaration: { ...fullDeclaration, action_allowlist: ["command.prompt", "nope"] },
		});
		expect(unknownAction.error.data.code).toBe("invalid_unattended_declaration");
		expect(unknownAction.error.data.message).toContain("unknown action");

		const malformed = await request(handle, conn, 6, "gjc/unattended/negotiate", {
			threadId,
			declaration: { actor: "x" },
		});
		expect(malformed.error.data.code).toBe("incomplete_budget");

		const unsupportedMetric = await request(handle, conn, 7, "gjc/unattended/negotiate", {
			threadId,
			declaration: {
				...fullDeclaration,
				budget: { ...fullDeclaration.budget, max_requests: 1 },
			},
		});
		expect(unsupportedMetric.error.data.code).toBe("unsupported_budget_metric");
	});

	it("preflights denied methods before backend calls or Rust-local registry mutation", async () => {
		const host = new FakeHost("thr_preflight");
		const handle = startAppServer(host, { onFrame: () => {} });
		const conn = await init(handle);
		const start = await request(handle, conn, 1, "thread/start", {});
		const threadId = start.result.thread.id as string;
		host.calls.length = 0;

		await request(handle, conn, 2, "gjc/unattended/negotiate", {
			threadId,
			declaration: {
				...fullDeclaration,
				scopes: ["command.prompt"],
				action_allowlist: ["command.prompt"],
			},
		});

		const deniedHostTools = await request(handle, conn, 3, "gjc/hostTools/set", {
			threadId,
			hostTools: [{ name: "host_echo", inputSchema: {} }],
		});
		expect(deniedHostTools.error.data).toMatchObject({
			code: "scope_denied",
			scope: "command.host_tools",
			pre_side_effect: true,
		});
		expect(host.calls).toEqual([]);
		expect(handle.server.hostToolNames(threadId)).toEqual([]);

		const deniedBash = await request(handle, conn, 4, "command/exec", { threadId, command: "rm -rf /tmp/nope" });
		expect(deniedBash.error.data).toMatchObject({
			code: "scope_denied",
			scope: "command.bash",
			pre_side_effect: true,
		});
		expect(host.calls).toEqual([]);
	});

	it("classifies bash actions, enforces budgets, aborts once, and records audit", async () => {
		const host = new FakeHost("thr_budget");
		const handle = startAppServer(host, { onFrame: () => {} });
		const conn = await init(handle);
		const start = await request(handle, conn, 1, "thread/start", {});
		const threadId = start.result.thread.id as string;

		await request(handle, conn, 2, "gjc/unattended/negotiate", {
			threadId,
			declaration: { ...fullDeclaration, budget: { ...fullDeclaration.budget, max_tool_calls: 1 } },
		});
		const destructive = await request(handle, conn, 3, "command/exec", { threadId, command: "rm -rf ./dist" });
		expect(destructive.error.data).toMatchObject({
			code: "action_denied",
			action: "bash.destructive",
			pre_side_effect: true,
		});
		expect(host.calls.filter(c => c.method === "exec")).toHaveLength(0);

		const readonly = await request(handle, conn, 4, "command/exec", { threadId, command: "git status" });
		expect(readonly.error).toBeUndefined();
		expect(host.calls.filter(c => c.method === "exec")).toHaveLength(1);

		const overBudget = await request(handle, conn, 5, "command/exec", { threadId, command: "git status" });
		expect(overBudget.error.data).toMatchObject({
			code: "budget_exceeded",
			metric: "tool_calls",
			phase: "reserve",
			abort_status: "aborting",
		});
		expect(host.calls.filter(c => c.method === "exec")).toHaveLength(1);

		const audit = await request(handle, conn, 6, "gjc/unattended/audit", { threadId });
		const events = audit.result.events.map((event: { event: string }) => event.event);
		expect(events).toContain("unattended_negotiated");
		expect(events).toContain("action_denied");
		expect(events).toContain("budget_exceeded");
		expect(events).toContain("abort_settled");

		const schema = JSON.parse(handle.server.schemaJson());
		expect(schema.definitions.RpcUnattendedAccepted).toBeDefined();
		expect(schema.definitions.RpcBudgetExceeded).toBeDefined();
		expect(schema.definitions.RpcScopeDenied).toBeDefined();
		expect(schema.definitions.RpcActionDenied).toBeDefined();
	});

	it("leaves attended sessions unaffected until negotiation", async () => {
		const host = new FakeHost("thr_attended");
		const handle = startAppServer(host, { onFrame: () => {} });
		const conn = await init(handle);
		const start = await request(handle, conn, 1, "thread/start", {});
		const threadId = start.result.thread.id as string;
		const exec = await request(handle, conn, 2, "command/exec", { threadId, command: "rm -rf ./dist" });
		expect(exec.error).toBeUndefined();
		expect(host.calls.some(c => c.method === "exec")).toBe(true);
	});
});
