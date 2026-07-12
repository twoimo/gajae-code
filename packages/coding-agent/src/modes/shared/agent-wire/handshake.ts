import {
	type AgentWireCapability,
	type AgentWireCommandScope,
	type AgentWireEndpointDescriptor,
	type AgentWireHandshakeAccepted,
	type AgentWireHandshakeRejected,
	type AgentWireHandshakeRequest,
	type AgentWireHandshakeResponse,
	type AgentWireHandshakeServer,
	type AgentWireVersionRange,
	isAgentWireHandshakeRequest,
	isAgentWireUnattendedDeclaration,
	negotiateAgentWireHandshake,
} from "@gajae-code/agent-wire";

/** @deprecated Use AgentWireCapability from @gajae-code/agent-wire. */
export type BridgeCapability = AgentWireCapability;
/** @deprecated Use AgentWireVersionRange from @gajae-code/agent-wire. */
export type BridgeProtocolRange = AgentWireVersionRange;
/** @deprecated Use AgentWireHandshakeRequest from @gajae-code/agent-wire. */
export type BridgeHandshakeRequest = AgentWireHandshakeRequest;
/** @deprecated Use AgentWireEndpointDescriptor from @gajae-code/agent-wire. */
export type BridgeEndpointDescriptor = AgentWireEndpointDescriptor;
/** @deprecated Use AgentWireHandshakeAccepted from @gajae-code/agent-wire. */
export type BridgeHandshakeAccepted = AgentWireHandshakeAccepted;
/** @deprecated Use AgentWireHandshakeRejected from @gajae-code/agent-wire. */
export type BridgeHandshakeRejected = AgentWireHandshakeRejected;
/** @deprecated Use AgentWireHandshakeResponse from @gajae-code/agent-wire. */
export type BridgeHandshakeResponse = AgentWireHandshakeResponse;

export const isBridgeHandshakeRequest = isAgentWireHandshakeRequest;
/** @deprecated Use isAgentWireUnattendedDeclaration from @gajae-code/agent-wire. */
export const isUnattendedDeclarationShape = isAgentWireUnattendedDeclaration;
export function negotiateBridgeHandshake(
	request: BridgeHandshakeRequest,
	server: AgentWireHandshakeServer & { scopes: readonly AgentWireCommandScope[] },
): BridgeHandshakeResponse {
	const response = negotiateAgentWireHandshake(request, server);
	if (response.status === "rejected" && response.reason === "incompatible_version") {
		return {
			...response,
			message: `Bridge protocol v2 is outside client range ${request.protocol_version_range.min}..${request.protocol_version_range.max}`,
		};
	}
	return response;
}
