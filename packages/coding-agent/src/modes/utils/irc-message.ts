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

export interface IrcMessageBlock {
	readonly sender: string;
	readonly recipient: string;
	readonly kind: "incoming" | "autoreply" | "outgoing";
	readonly time: string;
	readonly bodyLines: readonly string[];
}

/** Normalizes untrusted IRC identity fields without altering visible grapheme composition. */
export function normalizeIrcIdentity(identity: string): string {
	return sanitizeText(identity.replace(/[\r\n\t\u2028\u2029]+/g, " ")).replace(
		/[\u061C\u200E-\u200F\u202A-\u202E\u2066-\u2069]/g,
		"",
	);
}

/** Formats IRC observations into display-neutral semantic blocks for both IRC surfaces. */
export function formatIrcMessageBlock(message: ParsedIrcMessage & { timestamp: number }): IrcMessageBlock {
	const date = new Date(message.timestamp);
	// IRC timestamps are human-facing, so use local time rather than UTC serialization.
	const time = Number.isFinite(date.getTime())
		? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
		: "--:--";
	const bodyLines = message.text === "" ? [] : message.text.replaceAll("\t", "    ").split("\n");
	return {
		sender: normalizeIrcIdentity(message.from),
		recipient: normalizeIrcIdentity(message.to),
		kind: message.kind === "relay" ? "outgoing" : message.kind,
		time,
		bodyLines,
	};
}

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
	const from = normalizeIrcIdentity(kind === "autoreply" ? "you" : stringDetail(message.details, "from") || "?");
	const to = normalizeIrcIdentity(kind === "incoming" ? "you" : stringDetail(message.details, "to") || "?");
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
