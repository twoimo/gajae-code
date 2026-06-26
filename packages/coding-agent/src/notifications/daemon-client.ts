import {
	connectUds,
	defaultDaemonSocketPath,
	EventStream,
	notificationReplyFrame,
	performHello,
	type GjcFrame,
	type JsonObject,
	type JsonValue,
	type UdsTransport,
} from "@gajae-code/rpc-sdk";
import type { NotificationEvent, NotificationReplyRoute } from "./engine";

export interface NotificationDaemonClientOptions {
	socketPath?: string;
	sessions: string[];
	redaction?: "full" | "redacted" | "metadata_only";
	grantId?: string;
}

export interface NotificationDaemonClient {
	readonly transport: UdsTransport;
	close(): void;
	sendReply(route: NotificationReplyRoute): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.map(item => String(item)) : undefined;
}

function jsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	if (Array.isArray(value)) return value.map(jsonValue);
	if (isRecord(value)) {
		const out: JsonObject = {};
		for (const [key, item] of Object.entries(value)) out[key] = jsonValue(item);
		return out;
	}
	return String(value);
}

export function replyRouteToFrame(route: NotificationReplyRoute): GjcFrame<JsonObject> {
	return notificationReplyFrame(route.sessionId, route.actionId, { value: jsonValue(route.answer) });
}

export function notificationDaemonFrameToEvent(frame: GjcFrame<unknown>): NotificationEvent | undefined {
	if (frame.direction !== "server_to_client" || frame.kind !== "notification") return undefined;
	const payload = isRecord(frame.payload) ? frame.payload : {};
	if (frame.type === "action_needed") {
		const actionId = text(payload.id) ?? text(payload.actionId) ?? frame.correlationId ?? frame.frameId;
		const kind = payload.kind === "idle" ? "idle" : "ask";
		if (kind === "idle") {
			return {
				type: "action_needed",
				kind,
				id: actionId,
				sessionId: frame.sessionId,
				summary: text(payload.summary),
			};
		}
		return {
			type: "action_needed",
			kind,
			id: actionId,
			sessionId: frame.sessionId,
			question: text(payload.question),
			options: stringArray(payload.options),
		};
	}
	if (frame.type === "action_resolved") {
		const id = text(payload.id) ?? text(payload.actionId) ?? frame.correlationId;
		return id
			? { type: "action_resolved", id, sessionId: frame.sessionId, resolvedBy: text(payload.resolvedBy) }
			: undefined;
	}
	if (frame.type === "reply_rejected")
		return { type: "frame", sessionId: frame.sessionId, frame: frame.payload as Record<string, unknown> };
	return { type: "frame", sessionId: frame.sessionId, frame: frame.payload as Record<string, unknown> };
}

export async function connectNotificationDaemon(
	options: NotificationDaemonClientOptions,
	onEvent: (event: NotificationEvent, frame: GjcFrame<unknown>) => void,
): Promise<NotificationDaemonClient> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	const transport = await connectUds({ socketPath });
	await performHello(transport, {
		sessions: options.sessions,
		redaction: options.redaction ?? "redacted",
		grantId: options.grantId,
		frameId: "notifications_chat_subscribe",
	});
	const stream = new EventStream(transport);
	const subscription = stream.subscribe(
		frame => {
			const event = notificationDaemonFrameToEvent(frame);
			if (event) onEvent(event, frame);
		},
		frame => frame.kind === "notification" && frame.direction === "server_to_client",
	);
	return {
		transport,
		close() {
			subscription.unsubscribe();
			transport.close();
		},
		sendReply(route: NotificationReplyRoute): Promise<void> {
			return transport.write(replyRouteToFrame(route));
		},
	};
}
