import { describe, expect, test } from "bun:test";
import {
	AppServerClient,
	AppServerResponseError,
	type ServerNotificationEnvelope,
	type GjcMonitorsListResult,
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
		const jobStatuses: string[] = [];

		client.onNotification("gjc/workflowGate/opened", params => gateIds.push(params.gate_id));
		client.onNotification("gjc/hostUris/request", params => hostUriRequests.push(params.requestId));
		client.onNotification("gjc/jobs/changed", params => jobStatuses.push(`${params.kind}:${params.id}:${params.status}`));

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
		socket.serverMessage({
			method: "gjc/jobs/changed",
			params: {
				threadId: "thread-1",
				generation: 1,
				kind: "job",
				id: "job-1",
				status: "running",
				description: "Build",
			},
		});

		expect(gateIds).toEqual(["gate-1"]);
		expect(hostUriRequests).toEqual(["request-1"]);
		expect(jobStatuses).toEqual(["job:job-1:running"]);
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
				call: () => client.gjcRetry({ threadId: "thread-1" }),
				method: "gjc/retry",
				params: { threadId: "thread-1" },
				result: { turnId: "turn-1" },
			},
			{
				call: () => client.gjcContextRead({ threadId: "thread-1" }),
				method: "gjc/context/read",
				params: { threadId: "thread-1" },
				result: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, contextWindow: 100, percentUsed: 10, source: "AgentSession.getSessionStats", freshness: "live" },
			},
			{
				call: () => client.gjcGoalRead({ threadId: "thread-1" }),
				method: "gjc/goal/read",
				params: { threadId: "thread-1" },
				result: { active: true, objective: "Ship", status: "active", tokensUsed: 12 },
			},
			{
				call: () => client.gjcModelCatalog({ threadId: "thread-1" }),
				method: "gjc/model/catalog",
				params: { threadId: "thread-1" },
				result: { models: [{ provider: "openai", modelId: "gpt-5", label: "GPT-5", available: true }], activeProvider: "openai", activeModelId: "gpt-5" },
			},
			{
				call: () => client.gjcThinkingRead({ threadId: "thread-1" }),
				method: "gjc/thinking/read",
				params: { threadId: "thread-1" },
				result: { level: "medium", levels: ["low", "medium", "high"] },
			},
			{
				call: () => client.gjcThinkingSet({ threadId: "thread-1", level: "high" }),
				method: "gjc/thinking/set",
				params: { threadId: "thread-1", level: "high" },
				result: { level: "high" },
			},
			{
				call: () => client.gjcFastRead({ threadId: "thread-1" }),
				method: "gjc/fast/read",
				params: { threadId: "thread-1" },
				result: { enabled: false, affectedRoles: ["default"] },
			},
			{
				call: () => client.gjcFastSet({ threadId: "thread-1", enabled: true }),
				method: "gjc/fast/set",
				params: { threadId: "thread-1", enabled: true },
				result: { enabled: true, affectedRoles: ["default"] },
			},
			{
				call: () => client.gjcSettingsSchema(),
				method: "gjc/settings/schema",
				params: {},
				result: { settings: [{ key: "autoResume", type: "boolean", default: false }] },
			},
			{
				call: () => client.gjcSettingsRead(),
				method: "gjc/settings/read",
				params: {},
				result: { values: { autoResume: false } },
			},
			{
				call: () => client.gjcSettingsUpdate({ key: "autoResume", value: true }),
				method: "gjc/settings/update",
				params: { key: "autoResume", value: true },
				result: { values: { autoResume: true } },
			},
			{
				call: () => client.gjcAppearanceThemesList(),
				method: "gjc/appearance/themes/list",
				params: {},
				result: { themes: [{ id: "붉은 집게 테마", kind: "dark", builtin: false, semanticPreview: { bg: "#140b0b", bgElevated: "#211111", surface: "#281616", text: "#f7e7df", textMuted: "#b68b7e", accent: "#ff5a3d", border: "#5a2c24", success: "#6dd17c", warning: "#f0b45a", danger: "#ff4f4f" } }] },
			},
			{
				call: () => client.gjcAppearanceRead(),
				method: "gjc/appearance/read",
				params: {},
				result: { dark: "red-claw", light: "warm-day", symbolPreset: "unicode", colorBlindMode: false },
			},
			{
				call: () => client.gjcAppearanceSet({ dark: "붉은 집게 테마", light: "warm-day", symbolPreset: "ascii", colorBlindMode: true }),
				method: "gjc/appearance/set",
				params: { dark: "붉은 집게 테마", light: "warm-day", symbolPreset: "ascii", colorBlindMode: true },
				result: { dark: "붉은 집게 테마", light: "warm-day", symbolPreset: "ascii", colorBlindMode: true },
			},
			{
				call: () => client.gjcSessionList({ scope: "all", limit: 1 }),
				method: "gjc/session/list",
				params: { scope: "all", limit: 1 },
				result: { sessions: [{ id: "s1", cwd: "/tmp/project", path: "/tmp/project/session.jsonl", modifiedAt: "2026-01-01T00:00:00.000Z", firstMessage: "hello", entryCount: 2 }], total: 1 },
			},
			{
				call: () => client.gjcSessionSearch({ query: "hello", scope: "cwd", limit: 5 }),
				method: "gjc/session/search",
				params: { query: "hello", scope: "cwd", limit: 5 },
				result: { sessions: [{ id: "s1", cwd: "/tmp/project", path: "/tmp/project/session.jsonl", modifiedAt: "2026-01-01T00:00:00.000Z", title: "Hello" }], total: 1 },
			},
			{
				call: () => client.gjcSessionTree({ threadId: "thread-1" }),
				method: "gjc/session/tree",
				params: { threadId: "thread-1" },
				result: { nodes: [{ id: "root", type: "message", preview: "hello", timestamp: "2026-01-01T00:00:00.000Z", active: true, children: [] }], activeLeafId: "root" },
			},
			{
				call: () => client.gjcSessionRename({ sessionPath: "/tmp/session.jsonl", title: "Renamed" }),
				method: "gjc/session/rename",
				params: { sessionPath: "/tmp/session.jsonl", title: "Renamed" },
				result: { ok: true, title: "Renamed" },
			},
			{
				call: () => client.gjcSessionOpen({ sessionPath: "/tmp/session.jsonl" }),
				method: "gjc/session/open",
				params: { sessionPath: "/tmp/session.jsonl" },
				result: { threadId: "thread-2", sessionMetadata: { cwd: "/tmp/project" }, resumed: true },
			},
			{
				call: () => client.gjcSessionDelete({ sessionPath: "/tmp/session.jsonl" }),
				method: "gjc/session/delete",
				params: { sessionPath: "/tmp/session.jsonl" },
				result: { ok: true },
			},
			{
				call: () => client.gjcSessionExport({ sessionPath: "/tmp/session.jsonl", format: "json", redact: true }),
				method: "gjc/session/export",
				params: { sessionPath: "/tmp/session.jsonl", format: "json", redact: true },
				result: { content: "{}", format: "json", provenance: { exportedAt: "2026-01-01T00:00:00.000Z", sessionId: "s1", sourcePath: "/tmp/session.jsonl", redacted: true, tool: "gjc-app-server" } },
			},
			{
				call: () => client.gjcSessionNavigate({ threadId: "thread-1", entryId: "entry-1", summarize: true }),
				method: "gjc/session/navigate",
				params: { threadId: "thread-1", entryId: "entry-1", summarize: true },
				result: { ok: true, activeLeafId: "entry-1" },
			},
			{
				call: () => client.gjcSessionLabel({ threadId: "thread-1", entryId: "entry-1", label: "Important" }),
				method: "gjc/session/label",
				params: { threadId: "thread-1", entryId: "entry-1", label: "Important" },
				result: { ok: true },
			},
			{
				call: () => client.gjcSessionMove({ threadId: "thread-1", targetCwd: "/tmp/next", dryRun: true }),
				method: "gjc/session/move",
				params: { threadId: "thread-1", targetCwd: "/tmp/next", dryRun: true },
				result: { dryRun: true, sourceSessionFile: "/tmp/a.jsonl", targetSessionFile: "/tmp/next/a.jsonl", artifactsDirs: [], crossDevice: false, conflicts: [] },
			},
			{
				call: () => client.gjcProviderList(),
				method: "gjc/provider/list",
				params: {},
				result: { providers: [{ id: "anthropic", name: "Anthropic", authKind: "oauth", authenticated: false }] },
			},
			{
				call: () => client.gjcAuthStatus(),
				method: "gjc/auth/status",
				params: {},
				result: { providers: [{ providerId: "anthropic", state: "unauthenticated" }] },
			},
			{
				call: () => client.gjcAuthLogout({ providerId: "anthropic" }),
				method: "gjc/auth/logout",
				params: { providerId: "anthropic" },
				result: { providerId: "anthropic", authenticated: false },
			},
			{
				call: () => client.gjcProviderAdd({ compatibility: "openai", providerId: "local", baseUrl: "http://localhost:1234", apiKeyEnv: "LOCAL_API_KEY", models: ["m"] }),
				method: "gjc/provider/add",
				params: { compatibility: "openai", providerId: "local", baseUrl: "http://localhost:1234", apiKeyEnv: "LOCAL_API_KEY", models: ["m"] },
				result: { ok: true, providerId: "local", models: ["m"] },
			},
			{ call: () => client.gjcAuthLoginStart({ providerId: "anthropic" }), method: "gjc/auth/login/start", params: { providerId: "anthropic" }, result: { flowId: "flow-1", state: "pending-browser", authUrl: "https://example.test/auth" } },
			{ call: () => client.gjcAuthLoginPoll({ flowId: "flow-1" }), method: "gjc/auth/login/poll", params: { flowId: "flow-1" }, result: { state: "needs-input", promptMessage: "Paste redirect URL" } },
			{ call: () => client.gjcAuthLoginComplete({ flowId: "flow-1", redirectUrl: "http://localhost/callback" }), method: "gjc/auth/login/complete", params: { flowId: "flow-1", redirectUrl: "http://localhost/callback" }, result: { state: "authenticated" } },
			{ call: () => client.gjcAuthLoginCancel({ flowId: "flow-1" }), method: "gjc/auth/login/cancel", params: { flowId: "flow-1" }, result: { state: "cancelled" } },
			{
				call: () => client.gjcCommandsList({ threadId: "thread-1", includeDisabled: true }),
				method: "gjc/commands/list",
				params: { threadId: "thread-1", includeDisabled: true },
				result: { commands: [{ name: "/help", source: "builtin", description: "Show help", classification: "prompt-display-only" }] },
			},
			{
				call: () => client.gjcSkillsList({ threadId: "thread-1" }),
				method: "gjc/skills/list",
				params: { threadId: "thread-1" },
				result: { skills: [{ name: "ralplan", source: "builtin", description: "Plan", enabled: true }] },
			},
			{ call: () => client.gjcSkillsSetEnabled({ skillId: "ralplan", enabled: false }), method: "gjc/skills/setEnabled", params: { skillId: "ralplan", enabled: false }, result: { ok: true, enabled: false } },
			{
				call: () => client.gjcExtensionsList({ threadId: "thread-1" }),
				method: "gjc/extensions/list",
				params: { threadId: "thread-1" },
				result: { extensions: [{ id: "gemini", name: "Gemini", kind: "extension", source: "project", status: "available", state: "shadowed", disabledReason: "shadowed", shadowedBy: "native:gemini", provider: "gjc" }] },
			},
			{
				call: () => client.gjcExtensionsInspect({ threadId: "thread-1", extensionId: "gemini" }),
				method: "gjc/extensions/inspect",
				params: { threadId: "thread-1", extensionId: "gemini" },
				result: { extension: { id: "gemini", name: "Gemini", kind: "extension", source: "project", status: "available", state: "active", provider: "gjc" } },
			},
			{ call: () => client.gjcExtensionsSetEnabled({ extensionId: "gemini", enabled: false }), method: "gjc/extensions/setEnabled", params: { extensionId: "gemini", enabled: false }, result: { ok: true, enabled: false } },
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
			{ call: () => client.gjcPluginsSetEnabled({ pluginId: "pkg", enabled: false }), method: "gjc/plugins/setEnabled", params: { pluginId: "pkg", enabled: false }, result: { ok: true, enabled: false } },
			{ call: () => client.gjcPluginsSetFeature({ pluginId: "pkg", feature: "f", enabled: true }), method: "gjc/plugins/setFeature", params: { pluginId: "pkg", feature: "f", enabled: true }, result: { ok: true } },
			{ call: () => client.gjcPluginsSetSetting({ pluginId: "pkg", key: "secretToken", value: "stored" }), method: "gjc/plugins/setSetting", params: { pluginId: "pkg", key: "secretToken", value: "stored" }, result: { ok: true } },
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
			{ call: () => client.gjcModelAssign({ threadId: "thr_1", role: "main", provider: "openai", modelId: "gpt-4.1", thinkingLevel: "high" }), method: "gjc/model/assign", params: { threadId: "thr_1", role: "main", provider: "openai", modelId: "gpt-4.1", thinkingLevel: "high" }, result: { ok: true, role: "main", modelId: "gpt-4.1" } },
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
	const monitorsResult: GjcMonitorsListResult = {
		monitors: [{ id: "monitor-1", status: "running", outputTail: "latest line" }],
		crons: [
			{
				id: "cron-1",
				humanSchedule: "hourly",
				cronExpression: "0 * * * *",
				prompt: "ping",
				recurring: true,
				nextFireAt: "2026-01-01T01:00:00Z",
				createdAt: "2026-01-01T00:00:00Z",
			},
		],
	};
	const outputTail: string | null | undefined = monitorsResult.monitors[0]?.outputTail;
	const cronPrompt: string | null | undefined = monitorsResult.crons?.[0]?.prompt;
	void outputTail;
	void cronPrompt;
	// @ts-expect-error threadId is required for turn/start.
	void client.turnStart({ prompt: "missing thread" });
	// @ts-expect-error modelId is required for gjc/model/set.
	void client.gjcModelSet({ threadId: "thread-1", provider: "openai" });
}
void compileChecks;
