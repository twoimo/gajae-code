export interface AgentWireHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}
export interface AgentWireHostToolCall {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}
export interface AgentWireHostToolCancel {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}
export interface AgentWireHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: unknown;
}
export interface AgentWireHostToolResult {
	type: "host_tool_result";
	id: string;
	result: unknown;
	isError?: boolean;
}
export interface AgentWireHostUriScheme {
	scheme: string;
	description?: string;
	writable?: boolean;
	immutable?: boolean;
}
export interface AgentWireHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: "read" | "write";
	url: string;
	content?: string;
}
export interface AgentWireHostUriCancel {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}
export interface AgentWireHostUriResult {
	type: "host_uri_result";
	id: string;
	content?: string;
	contentType?: "text/markdown" | "application/json" | "text/plain";
	notes?: string[];
	immutable?: boolean;
	isError?: boolean;
	error?: string;
}
export type AgentWireUiRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| { type: "extension_ui_request"; id: string; method: "open_url"; url: string; instructions?: string };
export type AgentWireUiResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };
