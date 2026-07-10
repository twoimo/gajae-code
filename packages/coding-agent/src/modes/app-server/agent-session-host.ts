import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir, getSessionsDir, pathIsWithin } from "@gajae-code/utils";
import { PROVIDER_DESCRIPTORS } from "@gajae-code/ai/provider-models";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { z } from "zod";
import { Settings } from "../../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema";
import { materializeActiveModelProfileAssignment } from "../../config/model-profile-activation";
import { GJC_MODEL_ASSIGNMENT_TARGETS, type GjcModelAssignmentTargetId } from "../../config/model-registry";
import { formatModelSelectorValue } from "../../config/model-resolver";
import type { Extension, Skill } from "../../discovery";
import { loadCapability } from "../../discovery";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { PluginManager } from "../../extensibility/plugins/manager";
import type { InstalledPlugin } from "../../extensibility/plugins/types";
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../../extensibility/slash-commands";
import { InternalUrlRouter } from "../../internal-urls";
import { getAppearanceThemeCatalog } from "../theme/theme";
import { loadAllExtensions } from "../components/extensions/state-manager";
import { addApiCompatibleProvider } from "../../setup/provider-onboarding";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
} from "../../internal-urls/types";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "../../sdk";
import { AsyncJobManager } from "../../async";
import { listCronSnapshots, onCronChange } from "../../tools/cron";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { FileSessionStorage } from "../../session/session-storage";
import type { AuthStorage } from "../../session/auth-storage";
import { formatSessionDumpText } from "../../session/session-dump-format";
import { type SessionInfo, SessionManager, type SessionTreeNode } from "../../session/session-manager";
import type { WorkflowGateEmitter } from "../shared/agent-wire/unattended-session";
import type { OpenGateInput } from "../shared/agent-wire/workflow-gate-broker";
import type {
	RpcWorkflowGate,
	RpcWorkflowGateResolution,
	RpcWorkflowGateResponse,
} from "../shared/agent-wire/workflow-gate-types";
import type { AppServerHost, CreatedThread } from "./host";

interface NativeHostToolBridge {
	hostToolNames(threadId: string): string[];
	activeTurnId(threadId: string): string | null;
	callHostTool(threadId: string, turnId: string, tool: string, argsJson: string): Promise<string>;
}

interface NativeWorkflowGateBridge {
	openWorkflowGate(threadId: string, inputJson: string): Promise<string>;
	isWorkflowGateUnattended?(threadId: string): boolean;
}

interface NativeHostUriBridge {
	readHostUri(threadId: string, urlJson: string): Promise<string>;
	writeHostUri(threadId: string, urlJson: string, content: string): Promise<void>;
}

type NativeAppServerBridge = NativeHostToolBridge & Partial<NativeWorkflowGateBridge> & Partial<NativeHostUriBridge>;

export type AppServerEventEmitter = (
	threadId: string,
	generation: number,
	eventType: string,
	payloadJson: unknown,
) => void;

/**
 * The minimal `AgentSession` surface the app-server host drives. Declared
 * structurally (not `Pick<AgentSession>`) so both the real session and test
 * fakes satisfy it, and so a future native Rust session can conform too.
 */
export interface AppServerSession {
	readonly sessionId: string;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string, options?: unknown): Promise<void>;
	steer(text: string, images?: unknown): Promise<void>;
	abort(options?: unknown): void | Promise<void>;
	retry?: () => Promise<boolean>;
	executeBash(command: string, onChunk?: (chunk: string) => void, options?: unknown): Promise<unknown>;
	setModel?(...args: unknown[]): unknown;
	compact?(...args: unknown[]): unknown;
	dispose(): void | Promise<void>;
	state?: unknown;
	messages?: unknown;
	getSessionState?: () => unknown;
	getMessages?: () => unknown;
	setTodos?: (todos: unknown) => unknown;
	setWorkflowGateEmitter?: (emitter: WorkflowGateEmitter | undefined) => void;
	model?: unknown;
	getSessionStats?: () => unknown;
	getContextUsage?: () => unknown;
	getGoalModeState?: () => unknown;
	getActiveToolNames?: () => string[];
	getAllToolNames?: () => string[];
	sessionManager?: {
		getSessionFile?: () => string | undefined;
		getArtifactsDir?: () => string | null;
		flush?: () => Promise<void>;
		moveTo?: (targetCwd: string) => Promise<void>;
		getTree?: () => unknown[];
		getLeafId?: () => string | null;
		getEntries?: () => unknown[];
		appendLabelChange?: (entryId: string, label: string | undefined) => unknown;
	};
	navigateTree?: (entryId: string, options?: { summarize?: boolean }) => Promise<{ cancelled?: boolean }>;
	branch?: (entryId: string) => Promise<{ cancelled?: boolean }>;
	buildForkContextSeed?: (options: {
		maxMessages: number;
		maxTokens: number;
		cacheIdentity?: string;
	}) => Promise<CreateAgentSessionOptions["forkContextSeed"]>;
	getAsyncJobSnapshot?: (options?: { recentLimit?: number }) => unknown;
	getAgentId?: () => string | undefined;
	jobsObserver?: { onChange?: (cb: () => void) => () => void };
	modelRegistry?: { getAll?: () => unknown[]; getAvailable?: () => unknown[]; authStorage?: AuthStorage; refresh?: (mode?: string) => unknown };
	getActiveModelProfile?: () => string | undefined;
	setActiveModelProfile?: (profile: string | undefined) => void;
	authStorage?: AuthStorage;
	thinkingLevel?: string;
	getAvailableThinkingLevels?: () => readonly string[];
	setThinkingLevel?: (level: unknown, persist?: boolean) => void;
	isFastModeActive?: () => boolean;
	isFastModeEnabled?: () => boolean;
	setFastMode?: (enabled: boolean) => void;
	settings?: {
		get: (key: SettingPath) => unknown;
		set: (key: SettingPath, value: never) => void;
		flush?: () => Promise<void>;
		clearOverride?: (key: SettingPath | string) => void;
		override?: (key: SettingPath | string, value: unknown) => void;
		setModelRole?: (role: string, selector: string) => void;
	};
}

type AgentSessionLike = AppServerSession;

type SessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: AgentSessionLike }>;

export interface AgentSessionHostOptions {
	appServer?: NativeAppServerBridge;
	emit?: AppServerEventEmitter;
	sessionFactory?: SessionFactory;
	authStorageFactory?: () => Promise<AuthStorage>;
}

interface ThreadRecord {
	session: AgentSessionLike;
	unsubscribe: () => void;
	generation: number;
	cwd: string;
	metadata: Record<string, unknown>;
	hostUriSchemes: Map<string, { writable: boolean; immutable: boolean }>;
	pendingEvents: AgentSessionEvent[];
	pendingJobChanges: unknown[];
}

function hostToolDescriptors(value: unknown): Array<{ name: string; description: string; inputSchema: unknown }> {
	const record = asRecord(value);
	const tools = Array.isArray(record.hostTools) ? record.hostTools : Array.isArray(record.tools) ? record.tools : [];
	return tools
		.map(tool => asRecord(tool))
		.map(tool => ({
			name: optionalString(tool.name) ?? "",
			description: typeof tool.description === "string" ? tool.description : `Host tool ${String(tool.name ?? "")}`,
			inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {},
		}))
		.filter(tool => tool.name.length > 0);
}

function hostToolResult(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	return { content: [{ type: "text", text }], details: value };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function validateCwdParam(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length === 0) throw new Error("cwd must be a non-empty absolute path");
	if (!path.isAbsolute(value)) throw new Error("cwd must be an absolute path");
	if (value.split(/[\\/]/).includes("..")) throw new Error("cwd must not contain traversal segments");
	return path.normalize(value);
}

// Copied from packages/tui/src/fuzzy.ts to keep app-server independent of the TUI package boundary.
function fuzzyScore(query: string, text: string): number | undefined {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();
	if (queryLower.length === 0) return 0;
	if (queryLower.length > textLower.length) return undefined;
	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;
	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
		if (textLower[i] !== queryLower[queryIndex]) continue;
		const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!);
		if (lastMatchIndex === i - 1) {
			consecutiveMatches++;
			score -= consecutiveMatches * 5;
		} else {
			consecutiveMatches = 0;
			if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
		}
		if (isWordBoundary) score -= 10;
		score += i * 0.1;
		lastMatchIndex = i;
		queryIndex++;
	}
	return queryIndex < queryLower.length ? undefined : score;
}

function fuzzySearchScore(query: string, text: string): number | undefined {
	const tokens = query.trim().split(/\s+/).filter(Boolean);
	let total = 0;
	for (const token of tokens) {
		const score = fuzzyScore(token, text);
		if (score === undefined) return undefined;
		total += score;
	}
	return total;
}
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeSessionMetadata(params: unknown, sessionId?: string): Record<string, unknown> {
	const record = asRecord(params);
	const metadata: Record<string, unknown> = {};
	for (const key of [
		"cwd",
		"sessionId",
		"sessionDir",
		"systemPromptAppend",
		"thinking",
		"todos",
		"forkedFromId",
	] as const) {
		if (record[key] !== undefined) metadata[key] = record[key];
	}
	const model = optionalRecord(record.model);
	if (model) {
		metadata.model = {
			...(typeof model.provider === "string" ? { provider: model.provider } : {}),
			...(typeof model.modelId === "string" ? { modelId: model.modelId } : {}),
		};
	}
	if (sessionId) metadata.sessionId = sessionId;
	return metadata;
}

function modelPatternFromMetadataModel(model: unknown): string | undefined {
	const record = optionalRecord(model);
	if (!record) return undefined;
	const provider = optionalString(record.provider);
	const modelId = optionalString(record.modelId);
	if (!provider || !modelId) {
		throw new Error("sessionMetadata.model must include non-empty provider and modelId strings");
	}
	return `${provider}/${modelId}`;
}

function thinkingLevelFromMetadata(thinking: unknown): CreateAgentSessionOptions["thinkingLevel"] | undefined {
	if (typeof thinking === "string" && thinking.length > 0) {
		return thinking as CreateAgentSessionOptions["thinkingLevel"];
	}
	const record = optionalRecord(thinking);
	if (record && typeof record.level === "string" && record.level.length > 0) {
		return record.level as CreateAgentSessionOptions["thinkingLevel"];
	}
	return undefined;
}

function createOptionsFromMetadata(
	metadata: Record<string, unknown>,
	hostTools: CustomTool[],
): CreateAgentSessionOptions {
	const options: CreateAgentSessionOptions = {};
	if (typeof metadata.cwd === "string") options.cwd = metadata.cwd;
	if (typeof metadata.sessionId === "string") options.providerSessionId = metadata.sessionId;
	if (typeof metadata.systemPromptAppend === "string") {
		const append = metadata.systemPromptAppend;
		options.systemPrompt = defaultPrompt => [...defaultPrompt, append];
	}
	const modelPattern = modelPatternFromMetadataModel(metadata.model);
	if (modelPattern) options.modelPattern = modelPattern;
	const thinkingLevel = thinkingLevelFromMetadata(metadata.thinking);
	if (thinkingLevel) options.thinkingLevel = thinkingLevel;
	if (hostTools.length > 0) options.customTools = hostTools;
	return options;
}

function commandFromValue(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value)) {
		if (value.length === 0) return undefined;
		if (!value.every(part => typeof part === "string"))
			throw new Error("exec command array must contain only strings");
		return value.join(" ");
	}
	return undefined;
}

