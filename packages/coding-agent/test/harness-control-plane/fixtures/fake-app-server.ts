#!/usr/bin/env bun
/**
 * Minimal app-server JSON-RPC fixture — a TEST FIXTURE (never shipped).
 *
 * It speaks the app-server NDJSON handshake used by GajaeCodeAppServerRpc while
 * also emitting canonical agent-wire event frames so existing owner observation
 * tests exercise the real adapter + owner path without a live model.
 */
process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

let buffer = "";
const threadId = "fake-app-server-thread";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let idx = buffer.indexOf("\n");
	while (idx >= 0) {
		const line = buffer.slice(0, idx).trim();
		buffer = buffer.slice(idx + 1);
		if (line) handle(line);
		idx = buffer.indexOf("\n");
	}
});

function send(frame: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: unknown, result: Record<string, unknown>): void {
	send({ jsonrpc: "2.0", id, result });
}

function emitAgentEvent(event: Record<string, unknown>): void {
	// Kept in canonical event-envelope shape because RuntimeOwner consumes the
	// shared observeRpcOutboundFrame mapper until app-server notification mapping
	// is expanded in P4.
	send({ type: "event", payload: { event_type: event.type, event } });
}

function handle(line: string): void {
	let frame: { id?: string | number; method?: string; params?: Record<string, unknown> };
	try {
		frame = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> };
	} catch {
		return;
	}
	if (!frame.id && frame.method === "initialized") return;
	switch (frame.method) {
		case "initialize":
			respond(frame.id, { capabilities: {} });
			return;
		case "thread/start":
			respond(frame.id, { thread: { id: threadId } });
			return;
		case "gjc/state/read":
			respond(frame.id, { status: "idle", isStreaming: false, queuedMessageCount: 0, followupQueueDepth: 0 });
			return;
		case "gjc/messages/get":
			respond(frame.id, { messages: [{ role: "assistant", content: "APPROVE_MERGE_READY" }] });
			return;
		case "turn/start":
			respond(frame.id, { turnId: frame.params?.commandId ?? "turn-1" });
			send({
				jsonrpc: "2.0",
				method: "turn/started",
				params: { threadId, turnId: frame.params?.commandId ?? "turn-1" },
			});
			emitAgentEvent({ type: "agent_start" });
			if (process.env.GJC_FAKE_APP_SERVER_STORM === "1") {
				for (let i = 0; i < 200; i++) emitAgentEvent({ type: "message_update", message: { id: "m1" } });
			}
			emitAgentEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo hi" },
			});
			emitAgentEvent({
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { status: "running" },
			});
			emitAgentEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "hi" }], details: { status: "ok" } },
			});
			emitAgentEvent({ type: "agent_end" });
			return;
		default:
			if (frame.id) respond(frame.id, {});
	}
}

setInterval(() => {}, 1 << 30);
