import { createAgentSession, type CreateAgentSessionOptions } from "../../sdk";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { AppServerHost, CreatedThread } from "./host";

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
}

type AgentSessionLike = AppServerSession;

type SessionFactory = (options: CreateAgentSessionOptions) => Promise<{ session: AgentSessionLike }>;

export interface AgentSessionHostOptions {
	emit?: AppServerEventEmitter;
	sessionFactory?: SessionFactory;
}

interface ThreadRecord {
	session: AgentSessionLike;
	unsubscribe: () => void;
	generation: number;
	cwd: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonClone<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

export class AgentSessionHost implements AppServerHost {
	readonly #threads = new Map<string, ThreadRecord>();
	#emit: AppServerEventEmitter;
	readonly #sessionFactory: SessionFactory;

	constructor(options: AgentSessionHostOptions = {}) {
		this.#emit = options.emit ?? (() => {});
		this.#sessionFactory = options.sessionFactory ?? createAgentSession;
	}

	setEmitter(emit: AppServerEventEmitter): void {
		this.#emit = emit;
	}

	async createThread(params: unknown): Promise<CreatedThread> {
		const record = asRecord(params);
		const cwd = optionalString(record.cwd) ?? process.cwd();
		const model = record.model;
		const { session } = await this.#sessionFactory({
			cwd,
			...(model && typeof model === "object" ? { model: model as CreateAgentSessionOptions["model"] } : {}),
		});
		const threadId = session.sessionId;
		const thread: ThreadRecord = {
			session,
			// Core registers a new thread at BackendGeneration::FIRST (1); match it
			// so emitted events are not rejected by the stale-generation guard.
			generation: 1,
			cwd,
			unsubscribe: () => {},
		};
		thread.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.#emit(threadId, thread.generation, event.type, jsonClone(event));
		});
		this.#threads.set(threadId, thread);
		return { threadId, sessionMetadata: { cwd, sessionId: threadId } };
	}

	async resumeThread(params: unknown): Promise<CreatedThread> {
		return this.createThread(params);
	}

	async forkThread(params: unknown): Promise<CreatedThread> {
		return this.createThread(params);
	}

	async backendCall(threadId: string, method: string, params: unknown): Promise<unknown> {
		const thread = this.#threads.get(threadId);
		if (!thread) throw new Error(`unknown thread: ${threadId}`);
		const session = thread.session;
		const record = asRecord(params);

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
				thread.generation += 1;
				return { ok: true };
			case "getState":
				return typeof session.getSessionState === "function" ? session.getSessionState() : session.state ?? null;
			case "getMessages":
				return typeof session.getMessages === "function" ? session.getMessages() : session.messages ?? [];
			case "setModel":
				if (typeof session.setModel !== "function") throw new Error("setModel is not supported by this session");
				await session.setModel(record.model);
				return { ok: true };
			case "compact":
				if (typeof session.compact !== "function") throw new Error("compact is not supported by this session");
				return session.compact(optionalString(record.instructions));
			case "setTodos":
				if (typeof session.setTodos !== "function") throw new Error("setTodos is not supported by AgentSession");
				return session.setTodos(record.todos);
			case "exec": {
				const command = optionalString(record.command);
				if (!command) throw new Error("exec requires command");
				return session.executeBash(command, undefined, record.options as Parameters<AgentSession["executeBash"]>[2]);
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
}
