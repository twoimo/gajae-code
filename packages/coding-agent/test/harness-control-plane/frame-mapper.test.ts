import { describe, expect, it } from "bun:test";
import {
	isTestRunnerTool,
	observeRpcOutboundFrame as mapRpcFrame,
} from "../../src/modes/shared/agent-wire/event-observation";

/**
 * Wrap an AgentSessionEvent in the canonical agent-wire `event` frame, mirroring
 * what `gjc --mode rpc` now emits on stdout. Non-event frames (ready/response/
 * extension_error/host_*) stay flat and are passed directly.
 */
function evt(event: Record<string, unknown>): Record<string, unknown> {
	return { type: "event", payload: { event_type: event.type, event } };
}

describe("mapRpcFrame (canonical observeRpcOutboundFrame)", () => {
	it("ignores ready/response and unknown frames (adapter handles those)", () => {
		expect(mapRpcFrame({ type: "ready" })).toBeNull();
		expect(mapRpcFrame({ type: "response", id: "x", success: true })).toBeNull();
		expect(mapRpcFrame({ type: "totally_unknown" })).toBeNull();
		expect(mapRpcFrame({})).toBeNull();
		// A raw (unwrapped) session event is NOT a valid frame anymore.
		expect(mapRpcFrame({ type: "agent_start" })).toBeNull();
	});

	it("maps semantic lifecycle frames with never-drop flag", () => {
		expect(mapRpcFrame(evt({ type: "agent_start" }))).toMatchObject({
			kind: "agent_wire_agent_started",
			signal: "SessionStart",
			semantic: true,
		});
		// Real agent_end carries no failure field; it always maps to completed.
		expect(mapRpcFrame(evt({ type: "agent_end", stopReason: "completed", messages: [] }))).toMatchObject({
			kind: "agent_wire_agent_completed",
			signal: "completed",
			semantic: true,
		});
		// extension_error is a flat non-event control frame.
		expect(mapRpcFrame({ type: "extension_error", error: "boom", extensionPath: "/x", event: "run" })).toMatchObject({
			kind: "agent_wire_extension_error",
			signal: "error",
			semantic: true,
		});
	});

	it("maps real tool execution frames to tool-call, test-running, and error status", () => {
		const start = mapRpcFrame(
			evt({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "bun test foo" } }),
		);
		expect(start).toMatchObject({ kind: "agent_wire_tool_started", signal: "test-running", semantic: true });
		const plain = mapRpcFrame(evt({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} }));
		expect(plain).toMatchObject({ signal: "tool-call", semantic: true });
		const end = mapRpcFrame(
			evt({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", result: { details: { status: "ok" } } }),
		);
		expect(end).toMatchObject({ kind: "agent_wire_tool_ended", signal: "tool-call", semantic: true });
		// tool_execution_end has no args field, so test-detection falls back to the
		// tool name; a failed bash end is tool-call + warn + error status.
		const failed = mapRpcFrame(
			evt({
				type: "tool_execution_end",
				toolCallId: "t3",
				toolName: "bash",
				result: { content: [{ type: "text", text: "failure output" }] },
				isError: true,
			}),
		);
		expect(failed).toMatchObject({ signal: "tool-call", severity: "warn", evidence: { status: "error" } });
	});

	it("marks message_update + tool_execution_update as coalescible (non-semantic) with keys", () => {
		const m = mapRpcFrame(evt({ type: "message_update", message: { id: "m1" } }));
		expect(m).toMatchObject({ signal: null, semantic: false, coalesceKey: "message:m1" });
		const u = mapRpcFrame(
			evt({
				type: "tool_execution_update",
				toolCallId: "t9",
				toolName: "bash",
				args: { command: "bun test SECRET_COMMAND" },
				partialResult: { status: "running", content: [{ type: "text", text: "SECRET_UPDATE" }] },
			}),
		);
		expect(u).toMatchObject({
			kind: "agent_wire_tool_updated",
			signal: "test-running",
			evidence: { toolId: "t9", status: "running" },
			severity: "info",
			semantic: false,
			coalesceKey: "tool:t9",
		});
		expect(JSON.stringify(u)).not.toContain("SECRET_COMMAND");
		expect(JSON.stringify(u)).not.toContain("SECRET_UPDATE");
	});

	it("redacts: evidence carries no assistant text / message deltas / command output", () => {
		const m = mapRpcFrame(
			evt({
				type: "message_update",
				message: { id: "m1", content: [{ type: "text", text: "secret assistant text" }] },
				assistantMessageEvent: { type: "text_delta", delta: "secret assistant text" },
			}),
		) ?? { evidence: {} };
		const json = JSON.stringify(m.evidence);
		expect(json).not.toContain("secret assistant text");
		const t = mapRpcFrame(
			evt({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "SECRET OUTPUT" }], details: { status: "ok" } },
			}),
		) ?? { evidence: {} };
		const tj = JSON.stringify(t.evidence);
		expect(tj).not.toContain("SECRET OUTPUT");
	});

	it("does not persist arbitrary tool-result status text", () => {
		const mapped = mapRpcFrame(
			evt({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: { details: { status: "SECRET_STATUS_OUTPUT" } },
			}),
		);
		expect(JSON.stringify(mapped?.evidence)).not.toContain("SECRET_STATUS_OUTPUT");
		expect(mapped).toMatchObject({ evidence: { status: null } });
	});

	it("redacts extension_error free-text message from evidence", () => {
		const big = "x".repeat(5000);
		const e = mapRpcFrame({ type: "extension_error", error: big, extensionPath: "/x", event: "run" });
		// The free-text error message is dropped entirely; only bounded identifiers remain.
		expect(JSON.stringify(e?.evidence)).not.toContain("xxxx");
		expect(e?.evidence).toMatchObject({ extensionPath: "/x", event: "run" });
	});

	it("maps app-server method-shaped notifications", () => {
		expect(mapRpcFrame({ jsonrpc: "2.0", method: "turn/started", params: { turnId: "turn-1" } })).toMatchObject({
			frameType: "turn/started",
			kind: "agent_wire_turn_started",
			signal: "prompt-accepted",
			semantic: true,
			evidence: { turnId: "turn-1" },
		});

		expect(
			mapRpcFrame({
				jsonrpc: "2.0",
				method: "gjc/event",
				params: {
					eventType: "tool_execution_start",
					event: { toolCallId: "tool-1", toolName: "bash", args: { command: "bun test x" } },
				},
			}),
		).toMatchObject({
			eventType: "tool_execution_start",
			kind: "agent_wire_tool_started",
			signal: "test-running",
			semantic: true,
			evidence: { toolId: "tool-1", toolName: "bash" },
		});

		expect(
			mapRpcFrame({
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { turnId: "turn-1", status: "completed" },
			}),
		).toMatchObject({
			frameType: "turn/completed",
			kind: "agent_wire_agent_completed",
			signal: "completed",
			semantic: true,
			evidence: { stopReason: "completed" },
		});

		expect(
			mapRpcFrame({
				jsonrpc: "2.0",
				method: "gjc/event",
				params: { eventType: "agent_start", event: { type: "agent_start", raw: "SECRET_AGENT_START" } },
			}),
		).toMatchObject({
			eventType: "agent_start",
			kind: "agent_wire_agent_started",
			signal: "SessionStart",
			semantic: true,
		});

		expect(
			mapRpcFrame({
				jsonrpc: "2.0",
				method: "item/started",
				params: { itemId: "item-1", itemType: "toolCall", toolName: "read", raw: "SECRET_ITEM_START" },
			}),
		).toMatchObject({
			frameType: "item/started",
			kind: "agent_wire_tool_started",
			signal: "tool-call",
			semantic: true,
			evidence: { toolId: "item-1", toolName: "read" },
		});

		expect(
			mapRpcFrame({
				jsonrpc: "2.0",
				method: "item/updated",
				params: { itemId: "item-1", itemType: "toolCall", status: "running", raw: "SECRET_ITEM_UPDATE" },
			}),
		).toMatchObject({
			frameType: "item/updated",
			kind: "agent_wire_tool_updated",
			semantic: false,
			coalesceKey: "tool:item-1",
			evidence: { toolId: "item-1", status: "running" },
		});

		expect(
			mapRpcFrame({
				jsonrpc: "2.0",
				method: "item/completed",
				params: { itemId: "item-1", itemType: "toolCall", toolName: "read", status: "ok", raw: "SECRET_ITEM_DONE" },
			}),
		).toMatchObject({
			frameType: "item/completed",
			kind: "agent_wire_tool_ended",
			signal: "tool-call",
			semantic: true,
			evidence: { toolId: "item-1", toolName: "read", status: "ok" },
		});

		expect(
			mapRpcFrame({
				jsonrpc: "2.0",
				method: "gjc/event",
				params: {
					eventType: "agent_end",
					event: { type: "agent_end", stopReason: "completed", raw: "SECRET_END" },
				},
			}),
		).toMatchObject({
			eventType: "agent_end",
			kind: "agent_wire_agent_completed",
			signal: "completed",
			semantic: true,
		});

		expect(
			JSON.stringify(
				mapRpcFrame({
					jsonrpc: "2.0",
					method: "gjc/event",
					params: {
						eventType: "tool_execution_end",
						event: {
							type: "tool_execution_end",
							toolCallId: "secret-tool",
							toolName: "bash",
							result: { content: [{ type: "text", text: "SECRET_OUTPUT" }], details: { status: "ok" } },
						},
					},
				})?.evidence,
			),
		).not.toContain("SECRET_OUTPUT");
	});
	it("isTestRunnerTool detects common runners", () => {
		expect(isTestRunnerTool("bash", "bun test x")).toBe(true);
		expect(isTestRunnerTool("bash", "vitest run")).toBe(true);
		expect(isTestRunnerTool("bash", "echo hi")).toBe(false);
		expect(isTestRunnerTool("read", "")).toBe(false);
	});
});
