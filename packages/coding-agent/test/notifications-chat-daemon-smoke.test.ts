import { afterEach, describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder, type GjcFrame } from "@gajae-code/rpc-sdk";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { connectDaemonChatPresentation, createDiscordAdapter } from "../src/notifications/chat-adapters";
import { buildActionMessage } from "../src/notifications/telegram-reference";

let server: Server | undefined;
let socketPath = "";
const sockets = new Set<Socket>();

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	const { promise, resolve } = Promise.withResolvers<void>();
	server?.close(() => resolve()) ?? resolve();
	await promise;
	server = undefined;
	if (socketPath) await unlink(socketPath).catch(() => undefined);
});

function serverFrame(
	frame: Omit<GjcFrame<Record<string, unknown>>, "protocolVersion" | "seq" | "direction" | "replay">,
): GjcFrame<Record<string, unknown>> {
	return { protocolVersion: 1, seq: 1, direction: "server_to_client", replay: false, ...frame };
}

async function listen(handler: (socket: Socket) => void): Promise<void> {
	socketPath = join(tmpdir(), `gjc-chat-smoke-${process.pid}-${Date.now()}-${Math.random()}.sock`);
	server = createServer(handler);
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(socketPath, resolve);
	await promise;
}

describe("daemon-backed chat notification transport", () => {
	test("chat client subscribes over UDS, renders action_needed, and maps inbound reply into a GjcFrame", async () => {
		const received: GjcFrame<unknown>[] = [];
		await listen(socket => {
			const decoder = new FrameDecoder();
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("data", (chunk: Buffer) => {
				decoder.push(chunk);
				for (;;) {
					const frame = decoder.nextFrame();
					if (!frame) break;
					received.push(frame);
					if (frame.kind === "hello") {
						socket.write(
							encodeFrame(
								serverFrame({
									frameId: "hello-ok",
									sessionId: "",
									kind: "ready",
									type: "hello_accepted",
									payload: { sessions: 1 },
								}),
							),
						);
						setTimeout(() => {
							socket.write(
								encodeFrame(
									serverFrame({
										frameId: "action-1",
										sessionId: "chat-session",
										kind: "notification",
										type: "action_needed",
										correlationId: "ask-1",
										payload: { id: "ask-1", kind: "ask", question: "Ship it?", options: ["Yes", "No"] },
									}),
								),
							);
						}, 1);
					}
				}
			});
		});

		const delivered: unknown[] = [];
		const rendered = Promise.withResolvers<void>();
		const client = await connectDaemonChatPresentation({
			socketPath,
			sessions: ["chat-session"],
			redaction: "full",
			adapters: [createDiscordAdapter({ channelId: "discord-channel" })],
			deliver(payload) {
				delivered.push(payload);
				rendered.resolve();
			},
		});
		await rendered.promise;

		expect(received[0]).toMatchObject({ kind: "hello", type: "hello" });
		expect(delivered).toEqual([
			expect.objectContaining({
				adapter: "discord",
				channelKey: "discord-channel",
				route: { sessionId: "chat-session", actionId: "ask-1" },
				body: expect.objectContaining({ content: expect.stringContaining("Ship it?") }),
			}),
		]);
		expect(
			buildActionMessage({ kind: "ask", id: "ask-1", question: "Ship it?", options: ["Yes", "No"] }).inline_keyboard,
		).toBeDefined();

		expect(await client.mapInbound("discord", { sessionId: "chat-session", actionId: "ask-1", answer: 0 })).toBe(
			true,
		);
		const reply = await new Promise<GjcFrame<unknown>>(resolve => {
			const wait = () => {
				const found = received.find(frame => frame.kind === "notification" && frame.type === "reply");
				if (found) resolve(found);
				else setTimeout(wait, 1);
			};
			wait();
		});
		expect(reply).toMatchObject({
			direction: "client_to_server",
			kind: "notification",
			type: "reply",
			sessionId: "chat-session",
			correlationId: "ask-1",
			capabilityScope: "gate_answer",
			payload: { actionId: "ask-1", answer: { value: 0 } },
		});
		client.close();
	});
});
