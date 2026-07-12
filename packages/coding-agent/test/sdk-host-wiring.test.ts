import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/extensibility/extensions/types";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import {
	BrokerWorkflowGateEmitter,
	FileGateStore,
	type WorkflowGateEmitter,
} from "../src/modes/shared/agent-wire/workflow-gate-broker";
import type { InteractiveModeContext } from "../src/modes/types";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { createNotificationsExtension } from "../src/sdk/bus";
import { SessionSdkHost } from "../src/sdk/host";
import type {
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../src/session/client-bridge";

import { getAskAnswerSource } from "../src/tools/ask-answer-registry";

type SdkPermissionProvider =
	NonNullable<ExtensionContextActions["setSdkPermissionProvider"]> extends (provider: infer T) => void ? T : never;

const dirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.GJC_SDK_DISABLE;
	delete process.env.GJC_NOTIFICATIONS;
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(20);
	}
}

function start(
	ctx: Record<string, unknown>,
	settings?: Settings,
): Map<string, (event: unknown, context: unknown) => unknown> {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	createNotificationsExtension(
		{
			on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
			registerCommand: () => {},
			sendUserMessage: () => {},
		} as never,
		settings ? { settings } : undefined,
	);
	void handlers.get("session_start")?.({ type: "session_start" }, ctx);
	return handlers;
}

function context(
	cwd: string,
	sessionId: string,
	kind: "main" | "sub" = "main",
	live: { idle?: boolean; counts?: { steering: number; followUp: number; nextTurn: number } } = {},
	workflowGate?: WorkflowGateEmitter,
): Record<string, unknown> {
	return {
		cwd,
		sessionMetadata: { kind, taskDepth: kind === "sub" ? 1 : 0 },
		...(workflowGate ? { workflowGate } : {}),
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "SDK wiring",
			getUsageStatistics: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 }),
		},
		getContextUsage: () => ({ tokens: 3, contextWindow: 100, percent: 3 }),
		getSystemPrompt: () => ["test"],
		isIdle: () => live.idle ?? true,
		hasPendingMessages: () => {
			const counts = live.counts ?? { steering: 0, followUp: 0, nextTurn: 0 };
			return counts.steering + counts.followUp + counts.nextTurn > 0;
		},
		getPendingMessageCounts: () => live.counts ?? { steering: 0, followUp: 0, nextTurn: 0 },
		getTranscript: () => [
			{
				id: "entry-1",
				role: "assistant",
				textSummary: "Fixture transcript",
				ts: "2026-01-01T00:00:00.000Z",
				body: "Fixture transcript body",
			},
		],
		getTranscriptBody: (entryId: string) => (entryId === "entry-1" ? "Fixture transcript body" : undefined),
		getGoalState: () => ({ enabled: true, goal: { id: "goal-1", objective: "Fixture goal", status: "active" } }),
		getTodoState: () => [{ name: "Fixture", tasks: [{ content: "Fixture todo", status: "pending" }] }],
		getQueuedMessages: () => [{ id: "queue-1", text: "Fixture queued", mode: "followUp" }],
		cycleModel: async () => ({ model: { id: "fixture-model" }, thinkingLevel: "low" }),
		cycleThinkingLevel: () => "high",
		setQueueMode: (queue: string, mode: unknown) =>
			(queue === "steering" && mode === "all") ||
			(queue === "follow_up" && mode === "one-at-a-time") ||
			(queue === "interrupt" && mode === "wait"),
		getSkillState: () => [{ name: "fixture-skill" }],
		getConfigItems: () => [{ key: "fixture.config", value: true }],
		getBranchCandidates: () => [{ id: "branch-1" }],
		getExtensions: () => [{ path: "fixture-extension" }],
		getArtifact: () => undefined,
		getJobs: () => undefined,
		sdkBindings: () => [
			"cycleModel",
			"cycleThinkingLevel",
			"setQueueMode",
			"getSkillState",
			"getConfigItems",
			"getBranchCandidates",
			"getExtensions",
		],
		clearContext: async () => true,
	};
}

test("SDK broker registration records an absolute lifecycle scope", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-locator-"));
	const cwd = path.relative(process.cwd(), root);
	const agentDir = path.join(root, "agent");
	const sessionId = `locator-${Date.now()}`;
	dirs.push(root);
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId), {
		get: () => undefined,
		getAgentDir: () => agentDir,
	} as unknown as Settings);
	try {
		await waitFor(
			() => fs.existsSync(path.join(agentDir, "sdk", "sessions", "index.jsonl")),
			"SDK broker registration",
		);
		const sessions = (await new SessionIndex(agentDir).open()).listSessions().sessions;
		expect(sessions).toContainEqual(
			expect.objectContaining({ sessionId, locator: expect.objectContaining({ repo: path.resolve(cwd) }) }),
		);
	} finally {
		await brokerOwnerForTest(agentDir)?.stop();
	}
});

