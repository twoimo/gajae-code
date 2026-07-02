import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { AppServer } from "@gajae-code/natives";
import WebSocket from "ws";

type Json = Record<string, unknown>;

function makeServer(): AppServer {
	let server!: AppServer;
	const onFrame = () => {};
	const onCall = (_err: unknown, call: string) => {
		const parsed = JSON.parse(call) as { callId: string; kind: string };
		if (parsed.kind === "factory.create") {
			server.resolveCall(
				parsed.callId,
				true,
				JSON.stringify({ threadId: `thr_ws_${parsed.callId}`, sessionMetadata: {} }),
			);
			return;
		}
		server.resolveCall(parsed.callId, true, "{}");
	};
	server = new AppServer(onFrame, onCall);
	return server;
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
		socket.setTimeout(1_000, () => {
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

function nextJson(ws: WebSocket): Promise<Json> {
	return new Promise((resolve, reject) => {
		ws.once("message", data => resolve(JSON.parse(data.toString()) as Json));
		ws.once("error", reject);
	});
}

async function sendRequest(ws: WebSocket, id: number, method: string, params: Json = {}): Promise<Json> {
	const response = nextJson(ws);
	ws.send(JSON.stringify({ id, method, params }));
	return response;
}

describe("app-server WebSocket transport", () => {
	it("serves initialize and thread/start over token-gated loopback WebSocket", async () => {
		const server = makeServer();
		const url = await server.listenWs("127.0.0.1", 0, "tok", `sess-${randomUUID()}`, undefined);
		expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
		expect(url.endsWith(":0")).toBe(false);

		const ws = await connect(`${url}/?token=tok`);
		try {
			const initialize = await sendRequest(ws, 1, "initialize");
			expect((initialize.result as Json).userAgent).toContain("gjc-app-server/");

			ws.send(JSON.stringify({ method: "initialized" }));

			const started = await sendRequest(ws, 2, "thread/start", { cwd: "/repo" });
			const thread = ((started.result as Json).thread as Json).id;
			expect(typeof thread).toBe("string");
			expect(String(thread).startsWith("thr_ws_")).toBe(true);
		} finally {
			ws.close();
		}
	});

	it("rejects connections with the wrong token", async () => {
		const server = makeServer();
		const url = await server.listenWs("127.0.0.1", 0, "tok", `sess-${randomUUID()}`, undefined);

		expect(await rejectedHandshakeStatus(`${url}/?token=wrong`)).toContain(" 401 ");
	});
});
