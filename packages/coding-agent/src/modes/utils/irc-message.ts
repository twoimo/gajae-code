import type { AgentMessage } from "@gajae-code/agent-core";
import { sanitizeText } from "@gajae-code/utils";

export type IrcMessageKind = "incoming" | "autoreply" | "relay";

export type ParsedIrcMessage = {
	observationId: string;
	from: string;
	to: string;
	text: string;
	timestamp: number;
	kind: IrcMessageKind;
};

type IrcCustomMessage = Extract<AgentMessage, { role: "custom" }>;

export function isIrcCustomType(customType: string | undefined): customType is `irc:${IrcMessageKind}` {
	return customType === "irc:incoming" || customType === "irc:autoreply" || customType === "irc:relay";
}

function stringDetail(details: unknown, key: string): string {
	if (!details || typeof details !== "object") return "";
	const value = (details as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

/**
 * Normalizes every supported IRC custom message into its UI observation shape.
 * Legacy records have no UUID, so their immutable payload is used as a stable key.
 */
export function parseIrcMessage(message: IrcCustomMessage): ParsedIrcMessage | undefined {
	if (!isIrcCustomType(message.customType)) return undefined;

	const kind = message.customType.slice(4) as IrcMessageKind;
	const timestamp =
		typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
	const from = sanitizeText(kind === "autoreply" ? "you" : stringDetail(message.details, "from") || "?");
	const to = sanitizeText(kind === "incoming" ? "you" : stringDetail(message.details, "to") || "?");
	const text = sanitizeText(
		kind === "incoming"
			? stringDetail(message.details, "message")
			: kind === "autoreply"
				? stringDetail(message.details, "reply")
				: stringDetail(message.details, "body"),
	);
	const observationId = stringDetail(message.details, "observationId");
	return {
		observationId: observationId || `legacy:${JSON.stringify([kind, timestamp, from, to, text])}`,
		from,
		to,
		text,
		timestamp,
		kind,
	};
}
