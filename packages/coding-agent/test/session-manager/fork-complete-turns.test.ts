import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@gajae-code/ai";
import { selectCompleteTurnPrefix } from "../../src/session/complete-turns";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 3,
	};
}

function messageTexts(session: SessionManager): string[] {
	return session
		.getEntries()
		.filter(entry => entry.type === "message")
		.map(entry => {
			const message = entry.message;
			if (message.role === "user" || message.role === "developer") {
				return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
			}
			if (message.role === "assistant" || message.role === "toolResult") return JSON.stringify(message.content);
			return message.role;
		});
}

describe("SessionManager complete-turn forks", () => {
	it("keeps a completed user and assistant turn while excluding a user-only tail", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "kept user", timestamp: 1 });
		session.appendMessage(assistant([{ type: "text", text: "kept assistant" }]));
		session.appendMessage({ role: "user", content: "discarded user", timestamp: 3 });

		const fork = await session.fork();
		expect(fork).toBeDefined();
		expect(messageTexts(session)).toEqual(["kept user", JSON.stringify([{ type: "text", text: "kept assistant" }])]);
	});

	it("excludes an assistant tool-call tail without all results", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		session.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		session.appendMessage(assistant([{ type: "text", text: "complete" }]));
		session.appendMessage({ role: "user", content: "run a tool", timestamp: 3 });
		session.appendMessage(
			assistant([{ type: "toolCall", id: "call-missing", name: "read", arguments: { path: "x" } }]),
		);

		await session.fork();
		expect(session.getEntries()).toHaveLength(2);
	});

	it("keeps a completed tool-call turn including every tool result", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "run tools", timestamp: 1 });
		session.appendMessage(
			assistant([
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } },
				{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "two" } },
			]),
		);
		session.appendMessage(toolResult("call-2"));
		session.appendMessage(toolResult("call-1"));

		const selected = selectCompleteTurnPrefix(session.getEntries());
		expect(selected).toHaveLength(4);
		const lastEntry = selected.at(-1);
		expect(lastEntry?.type).toBe("message");
		if (lastEntry?.type === "message") expect(lastEntry.message.role).toBe("toolResult");
	});

	it("retains custom and mode entries around a completed turn but drops them after an incomplete input", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry("before", { retained: true });
		session.appendModeChange("plan");
		session.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		session.appendCustomEntry("during", { retained: true });
		session.appendMessage(assistant([{ type: "text", text: "done" }]));
		session.appendMessage({ role: "developer", content: "discarded", timestamp: 3 });
		session.appendModeChange("execute");
		session.appendCustomEntry("after-incomplete", { retained: false });

		const selected = selectCompleteTurnPrefix(session.getEntries());
		expect(selected.map(entry => (entry.type === "custom" ? entry.customType : entry.type))).toEqual([
			"before",
			"mode_change",
			"message",
			"during",
			"message",
		]);
	});

	it("materializes resident blobs before keeping them in a fork", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/cwd", "/sessions", storage);
		const largeContent = "resident text ".repeat(60_000);
		session.appendMessage({ role: "user", content: largeContent, timestamp: 1 });
		session.appendMessage(assistant([{ type: "text", text: "done" }]));

		await session.fork();
		expect(messageTexts(session)[0]).toBe(largeContent);
	});

	it("applies the same complete-turn selection when forking from another session", async () => {
		const storage = new MemorySessionStorage();
		const source = SessionManager.create("/source", "/sessions", storage);
		source.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		source.appendMessage(assistant([{ type: "text", text: "done" }]));
		source.appendMessage({ role: "fileMention", files: [{ path: "tail.ts", content: "tail" }], timestamp: 3 });
		await source.flush();

		const forked = await SessionManager.forkFrom(source.getSessionFile()!, "/target", "/forks", storage);
		expect(messageTexts(forked)).toEqual(["kept", JSON.stringify([{ type: "text", text: "done" }])]);
	});
});