test("ExtensionRunner forwards SDK permission providers into its production context", () => {
	let installed: SdkPermissionProvider;

	const runner = new ExtensionRunner([], {} as never, process.cwd(), {} as never, {} as never);
	runner.initialize(
		{} as ExtensionActions,
		{
			setSdkPermissionProvider: provider => {
				installed = provider;
			},
		} as ExtensionContextActions,
	);
	const provider = async (): Promise<ClientBridgePermissionOutcome> => ({ outcome: "cancelled" });
	runner.createContext().setSdkPermissionProvider?.(provider);
	expect(installed === provider).toBe(true);
});

test("interactive extension context advertises typed SDK controls and forwards permission providers", async () => {
	let contextActions: ExtensionContextActions | undefined;
	let installed: SdkPermissionProvider;

	let mode: "prompt" | "allow" | "deny" = "prompt";
	const runner = {
		initialize(
			_actions: ExtensionActions,
			actions: ExtensionContextActions,
			_commands: unknown,
			_ui: ExtensionUIContext,
		): void {
			contextActions = actions;
		},
	};
	const controller = new ExtensionUiController({
		session: {
			extensionRunner: runner,
			setSdkPermissionProvider: (provider: typeof installed) => {
				installed = provider;
			},
			setSdkPermissionMode: (next: typeof mode) => {
				mode = next;
			},
			get sdkPermissionMode() {
				return mode;
			},
		},
	} as unknown as InteractiveModeContext);
	controller.initializeHookRunner({} as ExtensionUIContext, false);
	const provider = async (): Promise<ClientBridgePermissionOutcome> => ({ outcome: "cancelled" });
	contextActions?.setSdkPermissionProvider?.(provider);
	expect(installed === provider).toBe(true);
	expect(await contextActions?.sdkControl?.("permission_mode.set", { mode: "deny" })).toEqual({
		changed: true,
		mode: "deny",
	});
});

test("SDK host replays event frames over direct v3 ingress and routes queries through the v2 control-command seam", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-"));
	dirs.push(cwd);
	const sessionId = `sdk-${Date.now()}`;
	process.env.GJC_NOTIFICATIONS = "1";
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const sessionContext = context(cwd, sessionId);
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	void handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	socket.send(JSON.stringify({ type: "event_replay", id: "replay-1", sinceGeneration: 1, sinceSeq: 0 }));
	await waitFor(
		() => frames.some(frame => frame.type === "event_replay_result" && frame.id === "replay-1"),
		"event replay response",
	);
	const replay = frames.find(frame => frame.type === "event_replay_result" && frame.id === "replay-1");
	expect(replay).toMatchObject({ type: "event_replay_result", id: "replay-1", ok: true, generation: 1 });
	const replayEvents = replay?.events as Array<Record<string, unknown>>;
	expect(replayEvents.length).toBeGreaterThanOrEqual(4);
	expect(replayEvents.map(event => event.seq)).toEqual(replayEvents.map((_event, index) => index + 1));
	expect(replayEvents).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
			expect.objectContaining({ payload: expect.objectContaining({ type: "identity_header", sessionId }) }),
			expect.objectContaining({ payload: expect.objectContaining({ type: "activity", sessionId, state: "busy" }) }),
			expect.objectContaining({ payload: expect.objectContaining({ type: "activity", sessionId, state: "idle" }) }),
		]),
	);
	await Bun.sleep(100);
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "q1",
			command: { type: "query_request", id: "q1", query: "session.metadata" },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "q1" && frame.status === "ok",
			),
		"query response",
	);
	const query = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "q1" && frame.status === "ok",
			)?.message,
		),
	);
	expect(query).toMatchObject({ type: "query_response", id: "q1", ok: true, page: { items: [{ sessionId }] } });
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "q2",
			command: { type: "query_request", id: "q2", query: "usage.get" },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "q2" && frame.status === "ok",
			),
		"usage response",
	);
	const usage = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "q2" && frame.status === "ok",
			)?.message,
		),
	);
	expect(usage).toMatchObject({
		type: "query_response",
		id: "q2",
		ok: true,
		page: { items: [{ input: 1, output: 2 }] },
	});

	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "q3",
			command: { type: "query_request", id: "q3", query: "transcript.list" },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "q3" && frame.status === "ok",
			),
		"transcript response",
	);
	const transcript = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "q3" && frame.status === "ok",
			)?.message,
		),
	);
	expect(transcript).toMatchObject({
		type: "query_response",
		id: "q3",
		ok: true,
		page: { items: [{ id: "entry-1", role: "assistant", textSummary: "Fixture transcript" }] },
	});
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "c1",
			command: { type: "control_request", id: "c1", operation: "not.real", input: {} },
		}),
	);
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "c1" && frame.status === "ok",
			),
		"control response",
	);
	const control = JSON.parse(
		String(
			frames.find(
				frame => frame.type === "control_command_result" && frame.requestId === "c1" && frame.status === "ok",
			)?.message,
		),
	);
	expect(control).toMatchObject({
		type: "control_response",
		id: "c1",
		ok: false,
		error: { code: "unknown_operation" },
	});
});

