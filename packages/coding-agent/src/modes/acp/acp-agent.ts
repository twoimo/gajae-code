import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type DeleteSessionRequest,
	type DeleteSessionResponse,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionInfo,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { getAgentDir } from "@gajae-code/utils";
import packageJson from "../../../package.json" with { type: "json" };
import {
	type AcpProviderRegistration,
	type AcpReverseConnection,
	AcpSdkAdapter,
	AcpSdkAdapterError,
} from "../../sdk/acp";
import { ensureBroker } from "../../sdk/broker/ensure";
import { readSdkBrokerDiscovery, SdkClient } from "../../sdk/client";
import { mapAgentWireEventPayloadToAcpSessionUpdates } from "./acp-event-mapper";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const THINKING_CONFIG_ID = "thinking";
const SESSION_PAGE_SIZE = 50;
export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;

type JsonObject = Record<string, unknown>;
type SessionRecord = {
	cwd: string;
	adapter: AcpSdkAdapter;
	unsubscribe: () => void;
};
type Endpoint = { url: string; token: string };

type BrokerSession = {
	sessionId: string;
	locator?: { repo?: string };
	live?: boolean;
};

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function endpoint(value: unknown): Endpoint {
	const candidate = object(value);
	const result = object(candidate?.result) ?? candidate;
	const nested = object(result?.endpoint) ?? result;
	if (typeof nested?.url !== "string" || typeof nested.token !== "string")
		throw new AcpSdkAdapterError("unavailable", "SDK lifecycle response omitted a session endpoint.");
	return { url: nested.url, token: nested.token };
}

function sessionId(value: unknown): string {
	const candidate = object(value);
	const result = object(candidate?.result) ?? candidate;
	if (typeof result?.sessionId !== "string" || !result.sessionId)
		throw new AcpSdkAdapterError("unavailable", "SDK lifecycle response omitted a session id.");
	return result.sessionId;
}

function pageItems(value: unknown): unknown[] {
	const response = object(value);
	const result = object(response?.result) ?? response;
	const page = object(result?.page);
	return Array.isArray(page?.items) ? page.items : [];
}

