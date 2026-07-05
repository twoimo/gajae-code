import { z } from "zod";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../../internal-urls";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
} from "../../internal-urls/types";
import { type CreateAgentSessionOptions, createAgentSession } from "../../sdk";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { BUILTIN_SLASH_COMMANDS, loadSlashCommands } from "../../extensibility/slash-commands";
import type { Extension, Skill } from "../../discovery";
import { loadCapability } from "../../discovery";
import { PluginManager } from "../../extensibility/plugins/manager";
import type { InstalledPlugin } from "../../extensibility/plugins/types";
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
	getActiveToolNames?: () => string[];
	getAllToolNames?: () => string[];
}

type AgentSessionLike = AppServerSession;

type SessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: AgentSessionLike }>;

export interface AgentSessionHostOptions {
	appServer?: NativeAppServerBridge;
	emit?: AppServerEventEmitter;
	sessionFactory?: SessionFactory;
}

interface ThreadRecord {
	session: AgentSessionLike;
	unsubscribe: () => void;
	generation: number;
	cwd: string;
	metadata: Record<string, unknown>;
	hostUriSchemes: Map<string, { writable: boolean; immutable: boolean }>;
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

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeSessionMetadata(params: unknown, sessionId?: string): Record<string, unknown> {
	const record = asRecord(params);
	const metadata: Record<string, unknown> = {};
	for (const key of ["cwd", "sessionId", "sessionDir", "systemPromptAppend", "thinking", "todos"] as const) {
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

type SkillCatalogEntry = { name: string; source: string; description?: string; enabled?: boolean };
type ExtensionCatalogEntry = { id: string; name: string; kind: string; source: string; status?: string; description?: string };
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

function sourceFromItem(item: { level?: string; _source?: { level?: string; provider?: string; providerName?: string } }): string {
	return optionalString(item._source?.level) ?? optionalString(item.level) ?? optionalString(item._source?.provider) ?? "unknown";
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
		const result = await loadCapability<Extension>("extensions", { cwd, includeDisabled });
		return result.items
			.map(extension => ({
				id: extension.name,
				name: extension.manifest.name ?? extension.name,
				kind: "extension",
				source: sourceFromItem(extension),
				status: "available",
				description: extension.manifest.description,
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
		masked[key] = schemas[key]?.secret === true ? "********" : value;
	}
	return masked;
}

async function pluginEntry(manager: PluginManager, plugin: InstalledPlugin, includePluginSettings = true): Promise<PluginCatalogEntry> {
	const settings = includePluginSettings ? maskPluginSettings(plugin, await manager.getPluginSettings(plugin.name)) : undefined;
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

async function pluginsCatalog(cwd: string, includeDisabled = true, includePluginSettings = true): Promise<PluginCatalogEntry[]> {
	try {
		const manager = new PluginManager(cwd);
		const plugins = await manager.list();
		return (await Promise.all(plugins.filter(plugin => includeDisabled || plugin.enabled).map(plugin => pluginEntry(manager, plugin, includePluginSettings)))).sort((a, b) => a.id.localeCompare(b.id));
	} catch {
		return [];
	}
}

async function toolsCatalog(session: AgentSessionLike): Promise<Array<{ name: string; active: boolean; description?: string }>> {
	const active = new Set(typeof session.getActiveToolNames === "function" ? session.getActiveToolNames() : []);
	const all = typeof session.getAllToolNames === "function" ? session.getAllToolNames() : Array.from(active);
	return Array.from(new Set(all))
		.filter(name => typeof name === "string" && name.length > 0)
		.sort((a, b) => a.localeCompare(b))
		.map(name => ({ name, active: active.has(name) }));
}

async function commandsCatalog(cwd: string): Promise<Array<{ name: string; source: string; description?: string }>> {
	const commands: Array<{ name: string; source: string; description?: string }> = [];
	const seen = new Set<string>();
	for (const command of BUILTIN_SLASH_COMMANDS) {
		if (seen.has(command.name)) continue;
		seen.add(command.name);
		commands.push({
			name: command.name,
			source: "builtin",
			description: command.description,
		});
	}
	try {
		for (const command of await loadSlashCommands({ cwd })) {
			if (seen.has(command.name)) continue;
			seen.add(command.name);
			commands.push({
				name: command.name,
				source: command.source,
				description: command.description,
			});
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

export class AgentSessionHost implements AppServerHost {
	readonly #threads = new Map<string, ThreadRecord>();
	#emit: AppServerEventEmitter;
	#notificationHandler: ((method: string, params: unknown) => unknown) | undefined;
	readonly #sessionFactory: SessionFactory;
	#appServer: NativeAppServerBridge | undefined;
	readonly #hostUriRegisteredSchemes = new Set<string>();

	constructor(options: AgentSessionHostOptions = {}) {
		this.#emit = options.emit ?? (() => {});
		this.#sessionFactory = options.sessionFactory ?? createAgentSession;
		this.#appServer = options.appServer;
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
		const returnedMetadata = normalizeSessionMetadata(metadata, threadId);
		const thread: ThreadRecord = {
			session,
			// Core registers a new thread at BackendGeneration::FIRST (1); match it
			// so emitted events are not rejected by the stale-generation guard.
			generation: 1,
			cwd,
			metadata: returnedMetadata,
			unsubscribe: () => {},
			hostUriSchemes: new Map(),
		};
		thread.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.#emit(threadId, thread.generation, event.type, jsonClone(event));
		});
		this.#threads.set(threadId, thread);
		return { threadId, sessionMetadata: returnedMetadata, resumed: false };
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
		return this.createThread(params);
	}

	async backendCall(threadId: string, method: string, params: unknown, generation?: number): Promise<unknown> {
		const thread = this.#threads.get(threadId);
		if (!thread) throw new Error(`unknown thread: ${threadId}`);
		const session = thread.session;
		const record = asRecord(params);
		if (typeof generation === "number" && Number.isFinite(generation) && generation > 0) {
			thread.generation = generation;
		}

		switch (method) {
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
			case "getState": {
				if (includeRequests(params, "tools")) return { tools: await toolsCatalog(session) };
				if (includeRequests(params, "commands")) return { commands: await commandsCatalog(thread.cwd) };
				if (includeRequests(params, "skills")) return { skills: await skillsCatalog(thread.cwd, includeDisabled(params)) };
				if (includeRequests(params, "extensions")) return { extensions: await extensionsCatalog(thread.cwd, includeDisabled(params)) };
				if (includeRequests(params, "plugins")) return { plugins: await pluginsCatalog(thread.cwd, includeDisabled(params), includeSettings(params)) };
				return typeof session.getSessionState === "function" ? session.getSessionState() : (session.state ?? null);
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