test("SDK host binds session query and control seams and excludes uninstalled resources", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-bindings-"));
	dirs.push(cwd);
	const sessionId = `sdk-bindings-${Date.now()}`;
	start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (requestId: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId, command }));
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === requestId),
			`${requestId} response`,
		);
		return JSON.parse(
			String(
				frames.find(frame => frame.type === "control_command_result" && frame.requestId === requestId)?.message,
			),
		) as Record<string, unknown>;
	};
	for (const [query, expected] of [
		["Q11", { name: "fixture-skill" }],
		["Q13", { key: "fixture.config" }],
		["Q16", { id: "branch-1" }],
		["Q22", { path: "fixture-extension" }],
	] as const) {
		const response = await request(`query-${query}`, { type: "query_request", id: `query-${query}`, query });
		expect(response).toMatchObject({ ok: true, page: { items: [expect.objectContaining(expected)] } });
	}
	for (const [operation, input, confirm] of [
		["model.cycle", {}, false],
		["thinking.cycle", {}, false],
		["queue.steering_mode.set", { mode: "all" }, false],
		["context.clear", {}, true],
	] as const) {
		const response = await request(`control-${operation}`, {
			type: "control_request",
			id: `control-${operation}`,
			operation,
			input,
			...(confirm ? { confirm } : {}),
		});
		expect(response).toMatchObject({ ok: true });
	}
	const capabilities = await request("capabilities", {
		type: "query_request",
		id: "capabilities",
		query: "runtime.capabilities",
	});
	expect(capabilities).toMatchObject({
		ok: true,
		page: { items: [expect.objectContaining({ operations: expect.arrayContaining(["config.patch"]) })] },
	});

	for (const query of ["Q24", "Q25"]) {
		const response = await request(`excluded-${query}`, {
			type: "query_request",
			id: `excluded-${query}`,
			query,
			input: { artifactId: "missing" },
		});
		expect(response).toMatchObject({ ok: false, error: { code: "resource_gone" } });
	}
});

test("SDK host routes pure ACP permission prompts through a live reverse provider", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-permission-provider-"));
	dirs.push(cwd);
	const sessionId = `sdk-permission-provider-${Date.now()}`;
	let permissionProvider:
		| ((
				toolCall: ClientBridgePermissionToolCall,
				options: ClientBridgePermissionOption[],
				signal?: AbortSignal,
		  ) => Promise<ClientBridgePermissionOutcome>)
		| undefined;
	const ctx = {
		...context(cwd, sessionId),
		setSdkPermissionProvider: (provider: typeof permissionProvider) => {
			permissionProvider = provider;
		},
	};
	process.env.GJC_NOTIFICATIONS = "1";
	start(ctx);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	await waitFor(() => frames.some(frame => frame.type === "hello"), "SDK hello");
	const connectionId = String(frames.find(frame => frame.type === "hello")?.connectionId);
	socket.send(
		JSON.stringify({
			type: "register_provider",
			id: "permission",
			connectionId,
			capability: "permission",
			definitions: [],
		}),
	);
	await waitFor(() => permissionProvider !== undefined, "permission provider installation");
	const requested = permissionProvider!(
		{ toolCallId: "call-1", toolName: "bash", title: "printf guarded", status: "pending" },
		[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
	);
	await waitFor(() => frames.some(frame => frame.type === "reverse_request"), "reverse permission request");
	const request = frames.find(frame => frame.type === "reverse_request")!;
	socket.send(
		JSON.stringify({
			type: "reverse_response",
			id: request.id,
			connectionId,
			leaseId: request.leaseId,
			ok: true,
			result: { outcome: "selected", optionId: "allow_once", kind: "allow_once" },
		}),
	);
	expect(await requested).toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
	socket.close();
	await waitFor(() => permissionProvider === undefined, "permission provider removal after disconnect");
});

