import { describe, expect, it } from "bun:test";
import { type AppServerHost, type CreatedThread, startAppServer } from "../src/modes/app-server/host";

// Verifies the host-routing core against the real native AppServer using a fake
// host (no live provider needed): factory routing, backend-call routing, error
// propagation, and event emission.

class FakeHost implements AppServerHost {
	public calls: Array<{ threadId: string; method: string; params: unknown; generation?: number }> = [];
	private n = 0;
	private readonly openedByPath = new Map<string, string>();

	async createThread(): Promise<CreatedThread> {
		this.n += 1;
		return { threadId: `thr_fake_${this.n}`, sessionMetadata: { cwd: "/repo" } };
	}
	resumeThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	forkThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	async sessionOpen(params: unknown): Promise<CreatedThread> {
		const sessionPath = (params as { sessionPath?: string }).sessionPath ?? "";
		let threadId = this.openedByPath.get(sessionPath);
		if (!threadId) {
			this.n += 1;
			threadId = `thr_open_${this.n}`;
			this.openedByPath.set(sessionPath, threadId);
		}
		return { threadId, sessionMetadata: { sessionPath } };
	}
	async sessionDelete(params: unknown): Promise<unknown> {
		return { ok: true, deleted: (params as { sessionPath?: string }).sessionPath };
	}
	async backendCall(threadId: string, method: string, params: unknown, generation?: number): Promise<unknown> {
		this.calls.push({ threadId, method, params, generation });
		if (method === "prompt" || method === "steer") return { turnId: `turn_${this.calls.length}` };
		if (method === "getState") return { status: "idle" };
		if (method === "explode") throw new Error("host boom");
		return {};
	}
	async notificationCall(method: string, _params: unknown): Promise<unknown> {
		return method.endsWith("/subscribe") ? [] : { ok: true };
	}
	async providerList(): Promise<unknown> {
		return { providers: [{ id: "fake-oauth", name: "偽 Provider", authKind: "oauth", authenticated: true }] };
	}
	authStatus(): Promise<unknown> {
		return Promise.resolve({ providers: [{ providerId: "fake-oauth", state: "authenticated", method: "oauth" }] });
	}
	authLogout(params: unknown): Promise<unknown> {
		return Promise.resolve({
			providerId: (params as { providerId?: string }).providerId ?? "",
			authenticated: false,
		});
	}
}

async function init(handle: ReturnType<typeof startAppServer>): Promise<string> {
	const conn = handle.openConnection();
	await handle.dispatch(conn, JSON.stringify({ id: 0, method: "initialize", params: {} }));
	await handle.dispatch(conn, JSON.stringify({ method: "initialized" }));
	return conn;
}

