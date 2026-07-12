import {
	type AgentWireEnvelope,
	type AgentWireUnattendedDeclaration,
	type AgentWireWorkflowGate,
	type AgentWireWorkflowGateResponse,
	isAgentWireWorkflowGate,
} from "@gajae-code/agent-wire";

/** @deprecated Use AgentWireWorkflowStage from @gajae-code/agent-wire. */
export type WorkflowGateStage = AgentWireWorkflowGate["stage"];
/** @deprecated Use AgentWireWorkflowGateKind from @gajae-code/agent-wire. */
export type WorkflowGateKind = AgentWireWorkflowGate["kind"];
/** @deprecated Use AgentWireWorkflowGate from @gajae-code/agent-wire. */
export type WorkflowGate = AgentWireWorkflowGate;
/** @deprecated Use AgentWireWorkflowGateResponse from @gajae-code/agent-wire. */
export type WorkflowGateResponse = AgentWireWorkflowGateResponse;
/** @deprecated Use AgentWireUnattendedDeclaration from @gajae-code/agent-wire. */
export type UnattendedDeclaration = AgentWireUnattendedDeclaration;

/** Type guard: is this bridge frame a fully-formed workflow_gate frame? */
export function isWorkflowGateFrame(
	frame: AgentWireEnvelope,
): frame is AgentWireEnvelope & { type: "workflow_gate"; payload: AgentWireWorkflowGate } {
	return frame.type === "workflow_gate" && isAgentWireWorkflowGate(frame.payload);
}

/** A callback that produces an answer for a received gate (the agent's "memory"). */
export type WorkflowGateResolver = (gate: WorkflowGate) => unknown | Promise<unknown>;