test("rejects malformed provider definitions without replacing a valid tools registry", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-provider-validation-"));
	dirs.push(cwd);
	const sessionId = `sdk-provider-validation-${Date.now()}`;
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	await waitFor(() => frames.some(frame => frame.type === "hello"), "SDK hello");
	const hello = frames.find(frame => frame.type === "hello")!;
	const connectionId = String(hello.connectionId);
	const sendProvider = (id: string, capability: string, definitions: unknown) =>
		socket.send(JSON.stringify({ type: "register_provider", id, connectionId, capability, definitions }));

	const validTool = { name: "host_read", description: "Read a host file.", parameters: {} };
	sendProvider("valid-tool", "host_tools", [validTool]);
	await waitFor(() => frames.some(frame => frame.type === "register_provider_result"), "valid tools registration");
	sendProvider("invalid-tool", "host_tools", [{ name: "", description: "missing name", parameters: {} }]);
	await waitFor(
		() => frames.some(frame => frame.type === "reverse_response" && frame.id === "invalid-tool"),
		"invalid tools rejection",
	);
	expect(frames.find(frame => frame.type === "reverse_response" && frame.id === "invalid-tool")).toMatchObject({
		ok: false,
		error: { code: "invalid_input" },
	});

	sendProvider("valid-uri", "host_uri", [{ scheme: "workspace+local" }]);
	await waitFor(
		() => frames.filter(frame => frame.type === "register_provider_result").length === 2,
		"valid URI registration",
	);
	sendProvider("invalid-uri", "host_uri", [{ scheme: "https" }]);
	await waitFor(
		() => frames.some(frame => frame.type === "reverse_response" && frame.id === "invalid-uri"),
		"invalid URI rejection",
	);
	expect(frames.find(frame => frame.type === "reverse_response" && frame.id === "invalid-uri")).toMatchObject({
		ok: false,
		error: { code: "invalid_input" },
	});

	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "tools",
			command: { type: "query_request", id: "tools", query: "tools.list" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === "tools"),
		"tools query",
	);
	const tools = JSON.parse(
		String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === "tools")?.message),
	);
	expect(tools).toMatchObject({ ok: true, page: { items: [validTool] } });
});

test("SDK host replay gaps are generation-scoped and sequence gaps remain coherent", async () => {
	let receive!: (connectionId: string, frame: Record<string, unknown>) => void;
	const sent: Array<Record<string, unknown>> = [];
	const host = new SessionSdkHost({
		sessionId: "replay-gaps",
		stateRoot: "/tmp/replay-gaps",
		token: "test-token",
		sendFrame: (_connectionId, frame) => {
			sent.push(frame);
		},
		onFrame: handler => {
			receive = handler;
			return () => {};
		},
	});
	await host.start();
	const replay = (id: string, sinceGeneration: number, sinceSeq: number) => {
		receive("client", { type: "event_replay", id, sinceGeneration, sinceSeq });
	};

	replay("normal", host.generation, 0);
	await waitFor(() => sent.some(frame => frame.id === "normal"), "normal replay");
	expect(sent.find(frame => frame.id === "normal")).toMatchObject({
		ok: true,
		events: [{ type: "event", name: "session_ready", seq: 1 }],
	});

	const previousGeneration = host.generation;
	host.events.restart();
	host.emitEvent({ name: "after_restart" });
	replay("reset", previousGeneration, 1);
	await waitFor(() => sent.some(frame => frame.id === "reset"), "generation reset replay");
	expect(sent.find(frame => frame.id === "reset")).toMatchObject({
		ok: true,
		generation: previousGeneration + 1,
		events: [{ type: "event", name: "after_restart", seq: 1 }],
		gap: {
			kind: "generation_reset",
			fromGeneration: previousGeneration,
			toGeneration: previousGeneration + 1,
			resyncQueries: ["Q01", "Q02", "Q03"],
		},
	});

	for (let index = 0; index < 256; index++) host.emitEvent({ name: `overflow-${index}` });
	replay("overflow", host.generation, 0);
	await waitFor(() => sent.some(frame => frame.id === "overflow"), "sequence gap replay");
	const overflow = sent.find(frame => frame.id === "overflow")!;
	expect(overflow).toMatchObject({
		ok: true,
		gap: { kind: "sequence_gap", fromSeq: 1, toSeq: 1, resyncQueries: ["Q01", "Q02", "Q03"] },
	});
	const gap = overflow.gap as { fromSeq: number; toSeq: number };
	expect(gap.fromSeq).toBeLessThanOrEqual(gap.toSeq);
	await host.stop();
});

