/**
 * App-server host routing core.
 *
 * The native {@link AppServer} (Rust core) forwards backend/factory calls to the
 * TypeScript host through the `onCall` callback and expects the host to satisfy
 * each call and report the result via `resolveCall`. This module encapsulates
 * that routing so the concrete, session-backed host can be a plain object
 * implementing {@link AppServerHost}, decoupled from the native wiring and
 * independently testable.
 */

import { AppServer } from "@gajae-code/natives";

/** Result of a factory call: a thread id plus optional session metadata. */
export interface CreatedThread {
	threadId: string;
	sessionMetadata?: Record<string, unknown>;
	resumed?: boolean;
}

/**
 * The host the app-server drives. Implementations create/resume/fork the
 * underlying `AgentSession`s and satisfy per-thread backend method calls. All
 * methods may be async; thrown errors are surfaced to the client as JSON-RPC
 * errors.
 */
export interface AppServerHost {
	createThread(params: unknown): Promise<CreatedThread>;
	resumeThread(params: unknown): Promise<CreatedThread>;
	forkThread(params: unknown): Promise<CreatedThread>;
	settingsSchema?(): Promise<unknown>;
	settingsRead?(): Promise<unknown>;
	settingsUpdate?(params: unknown): Promise<unknown>;
	appearanceThemesList?(): Promise<unknown>;
	appearanceRead?(): Promise<unknown>;
	appearanceSet?(params: unknown): Promise<unknown>;
	providerList?(): Promise<unknown>;
	providerAdd?(params: unknown): Promise<unknown>;
	authStatus?(): Promise<unknown>;
	authLogout?(params: unknown): Promise<unknown>;
	authLoginStart?(params: unknown): Promise<unknown>;
	authLoginPoll?(params: unknown): Promise<unknown>;
	authLoginComplete?(params: unknown): Promise<unknown>;
	authLoginCancel?(params: unknown): Promise<unknown>;
	sessionList?(params: unknown): Promise<unknown>;
	sessionSearch?(params: unknown): Promise<unknown>;
	sessionRename?(params: unknown): Promise<unknown>;
	sessionOpen?(params: unknown): Promise<unknown>;
	sessionDelete?(params: unknown): Promise<unknown>;
	sessionExport?(params: unknown): Promise<unknown>;
	extensionsSetEnabled?(params: unknown): Promise<unknown>;
	skillsSetEnabled?(params: unknown): Promise<unknown>;
	pluginsSetEnabled?(params: unknown): Promise<unknown>;
	pluginsSetFeature?(params: unknown): Promise<unknown>;
	pluginsSetSetting?(params: unknown): Promise<unknown>;
	/** Satisfy one backend method call (e.g. `prompt`, `steer`, `getState`). */
	backendCall(threadId: string, method: string, params: unknown, generation?: number): Promise<unknown>;
	/** Satisfy one token-free notifications channel call (e.g. `reply`, `subscribe`). */
	notificationCall(method: string, params: unknown): Promise<unknown>;
	/** Provide the native bridge to hosts that need to call back into clients. */
	/** Register host-owned URI schemes into the process-global internal URL router. */
	setHostUriSchemes?(
		threadId: string,
		schemes: Array<{ scheme: string; writable?: boolean; immutable?: boolean }>,
	): string[];
	setAppServer?(server: AppServer): void;
}

/** Live handle to a running app-server. */
export interface AppServerHandle {
	readonly server: AppServer;
	openConnection(): string;
	closeConnection(id: string): void;
	dispatch(connectionId: string, line: string): Promise<string | null>;
	/** Push a gjc `AgentEvent` for a thread; returns notifications emitted. */
	emitEvent(threadId: string, generation: number, eventType: string, payload: unknown): number;
	/** Push an opaque `gjc/notifications` SDK frame. */
	pushNotification(frame: unknown): void;
}

interface IncomingCall {
	callId: string;
	kind: string;
	threadId: string | null;
	params: unknown;
	generation?: number;
}

/** Options for {@link startAppServer}. */
export interface StartAppServerOptions {
	/** Receives outbound JSON-RPC notification frames (default: stdout). */
	onFrame?: (frame: string) => void;
	/** Per-thread concurrent-turn admission limit before `-32001` overload. */
	maxInflightTurnsPerThread?: number;
}

