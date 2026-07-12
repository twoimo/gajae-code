export type AgentWireJson = null | boolean | number | string | AgentWireJson[] | { [key: string]: AgentWireJson };

export type AgentWireWorkflowStage = "deep-interview" | "ralplan" | "ultragoal";
export type AgentWireWorkflowGateKind = "question" | "approval" | "execution";

export interface AgentWireJsonSchema {
	type?: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, AgentWireJsonSchema>;
	required?: string[];
	additionalProperties?: boolean | AgentWireJsonSchema;
	items?: AgentWireJsonSchema;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
	minimum?: number;
	maximum?: number;
	title?: string;
	description?: string;
	oneOf?: AgentWireJsonSchema[];
	anyOf?: AgentWireJsonSchema[];
}

export interface AgentWireWorkflowGate {
	type: "workflow_gate";
	gate_id: string;
	stage: AgentWireWorkflowStage;
	kind: AgentWireWorkflowGateKind;
	schema: AgentWireJsonSchema;
	schema_hash: string;
	options?: Array<{ value: unknown; label: string; description?: string }>;
	context: Record<string, unknown>;
	created_at: string;
	required: true;
}

export interface AgentWireWorkflowGateResponse {
	gate_id: string;
	answer: unknown;
	idempotency_key?: string;
}
export interface AgentWireUnattendedDeclaration {
	actor: string;
	budget: { max_tokens: number; max_tool_calls: number; max_wall_time_ms: number; max_cost_usd: number };
	scopes: string[];
	action_allowlist: string[];
}

export function isAgentWireWorkflowGate(value: unknown): value is AgentWireWorkflowGate {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const gate = value as Record<string, unknown>;
	return (
		gate.type === "workflow_gate" &&
		typeof gate.gate_id === "string" &&
		["deep-interview", "ralplan", "ultragoal"].includes(gate.stage as string) &&
		["question", "approval", "execution"].includes(gate.kind as string) &&
		typeof gate.schema_hash === "string" &&
		!!gate.schema &&
		typeof gate.schema === "object" &&
		!!gate.context &&
		typeof gate.context === "object" &&
		typeof gate.created_at === "string" &&
		gate.required === true &&
		(gate.options === undefined || Array.isArray(gate.options))
	);
}

export function isAgentWireUnattendedDeclaration(value: unknown): value is AgentWireUnattendedDeclaration {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const declaration = value as Record<string, unknown>;
	const budget = declaration.budget;
	return (
		typeof declaration.actor === "string" &&
		declaration.actor.trim() !== "" &&
		!!budget &&
		typeof budget === "object" &&
		["max_tokens", "max_tool_calls", "max_wall_time_ms", "max_cost_usd"].every(
			key =>
				typeof (budget as Record<string, unknown>)[key] === "number" &&
				Number.isFinite((budget as Record<string, number>)[key]) &&
				(budget as Record<string, number>)[key] > 0,
		) &&
		Array.isArray(declaration.scopes) &&
		declaration.scopes.every(scope => typeof scope === "string") &&
		Array.isArray(declaration.action_allowlist) &&
		declaration.action_allowlist.every(action => typeof action === "string")
	);
}
