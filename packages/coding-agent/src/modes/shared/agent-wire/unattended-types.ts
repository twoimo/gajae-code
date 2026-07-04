export interface RpcUnattendedBudget {
	max_tokens: number;
	max_tool_calls: number;
	max_wall_time_ms: number;
	max_cost_usd: number;
}

export interface RpcUnattendedDeclaration {
	/** Identity of the operating external agent, recorded in the audit trail. */
	actor: string;
	budget: RpcUnattendedBudget;
	/** Coarse command scopes the agent may use (maps to BridgeCommandScope). */
	scopes: string[];
	/** Action classes the agent is allowed to perform (default-deny otherwise). */
	action_allowlist: string[];
}

export interface RpcUnattendedAccepted {
	run_id: string;
	actor: string;
	budget: RpcUnattendedBudget;
	scopes: string[];
	action_allowlist: string[];
	accepted_at: string;
}

export type RpcBudgetMetric = "tokens" | "tool_calls" | "wall_time" | "cost";

/** Typed payload emitted when a declared budget cap is breached (#318). */
export interface RpcBudgetExceeded {
	code: "budget_exceeded";
	metric: RpcBudgetMetric;
	limit: number;
	observed: number;
	/** The accounting phase that detected the breach. */
	phase: string;
	run_id: string;
	session_id?: string;
	/** `aborting` = breach detected, async abort initiated; settled status follows in audit. */
	abort_status: "aborting" | "aborted" | "abort_failed";
}

export type RpcUnattendedRefusalCode =
	| "unattended_not_negotiated"
	| "incomplete_budget"
	| "unsupported_budget_metric"
	| "invalid_unattended_declaration"
	| "unattended_aborted";

/** Typed refusal emitted when unattended mode cannot start or continue (fail-closed). */
export interface RpcUnattendedRefused {
	code: RpcUnattendedRefusalCode;
	message: string;
}

/** v1 action taxonomy: every authorized operation maps to one of these classes. */
export type RpcUnattendedActionClass =
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

/** Typed error when a command's coarse scope is not in the declared allowlist. */
export interface RpcScopeDenied {
	code: "scope_denied";
	scope: string;
	command?: string;
	run_id: string;
	session_id?: string;
	/** Always true: enforcement happens before the side effect runs. */
	pre_side_effect: true;
}

/** Typed error when an action class is not in the declared allowlist (default-deny). */
export interface RpcActionDenied {
	code: "action_denied";
	action: string;
	command?: string;
	run_id: string;
	session_id?: string;
	pre_side_effect: true;
}
