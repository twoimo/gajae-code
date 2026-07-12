import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
	AGENT_WIRE_EVENT_TYPES,
	AGENT_WIRE_PROTOCOL_VERSION,
	type AgentWireEventFrame,
	type AgentWireEventType,
} from "../../src/modes/shared/agent-wire/event-contract";
import type { AgentSessionEvent } from "../../src/session/agent-session";

const fixturePath = path.resolve(import.meta.dir, "../../../../crates/git-daemon/tests/fixtures/paused-run.jsonl");
const sessionId = "paused-fixture-session";

const pausedAssistant = {
	role: "assistant",
	content: [{ type: "text", text: "Paused fixture response." }],
	api: "openai-responses",
	provider: "fixture",
	model: "fixture-model",
	usage: {
		input: 10,
		output: 7,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 17,
		cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
	},
	stopReason: "stop",
	timestamp: 0,
} satisfies Extract<AgentSessionEvent, { type: "message_end" }>["message"];

const pausedEvents = [
	{ type: "agent_start" },
	{ type: "message_start", message: pausedAssistant },
	{
		type: "message_update",
		message: pausedAssistant,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "Paused fixture response.",
			partial: pausedAssistant,
		},
	},
	{ type: "message_end", message: pausedAssistant },
	{ type: "agent_end", messages: [], stopReason: "paused" },
] satisfies readonly AgentSessionEvent[];

const typedFrames: readonly AgentWireEventFrame[] = pausedEvents.map((event, index) => ({
	protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
	session_id: sessionId,
	seq: index + 1,
	frame_id: `paused-000${index + 1}`,
	type: "event",
	payload: { event_type: event.type, event },
}));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPausedAgentSessionEvent(
	value: unknown,
	eventType: AgentWireEventType,
): asserts value is AgentSessionEvent {
	expect(isRecord(value), "event must be an object").toBe(true);
	if (!isRecord(value)) throw new Error("event must be an object");
	expect(value.type).toBe(eventType);

	switch (eventType) {
		case "agent_start":
			return;
		case "message_start":
		case "message_end":
			expect(value.message).toEqual(pausedAssistant);
			return;
		case "message_update":
			expect(value.message).toEqual(pausedAssistant);
			expect(value.assistantMessageEvent).toEqual({
				type: "text_delta",
				contentIndex: 0,
				delta: "Paused fixture response.",
				partial: pausedAssistant,
			});
			return;
		case "agent_end":
			expect(value).toEqual({ type: "agent_end", messages: [], stopReason: "paused" });
			return;
		default:
			throw new Error(`fixture contains unexpected event type: ${eventType}`);
	}
}

function assertCanonicalEventFrame(
	value: unknown,
	expected: AgentWireEventFrame,
): asserts value is AgentWireEventFrame {
	expect(isRecord(value), "frame must be an object").toBe(true);
	if (!isRecord(value)) throw new Error("frame must be an object");
	expect(Object.keys(value).sort()).toEqual(["frame_id", "payload", "protocol_version", "seq", "session_id", "type"]);
	expect(value.protocol_version).toBe(AGENT_WIRE_PROTOCOL_VERSION);
	expect(value.session_id).toBe(sessionId);
	expect(value.seq).toBe(expected.seq);
	expect(value.frame_id).toBe(expected.frame_id);
	expect(value.type).toBe("event");
	expect(isRecord(value.payload), "event payload must be an object").toBe(true);
	if (!isRecord(value.payload)) throw new Error("event payload must be an object");

	const eventType = value.payload.event_type;
	expect(typeof eventType).toBe("string");
	expect(AGENT_WIRE_EVENT_TYPES).toContain(eventType as AgentWireEventType);
	expect(eventType).toBe(expected.payload.event_type);
	assertPausedAgentSessionEvent(value.payload.event, eventType as AgentWireEventType);
	expect(value).toEqual(expected as unknown as Record<string, unknown>);
}

describe("git-daemon paused-run canonical agent-wire fixture", () => {
	it("is a typed, runtime-validated paused terminal sequence", async () => {
		const lines = (await readFile(fixturePath, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as unknown);

		expect(lines).toHaveLength(typedFrames.length + 1);
		expect(lines[0]).toEqual({ type: "ready" });
		for (const [index, frame] of typedFrames.entries()) {
			assertCanonicalEventFrame(lines[index + 1], frame);
		}

		const eventFrames = lines.slice(1) as AgentWireEventFrame[];
		expect(eventFrames.map(frame => frame.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(eventFrames.map(frame => frame.payload.event_type)).toEqual([
			"agent_start",
			"message_start",
			"message_update",
			"message_end",
			"agent_end",
		]);
		expect(eventFrames.at(-1)?.payload.event).toMatchObject({ type: "agent_end", stopReason: "paused" });
	});
});
