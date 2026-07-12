import { AGENT_WIRE_COMMAND_SCOPES, type AgentWireCommandScope } from "./commands";
import type { AgentWireFrameType } from "./envelope";
import {
	type AgentWireVersion,
	type AgentWireVersionRange,
	isAgentWireVersionRange,
	selectAgentWireVersion,
} from "./version";
import { type AgentWireUnattendedDeclaration, isAgentWireUnattendedDeclaration } from "./workflow-gate";

export const AGENT_WIRE_CAPABILITIES = [
	"events",
	"prompt",
	"permission",
	"elicitation",
	"ui.declarative",
	"ui.editor",
	"ui.terminal_input",
	"host_tools",
	"host_uri",
	"client_bridge.read_text_file",
	"client_bridge.write_text_file",
	"client_bridge.create_terminal",
	"workflow_gate",
	"compact_message_update",
] as const;
export type AgentWireCapability = (typeof AGENT_WIRE_CAPABILITIES)[number];
/** Capabilities introduced after v1 must never be negotiated for a v1 connection. */
export const AGENT_WIRE_V2_CAPABILITIES: readonly AgentWireCapability[] = ["compact_message_update"];
export interface AgentWireEndpointDescriptor {
	events: string;
	commands: string;
	uiResponses: string;
	claimControl: string;
	disconnectControl: string;
	hostToolResults: string;
	hostUriResults: string;
}
export interface AgentWireHandshakeRequest {
	protocol_version_range: AgentWireVersionRange;
	capabilities: AgentWireCapability[];
	requested_scopes: AgentWireCommandScope[];
	last_seq?: number;
	unattended?: AgentWireUnattendedDeclaration;
}
export interface AgentWireHandshakeAccepted {
	status: "accepted";
	protocol_version: AgentWireVersion;
	session_id: string;
	accepted_capabilities: AgentWireCapability[];
	accepted_scopes: AgentWireCommandScope[];
	unsupported: AgentWireCapability[];
	endpoints: AgentWireEndpointDescriptor;
	frame_types: AgentWireFrameType[];
	accepted_unattended?: AgentWireUnattendedDeclaration;
	unattended_active?: boolean;
}
export interface AgentWireHandshakeRejected {
	status: "rejected";
	reason: "incompatible_version" | "unauthorized" | "invalid_request";
	message: string;
}
export type AgentWireHandshakeResponse = AgentWireHandshakeAccepted | AgentWireHandshakeRejected;
export interface AgentWireHandshakeServer {
	sessionId: string;
	capabilities: readonly AgentWireCapability[];
	scopes: readonly AgentWireCommandScope[];
	endpoints: AgentWireEndpointDescriptor;
	frameTypes: readonly AgentWireFrameType[];
	acceptedUnattended?: AgentWireUnattendedDeclaration;
}
export function isAgentWireHandshakeRequest(value: unknown): value is AgentWireHandshakeRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	return (
		isAgentWireVersionRange(request.protocol_version_range) &&
		Array.isArray(request.capabilities) &&
		request.capabilities.every(
			capability =>
				typeof capability === "string" && AGENT_WIRE_CAPABILITIES.includes(capability as AgentWireCapability),
		) &&
		Array.isArray(request.requested_scopes) &&
		request.requested_scopes.every(
			scope => typeof scope === "string" && AGENT_WIRE_COMMAND_SCOPES.includes(scope as AgentWireCommandScope),
		) &&
		(request.last_seq === undefined ||
			(typeof request.last_seq === "number" && Number.isInteger(request.last_seq) && request.last_seq >= 0)) &&
		(request.unattended === undefined || isAgentWireUnattendedDeclaration(request.unattended))
	);
}
export function negotiateAgentWireHandshake(
	request: AgentWireHandshakeRequest,
	server: AgentWireHandshakeServer,
): AgentWireHandshakeResponse {
	const version = selectAgentWireVersion(request.protocol_version_range);
	if (version === undefined)
		return {
			status: "rejected",
			reason: "incompatible_version",
			message: `No supported agent-wire version is within client range ${request.protocol_version_range.min}..${request.protocol_version_range.max}`,
		};
	const serverCapabilities = new Set(server.capabilities);
	const requested =
		version === 1
			? request.capabilities.filter(capability => !AGENT_WIRE_V2_CAPABILITIES.includes(capability))
			: request.capabilities;
	const accepted_capabilities = requested.filter(capability => serverCapabilities.has(capability));
	const acceptedSet = new Set(accepted_capabilities);
	const unsupported = request.capabilities.filter(capability => !acceptedSet.has(capability));
	const serverScopes = new Set(server.scopes);
	const accepted_scopes = request.requested_scopes.filter(scope => serverScopes.has(scope));
	const response: AgentWireHandshakeAccepted = {
		status: "accepted",
		protocol_version: version,
		session_id: server.sessionId,
		accepted_capabilities,
		accepted_scopes,
		unsupported,
		endpoints: server.endpoints,
		frame_types: [...server.frameTypes],
	};
	if (server.acceptedUnattended !== undefined && acceptedSet.has("workflow_gate")) {
		response.accepted_unattended = server.acceptedUnattended;
		response.unattended_active = true;
	}
	return response;
}
