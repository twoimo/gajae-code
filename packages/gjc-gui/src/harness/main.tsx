import {
	AppServerClient,
	type GjcAppearanceReadResult,
	type GjcAppearanceThemesListResult,
	type GjcAuthLoginFlowState,
	type GjcAuthStatusResult,
	type GjcExtensionsListResult,
	type GjcPluginsInspectResult,
	type GjcPluginsListResult,
	type GjcProviderAddParams,
	type GjcProviderListResult,
	type GjcSessionListParams,
	type GjcSessionListResult,
	type GjcSessionSearchParams,
	type GjcSkillsListResult,
	type JsonValue,
	type ServerNotificationEnvelope,
	type ServerNotificationMap,
	type ServerNotificationMethod,
	type ThreadSummary,
} from "@gajae-code/app-server-client";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { type AppHostDeps, createApp } from "../app/main.tsx";

export type HarnessScenario =
	| "happy"
	| "failure"
	| "server-unavailable"
	| "token-rejected"
	| "inspect-error"
	| "scratch"
	| "clipboard-error";

export const HARNESS_CLIENT_METHODS = [
	"connect",
	"initialize",
	"notify",
	"onNotification",
	"close",
	"threadStart",
	"threadResume",
	"threadRead",
	"threadLoadedList",
	"threadFork",
	"threadArchive",
	"threadDelete",
	"turnStart",
	"turnInterrupt",
	"gjcStateRead",
	"gjcCommandsList",
	"gjcToolsList",
	"gjcSkillsList",
	"gjcSkillsSetEnabled",
	"gjcExtensionsList",
	"gjcExtensionsInspect",
	"gjcExtensionsSetEnabled",
	"gjcPluginsList",
	"gjcPluginsInspect",
	"gjcPluginsSetEnabled",
	"gjcPluginsSetFeature",
	"gjcPluginsSetSetting",
	"gjcAppearanceThemesList",
	"gjcAppearanceRead",
	"gjcAppearanceSet",
	"gjcProviderList",
	"gjcAuthStatus",
	"gjcAuthLogout",
	"gjcProviderAdd",
	"gjcAuthLoginStart",
	"gjcAuthLoginPoll",
	"gjcAuthLoginComplete",
	"gjcAuthLoginCancel",
	"gjcSessionList",
	"gjcSessionSearch",
	"gjcSessionRename",
	"gjcSessionOpen",
	"gjcSessionDelete",
	"gjcSessionExport",
	"gjcSessionTree",
	"gjcSessionMove",
	"gjcModelSet",
	"gjcCompact",
	"gjcHostToolsResult",
	"gjcHostUrisResult",
	"gjcWorkflowGateRespond",
] as const satisfies readonly (keyof AppServerClient)[];

type HarnessClientSurface = Pick<AppServerClient, (typeof HARNESS_CLIENT_METHODS)[number]>;
type NotificationListener = (notification: ServerNotificationEnvelope) => void;
type HarnessThread = ThreadSummary & { archived?: boolean; cwd?: string };
type HarnessSession = GjcSessionListResult["sessions"][number] & { threadId: string };
type HarnessPluginInspection = NonNullable<GjcPluginsInspectResult["plugin"]>;
type HarnessLoginFlow = { providerId: string; state: GjcAuthLoginFlowState };

const MODEL_LABEL = "synthetic-provider/synthetic-model";
const SYNTHETIC_TIMESTAMP = "2026-07-09T00:00:00.000Z";
const SYNTHETIC_SERVER_UNAVAILABLE_SECRET = "synthetic-server-unavailable-key";
const SYNTHETIC_TOKEN_REJECTED_SECRET = "synthetic-token-rejected-value";
const HARNESS_THEMES: GjcAppearanceThemesListResult["themes"] = [
	{
		id: "synthetic-dark",
		kind: "dark",
		builtin: true,
		semanticPreview: {
			bg: "#101826",
			bgElevated: "#182233",
			surface: "#243248",
			text: "#edf3ff",
			textMuted: "#9aabc4",
			accent: "#8bc5ff",
			border: "#3b4c66",
			success: "#76d6a1",
			warning: "#f4c46d",
			danger: "#ff9292",
		},
	},
	{
		id: "synthetic-light",
		kind: "light",
		builtin: true,
		semanticPreview: {
			bg: "#f7f9fc",
			bgElevated: "#ffffff",
			surface: "#e6edf7",
			text: "#172235",
			textMuted: "#66758c",
			accent: "#1769aa",
			border: "#b9c7da",
			success: "#197a47",
			warning: "#a76208",
			danger: "#bd3030",
		},
	},
];

