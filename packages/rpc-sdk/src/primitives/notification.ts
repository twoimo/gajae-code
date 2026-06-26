import { PROTOCOL_VERSION, type NotificationServerMessage } from "../protocol/generated";
import type { GjcFrame, JsonObject } from "../protocol/types";

export function notificationFrame(sessionId: string, type: NotificationServerMessage, payload: JsonObject, frameId = `${type}-notification`): GjcFrame<JsonObject> { return { protocolVersion: PROTOCOL_VERSION, frameId, sessionId, seq: 0, direction: "server_to_client", kind: "notification", type, replay: false, payload }; }
export function notificationReplyFrame(sessionId: string, actionId: string, answer: JsonObject): GjcFrame<JsonObject> { return { protocolVersion: PROTOCOL_VERSION, frameId: `notification-${actionId}-reply`, sessionId, seq: 0, direction: "client_to_server", kind: "notification", type: "reply", correlationId: actionId, replay: false, capabilityScope: "gate_answer", payload: { actionId, answer } }; }
