import { describe, expect, it } from "bun:test";
import { AppServer } from "../native/index.js";

// End-to-end test of the N-API app-server bridge: a fake TS host implements the
// backend/factory via the `onCall` callback and resolves each call through
// `resolveCall`, exactly as the real app-server-mode will. Proves the JSON-RPC
// transport, handshake, backend round-trip, and event streaming across the
// native boundary.

type Frame = Record<string, unknown>;

function makeServer(): { server: AppServer; frames: Frame[] } {
	const frames: Frame[] = [];
	// Forward-declare so onCall can call resolveCall on the constructed server.
	let server!: AppServer;
	const onFrame = (_err: unknown, frame: string) => {
		frames.push(JSON.parse(frame) as Frame);
	};
	const onCall = (_err: unknown, call: string) => {
		const { callId, kind, params } = JSON.parse(call) as {
			callId: string;
			kind: string;
			threadId: string | null;
			params: Record<string, unknown>;
		};
		if (kind.startsWith("factory.")) {
			server.resolveCall(callId, true, JSON.stringify({ threadId: `thr_host_${callId}`, sessionMetadata: {} }));
			return;
		}
		if (kind === "backend.prompt" || kind === "backend.steer") {
			server.resolveCall(callId, true, JSON.stringify({ turnId: `turn_${callId}` }));
			return;
		}
		if (kind === "backend.getState") {
			server.resolveCall(callId, true, JSON.stringify({ status: "idle", input: params }));
			return;
		}
		// Default: acknowledge with an empty object.
		server.resolveCall(callId, true, "{}");
	};
	server = new AppServer(onFrame, onCall);
	return { server, frames };
}

async function initialize(server: AppServer): Promise<string> {
	const conn = server.openConnection();
	const resp = await server.dispatch(conn, JSON.stringify({ id: 0, method: "initialize", params: {} }));
	expect(resp).not.toBeNull();
	expect(JSON.parse(resp as string).result.userAgent).toContain("gjc-app-server/");
	const ack = await server.dispatch(conn, JSON.stringify({ method: "initialized" }));
	expect(ack).toBeNull();
	return conn;
}

async function waitForFrame(frames: Frame[], method: string): Promise<Frame> {
	for (let i = 0; i < 50; i += 1) {
		const frame = frames.find(f => f.method === method);
		if (frame) return frame;
		await new Promise(r => setTimeout(r, 10));
	}
	throw new Error(`timed out waiting for ${method}`);
}

async function waitForCall(
	calls: Array<{ kind: string; threadId: string | null; generation?: number }>,
	kind: string,
	threadId: string,
): Promise<{ kind: string; threadId: string | null; generation?: number }> {
	for (let i = 0; i < 50; i += 1) {
		const call = calls.findLast(c => c.kind === kind && c.threadId === threadId);
		if (call) return call;
		await new Promise(r => setTimeout(r, 10));
	}
	throw new Error(`timed out waiting for ${kind}`);
}

