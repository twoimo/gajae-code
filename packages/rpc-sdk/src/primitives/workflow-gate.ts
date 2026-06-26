import { PROTOCOL_VERSION } from "../protocol/generated";
import type { GjcFrame, JsonObject, JsonValue } from "../protocol/types";

export type WorkflowGatePayload = JsonObject & { gateId: string; prompt: string; choices?: JsonValue[] }
export function workflowGate(gateId: string, prompt: string, choices?: JsonValue[]): WorkflowGatePayload { return { gateId, prompt, ...(choices ? { choices } : {}) }; }
export function workflowGateResponseFrame(sessionId: string, gateId: string, answer: JsonValue, correlationId = gateId): GjcFrame<JsonObject> { return { protocolVersion: PROTOCOL_VERSION, frameId: `gate-${gateId}-response`, sessionId, seq: 0, direction: "client_to_server", kind: "workflow_gate", type: "workflow_gate_response", correlationId, replay: false, capabilityScope: "gate_answer", payload: { gateId, answer } }; }
