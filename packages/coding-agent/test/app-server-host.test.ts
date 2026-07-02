import { describe, expect, it } from "bun:test";
import { type AppServerHost, type CreatedThread, startAppServer } from "../src/modes/app-server/host";

// Verifies the host-routing core against the real native AppServer using a fake
// host (no live provider needed): factory routing, backend-call routing, error
// propagation, and event emission.

class FakeHost implements AppServerHost {
	public calls: Array<{ threadId: string; method: string; params: unknown }> = [];
	private n = 0;

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
	async backendCall(threadId: string, method: string, params: unknown): Promise<unknown> {
		this.calls.push({ threadId, method, params });
		if (method === "prompt" || method === "steer") return { turnId: `turn_${this.calls.length}` };
		if (method === "getState") return { status: "idle" };
		if (method === "explode") throw new Error("host boom");
		return {};
	}
	async notificationCall(method: string, _params: unknown): Promise<unknown> {
		return method.endsWith("/subscribe") ? [] : { ok: true };
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
