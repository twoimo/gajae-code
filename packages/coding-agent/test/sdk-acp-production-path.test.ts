import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";

type TestServer = {
	port: number | undefined;
	upgrade(request: Request): boolean;
	stop(closeActiveConnections?: boolean): void;
};

const directories: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

test("production ACP routes zero-session SDK globals through the broker adapter", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "gjc-sdk-acp-production-"));
	directories.push(directory);
	const agentDir = path.join(directory, ".gjc", "agent");
	const token = "acp-broker-token";
	const requests: Array<Record<string, unknown>> = [];
	let server!: TestServer;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				requests.push(frame);
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: { sessions: [] } }));
			},
		},
	});
	servers.push(server);
	await mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await writeFile(
		path.join(agentDir, "sdk", "broker.json"),
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: server.port!,
			url: `ws://127.0.0.1:${server.port!}`,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);

	const abort = new AbortController();
	const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, { agentDir });
	const result = await agent.extMethod("_gjc/sdk/global", { operation: "session.list" });

	expect(result).toMatchObject({ ok: true, result: { sessions: [] } });
	expect(requests).toEqual([
		expect.objectContaining({ type: "broker_request", operation: "session.list", input: {} }),
	]);
	expect(requests[0]).not.toHaveProperty("sessionId");
	abort.abort();
});

