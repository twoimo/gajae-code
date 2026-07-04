import { describe, expect, test } from "bun:test";
import type { ServerNotificationEnvelope } from "@gajae-code/app-server-client";
import { emptyTranscriptState, foldNotification, markApproval } from "./transcript";

const streamingFixture: ServerNotificationEnvelope[] = [
	{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-1", seq: 1 } },
	{ method: "item/started", params: { threadId: "thread-1", itemId: "msg-1", itemType: "agentMessage", seq: 2 } },
	{ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "msg-1", delta: "Hello", seq: 3 } },
	{ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "msg-1", delta: " world", seq: 4 } },
	{ method: "item/completed", params: { threadId: "thread-1", itemId: "msg-1", itemType: "agentMessage", seq: 5 } },
	{ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", status: "completed", seq: 6 } },
];

const toolFixture: ServerNotificationEnvelope[] = [
	{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-2", seq: 7 } },
	{
		method: "gjc/hostTools/call",
		params: {
			threadId: "thread-1",
			turnId: "turn-2",
			callId: "call-1",
			generation: 1,
			tool: "bash",
			args: { command: "bun test" },
		},
	},
];

describe("transcript event folding", () => {
	test("folds recorded assistant streaming deltas into one completed item", () => {
		const state = streamingFixture.reduce(foldNotification, emptyTranscriptState());

		expect(state.activeThreadId).toBe("thread-1");
		expect(state.activeTurnId).toBeUndefined();
		expect(state.seq).toBe(6);
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({
			id: "msg-1",
			threadId: "thread-1",
			role: "assistant",
			status: "completed",
			content: "Hello world",
		});
	});

	test("keeps agentMessage start and deltas as a single assistant card", () => {
		const state = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-3", seq: 10 } },
			{
				method: "item/started",
				params: { threadId: "thread-1", itemId: "msg-2", itemType: "agentMessage", seq: 11 },
			},
			{ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "msg-2", delta: "A", seq: 12 } },
			{ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "msg-2", delta: "B", seq: 13 } },
		] satisfies ServerNotificationEnvelope[];

		const folded = state.reduce(foldNotification, emptyTranscriptState());

		expect(folded.items).toHaveLength(1);
		expect(folded.items[0]).toMatchObject({
			id: "msg-2",
			role: "assistant",
			status: "running",
			title: "GJC",
			content: "AB",
		});
	});

	test("completes active streaming assistant text on turn completion without duplicates", () => {
		const folded = streamingFixture.reduce(foldNotification, emptyTranscriptState());

		expect(folded.items.map(item => item.id)).toEqual(["msg-1"]);
		expect(folded.items[0]?.status).toBe("completed");
		expect(folded.items[0]?.content).toBe("Hello world");
	});

	test("drops empty assistant echo item when message_start reveals a user message", () => {
		// Real wire trace (G010 capture): the server maps the user's own
		// message_start to an agentMessage item/started before the assistant one.
		const fixture = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-9", seq: 20 } },
			{
				method: "item/started",
				params: { threadId: "thread-1", itemId: "echo-1", itemType: "agentMessage", seq: 21 },
			},
			{
				method: "gjc/event",
				params: {
					threadId: "thread-1",
					eventType: "message_start",
					event: { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
					seq: 22,
				},
			},
			{
				method: "item/completed",
				params: { threadId: "thread-1", itemId: "echo-1", itemType: "agentMessage", seq: 23 },
			},
			{
				method: "item/started",
				params: { threadId: "thread-1", itemId: "real-1", itemType: "agentMessage", seq: 24 },
			},
			{
				method: "gjc/event",
				params: {
					threadId: "thread-1",
					eventType: "message_start",
					event: { type: "message_start", message: { role: "assistant", content: [] } },
					seq: 25,
				},
			},
			{
				method: "item/agentMessage/delta",
				params: { threadId: "thread-1", itemId: "real-1", delta: "hello", seq: 26 },
			},
			{
				method: "item/completed",
				params: { threadId: "thread-1", itemId: "real-1", itemType: "agentMessage", seq: 27 },
			},
		] satisfies ServerNotificationEnvelope[];

		const folded = fixture.reduce(foldNotification, emptyTranscriptState());

		expect(folded.items.map(item => item.id)).toEqual(["real-1"]);
		expect(folded.items[0]).toMatchObject({ role: "assistant", status: "completed", content: "hello" });
	});

	test("creates pending approval gate and tool card from host tool call", () => {
		const state = toolFixture.reduce(foldNotification, emptyTranscriptState());

		expect(state.approvals).toHaveLength(1);
		expect(state.approvals[0]).toMatchObject({
			id: "call-1",
			threadId: "thread-1",
			turnId: "turn-2",
			tool: "bash",
			status: "pending",
		});
		expect(state.items.at(-1)).toMatchObject({
			id: "tool-call-1",
			role: "tool",
			status: "running",
			title: "bash",
		});
	});

	test("marks approval result without mutating unrelated gates", () => {
		const state = toolFixture.reduce(foldNotification, emptyTranscriptState());
		const approved = markApproval(state, "call-1", "approved");

		expect(approved.approvals[0]?.status).toBe("approved");
		expect(state.approvals[0]?.status).toBe("pending");
	});
});
