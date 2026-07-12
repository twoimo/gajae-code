import { describe, expect, it } from "bun:test";

describe("coding-agent stable export map", () => {
	it("resolves the retained root, SDK, and CLI entry points", async () => {
		const root = await import("@gajae-code/coding-agent");
		expect(root.createAgentSession).toBeFunction();
		expect(root.SessionManager).toBeDefined();
		expect(root.AgentSession).toBeDefined();
		expect(root.computeLineHash).toBeFunction();
		expect(root.formatSessionDumpText).toBeFunction();
		expect((await import("@gajae-code/coding-agent/sdk")).createAgentSession).toBeFunction();
		expect((await import("@gajae-code/coding-agent/cli")).runCli).toBeFunction();
	});

	it("does not resolve removed topology paths", async () => {
		for (const specifier of [
			"@gajae-code/coding-agent/tools",
			"@gajae-code/coding-agent/session/agent-session",
			"@gajae-code/coding-agent/modes",
			"@gajae-code/coding-agent/extensibility/extensions",
			"@gajae-code/coding-agent/mcp",
			"@gajae-code/coding-agent/mcp/server",
			"@gajae-code/coding-agent/runtime-mcp",
			"@gajae-code/coding-agent/runtime-mcp/manager",
		]) {
			await expect(import(specifier)).rejects.toThrow();
		}
	});
});
