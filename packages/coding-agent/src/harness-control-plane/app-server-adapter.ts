/**
 * App-server JSON-RPC adapter for the harness control plane.
 *
 * This is intentionally side-by-side with rpc-adapter.ts: it speaks the new
 * `gjc app-server` NDJSON JSON-RPC 2.0 protocol while preserving the same
 * HarnessRpc acceptance contract (ack + post-cursor agent_start/turn started).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { HarnessRpc, RpcStateSnapshot } from "./rpc-adapter";

interface PendingResponse {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

interface WritableLike {
	write(chunk: string, callback?: (error?: Error | null) => void): boolean;
	end(): void;
}

interface ReadableLike extends EventEmitter {
	setEncoding?(encoding: BufferEncoding): void;
}

export interface AppServerTransport extends EventEmitter {
	stdout: ReadableLike;
	stdin: WritableLike;
	kill(): void;
}

export interface GajaeCodeAppServerRpcOptions {
	sessionDir?: string;
	command?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	transport?: AppServerTransport;
}

function commandFromEnv(env: NodeJS.ProcessEnv): string[] | undefined {
	const raw = env.GJC_HARNESS_APP_SERVER_COMMAND?.trim();
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed) && parsed.every(part => typeof part === "string")) return parsed;
	} catch {
		// Fall back to shell-like whitespace splitting for local smoke overrides.
	}
	return raw.split(/\s+/).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isJsonRpcError(frame: Record<string, unknown>): boolean {
	return frame.error !== undefined;
}

function errorFromFrame(frame: Record<string, unknown>): Error {
	const error = asRecord(frame.error);
	const message = typeof error.message === "string" ? error.message : "app-server JSON-RPC error";
	return new Error(message);
}

function stateSnapshotFromResult(result: Record<string, unknown>): RpcStateSnapshot {
	const status = typeof result.status === "string" ? result.status : undefined;
	const queued = typeof result.queuedMessageCount === "number" ? result.queuedMessageCount : undefined;
	return {
		isStreaming: Boolean(result.isStreaming) || status === "running" || status === "streaming",
		steeringQueueDepth: queued ?? (typeof result.steeringQueueDepth === "number" ? result.steeringQueueDepth : 0),
		followupQueueDepth: typeof result.followupQueueDepth === "number" ? result.followupQueueDepth : 0,
	};
}

function isAgentStartFrame(frame: Record<string, unknown>): boolean {
	if (frame.method === "turn/started") return true;
	if (frame.method !== "gjc/event") return false;
	const params = asRecord(frame.params);
	const eventType = params.eventType ?? params.event_type;
	if (eventType === "agent_start") return true;
	const event = asRecord(params.event);
	return event.type === "agent_start";
}

function spawnAppServer(opts: GajaeCodeAppServerRpcOptions): AppServerTransport {
	const env = opts.env ?? process.env;
	const base = opts.command ?? commandFromEnv(env) ?? ["gjc", "app-server"];
	const args = [...base.slice(1)];
	return spawn(base[0]!, args, {
		cwd: opts.cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
}

/** Real adapter: spawns `gjc app-server` and speaks NDJSON JSON-RPC 2.0 over stdio. */
export class GajaeCodeAppServerRpc implements HarnessRpc {
	#proc: AppServerTransport;
	#buffer = "";
	#cursor = 0;
	#pending = new Map<string | number, PendingResponse>();
	#agentStartCursors: number[] = [];
	#waiters: {
		afterCursor: number;
		resolve: (v: { cursor: number } | null) => void;
		timer: NodeJS.Timeout;
	}[] = [];
	#frameListeners: ((frame: Record<string, unknown>) => void)[] = [];
	#lastFrameAt: string | null = null;
	#alive = true;
	#threadId: string | null = null;
	#readyResolve!: () => void;
	#readyReject!: (error: Error) => void;
	#ready: Promise<void>;

	constructor(opts: GajaeCodeAppServerRpcOptions = {}) {
		this.#ready = new Promise((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});
		this.#proc = opts.transport ?? spawnAppServer(opts);
		this.#proc.stdout.setEncoding?.("utf8");
		this.#proc.stdout.on("data", chunk => this.#onData(String(chunk)));
		this.#proc.on("exit", () => {
			this.#alive = false;
		});
		this.#proc.on("error", error => {
			this.#alive = false;
			this.#readyReject(error instanceof Error ? error : new Error(String(error)));
		});
		void this.#handshake(opts);
	}

	async ready(): Promise<void> {
		await this.#ready;
	}

	async #handshake(opts: GajaeCodeAppServerRpcOptions): Promise<void> {
		try {
			await this.#waitForReadyFrame();
			await this.#request("initialize", {});
			this.#notify("initialized", {});
			const started = asRecord(await this.#request("thread/start", { cwd: opts.cwd ?? process.cwd() }));
			const thread = asRecord(started.thread);
			const threadId =
				typeof thread.id === "string" ? thread.id : typeof thread.threadId === "string" ? thread.threadId : null;
			if (!threadId) throw new Error("app-server thread/start response missing thread id");
			this.#threadId = threadId;
			this.#readyResolve();
		} catch (error) {
			this.#readyReject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	#waitForReadyFrame(): Promise<void> {
		return new Promise(resolve => {
			const off = this.onEventFrame?.(frame => {
				if (frame.type === "ready") {
					off?.();
					resolve();
				}
			});
		});
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		let idx = this.#buffer.indexOf("\n");
		while (idx >= 0) {
			const line = this.#buffer.slice(0, idx).trim();
			this.#buffer = this.#buffer.slice(idx + 1);
			if (line) this.#onFrame(line);
			idx = this.#buffer.indexOf("\n");
		}
	}

	#onFrame(line: string): void {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const id = frame.id;
		if ((typeof id === "string" || typeof id === "number") && this.#pending.has(id)) {
			const pending = this.#pending.get(id);
			this.#pending.delete(id);
			if (isJsonRpcError(frame)) pending?.reject(errorFromFrame(frame));
			else pending?.resolve(asRecord(frame.result));
			return;
		}

		if (frame.type !== "ready") {
			this.#cursor += 1;
			this.#lastFrameAt = new Date().toISOString();
			if (isAgentStartFrame(frame)) {
				const cursor = this.#cursor;
				this.#agentStartCursors.push(cursor);
				this.#waiters = this.#waiters.filter(w => {
					if (cursor > w.afterCursor) {
						clearTimeout(w.timer);
						w.resolve({ cursor });
						return false;
					}
					return true;
				});
			}
		}
		for (const listener of this.#frameListeners) {
			try {
				listener(frame);
			} catch {
				// Listener failures must not kill the transport reader.
			}
		}
	}

	#request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, err => {
				if (err) {
					this.#pending.delete(id);
					reject(err);
				}
			});
		});
	}

	#notify(method: string, params: Record<string, unknown>): void {
		this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	onEventFrame(listener: (frame: Record<string, unknown>) => void): () => void {
		this.#frameListeners.push(listener);
		return () => {
			this.#frameListeners = this.#frameListeners.filter(l => l !== listener);
		};
	}

	isLive(): boolean {
		return this.#alive;
	}

	lastFrameAt(): string | null {
		return this.#lastFrameAt;
	}

	async getState(): Promise<RpcStateSnapshot> {
		await this.#ready;
		const result = await this.#request("gjc/state/read", { threadId: this.#threadId });
		return stateSnapshotFromResult(result);
	}

	async getLastAssistantText(): Promise<string | null> {
		await this.#ready;
		const result = await this.#request("gjc/messages/get", { threadId: this.#threadId });
		const messages = Array.isArray(result)
			? result
			: Array.isArray(result.messages)
				? result.messages
				: Array.isArray(result.data)
					? result.data
					: [];
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const message = asRecord(messages[i]);
			if (message.role !== "assistant") continue;
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				const text = content
					.map(part => {
						const record = asRecord(part);
						return typeof record.text === "string" ? record.text : "";
					})
					.join("");
				if (text.length > 0) return text;
			}
		}
		return null;
	}

	async sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }> {
		await this.#ready;
		const commandId = randomUUID();
		try {
			await this.#request("turn/start", { threadId: this.#threadId, input: prompt, commandId });
			return { commandId, ack: true };
		} catch {
			return { commandId, ack: false };
		}
	}

	eventCursor(): number {
		return this.#cursor;
	}

	waitForAgentStart(afterCursor: number, timeoutMs: number): Promise<{ cursor: number } | null> {
		const existing = this.#agentStartCursors.find(c => c > afterCursor);
		if (existing !== undefined) return Promise.resolve({ cursor: existing });
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.#waiters = this.#waiters.filter(w => w.timer !== timer);
				resolve(null);
			}, timeoutMs);
			this.#waiters.push({ afterCursor, resolve, timer });
		});
	}

	async close(): Promise<void> {
		try {
			this.#proc.stdin.end();
		} catch {
			// ignore
		}
		this.#proc.kill();
	}
}
