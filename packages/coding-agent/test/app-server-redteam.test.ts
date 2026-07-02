import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import WebSocket from "ws";
import { type AppServerHost, type CreatedThread, startAppServer } from "../src/modes/app-server/host";
import { AppServerNotificationEndpoint } from "../src/notifications/app-server-endpoint";

type Json = Record<string, unknown>;

class RedteamHost implements AppServerHost {
	public calls: Array<{ threadId: string; method: string; params: unknown; startedAt: number; finishedAt?: number }> =
		[];
	private nextThread = 0;
	public endpoint?: AppServerNotificationEndpoint;
	public promptDelayMs = 0;

	async createThread(): Promise<CreatedThread> {
		this.nextThread += 1;
		return { threadId: `thr_red_${this.nextThread}`, sessionMetadata: { cwd: "/repo" } };
	}
	resumeThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	forkThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	async backendCall(threadId: string, method: string, params: unknown): Promise<unknown> {
		const call: (typeof this.calls)[number] = { threadId, method, params, startedAt: Date.now() };
		this.calls.push(call);
		if (method === "prompt" || method === "steer") {
			if (this.promptDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.promptDelayMs));
			call.finishedAt = Date.now();
			return {
				turnId: `turn_${threadId}_${this.calls.filter(c => c.threadId === threadId && c.method === method).length}`,
			};
		}
		if (method === "getState") return { status: "idle" };
		if (method === "setModel") return { ok: true };
		if (method === "setTodos") return { ok: true };
		call.finishedAt = Date.now();
		return {};
	}
	async notificationCall(method: string, params: unknown): Promise<unknown> {
		if (!this.endpoint) return { ok: true };
		return this.endpoint.handleNotificationCall(method, params);
	}
}

function decode(frame: string | null): Json {
	expect(typeof frame).toBe("string");
	return JSON.parse(frame as string) as Json;
}

function errorCode(frame: string | null): number {
	return (decode(frame).error as Json).code as number;
}

async function init(handle: ReturnType<typeof startAppServer>): Promise<string> {
	const conn = handle.openConnection();
	expect(
		(decode(await handle.dispatch(conn, JSON.stringify({ id: 0, method: "initialize", params: {} }))).result as Json)
			.userAgent,
	).toContain("gjc-app-server/");
	expect(await handle.dispatch(conn, JSON.stringify({ method: "initialized" }))).toBeNull();
	return conn;
}

async function startThread(handle: ReturnType<typeof startAppServer>, conn: string, id = 1): Promise<string> {
	const resp = decode(
		await handle.dispatch(conn, JSON.stringify({ id, method: "thread/start", params: { cwd: "/repo" } })),
	);
	return ((resp.result as Json).thread as Json).id as string;
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for condition"));
			setTimeout(tick, 10);
		};
		tick();
	});
}

function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

