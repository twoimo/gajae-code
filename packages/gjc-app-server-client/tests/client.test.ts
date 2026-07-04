import { describe, expect, test } from "bun:test";
import {
	AppServerClient,
	AppServerResponseError,
	type ServerNotificationEnvelope,
	type WebSocketLike,
} from "../src";

class FakeSocket implements WebSocketLike {
	readyState = 1;
	sent: string[] = [];
	readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", {});
	}

	addEventListener(type: "open" | "message" | "error" | "close", listener: (event?: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: "open" | "message" | "error" | "close", listener: (event?: unknown) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	emit(type: string, event?: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	serverMessage(payload: unknown): void {
		this.emit("message", { data: JSON.stringify(payload) });
	}
}

function createHarness(): { client: AppServerClient; socket: FakeSocket } {
	const socket = new FakeSocket();
	const client = new AppServerClient({ webSocketFactory: () => socket });
	return { client, socket };
}

describe("AppServerClient", () => {
	test("correlates out-of-order request responses by id", async () => {
		const { client, socket } = createHarness();
		await client.connect("ws://127.0.0.1:8765?token=test");

		const first = client.initialize();
		const second = client.threadRead({ threadId: "thread-1" });

		expect(JSON.parse(socket.sent[0]!)).toEqual({ id: 1, method: "initialize", params: {} });
		expect(JSON.parse(socket.sent[1]!)).toEqual({ id: 2, method: "thread/read", params: { threadId: "thread-1" } });

		socket.serverMessage({ id: 2, result: { thread: { id: "thread-1", status: "idle" } } });
		socket.serverMessage({ id: 1, result: { userAgent: "gjc", platformOs: "darwin", platformFamily: "unix" } });

		await expect(second).resolves.toEqual({ thread: { id: "thread-1", status: "idle" } });
		await expect(first).resolves.toEqual({ userAgent: "gjc", platformOs: "darwin", platformFamily: "unix" });
	});

	test("dispatches typed notifications to global and method listeners", async () => {
		const { client, socket } = createHarness();
		await client.connect("ws://127.0.0.1:8765?token=test");
		const seen: ServerNotificationEnvelope[] = [];
		const hostCalls: string[] = [];

		client.onNotification(notification => seen.push(notification));
		client.onNotification("gjc/hostTools/call", params => hostCalls.push(params.callId));

		socket.serverMessage({
			method: "gjc/hostTools/call",
			params: { threadId: "thread-1", generation: 1, turnId: "turn-1", callId: "call-1", tool: "open", args: { path: "x" } },
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("gjc/hostTools/call");
		expect(hostCalls).toEqual(["call-1"]);
	});

	test("maps JSON-RPC errors to AppServerResponseError", async () => {
		const { client, socket } = createHarness();
		await client.connect("ws://127.0.0.1:8765?token=test");

		const response = client.gjcModelSet({ threadId: "thread-1", provider: "openai", modelId: "gpt-4.1" });
		socket.serverMessage({ id: 1, error: { code: -32602, message: "invalid params", data: { field: "modelId" } } });

		await expect(response).rejects.toBeInstanceOf(AppServerResponseError);
		await response.catch(error => {
			expect(error).toMatchObject({ code: -32602, message: "invalid params", data: { field: "modelId" } });
		});
	});

	test("sends client notifications without JSON-RPC header", async () => {
		const { client, socket } = createHarness();
		await client.connect("ws://127.0.0.1:8765?token=test");

		client.notify("initialized", {});

		expect(JSON.parse(socket.sent[0]!)).toEqual({ method: "initialized", params: {} });
	});
});

async function compileChecks(client: AppServerClient): Promise<void> {
	await client.turnStart({ threadId: "thread-1", prompt: "hello" });
	await client.gjcHostToolsSet({
		threadId: "thread-1",
		tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }],
	});
	client.onNotification("turn/started", params => {
		const turnId: string = params.turnId;
		void turnId;
	});
	// @ts-expect-error threadId is required for turn/start.
	void client.turnStart({ prompt: "missing thread" });
	// @ts-expect-error modelId is required for gjc/model/set.
	void client.gjcModelSet({ threadId: "thread-1", provider: "openai" });
}
void compileChecks;
