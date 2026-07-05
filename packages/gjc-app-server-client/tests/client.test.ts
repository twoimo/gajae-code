import { describe, expect, test } from "bun:test";
import {
	AppServerClient,
	AppServerResponseError,
	type ServerNotificationEnvelope,
	type WebSocketLike,
} from "../src";
import { checkMethodCatalogDrift } from "../scripts/generate";

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

	test("dispatches new typed notifications", async () => {
		const { client, socket } = createHarness();
		await client.connect("ws://127.0.0.1:8765?token=test");
		const gateIds: string[] = [];
		const hostUriRequests: string[] = [];

		client.onNotification("gjc/workflowGate/opened", params => gateIds.push(params.gate_id));
		client.onNotification("gjc/hostUris/request", params => hostUriRequests.push(params.requestId));

		socket.serverMessage({
			method: "gjc/workflowGate/opened",
			params: {
				threadId: "thread-1",
				generation: 1,
				type: "workflow-gate",
				gate_id: "gate-1",
				stage: "ralplan",
				kind: "approval",
				schema: { type: "boolean" },
				schema_hash: "hash",
				context: {},
				created_at: "2026-07-04T00:00:00Z",
				required: true,
			},
		});
		socket.serverMessage({
			method: "gjc/hostUris/request",
			params: {
				threadId: "thread-1",
				generation: 1,
				turnId: "turn-1",
				requestId: "request-1",
				operation: "read",
				url: "file:///tmp/a",
			},
		});

		expect(gateIds).toEqual(["gate-1"]);
		expect(hostUriRequests).toEqual(["request-1"]);
	});

	test("new GUI wrappers send method params and resolve responses", async () => {
		const { client, socket } = createHarness();
		await client.connect("ws://127.0.0.1:8765?token=test");
		const cases = [
			{
				call: () => client.threadFork({ threadId: "thread-1" }),
				method: "thread/fork",
				params: { threadId: "thread-1" },
				result: { thread: { id: "thread-2", status: "idle", forkedFromId: "thread-1" } },
			},
			{
				call: () => client.threadDelete({ threadId: "thread-1" }),
				method: "thread/delete",
				params: { threadId: "thread-1" },
				result: {},
			},
			{
				call: () => client.threadArchive({ threadId: "thread-1" }),
				method: "thread/archive",
				params: { threadId: "thread-1" },
				result: {},
			},
			{
				call: () => client.threadLoadedList(),
				method: "thread/loaded/list",
				params: {},
				result: { data: ["thread-1"] },
			},
			{
				call: () => client.gjcHostUriSchemesSet({ threadId: "thread-1", schemes: [{ scheme: "file", writable: false, immutable: true }] }),
				method: "gjc/hostUriSchemes/set",
				params: { threadId: "thread-1", schemes: [{ scheme: "file", writable: false, immutable: true }] },
				result: { schemes: [{ scheme: "file", writable: false, immutable: true }] },
			},
			{
				call: () => client.gjcToolsList({ threadId: "thread-1" }),
				method: "gjc/tools/list",
				params: { threadId: "thread-1" },
				result: { tools: [{ name: "read", active: true, description: "Read files" }] },
			},
			{
				call: () => client.gjcCommandsList({ threadId: "thread-1", includeDisabled: true }),
				method: "gjc/commands/list",
				params: { threadId: "thread-1", includeDisabled: true },
				result: { commands: [{ name: "help", source: "builtin", description: "Show help", classification: "builtin" }] },
			},
			{
				call: () => client.gjcSkillsList({ threadId: "thread-1" }),
				method: "gjc/skills/list",
				params: { threadId: "thread-1" },
				result: { skills: [{ name: "ralplan", source: "builtin", description: "Plan", enabled: true }] },
			},
			{
				call: () => client.gjcExtensionsList({ threadId: "thread-1" }),
				method: "gjc/extensions/list",
				params: { threadId: "thread-1" },
				result: { extensions: [{ id: "gemini", name: "Gemini", kind: "extension", source: "project", status: "available" }] },
			},
			{
				call: () => client.gjcExtensionsInspect({ threadId: "thread-1", extensionId: "gemini" }),
				method: "gjc/extensions/inspect",
				params: { threadId: "thread-1", extensionId: "gemini" },
				result: { extension: { id: "gemini", name: "Gemini", kind: "extension", source: "project", status: "available" } },
			},
			{
				call: () => client.gjcPluginsList({ threadId: "thread-1" }),
				method: "gjc/plugins/list",
				params: { threadId: "thread-1" },
				result: { plugins: [{ id: "pkg", name: "Pkg", kind: "plugin", source: "/tmp/pkg", status: "enabled" }] },
			},
			{
				call: () => client.gjcPluginsInspect({ threadId: "thread-1", pluginId: "pkg" }),
				method: "gjc/plugins/inspect",
				params: { threadId: "thread-1", pluginId: "pkg" },
				result: { plugin: { id: "pkg", name: "Pkg", kind: "plugin", source: "/tmp/pkg", status: "enabled" } },
			},
			{
				call: () => client.gjcHostUrisResult({ threadId: "thread-1", requestId: "request-1", content: "ok", isError: false }),
				method: "gjc/hostUris/result",
				params: { threadId: "thread-1", requestId: "request-1", content: "ok", isError: false },
				result: {},
			},
			{
				call: () => client.gjcWorkflowGateList({ threadId: "thread-1" }),
				method: "gjc/workflowGate/list",
				params: { threadId: "thread-1" },
				result: { gates: [] },
			},
			{
				call: () => client.gjcWorkflowGateRespond({ threadId: "thread-1", gate_id: "gate-1", answer: true }),
				method: "gjc/workflowGate/respond",
				params: { threadId: "thread-1", gate_id: "gate-1", answer: true },
				result: { gate_id: "gate-1", status: "accepted", answer_hash: "hash" },
			},
		];

		for (const item of cases) {
			const response = item.call();
			const sent = JSON.parse(socket.sent.at(-1)!);
			expect(sent).toEqual({ id: socket.sent.length, method: item.method, params: item.params });
			socket.serverMessage({ id: sent.id, result: item.result });
			expect(await (response as Promise<unknown>)).toEqual(item.result);
		}
	});

	test("method catalog drift check passes for current client wrappers", async () => {
		// Deliberate-drift simulation: removing an AppServerRequestMap key or wrapper request("...") call
		// for a guiWrapper=true catalog entry makes checkMethodCatalogDrift return an error.
		await expect(checkMethodCatalogDrift()).resolves.toEqual([]);
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
