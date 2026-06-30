/**
 * Typed `workflow_gate` client helpers (#322).
 *
 * Mirrors the server-side workflow-gate contract for bridge consumers: a typed
 * gate frame, the response shape, a frame type-guard, and a headless policy that
 * routes received gates to an agent callback and posts answers back through the
 * existing owner-token ui-response flow.
 */
import type { BridgeFrame } from "./reference-consumer";

export type WorkflowGateStage = "deep-interview" | "ralplan" | "ultragoal";
export type WorkflowGateKind = "question" | "approval" | "execution";

export interface WorkflowGateOption {
	value: unknown;
	label: string;
	description?: string;
}

export interface WorkflowGate {
	type: "workflow_gate";
	gate_id: string;
	stage: WorkflowGateStage;
	kind: WorkflowGateKind;
	schema: unknown;
	schema_hash: string;
	options?: WorkflowGateOption[];
	context: Record<string, unknown>;
	created_at: string;
	required: true;
}

export interface WorkflowGateResponse {
	gate_id: string;
	answer: unknown;
	idempotency_key?: string;
}

/** Numeric budget caps for bounded unattended mode. */
export interface UnattendedBudget {
	max_tokens: number;
	max_tool_calls: number;
	max_wall_time_ms: number;
	max_cost_usd: number;
}

/** Budget enforcement mode: `bounded` (default) enforces caps; `unbounded`
 * disables token/tool-call/wall-time/cost aborts while still observing usage. */
export type UnattendedBudgetMode = "bounded" | "unbounded";

interface UnattendedDeclarationBase {
	actor: string;
	scopes: string[];
	action_allowlist: string[];
}

/** Bounded declaration: a numeric budget is required. */
export interface BoundedUnattendedDeclaration extends UnattendedDeclarationBase {
	budget_mode?: "bounded";
	budget: UnattendedBudget;
}

/** Unbounded declaration: no numeric budget (#318/#319 D3). */
export interface UnboundedUnattendedDeclaration extends UnattendedDeclarationBase {
	budget_mode: "unbounded";
	budget?: undefined;
}

/** Unattended declaration carried on the bridge handshake (#318/#319). */
export type UnattendedDeclaration = BoundedUnattendedDeclaration | UnboundedUnattendedDeclaration;

/** Type guard: is this bridge frame a fully-formed workflow_gate frame? */
export function isWorkflowGateFrame(frame: BridgeFrame): frame is BridgeFrame<WorkflowGate> {
	if (frame.type !== "workflow_gate") return false;
	const p = frame.payload as Partial<WorkflowGate> | undefined;
	if (!p || typeof p !== "object") return false;
	const stages: WorkflowGateStage[] = ["deep-interview", "ralplan", "ultragoal"];
	const kinds: WorkflowGateKind[] = ["question", "approval", "execution"];
	return (
		p.type === "workflow_gate" &&
		typeof p.gate_id === "string" &&
		typeof p.stage === "string" &&
		stages.includes(p.stage as WorkflowGateStage) &&
		typeof p.kind === "string" &&
		kinds.includes(p.kind as WorkflowGateKind) &&
		typeof p.schema_hash === "string" &&
		typeof p.created_at === "string" &&
		p.required === true &&
		"schema" in p &&
		typeof p.context === "object" &&
		p.context !== null &&
		(p.options === undefined || Array.isArray(p.options))
	);
}

/** A callback that produces an answer for a received gate (the agent's "memory"). */
export type WorkflowGateResolver = (gate: WorkflowGate) => unknown | Promise<unknown>;