function rejectedHandshakeStatus(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const socket = net.connect(Number(parsed.port), parsed.hostname, () => {
			socket.write(
				[
					`GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
					`Host: ${parsed.host}`,
					"Connection: Upgrade",
					"Upgrade: websocket",
					"Sec-WebSocket-Version: 13",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"",
					"",
				].join("\r\n"),
			);
		});
		let data = "";
		socket.setTimeout(1000, () => {
			socket.destroy();
			reject(new Error("timed out waiting for handshake response"));
		});
		socket.on("data", chunk => {
			data += chunk.toString();
			if (data.includes("\r\n")) {
				socket.end();
				resolve(data.split("\r\n", 1)[0] ?? "");
			}
		});
		socket.on("error", reject);
	});
}

describe("app-server adversarial red-team", () => {
	it("rejects protocol abuse and preserves codex/gjc field policy", async () => {
		const host = new RedteamHost();
		const handle = startAppServer(host, { onFrame: () => {}, maxInflightTurnsPerThread: 1 });
		const coldConn = handle.openConnection();

		expect(
			errorCode(await handle.dispatch(coldConn, JSON.stringify({ id: 1, method: "thread/start", params: {} }))),
		).toBe(-32002);
		expect(errorCode(await handle.dispatch(coldConn, '{"id":2,"method":'))).toBe(-32700);

		expect(
			(
				decode(await handle.dispatch(coldConn, JSON.stringify({ id: 3, method: "initialize", params: {} })))
					.result as Json
			).userAgent,
		).toContain("gjc-app-server/");
		const dup = decode(await handle.dispatch(coldConn, JSON.stringify({ id: 4, method: "initialize", params: {} })));
		expect((dup.error as Json).message).toContain("Already initialized");
		expect(await handle.dispatch(coldConn, JSON.stringify({ method: "initialized" }))).toBeNull();

		expect(errorCode(await handle.dispatch(coldConn, JSON.stringify({ id: 5, method: "no/such", params: {} })))).toBe(
			-32601,
		);
		const threadId = await startThread(handle, coldConn, 6);

		const lenient = decode(
			await handle.dispatch(
				coldConn,
				JSON.stringify({
					id: 7,
					method: "turn/start",
					params: { threadId, input: "x", environments: ["prod"], realtime: true, selectedCapabilityRoots: [] },
				}),
			),
		);
		expect(lenient.error).toBeUndefined();

		const strict = decode(
			await handle.dispatch(
				coldConn,
				JSON.stringify({
					id: 8,
					method: "gjc/model/set",
					params: { threadId, provider: "anthropic", modelId: "claude", bogus: true },
				}),
			),
		);
		expect((strict.error as Json).code).toBe(-32602);
		expect((strict.error as Json).message).toContain("bogus");

		const mismatch = decode(
			await handle.dispatch(
				coldConn,
				JSON.stringify({
					id: 9,
					method: "turn/start",
					params: { threadId, input: "later", expectedTurnId: "turn_does_not_match" },
				}),
			),
		);
		expect((mismatch.error as Json).code).toBe(-32004);
		expect((mismatch.error as Json).message).toContain("expectedTurnId");
	});

	it("enforces per-thread admission while allowing simultaneous turns in two threads", async () => {
		const host = new RedteamHost();
		host.promptDelayMs = 80;
		const handle = startAppServer(host, { onFrame: () => {}, maxInflightTurnsPerThread: 1 });
		const conn = await init(handle);
		const a = await startThread(handle, conn, 10);
		const b = await startThread(handle, conn, 11);

		const first = handle.dispatch(
			conn,
			JSON.stringify({ id: 12, method: "turn/start", params: { threadId: a, input: "hold" } }),
		);
		await waitFor(() => host.calls.some(c => c.threadId === a && c.method === "prompt"));
		const overloaded = decode(
			await handle.dispatch(
				conn,
				JSON.stringify({ id: 13, method: "turn/start", params: { threadId: a, input: "second" } }),
			),
		);
		expect((overloaded.error as Json).code).toBe(-32001);

		const other = handle.dispatch(
			conn,
			JSON.stringify({ id: 14, method: "turn/start", params: { threadId: b, input: "parallel" } }),
		);
		const [firstResp, otherResp] = [decode(await first), decode(await other)];
		expect(firstResp.error).toBeUndefined();
		expect(otherResp.error).toBeUndefined();

		// Prompts run in background tasks (accepted-turn contract), so wait until
		// both threads' prompts have been dispatched before comparing.
		await waitFor(() => host.calls.filter(c => c.method === "prompt").length === 2);
		const promptCalls = host.calls.filter(c => c.method === "prompt");
		expect(promptCalls.map(c => c.threadId).sort()).toEqual([a, b].sort());
		expect(Math.abs(promptCalls[0].startedAt - promptCalls[1].startedAt)).toBeLessThan(75);
	});

	it("rejects stale-generation backend events and keeps two thread streams independent", async () => {
		const frames: Json[] = [];
		const handle = startAppServer(new RedteamHost(), { onFrame: frame => frames.push(JSON.parse(frame) as Json) });
		const conn = await init(handle);
		const a = await startThread(handle, conn, 20);
		const b = await startThread(handle, conn, 21);

		expect(handle.emitEvent(a, 99, "agent_start", {})).toBe(0);
		expect(frames).toHaveLength(0);

		handle.emitEvent(a, 1, "agent_start", {});
		handle.emitEvent(b, 1, "agent_start", {});
		handle.emitEvent(a, 1, "agent_end", {});
		handle.emitEvent(b, 1, "agent_end", {});
		await waitFor(() => frames.filter(f => f.method === "turn/completed").length === 2);

		const completedThreadIds = frames
			.filter(f => f.method === "turn/completed")
			.map(f => (f.params as Json).threadId as string)
			.sort();
		expect(completedThreadIds).toEqual([a, b].sort());
	});

	it("rejects wrong WS tokens with 401", async () => {
		const handle = startAppServer(new RedteamHost(), { onFrame: () => {} });
		const url = await handle.server.listenWs("127.0.0.1", 0, "tok", `sess-${randomUUID()}`, undefined);
		expect(await rejectedHandshakeStatus(`${url}/?token=wrong`)).toContain(" 401 ");
	});

	it("routes Phase7 notification lifecycle rejections through the native app-server", async () => {
		const host = new RedteamHost();
		const endpoint = new AppServerNotificationEndpoint({ sessionId: "sess-red", pushNotification: () => {} });
		host.endpoint = endpoint;
		const handle = startAppServer(host, { onFrame: () => {} });
		(endpoint as unknown as { pushNotification: (frame: unknown) => void }).pushNotification = frame =>
			handle.pushNotification(frame);
		endpoint.onReply((_err, reply) => {
			if (reply) endpoint.resolveClient(reply.id, reply.answerJson, reply.idempotencyKey);
		});

		const url = await handle.server.listenWs("127.0.0.1", 0, "tok", `sess-${randomUUID()}`, undefined);
		const ws = await connect(`${url}/?token=tok`);
		const messages: Json[] = [];
		ws.on("message", data => messages.push(JSON.parse(data.toString()) as Json));
		try {
			ws.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
			ws.send(JSON.stringify({ method: "initialized" }));
			ws.send(JSON.stringify({ id: 2, method: "gjc/notifications/subscribe", params: {} }));
			await waitFor(() => messages.some(m => m.id === 2 && (m.result as Json)?.ok === true));

			endpoint.registerAsk(
				JSON.stringify({
					id: "ask-local",
					kind: "ask",
					sessionId: "sess-red",
					question: "Proceed?",
					options: ["Yes"],
				}),
				true,
			);
			endpoint.resolveLocal("ask-local");
			ws.send(
				JSON.stringify({ id: 3, method: "gjc/notifications/reply", params: { id: "ask-local", answer: "Yes" } }),
			);
			await waitFor(() => messages.some(m => m.id === 3));
			expect((messages.find(m => m.id === 3)?.result as Json).rejected).toBe("already_answered");

			endpoint.registerAsk(
				JSON.stringify({
					id: "ask-idem",
					kind: "ask",
					sessionId: "sess-red",
					question: "Proceed?",
					options: ["Yes", "No"],
				}),
				true,
			);
			ws.send(
				JSON.stringify({
					id: 4,
					method: "gjc/notifications/reply",
					params: { id: "ask-idem", answer: "Yes", idempotencyKey: "k1" },
				}),
			);
			await waitFor(() => messages.some(m => m.id === 4));
			expect((messages.find(m => m.id === 4)?.result as Json).ok).toBe(true);
			ws.send(
				JSON.stringify({
					id: 5,
					method: "gjc/notifications/reply",
					params: { id: "ask-idem", answer: "Yes", idempotencyKey: "k1" },
				}),
			);
			await waitFor(() => messages.some(m => m.id === 5));
			expect((messages.find(m => m.id === 5)?.result as Json).ok).toBe(true);
			ws.send(
				JSON.stringify({
					id: 6,
					method: "gjc/notifications/reply",
					params: { id: "ask-idem", answer: "No", idempotencyKey: "k1" },
				}),
			);
			await waitFor(() => messages.some(m => m.id === 6));
			expect((messages.find(m => m.id === 6)?.result as Json).rejected).toBe("idempotency_conflict");

			endpoint.registerAsk(
				JSON.stringify({ id: "ask-info", kind: "ask", sessionId: "sess-red", question: "FYI", options: [] }),
				false,
			);
			ws.send(
				JSON.stringify({ id: 7, method: "gjc/notifications/reply", params: { id: "ask-info", answer: "ignored" } }),
			);
			await waitFor(() => messages.some(m => m.id === 7));
			expect((messages.find(m => m.id === 7)?.result as Json).rejected).toBe("not_repliable");
		} finally {
			ws.close();
		}
	});
});