test("Q17 returns resource_gone before the host has an assistant message and returns it after", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-last-assistant-"));
	dirs.push(cwd);
	const sessionId = `sdk-q17-${Date.now()}`;
	let lastAssistant: string | undefined;
	start({
		...context(cwd, sessionId),
		sessionManager: {
			...(context(cwd, sessionId).sessionManager as object),
			getLastAssistantText: () => lastAssistant,
		},
	});
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const query = (requestId: string) =>
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId,
				command: { type: "query_request", id: requestId, query: "Q17" },
			}),
		);
	query("before");
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "before" && frame.status === "ok",
			),
		"empty Q17 response",
	);
	expect(
		JSON.parse(
			String(
				frames.find(
					frame =>
						frame.type === "control_command_result" && frame.requestId === "before" && frame.status === "ok",
				)?.message,
			),
		),
	).toMatchObject({ ok: false, error: { code: "resource_gone" } });
	lastAssistant = "Assistant reply";
	query("after");
	await waitFor(
		() =>
			frames.some(
				frame => frame.type === "control_command_result" && frame.requestId === "after" && frame.status === "ok",
			),
		"message Q17 response",
	);
	expect(
		JSON.parse(
			String(
				frames.find(
					frame => frame.type === "control_command_result" && frame.requestId === "after" && frame.status === "ok",
				)?.message,
			),
		),
	).toMatchObject({ ok: true, page: { items: ["Assistant reply"] } });
});

test("terminal shutdown removes session snapshot spills", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-snapshots-"));
	dirs.push(cwd);
	const sessionId = `snapshots-${Date.now()}`;
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "snapshot-query",
			command: { type: "query_request", id: "snapshot-query", query: "Q01" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === "snapshot-query"),
		"snapshot query response",
	);
	const snapshotDirectory = path.join(cwd, ".gjc", "state", "sdk", "snapshots", sessionId);
	await waitFor(() => fs.existsSync(snapshotDirectory), "snapshot spill");
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(cwd, sessionId));
	await waitFor(() => !fs.existsSync(snapshotDirectory), "snapshot spill removal");
});

test("diff queries return typed errors outside a Git working tree", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-no-git-"));
	dirs.push(cwd);
	const sessionId = `no-git-${Date.now()}`;
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	for (const query of ["Q06", "Q07", "Q08"]) {
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId: query,
				command: { type: "query_request", id: query, query },
			}),
		);
	}
	await waitFor(
		() =>
			["Q06", "Q07", "Q08"].every(query =>
				frames.some(frame => frame.type === "control_command_result" && frame.requestId === query),
			),
		"typed diff responses",
	);
	for (const query of ["Q06", "Q07", "Q08"]) {
		const message = frames.find(
			frame => frame.type === "control_command_result" && frame.requestId === query,
		)?.message;
		expect(JSON.parse(String(message))).toMatchObject({ ok: false, error: { code: "not_git_repository" } });
	}
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("diff queries return a bounded error for oversized diffs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-large-diff-"));
	dirs.push(cwd);
	for (const args of [
		["init", "-q"],
		["config", "user.email", "test@example.com"],
		["config", "user.name", "Test"],
	]) {
		expect(Bun.spawnSync(["git", ...args], { cwd }).exitCode).toBe(0);
	}
	fs.writeFileSync(path.join(cwd, "large.txt"), "seed\n");
	expect(Bun.spawnSync(["git", "add", "large.txt"], { cwd }).exitCode).toBe(0);
	expect(Bun.spawnSync(["git", "commit", "-qm", "seed"], { cwd }).exitCode).toBe(0);
	fs.writeFileSync(path.join(cwd, "large.txt"), "x".repeat(1024 * 1024 + 1));
	const sessionId = `large-diff-${Date.now()}`;
	const handlers = start(context(cwd, sessionId));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	socket.send(
		JSON.stringify({
			type: "control_command",
			sessionId,
			token: endpoint.token,
			requestId: "large-diff",
			command: { type: "query_request", id: "large-diff", query: "Q06" },
		}),
	);
	await waitFor(
		() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === "large-diff"),
		"bounded diff response",
	);
	const message = frames.find(
		frame => frame.type === "control_command_result" && frame.requestId === "large-diff",
	)?.message;
	expect(JSON.parse(String(message))).toMatchObject({ ok: false, error: { code: "diff_too_large" } });
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, context(cwd, sessionId));
});

