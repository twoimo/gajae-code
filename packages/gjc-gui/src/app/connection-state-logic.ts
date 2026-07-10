import { AppServerConnectionError, AppServerResponseError } from "@gajae-code/app-server-client";
import { isSecretFieldKey, redactSecretText } from "./redaction-logic";

export type ConnectionKind = "booting" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
export type FailureKind =
	| "origin-rejected"
	| "token-rejected"
	| "stale-discovery"
	| "sidecar-crash"
	| "server-unavailable"
	| "unknown";

export type ConnectionState = {
	kind: ConnectionKind;
	failure?: FailureKind;
	detail?: string;
	endpointUrl?: string;
};

export function describeFailure(error: unknown): ConnectionState {
	const message = errorMessage(error);
	return { kind: "error", failure: classifyFailure(message), detail: redactDetail(message) };
}

export function classifyFailure(message: string): FailureKind {
	const lower = message.toLowerCase();
	if (lower.includes("origin") || lower.includes("forbidden")) return "origin-rejected";
	if (lower.includes("token") || lower.includes("unauthorized")) return "token-rejected";
	if (lower.includes("stale")) return "stale-discovery";
	if (lower.includes("crash") || lower.includes("closed") || lower.includes("disconnect")) return "sidecar-crash";
	if (lower.includes("connect") || lower.includes("unavailable") || lower.includes("readyz"))
		return "server-unavailable";
	return "unknown";
}

export function errorMessage(error: unknown): string {
	// Display-facing: always redact secret-like material before rendering.
	if (error instanceof AppServerResponseError || error instanceof AppServerConnectionError || error instanceof Error)
		return redactSecretText(error.message);
	if (typeof error === "string") return redactSecretText(error);
	return "Something went wrong.";
}

export type FailureCopy = { title: string; body: string; action: string };

export function failureContent(failure: FailureKind | undefined): FailureCopy {
	switch (failure) {
		case "origin-rejected":
			return {
				title: "This desktop app is not allowed to connect",
				body: "The local service rejected the desktop app origin. Restart Gajae Code from the desktop launcher, then reconnect.",
				action: "Reconnect",
			};
		case "token-rejected":
			return {
				title: "The connection token was rejected",
				body: "The desktop app and local service no longer agree on the private connection token. Restart the app, then reconnect.",
				action: "Reconnect",
			};
		case "stale-discovery":
			return {
				title: "The saved connection is stale",
				body: "Gajae Code found an old local-service record. Reconnect to discover the current desktop service.",
				action: "Reconnect",
			};
		case "sidecar-crash":
			return {
				title: "The local helper stopped",
				body: "The desktop helper closed before the chat could continue. Reconnect; if it repeats, restart Gajae Code.",
				action: "Reconnect",
			};
		case "server-unavailable":
			return {
				title: "Gajae Code is still starting",
				body: "The desktop service is not ready yet. Wait a moment, then reconnect.",
				action: "Reconnect",
			};
		default:
			return {
				title: "Connection unavailable",
				body: "The desktop app could not open a chat connection. Reconnect or restart Gajae Code if this keeps happening.",
				action: "Reconnect",
			};
	}
}

export function failureTitle(failure: FailureKind | undefined): string {
	return failureContent(failure).title;
}

export function failureCopy(failure: FailureKind | undefined): string {
	return failureContent(failure).body;
}

export function safeEndpoint(endpointUrl: string): string {
	try {
		const url = new URL(endpointUrl);
		for (const key of Array.from(url.searchParams.keys())) {
			if (isSecretFieldKey(key)) url.searchParams.delete(key);
		}
		if (url.username) url.username = "redacted";
		if (url.password) url.password = "redacted";
		return url.toString();
	} catch {
		return redactDetail(endpointUrl);
	}
}

export function redactDetail(detail: string): string {
	return redactSecretText(detail);
}