function execOptions(record: Record<string, unknown>): unknown {
	if (record.options && typeof record.options === "object") return record.options;
	const options: Record<string, unknown> = {};
	for (const key of ["cwd", "timeout", "timeoutMs", "excludeFromContext"] as const) {
		if (record[key] !== undefined) options[key] = record[key];
	}
	return Object.keys(options).length > 0 ? options : undefined;
}

function jsonClone<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

function includeRequests(include: unknown, key: string): boolean {
	const record = optionalRecord(include);
	return record?.[key] === true;
}

function includeDisabled(include: unknown): boolean {
	const record = optionalRecord(include);
	return typeof record?.includeDisabled === "boolean" ? record.includeDisabled : true;
}

function includeSettings(include: unknown): boolean {
	const record = optionalRecord(include);
	return typeof record?.includeSettings === "boolean" ? record.includeSettings : true;
}

type CommandClassification =
	| "in-scope-existing"
	| "in-scope-new"
	| "prompt-display-only"
	| "deferred-needs-new-api"
	| "excluded-terminal-only";
type CommandCatalogEntry = { name: string; source: "builtin" | "file" | "skill" | "extension"; description?: string; classification: CommandClassification };
type SkillCatalogEntry = { name: string; source: string; description?: string; enabled?: boolean };
type ExtensionCatalogEntry = {
	id: string;
	name: string;
	kind: string;
	source: string;
	status?: string;
	description?: string;
	state?: "active" | "disabled" | "shadowed";
	disabledReason?: string;
	shadowedBy?: string;
	provider?: string;
};
const BUILTIN_COMMAND_CLASSIFICATION: Record<string, CommandClassification> = {
	"/agents": "in-scope-new",
	"/background": "excluded-terminal-only",
	"/btw": "deferred-needs-new-api",
	"/compact": "in-scope-existing",
	"/context": "in-scope-new",
	"/contribute-pr": "deferred-needs-new-api",
	"/copy": "in-scope-existing",
	"/debug": "excluded-terminal-only",
	"/drop": "in-scope-existing",
	"/dump": "in-scope-existing",
	"/exit": "excluded-terminal-only",
	"/export": "in-scope-new",
	"/fast": "in-scope-new",
	"/goal": "in-scope-new",
	"/help": "prompt-display-only",
	"/hotkeys": "prompt-display-only",
	"/jobs": "in-scope-new",
	"/login": "in-scope-new",
	"/logout": "in-scope-new",
	"/memory": "deferred-needs-new-api",
	"/model": "in-scope-new",
	"/monitors": "in-scope-new",
	"/move": "in-scope-new",
	"/new": "in-scope-existing",
	"/provider": "in-scope-new",
	"/rename": "in-scope-new",
	"/resume": "in-scope-existing",
	"/retry": "in-scope-new",
	"/session": "in-scope-new",
	"/settings": "in-scope-new",
	"/ssh": "excluded-terminal-only",
	"/theme": "in-scope-new",
	"/tools": "in-scope-new",
	"/tree": "in-scope-new",
	"/usage": "in-scope-new",
};

function commandClassification(name: string, source: CommandCatalogEntry["source"]): CommandClassification {
	if (source === "builtin") return BUILTIN_COMMAND_CLASSIFICATION[name] ?? "in-scope-new";
	return "in-scope-new";
}
function slashName(name: string): string {
	return name.startsWith("/") ? name : `/${name}`;
}
type PluginCatalogEntry = {
	id: string;
	name: string;
	kind: string;
	source: string;
	status?: string;
	version?: string;
	description?: string;
	enabled?: boolean;
	enabledFeatures?: string[] | null;
	manifest?: unknown;
	settings?: Record<string, unknown>;
};

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoValue(value: unknown): string | undefined {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	return undefined;
}

const SAFE_SETTINGS_ALLOWLIST = [
	"theme.dark",
	"theme.light",
	"symbolPreset",
	"colorBlindMode",
	"notifications.terminalBell",
	"notifications.bellOnComplete",
	"notifications.bellOnApproval",
	"notifications.bellOnAsk",
	"autoResume",
] as const satisfies readonly SettingPath[];
type SafeSettingPath = (typeof SAFE_SETTINGS_ALLOWLIST)[number];

function settingDescriptor(key: SafeSettingPath) {
	const def = SETTINGS_SCHEMA[key];
	const ui = "ui" in def ? def.ui : undefined;
	return {
		key,
		type: def.type,
		...(ui?.label ? { label: ui.label } : {}),
		...(ui?.description ? { description: ui.description } : {}),
		...(def.type === "enum" ? { enum: [...def.values] } : {}),
		...("default" in def && def.default !== undefined ? { default: def.default } : {}),
	};
}
function settingsOwner(session?: AgentSessionLike): {
	get: (key: SettingPath) => unknown;
	set: (key: SettingPath, value: never) => void;
	flush?: () => Promise<void>;
} {
	try {
		return Settings.instance;
	} catch {
		return session?.settings ?? Settings.isolated();
	}
}
function settingsSchemaModel() {
	return { settings: SAFE_SETTINGS_ALLOWLIST.map(settingDescriptor) };
}
function settingsReadModel(session?: AgentSessionLike) {
	const owner = settingsOwner(session);
	return { values: Object.fromEntries(SAFE_SETTINGS_ALLOWLIST.map(key => [key, owner.get(key)])) };
}
async function settingsUpdateModel(params: unknown, session?: AgentSessionLike) {
	const record = asRecord(params);
	const key = optionalString(record.key) as SafeSettingPath | undefined;
	if (!key || !(SAFE_SETTINGS_ALLOWLIST as readonly string[]).includes(key))
		throw new Error("setting is not allowlisted");
	const def = SETTINGS_SCHEMA[key];
	const value = record.value;
	if (def.type === "boolean" && typeof value !== "boolean") throw new Error("setting value must be boolean");
	if (def.type === "string" && typeof value !== "string") throw new Error("setting value must be string");
	if (def.type === "enum" && (typeof value !== "string" || !(def.values as readonly string[]).includes(value)))
		throw new Error("setting value must be an allowed enum value");
	const owner = settingsOwner(session);
	owner.set(key, value as never);
	await owner.flush?.();
	return settingsReadModel(session);
}
async function appearanceThemesListModel() {
	return { themes: await getAppearanceThemeCatalog() };
}
function appearanceReadModel(session?: AgentSessionLike) {
	const owner = settingsOwner(session);
	return {
		dark: owner.get("theme.dark"),
		light: owner.get("theme.light"),
		symbolPreset: owner.get("symbolPreset"),
		colorBlindMode: owner.get("colorBlindMode"),
	};
}
async function appearanceSetModel(params: unknown, session?: AgentSessionLike) {
	const record = asRecord(params);
	const updates: Array<[SafeSettingPath, unknown]> = [];
	const themeIds = new Set((await getAppearanceThemeCatalog()).map(theme => theme.id));
	if (record.dark !== undefined) {
		const value = optionalString(record.dark);
		if (!value || !themeIds.has(value)) throw new Error("dark theme id is not in the theme registry");
		updates.push(["theme.dark", value]);
	}
	if (record.light !== undefined) {
		const value = optionalString(record.light);
		if (!value || !themeIds.has(value)) throw new Error("light theme id is not in the theme registry");
		updates.push(["theme.light", value]);
	}
	if (record.symbolPreset !== undefined) {
		const value = optionalString(record.symbolPreset);
		if (value !== "unicode" && value !== "nerd" && value !== "ascii")
			throw new Error("symbolPreset must be unicode, nerd, or ascii");
		updates.push(["symbolPreset", value]);
	}
	if (record.colorBlindMode !== undefined) {
		if (typeof record.colorBlindMode !== "boolean") throw new Error("colorBlindMode must be boolean");
		updates.push(["colorBlindMode", record.colorBlindMode]);
	}
	if (updates.length === 0) throw new Error("at least one appearance field is required");
	const owner = settingsOwner(session);
	for (const [key, value] of updates) owner.set(key, value as never);
	await owner.flush?.();
	return appearanceReadModel(session);
}
function modelCatalogModel(session: AgentSessionLike) {
	const all = session.modelRegistry?.getAll?.() ?? session.modelRegistry?.getAvailable?.() ?? [];
	const available = new Set(
		(session.modelRegistry?.getAvailable?.() ?? all).map(
			m =>
				`${optionalString(asRecord(m).provider)}/${optionalString(asRecord(m).id) ?? optionalString(asRecord(m).modelId)}`,
		),
	);
	const models = all
		.map(asRecord)
		.map(m => {
			const modelId = optionalString(m.id) ?? optionalString(m.modelId) ?? optionalString(m.model) ?? "unknown";
			const provider = optionalString(m.provider) ?? "unknown";
			return {
				provider,
				modelId,
				...(optionalString(m.name) ? { name: optionalString(m.name) } : {}),
				...(numberValue(m.contextWindow) !== undefined ? { contextWindow: numberValue(m.contextWindow) } : {}),
				...(m.reasoning !== undefined || asRecord(m.thinking).enabled !== undefined
					? { reasoning: Boolean(m.reasoning ?? asRecord(m.thinking).enabled) }
					: {}),
				available: available.has(`${provider}/${modelId}`),
			};
		})
		.filter((m, i, a) => a.findIndex(x => x.provider === m.provider && x.modelId === m.modelId) === i);
	const active = asRecord(session.model);
	return {
		models,
		...(optionalString(active.provider) ? { activeProvider: optionalString(active.provider) } : {}),
		...((optionalString(active.id) ?? optionalString(active.modelId))
			? { activeModelId: optionalString(active.id) ?? optionalString(active.modelId) }
			: {}),
	};
}
function thinkingReadModel(session: AgentSessionLike) {
	const levels = ["off", ...(session.getAvailableThinkingLevels?.() ?? [])].filter(
		(v, i, a) => typeof v === "string" && a.indexOf(v) === i,
	);
	return { level: session.thinkingLevel ?? "off", levels };
}
function setThinkingModel(session: AgentSessionLike, level: unknown) {
	const read = thinkingReadModel(session);
	if (typeof level !== "string" || !read.levels.includes(level)) throw new Error("unsupported thinking level");
	if (typeof session.setThinkingLevel !== "function")
		throw new Error("setThinkingLevel is not supported by AgentSession");
	session.setThinkingLevel(level === "off" ? undefined : level, true);
	return { level: session.thinkingLevel ?? "off" };
}
function fastReadModel(session: AgentSessionLike) {
	return {
		enabled: Boolean(session.isFastModeActive?.() ?? session.isFastModeEnabled?.()),
		affectedRoles: ["default"],
	};
}
function setFastModel(session: AgentSessionLike, enabled: unknown) {
	if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
	if (typeof session.setFastMode !== "function") throw new Error("setFastMode is not supported by AgentSession");
	session.setFastMode(enabled);
	return fastReadModel(session);
}

type ProviderAuthKind = "oauth" | "api-key-env" | "none";
const OAUTH_CAPABLE_PROVIDERS = new Set(getOAuthProviders().map(provider => provider.id));

function authStorageForSession(session?: AgentSessionLike): AuthStorage | undefined {
	return session?.authStorage ?? session?.modelRegistry?.authStorage;
}

async function providerAuthRows(session: AgentSessionLike | undefined, fallbackStorage?: () => Promise<AuthStorage>) {
	const storage = authStorageForSession(session) ?? (fallbackStorage ? await fallbackStorage() : undefined);
	const stored = new Set(storage?.list?.() ?? []);
	return PROVIDER_DESCRIPTORS.map(descriptor => {
		const envVar = descriptor.catalogDiscovery?.envVars[0];
		const hasOAuthCapability = OAUTH_CAPABLE_PROVIDERS.has(descriptor.providerId);
		const authenticated = storage?.hasAuth?.(descriptor.providerId) ?? false;
		const authKind: ProviderAuthKind = hasOAuthCapability
			? "oauth"
			: envVar
				? "api-key-env"
				: descriptor.allowUnauthenticated
					? "none"
					: "api-key-env";
		return {
			id: descriptor.providerId,
			...(descriptor.catalogDiscovery?.label ? { name: descriptor.catalogDiscovery.label } : {}),
			authKind,
			authenticated: authenticated || stored.has(descriptor.providerId),
			...(authKind === "api-key-env" && envVar ? { envVar } : {}),
		};
	});
}

