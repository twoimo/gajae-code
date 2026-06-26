import { describe, expect, test } from "bun:test";
import { buildCommandFrame, commandLane, commandScope, commands } from "../src/commands/builders";
import { cursorAfter, reconnectFromCursor, rememberReplayCursor } from "../src/replay";
import { hostToolDefinition, hostToolResultFrame } from "../src/primitives/host-tool";
import { hostUriResultFrame, hostUriScheme } from "../src/primitives/host-uri";
import { notificationFrame, notificationReplyFrame } from "../src/primitives/notification";
import { workflowGate, workflowGateResponseFrame } from "../src/primitives/workflow-gate";
import type { Cursor } from "../src/protocol";
import type { UdsTransport } from "../src/transport/uds";

describe("command and primitive builders", () => {
	test("classifies command lanes from generated manifest", () => {
		expect(commandLane("abort")).toBe("fast_lane_cancellation");
		expect(commandLane("get_state")).toBe("fast_lane_safe_read");
		expect(commands.prompt("hi", "c1")).toMatchObject({ type: "prompt", lane: "ordered", payload: { message: "hi" } });
	});
	test("builds command frames with lane-derived scopes", () => {
		const readFrame = buildCommandFrame("get_state", { sessionId: "s", commandId: "c", payload: {} });
		expect(commandScope("get_state")).toBe("read");
		expect(readFrame).toMatchObject({ kind: "command", type: "get_state", capabilityScope: "read", correlationId: "c" });
		expect(buildCommandFrame("prompt", { sessionId: "s", payload: { message: "hi" } })).toMatchObject({ type: "prompt", capabilityScope: "control" });
	});
	test("tracks replay cursors without emitting replay_from commands", async () => {
		const frame = buildCommandFrame("get_state", { sessionId: "s", commandId: "c", payload: {}, seq: 9 });
		expect(cursorAfter(frame)).toEqual({ sessionId: "s", seq: 9 });
		expect(rememberReplayCursor({ sessionId: "s", seq: 12 }, frame)).toEqual({ sessionId: "s", seq: 12 });
		const calls: Cursor[] = [];
		const transport = { setCursor: (cursor: Cursor | undefined) => { if (cursor) calls.push(cursor); }, reconnect: async () => undefined } as unknown as UdsTransport;
		await reconnectFromCursor(transport, { sessionId: "s", seq: 9 });
		expect(calls).toEqual([{ sessionId: "s", seq: 9 }]);
	});
	test("builds workflow, host tool, host URI, and notification primitives", () => {
		expect(workflowGate("g", "Approve?")).toEqual({ gateId: "g", prompt: "Approve?" });
		expect(workflowGateResponseFrame("s", "g", "yes")).toMatchObject({ capabilityScope: "gate_answer" });
		expect(hostToolDefinition("t", "desc")).toEqual({ name: "t", description: "desc" });
		expect(hostToolResultFrame("s", "call", { ok: true })).toMatchObject({ capabilityScope: "host_tool_result" });
		expect(hostUriScheme("vscode", "Open editor")).toEqual({ scheme: "vscode", description: "Open editor" });
		expect(hostUriResultFrame("s", "r", "vscode://file", true)).toMatchObject({ capabilityScope: "host_uri_result" });
		expect(notificationFrame("s", "turn_stream", { text: "x" })).toMatchObject({ kind: "notification", direction: "server_to_client" });
		expect(notificationReplyFrame("s", "a", { value: "ok" })).toMatchObject({ type: "reply", capabilityScope: "gate_answer" });
	});
});
