import { describe, expect, test } from "bun:test";
import {
	clampText,
	DATA_CLASS_POLICIES,
	displayBasename,
	isSecretFieldKey,
	redactHostUri,
	redactSecretText,
	safeToolText,
	safeWorkflowGateContext,
	truncateMiddle,
} from "./redaction-logic";

describe("redaction data classification", () => {
	test("documents required data classes as policies", () => {
		expect(DATA_CLASS_POLICIES["public-ui-copy"].display).toBe("show");
		expect(DATA_CLASS_POLICIES["local-path"].display).toBe("truncate");
		expect(DATA_CLASS_POLICIES["endpoint-transport-metadata"].export).toBe("omit");
		expect(DATA_CLASS_POLICIES["host-uri-url"].display).toBe("truncate");
		expect(DATA_CLASS_POLICIES["host-uri-content"].screenshot).toBe("synthetic-only");
		expect(DATA_CLASS_POLICIES["workflow-gate-context"].display).toBe("truncate");
		expect(DATA_CLASS_POLICIES["workflow-gate-schema"].display).toBe("truncate");
		expect(DATA_CLASS_POLICIES["tool-args"].display).toBe("truncate");
		expect(DATA_CLASS_POLICIES["tool-output"].display).toBe("truncate");
		expect(DATA_CLASS_POLICIES["tool-error"].display).toBe("truncate");
		expect(DATA_CLASS_POLICIES["transcript-text"].export).toBe("show");
		expect(DATA_CLASS_POLICIES["copy-dump-export"].export).toBe("show");
		expect(DATA_CLASS_POLICIES["plugin-settings"].display).toBe("mask");
	});

	test("redacts host URI credentials and query secrets", () => {
		const uri = redactHostUri(
			"gjc://user:secret@example.test/path/file?token=secret-token&safe=1&api_key=secret-key",
			300,
		);
		expect(uri).toContain("gjc://redacted:redacted@example.test/path/file");
		expect(uri).not.toContain("secret-token");
		expect(uri).not.toContain("secret-key");
	});

	test("redacts high-confidence secrets without rewriting generic keys", () => {
		const workflow = safeWorkflowGateContext(
			{
				prompt: "approve",
				token: "secret-token",
				access_token: "access-secret",
				client_secret: "client-secret",
				key: "legitimate-key",
				nested: { authorization: "Bearer abc.def" },
			},
			200,
		);
		expect(workflow).toContain("[redacted]");
		expect(workflow).toContain("legitimate-key");
		expect(workflow).not.toContain("secret-token");
		expect(workflow).not.toContain("access-secret");
		expect(workflow).not.toContain("client-secret");
		expect(workflow).not.toContain("abc.def");
		expect(isSecretFieldKey("access-token")).toBe(true);
		expect(isSecretFieldKey("refresh_token")).toBe(true);
		expect(isSecretFieldKey("x-api-key")).toBe(true);
		expect(isSecretFieldKey("apikey")).toBe(true);
		expect(isSecretFieldKey("key")).toBe(false);
		expect(safeToolText(`key=value\nAuthorization: Bearer abc.def\n${"x".repeat(100)}`, 60)).toContain("key=value");
	});

	test("redacts JSON secret values inside plain text", () => {
		const json = redactSecretText('{"password":"x","nested":{"token":"y"}}');
		expect(json).toBe('{"password":"[redacted]","nested":{"token":"[redacted]"}}');
		expect(redactSecretText("payload: \"x-api-key\": \"abc\" and 'client_secret': 'def'")).not.toContain("abc");
	});

	test("redacts explicit assignments but preserves benign code references and generic key content", () => {
		expect(
			redactSecretText(
				"key=value token=secret access_token=access refresh-token=refresh client_secret=client x-api-key:shh apikey=short password=pw Authorization: Basic abc",
			),
		).toBe(
			"key=value token=[redacted] access_token=[redacted] refresh-token=[redacted] client_secret=[redacted] x-api-key=[redacted] apikey=[redacted] password=[redacted] Authorization=[redacted] [redacted]",
		);
		expect(redactSecretText("+ const password = getPassword()")).toBe("+ const password = getPassword()");
		expect(redactSecretText("const token = readToken();")).toBe("const token = readToken();");
		expect(redactSecretText("password=getPassword()")).toBe("password=getPassword()");
		expect(redactSecretText("password = config.password;")).toBe("password = config.password;");
		expect(redactSecretText("password=hunter2")).toBe("password=[redacted]");
		expect(redactSecretText("monkey=banana")).toBe("monkey=banana");
		expect(redactSecretText("prose password should not redact")).toBe("prose password should not redact");
	});

	test("utility truncation and path display stay compact", () => {
		expect(clampText("abcdef", 3)).toBe("abc\n[truncated 3 chars]");
		expect(truncateMiddle("abcdefghij", 5)).toBe("ab…ij");
		expect(displayBasename("/Users/alice/work/project-secret")).toBe("project-secret");
		expect(redactSecretText("api_key=secret Authorization: Basic abc")).not.toContain("secret");
	});
});