async function providerListModel(session?: AgentSessionLike, fallbackStorage?: () => Promise<AuthStorage>) {
	return { providers: await providerAuthRows(session, fallbackStorage) };
}

async function authStatusModel(session?: AgentSessionLike, fallbackStorage?: () => Promise<AuthStorage>) {
	const rows = await providerAuthRows(session, fallbackStorage);
	return {
		providers: rows.map(provider => ({
			providerId: provider.id,
			state: provider.authenticated ? "authenticated" : "unauthenticated",
			...(provider.authenticated ? { method: provider.authKind === "oauth" ? "oauth" : "env" } : {}),
		})),
	};
}

async function authLogoutModel(
	params: unknown,
	session?: AgentSessionLike,
	fallbackStorage?: () => Promise<AuthStorage>,
) {
	const providerId = optionalString(asRecord(params).providerId);
	if (!providerId) throw new Error("providerId is required");
	const storage = authStorageForSession(session) ?? (fallbackStorage ? await fallbackStorage() : undefined);
	if (!storage) throw new Error("auth storage is not available");
	await storage.remove(providerId);
	console.info(JSON.stringify({ event: "gjc.auth.logout", providerId }));
	return { providerId, authenticated: storage.hasAuth(providerId) };
}
async function ensureAbsoluteExistingDir(value: unknown, label: string): Promise<string> {
	const dir = optionalString(value);
	if (!dir || !path.isAbsolute(dir)) throw new Error(`${label} must be an absolute path`);
	const info = await stat(dir);
	if (!info.isDirectory()) throw new Error(`${label} must be an existing directory`);
	return path.normalize(dir);
}

function envVarName(value: unknown): string {
	const name = optionalString(value);
	if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("apiKeyEnv must be an environment variable name");
	return name;
}

async function providerAddModel(params: unknown, sessions: Iterable<AgentSessionLike>) {
	const record = asRecord(params);
	if ("apiKey" in record) throw new Error("raw API keys are not accepted; pass apiKeyEnv");
	const input = optionalString(record.preset)
		? { preset: optionalString(record.preset), force: record.force === true }
		: {
				compatibility: optionalString(record.compatibility) as "openai" | "anthropic" | undefined,
				providerId: optionalString(record.providerId),
				baseUrl: optionalString(record.baseUrl),
				apiKeyEnv: envVarName(record.apiKeyEnv),
				models: Array.isArray(record.models) ? record.models.map(String) : undefined,
				force: record.force === true,
			};
	const result = await addApiCompatibleProvider(input);
	await Promise.all([...sessions].map(session => Promise.resolve(session.modelRegistry?.refresh?.("offline"))));
	return { ok: true, providerId: result.providerId, models: result.modelIds };
}

async function sessionMoveModel(thread: ThreadRecord, params: unknown) {
	const record = asRecord(params);
	const targetCwd = await ensureAbsoluteExistingDir(record.targetCwd, "targetCwd");
	const manager = thread.session.sessionManager;
	if (!manager?.getSessionFile) throw new Error("sessionMove is not supported by this session");
	const sourceSessionFile = manager.getSessionFile();
	if (!sourceSessionFile) throw new Error("session has no session file");
	const targetSessionDir = SessionManager.getDefaultSessionDir(targetCwd, undefined, new FileSessionStorage());
	const targetSessionFile = path.join(targetSessionDir, path.basename(sourceSessionFile));
	const artifactsDirs = [sourceSessionFile.slice(0, -6)];
	const conflicts: string[] = [];
	try {
		await stat(targetSessionFile);
		if (path.resolve(targetSessionFile) !== path.resolve(sourceSessionFile)) conflicts.push("target session file already exists");
	} catch {}
	const crossDevice = path.parse(sourceSessionFile).root !== path.parse(targetCwd).root;
	if (record.dryRun === true) return { dryRun: true, sourceSessionFile, targetSessionFile, artifactsDirs, crossDevice, conflicts };
	if (asRecord(thread.session.state).status === "streaming") throw new Error("cannot move a streaming thread");
	if (conflicts.length > 0) throw new Error(`session move conflicts: ${conflicts.join(", ")}`);
	if (!manager.flush || !manager.moveTo) throw new Error("sessionMove is not supported by this session");
	await manager.flush();
	await manager.moveTo(targetCwd);
	thread.cwd = targetCwd;
	return { dryRun: false, movedTo: targetCwd, sessionPath: manager.getSessionFile?.() ?? targetSessionFile };
}

async function modelAssignModel(session: AgentSessionLike, params: unknown) {
	const record = asRecord(params);
	const role = optionalString(record.role);
	const provider = optionalString(record.provider);
	const modelId = optionalString(record.modelId);
	if (!role || !provider || !modelId) throw new Error("role, provider, and modelId are required");
	const target = GJC_MODEL_ASSIGNMENT_TARGETS[role as GjcModelAssignmentTargetId];
	if (!target) throw new Error(`unsupported model assignment role: ${role}`);
	const thinkingLevel = optionalString(record.thinkingLevel);
	const baseSelector = `${provider}/${modelId}`;
	const persistedSelector = formatModelSelectorValue(baseSelector, thinkingLevel as never);
	const settings = session.settings ?? Settings.instance;
	const models = [...(session.modelRegistry?.getAll?.() ?? []), ...(session.modelRegistry?.getAvailable?.() ?? [])];
	const model = models.find(candidate => {
		const value = asRecord(candidate);
		return optionalString(value.provider) === provider && optionalString(value.id) === modelId;
	});
	if (!model) throw new Error(`unknown model: ${provider}/${modelId}`);
	if (role === "default") {
		if (typeof session.setModel === "function") await session.setModel(model, role, { selector: baseSelector, ...(thinkingLevel ? { thinkingLevel } : {}) });
		else settings.setModelRole?.(role, persistedSelector);
		materializeActiveModelProfileAssignment({ session: session as never, settings: settings as never, role, selector: persistedSelector });
		if (thinkingLevel) session.setThinkingLevel?.(thinkingLevel, true);
	} else {
		const materializedProfile = materializeActiveModelProfileAssignment({ session: session as never, settings: settings as never, role: role as GjcModelAssignmentTargetId, selector: persistedSelector });
		if (!materializedProfile) {
			if (target.settingsPath === "modelRoles") settings.setModelRole?.(role, persistedSelector);
			else {
				const overrides = asRecord(settings.get("task.agentModelOverrides"));
				settings.set("task.agentModelOverrides", { ...overrides, [role]: persistedSelector } as never);
			}
		}
	}
	await settings.flush?.();
	return { ok: true, role, modelId };
}

async function disabledExtensionToggle(id: string, enabled: boolean) {
	const owner = Settings.instance;
	const current = Array.isArray(owner.get("disabledExtensions" as SettingPath))
		? [...(owner.get("disabledExtensions" as SettingPath) as string[])]
		: [];
	const next = enabled ? current.filter(value => value !== id) : [...new Set([...current, id])];
	owner.set("disabledExtensions" as SettingPath, next as never);
	await owner.flush?.();
	return { ok: true, enabled };
}

function isSecretSettingKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key);
}

async function requireExtensionId(cwd: string, extensionId: string): Promise<void> {
	const extensions = await extensionsCatalog(cwd, true);
	if (!extensions.some(extension => extension.id === extensionId)) throw new Error(`unknown extension: ${extensionId}`);
}

async function requireSkillId(cwd: string, skillId: string): Promise<void> {
	const skills = await skillsCatalog(cwd, true);
	if (!skills.some(skill => skill.name === skillId)) throw new Error(`unknown skill: ${skillId}`);
}

async function requirePlugin(manager: PluginManager, pluginId: string): Promise<InstalledPlugin> {
	const plugin = (await manager.list()).find(entry => entry.name === pluginId);
	if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
	return plugin;
}

function todosReadModel(session: AgentSessionLike): unknown {
	const state = asRecord(typeof session.getSessionState === "function" ? session.getSessionState() : session.state);
	const raw: unknown[] = Array.isArray(state.todos)
		? state.todos
		: Array.isArray(asRecord(state.todoState).todos)
			? (asRecord(state.todoState).todos as unknown[])
			: [];
	return {
		todos: raw
			.map(item => asRecord(item))
			.map((item, index) => ({
				...(optionalString(item.id) ? { id: optionalString(item.id) } : {}),
				content:
					optionalString(item.content) ??
					optionalString(item.title) ??
					optionalString(item.text) ??
					`todo-${index + 1}`,
				status: optionalString(item.status) ?? (item.done === true ? "completed" : "pending"),
			})),
	};
}

function usageReadModel(session: AgentSessionLike): unknown {
	const stats = typeof session.getSessionStats === "function" ? asRecord(session.getSessionStats()) : {};
	const rows = Array.isArray(stats.perModel) ? stats.perModel : Array.isArray(stats.models) ? stats.models : [];
	let perModel = rows
		.map(row => asRecord(row))
		.map(row => ({
			...(optionalString(row.provider) ? { provider: optionalString(row.provider) } : {}),
			modelId: optionalString(row.modelId) ?? optionalString(row.model) ?? "unknown",
			input: numberValue(row.input) ?? numberValue(row.inputTokens) ?? 0,
			output: numberValue(row.output) ?? numberValue(row.outputTokens) ?? 0,
			...(numberValue(row.cacheRead) !== undefined ? { cacheRead: numberValue(row.cacheRead) } : {}),
			...(numberValue(row.cacheWrite) !== undefined ? { cacheWrite: numberValue(row.cacheWrite) } : {}),
			...(numberValue(row.cost) !== undefined ? { cost: numberValue(row.cost) } : {}),
		}));
	if (perModel.length === 0) {
		const input = numberValue(stats.input) ?? numberValue(stats.inputTokens) ?? 0;
		const output = numberValue(stats.output) ?? numberValue(stats.outputTokens) ?? 0;
		if (input || output)
			perModel = [{ modelId: optionalString(asRecord(session.model).modelId) ?? "unknown", input, output }];
	}
	return {
		perModel,
		...(numberValue(stats.totalCost) !== undefined
			? { totalCost: numberValue(stats.totalCost) }
			: numberValue(stats.costUsd) !== undefined
				? { totalCost: numberValue(stats.costUsd) }
				: {}),
		source: "AgentSession.getSessionStats",
		freshness: "live",
	};
}
const MONITOR_OUTPUT_TAIL_LIMIT = 4000;

function boundedOutputTail(value: unknown): string | undefined {
	const text = optionalString(value);
	if (!text) return undefined;
	return scrubSecrets(text).slice(-MONITOR_OUTPUT_TAIL_LIMIT);
}

function cronSnapshots(session: AgentSessionLike): Array<Record<string, unknown>> {
	const snap = typeof session.getAsyncJobSnapshot === "function" ? asRecord(session.getAsyncJobSnapshot({ recentLimit: 20 })) : {};
	const fromSnapshot = Array.isArray(snap.crons)
		? snap.crons
		: Array.isArray(snap.cron)
			? snap.cron
			: Array.isArray(snap.cronSnapshots)
				? snap.cronSnapshots
				: undefined;
	if (fromSnapshot) return fromSnapshot.map(asRecord);
	return typeof session.getAgentId === "function" ? listCronSnapshots(session.getAgentId()).map(asRecord) : [];
}

