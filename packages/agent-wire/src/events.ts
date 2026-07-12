import type { AgentWireJson } from "./workflow-gate";

export const AGENT_WIRE_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"subagent_steer_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
] as const;
export type AgentWireEventType = (typeof AGENT_WIRE_EVENT_TYPES)[number];

/** JSON counterpart to the rich domain event; conversion stays in the consumer boundary. */
export interface AgentWireRichEventPayload {
	event_type: AgentWireEventType;
	event: Record<string, AgentWireJson>;
}
/** v2-only delta format. It is never valid in a v1 envelope. */
export interface AgentWireCompactMessageUpdatePayload {
	event_type: "message_update";
	compact: true;
	message_id: string | null;
	content_index: number | null;
	assistantMessageEvent: Record<string, AgentWireJson>;
	checkpoint_message?: AgentWireJson;
	checkpoint_reason?: "periodic";
}
export type AgentWireEventPayloadV1 = AgentWireRichEventPayload;
export type AgentWireEventPayloadV2 = AgentWireRichEventPayload | AgentWireCompactMessageUpdatePayload;

export type AgentWireObservedSignal =
	| "SessionStart"
	| "prompt-accepted"
	| "tool-call"
	| "test-running"
	| "commit-created"
	| "completed"
	| "error"
	| "streaming"
	| "idle";
export interface AgentWireOwnerObservation {
	eventType?: AgentWireEventType;
	frameType?: string;
	kind: string;
	signal: AgentWireObservedSignal | null;
	evidence: Record<string, AgentWireJson>;
	severity: "info" | "warn" | "critical";
	semantic: boolean;
	coalesceKey: string | null;
}

export function isAgentWireEventType(value: unknown): value is AgentWireEventType {
	return typeof value === "string" && AGENT_WIRE_EVENT_TYPES.includes(value as AgentWireEventType);
}
export function isAgentWireRichEventPayload(value: unknown): value is AgentWireRichEventPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return (
		isAgentWireEventType(payload.event_type) &&
		!!payload.event &&
		typeof payload.event === "object" &&
		!Array.isArray(payload.event)
	);
}
export function isAgentWireCompactMessageUpdatePayload(value: unknown): value is AgentWireCompactMessageUpdatePayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return (
		payload.event_type === "message_update" &&
		payload.compact === true &&
		(typeof payload.message_id === "string" || payload.message_id === null) &&
		(typeof payload.content_index === "number" || payload.content_index === null) &&
		!!payload.assistantMessageEvent &&
		typeof payload.assistantMessageEvent === "object" &&
		!Array.isArray(payload.assistantMessageEvent) &&
		(payload.checkpoint_reason === undefined || payload.checkpoint_reason === "periodic")
	);
}
