import type { CapabilityScope, RedactionPolicy } from "./generated";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type Direction = "server_to_client" | "client_to_server";
export type FrameKind = "ready" | "hello" | "command" | "response" | "event" | "ui_request" | "permission_request" | "host_tool_call" | "host_uri_request" | "workflow_gate" | "notification" | "reset" | "error";
export interface GjcFrame<TPayload = JsonValue> {
	protocolVersion: 1;
	frameId: string;
	sessionId: string;
	seq: number;
	direction: Direction;
	kind: FrameKind;
	type: string;
	correlationId?: string;
	replay: boolean;
	capabilityScope?: CapabilityScope;
	payload: TPayload;
}
export interface HelloSessionRequest extends JsonObject { session: string; redaction: RedactionPolicy }
export interface HelloRequest { protocolVersion: 1; requested: HelloSessionRequest[]; grantId?: string }
export interface HelloAcceptedPayload extends JsonObject { sessions: number }
export interface Cursor { sessionId: string; seq: number }