function jobChangeKind(job: Record<string, unknown>): "job" | "monitor" | "agent" {
	if (asRecord(job.metadata).monitor === true || optionalString(job.type) === "monitor") return "monitor";
	const sub = asRecord(asRecord(job.metadata).subagent);
	if (
		optionalString(sub.id) ||
		optionalString(sub.agent) ||
		optionalString(job.type) === "subagent" ||
		optionalString(asRecord(job.metadata).agentType)
	) {
		return "agent";
	}
	return "job";
}

function jobChangeDescription(job: Record<string, unknown>): string | undefined {
	const metadata = asRecord(job.metadata);
	return optionalString(asRecord(metadata.subagent).description) ?? optionalString(metadata.description) ?? optionalString(job.label);
}

function jobSnapshot(session: AgentSessionLike): Array<Record<string, unknown>> {
	const snap =
		typeof session.getAsyncJobSnapshot === "function"
			? asRecord(session.getAsyncJobSnapshot({ recentLimit: 20 }))
			: {};
	const all = [
		...(Array.isArray(snap.running) ? snap.running : []),
		...(Array.isArray(snap.recent) ? snap.recent : []),
	].map(asRecord);
	return [...new Map(all.map(job => [String(job.id ?? ""), job])).values()].filter(job => optionalString(job.id));
}
function jobDto(job: Record<string, unknown>) {
	return {
		id: optionalString(job.id) ?? "",
		type: optionalString(job.type) ?? "job",
		status: optionalString(job.status) ?? "unknown",
		...(optionalString(job.label) ? { description: optionalString(job.label) } : {}),
		...(isoValue(job.startTime) ? { startedAt: isoValue(job.startTime) } : {}),
		...(isoValue(job.endTime) ? { endedAt: isoValue(job.endTime) } : {}),
	};
}
function jobsListModel(session: AgentSessionLike): unknown {
	return { jobs: jobSnapshot(session).map(jobDto) };
}
function agentsListModel(session: AgentSessionLike): unknown {
	const agents = jobSnapshot(session)
		.map(j => ({ job: j, sub: asRecord(asRecord(j.metadata).subagent) }))
		.filter(
			({ job, sub }) =>
				optionalString(sub.id) ||
				optionalString(sub.agent) ||
				optionalString(job.type) === "subagent" ||
				optionalString(asRecord(job.metadata).agentType),
		)
		.map(({ job, sub }) => ({
			id: optionalString(sub.id) ?? optionalString(job.id) ?? "",
			...((optionalString(sub.agent) ?? optionalString(asRecord(job.metadata).agentType) ?? undefined)
				? { agentType: optionalString(sub.agent) ?? optionalString(asRecord(job.metadata).agentType) }
				: {}),
			...((optionalString(sub.description) ?? optionalString(job.label) ?? undefined)
				? { description: optionalString(sub.description) ?? optionalString(job.label) }
				: {}),
			status: optionalString(job.status) ?? "unknown",
			...(optionalString(asRecord(job.metadata).outputRef)
				? { outputRef: optionalString(asRecord(job.metadata).outputRef) }
				: {}),
		}));
	return { agents };
}
function monitorOutputTail(session: AgentSessionLike, jobId: string): string | undefined {
	const manager = AsyncJobManager.instance();
	if (!manager) return undefined;
	const ownerId = typeof session.getAgentId === "function" ? session.getAgentId() : undefined;
	const slice = manager.readOutputSince(jobId, 0, ownerId ? { ownerId } : undefined);
	return boundedOutputTail(slice?.text);
}

function cronDto(cron: Record<string, unknown>) {
	const humanSchedule = optionalString(cron.humanSchedule) ?? optionalString(cron.human_schedule);
	const cronExpression = optionalString(cron.cronExpression) ?? optionalString(cron.cron_expression);
	const prompt = optionalString(cron.prompt);
	return {
		id: optionalString(cron.id) ?? "",
		...(humanSchedule ? { humanSchedule } : {}),
		...(cronExpression ? { cronExpression } : {}),
		...(prompt ? { prompt: scrubSecrets(prompt) } : {}),
		...(typeof cron.recurring === "boolean" ? { recurring: cron.recurring } : {}),
		...(isoValue(cron.nextFireAt) ? { nextFireAt: isoValue(cron.nextFireAt) } : {}),
		...(isoValue(cron.createdAt) ? { createdAt: isoValue(cron.createdAt) } : {}),
	};
}

function monitorsListModel(session: AgentSessionLike): unknown {
	const monitors = jobSnapshot(session)
		.filter(j => asRecord(j.metadata).monitor === true || optionalString(j.type) === "monitor")
		.map(j => {
			const id = optionalString(j.id) ?? "";
			const outputTail = id ? monitorOutputTail(session, id) : undefined;
			return {
				id,
				kind: optionalString(asRecord(j.metadata).kind) ?? optionalString(j.type),
				...((optionalString(asRecord(j.metadata).description) ?? optionalString(j.label) ?? undefined)
					? { description: optionalString(asRecord(j.metadata).description) ?? optionalString(j.label) }
					: {}),
				status: optionalString(j.status) ?? "unknown",
				...(isoValue(j.startTime) ? { startedAt: isoValue(j.startTime) } : {}),
				...(outputTail ? { outputTail } : {}),
			};
		});
	const crons = cronSnapshots(session).map(cronDto);
	return { monitors, ...(crons.length > 0 ? { crons } : {}) };
}
function compactSummaryModel(session: AgentSessionLike): unknown {
	const entries = typeof session.sessionManager?.getEntries === "function" ? session.sessionManager.getEntries() : [];
	return {
		summaries: entries
			.map(asRecord)
			.filter(e => e.type === "compaction")
			.map(e => ({
				...(optionalString(e.id) ? { id: optionalString(e.id) } : {}),
				summary: scrubSecrets(String(e.summary ?? "")).slice(0, 2000),
				...(numberValue(e.tokensBefore) !== undefined ? { tokensBefore: numberValue(e.tokensBefore) } : {}),
				timestamp: optionalString(e.timestamp) ?? "",
			})),
	};
}

function sourceFromItem(item: {
	level?: string;
	_source?: { level?: string; provider?: string; providerName?: string };
}): string {
	return (
		optionalString(item._source?.level) ??
		optionalString(item.level) ??
		optionalString(item._source?.provider) ??
		"unknown"
	);
}

async function skillsCatalog(cwd: string, includeDisabled = true): Promise<SkillCatalogEntry[]> {
	try {
		const result = await loadCapability<Skill>("skills", { cwd, includeDisabled });
		return result.items
			.map(skill => ({
				name: skill.name,
				source: sourceFromItem(skill),
				description: skill.frontmatter?.description,
				enabled: true,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

async function extensionsCatalog(cwd: string, includeDisabled = true): Promise<ExtensionCatalogEntry[]> {
	try {
		return (await loadAllExtensions(cwd))
			.filter(extension => includeDisabled || extension.state === "active")
			.map(extension => ({
				id: extension.id,
				name: extension.displayName ?? extension.name,
				kind: extension.kind,
				source: extension.source.level,
				status: extension.state,
				description: extension.description,
				state: extension.state,
				disabledReason: extension.disabledReason,
				shadowedBy: extension.shadowedBy,
				provider: extension.source.provider,
			}))
			.sort((a, b) => a.id.localeCompare(b.id));
	} catch {
		return [];
	}
}

function maskPluginSettings(plugin: InstalledPlugin, settings: Record<string, unknown>): Record<string, unknown> {
	const schemas = plugin.manifest.settings ?? {};
	const masked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(settings)) {
		masked[key] = schemas[key]?.secret === true || SECRET_KEY_PATTERN.test(key) ? "********" : value;
	}
	return masked;
}

async function pluginEntry(
	manager: PluginManager,
	plugin: InstalledPlugin,
	includePluginSettings = true,
): Promise<PluginCatalogEntry> {
	const settings = includePluginSettings
		? maskPluginSettings(plugin, await manager.getPluginSettings(plugin.name))
		: undefined;
	const entry: PluginCatalogEntry = {
		id: plugin.name,
		name: plugin.manifest.name ?? plugin.name,
		kind: "plugin",
		source: plugin.path,
		status: plugin.enabled ? "enabled" : "disabled",
		version: plugin.version,
		description: plugin.manifest.description,
		enabled: plugin.enabled,
		enabledFeatures: plugin.enabledFeatures,
		manifest: plugin.manifest,
	};
	if (settings !== undefined) entry.settings = settings;
	return entry;
}

async function pluginsCatalog(
	cwd: string,
	includeDisabled = true,
	includePluginSettings = true,
): Promise<PluginCatalogEntry[]> {
	try {
		const manager = new PluginManager(cwd);
		const plugins = await manager.list();
		return (
			await Promise.all(
				plugins
					.filter(plugin => includeDisabled || plugin.enabled)
					.map(plugin => pluginEntry(manager, plugin, includePluginSettings)),
			)
		).sort((a, b) => a.id.localeCompare(b.id));
	} catch {
		return [];
	}
}

async function toolsCatalog(
	session: AgentSessionLike,
): Promise<Array<{ name: string; active: boolean; description?: string }>> {
	const active = new Set(typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : []);
	const all = typeof session.getAllToolNames === "function" ? session.getAllToolNames() : Array.from(active);
	return Array.from(new Set(all))
		.filter(name => typeof name === "string" && name.length > 0)
		.sort((a, b) => a.localeCompare(b))
		.map(name => ({ name, active: active.has(name) }));
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function contextReadModel(session: AgentSessionLike): {
	tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };
	contextWindow?: number;
	percentUsed?: number;
	source: string;
	freshness: "live" | "post-turn";
} {
	const stats = typeof session.getSessionStats === "function" ? asRecord(session.getSessionStats()) : {};
	const statsTokens = asRecord(stats.tokens);
	const input = finiteNumber(statsTokens.input) ?? finiteNumber(stats.inputTokens) ?? 0;
	const output = finiteNumber(statsTokens.output) ?? finiteNumber(stats.outputTokens) ?? 0;
	const cacheRead = finiteNumber(statsTokens.cacheRead) ?? finiteNumber(stats.cacheReadTokens);
	const cacheWrite = finiteNumber(statsTokens.cacheWrite) ?? finiteNumber(stats.cacheWriteTokens);
	const total = finiteNumber(statsTokens.total) ?? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0);
	const context = typeof session.getContextUsage === "function" ? asRecord(session.getContextUsage()) : {};
	const contextWindow = finiteNumber(context.contextWindow);
	const rawPercent = finiteNumber(context.percent);
	const percentUsed = rawPercent !== undefined ? Math.min(rawPercent, 100) : undefined;
	return {
		tokens: {
			input,
			output,
			...(cacheRead !== undefined ? { cacheRead } : {}),
			...(cacheWrite !== undefined ? { cacheWrite } : {}),
			total,
		},
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(percentUsed !== undefined ? { percentUsed } : {}),
		source: typeof session.getSessionStats === "function" ? "AgentSession.getSessionStats" : "session-fallback",
		freshness: context.tokens === null ? "post-turn" : "live",
	};
}

function goalReadModel(session: AgentSessionLike): {
	active: boolean;
	objective?: string;
	status?: string;
	tokensUsed?: number;
} {
	const state = typeof session.getGoalModeState === "function" ? asRecord(session.getGoalModeState()) : {};
	const goal = optionalRecord(state.goal);
	const enabled = state.enabled === true;
	if (!enabled || !goal) return { active: false };
	const status = optionalString(goal.status);
	const objective = optionalString(goal.objective);
	const safeObjective = objective !== undefined ? scrubSecrets(objective).slice(0, 2000) : undefined;
	const tokensUsed = finiteNumber(goal.tokensUsed);
	return {
		active: status !== "complete" && status !== "dropped",
		...(safeObjective !== undefined ? { objective: safeObjective } : {}),
		...(status !== undefined ? { status } : {}),
		...(tokensUsed !== undefined ? { tokensUsed } : {}),
	};
}

const TEXT_LIMIT = 200;
const PREVIEW_LIMIT = 120;
const EXPORT_MAX_BYTES = 5 * 1024 * 1024;
const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9_-]{8,}/g,
	/Bearer\s+\S+/g,
	/api[_-]?key\s*[:=]\s*\S+/gi,
	/AKIA[0-9A-Z]{16}/g,
	/ASIA[0-9A-Z]{16}/g,
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/xox[baprs]-[A-Za-z0-9-]{10,}/g,
];
const SECRET_QUERY_PARAM_PATTERN = /([?&](?:state|code|code_verifier|client_secret|access_token|refresh_token|id_token|token|fingerprint)=)[^&#\s]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|secret|token|password|credential|fingerprint)\s*=\s*\S+/gi;
const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|credential|authorization|fingerprint)/i;

function truncateText(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text) return undefined;
	return text.length > limit ? text.slice(0, limit) : text;
}

