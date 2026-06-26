/**
 * gajae-code RPC adapter + single-flight acceptance.
 *
 * The harness control plane is driven through the rpc-sdk UDS daemon transport.
 * Acceptance is a PROTOCOL FACT, not an echo: a prompt is `accepted` only when
 * the RPC command is acked AND the next `agent_start` event arrives after the
 * pre-submit cursor within `timeoutMs`, with an idle + empty-queue pre-state.
 * Ack alone never means accepted.
 *
 * The acceptance logic ({@link singleFlightAccept}) is decoupled from the transport via
 * the {@link HarnessRpc} interface so it is unit-testable with a fake, while
 * {@link GajaeCodeDaemonRpc} provides the rpc-sdk daemon-backed implementation.
 */

import { randomUUID } from "node:crypto";
import {
	buildCommandFrame,
	connectUds,
	defaultDaemonSocketPath,
	type GjcFrame,
	type JsonObject,
	performHello,
	type UdsTransport,
} from "@gajae-code/rpc-sdk";

export interface RpcStateSnapshot {
	isStreaming: boolean;
	steeringQueueDepth: number;
	followupQueueDepth: number;
}

/** Abstract handle to a live gajae-code RPC session. */
export interface HarnessRpc {
	getState(): Promise<RpcStateSnapshot>;
	/** Send a prompt; resolves with the RPC command id and whether it was acked. Does NOT await agent_start. */
	sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }>;
	/** Monotonic count of events observed so far (the acceptance cursor). */
	eventCursor(): number;
	/** Resolve when an `agent_start` event arrives strictly after `afterCursor`, else null on timeout. */
	waitForAgentStart(afterCursor: number, timeoutMs: number): Promise<{ cursor: number } | null>;
	close(): Promise<void>;
	/** Subscribe to parsed event frames (non-ready, non-response), fired AFTER the cursor advances. Returns unsubscribe. */
	onEventFrame?(listener: (frame: Record<string, unknown>) => void): () => void;
	/** Whether the underlying RPC subprocess is still alive. */
	isLive?(): boolean;
	/** ISO timestamp of the last observed event frame, or null. */
	lastFrameAt?(): string | null;
	/** Final assistant text from the live session (for review-verdict extraction); null when unavailable. */
	getLastAssistantText?(): Promise<string | null>;
}

export interface AcceptanceResult {
	accepted: boolean;
	reason: string;
	commandId: string | null;
	preSubmitCursor: number;
	agentStartCursor: number | null;
	preSubmitState: RpcStateSnapshot;
}

/**
 * Single-flight acceptance: idle + empty-queue pre-state, ack, then the NEXT
 * `agent_start` after the pre-submit cursor within `timeoutMs`.
 */
