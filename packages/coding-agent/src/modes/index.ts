import { emergencyTerminalRestore } from "@gajae-code/tui";
import { postmortem } from "@gajae-code/utils";

/**
 * Run modes for the coding agent.
 */
export { runAcpMode } from "./acp";
export { runBridgeMode } from "./bridge/bridge-mode";
export { InteractiveMode, type InteractiveModeOptions } from "./interactive-mode";
export { type PrintModeOptions, runPrintMode } from "./print-mode";
export { runRpcMode } from "./rpc/rpc-mode";
export type {
	RpcCommand,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types";

postmortem.register("terminal-restore", () => {
	emergencyTerminalRestore();
});
