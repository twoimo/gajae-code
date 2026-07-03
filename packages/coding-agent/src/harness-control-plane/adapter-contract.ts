/**
 * Neutral harness adapter contract + single-flight acceptance.
 *
 * Acceptance is a protocol fact: a prompt is `accepted` only when the transport
 * command is acked AND the next `agent_start`/turn-start-equivalent event arrives
 * after the pre-submit cursor within the timeout, with an idle + empty-queue
 * pre-state. Ack alone never means accepted.
 */
export interface RpcStateSnapshot {
	isStreaming: boolean;
	steeringQueueDepth: number;
	followupQueueDepth: number;
}

/** Abstract handle to a live gajae-code harness transport session. */
export interface HarnessRpc {
	getState(): Promise<RpcStateSnapshot>;
	/** Send a prompt; resolves with the transport command id and whether it was acked. Does NOT await agent_start. */
	sendPrompt(prompt: string): Promise<{ commandId: string; ack: boolean }>;
	/** Monotonic count of events observed so far (the acceptance cursor). */
	eventCursor(): number;
	/** Resolve when an `agent_start`/turn-start-equivalent event arrives strictly after `afterCursor`, else null on timeout. */
	waitForAgentStart(afterCursor: number, timeoutMs: number): Promise<{ cursor: number } | null>;
	/** Optional transport readiness handshake; owners await this before advertising live. */
	ready?(): Promise<void>;
	close(): Promise<void>;
	/** Subscribe to parsed event frames (non-ready, non-response), fired AFTER the cursor advances. Returns unsubscribe. */
	onEventFrame?(listener: (frame: Record<string, unknown>) => void): () => void;
	/** Whether the underlying transport subprocess is still alive. */
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
