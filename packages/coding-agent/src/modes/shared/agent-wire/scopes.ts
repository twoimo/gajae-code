import {
	AGENT_WIRE_COMMAND_SCOPES,
	AGENT_WIRE_COMMAND_TYPES,
	type AgentWireCommandScope,
	type AgentWireCommandType,
	scopeForAgentWireCommand,
} from "@gajae-code/agent-wire";
import type { RpcCommand } from "../../rpc/rpc-types";

export type RpcCommandType = RpcCommand["type"];
/** @deprecated Use AgentWireCommandScope from @gajae-code/agent-wire. */
export type BridgeCommandScope = AgentWireCommandScope;
export const BRIDGE_COMMAND_SCOPES = AGENT_WIRE_COMMAND_SCOPES;
export const RPC_COMMAND_TYPES: readonly RpcCommandType[] = AGENT_WIRE_COMMAND_TYPES as readonly RpcCommandType[];
export function isRpcCommandType(value: unknown): value is RpcCommandType {
	return typeof value === "string" && (AGENT_WIRE_COMMAND_TYPES as readonly string[]).includes(value);
}
export const MANDATORY_FLOOR_COMMAND_SCOPES: readonly BridgeCommandScope[] = ["prompt"];
export function scopeForRpcCommand(type: RpcCommandType): BridgeCommandScope {
	return scopeForAgentWireCommand(type as AgentWireCommandType);
}
export function isRpcCommandAllowed(type: RpcCommandType, scopes: ReadonlySet<BridgeCommandScope>): boolean {
	return scopes.has(scopeForRpcCommand(type));
}
