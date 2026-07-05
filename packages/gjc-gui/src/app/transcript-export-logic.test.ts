import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./transcript";
import { lastAssistantText, serializeTranscript } from "./transcript-export-logic";

const item = (overrides: Partial<TranscriptItem>): TranscriptItem => ({
	id: overrides.id ?? "item-1",
	threadId: overrides.threadId ?? "thread-1",
	role: overrides.role ?? "assistant",
	status: overrides.status ?? "completed",
	content: overrides.content ?? "",
	...overrides,
});

describe("lastAssistantText", () => {
	test("returns the last non-empty assistant content", () => {
		expect(
			lastAssistantText([
				item({ id: "user", role: "user", content: "question" }),
				item({ id: "assistant-1", role: "assistant", content: "first" }),
				item({ id: "tool", role: "tool", content: "tool output" }),
				item({ id: "assistant-empty", role: "assistant", content: "  " }),
				item({ id: "assistant-2", role: "assistant", content: " second answer " }),
			]),
		).toBe("second answer");
	});

	test("cleans inline tool-call JSON from copied assistant text", () => {
		expect(lastAssistantText([item({ content: 'Here is the answer. {"_i":"Calling read","path":"x"}' })])).toBe("Here is the answer.");
	});

	test("returns undefined for empty input or no assistant content", () => {
		expect(lastAssistantText([])).toBeUndefined();
		expect(lastAssistantText([item({ role: "user", content: "hello" }), item({ role: "assistant", content: "" })])).toBeUndefined();
	});
});

describe("serializeTranscript", () => {
	test("serializes non-empty items into readable blocks", () => {
		expect(
			serializeTranscript([
				item({ id: "user", role: "user", status: "completed", content: "hello" }),
				item({ id: "assistant", role: "assistant", status: "running", content: "working" }),
				item({ id: "empty", role: "tool", status: "success", content: "  " }),
				item({ id: "event", role: "event", status: "error", content: "failed" }),
			]),
		).toBe("USER[/completed]: hello\n\nASSISTANT[/running]: working\n\nEVENT[/error]: failed");
	});

	test("cleans assistant and reasoning content when dumping transcript", () => {
		const dump = serializeTranscript([
			item({ id: "assistant", role: "assistant", content: 'Prose {"_i":"Calling bash","args":{"command":"pwd"}}' }),
			item({ id: "reasoning", role: "reasoning", content: 'Thought {"_i":"Calling read","path":"x"}' }),
		]);

		expect(dump).toBe("ASSISTANT[/completed]: Prose\n\nREASONING[/completed]: Thought");
		expect(dump).not.toContain('"_i"');
	});
	test("returns an empty string for empty input", () => {
		expect(serializeTranscript([])).toBe("");
	});
});
