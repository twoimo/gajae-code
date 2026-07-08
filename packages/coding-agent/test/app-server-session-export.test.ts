import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentSessionHost } from "../src/modes/app-server/agent-session-host";

function messageEntry(message: unknown, id: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

describe("app-server session export redaction", () => {
	it("rejects relative traversal and nonexistent absolute paths before opening sessions", async () => {
		const host = new AgentSessionHost();
		await expect(host.sessionRename({ sessionPath: "../../etc/passwd", title: "Nope" })).rejects.toThrow("absolute local .jsonl");
		await expect(host.sessionExport({ sessionPath: path.join(os.tmpdir(), "gjc-missing-session.jsonl"), format: "json" })).rejects.toThrow("session file not found");
	});

	it("rejects absolute paths containing traversal segments before normalization", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-trav-"));
		const sessionPath = path.join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "trav-session", timestamp: new Date().toISOString(), cwd: dir };
		await fs.writeFile(sessionPath, `${JSON.stringify(header)}\n`);
		const host = new AgentSessionHost();
		const sneaky = `${dir}/sub/../session.jsonl`;
		await expect(host.sessionRename({ sessionPath: sneaky, title: "Nope" })).rejects.toThrow("traversal");
		await expect(host.sessionExport({ sessionPath: sneaky, format: "json" })).rejects.toThrow("traversal");
	});

	it("scrubs mixed-case key-name secrets inside toolCall arguments and toolResult content", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-toolredact-"));
		const sessionPath = path.join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "toolredact-session", timestamp: new Date().toISOString(), cwd: dir };
		const assistant = messageEntry({
			role: "assistant",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			content: [
				{ type: "toolCall", id: "tc1", name: "cfg", arguments: { Api_Key: "raw-mixed-case", nested: [{ PASSWORD: "raw-upper" }] } },
			],
		}, "m1");
		const toolResult = messageEntry({
			role: "toolResult",
			toolCallId: "tc1",
			content: [{ type: "text", text: "ok" }],
			details: { Authorization: "raw-auth-header" },
		}, "m2");
		await fs.writeFile(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n${JSON.stringify(toolResult)}\n`);
		const host = new AgentSessionHost();
		const redacted = await host.sessionExport({ sessionPath, format: "json" }) as { content: string };
		expect(redacted.content).not.toContain("raw-mixed-case");
		expect(redacted.content).not.toContain("raw-upper");
		expect(redacted.content).not.toContain("raw-auth-header");
		const raw = await host.sessionExport({ sessionPath, format: "json", redact: false }) as { content: string };
		expect(raw.content).toContain("raw-mixed-case");
		expect(raw.content).toContain("raw-upper");
		expect(raw.content).toContain("raw-auth-header");
	});
	it("renames a valid absolute tmp .jsonl session", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-rename-"));
		const sessionPath = path.join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "rename-session", timestamp: new Date().toISOString(), cwd: dir };
		await fs.writeFile(sessionPath, `${JSON.stringify(header)}\n`);
		const host = new AgentSessionHost();
		await expect(host.sessionRename({ sessionPath, title: "Renamed" })).resolves.toMatchObject({ ok: true, title: "Renamed" });
	});

	it("exports handcrafted user and assistant messages as non-empty markdown and json", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-export-"));
		const sessionPath = path.join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "content-session", timestamp: new Date().toISOString(), cwd: dir };
		const user = messageEntry({ role: "user", content: "hello from user" }, "m1");
		const assistant = messageEntry({ role: "assistant", content: [{ type: "text", text: "hello from assistant" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } }, "m2");
		await fs.writeFile(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
		const host = new AgentSessionHost();
		const markdown = await host.sessionExport({ sessionPath, format: "markdown" }) as { content: string };
		const json = await host.sessionExport({ sessionPath, format: "json" }) as { content: string };
		expect(markdown.content).toContain("hello from user");
		expect(markdown.content).toContain("hello from assistant");
		expect(JSON.parse(json.content).messages).toHaveLength(2);
		expect(json.content).toContain("hello from assistant");
	});

	it("redacts common secrets by default and preserves raw content when disabled", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-export-"));
		const sessionPath = path.join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "redact-session", timestamp: new Date().toISOString(), cwd: dir };
		const secrets = "sk-abcdefgh12345678 Bearer bearer-secret AKIA1234567890ABCDEF ghp_abcdefghijklmnopqrstuvwxyz xoxb-1234567890-secret";
		const message = messageEntry({
			role: "assistant",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			content: [
				{ type: "text", text: `token ${secrets}` },
				{ type: "toolCall", id: "tc1", name: "read", arguments: { authorization: "Bearer nested", config: { api_key: "v", password: { deep: "raw" } } } },
			],
		}, "m1");
		await fs.writeFile(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
		const host = new AgentSessionHost();
		const redacted = await host.sessionExport({ sessionPath, format: "json" }) as { content: string; provenance: { redacted: boolean } };
		const raw = await host.sessionExport({ sessionPath, format: "json", redact: false }) as { content: string; provenance: { redacted: boolean } };
		expect(redacted.provenance.redacted).toBe(true);
		expect(redacted.content).toContain("[REDACTED]");
		expect(redacted.content).not.toContain("sk-abcdefgh12345678");
		expect(redacted.content).not.toContain("Bearer bearer-secret");
		expect(redacted.content).not.toContain("AKIA1234567890ABCDEF");
		expect(redacted.content).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
		expect(redacted.content).not.toContain("xoxb-1234567890-secret");
		expect(redacted.content).not.toContain("api_key\": \"v");
		expect(raw.provenance.redacted).toBe(false);
		expect(raw.content).toContain("sk-abcdefgh12345678");
		expect(raw.content).toContain("Bearer bearer-secret");
		expect(raw.content).toContain("AKIA1234567890ABCDEF");
		expect(raw.content).toContain("ghp_abcdefghijklmnopqrstuvwxyz");
		expect(raw.content).toContain("xoxb-1234567890-secret");
		expect(raw.content).toContain("api_key");
		expect(raw.content).toContain("v");
	});
});
