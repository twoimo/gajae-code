import { describe, expect, test } from "bun:test";
import { nextLoginFlowState, redactedLoginFlowView } from "./login-flow-logic";

describe("login flow logic", () => {
	test("transitions from pending through needs-input to authenticated", () => {
		expect(nextLoginFlowState("idle", "pending-browser")).toBe("pending-browser");
		expect(nextLoginFlowState("pending-browser", "needs-input")).toBe("needs-input");
		expect(nextLoginFlowState("needs-input", "authenticated")).toBe("authenticated");
	});

	test("terminal states do not reopen on later poll results", () => {
		expect(nextLoginFlowState("authenticated", "pending-browser")).toBe("authenticated");
		expect(nextLoginFlowState("cancelled", "pending-browser")).toBe("cancelled");
		expect(nextLoginFlowState("unsupported", "needs-input")).toBe("unsupported");
	});

	test("redacted view preserves state prompts but no credential-shaped fields", () => {
		const view = redactedLoginFlowView({
			state: "needs-input",
			promptMessage: "Paste redirect URL",
			authUrl: "https://auth.example/start",
			instructions: "Open browser",
		});
		expect(view).toEqual({
			state: "needs-input",
			promptMessage: "Paste redirect URL",
			authUrl: "https://auth.example/start",
			instructions: "Open browser",
		});
		expect(JSON.stringify(view)).not.toContain("token");
		expect(JSON.stringify(view)).not.toContain("verifier");
		expect(JSON.stringify(view)).not.toContain("code");
	});
});