declare global {
	interface Window {
		__harnessScenario?: HarnessScenario;
		__harnessClipboard?: { writes: string[]; lastText?: string; writeText(text: string): Promise<void> };
	}
}

export function createHarnessDeps(scenario = readScenario()): AppHostDeps {
	const storage = new Map<string, string>();
	const client = new HarnessClient(scenario);
	const clipboard = createClipboard(scenario);
	return {
		resolveEndpoint: async () => {
			const failure = connectionFailure(scenario);
			if (failure) throw failure;
			return { url: "http://127.0.0.1:44111/rpc", token: "synthetic-token" };
		},
		createClient: ({ webSocketFactory }) => {
			webSocketFactory("ws://127.0.0.1:44111/rpc?token=synthetic-token");
			return client;
		},
		createWebSocket: () => minimalWebSocket(),
		pickDirectory: async () => "/projects/demo-app",
		clipboard,
		storage: {
			getItem: key => storage.get(key) ?? null,
			setItem: (key, value) => storage.set(key, value),
		},
		timers: {
			setTimeout: window.setTimeout.bind(window),
			clearTimeout: window.clearTimeout.bind(window),
			requestAnimationFrame: window.requestAnimationFrame.bind(window),
		},
	};
}

export class HarnessClient extends AppServerClient implements HarnessClientSurface {
	#scenario: HarnessScenario;
	#listeners = new Set<NotificationListener>();
	#seq = 0;
	#threadCounter = 100;
	#turnCounter = 1;
	#loginCounter = 1;
	#model = { provider: "synthetic-provider", id: "synthetic-model", label: MODEL_LABEL };
	#appearance: GjcAppearanceReadResult = {
		dark: "synthetic-dark",
		light: "synthetic-light",
		symbolPreset: "unicode",
		colorBlindMode: false,
	};
	#skills: GjcSkillsListResult["skills"] = [
		{ name: "demo-review", source: "project", description: "Synthetic review skill", enabled: true },
		{ name: "demo-plan", source: "user", description: "Synthetic planning skill", enabled: true },
	];
	#extensions: GjcExtensionsListResult["extensions"] = [
		{
			id: "ext.demo-theme",
			name: "Demo Theme",
			source: "synthetic",
			kind: "ui",
			state: "enabled",
			status: "enabled",
		},
		{
			id: "ext.demo-lint",
			name: "Demo Lint",
			source: "synthetic",
			kind: "analysis",
			state: "enabled",
			status: "enabled",
		},
	];
	#plugins: GjcPluginsListResult["plugins"] = [
		{ id: "plugin.demo-vcs", name: "Demo VCS", source: "synthetic", kind: "mcp", status: "enabled" },
		{ id: "plugin.demo-ci", name: "Demo CI", source: "synthetic", kind: "automation", status: "disabled" },
	];
	#pluginInspections = new Map<string, HarnessPluginInspection>();
	#pluginFeatures = new Map<string, Map<string, boolean>>();
	#providers: GjcProviderListResult["providers"] = [
		{
			id: "synthetic-provider",
			name: "Synthetic Provider",
			authKind: "api-key-env",
			authenticated: true,
			envVar: "SYNTHETIC_API_KEY",
		},
		{ id: "synthetic-oauth", name: "Synthetic OAuth", authKind: "oauth", authenticated: false },
	];
	#authStates = new Map<string, GjcAuthStatusResult["providers"][number]["state"]>([
		["synthetic-provider", "authenticated"],
		["synthetic-oauth", "unauthenticated"],
	]);
	#loginFlows = new Map<string, HarnessLoginFlow>();
	#threads: HarnessThread[] = [
		thread("thread-demo-active", "running", 2, "/projects/demo-app"),
		thread("thread-demo-review", "idle", 1, "/projects/demo-lib"),
		{ ...thread("thread-demo-archived", "archived", 1, "/projects/demo-archive"), archived: true },
	];
	#sessions: HarnessSession[];

	constructor(scenario: HarnessScenario) {
		super();
		this.#scenario = scenario;
		if (scenario === "scratch") {
			this.#threads = [];
			this.#sessions = [];
			return;
		}
		this.#sessions = [
			sessionForThread(this.#threads[0]!, "Synthetic project review", "Review the synthetic demo project."),
			sessionForThread(this.#threads[1]!, "Synthetic library planning", "Plan a deterministic library change."),
			sessionForThread(this.#threads[2]!, "Synthetic archived session", "Archived synthetic session."),
		];
	}

	async connect(): Promise<void> {
		const failure = connectionFailure(this.#scenario);
		if (failure) throw failure;
	}

	async initialize() {
		return { platformFamily: "harness", platformOs: "browser", userAgent: "synthetic-harness" };
	}

	notify(): void {}

	onNotification(listener: NotificationListener): () => void;
	onNotification<M extends ServerNotificationMethod>(
		method: M,
		listener: (params: ServerNotificationMap[M]) => void,
	): () => void;
	onNotification<M extends ServerNotificationMethod>(
		methodOrListener: M | NotificationListener,
		listener?: (params: ServerNotificationMap[M]) => void,
	): () => void {
		const wrapped: NotificationListener =
			typeof methodOrListener === "function"
				? methodOrListener
				: notification => {
						if (notification.method === methodOrListener)
							listener?.(notification.params as ServerNotificationMap[M]);
					};
		this.#listeners.add(wrapped);
		return () => {
			this.#listeners.delete(wrapped);
		};
	}

	close(): void {}

	async threadStart(params: JsonValue) {
		const cwd = readOptionalString(params, "cwd") ?? (this.#scenario === "scratch" ? "/tmp" : "/projects/demo-app");
		const next = thread(`thread-demo-${this.#threadCounter++}`, "idle", 1, cwd);
		this.#threads = [next, ...this.#threads];
		this.#recordSession(next, "Synthetic new chat", "Start a synthetic chat.");
		return { thread: next };
	}

	async threadResume(params: { threadId: string }) {
		return { resumed: true, thread: this.#requireThread(params.threadId) };
	}

	async threadRead(params: { threadId: string }) {
		return { thread: this.#requireThread(params.threadId) };
	}

	async threadLoadedList() {
		return { data: this.#threads.map(thread => thread.id) };
	}

	async threadFork(params: JsonValue) {
		const source = this.#requireThread(readRequiredString(params, "threadId"));
		const forked = {
			...thread(`thread-demo-fork-${this.#threadCounter++}`, "idle", 1, source.cwd),
			forkedFromId: source.id,
		};
		this.#threads = [forked, ...this.#threads];
		this.#recordSession(forked, "Synthetic fork", "Forked from a synthetic session.");
		return { thread: forked };
	}

	async threadArchive(params: { threadId: string }) {
		this.#requireThread(params.threadId);
		this.#threads = this.#threads.map(item =>
			item.id === params.threadId ? { ...item, status: "archived", archived: true } : item,
		);
		return {};
	}

	async threadDelete(params: { threadId: string }) {
		this.#requireThread(params.threadId);
		this.#threads = this.#threads.filter(item => item.id !== params.threadId);
		this.#sessions = this.#sessions.filter(session => session.threadId !== params.threadId);
		return {};
	}

	async turnStart(params: { threadId: string; text?: string }) {
		this.#requireThread(params.threadId);
		const session = this.#sessions.find(candidate => candidate.threadId === params.threadId);
		if (session && params.text) session.firstMessage = params.text;
		const turnId = `turn-demo-${this.#turnCounter++}`;
		this.#emitScript(params.threadId, turnId);
		return { turn: { id: turnId, status: "completed" } };
	}

	async turnInterrupt() {
		return {};
	}

	async gjcStateRead() {
		return { model: { ...this.#model } };
	}

	async gjcCommandsList() {
		return {
			commands: [
				{ name: "/status", source: "synthetic", description: "Show synthetic status", classification: "safe" },
				{
					name: "/compact",
					source: "synthetic",
					description: "Compact the synthetic session",
					classification: "safe",
				},
			],
		};
	}

	async gjcToolsList() {
		return {
			tools: [
				{ name: "read", active: true, description: "Read synthetic project files" },
				{ name: "edit", active: true, description: "Preview a synthetic diff" },
			],
		};
	}

	async gjcSkillsList() {
		return { skills: this.#skills.map(skill => ({ ...skill })) };
	}

	async gjcSkillsSetEnabled(params: { skillId: string; enabled: boolean }) {
		this.#requireSkill(params.skillId);
		this.#skills = this.#skills.map(skill =>
			skill.name === params.skillId ? { ...skill, enabled: params.enabled } : skill,
		);
		return { ok: true, enabled: params.enabled };
	}

	async gjcExtensionsList() {
		return { extensions: this.#extensions.map(extension => ({ ...extension })) };
	}

	async gjcExtensionsInspect(params: { extensionId: string }) {
		if (this.#scenario === "inspect-error" || params.extensionId.includes("error"))
			throw new Error("synthetic extension inspect failure");
		return { extension: { ...this.#requireExtension(params.extensionId) } };
	}

	async gjcExtensionsSetEnabled(params: { extensionId: string; enabled: boolean }) {
		this.#requireExtension(params.extensionId);
		this.#extensions = this.#extensions.map(extension =>
			extension.id === params.extensionId
				? {
						...extension,
						state: params.enabled ? "enabled" : "disabled",
						status: params.enabled ? "enabled" : "disabled",
					}
				: extension,
		);
		return { ok: true, enabled: params.enabled };
	}

	async gjcPluginsList() {
		return { plugins: this.#plugins.map(plugin => ({ ...plugin })) };
	}

	async gjcPluginsInspect(params: { pluginId: string }) {
		if (this.#scenario === "inspect-error" || params.pluginId.includes("error"))
			throw new Error("synthetic plugin inspect failure");
		return { plugin: this.#pluginInspection(params.pluginId) };
	}

	async gjcPluginsSetEnabled(params: { pluginId: string; enabled: boolean }) {
		this.#requirePlugin(params.pluginId);
		this.#plugins = this.#plugins.map(plugin =>
			plugin.id === params.pluginId ? { ...plugin, status: params.enabled ? "enabled" : "disabled" } : plugin,
		);
		const inspection = this.#pluginInspections.get(params.pluginId);
		if (inspection)
			this.#pluginInspections.set(params.pluginId, {
				...inspection,
				plugin: { ...inspection.plugin, status: params.enabled ? "enabled" : "disabled" },
			});
		return { ok: true, enabled: params.enabled };
	}

	async gjcPluginsSetFeature(params: { pluginId: string; feature: string; enabled: boolean }) {
		this.#requirePlugin(params.pluginId);
		const features = this.#pluginFeatures.get(params.pluginId) ?? new Map<string, boolean>();
		features.set(params.feature, params.enabled);
		this.#pluginFeatures.set(params.pluginId, features);
		return { ok: true };
	}

	async gjcPluginsSetSetting(params: { pluginId: string; key: string; value: JsonValue }) {
		const inspection = this.#pluginInspection(params.pluginId);
		this.#pluginInspections.set(params.pluginId, {
			...inspection,
			settings: { ...jsonRecord(inspection.settings), [params.key]: params.value },
		});
		return { ok: true };
	}

	async gjcAppearanceThemesList() {
		return { themes: HARNESS_THEMES.map(theme => ({ ...theme, semanticPreview: { ...theme.semanticPreview } })) };
	}

	async gjcAppearanceRead() {
		return { ...this.#appearance };
	}

	async gjcAppearanceSet(params: {
		dark?: string | null;
		light?: string | null;
		symbolPreset?: string | null;
		colorBlindMode?: boolean | null;
	}) {
		this.#appearance = {
			dark: params.dark ?? this.#appearance.dark,
			light: params.light ?? this.#appearance.light,
			symbolPreset: params.symbolPreset ?? this.#appearance.symbolPreset,
			colorBlindMode: params.colorBlindMode ?? this.#appearance.colorBlindMode,
		};
		return { ...this.#appearance };
	}

	async gjcProviderList() {
		return { providers: this.#providers.map(provider => ({ ...provider })) };
	}

	async gjcAuthStatus(): Promise<GjcAuthStatusResult> {
		return {
			providers: this.#providers.map(provider => ({
				providerId: provider.id,
				state: this.#authStates.get(provider.id) ?? "unauthenticated",
				method: provider.authKind === "oauth" ? ("oauth" as const) : ("env" as const),
			})),
		};
	}

	async gjcAuthLogout(params: { providerId: string }) {
		this.#setProviderAuthentication(params.providerId, false);
		return { providerId: params.providerId, authenticated: false };
	}

	async gjcProviderAdd(params: GjcProviderAddParams) {
		const providerId = params.providerId?.trim() || params.preset?.trim() || "synthetic-added-provider";
		const provider = {
			id: providerId,
			name: `Synthetic ${providerId}`,
			authKind: "api-key-env" as const,
			authenticated: false,
			envVar: params.apiKeyEnv ?? "SYNTHETIC_API_KEY",
		};
		this.#providers = [provider, ...this.#providers.filter(candidate => candidate.id !== providerId)];
		this.#authStates.set(providerId, "unauthenticated");
		return { ok: true, providerId, models: params.models ?? ["synthetic-model"] };
	}

	async gjcAuthLoginStart(params: { providerId: string }) {
		this.#requireProvider(params.providerId);
		const flowId = `synthetic-login-${this.#loginCounter++}`;
		this.#loginFlows.set(flowId, { providerId: params.providerId, state: "pending-browser" });
		return {
			flowId,
			state: "pending-browser" as const,
			authUrl: `https://synthetic.invalid/auth/${encodeURIComponent(params.providerId)}`,
			instructions: "Complete the synthetic provider sign-in flow.",
		};
	}

	async gjcAuthLoginPoll(params: { flowId: string }) {
		const flow = this.#requireLoginFlow(params.flowId);
		return {
			state: flow.state,
			promptMessage: flow.state === "pending-browser" ? "Waiting for synthetic sign-in completion." : undefined,
		};
	}

	async gjcAuthLoginComplete(params: { flowId: string; redirectUrl: string }) {
		const flow = this.#requireLoginFlow(params.flowId);
		if (!params.redirectUrl) throw new Error("Synthetic sign-in requires a redirect URL.");
		flow.state = "authenticated";
		this.#setProviderAuthentication(flow.providerId, true);
		return { state: flow.state };
	}

	async gjcAuthLoginCancel(params: { flowId: string }) {
		const flow = this.#requireLoginFlow(params.flowId);
		flow.state = "cancelled";
		return { state: flow.state };
	}

	async gjcSessionList(params: GjcSessionListParams = {}) {
		return this.#listSessions(params);
	}

	async gjcSessionSearch(params: GjcSessionSearchParams) {
		return this.#listSessions(params, params.query);
	}

	async gjcSessionRename(params: { sessionPath: string; title: string }) {
		const session = this.#requireSession(params.sessionPath);
		session.title = params.title;
		return { ok: true, title: session.title };
	}

	async gjcSessionOpen(params: { sessionPath: string }) {
		const session = this.#requireSession(params.sessionPath);
		this.#requireThread(session.threadId);
		return {
			threadId: session.threadId,
			generation: 1,
			resumed: true,
			sessionMetadata: { cwd: session.cwd, sessionFile: session.path, sessionId: session.id },
		};
	}

	async gjcSessionDelete(params: { sessionPath: string }) {
		const session = this.#requireSession(params.sessionPath);
		this.#sessions = this.#sessions.filter(candidate => candidate.path !== session.path);
		return { ok: true };
	}

	async gjcSessionExport(params: { sessionPath: string; format: "markdown" | "json"; redact?: boolean | null }) {
		const session = this.#requireSession(params.sessionPath);
		const title = session.title ?? session.firstMessage ?? session.id;
		const redacted = params.redact ?? true;
		const content =
			params.format === "markdown"
				? `# ${title}\n\n${session.firstMessage ?? "Synthetic session."}\n\nSynthetic content: [redacted]`
				: JSON.stringify({ id: session.id, title, content: "[redacted]" }, null, 2);
		return {
			content,
			format: params.format,
			provenance: {
				exportedAt: SYNTHETIC_TIMESTAMP,
				redacted,
				sessionId: session.id,
				sourcePath: session.path,
				tool: "synthetic-harness",
			},
		};
	}

	async gjcSessionTree(params: { threadId: string }) {
		const thread = this.#requireThread(params.threadId);
		const session = this.#sessions.find(candidate => candidate.threadId === thread.id);
		const rootId = `${thread.id}-root`;
		const leafId = `${thread.id}-leaf`;
		return {
			activeLeafId: leafId,
			nodes: [
				{
					id: rootId,
					parentId: null,
					label: session?.title ?? "Synthetic session",
					preview: session?.firstMessage ?? "Synthetic session tree root.",
					timestamp: SYNTHETIC_TIMESTAMP,
					type: "session",
					active: false,
					children: [
						{
							id: leafId,
							parentId: rootId,
							label: "Synthetic current turn",
							preview: "Synthetic tree leaf for the current chat.",
							timestamp: SYNTHETIC_TIMESTAMP,
							type: "turn",
							active: true,
							children: [],
						},
					],
				},
			],
		};
	}

	async gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun?: boolean | null }): Promise<JsonValue> {
		const thread = this.#requireThread(params.threadId);
		const session = this.#sessions.find(candidate => candidate.threadId === thread.id);
		const targetSessionFile = sessionPath(params.targetCwd, session?.id ?? thread.id);
		if (params.dryRun)
			return {
				dryRun: true,
				artifactsDirs: [],
				conflicts: [],
				crossDevice: false,
				sourceSessionFile: session?.path ?? sessionPath(thread.cwd ?? "/projects/demo-app", thread.id),
				targetSessionFile,
			};
		const moved = {
			...thread,
			cwd: params.targetCwd,
			turns: [{ id: `${thread.id}-turn`, cwd: params.targetCwd, model: this.#model.label }],
		};
		this.#threads = this.#threads.map(candidate => (candidate.id === thread.id ? moved : candidate));
		if (session) {
			session.cwd = params.targetCwd;
			session.path = targetSessionFile;
		}
		return { dryRun: false, movedTo: params.targetCwd, sessionPath: targetSessionFile };
	}

	async gjcModelSet(params: { provider: string; modelId: string }) {
		this.#model = {
			provider: params.provider,
			id: params.modelId,
			label: `${params.provider}/${params.modelId}`,
		};
		return { model: this.#model.label };
	}

	async gjcCompact() {
		return { compacted: true };
	}

	async gjcHostToolsResult() {
		return {};
	}

	async gjcHostUrisResult() {
		return {};
	}

	async gjcWorkflowGateRespond(params: { gate_id: string }) {
		return {
			gate_id: params.gate_id,
			status: "accepted",
			answer_hash: "synthetic-answer",
			resolved_at: SYNTHETIC_TIMESTAMP,
		};
	}

	#listSessions(
		params: Pick<GjcSessionListParams, "cwd" | "limit" | "offset" | "scope">,
		query?: string,
	): GjcSessionListResult {
		const normalizedQuery = query?.trim().toLowerCase();
		const matching = this.#sessions.filter(session => {
			if (params.scope === "cwd" && params.cwd && session.cwd !== params.cwd) return false;
			if (!normalizedQuery) return true;
			return [session.id, session.cwd, session.title, session.firstMessage]
				.filter((value): value is string => typeof value === "string")
				.some(value => value.toLowerCase().includes(normalizedQuery));
		});
		const offset = Math.max(0, params.offset ?? 0);
		const limit = Math.max(0, params.limit ?? matching.length);
		return { sessions: this.#sessionEntries(matching.slice(offset, offset + limit)), total: matching.length };
	}

	#sessionEntries(sessions: readonly HarnessSession[]): GjcSessionListResult["sessions"] {
		return sessions.map(session => ({
			id: session.id,
			cwd: session.cwd,
			path: session.path,
			modifiedAt: session.modifiedAt,
			entryCount: session.entryCount,
			firstMessage: session.firstMessage,
			title: session.title,
		}));
	}

	#recordSession(thread: HarnessThread, title: string, firstMessage: string): void {
		this.#sessions = [sessionForThread(thread, title, firstMessage), ...this.#sessions];
	}

	#requireThread(threadId: string): HarnessThread {
		const found = this.#threads.find(thread => thread.id === threadId);
		if (!found) throw new Error(`Unknown synthetic thread ${threadId}`);
		return found;
	}

	#requireSession(sessionPath: string): HarnessSession {
		const found = this.#sessions.find(session => session.path === sessionPath);
		if (!found) throw new Error(`Unknown synthetic session ${sessionPath}`);
		return found;
	}

	#requireSkill(skillId: string): void {
		if (!this.#skills.some(skill => skill.name === skillId)) throw new Error(`Unknown synthetic skill ${skillId}`);
	}

	#requireExtension(extensionId: string) {
		const found = this.#extensions.find(extension => extension.id === extensionId);
		if (!found) throw new Error(`Unknown synthetic extension ${extensionId}`);
		return found;
	}

	#requirePlugin(pluginId: string) {
		const found = this.#plugins.find(plugin => plugin.id === pluginId);
		if (!found) throw new Error(`Unknown synthetic plugin ${pluginId}`);
		return found;
	}

	#pluginInspection(pluginId: string): HarnessPluginInspection {
		const existing = this.#pluginInspections.get(pluginId);
		if (existing) return existing;
		const plugin = this.#requirePlugin(pluginId);
		const created: HarnessPluginInspection = {
			plugin: { ...plugin },
			manifest: {
				name: plugin.id,
				permissions: ["read:/projects/demo-app"],
				settings: {
					mode: { type: "enum", values: ["synthetic", "diagnostic"] },
					apiToken: { type: "string", secret: true },
				},
			},
			settings: { mode: "synthetic", apiToken: "[redacted]" },
		};
		this.#pluginInspections.set(pluginId, created);
		return created;
	}

	#requireProvider(providerId: string) {
		const found = this.#providers.find(provider => provider.id === providerId);
		if (!found) throw new Error(`Unknown synthetic provider ${providerId}`);
		return found;
	}

	#setProviderAuthentication(providerId: string, authenticated: boolean): void {
		this.#requireProvider(providerId);
		this.#authStates.set(providerId, authenticated ? "authenticated" : "unauthenticated");
		this.#providers = this.#providers.map(provider =>
			provider.id === providerId ? { ...provider, authenticated } : provider,
		);
	}

	#requireLoginFlow(flowId: string): HarnessLoginFlow {
		const found = this.#loginFlows.get(flowId);
		if (!found) throw new Error(`Unknown synthetic login flow ${flowId}`);
		return found;
	}

	#emitScript(threadId: string, turnId: string): void {
		const assistantId = `assistant-${turnId}`;
		const toolCallId = `call-${turnId}`;
		const toolItemId = `tool-output-${turnId}`;
		this.#emit({ method: "turn/started", params: { threadId, turnId, seq: this.#nextSeq() } });
		this.#emit({
			method: "item/started",
			params: { threadId, itemId: assistantId, itemType: "assistant_message", seq: this.#nextSeq() },
		});
		for (const delta of ["Harness reply: ", "created a synthetic plan, ", "ran a tool, and produced a diff.\n\n"]) {
			this.#emit({
				method: "item/agentMessage/delta",
				params: { threadId, itemId: assistantId, delta, seq: this.#nextSeq() },
			});
		}
		this.#emit({
			method: "gjc/hostTools/call",
			params: {
				threadId,
				turnId,
				callId: toolCallId,
				tool: "edit",
				args: { path: "/projects/demo-app/src/demo.ts", diff: "-old\n+new" },
				generation: 1,
			},
		});
		this.#emit({
			method: "item/started",
			params: {
				threadId,
				itemId: toolItemId,
				itemType: "tool_result",
				toolName: "edit",
				content:
					"output:\nApplied synthetic diff to /projects/demo-app/src/demo.ts\n--- a/src/demo.ts\n+++ b/src/demo.ts\n@@\n-old\n+new",
				seq: this.#nextSeq(),
			},
		});
		this.#emit({
			method: "item/completed",
			params: { threadId, itemId: toolItemId, itemType: "tool_result", seq: this.#nextSeq() },
		});
		this.#emit({
			method: "item/completed",
			params: { threadId, itemId: assistantId, itemType: "assistant_message", seq: this.#nextSeq() },
		});
		this.#emit({ method: "turn/completed", params: { threadId, turnId, status: "completed", seq: this.#nextSeq() } });
	}

	#emit(notification: ServerNotificationEnvelope): void {
		for (const listener of this.#listeners) listener(notification);
	}

	#nextSeq(): number {
		return ++this.#seq;
	}
}

