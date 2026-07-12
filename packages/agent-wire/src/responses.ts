import type { AgentWireCapability } from "./handshake";
import type { AgentWireUnattendedDeclaration, AgentWireWorkflowGate } from "./workflow-gate";

/** Domain values substituted into the transport-neutral response DTO grammar. */
export interface AgentWireResponseAdapters {
	sessionState: unknown;
	todoPhase: unknown;
	model: unknown;
	thinkingLevel: unknown;
	effort: unknown;
	compactionResult: unknown;
	bashResult: unknown;
	sessionStats: unknown;
	message: unknown;
}

export interface AgentWireWorkflowGateValidationError {
	code: "invalid_workflow_gate_answer";
	gate_id: string;
	schema_hash: string;
	errors: Array<{ path: string; keyword: string; message: string; expected?: unknown }>;
}

/** Outcome of resolving a workflow gate, surfaced to the answering client. */
export interface AgentWireWorkflowGateResolution {
	gate_id: string;
	status: "accepted" | "rejected";
	answer_hash: string;
	resolved_at: string;
	error?: AgentWireWorkflowGateValidationError;
}

export interface AgentWireUnattendedAccepted {
	run_id: string;
	actor: string;
	budget: AgentWireUnattendedDeclaration["budget"];
	scopes: string[];
	action_allowlist: string[];
	accepted_at: string;
}

export interface AgentWireHandoffResult {
	savedPath?: string;
}

type AgentWireResponseSuccess<TCommand extends string, TData = never> = [TData] extends [never]
	? { id?: string; type: "response"; command: TCommand; success: true }
	: { id?: string; type: "response"; command: TCommand; success: true; data: TData };

export type AgentWirePromptResponseDto =
	| AgentWireResponseSuccess<"prompt">
	| AgentWireResponseSuccess<"steer">
	| AgentWireResponseSuccess<"follow_up">
	| AgentWireResponseSuccess<"abort">
	| AgentWireResponseSuccess<"abort_and_prompt">
	| AgentWireResponseSuccess<"new_session", { cancelled: boolean }>;

export type AgentWireStateResponseDto<T extends AgentWireResponseAdapters> =
	| AgentWireResponseSuccess<"get_state", T["sessionState"]>
	| AgentWireResponseSuccess<"set_todos", { todoPhases: T["todoPhase"][] }>
	| AgentWireResponseSuccess<"set_host_tools", { toolNames: string[] }>
	| AgentWireResponseSuccess<"set_host_uri_schemes", { schemes: string[] }>
	| AgentWireResponseSuccess<"get_pending_workflow_gates", { gates: AgentWireWorkflowGate[] }>
	| AgentWireResponseSuccess<
			"set_capabilities",
			{ acceptedCapabilities: AgentWireCapability[]; unsupported: string[] }
	  >;

export type AgentWireModelResponseDto<T extends AgentWireResponseAdapters> =
	| AgentWireResponseSuccess<"set_model", T["model"]>
	| AgentWireResponseSuccess<
			"cycle_model",
			{ model: T["model"]; thinkingLevel: T["thinkingLevel"] | undefined; isScoped: boolean } | null
	  >
	| AgentWireResponseSuccess<"get_available_models", { models: T["model"][] }>
	| AgentWireResponseSuccess<"set_thinking_level">
	| AgentWireResponseSuccess<"cycle_thinking_level", { level: T["effort"] } | null>;

export type AgentWireControlResponseDto<T extends AgentWireResponseAdapters> =
	| AgentWireResponseSuccess<"set_steering_mode">
	| AgentWireResponseSuccess<"set_follow_up_mode">
	| AgentWireResponseSuccess<"set_interrupt_mode">
	| AgentWireResponseSuccess<"compact", T["compactionResult"]>
	| AgentWireResponseSuccess<"set_auto_compaction">
	| AgentWireResponseSuccess<"set_auto_retry">
	| AgentWireResponseSuccess<"abort_retry">
	| AgentWireResponseSuccess<"bash", T["bashResult"]>
	| AgentWireResponseSuccess<"abort_bash">;

