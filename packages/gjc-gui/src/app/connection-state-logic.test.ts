import { describe, expect, test } from "bun:test";
import {
	classifyFailure,
	describeFailure,
	errorMessage,
	failureCopy,
	redactDetail,
	safeEndpoint,
} from "./connection-state-logic";

describe("connection failure logic", () => {
	const cases = [
		[
			"origin blocked by allowlist",
			"origin-rejected",
			"The local service rejected the desktop app origin. Restart Gajae Code from the desktop launcher, then reconnect.",
		],
		[
			"token unauthorized",
			"token-rejected",
			"The desktop app and local service no longer agree on the private connection token. Restart the app, then reconnect.",
		],
		[
			"stale discovery record",
			"stale-discovery",
			"Gajae Code found an old local-service record. Reconnect to discover the current desktop service.",
		],
		[
			"sidecar closed after crash",
			"sidecar-crash",
			"The desktop helper closed before the chat could continue. Reconnect; if it repeats, restart Gajae Code.",
		],
		[
			"connect ECONNREFUSED readyz unavailable",
			"server-unavailable",
			"The desktop service is not ready yet. Wait a moment, then reconnect.",
		],
		[
			"unexpected banana",
			"unknown",
			"The desktop app could not open a chat connection. Reconnect or restart Gajae Code if this keeps happening.",
		],
	] as const;

	for (const [message, kind, copy] of cases) {
		test(`${kind} classification and copy`, () => {
			expect(classifyFailure(message)).toBe(kind);
			expect(failureCopy(kind)).toBe(copy);
		});
	}

	test("redacts endpoint and detail tokens", () => {
		expect(safeEndpoint("http://user:secret@127.0.0.1:1234/rpc?token=secret-token&x=1")).not.toContain("secret");
		expect(safeEndpoint("http://127.0.0.1:1234/rpc?token=secret-token&password=secret-password&x=1")).toBe(
			"http://127.0.0.1:1234/rpc?x=1",
		);
		expect(redactDetail("failed token=secret-token Authorization: Bearer abc.def?api_key=secret-key")).not.toContain(
			"secret-token",
		);
		expect(redactDetail("close reason key=keep-me secret=shh")).toContain("key=keep-me");
		expect(redactDetail("close reason key=keep-me secret=shh")).not.toContain("shh");
		expect(redactDetail("authorization=Basic xyz-credential password=swordfish")).not.toContain("xyz-credential");
		expect(redactDetail("authorization=Basic xyz-credential password=swordfish")).not.toContain("swordfish");
		expect(errorMessage(new Error("catalog load failed api_key=palette-secret"))).not.toContain("palette-secret");
		expect(errorMessage("inspect failed token=ext-secret")).not.toContain("ext-secret");
		expect(errorMessage(new Error("plain failure key=keep-me"))).toContain("key=keep-me");
	});

	test("describeFailure stores redacted detail", () => {
		const state = describeFailure(new Error("token=secret-token unauthorized"));
		expect(state.failure).toBe("token-rejected");
		expect(state.detail).not.toContain("secret-token");
	});
});
