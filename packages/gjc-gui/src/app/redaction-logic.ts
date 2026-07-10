import type { JsonValue } from "@gajae-code/app-server-client";
import { basename } from "./directory-logic";

export type DataClass =
	| "public-ui-copy"
	| "local-path"
	| "endpoint-transport-metadata"
	| "host-uri-url"
	| "host-uri-content"
	| "workflow-gate-context"
	| "workflow-gate-schema"
	| "tool-args"
	| "tool-output"
	| "tool-error"
	| "transcript-text"
	| "copy-dump-export"
	| "plugin-settings"
	| "screenshot";

export type DisplayPolicy = "show" | "truncate" | "mask" | "omit" | "synthetic-only";

export const DATA_CLASS_POLICIES: Record<
	DataClass,
	{ display: DisplayPolicy; export: DisplayPolicy; screenshot: DisplayPolicy }
> = {
	"public-ui-copy": { display: "show", export: "show", screenshot: "show" },
	"local-path": { display: "truncate", export: "truncate", screenshot: "mask" },
	"endpoint-transport-metadata": { display: "mask", export: "omit", screenshot: "mask" },
	"host-uri-url": { display: "truncate", export: "omit", screenshot: "mask" },
	"host-uri-content": { display: "truncate", export: "omit", screenshot: "synthetic-only" },
	"workflow-gate-context": { display: "truncate", export: "omit", screenshot: "synthetic-only" },
	"workflow-gate-schema": { display: "truncate", export: "omit", screenshot: "synthetic-only" },
	"tool-args": { display: "truncate", export: "truncate", screenshot: "synthetic-only" },
	"tool-output": { display: "truncate", export: "truncate", screenshot: "synthetic-only" },
	"tool-error": { display: "truncate", export: "truncate", screenshot: "synthetic-only" },
	"transcript-text": { display: "show", export: "show", screenshot: "synthetic-only" },
	"copy-dump-export": { display: "show", export: "show", screenshot: "synthetic-only" },
	"plugin-settings": { display: "mask", export: "omit", screenshot: "mask" },
	screenshot: { display: "synthetic-only", export: "omit", screenshot: "synthetic-only" },
};

const SECRET_KEY_PATTERN =
	"(?:token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|x-api-key|secret|authorization|password)";
const SECRET_FIELD = new RegExp(`^${SECRET_KEY_PATTERN}$`, "i");
const JSON_SECRET_VALUE = new RegExp(`(["']${SECRET_KEY_PATTERN}["']\\s*:\\s*)(["'])[^"']*\\2`, "gi");
const SECRET_ASSIGNMENT = new RegExp(
	String.raw`\b(?<!\b(?:const|let|var)\s+)(${SECRET_KEY_PATTERN})\s*[:=]\s*([^\s,;]+)`,
	"gi",
);
const AUTH_HEADER = /\b((?:Bearer|Basic|Digest)\s+)[A-Za-z0-9._~+/-]+=*/gi;
const QUERY_SECRET = new RegExp(`([?&](?:${SECRET_KEY_PATTERN})=)[^\\s&#]+`, "gi");

export function isSecretFieldKey(key: string): boolean {
	return SECRET_FIELD.test(key);
}

export function clampText(value: string, maxLength = 2000): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength))}\n[truncated ${value.length - maxLength} chars]`;
}

export function truncateMiddle(value: string, maxLength = 160): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return "…";
	const keep = maxLength - 1;
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function isCodeReference(value: string): boolean {
	// Function/method calls (getPassword(), config.read()) and dotted property
	// references (config.password) are code, not literal secrets.
	if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^\s)]*\)$/.test(value)) return true;
	return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value);
}

export function redactSecretText(value: string): string {
	return value
		.replace(JSON_SECRET_VALUE, (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted]${quote}`)
		.replace(QUERY_SECRET, "$1[redacted]")
		.replace(AUTH_HEADER, "$1[redacted]")
		.replace(SECRET_ASSIGNMENT, (match, key: string, assignedValue: string) =>
			isCodeReference(assignedValue) ? match : `${key}=[redacted]`,
		);
}

export function redactHostUri(value: string, maxLength = 160): string {
	try {
		const url = new URL(value);
		if (url.username) url.username = "redacted";
		if (url.password) url.password = "redacted";
		for (const key of Array.from(url.searchParams.keys())) {
			if (isSecretFieldKey(key)) url.searchParams.set(key, "[redacted]");
		}
		return truncateMiddle(redactSecretText(url.toString()), maxLength);
	} catch {
		return truncateMiddle(redactSecretText(value), maxLength);
	}
}

export function safeWorkflowGateContext(value: JsonValue, maxLength = 1200): string {
	return clampText(redactSecretText(jsonPreview(value)), maxLength);
}

export function safeToolText(value: string, maxLength = 2000): string {
	return clampText(redactSecretText(value), maxLength);
}

export function displayBasename(path: string, maxLength = 40): string {
	return truncateMiddle(basename(path.replace(/^\/Users\/[^/]+/i, "~/").replace(/^\/home\/[^/]+/i, "~/")), maxLength);
}

function jsonPreview(value: JsonValue): string {
	return typeof value === "string" ? value : JSON.stringify(redactJson(value), null, 2);
}

function redactJson(value: JsonValue): JsonValue {
	if (typeof value === "string") return redactSecretText(value);
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(redactJson) as JsonValue;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			isSecretFieldKey(key) ? "[redacted]" : redactJson(child as JsonValue),
		]),
	) as JsonValue;
}
