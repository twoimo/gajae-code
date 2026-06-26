import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
import { encodeFrame, FrameDecoder, type GjcFrame } from "@gajae-code/rpc-sdk";
import { BridgeDaemonClient, ReferenceBridgeConsumer } from "../src";

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

function commandFrame(sessionId: string): GjcFrame {
	return {
		protocolVersion: 1,
		frameId: "bridge-smoke-command",
		sessionId,
		seq: 1,
		direction: "client_to_server",
		kind: "command",
		type: "prompt",
		correlationId: "bridge-smoke-correlation",
		replay: false,
		capabilityScope: "control",
		payload: { message: "bridge smoke" },
	};
}

describe("G007 bridge daemon smoke", () => {
	it("g007_bridge_smoke exchanges real GjcFrames over UDS through bridge-client", async () => {
		const root = await mkdtemp(path.join("/tmp", "gjc-bridge-smoke-"));
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
				socket.write(
					encodeFrame({
						protocolVersion: 1,
						frameId: "bridge-smoke-response",
						sessionId: frame.sessionId,
						seq: frame.seq + 1,
						direction: "server_to_client",
						kind: "response",
						type: "command_result",
						correlationId: frame.correlationId,
						replay: false,
						payload: { command: frame.type, success: true },
					}),
				);
			});

			const client = new BridgeDaemonClient({ socketPath, sessions: ["bridge-smoke-session"] });
			const ready = await client.connect();
			expect(ready).toMatchObject({
				protocolVersion: 1,
				direction: "server_to_client",
				kind: "ready",
				type: "hello_accepted",
			});

			await client.write(commandFrame("bridge-smoke-session"));
			const response = await client.nextFrame();
			client.close();

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
				type: "prompt",
			});
			expect(response).toMatchObject({
				protocolVersion: 1,
				direction: "server_to_client",
				kind: "response",
				type: "command_result",
			});
			expect(response.sessionId).toBe("bridge-smoke-session");
			expect(response.correlationId).toBe("bridge-smoke-correlation");
			const consumer = new ReferenceBridgeConsumer();
			const rendered = consumer.consume(response);
			expect(rendered.html).toContain("command_result");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