describe("app-server N-API bridge", () => {
	it("completes the initialize handshake and rejects pre-init requests", async () => {
		const { server } = makeServer();
		const conn = server.openConnection();
		const early = await server.dispatch(conn, JSON.stringify({ id: 1, method: "thread/start" }));
		expect(JSON.parse(early as string).error.code).toBe(-32002); // NOT_INITIALIZED
		await initialize(server);
	});

	it("starts a thread via the host factory round-trip", async () => {
		const { server } = makeServer();
		const conn = await initialize(server);
		const resp = await server.dispatch(
			conn,
			JSON.stringify({ id: 2, method: "thread/start", params: { cwd: "/repo" } }),
		);
		const thread = JSON.parse(resp as string).result.thread;
		expect(typeof thread.id).toBe("string");
		expect(thread.id.startsWith("thr_host_")).toBe(true);
	});

	it("runs a turn and streams mapped frames from backend events", async () => {
		const { server, frames } = makeServer();
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 3, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;

		const turnResp = await server.dispatch(
			conn,
			JSON.stringify({ id: 4, method: "turn/start", params: { threadId, input: "hi" } }),
		);
		expect(JSON.parse(turnResp as string).result.turn.status).toBe("inProgress");

		// Simulate the AgentSession streaming a turn.
		server.emitBackendEvent(threadId, 1, "agent_start", "{}");
		server.emitBackendEvent(threadId, 1, "message_start", "{}");
		server.emitBackendEvent(
			threadId,
			1,
			"message_update",
			JSON.stringify({ assistantMessageEvent: { delta: "hello" } }),
		);
		server.emitBackendEvent(threadId, 1, "agent_end", "{}");

		// onFrame is a NonBlocking TSFN; let the event loop drain the frames.
		await new Promise(r => setTimeout(r, 50));

		const methods = frames.map(f => f.method);
		expect(methods).toContain("turn/started");
		expect(methods).toContain("item/agentMessage/delta");
		expect(methods.filter(m => m === "turn/completed").length).toBe(1);
	});

	it("rejects stale-generation backend events", async () => {
		const { server, frames } = makeServer();
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 5, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;
		const before = frames.length;
		const emitted = server.emitBackendEvent(threadId, 99, "agent_start", "{}");
		expect(emitted).toBe(0);
		expect(frames.length).toBe(before);
	});

	it("propagates resumed generation through backend calls and accepts only current events", async () => {
		const frames: Frame[] = [];
		const calls: Array<{ kind: string; threadId: string | null; generation?: number }> = [];
		let server!: AppServer;
		const onFrame = (_err: unknown, frame: string) => frames.push(JSON.parse(frame) as Frame);
		const onCall = (_err: unknown, call: string) => {
			const parsed = JSON.parse(call) as {
				callId: string;
				kind: string;
				threadId: string | null;
				generation?: number;
			};
			calls.push({ kind: parsed.kind, threadId: parsed.threadId, generation: parsed.generation });
			if (parsed.kind.startsWith("factory.")) {
				server.resolveCall(
					parsed.callId,
					true,
					JSON.stringify({ threadId: `thr_host_${parsed.callId}`, sessionMetadata: {} }),
				);
				return;
			}
			if (parsed.kind === "backend.prompt") {
				server.resolveCall(parsed.callId, true, JSON.stringify({ turnId: `turn_${parsed.callId}` }));
				return;
			}
			server.resolveCall(parsed.callId, true, "{}");
		};
		server = new AppServer(onFrame, onCall);
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 50, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;
		const resumeResp = await server.dispatch(
			conn,
			JSON.stringify({ id: 51, method: "thread/resume", params: { threadId } }),
		);
		const resumed = JSON.parse(resumeResp as string).result;
		expect(resumed.resumed).toBe(true);
		expect(resumed.thread.generation).toBe(2);

		const beforeTurn = frames.length;
		const turnResp = await server.dispatch(
			conn,
			JSON.stringify({ id: 52, method: "turn/start", params: { threadId, input: "after resume" } }),
		);
		expect(JSON.parse(turnResp as string).result.turn.status).toBe("inProgress");
		expect((await waitForCall(calls, "backend.prompt", threadId)).generation).toBe(2);

		expect(server.emitBackendEvent(threadId, 2, "message_start", "{}")).toBeGreaterThan(0);
		await new Promise(r => setTimeout(r, 50));
		expect(frames.slice(beforeTurn).map(f => f.method)).toContain("item/started");
		const afterAccepted = frames.length;
		expect(server.emitBackendEvent(threadId, 1, "agent_start", "{}")).toBe(0);
		await new Promise(r => setTimeout(r, 20));
		expect(frames.length).toBe(afterAccepted);
	});

	it("enforces strict gjc/* field policy through the bridge", async () => {
		const { server } = makeServer();
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 6, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;
		const resp = await server.dispatch(
			conn,
			JSON.stringify({
				id: 7,
				method: "gjc/model/set",
				params: { threadId, provider: "a", modelId: "b", bogus: 1 },
			}),
		);
		expect(JSON.parse(resp as string).error.code).toBe(-32602); // INVALID_PARAMS
	});

	it("round-trips client registered host tools through the native bridge", async () => {
		const { server, frames } = makeServer();
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 8, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;

		const setResp = await server.dispatch(
			conn,
			JSON.stringify({
				id: 9,
				method: "gjc/hostTools/set",
				params: {
					threadId,
					tools: [{ name: "echo_host", description: "Echo", inputSchema: { type: "object" } }],
				},
			}),
		);
		expect(JSON.parse(setResp as string).result).toEqual({});
		expect(server.hostToolNames(threadId)).toEqual(["echo_host"]);

		const pending = server.callHostTool(threadId, "turn_host", "echo_host", JSON.stringify({ value: 42 }));
		const callFrame = await waitForFrame(frames, "gjc/hostTools/call");
		const params = callFrame.params as Record<string, unknown>;
		expect(params.threadId).toBe(threadId);
		expect(params.turnId).toBe("turn_host");
		expect(params.tool).toBe("echo_host");
		expect(params.args).toEqual({ value: 42 });

		const resultResp = await server.dispatch(
			conn,
			JSON.stringify({
				id: 10,
				method: "gjc/hostTools/result",
				params: { threadId, callId: params.callId, ok: true, result: { echoed: params.args } },
			}),
		);
		expect(JSON.parse(resultResp as string).result).toEqual({});
		expect(JSON.parse(await pending)).toEqual({ echoed: { value: 42 } });
	});

	it("rejects native host tool calls for unknown tools", async () => {
		const { server } = makeServer();
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 11, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;

		await expect(server.callHostTool(threadId, "turn_missing", "missing", "{}")).rejects.toThrow(
			"host tool not registered: missing",
		);
	});

	it("rejects host tool calls without an active turn id", async () => {
		const { server } = makeServer();
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 12, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;
		await server.dispatch(
			conn,
			JSON.stringify({
				id: 13,
				method: "gjc/hostTools/set",
				params: { threadId, tools: [{ name: "echo_host", description: "Echo", inputSchema: { type: "object" } }] },
			}),
		);

		await expect(server.callHostTool(threadId, null, "echo_host", "{}")).rejects.toThrow("missing turnId");
	});

	it("cancels native host tool calls that use the accepted active turn id", async () => {
		const frames: Frame[] = [];
		let server!: AppServer;
		let promptCallId: string | undefined;
		const onFrame = (_err: unknown, frame: string) => frames.push(JSON.parse(frame) as Frame);
		const onCall = (_err: unknown, call: string) => {
			const { callId, kind } = JSON.parse(call) as { callId: string; kind: string };
			if (kind.startsWith("factory.")) {
				server.resolveCall(callId, true, JSON.stringify({ threadId: `thr_host_${callId}`, sessionMetadata: {} }));
				return;
			}
			if (kind === "backend.prompt") {
				promptCallId = callId;
				return;
			}
			if (kind === "backend.abort") {
				server.resolveCall(callId, true, "{}");
			}
		};
		server = new AppServer(onFrame, onCall);
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 14, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;
		await server.dispatch(
			conn,
			JSON.stringify({
				id: 15,
				method: "gjc/hostTools/set",
				params: { threadId, tools: [{ name: "echo_host", description: "Echo", inputSchema: { type: "object" } }] },
			}),
		);

		const turnResp = await server.dispatch(
			conn,
			JSON.stringify({ id: 16, method: "turn/start", params: { threadId, input: "hi" } }),
		);
		const turnId = JSON.parse(turnResp as string).result.turn.id as string;
		expect(server.activeTurnId(threadId)).toBe(turnId);

		const pending = server.callHostTool(threadId, turnId, "echo_host", JSON.stringify({ value: 42 }));
		const pendingError = pending.then(
			() => null,
			error => error,
		);
		const callFrame = await waitForFrame(frames, "gjc/hostTools/call");
		expect((callFrame.params as Record<string, unknown>).turnId).toBe(turnId);

		const interruptPromise = server.dispatch(
			conn,
			JSON.stringify({ id: 17, method: "turn/interrupt", params: { threadId, turnId } }),
		);
		const cancelFrame = await waitForFrame(frames, "gjc/hostTools/cancel");
		expect((cancelFrame.params as Record<string, unknown>).threadId).toBe(threadId);
		const interruptResp = await interruptPromise;
		expect(JSON.parse(interruptResp as string).result).toEqual({});
		const error = await pendingError;
		expect(error?.message).toContain("host tool call was cancelled");
		if (promptCallId) server.resolveCall(promptCallId, true, JSON.stringify({ turnId }));
	});

	it("rejects malformed host sessionMetadata and backend event payload JSON", async () => {
		let server!: AppServer;
		server = new AppServer(
			() => {},
			(_err: unknown, call: string) => {
				const { callId, kind } = JSON.parse(call) as { callId: string; kind: string };
				if (kind.startsWith("factory.")) {
					server.resolveCall(
						callId,
						true,
						JSON.stringify({ threadId: "thr_bad", sessionMetadata: "not-an-object" }),
					);
				}
			},
		);
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 18, method: "thread/start", params: {} }));
		expect(JSON.parse(startResp as string).error.message).toContain("sessionMetadata");
		expect(() => server.emitBackendEvent("thr_bad", 1, "agent_start", "{")).toThrow(
			"invalid backend event payload JSON",
		);
	});

	it("exposes the Rust-derived schema", () => {
		const { server } = makeServer();
		const schema = JSON.parse(server.schemaJson());
		expect(schema.title).toBe("gjc-app-server wire protocol");
		expect(schema.definitions.Request).toBeDefined();
	});
});