async function existingCanonicalDir(value: string): Promise<string | undefined> {
	try {
		return await realpath(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function managedSessionRoots(): Promise<string[]> {
	const roots = [getSessionsDir(), path.join(getAgentDir(), "sessions")];
	const seen = new Set<string>();
	const canonical: string[] = [];
	for (const root of roots) {
		const resolved = await existingCanonicalDir(root);
		if (resolved && !seen.has(resolved)) {
			seen.add(resolved);
			canonical.push(resolved);
		}
	}
	return canonical;
}

function sessionIndexEntry(info: SessionInfo): Record<string, unknown> {
	return {
		id: info.id,
		title: truncateText(info.title, TEXT_LIMIT),
		firstMessage: truncateText(info.firstMessage, TEXT_LIMIT),
		cwd: info.cwd,
		path: info.path,
		modifiedAt: info.modified.toISOString(),
		entryCount: info.messageCount,
	};
}

async function sessionIndex(
	params: unknown,
	options: { deepContent?: boolean } = {},
): Promise<{ sessions: Record<string, unknown>[]; total: number; infos: SessionInfo[] }> {
	const record = asRecord(params);
	const scope = record.scope === "all" ? "all" : "cwd";
	const limit =
		typeof record.limit === "number" && Number.isFinite(record.limit) && record.limit >= 0
			? Math.floor(record.limit)
			: undefined;
	const offset =
		typeof record.offset === "number" && Number.isFinite(record.offset) && record.offset >= 0
			? Math.floor(record.offset)
			: 0;
	const cwd = validateCwdParam(record.cwd) ?? process.cwd();
	const all =
		scope === "all"
			? await SessionManager.listAll(undefined, options)
			: await SessionManager.list(cwd, undefined, undefined, options);
	const mapped = all.map(sessionIndexEntry);
	return {
		sessions: mapped.slice(offset, limit === undefined ? undefined : offset + limit),
		total: mapped.length,
		infos: all,
	};
}

function entryPreview(entry: Record<string, unknown>): string {
	if (entry.type === "message") {
		const message = asRecord(entry.message);
		const content = message.content;
		if (typeof content === "string") return truncateText(content, PREVIEW_LIMIT) ?? "";
		if (Array.isArray(content)) {
			const text = content
				.map(part => asRecord(part).text)
				.filter((part): part is string => typeof part === "string")
				.join(" ");
			return truncateText(text, PREVIEW_LIMIT) ?? "";
		}
	}
	for (const key of ["summary", "shortSummary", "content", "customType", "mode", "model", "type"]) {
		const preview = truncateText(entry[key], PREVIEW_LIMIT);
		if (preview) return preview;
	}
	return typeof entry.type === "string" ? entry.type : "";
}

async function validateSessionPath(value: string, options: { requireManagedRoot?: boolean } = {}): Promise<string> {
	if (!path.isAbsolute(value)) throw new Error("sessionPath must be an absolute local .jsonl path");
	if (value.split(/[\\/]/).includes("..")) throw new Error("sessionPath must not contain traversal segments");
	const normalized = path.normalize(value);
	if (path.extname(normalized) !== ".jsonl") throw new Error("sessionPath must end in .jsonl");
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(normalized);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("session file not found");
		throw error;
	}
	if (info.isSymbolicLink()) throw new Error("sessionPath must not be a symlink");
	if (!info.isFile()) throw new Error("sessionPath must reference a regular file");
	const canonicalInput = path.join(await realpath(path.dirname(normalized)), path.basename(normalized));
	const resolved = await realpath(normalized);
	if (resolved !== canonicalInput) throw new Error("sessionPath must be canonical and must not traverse symlinks");
	if (options.requireManagedRoot) {
		const roots = await managedSessionRoots();
		if (!roots.some(root => pathIsWithin(root, resolved)))
			throw new Error("session delete is limited to managed session roots");
	}
	await validateSessionHeader(normalized);
	return normalized;
}

async function validateSessionHeader(sessionPath: string): Promise<void> {
	const handle = await open(sessionPath, "r");
	let firstLine = "";
	try {
		const buffer = Buffer.allocUnsafe(4096);
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
	} finally {
		await handle.close();
	}
	if (!firstLine) throw new Error("session file is empty or missing session header");
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(firstLine) as Record<string, unknown>;
	} catch {
		throw new Error("session file has invalid session header");
	}
	if (header.type !== "session" || typeof header.id !== "string" || header.id.length === 0)
		throw new Error("session file has invalid session header");
}

function promptMessageText(prompt: unknown): string {
	if (typeof prompt === "string") return prompt;
	const record = asRecord(prompt);
	return optionalString(record.message) ?? "";
}

function isSecretPrompt(prompt: unknown, options?: { secret?: boolean }): boolean {
	if (options?.secret) return true;
	const record = asRecord(prompt);
	const fields = [record.message, record.placeholder, record.type, record.kind]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	return /api[-_ ]?key|token|password|credential|secret/i.test(fields);
}

function isKnownNonSecretPrompt(prompt: unknown): boolean {
	const text = promptMessageText(prompt);
	return /github enterprise|ghe|enterprise.*domain|domain/i.test(text);
}

function scrubSecrets(text: string): string {
	return SECRET_PATTERNS.reduce(
		(next, pattern) => next.replace(pattern, "[REDACTED]"),
		text.replace(SECRET_QUERY_PARAM_PATTERN, "$1[REDACTED]").replace(SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]"),
	);
}

function previewValue(value: unknown): string {
	// Callers pass structurally redacted values; scrubbing serialized JSON here
	// would be delimiter-unaware and can swallow neighboring fields.
	return (typeof value === "string" ? scrubSecrets(value) : (JSON.stringify(value ?? null) ?? "null")).slice(0, 200);
}

function sanitizedKeyFor(key: string, used: Set<string>): string {
	const base = scrubSecrets(key);
	let candidate = base;
	for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}#${suffix}`;
	used.add(candidate);
	return candidate;
}

function redactExportValue(value: unknown, keyName?: string): unknown {
	if (keyName && SECRET_KEY_PATTERN.test(keyName)) return "[REDACTED]";
	if (Array.isArray(value)) return value.map(item => redactExportValue(item));
	if (!value || typeof value !== "object") return typeof value === "string" ? scrubSecrets(value) : value;
	const record = value as Record<string, unknown>;
	if (record.type === "toolCall")
		return {
			type: "toolCall",
			name: typeof record.name === "string" ? scrubSecrets(record.name) : record.name,
			preview: previewValue(redactObjectEntries(asRecord(record.arguments))),
		};
	const next: Record<string, unknown> = {};
	const usedKeys = new Set<string>();
	for (const [key, item] of Object.entries(record)) {
		next[sanitizedKeyFor(key, usedKeys)] =
			record.role === "toolResult" && key === "content"
				? previewValue(redactExportValue(item))
				: redactExportValue(item, key);
	}
	return next;
}

function redactObjectEntries(record: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	const usedKeys = new Set<string>();
	for (const [key, item] of Object.entries(record)) next[sanitizedKeyFor(key, usedKeys)] = redactExportValue(item, key);
	return next;
}

function exportMessagesFromEntries(entries: ReturnType<SessionManager["getEntriesForExport"]>): unknown[] {
	return (entries as unknown[]).flatMap(rawEntry => {
		const entry = asRecord(rawEntry);
		if (entry.type === "message") return [entry.message];
		if (entry.type === "branch_summary")
			return [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: entry.timestamp }];
		if (entry.type === "compaction")
			return [
				{
					role: "compactionSummary",
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
					timestamp: entry.timestamp,
				},
			];
		return [];
	});
}

async function sessionRenameModel(params: unknown): Promise<{ ok: true; title: string }> {
	const record = asRecord(params);
	const sessionPath = optionalString(record.sessionPath);
	const title = typeof record.title === "string" ? record.title.trim() : "";
	if (!sessionPath) throw new Error("sessionPath must not be empty");
	if (!title || title.length > 200) throw new Error("title must be 1..200 characters after trim");
	const manager = await SessionManager.open(await validateSessionPath(sessionPath));
	const ok = await manager.setSessionName(title, "user");
	if (!ok) throw new Error("session title was not updated");
	return { ok: true, title: manager.getSessionName() ?? title };
}

async function sessionDeleteModel(params: unknown): Promise<{ ok: true }> {
	const record = asRecord(params);
	const sessionPath = optionalString(record.sessionPath);
	if (!sessionPath) throw new Error("sessionPath must not be empty");
	await new FileSessionStorage().deleteSessionWithArtifacts(
		await validateSessionPath(sessionPath, { requireManagedRoot: true }),
	);
	return { ok: true };
}
async function sessionExportModel(params: unknown): Promise<Record<string, unknown>> {
	const record = asRecord(params);
	const sessionPath = optionalString(record.sessionPath);
	const format = record.format === "json" ? "json" : record.format === "markdown" ? "markdown" : undefined;
	const redact = record.redact !== false;
	if (!sessionPath) throw new Error("sessionPath must not be empty");
	if (!format) throw new Error("format must be markdown or json");
	const validatedPath = await validateSessionPath(sessionPath);
	const manager = await SessionManager.open(validatedPath);
	const entries = manager.getEntriesForExport();
	const header = (entries as unknown[]).map(asRecord).find(entry => entry.type === "session") as
		| { id?: string }
		| undefined;
	let messages = exportMessagesFromEntries(entries);
	if (redact) messages = redactExportValue(messages) as unknown[];
	let content =
		format === "json"
			? JSON.stringify({ messages }, null, 2)
			: formatSessionDumpText({ messages: messages as Parameters<typeof formatSessionDumpText>[0]["messages"] });
	// Structured redaction already ran before serialization; regex-scrubbing
	// serialized JSON can consume delimiters and corrupt syntax, so the final
	// text scrub applies to markdown only.
	if (redact && format === "markdown") content = scrubSecrets(content);
	if (new TextEncoder().encode(content).byteLength > EXPORT_MAX_BYTES)
		throw new Error("session export exceeds 5MB cap");
	return {
		content,
		format,
		provenance: {
			exportedAt: new Date().toISOString(),
			sessionId: manager.getSessionId?.() ?? header?.id ?? "",
			sourcePath: validatedPath,
			redacted: redact,
			tool: "gjc-app-server",
		},
	};
}

