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
	/** Satisfy one backend method call (e.g. `prompt`, `steer`, `getState`). */
	backendCall(threadId: string, method: string, params: unknown): Promise<unknown>;
}

/** Live handle to a running app-server. */
export interface AppServerHandle {
	readonly server: AppServer;
	openConnection(): string;
	closeConnection(id: string): void;
	dispatch(connectionId: string, line: string): Promise<string | null>;
	/** Push a gjc `AgentEvent` for a thread; returns notifications emitted. */
	emitEvent(threadId: string, generation: number, eventType: string, payload: unknown): number;
}

interface IncomingCall {
	callId: string;
	kind: string;
	threadId: string | null;
	params: unknown;
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
			} else if (call.kind.startsWith("backend.")) {
				const method = call.kind.slice("backend.".length);
				resolveOk(call.callId, await host.backendCall(call.threadId ?? "", method, call.params));
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

	return {
		server,
		openConnection: () => server.openConnection(),
		closeConnection: (id: string) => server.closeConnection(id),
		dispatch: (connectionId: string, line: string) => server.dispatch(connectionId, line),
		emitEvent: (threadId, generation, eventType, payload) =>
			server.emitBackendEvent(threadId, generation, eventType, JSON.stringify(payload ?? null)),
	};
}
