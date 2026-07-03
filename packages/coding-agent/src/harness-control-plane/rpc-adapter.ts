/**
 * gajae-code transport adapter.
 *
 * The gajae-code harness is driven via `gjc --mode rpc` (see docs/rpc.md). Acceptance
 * is a PROTOCOL FACT, not an echo: a prompt is `accepted` only when the RPC command is
 * acked AND the next `agent_start` event arrives after the pre-submit cursor within the
 * timeout, with an idle + empty-queue pre-state. Ack alone never means accepted.
 *
 * The neutral acceptance contract lives in adapter-contract.ts.
 * {@link GajaeCodeRpc} provides the legacy `gjc --mode rpc` subprocess implementation.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HarnessRpc, RpcStateSnapshot } from "./adapter-contract";

interface PendingResponse {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

/**
 * Real adapter: spawns `gjc --mode rpc --session-dir <dir>` and speaks the JSONL
 * protocol from docs/rpc.md. Verified end-to-end in the M10 suite.
 */
export class GajaeCodeRpc implements HarnessRpc {
	#proc: ChildProcessWithoutNullStreams;
	#buffer = "";
	#cursor = 0;
	#pending = new Map<string, PendingResponse>();
	#agentStartCursors: number[] = [];
	#waiters: {
		afterCursor: number;
		resolve: (v: { cursor: number } | null) => void;
		timer: NodeJS.Timeout;
	}[] = [];
	#frameListeners: ((frame: Record<string, unknown>) => void)[] = [];
	#lastFrameAt: string | null = null;
	#alive = true;

	constructor(opts: { sessionDir: string; command?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }) {
		const base = opts.command ?? ["gjc", "--mode", "rpc"];
		const args = [...base.slice(1), "--session-dir", opts.sessionDir];
		this.#proc = spawn(base[0], args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.#proc.stdout.setEncoding("utf8");
		this.#proc.stdout.on("data", chunk => this.#onData(chunk as string));
		this.#proc.on("exit", () => {
			this.#alive = false;
		});
		this.#proc.on("error", () => {
			this.#alive = false;
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
		const type = frame.type;
		if (type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (id && this.#pending.has(id)) {
				const pending = this.#pending.get(id);
				this.#pending.delete(id);
				pending?.resolve(frame);
			}
			return;
		}
		if (type === "ready") return;
		// Any other frame is a session/agent event: advance the cursor.
		this.#cursor += 1;
		this.#lastFrameAt = new Date().toISOString();
		// Session events arrive as canonical `event` frames: the agent event type
		// lives in `payload.event_type`. Non-event frames keep their flat `type`.
		const effectiveType =
			type === "event" && frame.payload && typeof frame.payload === "object"
				? (frame.payload as { event_type?: unknown }).event_type
				: type;
		if (effectiveType === "agent_start") {
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
		// Fire-and-forget frame listeners (owner maps + emits). Never await; never let a listener kill the reader.
		for (const listener of this.#frameListeners) {
			try {
				listener(frame);
			} catch {
				// swallow listener errors
			}
		}
	}

	#send(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`, err => {
				if (err) {
					this.#pending.delete(id);
					reject(err);
				}
			});
		});
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
		const res = await this.#send({ type: "get_state" });
		const data = (res.data ?? {}) as Record<string, unknown>;
		return {
			isStreaming: Boolean(data.isStreaming),
			steeringQueueDepth: typeof data.queuedMessageCount === "number" ? data.queuedMessageCount : 0,
			followupQueueDepth: 0,
		};
	}

	async getLastAssistantText(): Promise<string | null> {
		const res = await this.#send({ type: "get_last_assistant_text" });
		const data = (res.data ?? {}) as Record<string, unknown>;
		return typeof data.text === "string" ? data.text : null;
	}

	async sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }> {
		const id = randomUUID();
		const ackPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#proc.stdin.write(`${JSON.stringify({ id, type: "prompt", message: prompt })}\n`, err => {
				if (err) {
					this.#pending.delete(id);
					reject(err);
				}
			});
		});
		const res = await ackPromise;
		return { commandId: id, ack: res.success === true };
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