test("production ACP preserves lifecycle, turn, replay, and connection ownership contracts over SDK WebSockets", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "gjc-sdk-acp-contract-"));
	directories.push(directory);
	const agentDir = path.join(directory, ".gjc", "agent");
	const cwd = path.join(directory, "workspace");
	const token = "acp-contract-token";
	let brokerSessions: Record<string, unknown>[] = [
		{ sessionId: "owned-session", locator: { repo: cwd }, live: true, endpointGeneration: 1 },
	];
	const lifecycleInputs: Record<string, unknown>[] = [];
	const brokerRequests: Record<string, unknown>[] = [];
	const promptInputs: Record<string, unknown>[] = [];
	const controlOperations: string[] = [];
	const updates: SessionNotification[] = [];
	const providerRegistrations: Array<Record<string, unknown>> = [];
	let promptSocket: { send(message: string): void } | undefined;

	let server!: ReturnType<typeof Bun.serve>;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "acp-contract" }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.type === "register_provider") {
					providerRegistrations.push(frame);
					socket.send(
						JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
					);
					return;
				}
				if (frame.type === "broker_request") {
					brokerRequests.push(frame);
					if (frame.operation === "session.create") {
						lifecycleInputs.push(frame.input as Record<string, unknown>);
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: {
									sessionId: "owned-session",
									endpoint: { url: `ws://127.0.0.1:${server.port}`, token },
								},
							}),
						);
						return;
					}
					if (frame.operation === "session.list") {
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: { sessions: brokerSessions },
							}),
						);
						return;
					}
					if (frame.operation === "session.get_endpoint") {
						socket.send(
							JSON.stringify({
								type: "broker_response",
								id: frame.id,
								ok: true,
								result: {
									sessionId: "owned-session",
									endpoint: { url: `ws://127.0.0.1:${server.port}`, token },
								},
							}),
						);
						return;
					}
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: {} }));
					return;
				}
				if (frame.type === "query_request") {
					const items =
						frame.query === "config.list/get"
							? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
							: frame.query === "models.list/current"
								? [{ provider: "openai", id: "gpt", name: "GPT" }]
								: frame.query === "transcript.list"
									? [
											{ id: "user-1", role: "user", content: "Earlier request" },
											{
												id: "assistant-1",
												role: "assistant",
												content: [{ type: "text", text: "Earlier response" }],
											},
										]
									: [];
					socket.send(
						JSON.stringify({ type: "query_response", id: frame.id, ok: true, result: { page: { items } } }),
					);
					return;
				}
				if (frame.type === "control_request") {
					if (typeof frame.operation === "string") controlOperations.push(frame.operation);
					if (frame.operation === "turn.prompt") {
						promptInputs.push(frame.input as Record<string, unknown>);
						promptSocket = socket;
					}
					socket.send(
						JSON.stringify({
							type: "control_response",
							id: frame.id,
							ok: true,
							result: frame.operation === "turn.prompt" ? { commandId: "prompt-command", accepted: true } : {},
						}),
					);
				}
			},
		},
	});
	servers.push(server);
	await mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(
		path.join(agentDir, "sdk", "broker.json"),
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: server.port,
			url: `ws://127.0.0.1:${server.port}`,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);

	const controller = new AbortController();
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => {
				updates.push(update);
			},
			signal: controller.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir, startupOptions: { modelPreset: "codex-medium" } },
	);
	const initialized = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
	expect(initialized.agentCapabilities?.mcpCapabilities).toBeUndefined();
	const created = await agent.newSession({ cwd, mcpServers: [] });
	expect(created.sessionId).toBe("owned-session");
	expect(lifecycleInputs).toEqual([expect.objectContaining({ cwd, modelPreset: "codex-medium" })]);

	let firstSettled = false;
	const firstPrompt = agent
		.prompt({
			sessionId: created.sessionId,
			prompt: [
				{ type: "resource_link", name: "README", uri: "file:///workspace/README.md" },
				{ type: "image", data: "image-bytes", mimeType: "image/png" },
			],
		})
		.then(value => {
			firstSettled = true;
			return value;
		});
	await waitFor(() => promptInputs.length === 1 && promptSocket !== undefined, "first prompt delivery");
	expect(promptInputs[0]).toEqual({
		text: "[Resource: README]\nURI: file:///workspace/README.md",
		images: [{ data: "image-bytes", mimeType: "image/png" }],
	});
	await expect(
		agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "second" }] }),
	).rejects.toThrow("ACP session already has an active prompt.");
	await Bun.sleep(20);
	expect(firstSettled).toBe(false);
	promptSocket!.send(
		JSON.stringify({
			type: "event",
			payload: {
				event_type: "agent_end",
				event: { type: "agent_end", commandId: "stale-command", messages: [] },
			},
		}),
	);
	await Bun.sleep(20);
	expect(firstSettled).toBe(false);
	promptSocket!.send(
		JSON.stringify({
			type: "event",
			payload: { event_type: "agent_end", event: { type: "agent_end", messages: [] } },
		}),
	);
	await Bun.sleep(20);
	expect(firstSettled).toBe(false);
	promptSocket!.send(
		JSON.stringify({ type: "event", payload: { event_type: "agent_start", event: { type: "agent_start" } } }),
	);
	promptSocket!.send(
		JSON.stringify({
			type: "event",
			payload: { event_type: "agent_end", event: { type: "agent_end", messages: [] } },
		}),
	);
	expect(await firstPrompt).toEqual({ stopReason: "end_turn" });

	let cancelledSettled = false;
	const cancelledPrompt = agent
		.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "cancel me" }] })
		.then(value => {
			cancelledSettled = true;
			return value;
		});
	await waitFor(() => promptInputs.length === 2, "second prompt delivery");
	await agent.cancel({ sessionId: created.sessionId });
	expect(controlOperations).toContain("turn.abort");
	await Bun.sleep(20);
	expect(cancelledSettled).toBe(false);
	promptSocket!.send(
		JSON.stringify({ type: "event", payload: { event_type: "agent_start", event: { type: "agent_start" } } }),
	);
	promptSocket!.send(
		JSON.stringify({
			type: "event",
			payload: { event_type: "agent_end", event: { type: "agent_end", messages: [] } },
		}),
	);
	expect(await cancelledPrompt).toEqual({ stopReason: "cancelled" });

	await expect(
		agent.prompt({
			sessionId: created.sessionId,
			prompt: [
				{
					type: "resource",
					resource: { uri: "file:///workspace/archive.bin", blob: "bytes", mimeType: "application/octet-stream" },
				},
			],
		}),
	).rejects.toThrow("Unsupported embedded resource MIME type");
	await expect(
		agent.newSession({ cwd, mcpServers: [{ type: "http", name: "unavailable", url: "http://127.0.0.1" }] as never }),
	).rejects.toThrow("MCP servers are unsupported under SDK-backed ACP.");

	const observerAbort = new AbortController();
	const observer = new AcpAgent({ signal: observerAbort.signal } as unknown as AgentSideConnection, { agentDir });
	await observer.listSessions({});
	const brokerRequestCount = brokerRequests.length;
	expect(await observer.closeSession({ sessionId: created.sessionId })).toEqual({});
	expect(await observer.deleteSession({ sessionId: created.sessionId })).toEqual({});
	expect(brokerRequests).toHaveLength(brokerRequestCount);
	observerAbort.abort();

	await agent.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] });
	expect(updates).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: "Earlier request" },
				}),
			}),
			expect.objectContaining({
				sessionId: created.sessionId,
				update: expect.objectContaining({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Earlier response" },
				}),
			}),
		]),
	);
	const loaderAbort = new AbortController();
	const loader = new AcpAgent(
		{
			sessionUpdate: async () => {},
			signal: loaderAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const registrationsBeforeLiveAttach = providerRegistrations.length;
	const brokerRequestsBeforeLiveAttach = brokerRequests.length;
	await Promise.all([
		loader.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
		loader.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
	]);
	const liveAttachRequests = brokerRequests.slice(brokerRequestsBeforeLiveAttach);
	expect(liveAttachRequests.filter(request => request.operation === "session.resume")).toHaveLength(0);
	expect(liveAttachRequests.filter(request => request.operation === "session.get_endpoint")).toEqual([
		expect.objectContaining({ input: { sessionId: created.sessionId, endpointGeneration: 1 } }),
	]);
	expect(providerRegistrations).toHaveLength(registrationsBeforeLiveAttach + 2);

	brokerSessions = [
		{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 1 },
		{ sessionId: created.sessionId, locator: { repo: cwd }, live: true, endpointGeneration: 2 },
	];
	const conflictAbort = new AbortController();
	const conflictingLoader = new AcpAgent(
		{ signal: conflictAbort.signal, closed: Promise.withResolvers<void>().promise } as unknown as AgentSideConnection,
		{ agentDir },
	);
	const brokerRequestsBeforeConflict = brokerRequests.length;
	await expect(conflictingLoader.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] })).rejects.toThrow(
		"Broker returned duplicate session id",
	);
	expect(brokerRequests.slice(brokerRequestsBeforeConflict)).toEqual([
		expect.objectContaining({ operation: "session.list", input: { cwd } }),
	]);
	conflictAbort.abort();

	brokerSessions = [
		{ sessionId: created.sessionId, locator: { repo: path.join(directory, "other-workspace") }, live: true },
	];
	const scopeConflictAbort = new AbortController();
	const scopeConflictingLoader = new AcpAgent(
		{
			signal: scopeConflictAbort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const brokerRequestsBeforeScopeConflict = brokerRequests.length;
	await expect(
		scopeConflictingLoader.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] }),
	).rejects.toThrow("Broker returned conflicting session scope");
	expect(brokerRequests.slice(brokerRequestsBeforeScopeConflict)).toEqual([
		expect.objectContaining({ operation: "session.list", input: { cwd } }),
	]);
	scopeConflictAbort.abort();
	loaderAbort.abort();
	controller.abort();
});