export type AgentWireSessionResponseDto<T extends AgentWireResponseAdapters> =
	| AgentWireResponseSuccess<"get_session_stats", T["sessionStats"]>
	| AgentWireResponseSuccess<"export_html", { path: string }>
	| AgentWireResponseSuccess<"switch_session", { cancelled: boolean }>
	| AgentWireResponseSuccess<"branch", { text: string; cancelled: boolean }>
	| AgentWireResponseSuccess<"get_branch_messages", { messages: Array<{ entryId: string; text: string }> }>
	| AgentWireResponseSuccess<"get_last_assistant_text", { text: string | null }>
	| AgentWireResponseSuccess<"set_session_name">
	| AgentWireResponseSuccess<"handoff", AgentWireHandoffResult | null>
	| AgentWireResponseSuccess<"get_messages", { messages: T["message"][] }>;

export type AgentWireAuthenticationResponseDto =
	| AgentWireResponseSuccess<
			"get_login_providers",
			{ providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> }
	  >
	| AgentWireResponseSuccess<"login", { providerId: string }>;

export type AgentWireUnattendedResponseDto =
	| AgentWireResponseSuccess<"negotiate_unattended", AgentWireUnattendedAccepted>
	| AgentWireResponseSuccess<"workflow_gate_response", AgentWireWorkflowGateResolution>;

export type AgentWireBudgetMetric = "tokens" | "tool_calls" | "wall_time" | "cost";

/** Typed payload emitted when a declared unattended budget cap is breached. */
export interface AgentWireBudgetExceeded {
	code: "budget_exceeded";
	metric: AgentWireBudgetMetric;
	limit: number;
	observed: number;
	phase: string;
	run_id: string;
	session_id?: string;
	abort_status: "aborting" | "aborted" | "abort_failed";
}

export type AgentWireUnattendedRefusalCode =
	| "unattended_not_negotiated"
	| "incomplete_budget"
	| "unsupported_budget_metric"
	| "invalid_unattended_declaration"
	| "unattended_aborted";

/** Typed refusal emitted when unattended mode cannot start or continue. */
export interface AgentWireUnattendedRefused {
	code: AgentWireUnattendedRefusalCode;
	message: string;
}

/** v1 action taxonomy for unattended authorization. */
export type AgentWireUnattendedActionClass =
	| "command.prompt"
	| "command.control"
	| "command.bash"
	| "command.export"
	| "command.session"
	| "command.model"
	| "command.message_read"
	| "command.host_tools"
	| "command.host_uri"
	| "command.admin"
	| "bash.readonly"
	| "bash.mutating"
	| "bash.destructive"
	| "git.force_push"
	| "file.delete"
	| "file.write"
	| "host_tool.invoke"
	| "host_uri.read"
	| "host_uri.write"
	| "auth.login";

/** Typed error when a command's coarse scope is outside the unattended allowlist. */
export interface AgentWireScopeDenied {
	code: "scope_denied";
	scope: string;
	command?: string;
	run_id: string;
	session_id?: string;
	pre_side_effect: true;
}

/** Typed error when an unattended action is outside the declared allowlist. */
export interface AgentWireActionDenied {
	code: "action_denied";
	action: AgentWireUnattendedActionClass;
	command?: string;
	run_id: string;
	session_id?: string;
	pre_side_effect: true;
}

export type AgentWireErrorResponseDto = {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string | object;
};

/** Every JSON response DTO emitted by an agent-wire transport. */
export type AgentWireResponseDto<T extends AgentWireResponseAdapters = AgentWireResponseAdapters> =
	| AgentWirePromptResponseDto
	| AgentWireStateResponseDto<T>
	| AgentWireModelResponseDto<T>
	| AgentWireControlResponseDto<T>
	| AgentWireSessionResponseDto<T>
	| AgentWireAuthenticationResponseDto
	| AgentWireUnattendedResponseDto
	| AgentWireErrorResponseDto;

export type AgentWireResponse<T extends AgentWireResponseAdapters = AgentWireResponseAdapters> =
	AgentWireResponseDto<T>;