test("SDK host honors disable opt-out and excludes subagent sessions", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-gate-"));
	dirs.push(cwd);
	process.env.GJC_SDK_DISABLE = "1";
	start(context(cwd, "disabled"));
	await Bun.sleep(100);
	expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", "disabled.json"))).toBe(false);
	delete process.env.GJC_SDK_DISABLE;
	start(context(cwd, "subagent", "sub"));
	await Bun.sleep(100);
	expect(fs.existsSync(path.join(cwd, ".gjc", "state", "sdk", "subagent.json"))).toBe(false);
});

test("context.get reports live streaming state and typed queue depths without notifications", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-live-"));
	dirs.push(cwd);
	const sessionId = `live-${Date.now()}`;
	// Notifications intentionally NOT configured: SDK-only hosting.
	const live: { idle?: boolean; counts?: { steering: number; followUp: number; nextTurn: number } } = {};
	const handlers = start(context(cwd, sessionId, "main", live));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	await Bun.sleep(100);
	const queryContext = async (requestId: string): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({
				type: "control_command",
				sessionId,
				token: endpoint.token,
				requestId,
				command: { type: "query_request", id: requestId, query: "context.get" },
			}),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === requestId),
			`context response ${requestId}`,
		);
		const message = frames.find(
			frame => frame.type === "control_command_result" && frame.requestId === requestId,
		)?.message;
		const parsed = JSON.parse(String(message)) as { page: { items: Record<string, unknown>[] } };
		return parsed.page.items[0] as Record<string, unknown>;
	};

	// Idle, empty queues.
	const idle = await queryContext("ctx-idle");
	expect(idle).toMatchObject({ isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 });

	// Streaming via agent_start (notifications off — rt.busy must still track).
	const sessionContext = context(cwd, sessionId, "main", live);
	void handlers.get("agent_start")?.({ type: "agent_start" }, sessionContext);
	const streaming = await queryContext("ctx-streaming");
	expect(streaming).toMatchObject({ isStreaming: true });

	// Typed queue depths straight from the counted seam.
	live.counts = { steering: 2, followUp: 1, nextTurn: 3 };
	const queued = await queryContext("ctx-queued");
	expect(queued).toMatchObject({ steeringQueueDepth: 2, followupQueueDepth: 1 });

	// Settled via agent_end.
	void handlers.get("agent_end")?.({ type: "agent_end" }, sessionContext);
	live.counts = { steering: 0, followUp: 0, nextTurn: 0 };
	const settled = await queryContext("ctx-settled");
	expect(settled).toMatchObject({ isStreaming: false, steeringQueueDepth: 0, followupQueueDepth: 0 });
});