/** ACP form elicitation uses the client-facing reverse surface without owning a session runtime. */
export function createAcpExtensionUiContext(
	connection: AgentSideConnection,
	getSessionId: () => string,
	capabilities: ClientCapabilities | undefined,
): {
	select: (
		message: string,
		options: string[],
		dialog?: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void },
	) => Promise<string | undefined>;
	confirm: (
		message: string,
		detail?: string,
		dialog?: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void },
	) => Promise<boolean>;
	input: (
		message: string,
		placeholder?: string,
		dialog?: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void },
	) => Promise<string | undefined>;
} {
	const elicit = async (
		kind: "select" | "confirm" | "input",
		message: string,
		options: string[] | undefined,
		dialog: { signal?: AbortSignal; timeout?: number; onTimeout?: () => void } | undefined,
	): Promise<unknown> => {
		if (!capabilities?.elicitation?.form || dialog?.signal?.aborted) return undefined;
		const request = (
			connection as unknown as { unstable_createElicitation(input: JsonObject): Promise<JsonObject> }
		).unstable_createElicitation({
			sessionId: getSessionId(),
			message,
			requestedSchema: {
				type: "object",
				properties: {
					value:
						kind === "confirm" ? { type: "boolean" } : { type: "string", ...(options ? { enum: options } : {}) },
				},
				required: ["value"],
			},
		});
		let timer: NodeJS.Timeout | undefined;
		const timeout =
			dialog?.timeout === undefined
				? undefined
				: new Promise<undefined>(resolve => {
						timer = setTimeout(() => {
							dialog.onTimeout?.();
							resolve(undefined);
						}, dialog.timeout);
					});
		try {
			const response = timeout ? await Promise.race([request, timeout]) : await request;
			return object(object(response)?.content)?.value;
		} catch {
			return undefined;
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	return {
		select: async (message, options, dialog) => {
			const value = await elicit("select", message, options, dialog);
			return typeof value === "string" && options.includes(value) ? value : undefined;
		},
		confirm: async (message, detail, dialog) =>
			(await elicit("confirm", detail ? `${message}\n\n${detail}` : message, undefined, dialog)) === true,
		input: async (message, placeholder, dialog) => {
			const value = await elicit("input", placeholder ? `${message}\n\n${placeholder}` : message, undefined, dialog);
			return typeof value === "string" ? value : undefined;
		},
	};
}

/**
 * ACP is a pure SDK client. Session processes are created and resumed by the
 * broker, while all per-session operations use that session's authenticated SDK
 * endpoint. This class deliberately imports neither AgentSession nor any local
 * runtime host component.
 */
export class AcpAgent implements Agent {
	readonly #connection: AgentSideConnection;
	readonly #agentDir: string;
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #knownSessionCwds = new Map<string, string>();
	#clientCapabilities: ClientCapabilities | undefined;
	#broker: Promise<AcpSdkAdapter> | undefined;
	#disposed = false;

	constructor(connection: AgentSideConnection, options?: { agentDir?: string } | unknown) {
		this.#connection = connection;
		const candidate = object(options);
		this.#agentDir = typeof candidate?.agentDir === "string" ? candidate.agentDir : getAgentDir();
		queueMicrotask(() => {
			if (connection.signal.aborted) {
				void this.#dispose();
			} else {
				connection.signal.addEventListener("abort", () => void this.#dispose(), { once: true });
			}
		});
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		this.#clientCapabilities = params.clientCapabilities;
		const authMethods: AuthMethod[] = [
			{
				id: "agent",
				name: "Use existing local credentials",
				description: "Authenticate via the provider keys/OAuth state already configured under ~/.gjc.",
			},
		];
		if (params.clientCapabilities?.auth?.terminal === true) {
			authMethods.push({
				type: "terminal",
				id: "terminal",
				name: "Set up Gajae Code in terminal",
				description: "Launch the gjc TUI to add provider keys and select models.",
				args: [ACP_TERMINAL_AUTH_FLAG],
			});
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: "gajae-code", title: "Gajae Code", version: packageJson.version },
			authMethods,
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: { http: true, sse: true },
				promptCapabilities: { embeddedContext: true, image: true },
				sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {}, delete: {} },
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		const methods = this.#clientCapabilities?.auth?.terminal ? ["agent", "terminal"] : ["agent"];
		if (!methods.includes(params.methodId)) throw new Error(`Unknown ACP auth method: ${params.methodId}`);
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const result = await (await this.#brokerAdapter()).global(
			"session.create",
			{ cwd: params.cwd, target: { path: params.cwd } },
			randomUUID(),
		);
		const id = sessionId(result);
		this.#knownSessionCwds.set(id, params.cwd);
		await this.#attach(id, params.cwd, endpoint(result));
		this.#scheduleBootstrap(id);
		return { sessionId: id, ...(await this.#sessionState(id)) };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		await this.#attachExisting(params.sessionId, params.cwd, "session.resume");
		this.#scheduleBootstrap(params.sessionId);
		return await this.#sessionState(params.sessionId);
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		await this.#attachExisting(params.sessionId, params.cwd, "session.resume");
		this.#scheduleBootstrap(params.sessionId);
		return await this.#sessionState(params.sessionId);
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const source = await this.#resolveSavedSession(params.sessionId, params.cwd);
		const result = await (await this.#brokerAdapter()).global(
			"session.fork",
			{
				cwd: params.cwd,
				sourceSessionId: params.sessionId,
				sourceSessionPath: source,
				target: { path: params.cwd },
			},
			randomUUID(),
		);
		const id = sessionId(result);
		await this.#attach(id, params.cwd, endpoint(result));
		this.#scheduleBootstrap(id);
		return { sessionId: id, ...(await this.#sessionState(id)) };
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		if (params.cwd) this.#assertAbsoluteCwd(params.cwd);
		const result = object(await (await this.#brokerAdapter()).global("session.list"));
		const listing = object(result?.result) ?? result;
		const listed = Array.isArray(listing?.sessions) ? listing.sessions : [];
		for (const session of listed) {
			const candidate = object(session) as BrokerSession | undefined;
			if (typeof candidate?.sessionId === "string" && typeof candidate.locator?.repo === "string")
				this.#knownSessionCwds.set(candidate.sessionId, candidate.locator.repo);
		}
		const sessions = listed
			.map(value => object(value) as BrokerSession | undefined)
			.filter(
				(value): value is BrokerSession & { locator: { repo: string } } =>
					typeof value?.sessionId === "string" && typeof value.locator?.repo === "string",
			)
			.filter(value => !params.cwd || value.locator.repo === params.cwd)
			.slice(this.#cursor(params.cursor), this.#cursor(params.cursor) + SESSION_PAGE_SIZE)
			.map(
				value =>
					({ sessionId: value.sessionId, cwd: value.locator.repo, title: value.sessionId }) satisfies SessionInfo,
			);
		const offset = this.#cursor(params.cursor) + sessions.length;
		return { sessions, nextCursor: offset < listed.length ? String(offset) : undefined };
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		if (record) await record.adapter.close();
		this.#sessions.delete(params.sessionId);
		await (await this.#brokerAdapter()).global("session.close", { sessionId: params.sessionId }, randomUUID());
		return {};
	}

	async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		const cwd = record?.cwd ?? this.#knownSessionCwds.get(params.sessionId);
		// ACP's delete request has no cwd. Only delete sessions this connection has
		// already scoped through the broker; unknown ids remain the protocol no-op.
		if (!cwd) return {};

		if (record) {
			record.unsubscribe();
			await record.adapter.close();
			this.#sessions.delete(params.sessionId);
			await (await this.#brokerAdapter()).global("session.close", { sessionId: params.sessionId }, randomUUID());
		}

		let saved: string;
		try {
			saved = await this.#resolveSavedSession(params.sessionId, cwd);
		} catch (error) {
			if (error instanceof AcpSdkAdapterError && error.code === "not_found") return {};
			throw error;
		}
		await (await this.#brokerAdapter()).global(
			"session.delete",
			{ sessionId: params.sessionId, sessionPath: saved, cwd, target: { path: cwd } },
			randomUUID(),
		);
		this.#knownSessionCwds.delete(params.sessionId);
		return {};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		if (params.modeId !== ACP_DEFAULT_MODE_ID && params.modeId !== ACP_PLAN_MODE_ID)
			throw new Error(`Unsupported ACP mode: ${params.modeId}`);
		await this.#adapter(params.sessionId).control("mode.plan.set", { on: params.modeId === ACP_PLAN_MODE_ID });
		await this.#connection.sessionUpdate({
			sessionId: params.sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
		});
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		if (typeof params.value !== "string")
			throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
		switch (params.configId) {
			case MODE_CONFIG_ID:
				await this.setSessionMode({ sessionId: params.sessionId, modeId: params.value });
				break;
			case MODEL_CONFIG_ID:
				await this.#adapter(params.sessionId).setModel(params.value);
				break;
			case THINKING_CONFIG_ID:
				await this.#adapter(params.sessionId).control("thinking.set", { level: params.value });
				break;
			default:
				throw new Error(`Unknown ACP config option: ${params.configId}`);
		}
		const state = await this.#sessionState(params.sessionId);
		await this.#connection.sessionUpdate({
			sessionId: params.sessionId,
			update: { sessionUpdate: "config_option_update", configOptions: state.configOptions ?? [] },
		});
		return { configOptions: state.configOptions ?? [] };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const text = params.prompt
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const images = params.prompt
			.filter(block => block.type === "image")
			.map(block => ({ type: "image", data: block.data, mimeType: block.mimeType }));
		await this.#adapter(params.sessionId).prompt({ text, ...(images.length ? { images } : {}) });
		return { stopReason: "end_turn" };
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		await this.#adapter(params.sessionId).cancel();
		await this.#connection.sessionUpdate({
			sessionId: params.sessionId,
			update: {
				sessionUpdate: "session_info_update",
				_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
			},
		});
	}

	async extMethod(method: string, params: JsonObject): Promise<JsonObject> {
		try {
			if (method === "_gjc/sdk/global") {
				const result = await (await this.#brokerAdapter()).handle(method, params);
				return object(result) ?? {};
			}
			if (method === "_gjc/sdk/control" || method === "_gjc/sdk/query") {
				const id = typeof params.sessionId === "string" ? params.sessionId : undefined;
				if (!id) throw new AcpSdkAdapterError("invalid_input", "sessionId is required.");
				const result = await this.#adapter(id).handle(method, params);
				return object(result) ?? {};
			}
			throw new AcpSdkAdapterError("method_not_found", `Unknown ACP ext method: ${method}`);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "internal";
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: { code, message } };
		}
	}

	async extNotification(_method: string, _params: JsonObject): Promise<void> {}
	get signal(): AbortSignal {
		return this.#connection.signal;
	}
	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	async #attachExisting(id: string, cwd: string, operation: "session.resume"): Promise<void> {
		if (this.#sessions.has(id)) return;
		const saved = await this.#resolveSavedSession(id, cwd);
		const result = await (await this.#brokerAdapter()).global(
			operation,
			{ cwd, sessionId: id, sessionPath: saved, target: { path: cwd } },
			randomUUID(),
		);
		await this.#attach(id, cwd, endpoint(result));
	}

	async #attach(id: string, cwd: string, discovered: Endpoint): Promise<void> {
		const existing = this.#sessions.get(id);
		if (existing) {
			if (path.resolve(existing.cwd) !== path.resolve(cwd))
				throw new Error(`ACP session ${id} is already attached for ${existing.cwd}.`);
			return;
		}
		const adapter = await AcpSdkAdapter.connect({
			url: discovered.url,
			token: discovered.token,
			connection: this.#reverseConnection(id),

			providers: this.#providers(),
		});
		const unsubscribe = adapter.onFrame(frame => void this.#handleSdkFrame(id, frame));
		this.#sessions.set(id, { cwd, adapter, unsubscribe });
		this.#knownSessionCwds.set(id, cwd);
	}

	async #brokerAdapter(): Promise<AcpSdkAdapter> {
		if (!this.#broker) {
			this.#broker = (async () => {
				await ensureBroker({ agentDir: this.#agentDir });
				const discovery = await readSdkBrokerDiscovery(this.#agentDir);
				if (!discovery) throw new AcpSdkAdapterError("unavailable", "SDK broker discovery is unavailable.");
				const client = await SdkClient.connect(discovery.url, discovery.token);
				return new AcpSdkAdapter({ url: discovery.url, token: discovery.token, client });
			})();
		}
		return await this.#broker;
	}

	#adapter(id: string): AcpSdkAdapter {
		const record = this.#sessions.get(id);
		if (!record) throw new AcpSdkAdapterError("not_found", `Unsupported ACP session: ${id}`);
		return record.adapter;
	}

	async #resolveSavedSession(id: string, cwd: string): Promise<string> {
		const response = object(
			await (await this.#brokerAdapter()).global("session.list", { resolveSessionId: id, cwd }),
		);
		const result = object(response?.result) ?? response;
		const saved = object(result?.savedSession);
		if (saved?.id !== id || typeof saved.path !== "string")
			throw new AcpSdkAdapterError("not_found", `Saved ACP session does not exist: ${id}`);
		return saved.path;
	}

	#providers(): AcpProviderRegistration[] {
		const capabilities = this.#clientCapabilities;
		return [
			...(capabilities?.fs?.readTextFile || capabilities?.fs?.writeTextFile
				? [{ capability: "fs", definitions: [] }]
				: []),
			...(capabilities?.terminal ? [{ capability: "terminal", definitions: [] }] : []),
			...(capabilities?._meta ? [{ capability: "permission", definitions: [] }] : []),
			{ capability: "ui", definitions: [] },
		];
	}

	#reverseConnection(sessionId: string): AcpReverseConnection {
		const methods: Record<string, string> = {
			"fs.readTextFile": "readTextFile",
			"fs.writeTextFile": "writeTextFile",
			"terminal.create": "createTerminal",
			"permission.request": "requestPermission",
			"ui.elicit": "unstable_createElicitation",
		};
		return {
			request: async (method: string, params: JsonObject): Promise<unknown> => {
				const name = methods[method] ?? method;
				const target = (this.#connection as unknown as Record<string, unknown>)[name];
				if (typeof target !== "function")
					throw new AcpSdkAdapterError("acp_reverse_unavailable", `ACP reverse method is unavailable: ${method}`);
				const request = method === "permission.request" ? { ...params, sessionId } : params;
				return await (target as (input: JsonObject) => Promise<unknown>)(request);
			},
		};
	}

	async #handleSdkFrame(id: string, frame: Record<string, unknown>): Promise<void> {
		if (frame.type !== "event") return;
		const payload = object(frame.payload) ?? object(frame);
		if (!payload || typeof payload.type !== "string") return;
		const cwd = this.#sessions.get(id)?.cwd;
		for (const notification of mapAgentWireEventPayloadToAcpSessionUpdates(payload as never, id, { cwd }))
			await this.#connection.sessionUpdate(notification);
	}

	async #sessionState(id: string): Promise<Pick<NewSessionResponse, "configOptions" | "modes">> {
		const config = await this.#adapter(id).query("config.list/get");
		const configItems = pageItems(config);
		const configOptions = configItems
			.map(item => object(item))
			.filter((item): item is JsonObject =>
				Boolean(item && typeof item.id === "string" && typeof item.value === "string"),
			)
			.map(item => ({
				id: String(item.id),
				name: typeof item.name === "string" ? item.name : String(item.id),
				type: "select" as const,
				currentValue: String(item.value),
				options: [],
			}));
		return {
			configOptions: [
				{
					id: MODE_CONFIG_ID,
					name: "Mode",
					type: "select",
					currentValue: ACP_DEFAULT_MODE_ID,
					options: [
						{ value: ACP_DEFAULT_MODE_ID, name: "Default" },
						{ value: ACP_PLAN_MODE_ID, name: "Plan" },
					],
				},
				...configOptions,
			],
			modes: {
				availableModes: [
					{ id: ACP_DEFAULT_MODE_ID, name: "Default" },
					{ id: ACP_PLAN_MODE_ID, name: "Plan" },
				],
				currentModeId: ACP_DEFAULT_MODE_ID,
			},
		};
	}

	#scheduleBootstrap(id: string): void {
		setTimeout(() => {
			if (!this.#sessions.has(id) || this.#connection.signal.aborted) return;
			void this.#connection.sessionUpdate({
				sessionId: id,
				update: {
					sessionUpdate: "session_info_update",
					_meta: { gjcPhase: "idle", running: false, gjcRunning: false },
				},
			});
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
	}

	#cursor(cursor: string | null | undefined): number {
		if (!cursor) return 0;
		const value = Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ACP session cursor: ${cursor}`);
		return value;
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) throw new Error(`ACP cwd must be an absolute path: ${cwd}`);
	}

	async #dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const record of this.#sessions.values()) {
			record.unsubscribe();
			await record.adapter.close();
		}
		this.#sessions.clear();
		if (this.#broker) (await this.#broker).close().catch(() => undefined);
	}
}
