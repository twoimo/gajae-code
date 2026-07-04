/**
 * Coarse agent-wire authorization scopes for command requests.
 *
 * The registry assigns every command to one coarse scope before any external
 * handler can dispatch it. Keeping the registry exhaustive makes new command
 * additions require an explicit authorization decision.
 */
export type AgentWireCommandType =
	| "prompt"
	| "steer"
	| "follow_up"
	| "abort"
	| "abort_and_prompt"
	| "new_session"
	| "get_state"
	| "set_todos"
	| "set_host_tools"
	| "set_host_uri_schemes"
	| "get_pending_workflow_gates"
	| "set_model"
	| "cycle_model"
	| "get_available_models"
	| "set_thinking_level"
	| "cycle_thinking_level"
	| "set_steering_mode"
	| "set_follow_up_mode"
	| "set_interrupt_mode"
	| "compact"
	| "set_auto_compaction"
	| "set_auto_retry"
	| "abort_retry"
	| "bash"
	| "abort_bash"
	| "get_session_stats"
	| "export_html"
	| "switch_session"
	| "branch"
	| "get_branch_messages"
	| "get_last_assistant_text"
	| "set_session_name"
	| "handoff"
	| "get_messages"
	| "get_login_providers"
	| "login"
	| "negotiate_unattended"
	| "workflow_gate_response";

export type RpcCommandType = AgentWireCommandType;

export type BridgeCommandScope =
	| "prompt"
	| "control"
	| "bash"
	| "export"
	| "session"
	| "model"
	| "message:read"
	| "host_tools"
	| "host_uri"
	| "admin";
export const BRIDGE_COMMAND_SCOPES: readonly BridgeCommandScope[] = [
	"prompt",
	"control",
	"bash",
	"export",
	"session",
	"model",
	"message:read",
	"host_tools",
	"host_uri",
	"admin",
];

const RPC_COMMAND_SCOPE_REGISTRY: Record<RpcCommandType, BridgeCommandScope> = {
	prompt: "prompt",
	steer: "prompt",
	follow_up: "prompt",
	abort: "prompt",
	abort_and_prompt: "prompt",
	new_session: "session",
	get_state: "message:read",
	set_todos: "control",
	set_host_tools: "host_tools",
	set_host_uri_schemes: "host_uri",
	get_pending_workflow_gates: "message:read",
	set_capabilities: "control",
	set_model: "model",
	set_default_model_selection: "model",
	cycle_model: "model",
	get_available_models: "model",
	set_thinking_level: "model",
	cycle_thinking_level: "model",
	set_steering_mode: "control",
	set_follow_up_mode: "control",
	set_interrupt_mode: "control",
	compact: "control",
	set_auto_compaction: "control",
	set_auto_retry: "control",
	abort_retry: "control",
	bash: "bash",
	abort_bash: "bash",
	get_session_stats: "message:read",
	export_html: "export",
	switch_session: "session",
	branch: "session",
	get_branch_messages: "session",
	get_last_assistant_text: "message:read",
	set_session_name: "session",
	handoff: "admin",
	get_messages: "message:read",
	get_login_providers: "admin",
	login: "admin",
	negotiate_unattended: "control",
	workflow_gate_response: "control",
};

export const RPC_COMMAND_TYPES: readonly RpcCommandType[] = Object.keys(RPC_COMMAND_SCOPE_REGISTRY) as RpcCommandType[];
export function isRpcCommandType(value: unknown): value is RpcCommandType {
	return typeof value === "string" && value in RPC_COMMAND_SCOPE_REGISTRY;
}

export const MANDATORY_FLOOR_COMMAND_SCOPES: readonly BridgeCommandScope[] = ["prompt"];

export function scopeForRpcCommand(type: RpcCommandType): BridgeCommandScope {
	return RPC_COMMAND_SCOPE_REGISTRY[type];
}

export function isRpcCommandAllowed(type: RpcCommandType, scopes: ReadonlySet<BridgeCommandScope>): boolean {
	return scopes.has(scopeForRpcCommand(type));
}
