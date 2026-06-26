import { PROTOCOL_VERSION } from "../protocol/generated";
import type { GjcFrame, JsonObject } from "../protocol/types";

export interface HostUriSchemeDefinition extends JsonObject { scheme: string; description: string }
export function hostUriScheme(scheme: string, description: string): HostUriSchemeDefinition { return { scheme, description }; }
export function hostUriResultFrame(sessionId: string, requestId: string, uri: string, accepted: boolean): GjcFrame<JsonObject> { return { protocolVersion: PROTOCOL_VERSION, frameId: `host-uri-${requestId}-result`, sessionId, seq: 0, direction: "client_to_server", kind: "host_uri_request", type: "host_uri_result", correlationId: requestId, replay: false, capabilityScope: "host_uri_result", payload: { requestId, uri, accepted } }; }