export async function singleFlightAccept(
	rpc: HarnessRpc,
	prompt: string,
	timeoutMs: number,
): Promise<AcceptanceResult> {
	const pre = await rpc.getState();
	const preSubmitCursor = rpc.eventCursor();
	if (pre.isStreaming || pre.steeringQueueDepth > 0 || pre.followupQueueDepth > 0) {
		return {
			accepted: false,
			reason: "pre-state-not-idle",
			commandId: null,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	const { commandId, ack } = await rpc.sendPrompt(prompt);
	if (!ack) {
		return {
			accepted: false,
			reason: "no-ack",
			commandId,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	const started = await rpc.waitForAgentStart(preSubmitCursor, timeoutMs);
	if (!started) {
		return {
			accepted: false,
			reason: "no-agent-start-within-timeout",
			commandId,
			preSubmitCursor,
			agentStartCursor: null,
			preSubmitState: pre,
		};
	}
	return {
		accepted: true,
		reason: "protocol-ack-single-flight",
		commandId,
		preSubmitCursor,
		agentStartCursor: started.cursor,
		preSubmitState: pre,
	};
}

interface PendingResponse {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

function framePayloadObject(frame: GjcFrame<unknown>): Record<string, unknown> {
	return frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
		? (frame.payload as Record<string, unknown>)
		: {};
}

function responseAck(frame: GjcFrame<unknown>): boolean {
	const payload = framePayloadObject(frame);
	return (
		frame.kind === "response" &&
		(payload.success === true || payload.ok === true || frame.type === "dispatch_immediate")
	);
}

/**
 * rpc-sdk daemon-backed adapter. This is the migrated harness transport path:
 * connect to the local UDS daemon, perform hello for the harness session, and
 * exchange canonical GjcFrames instead of spawning legacy JSONL RPC mode.
 *
 * The current Rust daemon dispatch path is a protocol/broker pipeline. It acks
 * scheduled commands but does not yet host the coding-agent runtime, so state and
 * agent events are only available once runtime hosting is wired into the daemon.
 */
export class GajaeCodeDaemonRpc implements HarnessRpc {
	#transport: UdsTransport | undefined;
	#sessionId: string;
	#socketPath: string;
	#grantId: string | undefined;
	#seq = 0;
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
	#alive = false;
	#lastAssistantText: string | null = null;

	constructor(opts: { sessionId: string; socketPath?: string; grantId?: string }) {
		this.#sessionId = opts.sessionId;
		this.#socketPath = opts.socketPath ?? defaultDaemonSocketPath();
		this.#grantId = opts.grantId;
	}

	async connect(): Promise<void> {
		const transport = await connectUds({ socketPath: this.#socketPath });
		this.#transport = transport;
		transport.on("frame", frame => this.#onFrame(frame));
		transport.on("close", () => {
			this.#alive = false;
		});
		transport.on("error", error => {
			this.#alive = false;
			for (const [id, pending] of this.#pending) {
				this.#pending.delete(id);
				pending.reject(error);
			}
		});
		await performHello(transport, { sessions: [this.#sessionId], grantId: this.#grantId });
		this.#alive = true;
	}

	#onFrame(frame: GjcFrame<unknown>): void {
		if (frame.kind === "ready") return;
		const correlationId = typeof frame.correlationId === "string" ? frame.correlationId : undefined;
		if ((frame.kind === "response" || frame.kind === "error") && correlationId && this.#pending.has(correlationId)) {
			const pending = this.#pending.get(correlationId);
			this.#pending.delete(correlationId);
			if (frame.kind === "error") pending?.reject(new Error(JSON.stringify(frame.payload)));
			else pending?.resolve(frame as unknown as Record<string, unknown>);
			return;
		}

		this.#cursor += 1;
		this.#lastFrameAt = new Date().toISOString();
		const payload = framePayloadObject(frame);
		const effectiveType =
			frame.kind === "event" && typeof payload.event_type === "string" ? payload.event_type : frame.type;
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
		if (
			typeof payload.text === "string" &&
			(frame.type === "assistant_message" || effectiveType === "assistant_message")
		) {
			this.#lastAssistantText = payload.text;
		}
		for (const listener of this.#frameListeners) {
			try {
				listener(frame as unknown as Record<string, unknown>);
			} catch {
				// swallow listener errors
			}
		}
	}

	async #send(type: "get_state" | "prompt", payload: JsonObject): Promise<GjcFrame<unknown>> {
		const transport = this.#transport;
		if (!transport) throw new Error("GajaeCodeDaemonRpc is not connected");
		const commandId = randomUUID();
		const frame = buildCommandFrame(type, {
			sessionId: this.#sessionId,
			commandId,
			frameId: commandId,
			seq: ++this.#seq,
			payload,
		});
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(commandId, { resolve, reject });
		try {
			await transport.write(frame);
		} catch (error) {
			this.#pending.delete(commandId);
			throw error;
		}
		return (await promise) as unknown as GjcFrame<unknown>;
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
		const frame = await this.#send("get_state", {});
		const payload = framePayloadObject(frame);
		const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<
			string,
			unknown
		>;
		return {
			isStreaming: Boolean(data.isStreaming),
			steeringQueueDepth: typeof data.queuedMessageCount === "number" ? data.queuedMessageCount : 0,
			followupQueueDepth: typeof data.followupQueueDepth === "number" ? data.followupQueueDepth : 0,
		};
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#lastAssistantText;
	}

	async sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }> {
		const frame = await this.#send("prompt", { message: prompt });
		return {
			commandId: typeof frame.correlationId === "string" ? frame.correlationId : frame.frameId,
			ack: responseAck(frame),
		};
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
		this.#transport?.close();
		this.#transport = undefined;
		this.#alive = false;
	}
}