function sessionTreeModel(session: AgentSessionLike): { nodes: unknown[]; activeLeafId?: string } {
	const manager = session.sessionManager;
	if (!manager?.getTree) throw new Error("session tree is not supported by AgentSession");
	const activeLeafId = manager.getLeafId?.() ?? undefined;
	const activeIds = new Set<string>();
	const markActive = (node: SessionTreeNode): boolean => {
		const self = node.entry.id === activeLeafId;
		const childActive = node.children.some(markActive);
		if (self || childActive) activeIds.add(node.entry.id);
		return self || childActive;
	};
	const roots = manager.getTree() as SessionTreeNode[];
	roots.forEach(markActive);
	const mapNode = (node: SessionTreeNode): Record<string, unknown> => ({
		id: node.entry.id,
		parentId: node.entry.parentId ?? undefined,
		type: node.entry.type,
		label: node.label,
		preview: entryPreview(node.entry as unknown as Record<string, unknown>),
		timestamp: node.entry.timestamp,
		active: activeIds.has(node.entry.id),
		children: node.children.map(mapNode),
	});
	return { nodes: roots.map(mapNode), activeLeafId };
}

async function commandsCatalog(cwd: string): Promise<CommandCatalogEntry[]> {
	const commands: CommandCatalogEntry[] = [];
	const seen = new Set<string>();
	const addCommand = (entry: { name: string; source: CommandCatalogEntry["source"]; description?: string }) => {
		const key = `${entry.source}:${entry.name}`;
		if (seen.has(key)) return;
		seen.add(key);
		commands.push({
			name: entry.name,
			source: entry.source,
			description: entry.description,
			classification: commandClassification(entry.name, entry.source),
		});
	};
	for (const command of BUILTIN_SLASH_COMMANDS) {
		addCommand({ name: slashName(command.name), source: "builtin", description: command.description });
	}
	try {
		for (const command of await loadSlashCommands({ cwd })) {
			addCommand({ name: slashName(command.name), source: "file", description: command.description });
		}
	} catch {
		// Catalog reads are best-effort: command discovery warnings must not break state reads.
	}
	try {
		for (const skill of await skillsCatalog(cwd, true)) {
			addCommand({ name: `/skill:${skill.name}`, source: "skill", description: skill.description });
		}
	} catch {
		// Catalog reads are best-effort: command discovery warnings must not break state reads.
	}
	try {
		for (const extension of await loadAllExtensions(cwd)) {
			if (extension.kind !== "slash-command") continue;
			addCommand({ name: slashName(extension.name), source: "extension", description: extension.description });
		}
	} catch {
		// Catalog reads are best-effort: command discovery warnings must not break state reads.
	}
	return commands.sort((a, b) => a.name.localeCompare(b.name));
}

class AppServerHostUriProtocolHandler implements ProtocolHandler {
	readonly scheme: string;
	readonly immutable = false;
	readonly #host: AgentSessionHost;

	constructor(scheme: string, host: AgentSessionHost) {
		this.scheme = scheme;
		this.#host = host;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		return this.#host.resolveHostUri(url, context);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		return this.#host.writeHostUri(url, content, context);
	}
}

const MAX_PENDING_EVENTS = 512;

function subscribeThreadEvents(threadId: string, thread: ThreadRecord, emit: AppServerEventEmitter): () => void {
	return thread.session.subscribe((event: AgentSessionEvent) => {
		if (thread.generation > 0) {
			emit(threadId, thread.generation, event.type, jsonClone(event));
			return;
		}
		if (thread.pendingEvents.length >= MAX_PENDING_EVENTS) {
			const droppedEvents = thread.pendingEvents.length - MAX_PENDING_EVENTS + 1;
			thread.pendingEvents.splice(0, droppedEvents);
			console.debug(JSON.stringify({ event: "gjc.appServer.pendingEvents.dropped", threadId, droppedEvents }));
		}
		thread.pendingEvents.push(event);
	});
}
function cronSnapshotSignature(session: AgentSessionLike): string {
	return JSON.stringify(
		cronSnapshots(session)
			.map(cronDto)
			.sort((a, b) => a.id.localeCompare(b.id)),
	);
}

function emitJobChange(threadId: string, thread: ThreadRecord, emit: AppServerEventEmitter, payload: unknown): void {
	if (thread.generation > 0) {
		emit(threadId, thread.generation, "jobs_changed", payload);
		return;
	}
	if (thread.pendingJobChanges.length >= MAX_PENDING_EVENTS) {
		const droppedEvents = thread.pendingJobChanges.length - MAX_PENDING_EVENTS + 1;
		thread.pendingJobChanges.splice(0, droppedEvents);
		console.debug(JSON.stringify({ event: "gjc.appServer.pendingJobChanges.dropped", threadId, droppedEvents }));
	}
	thread.pendingJobChanges.push(payload);
}

function subscribeJobChanges(threadId: string, thread: ThreadRecord, emit: AppServerEventEmitter): () => void {
	if (typeof thread.session.getAsyncJobSnapshot !== "function") return () => {};
	let previous = new Map<string, { status: string; job: Record<string, unknown> }>();
	let previousCronSignature = cronSnapshotSignature(thread.session);
	const snapshotMap = () =>
		new Map(
			jobSnapshot(thread.session).map(job => [
				optionalString(job.id) ?? "",
				{ status: optionalString(job.status) ?? "unknown", job },
			]),
		);
	previous = snapshotMap();
	const emitChanges = () => {
		const next = snapshotMap();
		for (const [id, current] of next) {
			const prior = previous.get(id);
			if (prior?.status === current.status) continue;
			const description = jobChangeDescription(current.job);
			emitJobChange(threadId, thread, emit, {
				kind: jobChangeKind(current.job),
				id,
				status: current.status,
				...(description ? { description } : {}),
			});
		}
		previous = next;

		const nextCronSignature = cronSnapshotSignature(thread.session);
		if (nextCronSignature !== previousCronSignature) {
			previousCronSignature = nextCronSignature;
			emitJobChange(threadId, thread, emit, { kind: "monitor", id: "crons", status: "changed" });
		}
	};
	const unsubscribers: Array<() => void> = [];
	const observerUnsubscribe = thread.session.jobsObserver?.onChange?.(emitChanges);
	if (observerUnsubscribe) unsubscribers.push(observerUnsubscribe);
	else {
		const manager = AsyncJobManager.instance();
		if (manager) unsubscribers.push(manager.onChange(emitChanges));
	}
	unsubscribers.push(onCronChange(emitChanges));
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}

function combineUnsubscribers(...unsubscribers: Array<() => void>): () => void {
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
}

export class AgentSessionHost implements AppServerHost {
	readonly #threads = new Map<string, ThreadRecord>();
	#emit: AppServerEventEmitter;
	#notificationHandler: ((method: string, params: unknown) => unknown) | undefined;
	readonly #sessionFactory: SessionFactory;
	#appServer: NativeAppServerBridge | undefined;
	readonly #hostUriRegisteredSchemes = new Set<string>();
	#fallbackAuthStorage: Promise<AuthStorage> | undefined;
	readonly #authStorageFactory: () => Promise<AuthStorage>;
	readonly #loginFlows = new Map<string, { providerId: string; state: string; authUrl?: string; promptMessage?: string; inputSlot?: (value: string) => void; abort?: AbortController }>();

	constructor(options: AgentSessionHostOptions = {}) {
		this.#emit = options.emit ?? (() => {});
		this.#sessionFactory = (options.sessionFactory ?? createAgentSession) as SessionFactory;
		this.#appServer = options.appServer;
		this.#authStorageFactory = options.authStorageFactory ?? (() => discoverAuthStorage());
	}

