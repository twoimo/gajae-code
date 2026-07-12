import {
	AGENT_WIRE_CURRENT_VERSION,
	AGENT_WIRE_EVENT_TYPES as AGENT_WIRE_EVENT_TYPE_CATALOG,
	type AgentWireCompactMessageUpdatePayload as AgentWireCompactMessageUpdateJson,
	type AgentWireEnvelope,
	type AgentWireEventType as AgentWireEventTypeJson,
	type AgentWireObservedSignal,
	type AgentWireOwnerObservation,
	type AgentWireVersion,
} from "@gajae-code/agent-wire";
import type { AssistantMessageEvent } from "@gajae-code/ai";
import type { AgentSessionEvent } from "../../../session/agent-session";

/** @deprecated Use AGENT_WIRE_CURRENT_VERSION from @gajae-code/agent-wire. */
export const AGENT_WIRE_PROTOCOL_VERSION = AGENT_WIRE_CURRENT_VERSION;
export type AgentWireProtocolVersion = AgentWireVersion;
/** The JSON discriminant is owned by agent-wire; the adapter asserts domain parity. */
export type AgentWireEventType = AgentWireEventTypeJson;
type _DomainEventParity = AgentSessionEvent["type"] extends AgentWireEventType
	? AgentWireEventType extends AgentSessionEvent["type"]
		? true
		: never
	: never;
const domainEventParity: _DomainEventParity = true;
void domainEventParity;

export { AGENT_WIRE_EVENT_TYPE_CATALOG as AGENT_WIRE_EVENT_TYPES };

/** Domain adapter for the rich event JSON DTO. */
export interface AgentWireEventPayload {
	event_type: AgentWireEventType;
	event: AgentSessionEvent;
}
export type AgentWireCompactAssistantMessageEvent = AssistantMessageEvent extends infer TEvent
	? TEvent extends { type: string }
		? Omit<TEvent, "partial" | "message" | "error">
		: never
	: never;
/** Domain specialization of the v2 compact JSON DTO. */
export interface AgentWireCompactMessageUpdatePayload
	extends Omit<AgentWireCompactMessageUpdateJson, "assistantMessageEvent" | "checkpoint_message"> {
	assistantMessageEvent: AgentWireCompactAssistantMessageEvent;
	checkpoint_message?: Extract<AgentSessionEvent, { type: "message_update" }>["message"];
}
export type AgentWireEventFramePayload = AgentWireEventPayload | AgentWireCompactMessageUpdatePayload;
export type { AgentWireObservedSignal, AgentWireOwnerObservation };
/** Generic envelope specialization backed by the leaf envelope grammar. */
export type AgentWireFrameEnvelope<
	TType extends AgentWireEnvelope["type"] = AgentWireEnvelope["type"],
	TPayload = unknown,
> = Omit<AgentWireEnvelope, "type" | "payload"> & { type: TType; payload: TPayload };
export type AgentWireFrameType = AgentWireEnvelope["type"];
export type AgentWireEventFrame = AgentWireFrameEnvelope<"event", AgentWireEventPayload>;
export type AgentWireCompactEventFrame = AgentWireFrameEnvelope<"event", AgentWireEventFramePayload>;
