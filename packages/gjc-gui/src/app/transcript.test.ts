import { describe, expect, test } from "bun:test";
import type { ServerNotificationEnvelope } from "@gajae-code/app-server-client";
import { appendLocalUserMessage, cleanAssistantText, emptyTranscriptState, foldNotification, markApproval, upsertThread } from "./transcript";

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


describe("assistant text cleanup", () => {
	test("strips inline nested tool JSON carrying the _i marker", () => {
		const text = 'Before {"_i":"Calling read","path":"x","nested":{"brace":"}"}} after';

		expect(cleanAssistantText(text)).toBe("Before  after");
	});

	test("assistant content that is only tool JSON becomes empty", () => {
		expect(cleanAssistantText('{"_i":"Calling bash","args":{"command":"pwd"}}')).toBe("");
	});
});
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
			title: "gajae",
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

		const initial = appendLocalUserMessage(emptyTranscriptState(), "thread-1", "hi");
		const folded = fixture.reduce(foldNotification, initial);

		expect(folded.items.map(item => item.role)).toEqual(["user", "assistant"]);
		expect(folded.items[0]).toMatchObject({ role: "user", status: "completed", content: "hi" });
		expect(folded.items[1]).toMatchObject({ role: "assistant", status: "completed", content: "hello" });
	});

	test("folds tool_execution start/end detail into the tool card by callId", () => {
		const fixture = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-5", seq: 40 } },
			{
				method: "item/started",
				params: { threadId: "thread-1", itemId: "call-9", itemType: "commandExecution", toolName: "bash", seq: 41 },
			},
			{
				method: "gjc/event",
				params: {
					threadId: "thread-1",
					eventType: "tool_execution_start",
					event: { type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: { command: "ls" } },
					seq: 42,
				},
			},
			{
				method: "gjc/event",
				params: {
					threadId: "thread-1",
					eventType: "tool_execution_end",
					event: { type: "tool_execution_end", toolCallId: "call-9", output: "file.txt" },
					seq: 43,
				},
			},
		] as ServerNotificationEnvelope[];

		const folded = fixture.reduce(foldNotification, emptyTranscriptState());
		const card = folded.items.find(item => item.id === "call-9");
		expect(card).toBeDefined();
		expect(card?.role).toBe("tool");
		expect(card?.status).toBe("completed");
		expect(card?.content).toContain("ls");
		expect(card?.content).toContain("file.txt");
		expect(card?.tool).toMatchObject({ name: "bash", args: '{\n  "command": "ls"\n}', output: "file.txt" });
	});

	test("delta before start carries active turn id and turn completion finalizes it", () => {
		const folded = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-delta", seq: 50 } },
			{ method: "item/agentMessage/delta", params: { threadId: "thread-1", itemId: "late-start", delta: "early", seq: 51 } },
			{ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-delta", status: "completed", seq: 52 } },
		] satisfies ServerNotificationEnvelope[];

		const state = folded.reduce(foldNotification, emptyTranscriptState());
		expect(state.items[0]).toMatchObject({ id: "late-start", turnId: "turn-delta", status: "completed", content: "early" });
	});

	test("raw tool end attaches to host tool card id by callId", () => {
		const folded = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-tool", seq: 60 } },
			{
				method: "gjc/hostTools/call",
				params: { threadId: "thread-1", turnId: "turn-tool", callId: "call-raw", generation: 1, tool: "bash", args: { command: "pwd" } },
			},
			{
				method: "gjc/event",
				params: {
					threadId: "thread-1",
					eventType: "tool_execution_end",
					event: { type: "tool_execution_end", toolCallId: "call-raw", output: "ok", error: "warn" },
					seq: 61,
				},
			},
		] satisfies ServerNotificationEnvelope[];

		const state = folded.reduce(foldNotification, emptyTranscriptState());
		const card = state.items.find(item => item.id === "tool-call-raw");
		expect(card).toMatchObject({ role: "tool", status: "error" });
		expect(card?.content).toContain("pwd");
		expect(card?.content).toContain("warn");
		expect(card?.tool).toMatchObject({ name: "bash", args: '{\n  "command": "pwd"\n}', output: "ok", error: "warn" });
	});

	test("stale unknown-thread item event is ignored", () => {
		const state = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-known", seq: 70 } },
			{ method: "item/started", params: { threadId: "ghost", itemId: "ghost-item", itemType: "agentMessage", seq: 71 } },
		] satisfies ServerNotificationEnvelope[];

		const folded = state.reduce(foldNotification, emptyTranscriptState());
		expect(folded.items).toHaveLength(0);
	});

	test("user echo dedup matches by role and content within active thread", () => {
		const fixture = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-echo", seq: 80 } },
			{ method: "item/started", params: { threadId: "thread-1", itemId: "echo-a", itemType: "agentMessage", seq: 81 } },
			{
				method: "gjc/event",
				params: {
					threadId: "thread-1",
					eventType: "message_start",
					event: { type: "message_start", message: { role: "user", content: [{ type: "text", text: "second" }] } },
					seq: 82,
				},
			},
		] satisfies ServerNotificationEnvelope[];

		const initial = appendLocalUserMessage(
			appendLocalUserMessage(emptyTranscriptState(), "thread-1", "first"),
			"thread-1",
			"second",
		);
		const folded = fixture.reduce(foldNotification, initial);
		expect(folded.items.filter(item => item.role === "assistant")).toHaveLength(0);
		expect(folded.items.filter(item => item.role === "user").map(item => item.content)).toEqual(["first", "second"]);
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
		expect(state.items.at(-1)?.tool).toMatchObject({ name: "bash", args: '{\n  "command": "bun test"\n}' });
	});

	test("marks approval result without mutating unrelated gates", () => {
		const state = toolFixture.reduce(foldNotification, emptyTranscriptState());
		const approved = markApproval(state, "call-1", "approved");

		expect(approved.approvals[0]?.status).toBe("approved");
		expect(state.approvals[0]?.status).toBe("pending");
	});

	test("folds host URI request into a pending approval card", () => {
		const state = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-host-uri", seq: 90 } },
			{
				method: "gjc/hostUris/request",
				params: {
					threadId: "thread-1",
					turnId: "turn-host-uri",
					requestId: "uri-1",
					generation: 1,
					operation: "read",
					url: "file:///tmp/example.txt",
				},
			},
		] satisfies ServerNotificationEnvelope[];

		const folded = state.reduce(foldNotification, emptyTranscriptState());
		expect(folded.approvals[0]).toMatchObject({
			kind: "host-uri",
			id: "uri-1",
			threadId: "thread-1",
			turnId: "turn-host-uri",
			operation: "read",
			url: "file:///tmp/example.txt",
			status: "pending",
		});
	});

	test("folds host URI cancel into a cancelled card", () => {
		const state = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-host-uri", seq: 91 } },
			{
				method: "gjc/hostUris/request",
				params: {
					threadId: "thread-1",
					turnId: "turn-host-uri",
					requestId: "uri-2",
					generation: 1,
					operation: "write",
					url: "file:///tmp/out.txt",
					content: "hello",
				},
			},
			{ method: "gjc/hostUris/cancel", params: { threadId: "thread-1", turnId: "turn-host-uri", requestId: "uri-2", generation: 2 } },
		] satisfies ServerNotificationEnvelope[];

		const folded = state.reduce(foldNotification, emptyTranscriptState());
		expect(folded.approvals[0]).toMatchObject({ kind: "host-uri", id: "uri-2", status: "cancelled" });
	});

	test("folds workflow gate opened into a pending gate card", () => {
		const state = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-gate", seq: 92 } },
			{
				method: "gjc/workflowGate/opened",
				params: {
					threadId: "thread-1",
					gate_id: "gate-1",
					generation: 1,
					kind: "approval",
					stage: "ralplan",
					required: true,
					type: "workflow_gate",
					created_at: "2026-07-04T00:00:00Z",
					schema_hash: "hash",
					schema: { type: "boolean" },
					context: {},
					options: [{ label: "Proceed", value: true }],
				},
			},
		] satisfies ServerNotificationEnvelope[];

		const folded = state.reduce(foldNotification, emptyTranscriptState());
		expect(folded.approvals[0]).toMatchObject({
			kind: "workflow-gate",
			id: "gate-1",
			threadId: "thread-1",
			gateKind: "approval",
			stage: "ralplan",
			status: "pending",
		});
	});

	test("ignores lower-generation workflow gate opened notifications", () => {
		const fixture = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-gate", seq: 94 } },
			{
				method: "gjc/workflowGate/opened",
				params: {
					threadId: "thread-1",
					gate_id: "gate-stale",
					generation: 3,
					kind: "approval",
					stage: "ralplan",
					required: true,
					type: "workflow_gate",
					created_at: "2026-07-04T00:00:00Z",
					schema_hash: "hash-new",
					schema: { type: "object" },
					context: { title: "new" },
					options: [{ label: "Proceed", value: "proceed" }],
				},
			},
			{
				method: "gjc/workflowGate/opened",
				params: {
					threadId: "thread-1",
					gate_id: "gate-stale",
					generation: 2,
					kind: "approval",
					stage: "ralplan",
					required: true,
					type: "workflow_gate",
					created_at: "2026-07-04T00:00:00Z",
					schema_hash: "hash-old",
					schema: { type: "object" },
					context: { title: "old" },
					options: [{ label: "Old", value: "old" }],
				},
			},
		] satisfies ServerNotificationEnvelope[];

		const folded = fixture.reduce(foldNotification, emptyTranscriptState());
		expect(folded.approvals[0]).toMatchObject({ id: "gate-stale", generation: 3, context: { title: "new" } });
	});

	test("known inactive thread events do not mutate the active thread turn or items", () => {
		const known = upsertThread(
			upsertThread(emptyTranscriptState(), { id: "thread-1", status: "running" }),
			{ id: "thread-2", status: "running" },
		);
		const active = upsertThread(known, { id: "thread-1", status: "running" });
		const folded = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "active-turn", seq: 100 } },
			{ method: "turn/started", params: { threadId: "thread-2", turnId: "inactive-turn", seq: 101 } },
			{ method: "item/agentMessage/delta", params: { threadId: "thread-2", itemId: "inactive-item", delta: "background", seq: 102 } },
			{ method: "turn/completed", params: { threadId: "thread-2", turnId: "inactive-turn", status: "completed", seq: 103 } },
		] satisfies ServerNotificationEnvelope[];

		const state = folded.reduce(foldNotification, active);
		expect(state.activeThreadId).toBe("thread-1");
		expect(state.activeTurnId).toBe("active-turn");
		expect(state.items).toHaveLength(0);
	});

	test("stale host URI cancel does not cancel a newer request", () => {
		const fixture = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-host-uri", seq: 110 } },
			{
				method: "gjc/hostUris/request",
				params: {
					threadId: "thread-1",
					turnId: "turn-host-uri",
					requestId: "uri-newer",
					generation: 4,
					operation: "read",
					url: "file:///tmp/new.txt",
				},
			},
			{ method: "gjc/hostUris/cancel", params: { threadId: "thread-1", turnId: "turn-host-uri", requestId: "uri-newer", generation: 3 } },
		] satisfies ServerNotificationEnvelope[];

		const folded = fixture.reduce(foldNotification, emptyTranscriptState());
		expect(folded.approvals[0]).toMatchObject({ kind: "host-uri", id: "uri-newer", generation: 4, status: "pending" });
	});

	test("optimistically marks host URI resolution", () => {
		const state = [
			{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-host-uri", seq: 93 } },
			{
				method: "gjc/hostUris/request",
				params: {
					threadId: "thread-1",
					turnId: "turn-host-uri",
					requestId: "uri-3",
					generation: 1,
					operation: "read",
					url: "file:///tmp/example.txt",
				},
			},
		] satisfies ServerNotificationEnvelope[];

		const folded = state.reduce(foldNotification, emptyTranscriptState());
		const resolved = markApproval(folded, "uri-3", "approved");
		expect(resolved.approvals[0]).toMatchObject({ kind: "host-uri", id: "uri-3", status: "approved" });
		expect(folded.approvals[0]?.status).toBe("pending");
	});
});