	#connectionAuthStorage(): Promise<AuthStorage> {
		this.#fallbackAuthStorage ??= this.#authStorageFactory();
		return this.#fallbackAuthStorage;
	}

	#registerThread(session: AgentSessionLike, cwd: string, metadata: Record<string, unknown>): CreatedThread {
		const threadId = session.sessionId;
		const existing = this.#threads.get(threadId);
		if (existing) {
			existing.unsubscribe();
			if (typeof existing.session.dispose === "function") void existing.session.dispose();
			const returnedMetadata = normalizeSessionMetadata(metadata, threadId);
			const thread: ThreadRecord = {
				session,
				generation: 0,
				cwd,
				metadata: returnedMetadata,
				unsubscribe: () => {},
				hostUriSchemes: new Map(),
				pendingEvents: [],
				pendingJobChanges: [],
			};
			thread.unsubscribe = combineUnsubscribers(
				subscribeThreadEvents(threadId, thread, this.#emit),
				subscribeJobChanges(threadId, thread, this.#emit),
			);
			this.#threads.set(threadId, thread);
			return { threadId, sessionMetadata: returnedMetadata, resumed: true };
		}
		const returnedMetadata = normalizeSessionMetadata(metadata, threadId);
		const thread: ThreadRecord = {
			session,
			generation: 1,
			cwd,
			metadata: returnedMetadata,
			unsubscribe: () => {},
			hostUriSchemes: new Map(),
			pendingEvents: [],
			pendingJobChanges: [],
		};
		thread.unsubscribe = combineUnsubscribers(
			subscribeThreadEvents(threadId, thread, this.#emit),
			subscribeJobChanges(threadId, thread, this.#emit),
		);
		this.#threads.set(threadId, thread);
		return { threadId, sessionMetadata: returnedMetadata, resumed: false };
	}

	setEmitter(emit: AppServerEventEmitter): void {
		this.#emit = emit;
	}

	setAppServer(appServer: NativeAppServerBridge): void {
		this.#appServer = appServer;
	}

	/** Register the session's notifications endpoint so `gjc/notifications/*`
	 * frames route to it. When unset, subscribe replays nothing and other
	 * notification calls ack. */
	setNotificationHandler(handler: (method: string, params: unknown) => unknown): void {
		this.#notificationHandler = handler;
	}

	async notificationCall(method: string, params: unknown): Promise<unknown> {
		if (this.#notificationHandler) return this.#notificationHandler(method, params);
		const suffix = method.startsWith("gjc/notifications/") ? method.slice("gjc/notifications/".length) : method;
		return suffix === "subscribe" ? [] : { ok: true };
	}

	async createThread(params: unknown): Promise<CreatedThread> {
		const metadata = normalizeSessionMetadata(params);
		const cwd = optionalString(metadata.cwd) ?? process.cwd();
		metadata.cwd = cwd;
		let threadId = "";
		const hostTools: CustomTool[] = hostToolDescriptors(params).map(descriptor => ({
			name: descriptor.name,
			label: descriptor.name,
			description: descriptor.description,
			parameters: z.record(z.string(), z.unknown()),
			execute: async (_toolCallId, toolParams) => {
				const bridge = this.#appServer;
				if (!bridge) throw new Error("host tool bridge is not attached");
				const registered = bridge.hostToolNames(threadId);
				if (!registered.includes(descriptor.name)) throw new Error(`host tool not registered: ${descriptor.name}`);
				const turnId = bridge.activeTurnId(threadId);
				if (!turnId) throw new Error(`no active turn for host tool: ${descriptor.name}`);
				const resultJson = await bridge.callHostTool(
					threadId,
					turnId,
					descriptor.name,
					JSON.stringify(toolParams ?? {}),
				);
				return hostToolResult(JSON.parse(resultJson));
			},
		}));
		const { session } = await this.#sessionFactory(createOptionsFromMetadata(metadata, hostTools));
		threadId = session.sessionId;
		if (typeof session.setWorkflowGateEmitter === "function") {
			const emitter: WorkflowGateEmitter = {
				isUnattended: () => this.#appServer?.isWorkflowGateUnattended?.(threadId) ?? true,
				emitGate: async (input: OpenGateInput) => {
					const bridge = this.#appServer;
					if (!bridge?.openWorkflowGate) throw new Error("workflow gate bridge is not attached");
					const answerJson = await bridge.openWorkflowGate(threadId, JSON.stringify(input));
					return JSON.parse(answerJson);
				},
				listPendingGates: () => [],
				resolveGate: async (_response: RpcWorkflowGateResponse): Promise<RpcWorkflowGateResolution> => {
					throw new Error("workflow gate resolve is handled by gjc/workflowGate/respond");
				},
				onGateEmitted: (_listener: (gate: RpcWorkflowGate) => void) => () => {},
			};
			session.setWorkflowGateEmitter(emitter);
		}
		return this.#registerThread(session, cwd, metadata);
	}

	async sessionOpen(params: unknown): Promise<CreatedThread> {
		const record = asRecord(params);
		const sessionPath = optionalString(record.sessionPath);
		if (!sessionPath) throw new Error("sessionPath must not be empty");
		const manager = await SessionManager.open(await validateSessionPath(sessionPath));
		const cwd = manager.getCwd();
		const metadata = normalizeSessionMetadata({ ...record, cwd });
		const { session } = await this.#sessionFactory({
			...createOptionsFromMetadata(metadata, []),
			sessionManager: manager,
		});
		const registered = this.#registerThread(session, cwd, metadata);
		return {
			...registered,
			resumed: true,
			sessionMetadata: {
				...metadata,
				sessionId: session.sessionId,
				generation: registered.sessionMetadata?.generation,
			},
		};
	}

	async resumeThread(params: unknown): Promise<CreatedThread> {
		const created = await this.createThread(params);
		return {
			...created,
			resumed: false,
			sessionMetadata: { ...(created.sessionMetadata ?? {}), resumed: false },
		};
	}

	async forkThread(params: unknown): Promise<CreatedThread> {
		const record = asRecord(params);
		const metadata = normalizeSessionMetadata(params);
		const sourceThreadId =
			optionalString(record.threadId) ??
			optionalString(record.sourceThreadId) ??
			optionalString(record.parentThreadId) ??
			optionalString(asRecord(record.metadata).threadId);
		const source = sourceThreadId ? this.#threads.get(sourceThreadId) : undefined;
		if (sourceThreadId && !source) throw new Error(`unknown fork source thread: ${sourceThreadId}`);
		if (!source) return this.createThread(params);
		const entryId =
			optionalString(record.entryId) ??
			optionalString(record.leafEntryId) ??
			source.session.sessionManager?.getLeafId?.() ??
			undefined;
		if (entryId && typeof source.session.navigateTree === "function")
			await source.session.navigateTree(entryId, { summarize: false });
		const cwd = optionalString(metadata.cwd) ?? source.cwd;
		metadata.cwd = cwd;
		metadata.forkedFromId = sourceThreadId;
		const options = createOptionsFromMetadata(metadata, []);
		if (typeof source.session.buildForkContextSeed === "function") {
			options.forkContextSeed = await source.session.buildForkContextSeed({
				maxMessages: 500,
				maxTokens: 200_000,
				cacheIdentity: sourceThreadId,
			});
		} else if (typeof source.session.branch === "function" && entryId) {
			await source.session.branch(entryId);
		} else {
			throw new Error("fork context seeding unsupported");
		}
		const { session } = await this.#sessionFactory(options);
		const created = this.#registerThread(session, cwd, metadata);
		return { ...created, sessionMetadata: { ...(created.sessionMetadata ?? {}), forkedFromId: sourceThreadId } };
	}

	#settingsSession(): AgentSessionLike | undefined {
		return this.#threads.values().next().value?.session;
	}

	async settingsSchema(): Promise<unknown> {
		return settingsSchemaModel();
	}

	async settingsRead(): Promise<unknown> {
		return settingsReadModel(this.#settingsSession());
	}

	async settingsUpdate(params: unknown): Promise<unknown> {
		return settingsUpdateModel(params, this.#settingsSession());
	}
	async appearanceThemesList(): Promise<unknown> {
		return appearanceThemesListModel();
	}

	async appearanceRead(): Promise<unknown> {
		return appearanceReadModel(this.#settingsSession());
	}

	async appearanceSet(params: unknown): Promise<unknown> {
		return appearanceSetModel(params, this.#settingsSession());
	}

	async providerList(): Promise<unknown> {
		return providerListModel(undefined, () => this.#connectionAuthStorage());
	}

	async authStatus(): Promise<unknown> {
		return authStatusModel(undefined, () => this.#connectionAuthStorage());
	}

	async authLogout(params: unknown): Promise<unknown> {
		return authLogoutModel(params, undefined, () => this.#connectionAuthStorage());
	}

	async providerAdd(params: unknown): Promise<unknown> {
		return providerAddModel(params, [...this.#threads.values()].map(thread => thread.session));
	}

	async authLoginStart(params: unknown): Promise<unknown> {
		const providerId = optionalString(asRecord(params).providerId);
		if (!providerId) throw new Error("providerId is required");
		const storage = (await this.#connectionAuthStorage()) as AuthStorage & { login?: (providerId: string, callbacks: Record<string, unknown>) => Promise<unknown> };
		const flowId = crypto.randomUUID();
		const abort = new AbortController();
		const flow = { providerId, state: "idle", abort };
		this.#loginFlows.set(flowId, flow);
		const audit = (state: string) => console.info(JSON.stringify({ event: "gjc.auth.login", providerId, flowId, state }));
		let firstTransitionResolved = false;
		let resolveFirstTransition!: () => void;
		const firstTransition = new Promise<void>(resolve => {
			resolveFirstTransition = resolve;
		});
		const markFirstTransition = () => {
			if (firstTransitionResolved) return;
			firstTransitionResolved = true;
			resolveFirstTransition();
		};
		const startTimeout = setTimeout(() => {
			if (flow.state === "idle") {
				flow.state = "failed";
				audit(flow.state);
			}
			markFirstTransition();
		}, 5000);
		if (typeof storage.login !== "function") {
			flow.state = "failed";
			audit(flow.state);
			markFirstTransition();
			clearTimeout(startTimeout);
		}
		void storage.login?.(providerId, {
			signal: abort.signal,
			onAuth: (info: { url?: string; authUrl?: string; instructions?: string }) => {
				const authUrl = info.authUrl ?? info.url;
				flow.authUrl = authUrl ? scrubSecrets(authUrl) : undefined;
				flow.promptMessage = info.instructions ? scrubSecrets(info.instructions) : undefined;
				flow.state = "pending-browser";
				audit(flow.state);
				markFirstTransition();
			},
			onManualCodeInput: () => new Promise<string>(resolve => { flow.inputSlot = resolve; }),
			onPrompt: (prompt: unknown, options?: { secret?: boolean }) => {
				if (isSecretPrompt(prompt, options) || !isKnownNonSecretPrompt(prompt)) {
					flow.state = "unsupported";
					audit(flow.state);
					markFirstTransition();
					throw new Error("credential prompt login is unsupported");
				}
				flow.promptMessage = scrubSecrets(promptMessageText(prompt));
				flow.state = "needs-input";
				audit(flow.state);
				markFirstTransition();
				return Promise.resolve("");
			},
		}).then(
			() => { flow.state = abort.signal.aborted ? "cancelled" : "authenticated"; audit(flow.state); markFirstTransition(); },
			() => { flow.state = abort.signal.aborted ? "cancelled" : flow.state === "unsupported" ? "unsupported" : "failed"; audit(flow.state); markFirstTransition(); },
		).finally(() => clearTimeout(startTimeout));
		await firstTransition;
		return { flowId, state: flow.state, ...(flow.authUrl ? { authUrl: flow.authUrl } : {}), ...(flow.promptMessage ? { instructions: flow.promptMessage } : {}) };
	}

	async authLoginPoll(params: unknown): Promise<unknown> {
		const flow = this.#loginFlows.get(optionalString(asRecord(params).flowId) ?? "");
		if (!flow) throw new Error("unknown login flow");
		return { state: flow.state, ...(flow.promptMessage ? { promptMessage: flow.promptMessage } : {}) };
	}

	async authLoginComplete(params: unknown): Promise<unknown> {
		const record = asRecord(params);
		const flow = this.#loginFlows.get(optionalString(record.flowId) ?? "");
		const redirectUrl = optionalString(record.redirectUrl);
		if (!flow || !redirectUrl) throw new Error("flowId and redirectUrl are required");
		flow.inputSlot?.(redirectUrl);
		console.info(JSON.stringify({ event: "gjc.auth.login", providerId: flow.providerId, flowId: optionalString(record.flowId), state: flow.state }));
		return { state: flow.state };
	}

	async authLoginCancel(params: unknown): Promise<unknown> {
		const flowId = optionalString(asRecord(params).flowId) ?? "";
		const flow = this.#loginFlows.get(flowId);
		if (!flow) throw new Error("unknown login flow");
		flow.abort?.abort();
		flow.state = "cancelled";
		console.info(JSON.stringify({ event: "gjc.auth.login", providerId: flow.providerId, flowId, state: flow.state }));
		return { state: flow.state };
	}

	async extensionsSetEnabled(params: unknown): Promise<unknown> {
		const record = asRecord(params);
		const extensionId = optionalString(record.extensionId);
		if (!extensionId || typeof record.enabled !== "boolean") throw new Error("extensionId and enabled are required");
		await requireExtensionId(process.cwd(), extensionId);
		return disabledExtensionToggle(extensionId, record.enabled);
	}

	async skillsSetEnabled(params: unknown): Promise<unknown> {
		const record = asRecord(params);
		const skillId = optionalString(record.skillId);
		if (!skillId || typeof record.enabled !== "boolean") throw new Error("skillId and enabled are required");
		await requireSkillId(process.cwd(), skillId);
		return disabledExtensionToggle(`skill:${skillId}`, record.enabled);
	}

	async pluginsSetEnabled(params: unknown): Promise<unknown> {
		const record = asRecord(params);
		const pluginId = optionalString(record.pluginId);
		if (!pluginId || typeof record.enabled !== "boolean") throw new Error("pluginId and enabled are required");
		const manager = new PluginManager();
		await requirePlugin(manager, pluginId);
		await manager.setEnabled(pluginId, record.enabled);
		return { ok: true, enabled: record.enabled };
	}

	async pluginsSetFeature(params: unknown): Promise<unknown> {
		const record = asRecord(params);
		const pluginId = optionalString(record.pluginId);
		const feature = optionalString(record.feature);
		if (!pluginId || !feature || typeof record.enabled !== "boolean") throw new Error("pluginId, feature, and enabled are required");
		const manager = new PluginManager();
		const plugin = await requirePlugin(manager, pluginId);
		if (!plugin.manifest.features?.[feature]) throw new Error(`unknown plugin feature: ${pluginId}/${feature}`);
		const current = (await manager.getEnabledFeatures(pluginId)) ?? [];
		const next = record.enabled ? [...new Set([...current, feature])] : current.filter(value => value !== feature);
		await manager.setEnabledFeatures(pluginId, next);
		return { ok: true };
	}

	async pluginsSetSetting(params: unknown): Promise<unknown> {
		const record = asRecord(params);
		const pluginId = optionalString(record.pluginId);
		const key = optionalString(record.key);
		if (!pluginId || !key || !("value" in record)) throw new Error("pluginId, key, and value are required");
		const manager = new PluginManager();
		const plugin = await requirePlugin(manager, pluginId);
		if (!plugin.manifest.settings?.[key]) throw new Error(`unknown plugin setting: ${pluginId}/${key}`);
		const previous = (await manager.getPluginSettings(pluginId))[key];
		try {
			await manager.setPluginSetting(pluginId, key, record.value);
		} catch (error) {
			if (previous === undefined) await manager.deletePluginSetting(pluginId, key);
			else await manager.setPluginSetting(pluginId, key, previous);
			throw error;
		}
		return isSecretSettingKey(key) ? { ok: true, value: "********" } : { ok: true, value: record.value };
	}

	async sessionList(params: unknown): Promise<unknown> {
		const { sessions, total } = await sessionIndex(params);
		return { sessions, total };
	}

	async sessionSearch(params: unknown): Promise<unknown> {
		const record = asRecord(params);
		const query = optionalString(record.query);
		if (!query) throw new Error("query must not be empty");
		const list = await sessionIndex({ ...record, offset: 0, limit: undefined }, { deepContent: true });
		const scored = list.infos
			.map(info => ({
				info,
				score: fuzzySearchScore(
					query,
					[info.title, info.firstMessage, info.id, info.cwd, info.path, info.allMessagesText]
						.filter(Boolean)
						.join("\n"),
				),
			}))
			.filter((item): item is { info: SessionInfo; score: number } => item.score !== undefined)
			.sort((a, b) => a.score - b.score);
		const limit =
			typeof record.limit === "number" && Number.isFinite(record.limit) && record.limit >= 0
				? Math.floor(record.limit)
				: undefined;
		return { sessions: scored.map(item => sessionIndexEntry(item.info)).slice(0, limit), total: scored.length };
	}

	async sessionRename(params: unknown): Promise<unknown> {
		return sessionRenameModel(params);
	}

	async sessionDelete(params: unknown): Promise<unknown> {
		return sessionDeleteModel(params);
	}

	async sessionExport(params: unknown): Promise<unknown> {
		return sessionExportModel(params);
	}

	async backendCall(threadId: string, method: string, params: unknown, generation?: number): Promise<unknown> {
		const thread = this.#threads.get(threadId);
		if (!thread) throw new Error(`unknown thread: ${threadId}`);
		const session = thread.session;
		const record = asRecord(params);
		if (typeof generation === "number" && Number.isFinite(generation) && generation > 0) {
			thread.generation = generation;
			if (thread.pendingEvents.length > 0) {
				const pending = thread.pendingEvents.splice(0);
				for (const event of pending) this.#emit(threadId, thread.generation, event.type, jsonClone(event));
			}
			if (thread.pendingJobChanges.length > 0) {
				const pending = thread.pendingJobChanges.splice(0);
				for (const payload of pending) this.#emit(threadId, thread.generation, "jobs_changed", jsonClone(payload));
			}
		}

		switch (method) {
			case "sessionMove":
				return sessionMoveModel(thread, params);
			case "modelAssign":
				return modelAssignModel(session, params);
			case "prompt": {
				const text = optionalString(record.text) ?? optionalString(record.input) ?? "";
				const options = record.options && typeof record.options === "object" ? record.options : undefined;
				await session.prompt(text, options as Parameters<AgentSession["prompt"]>[1]);
				return { turnId: `${threadId}:${thread.generation}` };
			}
			case "steer": {
				const text = optionalString(record.text) ?? optionalString(record.input) ?? "";
				const images = Array.isArray(record.images) ? record.images : undefined;
				await session.steer(text, images as Parameters<AgentSession["steer"]>[1]);
				return { turnId: `${threadId}:${thread.generation}` };
			}
			case "abort":
				await session.abort();
				return { ok: true };
			case "retry": {
				if (typeof session.retry !== "function") throw new Error("retry is not supported by this session");
				const didRetry = await session.retry();
				if (!didRetry) throw new Error("Nothing to retry");
				return { turnId: `${threadId}:${thread.generation}` };
			}
			case "getState": {
				if (includeRequests(params, "tools")) return { tools: await toolsCatalog(session) };
				if (includeRequests(params, "commands")) return { commands: await commandsCatalog(thread.cwd) };
				if (includeRequests(params, "skills"))
					return { skills: await skillsCatalog(thread.cwd, includeDisabled(params)) };
				if (includeRequests(params, "extensions"))
					return { extensions: await extensionsCatalog(thread.cwd, includeDisabled(params)) };
				if (includeRequests(params, "plugins"))
					return { plugins: await pluginsCatalog(thread.cwd, includeDisabled(params), includeSettings(params)) };
				return typeof session.getSessionState === "function" ? session.getSessionState() : (session.state ?? null);
			}
			case "readContext":
				return contextReadModel(session);
			case "readGoal":
				return goalReadModel(session);
			case "modelCatalog":
				return modelCatalogModel(session);
			case "readThinking":
				return thinkingReadModel(session);
			case "setThinking":
				return setThinkingModel(session, record.level);
			case "readFast":
				return fastReadModel(session);
			case "setFast":
				return setFastModel(session, record.enabled);
			case "readTodos":
				return todosReadModel(session);
			case "readUsage":
				return usageReadModel(session);
			case "listJobs":
				return jobsListModel(session);
			case "listAgents":
				return agentsListModel(session);
			case "listMonitors":
				return monitorsListModel(session);
			case "compactSummary":
				return compactSummaryModel(session);
			case "sessionTree":
				return sessionTreeModel(session);
			case "sessionNavigate": {
				if (typeof session.navigateTree !== "function")
					throw new Error("sessionNavigate is not supported by this session");
				const entryId = optionalString(record.entryId);
				if (!entryId) throw new Error("entryId must not be empty");
				await session.navigateTree(entryId, { summarize: record.summarize === true });
				return { ok: true, activeLeafId: session.sessionManager?.getLeafId?.() ?? undefined };
			}
			case "sessionLabel": {
				const entryId = optionalString(record.entryId);
				if (!entryId) throw new Error("entryId must not be empty");
				if (typeof session.sessionManager?.appendLabelChange !== "function")
					throw new Error("sessionLabel is not supported by this session");
				const label = optionalString(record.label)?.trim();
				if (label && label.length > 200) throw new Error("label must be 200 characters or fewer");
				session.sessionManager.appendLabelChange(entryId, label);
				return { ok: true };
			}
			case "getMessages":
				return typeof session.getMessages === "function" ? session.getMessages() : (session.messages ?? []);
			case "setModel": {
				if (typeof session.setModel !== "function") throw new Error("setModel is not supported by this session");
				const provider = record.provider;
				const modelId = record.modelId ?? record.model;
				await session.setModel({ provider, modelId });
				return { ok: true };
			}
			case "compact":
				if (typeof session.compact !== "function") throw new Error("compact is not supported by this session");
				return session.compact(optionalString(record.customInstructions) ?? optionalString(record.instructions));
			case "setTodos":
				if (typeof session.setTodos !== "function") throw new Error("setTodos is not supported by AgentSession");
				return session.setTodos("todos" in record ? record.todos : params);
			case "exec": {
				const command = commandFromValue(record.command) ?? commandFromValue(params);
				if (!command) throw new Error("exec requires a string command or string[] command payload");
				return session.executeBash(
					command,
					undefined,
					execOptions(record) as Parameters<AgentSession["executeBash"]>[2],
				);
			}
			case "usageSnapshot": {
				const stats = typeof session.getSessionStats === "function" ? asRecord(session.getSessionStats()) : {};
				const tokenCandidates: unknown[] = [
					stats.tokens,
					stats.totalTokens,
					stats.total_tokens,
					stats.inputTokens,
					stats.outputTokens,
				];
				const tokens = tokenCandidates.reduce<number>(
					(sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
					0,
				);
				const cost =
					typeof stats.cost_usd === "number"
						? stats.cost_usd
						: typeof stats.costUsd === "number"
							? stats.costUsd
							: 0;
				return { tokens, cost_usd: cost };
			}
			case "dispose":
				thread.unsubscribe();
				thread.pendingEvents.splice(0);
				thread.pendingJobChanges.splice(0);
				this.#threads.delete(threadId);
				await session.dispose();
				return { ok: true };
			default:
				throw new Error(`unknown backend method: ${method}`);
		}
	}

	setHostUriSchemes(
		threadId: string,
		schemes: Array<{ scheme: string; writable?: boolean; immutable?: boolean }>,
	): string[] {
		const thread = this.#threads.get(threadId);
		if (!thread) throw new Error(`unknown thread: ${threadId}`);
		thread.hostUriSchemes = new Map(
			schemes.map(scheme => [
				scheme.scheme.toLowerCase(),
				{ writable: scheme.writable === true, immutable: scheme.immutable === true },
			]),
		);
		const activeSchemes = new Set<string>();
		for (const record of this.#threads.values()) {
			for (const scheme of record.hostUriSchemes.keys()) activeSchemes.add(scheme);
		}
		const router = InternalUrlRouter.instance();
		for (const scheme of this.#hostUriRegisteredSchemes) {
			if (!activeSchemes.has(scheme)) {
				router.unregister(scheme);
				this.#hostUriRegisteredSchemes.delete(scheme);
			}
		}
		for (const scheme of activeSchemes) {
			if (!this.#hostUriRegisteredSchemes.has(scheme)) {
				router.register(new AppServerHostUriProtocolHandler(scheme, this));
				this.#hostUriRegisteredSchemes.add(scheme);
			}
		}
		return Array.from(thread.hostUriSchemes.keys()).sort();
	}

	async resolveHostUri(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const threadId = context?.threadId ?? context?.sessionId;
		if (!threadId) throw new Error(`Host URI ${url.href} requires a thread-scoped read context`);
		const thread = this.#threads.get(threadId);
		if (!thread) throw new Error(`unknown thread for Host URI ${url.href}: ${threadId}`);
		const scheme = url.protocol.replace(/:$/, "").toLowerCase();
		const definition = thread.hostUriSchemes.get(scheme);
		if (!definition) throw new Error(`Host URI scheme is not registered for thread ${threadId}: ${scheme}`);
		const bridge = this.#appServer;
		if (!bridge?.readHostUri) throw new Error("host URI bridge is not attached");
		const resource = JSON.parse(await bridge.readHostUri(threadId, JSON.stringify({ url: url.href })));
		return {
			url: typeof resource.url === "string" ? resource.url : url.href,
			content: typeof resource.content === "string" ? resource.content : "",
			contentType:
				resource.contentType === "text/markdown" ||
				resource.contentType === "application/json" ||
				resource.contentType === "text/plain"
					? resource.contentType
					: "text/plain",
			size: typeof resource.size === "number" ? resource.size : undefined,
			notes: Array.isArray(resource.notes)
				? resource.notes.filter((note: unknown) => typeof note === "string")
				: undefined,
			immutable: typeof resource.immutable === "boolean" ? resource.immutable : definition.immutable,
		};
	}

	async writeHostUri(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const threadId = context?.threadId ?? context?.sessionId;
		if (!threadId) throw new Error(`Host URI ${url.href} requires a thread-scoped write context`);
		const thread = this.#threads.get(threadId);
		if (!thread) throw new Error(`unknown thread for Host URI ${url.href}: ${threadId}`);
		const scheme = url.protocol.replace(/:$/, "").toLowerCase();
		const definition = thread.hostUriSchemes.get(scheme);
		if (!definition) throw new Error(`Host URI scheme is not registered for thread ${threadId}: ${scheme}`);
		if (!definition.writable) throw new Error(`Host URI scheme is not writable: ${scheme}`);
		const bridge = this.#appServer;
		if (!bridge?.writeHostUri) throw new Error("host URI bridge is not attached");
		await bridge.writeHostUri(threadId, JSON.stringify({ url: url.href }), content);
	}
}
