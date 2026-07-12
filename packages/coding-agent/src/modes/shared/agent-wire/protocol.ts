import {
	AGENT_WIRE_CURRENT_VERSION,
	AGENT_WIRE_EVENT_TYPES,
	type AgentWireEnvelope,
	type AgentWireEventPayloadV1,
	type AgentWireFrameType,
	type AgentWireWorkflowGate,
} from "@gajae-code/agent-wire";

/** @deprecated Use AGENT_WIRE_CURRENT_VERSION from @gajae-code/agent-wire. */
export const BRIDGE_PROTOCOL_VERSION = AGENT_WIRE_CURRENT_VERSION;
export type AgentSessionEventType = (typeof AGENT_WIRE_EVENT_TYPES)[number];
export const AGENT_SESSION_EVENT_TYPES = AGENT_WIRE_EVENT_TYPES;
export type BridgeFrameType = AgentWireFrameType;
/** Compatibility view over the shared envelope; serialization is owned by agent-wire. */
export type BridgeFrameEnvelope<TType extends BridgeFrameType = BridgeFrameType, TPayload = unknown> = Omit<
	AgentWireEnvelope,
	"type" | "payload"
> & { type: TType; payload: TPayload };
export type BridgeEventPayload = AgentWireEventPayloadV1;
export type BridgeEventFrame = BridgeFrameEnvelope<"event", BridgeEventPayload>;
export type BridgeWorkflowGateFrame = BridgeFrameEnvelope<"workflow_gate", AgentWireWorkflowGate>;
