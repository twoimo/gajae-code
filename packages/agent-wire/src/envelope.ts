import { isAgentWireCompactMessageUpdatePayload, isAgentWireRichEventPayload } from "./events";
import { AGENT_WIRE_CURRENT_VERSION, AGENT_WIRE_PREVIOUS_VERSION } from "./version";
import type { AgentWireJson } from "./workflow-gate";

export type AgentWireFrameType =
	| "ready"
	| "event"
	| "response"
	| "ui_request"
	| "permission_request"
	| "host_tool_call"
	| "host_uri_request"
	| "reset"
	| "workflow_gate"
	| "error";
interface AgentWireEnvelopeBase<TType extends AgentWireFrameType, TPayload> {
	protocol_version: number;
	session_id: string;
	seq: number;
	frame_id: string;
	correlation_id?: string;
	type: TType;
	payload: TPayload;
}
/**
 * Public transport envelopes carry untrusted JSON. Consumers narrow payloads
 * with their frame-specific adapters before using them.
 */
export type AgentWireEnvelopeV1<TType extends AgentWireFrameType = AgentWireFrameType> = AgentWireEnvelopeBase<
	TType,
	unknown
> & { protocol_version: typeof AGENT_WIRE_PREVIOUS_VERSION };
/** Current v2 retains the exact base envelope and permits compact message_update after validation. */
export type AgentWireEnvelopeV2<TType extends AgentWireFrameType = AgentWireFrameType> = AgentWireEnvelopeBase<
	TType,
	unknown
> & { protocol_version: typeof AGENT_WIRE_CURRENT_VERSION };
export type AgentWireEnvelope = AgentWireEnvelopeV1 | AgentWireEnvelopeV2;

export const AGENT_WIRE_FRAME_TYPES: readonly AgentWireFrameType[] = [
	"ready",
	"event",
	"response",
	"ui_request",
	"permission_request",
	"host_tool_call",
	"host_uri_request",
	"reset",
	"workflow_gate",
	"error",
];
function isJson(value: unknown): value is AgentWireJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJson);
	return typeof value === "object" && value !== null && Object.values(value).every(isJson);
}
function hasBaseShape(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const envelope = value as Record<string, unknown>;
	return (
		typeof envelope.session_id === "string" &&
		typeof envelope.seq === "number" &&
		Number.isInteger(envelope.seq) &&
		envelope.seq >= 1 &&
		typeof envelope.frame_id === "string" &&
		(envelope.correlation_id === undefined || typeof envelope.correlation_id === "string") &&
		typeof envelope.type === "string" &&
		AGENT_WIRE_FRAME_TYPES.includes(envelope.type as AgentWireFrameType) &&
		"payload" in envelope
	);
}
export function isAgentWireEnvelope(value: unknown): value is AgentWireEnvelope {
	if (!hasBaseShape(value)) return false;
	const envelope = value as Record<string, unknown>;
	if (envelope.type === "event") {
		if (envelope.protocol_version === AGENT_WIRE_PREVIOUS_VERSION)
			return isAgentWireRichEventPayload(envelope.payload);
		return (
			envelope.protocol_version === AGENT_WIRE_CURRENT_VERSION &&
			(isAgentWireRichEventPayload(envelope.payload) || isAgentWireCompactMessageUpdatePayload(envelope.payload))
		);
	}
	return (
		(envelope.protocol_version === AGENT_WIRE_PREVIOUS_VERSION ||
			envelope.protocol_version === AGENT_WIRE_CURRENT_VERSION) &&
		isJson(envelope.payload)
	);
}
export function parseAgentWireEnvelope(value: unknown): AgentWireEnvelope {
	if (!isAgentWireEnvelope(value)) throw new TypeError("Invalid or unsupported agent-wire envelope");
	return value;
}