test("SDK endpoint applies typed skill, plan, goal, and config controls with observable readback", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-typed-controls-"));
	dirs.push(cwd);
	const sessionId = `typed-controls-${Date.now()}`;
	let plan: { enabled: boolean; planFilePath: string } | undefined;
	let goal: { enabled: boolean; goal: { objective: string; status: string } } | undefined;
	const activeSkills: Array<{ name: string; args?: string }> = [];
	const ctx = {
		...context(cwd, sessionId),
		getSkillState: () => activeSkills,
		getGoalState: () => goal,
		invokeSkill: async (name: string, args?: string) => {
			if (name !== "fixture-skill")
				throw Object.assign(new Error(`Skill ${name} was not found.`), { code: "invalid_input" });
			activeSkills.push({ name, args });
			return { name, args };
		},
		setPlanMode: (on: boolean) => {
			plan = on ? { enabled: true, planFilePath: "local://PLAN.md" } : undefined;
			return plan;
		},
		operateGoal: async (op: string, objective?: string) => {
			if (op === "create") {
				goal = { enabled: true, goal: { objective: objective ?? "", status: "active" } };
				return goal;
			}
			if (op === "get") return goal;
			throw Object.assign(new Error(`Unsupported goal op ${op}.`), { code: "invalid_input" });
		},
		sdkBindings: () => [
			"cycleModel",
			"cycleThinkingLevel",
			"setQueueMode",
			"getSkillState",
			"getConfigItems",
			"getBranchCandidates",
			"getExtensions",
			"invokeSkill",
			"setPlanMode",
			"operateGoal",
		],
	};
	const configWrites: Array<[string, unknown]> = [];
	const settings = {
		get: () => undefined,
		set: (key: string, value: unknown) => configWrites.push([key, value]),
	} as unknown as Settings;

	process.env.GJC_NOTIFICATIONS = "1";
	start(ctx, settings);

	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (id: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId: id, command }),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === id),
			`${id} response`,
		);
		return JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === id)?.message),
		) as Record<string, unknown>;
	};
	expect(
		await request("skill", {
			type: "control_request",
			id: "skill",
			operation: "skill.invoke",
			input: { name: "fixture-skill", args: "run" },
		}),
	).toMatchObject({ ok: true });
	expect(await request("q11", { type: "query_request", id: "q11", query: "Q11" })).toMatchObject({
		ok: true,
		page: { items: [{ name: "fixture-skill", args: "run" }] },
	});
	expect(
		await request("plan", { type: "control_request", id: "plan", operation: "mode.plan.set", input: { on: true } }),
	).toMatchObject({ ok: true, result: { state: { enabled: true, planFilePath: "local://PLAN.md" } } });
	expect(
		await request("goal", {
			type: "control_request",
			id: "goal",
			operation: "mode.goal.operate",
			input: { op: "create", objective: "Ship it" },
		}),
	).toMatchObject({ ok: true });
	expect(await request("q04", { type: "query_request", id: "q04", query: "Q04" })).toMatchObject({
		ok: true,
		page: { items: [{ enabled: true, goal: { objective: "Ship it", status: "active" } }] },
	});

	expect(
		await request("skill-error", {
			type: "control_request",
			id: "skill-error",
			operation: "skill.invoke",
			input: { name: "missing" },
		}),
	).toEqual({
		type: "control_response",
		id: "skill-error",
		ok: false,
		error: { code: "invalid_input", message: "Skill missing was not found." },
	});
	expect(
		await request("secret-error", {
			type: "control_request",
			id: "secret-error",
			operation: "config.patch",
			input: { patch: { apiToken: "secret" } },
		}),
	).toEqual({
		type: "control_response",
		id: "secret-error",
		ok: false,
		error: { code: "invalid_input", message: "config.patch rejects secret fields at the SDK host." },
	});
	expect(
		await request("nested-secret-error", {
			type: "control_request",
			id: "nested-secret-error",
			operation: "config.patch",
			input: { patch: { theme: "dark", display: { credentials: { apiKey: "secret" } } } },
		}),
	).toEqual({
		type: "control_response",
		id: "nested-secret-error",
		ok: false,
		error: { code: "invalid_input", message: "config.patch rejects secret fields at the SDK host." },
	});
	expect(configWrites).toEqual([]);
});

test("SDK host discovers, answers, and advances a durable workflow gate", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-workflow-gate-"));
	dirs.push(cwd);
	const sessionId = `workflow-gate-${Date.now()}`;
	const emitter = new BrokerWorkflowGateEmitter(
		sessionId,
		new FileGateStore(path.join(cwd, ".gjc", "state", "workflow-gates.json")),
	);
	process.env.GJC_NOTIFICATIONS = "1";
	start(context(cwd, sessionId, "main", {}, emitter));
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	const frames: Record<string, unknown>[] = [];
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (id: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId: id, command }),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === id),
			`${id} response`,
		);
		return JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === id)?.message),
		) as Record<string, unknown>;
	};
	let gateId = "";
	emitter.onGateEmitted!(gate => {
		gateId = gate.gate_id;
	});
	const advance = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
	});
	await waitFor(() => gateId !== "", "workflow gate");
	expect(await request("gates", { type: "query_request", id: "gates", query: "Q12" })).toMatchObject({
		ok: true,
		page: { items: [{ gate_id: gateId }] },
	});
	expect(
		await request("answer", {
			type: "control_request",
			id: "answer",
			operation: "workflow.gate_answer",
			input: { id: gateId, response: "approve" },
		}),
	).toMatchObject({ ok: true, result: { status: "accepted" } });
	expect(await advance).toBe("approve");
});

