import { isAgentWireCommand } from "@gajae-code/agent-wire";
import type { RpcCommand } from "../../rpc/rpc-types";

/** Coding-agent domain specialization of the leaf's JSON command validator. */
export function isRpcCommand(value: unknown): value is RpcCommand {
	return isAgentWireCommand(value);
}
