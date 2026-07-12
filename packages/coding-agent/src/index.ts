// Stable public surface: SDK factories/types and extension contracts only.

export { ModelRegistry } from "./config/model-registry";
export { isToolCallEventType } from "./extensibility/extensions";
export { createOuroborosOooBridge } from "./extensibility/extensions/prefix-command-bridge";
export type { HookAPI, HookContext, SessionBeforeSwitchEvent } from "./extensibility/hooks/types";
export { computeLineHash } from "./hashline/hash";
export {
	defineRpcClientTool,
	type ModelInfo,
	RpcClient,
	type RpcClientCustomTool,
	type RpcClientOptions,
	type RpcClientToolContext,
	type RpcClientToolResult,
	type RpcEventListener,
} from "./modes/rpc/rpc-client";
export { getSettingsListTheme } from "./modes/theme/theme";
export * from "./sdk";
export { AgentSession, type AgentSessionEvent, type SessionStats } from "./session/agent-session";
export { AuthStorage } from "./session/auth-storage";
export { convertToLlm } from "./session/messages";
export { formatSessionDumpText } from "./session/session-dump-format";
export type { SessionMessageEntry } from "./session/session-manager";
export { SessionManager } from "./session/session-manager";
