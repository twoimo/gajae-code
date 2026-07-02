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
		const resp = await server.dispatch(conn, JSON.stringify({ id: 2, method: "thread/start", params: { cwd: "/repo" } }));
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
		await new Promise((r) => setTimeout(r, 50));

		const methods = frames.map((f) => f.method);
		expect(methods).toContain("turn/started");
		expect(methods).toContain("item/agentMessage/delta");
		expect(methods.filter((m) => m === "turn/completed").length).toBe(1);
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

	it("enforces strict gjc/* field policy through the bridge", async () => {
		const { server } = makeServer();
		const conn = await initialize(server);
		const startResp = await server.dispatch(conn, JSON.stringify({ id: 6, method: "thread/start", params: {} }));
		const threadId = JSON.parse(startResp as string).result.thread.id as string;
		const resp = await server.dispatch(
			conn,
			JSON.stringify({ id: 7, method: "gjc/model/set", params: { threadId, provider: "a", modelId: "b", bogus: 1 } }),
		);
		expect(JSON.parse(resp as string).error.code).toBe(-32602); // INVALID_PARAMS
	});

	it("exposes the Rust-derived schema", () => {
		const { server } = makeServer();
		const schema = JSON.parse(server.schemaJson());
		expect(schema.title).toBe("gjc-app-server wire protocol");
		expect(schema.definitions.Request).toBeDefined();
	});
});