function thread(id: string, status: ThreadSummary["status"], generation: number, cwd?: string): HarnessThread {
	return {
		id,
		status,
		generation,
		turns: [{ id: `${id}-turn`, cwd: cwd ?? "/projects/demo-app", model: MODEL_LABEL }],
		cwd,
	};
}

function sessionForThread(thread: HarnessThread, title: string, firstMessage: string): HarnessSession {
	const cwd = thread.cwd ?? "/projects/demo-app";
	return {
		threadId: thread.id,
		id: thread.id,
		cwd,
		path: sessionPath(cwd, thread.id),
		modifiedAt: SYNTHETIC_TIMESTAMP,
		entryCount: 2,
		title,
		firstMessage,
	};
}

function sessionPath(cwd: string, sessionId: string): string {
	return `${cwd}/.gjc/sessions/${sessionId}.jsonl`;
}

function readOptionalString(value: JsonValue, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function readRequiredString(value: JsonValue, key: string): string {
	const candidate = readOptionalString(value, key);
	if (!candidate) throw new Error(`Synthetic request requires ${key}.`);
	return candidate;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createClipboard(scenario: HarnessScenario): Pick<Clipboard, "writeText"> {
	const recorder = {
		writes: [] as string[],
		lastText: undefined as string | undefined,
		async writeText(text: string) {
			if (scenario === "clipboard-error") throw new Error("Synthetic clipboard write failed.");
			this.writes.push(text);
			this.lastText = text;
		},
	};
	window.__harnessClipboard = recorder;
	return recorder;
}

function minimalWebSocket(): WebSocket {
	return {
		readyState: WebSocket.OPEN,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		close: () => undefined,
		send: () => undefined,
	} as unknown as WebSocket;
}

function connectionFailure(scenario: HarnessScenario): Error | undefined {
	if (scenario === "server-unavailable" || scenario === "failure") {
		return new Error(`server unavailable: api_key=${SYNTHETIC_SERVER_UNAVAILABLE_SECRET}`);
	}
	if (scenario === "token-rejected") return new Error(`token rejected: token=${SYNTHETIC_TOKEN_REJECTED_SECRET}`);
	return undefined;
}

export function readScenario(): HarnessScenario {
	if (typeof window === "undefined") return "happy";
	const fromWindow = window.__harnessScenario;
	if (fromWindow) return fromWindow;
	const value = new URLSearchParams(window.location.search).get("scenario");
	if (
		value === "failure" ||
		value === "server-unavailable" ||
		value === "token-rejected" ||
		value === "inspect-error" ||
		value === "scratch" ||
		value === "clipboard-error"
	)
		return value;
	return "happy";
}

export function HarnessApp() {
	const scenario = readScenario();
	return createApp({
		deps: createHarnessDeps(scenario),
		autoConnect: true,
		initialState: { workingDirectory: scenario === "scratch" ? "" : "/projects/demo-app" },
	});
}

const root = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-gjc-harness-root]");
if (root)
	createRoot(root).render(
		<React.StrictMode>
			<HarnessApp />
		</React.StrictMode>,
	);
