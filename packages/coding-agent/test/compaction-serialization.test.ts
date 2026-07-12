import { describe, expect, it } from "bun:test";
import { serializeConversation } from "@gajae-code/agent-core/compaction/utils";
import type { Message } from "@gajae-code/ai";

describe("serializeConversation", () => {
	it("truncates long tool results in serialized summaries", () => {
		const longContent = `${"h".repeat(2500)}${"t".repeat(2470)}\nEXIT_CODE=0\nmodified: src/final.ts`;
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... tool result truncated ...]");
		expect(result).toContain("h".repeat(900));
		expect(result).toContain("t".repeat(900));
		expect(result).toContain("EXIT_CODE=0");
		expect(result).toContain("modified: src/final.ts");
		expect(result).not.toContain("h".repeat(1500));
	});

	it("does not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("does not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