describe("app-server host routing", () => {
	it("routes factory.create and backend calls to the host", async () => {
		const host = new FakeHost();
		const handle = startAppServer(host, { onFrame: () => {} });
		const conn = await init(handle);

		const start = await handle.dispatch(
			conn,
			JSON.stringify({ id: 1, method: "thread/start", params: { cwd: "/repo" } }),
		);
		const threadId = JSON.parse(start as string).result.thread.id as string;
		expect(threadId).toBe("thr_fake_1");

		const turn = await handle.dispatch(
			conn,
			JSON.stringify({ id: 2, method: "turn/start", params: { threadId, input: "hi" } }),
		);
		expect(JSON.parse(turn as string).result.turn.status).toBe("inProgress");
		// turn/start accepts and returns immediately; the prompt runs in the
		// background, so wait for the host to receive the prompt call.
		for (let i = 0; i < 100 && !host.calls.some(c => c.method === "prompt"); i += 1) {
			await new Promise(r => setTimeout(r, 5));
		}
		expect(host.calls.some(c => c.method === "prompt" && c.threadId === threadId)).toBe(true);
	});

	it("routes session open and delete through the native factory bridge", async () => {
		const host = new FakeHost();
		const handle = startAppServer(host, { onFrame: () => {} });
		const conn = await init(handle);
		const open = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({ id: 9, method: "gjc/session/open", params: { sessionPath: "/tmp/session.jsonl" } }),
			)) as string,
		);
		expect(open.error).toBeUndefined();
		expect(open.result.threadId).toBe("thr_open_1");
		expect(open.result.generation).toBe(1);
		expect(
			host.calls.some(call => call.threadId === "thr_open_1" && call.method === "getState" && call.generation === 1),
		).toBe(true);
		const del = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({ id: 10, method: "gjc/session/delete", params: { sessionPath: "/tmp/session.jsonl" } }),
			)) as string,
		);
		expect(del.error).toBeUndefined();
		expect(del.result.ok).toBe(true);
	});

	it("syncs duplicate session-open generation before accepting event-producing backend calls", async () => {
		const host = new FakeHost();
		const frames: Array<Record<string, unknown>> = [];
		const handle = startAppServer(host, { onFrame: frame => frames.push(JSON.parse(frame)) });
		const conn = await init(handle);
		const first = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({ id: 11, method: "gjc/session/open", params: { sessionPath: "/tmp/dupe.jsonl" } }),
			)) as string,
		);
		const second = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({ id: 12, method: "gjc/session/open", params: { sessionPath: "/tmp/dupe.jsonl" } }),
			)) as string,
		);
		expect(second.result.threadId).toBe(first.result.threadId);
		expect(second.result.generation).toBe(2);
		expect(
			host.calls.some(
				call => call.threadId === second.result.threadId && call.method === "getState" && call.generation === 2,
			),
		).toBe(true);

		handle.emitEvent(second.result.threadId, 2, "agent_start", {});
		await new Promise(r => setTimeout(r, 20));

		const started = frames.find(frame => frame.method === "turn/started");
		expect(started?.params).toMatchObject({ threadId: second.result.threadId });
	});

	it("propagates host errors as JSON-RPC errors", async () => {
		class ThrowingHost extends FakeHost {
			override async backendCall(threadId: string, method: string, params: unknown): Promise<unknown> {
				if (method === "getState") throw new Error("host boom");
				return super.backendCall(threadId, method, params);
			}
		}
		const handle = startAppServer(new ThrowingHost(), { onFrame: () => {} });
		const conn = await init(handle);
		const start = await handle.dispatch(conn, JSON.stringify({ id: 3, method: "thread/start", params: {} }));
		const threadId = JSON.parse(start as string).result.thread.id as string;
		const resp = await handle.dispatch(
			conn,
			JSON.stringify({ id: 4, method: "gjc/state/read", params: { threadId } }),
		);
		const err = JSON.parse(resp as string).error;
		expect(err).toBeDefined();
		expect(err.message).toContain("host boom");
	});

	it("routes provider auth methods without credential material", async () => {
		const handle = startAppServer(new FakeHost(), { onFrame: () => {} });
		const conn = await init(handle);
		const list = JSON.parse(
			(await handle.dispatch(conn, JSON.stringify({ id: 6, method: "gjc/provider/list", params: {} }))) as string,
		).result;
		expect(list.providers[0]).toEqual({
			id: "fake-oauth",
			name: "偽 Provider",
			authKind: "oauth",
			authenticated: true,
		});
		expect(JSON.stringify(list)).not.toContain("secret");
		const status = JSON.parse(
			(await handle.dispatch(conn, JSON.stringify({ id: 7, method: "gjc/auth/status", params: {} }))) as string,
		).result;
		expect(status.providers[0].method).toBe("oauth");
		const logout = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({ id: 8, method: "gjc/auth/logout", params: { providerId: "fake-oauth" } }),
			)) as string,
		).result;
		expect(logout).toEqual({ providerId: "fake-oauth", authenticated: false });
	});

	it("emits mapped frames from backend events", async () => {
		const host = new FakeHost();
		const frames: Array<Record<string, unknown>> = [];
		const handle = startAppServer(host, { onFrame: f => frames.push(JSON.parse(f)) });
		const conn = await init(handle);
		const start = await handle.dispatch(conn, JSON.stringify({ id: 5, method: "thread/start", params: {} }));
		const threadId = JSON.parse(start as string).result.thread.id as string;

		handle.emitEvent(threadId, 1, "agent_start", {});
		handle.emitEvent(threadId, 1, "agent_end", {});
		await new Promise(r => setTimeout(r, 50));

		const methods = frames.map(f => f.method);
		expect(methods).toContain("turn/started");
		expect(methods.filter(m => m === "turn/completed").length).toBe(1);
	});
});
