import type { AgentWireCommandType } from "./scopes";

export interface AgentWireResponse {
	id: string | undefined;
	type: "response";
	command: string;
	success: boolean;
	data?: object | null;
	error?: string | object;
}

export function rpcSuccess<T extends AgentWireCommandType>(
	id: string | undefined,
	command: T,
	data?: object | null,
): AgentWireResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true };
	}
	return { id, type: "response", command, success: true, data };
}

export function rpcError(id: string | undefined, command: string, error: string | object): AgentWireResponse {
	return { id, type: "response", command, success: false, error };
}