/**
 * Construct a native app-server wired to `host`. Backend/factory calls are
 * routed to the host and resolved back into the Rust core; the returned handle
 * exposes connection + dispatch + event-emission helpers.
 */
export function startAppServer(host: AppServerHost, options: StartAppServerOptions = {}): AppServerHandle {
	const emitFrame = options.onFrame ?? ((frame: string) => process.stdout.write(`${frame}\n`));

	// Assigned before any callback can fire (constructor returns synchronously).
	let server!: AppServer;

	const resolveOk = (callId: string, value: unknown) => {
		server.resolveCall(callId, true, JSON.stringify(value ?? null));
	};
	const resolveErr = (callId: string, error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		server.resolveCall(callId, false, JSON.stringify({ code: -32603, message }));
	};

	const handleCall = async (call: IncomingCall): Promise<void> => {
		try {
			if (call.kind === "factory.create") {
				resolveOk(call.callId, await host.createThread(call.params));
			} else if (call.kind === "factory.resume") {
				resolveOk(call.callId, await host.resumeThread(call.params));
			} else if (call.kind === "factory.fork") {
				resolveOk(call.callId, await host.forkThread(call.params));
			} else if (call.kind === "factory.settingsSchema") {
				if (!host.settingsSchema) throw new Error("settings schema is not supported by this host");
				resolveOk(call.callId, await host.settingsSchema());
			} else if (call.kind === "factory.settingsRead") {
				if (!host.settingsRead) throw new Error("settings read is not supported by this host");
				resolveOk(call.callId, await host.settingsRead());
			} else if (call.kind === "factory.settingsUpdate") {
				if (!host.settingsUpdate) throw new Error("settings update is not supported by this host");
				resolveOk(call.callId, await host.settingsUpdate(call.params));
			} else if (call.kind === "factory.appearanceThemesList") {
				if (!host.appearanceThemesList) throw new Error("appearance theme list is not supported by this host");
				resolveOk(call.callId, await host.appearanceThemesList());
			} else if (call.kind === "factory.appearanceRead") {
				if (!host.appearanceRead) throw new Error("appearance read is not supported by this host");
				resolveOk(call.callId, await host.appearanceRead());
			} else if (call.kind === "factory.appearanceSet") {
				if (!host.appearanceSet) throw new Error("appearance set is not supported by this host");
				resolveOk(call.callId, await host.appearanceSet(call.params));
			} else if (call.kind === "factory.providerList") {
				if (!host.providerList) throw new Error("provider list is not supported by this host");
				resolveOk(call.callId, await host.providerList());
			} else if (call.kind === "factory.providerAdd") {
				if (!host.providerAdd) throw new Error("provider add is not supported by this host");
				resolveOk(call.callId, await host.providerAdd(call.params));
			} else if (call.kind === "factory.authStatus") {
				if (!host.authStatus) throw new Error("auth status is not supported by this host");
				resolveOk(call.callId, await host.authStatus());
			} else if (call.kind === "factory.authLogout") {
				if (!host.authLogout) throw new Error("auth logout is not supported by this host");
				resolveOk(call.callId, await host.authLogout(call.params));
			} else if (call.kind === "factory.authLoginStart") {
				if (!host.authLoginStart) throw new Error("auth login start is not supported by this host");
				resolveOk(call.callId, await host.authLoginStart(call.params));
			} else if (call.kind === "factory.authLoginPoll") {
				if (!host.authLoginPoll) throw new Error("auth login poll is not supported by this host");
				resolveOk(call.callId, await host.authLoginPoll(call.params));
			} else if (call.kind === "factory.authLoginComplete") {
				if (!host.authLoginComplete) throw new Error("auth login complete is not supported by this host");
				resolveOk(call.callId, await host.authLoginComplete(call.params));
			} else if (call.kind === "factory.authLoginCancel") {
				if (!host.authLoginCancel) throw new Error("auth login cancel is not supported by this host");
				resolveOk(call.callId, await host.authLoginCancel(call.params));
			} else if (call.kind === "factory.sessionList") {
				if (!host.sessionList) throw new Error("session list is not supported by this host");
				resolveOk(call.callId, await host.sessionList(call.params));
			} else if (call.kind === "factory.sessionSearch") {
				if (!host.sessionSearch) throw new Error("session search is not supported by this host");
				resolveOk(call.callId, await host.sessionSearch(call.params));
			} else if (call.kind === "factory.sessionOpen") {
				if (!host.sessionOpen) throw new Error("session open is not supported by this host");
				resolveOk(call.callId, await host.sessionOpen(call.params));
			} else if (call.kind === "factory.sessionRename") {
				if (!host.sessionRename) throw new Error("session rename is not supported by this host");
				resolveOk(call.callId, await host.sessionRename(call.params));
			} else if (call.kind === "factory.sessionDelete") {
				if (!host.sessionDelete) throw new Error("session delete is not supported by this host");
				resolveOk(call.callId, await host.sessionDelete(call.params));
			} else if (call.kind === "factory.sessionExport") {
				if (!host.sessionExport) throw new Error("session export is not supported by this host");
				resolveOk(call.callId, await host.sessionExport(call.params));
			} else if (call.kind === "factory.extensionsSetEnabled") {
				if (!host.extensionsSetEnabled) throw new Error("extensions set enabled is not supported by this host");
				resolveOk(call.callId, await host.extensionsSetEnabled(call.params));
			} else if (call.kind === "factory.skillsSetEnabled") {
				if (!host.skillsSetEnabled) throw new Error("skills set enabled is not supported by this host");
				resolveOk(call.callId, await host.skillsSetEnabled(call.params));
			} else if (call.kind === "factory.pluginsSetEnabled") {
				if (!host.pluginsSetEnabled) throw new Error("plugins set enabled is not supported by this host");
				resolveOk(call.callId, await host.pluginsSetEnabled(call.params));
			} else if (call.kind === "factory.pluginsSetFeature") {
				if (!host.pluginsSetFeature) throw new Error("plugins set feature is not supported by this host");
				resolveOk(call.callId, await host.pluginsSetFeature(call.params));
			} else if (call.kind === "factory.pluginsSetSetting") {
				if (!host.pluginsSetSetting) throw new Error("plugins set setting is not supported by this host");
				resolveOk(call.callId, await host.pluginsSetSetting(call.params));
			} else if (call.kind.startsWith("backend.")) {
				const method = call.kind.slice("backend.".length);
				resolveOk(call.callId, await host.backendCall(call.threadId ?? "", method, call.params, call.generation));
			} else if (call.kind.startsWith("notifications.")) {
				const method = call.kind.slice("notifications.".length);
				resolveOk(call.callId, await host.notificationCall(method, call.params));
			} else if (call.kind === "hostUriSchemes.set") {
				const params = (call.params && typeof call.params === "object" ? call.params : {}) as {
					threadId?: unknown;
					schemes?: unknown;
				};
				if (typeof params.threadId !== "string" || !Array.isArray(params.schemes)) {
					throw new Error("hostUriSchemes.set requires threadId and schemes");
				}
				if (!host.setHostUriSchemes) throw new Error("host URI scheme registration is not supported by this host");
				resolveOk(call.callId, {
					schemes: host.setHostUriSchemes(
						params.threadId,
						params.schemes as Array<{ scheme: string; writable?: boolean; immutable?: boolean }>,
					),
				});
			} else {
				resolveErr(call.callId, new Error(`unknown call kind: ${call.kind}`));
			}
		} catch (error) {
			resolveErr(call.callId, error);
		}
	};

	const onCall = (_err: unknown, call: string) => {
		let parsed: IncomingCall;
		try {
			parsed = JSON.parse(call) as IncomingCall;
		} catch {
			return; // malformed call payload; nothing to resolve
		}
		void handleCall(parsed);
	};

	server = new AppServer(
		(_err: unknown, frame: string) => emitFrame(frame),
		onCall,
		options.maxInflightTurnsPerThread,
	);
	if (typeof host.setAppServer === "function") host.setAppServer(server);

	return {
		server,
		openConnection: () => server.openConnection(),
		closeConnection: (id: string) => server.closeConnection(id),
		dispatch: (connectionId: string, line: string) => server.dispatch(connectionId, line),
		emitEvent: (threadId, generation, eventType, payload) =>
			server.emitBackendEvent(threadId, generation, eventType, JSON.stringify(payload ?? null)),
		pushNotification: frame => server.pushNotification(JSON.stringify(frame ?? null)),
	};
}
