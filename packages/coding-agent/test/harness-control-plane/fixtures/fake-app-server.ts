#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

/**
 * Minimal app-server JSON-RPC fixture — a TEST FIXTURE (never shipped).
 *
 * It speaks the app-server NDJSON handshake used by GajaeCodeAppServerRpc while
 * emitting method-shaped app-server JSON-RPC notifications so owner observation
 * tests exercise the real adapter + owner path without a live model.
 */

let buffer = "";
const threadId = "fake-app-server-thread";
const tracePath = process.env.GJC_FAKE_APP_SERVER_TRACE;

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

function trace(direction: "in" | "out", frame: Record<string, unknown>): void {
	if (!tracePath) return;
	appendFileSync(tracePath, `${JSON.stringify({ direction, frame })}\n`, "utf8");
}

function send(frame: Record<string, unknown>): void {
	trace("out", frame);
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}
send({ type: "ready" });

function respond(id: unknown, result: Record<string, unknown>): void {
	send({ jsonrpc: "2.0", id, result });
}

function emitAppServerEvent(event: Record<string, unknown>): void {
	send({ jsonrpc: "2.0", method: "gjc/event", params: { eventType: event.type, event } });
}

function handle(line: string): void {
	let frame: { id?: string | number; method?: string; params?: Record<string, unknown> };
	try {
		frame = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> };
	} catch {
		return;
	}
	trace("in", frame as unknown as Record<string, unknown>);
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
			emitAppServerEvent({ type: "agent_start" });
			if (process.env.GJC_FAKE_APP_SERVER_STORM === "1") {
				for (let i = 0; i < 200; i++) emitAppServerEvent({ type: "message_update", message: { id: "m1" } });
			}
			send({
				jsonrpc: "2.0",
				method: "item/started",
				params: { itemId: "item-t1", itemType: "toolCall", toolName: "read" },
			});
			send({
				jsonrpc: "2.0",
				method: "item/updated",
				params: { itemId: "item-t1", itemType: "toolCall", status: "running", raw: "SECRET_ITEM_UPDATE" },
			});
			send({
				jsonrpc: "2.0",
				method: "item/completed",
				params: {
					itemId: "item-t1",
					itemType: "toolCall",
					toolName: "read",
					status: "ok",
					raw: "SECRET_ITEM_DONE",
				},
			});
			emitAppServerEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo SECRET_COMMAND" },
			});
			emitAppServerEvent({
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo SECRET_COMMAND" },
				partialResult: { status: "running", content: "SECRET_PARTIAL" },
			});
			emitAppServerEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "SECRET_OUTPUT" }], details: { status: "ok" } },
			});
			emitAppServerEvent({ type: "agent_end" });
			send({
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { threadId, turnId: frame.params?.commandId ?? "turn-1", status: "completed" },
			});
			return;
		default:
			if (frame.id) respond(frame.id, {});
	}
}

setInterval(() => {}, 1 << 30);
