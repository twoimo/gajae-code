import type { AgentWireCapability } from "./handshake";

export const AGENT_WIRE_COMMAND_TYPES = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"abort_and_prompt",
	"new_session",
	"get_state",
	"set_todos",
	"set_host_tools",
	"set_host_uri_schemes",
	"get_pending_workflow_gates",
	"set_capabilities",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"branch",
	"get_branch_messages",
	"get_last_assistant_text",
	"set_session_name",
	"handoff",
	"get_messages",
	"get_login_providers",
	"login",
	"negotiate_unattended",
	"workflow_gate_response",
] as const;

export type AgentWireCommandType = (typeof AGENT_WIRE_COMMAND_TYPES)[number];
export type AgentWireCommandScope =
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
export const AGENT_WIRE_COMMAND_SCOPES: readonly AgentWireCommandScope[] = [
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

export const AGENT_WIRE_COMMAND_SCOPE: Record<AgentWireCommandType, AgentWireCommandScope> = {
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

export interface AgentWireImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface AgentWireTodoPhase {
	name: string;
	tasks: Array<{
		content: string;
		status: "pending" | "in_progress" | "completed" | "abandoned";
		notes?: string[];
	}>;
}

export type AgentWireGetStateInclude = "tools" | "dumpTools" | "systemPrompt";
export type AgentWireThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentWireCommandAdapters {
	image: AgentWireImageContent;
	todoPhase: AgentWireTodoPhase;
	hostTool: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		label?: string;
		hidden?: boolean;
	};
	hostUriScheme: { scheme: string; description?: string; writable?: boolean; immutable?: boolean };
	unattendedDeclaration: {
		actor: string;
		budget: { max_tokens: number; max_tool_calls: number; max_wall_time_ms: number; max_cost_usd: number };
		scopes: string[];
		action_allowlist: string[];
	};
	workflowGateResponse: { gate_id: string; answer: unknown; idempotency_key?: string };
	thinkingLevel: AgentWireThinkingLevel;
}

export type AgentWireCommandDto<T extends AgentWireCommandAdapters = AgentWireCommandAdapters> =
	| { id?: string; type: "prompt"; message: string; images?: T["image"][]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer" | "follow_up" | "abort_and_prompt"; message: string; images?: T["image"][] }
	| {
			id?: string;
			type:
				| "abort"
				| "cycle_model"
				| "get_available_models"
				| "cycle_thinking_level"
				| "abort_retry"
				| "abort_bash"
				| "get_session_stats"
				| "get_branch_messages"
				| "get_last_assistant_text"
				| "get_messages"
				| "get_login_providers"
				| "get_pending_workflow_gates";
	  }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state"; include?: AgentWireGetStateInclude[] }
	| { id?: string; type: "set_todos"; phases: T["todoPhase"][] }
	| { id?: string; type: "set_host_tools"; tools: T["hostTool"][] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: T["hostUriScheme"][] }
	| { id?: string; type: "set_capabilities"; capabilities: AgentWireCapability[] }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "set_thinking_level"; level: T["thinkingLevel"] }
	| { id?: string; type: "set_steering_mode" | "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }
	| { id?: string; type: "compact" | "handoff"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction" | "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "negotiate_unattended"; declaration: T["unattendedDeclaration"] }
	| ({ id?: string; type: "workflow_gate_response" } & T["workflowGateResponse"]);

export type AgentWireCommand<
	TType extends AgentWireCommandType = AgentWireCommandType,
	T extends AgentWireCommandAdapters = AgentWireCommandAdapters,
> = Extract<AgentWireCommandDto<T>, { type: TType }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}
function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}
export function isAgentWireImageContent(value: unknown): value is AgentWireImageContent {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function optionalImages(value: unknown): value is AgentWireImageContent[] | undefined {
	return value === undefined || (Array.isArray(value) && value.every(isAgentWireImageContent));
}
function isTodoPhase(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		Array.isArray(value.tasks) &&
		value.tasks.every(
			task =>
				isRecord(task) &&
				typeof task.content === "string" &&
				["pending", "in_progress", "completed", "abandoned"].includes(task.status as string) &&
				(task.notes === undefined || stringArray(task.notes)),
		)
	);
}
function isHostTool(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.description === "string" &&
		isRecord(value.parameters) &&
		optionalString(value.label) &&
		(value.hidden === undefined || typeof value.hidden === "boolean")
	);
}
function isHostUriScheme(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.scheme === "string" &&
		optionalString(value.description) &&
		(value.writable === undefined || typeof value.writable === "boolean") &&
		(value.immutable === undefined || typeof value.immutable === "boolean")
	);
}
function isUnattendedDeclaration(value: unknown): boolean {
	if (!isRecord(value) || typeof value.actor !== "string" || !isRecord(value.budget)) return false;
	const budget = value.budget;
	return (
		["max_tokens", "max_tool_calls", "max_wall_time_ms", "max_cost_usd"].every(
			key => typeof budget[key] === "number",
		) &&
		stringArray(value.scopes) &&
		stringArray(value.action_allowlist)
	);
}

