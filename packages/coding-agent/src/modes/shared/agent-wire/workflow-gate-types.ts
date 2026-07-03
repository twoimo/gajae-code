/**
 * Lifecycle stages that emit machine-addressable gates. v1 is single-agent;
 * `team` parallel execution over the wire is deferred, so it is intentionally
 * absent from this union. Gate construction rejects any other stage value.
 */
export type RpcWorkflowStage = "deep-interview" | "ralplan" | "ultragoal";

/** Reserved stage names that are explicitly not part of the v1 contract. */
export const RESERVED_WORKFLOW_STAGES: readonly string[] = ["team"];

export type RpcWorkflowGateKind = "question" | "approval" | "execution";

/**
 * The documented JSON Schema 2020-12 subset supported by the gate validator.
 * Schemas containing any keyword outside this shape are rejected at gate
 * construction time so the server never advertises a schema it cannot validate.
 */
export interface RpcJsonSchema {
	type?: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, RpcJsonSchema>;
	required?: string[];
	additionalProperties?: boolean | RpcJsonSchema;
	items?: RpcJsonSchema;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
	minimum?: number;
	maximum?: number;
	title?: string;
	description?: string;
	oneOf?: RpcJsonSchema[];
	anyOf?: RpcJsonSchema[];
}

export interface RpcWorkflowGateOption {
	value: unknown;
	label: string;
	description?: string;
}

export interface RpcWorkflowGateContext {
	title?: string;
	plan?: string;
	source?: string;
	prompt?: string;
	summary?: string;
	stage_state?: Record<string, unknown>;
	artifact_refs?: Array<{ kind: string; path?: string; sha256?: string }>;
	language?: string;
}

/** Outbound event: a machine-addressable workflow gate awaiting an answer. */
export interface RpcWorkflowGate {
	type: "workflow_gate";
	/** Run-scoped, monotonic, stable id (e.g. `wg_<run>_<stage>_000001`). */
	gate_id: string;
	stage: RpcWorkflowStage;
	kind: RpcWorkflowGateKind;
	schema: RpcJsonSchema;
	/** Canonical hash of `schema`; advertised hash must equal server validation hash. */
	schema_hash: string;
	options?: RpcWorkflowGateOption[];
	context: RpcWorkflowGateContext;
	created_at: string;
	required: true;
}

/** Inbound: the agent's answer to a workflow gate. */
export interface RpcWorkflowGateResponse {
	gate_id: string;
	answer: unknown;
	/** Optional idempotency key; same key + body returns the cached resolution. */
	idempotency_key?: string;
}

/** Outcome of resolving a gate, surfaced back to the answering client. */
export interface RpcWorkflowGateResolution {
	gate_id: string;
	status: "accepted" | "rejected";
	answer_hash: string;
	resolved_at: string;
	/** Present only when `status === "rejected"`. */
	error?: RpcWorkflowGateValidationError;
}

/** Typed error shape for schema validation failures (#315 acceptance). */
export interface RpcWorkflowGateValidationError {
	code: "invalid_workflow_gate_answer";
	gate_id: string;
	schema_hash: string;
	errors: Array<{ path: string; keyword: string; message: string; expected?: unknown }>;
}
