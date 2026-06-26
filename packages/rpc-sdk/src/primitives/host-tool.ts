import { PROTOCOL_VERSION } from "../protocol/generated";
import type { GjcFrame, JsonObject } from "../protocol/types";

export type HostToolDefinition = JsonObject & { name: string; description: string; inputSchema?: JsonObject; label?: string }
export function hostToolDefinition(name: string, description: string, inputSchema?: JsonObject, label?: string): HostToolDefinition { return { name, description, ...(inputSchema ? { inputSchema } : {}), ...(label ? { label } : {}) }; }
export function hostToolResultFrame(sessionId: string, callId: string, result: JsonObject, error?: string): GjcFrame<JsonObject> { return { protocolVersion: PROTOCOL_VERSION, frameId: `host-tool-${callId}-result`, sessionId, seq: 0, direction: "client_to_server", kind: "host_tool_call", type: "host_tool_result", correlationId: callId, replay: false, capabilityScope: "host_tool_result", payload: { callId, result, ...(error ? { error } : {}) } }; }