/** Runtime validator for every JSON command DTO accepted by agent-wire transports. */
export function isAgentWireCommand(value: unknown): value is AgentWireCommand {
	if (!isRecord(value) || !optionalString(value.id) || !isAgentWireCommandType(value.type)) return false;
	switch (value.type) {
		case "prompt":
			return (
				typeof value.message === "string" &&
				optionalImages(value.images) &&
				(value.streamingBehavior === undefined ||
					value.streamingBehavior === "steer" ||
					value.streamingBehavior === "followUp")
			);
		case "steer":
		case "follow_up":
		case "abort_and_prompt":
			return typeof value.message === "string" && optionalImages(value.images);
		case "abort":
		case "cycle_model":
		case "get_available_models":
		case "cycle_thinking_level":
		case "abort_retry":
		case "abort_bash":
		case "get_session_stats":
		case "get_branch_messages":
		case "get_last_assistant_text":
		case "get_messages":
		case "get_login_providers":
		case "get_pending_workflow_gates":
			return true;
		case "new_session":
			return optionalString(value.parentSession);
		case "get_state":
			return (
				value.include === undefined ||
				(Array.isArray(value.include) &&
					value.include.every(item => item === "tools" || item === "dumpTools" || item === "systemPrompt"))
			);
		case "set_todos":
			return Array.isArray(value.phases) && value.phases.every(isTodoPhase);
		case "set_host_tools":
			return Array.isArray(value.tools) && value.tools.every(isHostTool);
		case "set_host_uri_schemes":
			return Array.isArray(value.schemes) && value.schemes.every(isHostUriScheme);
		case "set_capabilities":
			return (
				Array.isArray(value.capabilities) && value.capabilities.every(item => item === "compact_message_update")
			);
		case "set_model":
			return typeof value.provider === "string" && typeof value.modelId === "string";
		case "set_thinking_level":
			return (
				typeof value.level === "string" &&
				["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.level)
			);
		case "set_steering_mode":
		case "set_follow_up_mode":
			return value.mode === "all" || value.mode === "one-at-a-time";
		case "set_interrupt_mode":
			return value.mode === "immediate" || value.mode === "wait";
		case "compact":
		case "handoff":
			return optionalString(value.customInstructions);
		case "set_auto_compaction":
		case "set_auto_retry":
			return typeof value.enabled === "boolean";
		case "bash":
			return typeof value.command === "string";
		case "export_html":
			return optionalString(value.outputPath);
		case "switch_session":
			return typeof value.sessionPath === "string";
		case "branch":
			return typeof value.entryId === "string";
		case "set_session_name":
			return typeof value.name === "string";
		case "login":
			return typeof value.providerId === "string";
		case "negotiate_unattended":
			return isUnattendedDeclaration(value.declaration);
		case "workflow_gate_response":
			return typeof value.gate_id === "string" && "answer" in value && optionalString(value.idempotency_key);
	}
}

export function isAgentWireCommandType(value: unknown): value is AgentWireCommandType {
	return typeof value === "string" && AGENT_WIRE_COMMAND_TYPES.includes(value as AgentWireCommandType);
}
export function scopeForAgentWireCommand(type: AgentWireCommandType): AgentWireCommandScope {
	return AGENT_WIRE_COMMAND_SCOPE[type];
}
