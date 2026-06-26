import { COMMAND_CLASSIFICATION, PROTOCOL_VERSION, type CapabilityScope, type Command, type SchedulingLane } from "../protocol/generated";
import type { GjcFrame, JsonObject, JsonValue } from "../protocol/types";

export interface RpcCommand<TType extends Command = Command, TPayload extends JsonObject = JsonObject> { id?: string; type: TType; payload: TPayload; lane: SchedulingLane; bridgeScope: string }
export interface CommandFrameOptions<TPayload extends JsonObject> { sessionId: string; commandId?: string; frameId?: string; seq?: number; payload: TPayload }
export function commandLane(command: Command): SchedulingLane { return COMMAND_CLASSIFICATION[command].lane; }
export function commandScope(command: Command): CapabilityScope { return commandLane(command) === "fast_lane_safe_read" ? "read" : "control"; }
export function buildCommand<TType extends Command, TPayload extends JsonObject>(type: TType, payload: TPayload, id?: string): RpcCommand<TType, TPayload> { const c = COMMAND_CLASSIFICATION[type]; return { ...(id ? { id } : {}), type, payload, lane: c.lane, bridgeScope: c.bridgeScope }; }
export function buildCommandFrame<TType extends Command, TPayload extends JsonObject>(type: TType, options: CommandFrameOptions<TPayload>): GjcFrame<RpcCommand<TType, TPayload>> { const command = buildCommand(type, options.payload, options.commandId); return { protocolVersion: PROTOCOL_VERSION, frameId: options.frameId ?? options.commandId ?? `${type}-command`, sessionId: options.sessionId, seq: options.seq ?? 0, direction: "client_to_server", kind: "command", type, correlationId: options.commandId, replay: false, capabilityScope: commandScope(type), payload: command }; }
export const commands = {
	prompt: (message: string, id?: string) => buildCommand("prompt", { message }, id),
	steer: (message: string, id?: string) => buildCommand("steer", { message }, id),
	followUp: (message: string, id?: string) => buildCommand("follow_up", { message }, id),
	abort: (id?: string) => buildCommand("abort", {}, id),
	getState: (include?: string[], id?: string) => buildCommand("get_state", include ? { include } : {}, id),
	workflowGateResponse: (gateId: string, answer: JsonValue, id?: string) => buildCommand("workflow_gate_response", { gateId, answer }, id),
};
