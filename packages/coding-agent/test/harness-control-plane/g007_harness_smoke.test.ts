import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
import { encodeFrame, FrameDecoder, type GjcFrame } from "@gajae-code/rpc-sdk";
import { GajaeCodeDaemonRpc } from "../../src/harness-control-plane/rpc-adapter";

let server: Server | undefined;

afterEach(async () => {
	await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
	server = undefined;
});

async function listen(socketPath: string, onFrame: (socket: Socket, frame: GjcFrame<unknown>) => void): Promise<void> {
	const decoder = new FrameDecoder();
	server = createServer(socket => {
		socket.on("data", (chunk: Buffer) => {
			decoder.push(chunk);
			for (;;) {
				const frame = decoder.nextFrame();
				if (!frame) break;
				onFrame(socket, frame);
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(socketPath, () => resolve());
	});
}

function responseFor(frame: GjcFrame<unknown>, payload: Record<string, unknown>): GjcFrame<Record<string, unknown>> {
	return {
		protocolVersion: 1,
		frameId: `${frame.frameId}-response`,
		sessionId: frame.sessionId,
		seq: frame.seq + 1,
		direction: "server_to_client",
		kind: "response",
		type: "command_result",
		correlationId: frame.correlationId,
		replay: false,
		payload,
	};
}

describe("G007 harness daemon smoke", () => {
	it("g007_harness_smoke exchanges real GjcFrames over UDS through the harness adapter", async () => {
		const root = await mkdtemp(path.join("/tmp", "gjc-harness-smoke-"));
		try {
			await chmod(root, 0o700);
			const socketPath = path.join(root, "daemon.sock");
			const seen: GjcFrame<unknown>[] = [];
			await listen(socketPath, (socket, frame) => {
				seen.push(frame);
				if (frame.kind === "hello") {
					socket.write(
						encodeFrame({
							protocolVersion: 1,
							frameId: "hello_ok",
							sessionId: "",
							seq: 0,
							direction: "server_to_client",
							kind: "ready",
							type: "hello_accepted",
							replay: false,
							payload: { sessions: 1 },
						}),
					);
					return;
				}
				if (frame.kind === "command" && frame.type === "get_state") {
					socket.write(
						encodeFrame(
							responseFor(frame, {
								success: true,
								data: { isStreaming: false, queuedMessageCount: 2, followupQueueDepth: 1 },
							}),
						),
					);
					return;
				}
				socket.write(encodeFrame(responseFor(frame, { success: true, command: frame.type })));
			});

			const rpc = new GajaeCodeDaemonRpc({ socketPath, sessionId: "harness-smoke-session" });
			await rpc.connect();
			const state = await rpc.getState();
			const prompt = await rpc.sendPrompt("harness smoke");
			await rpc.close();

			expect(state).toEqual({ isStreaming: false, steeringQueueDepth: 2, followupQueueDepth: 1 });
			expect(prompt.ack).toBe(true);
			expect(seen[0]).toMatchObject({
				protocolVersion: 1,
				direction: "client_to_server",
				kind: "hello",
				type: "hello",
			});
			expect(seen[1]).toMatchObject({
				protocolVersion: 1,
				direction: "client_to_server",
				kind: "command",
				type: "get_state",
				sessionId: "harness-smoke-session",
			});
			expect(seen[2]).toMatchObject({
				protocolVersion: 1,
				direction: "client_to_server",
				kind: "command",
				type: "prompt",
				sessionId: "harness-smoke-session",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