test("AC2/AC8: SDK host completes successful session mutations over its live WebSocket", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-host-successful-verbs-"));
	dirs.push(cwd);
	const sessionId = `successful-verbs-${Date.now()}`;
	const emitter = new BrokerWorkflowGateEmitter(
		sessionId,
		new FileGateStore(path.join(cwd, ".gjc", "state", "workflow-gates.json")),
	);
	const emittedGates: Array<{ gate_id: string; kind: string }> = [];
	emitter.onGateEmitted!(gate => emittedGates.push(gate));
	let compactions = 0;
	const configWrites: Array<[string, unknown]> = [];
	const settings = {
		get: () => undefined,
		set: (key: string, value: unknown) => configWrites.push([key, value]),
	} as unknown as Settings;
	const ctx = {
		...context(cwd, sessionId, "main", {}, emitter),
		compact: async () => {
			compactions++;
		},
		getConfigItems: () => ({ "ui.theme": "light" }),
	};
	process.env.GJC_NOTIFICATIONS = "1";
	start(ctx, settings);
	const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${sessionId}.json`);
	await waitFor(() => fs.existsSync(endpointFile), "SDK endpoint");
	const endpoint = JSON.parse(fs.readFileSync(endpointFile, "utf8")) as { url: string; token: string };
	const frames: Record<string, unknown>[] = [];
	const socket = new WebSocket(`${endpoint.url}/?token=${encodeURIComponent(endpoint.token)}`);
	sockets.push(socket);
	socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WS error")), { once: true });
	});
	const request = async (id: string, command: Record<string, unknown>): Promise<Record<string, unknown>> => {
		socket.send(
			JSON.stringify({ type: "control_command", sessionId, token: endpoint.token, requestId: id, command }),
		);
		await waitFor(
			() => frames.some(frame => frame.type === "control_command_result" && frame.requestId === id),
			`${id} response`,
		);
		return JSON.parse(
			String(frames.find(frame => frame.type === "control_command_result" && frame.requestId === id)?.message),
		) as Record<string, unknown>;
	};

	await waitFor(() => getAskAnswerSource(sessionId) !== undefined, "interactive ask source");
	const askAnswer = getAskAnswerSource(sessionId)!.awaitAnswer("Continue with the SDK host test?", [
		"continue",
		"stop",
	]);
	await waitFor(() => frames.some(frame => frame.type === "action_needed" && frame.kind === "ask"), "pending ask");
	const askId = String(frames.find(frame => frame.type === "action_needed" && frame.kind === "ask")?.id);
	expect(
		await request("ask-answer", {
			type: "control_request",
			id: "ask-answer",
			operation: "ask.answer",
			input: { id: askId, answer: 0 },
			idempotencyKey: "successful-verbs-ask-answer",
		}),
	).toEqual({ type: "control_response", id: "ask-answer", ok: true, result: { resolved: true } });
	expect(await askAnswer).toBe("continue");

	const questionAdvance = emitter.emitGate({
		stage: "deep-interview",
		kind: "question",
		schema: { type: "string", enum: ["continue"] },
	});
	await waitFor(() => emittedGates.some(gate => gate.kind === "question"), "pending question gate");
	const questionGateId = emittedGates.find(gate => gate.kind === "question")!.gate_id;
	expect(
		await request("gate-answer", {
			type: "control_request",
			id: "gate-answer",
			operation: "workflow.gate_answer",
			input: { id: questionGateId, response: "continue" },
			idempotencyKey: "successful-verbs-gate-answer",
		}),
	).toMatchObject({
		type: "control_response",
		id: "gate-answer",
		ok: true,
		result: { gate_id: questionGateId, status: "accepted" },
	});
	expect(await questionAdvance).toBe("continue");

	const approvalAdvance = emitter.emitGate({
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string", enum: ["approve"] },
	});
	await waitFor(() => emittedGates.some(gate => gate.kind === "approval"), "pending approval gate");
	const approvalGateId = emittedGates.find(gate => gate.kind === "approval")!.gate_id;
	expect(
		await request("plan-approve", {
			type: "control_request",
			id: "plan-approve",
			operation: "workflow.plan_approve",
			input: { id: approvalGateId, choice: "approve" },
			idempotencyKey: "successful-verbs-plan-approve",
		}),
	).toMatchObject({
		type: "control_response",
		id: "plan-approve",
		ok: true,
		result: { gate_id: approvalGateId, status: "accepted" },
	});
	expect(await approvalAdvance).toBe("approve");

	expect(
		await request("compaction", {
			type: "control_request",
			id: "compaction",
			operation: "compaction.run",
			input: {},
			idempotencyKey: "successful-verbs-compaction",
		}),
	).toEqual({ type: "control_response", id: "compaction", ok: true, result: { started: true } });
	expect(compactions).toBe(1);

	expect(
		await request("config-patch", {
			type: "control_request",
			id: "config-patch",
			operation: "config.patch",
			input: { patch: { "ui.theme": "dark" } },
			expectedRevision: "0",
			idempotencyKey: "successful-verbs-config-patch",
		}),
	).toEqual({
		type: "control_response",
		id: "config-patch",
		ok: true,
		result: { patched: ["ui.theme"], revision: "1" },
	});
	expect(configWrites).toEqual([["ui.theme", "dark"]]);
	expect(
		await request("config-readback", {
			type: "query_request",
			id: "config-readback",
			query: "config.list/get",
		}),
	).toMatchObject({
		type: "query_response",
		id: "config-readback",
		ok: true,
		page: { items: [{ "ui.theme": "dark" }] },
	});
});
