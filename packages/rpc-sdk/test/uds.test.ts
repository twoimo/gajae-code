import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { CodecError, encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from "../src/codec";
import { connectUds } from "../src/transport/uds";
import type { GjcFrame } from "../src/protocol";

let server: Server | undefined;
let socketPath = "";
afterEach(async () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	server?.close(() => resolve()) ?? resolve();
	await promise;
	if (socketPath) await unlink(socketPath).catch(() => undefined);
});

async function listen(handler: (socket: Socket) => void): Promise<void> {
	socketPath = join(tmpdir(), `gjc-rpc-sdk-${process.pid}-${Date.now()}-${Math.random()}.sock`);
	server = createServer(handler);
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(socketPath, resolve);
	await promise;
}

function echo(socket: Socket): void {
	const decoder = new FrameDecoder();
	socket.on("data", (chunk: Buffer) => {
		decoder.push(chunk);
		for (;;) {
			const frame = decoder.nextFrame();
			if (!frame) break;
			socket.write(encodeFrame({ ...frame, direction: "server_to_client", seq: frame.seq + 1 }));
		}
	});
}

async function transportErrorFromServer(writeBadFrame: (socket: Socket) => void): Promise<Error> {
	await listen((socket) => {
		writeBadFrame(socket);
		socket.end();
	});
	const transport = await connectUds({ socketPath });
	const { promise, resolve } = Promise.withResolvers<Error>();
	transport.once("error", resolve);
	return promise;
}

describe("UDS transport", () => {
	test("sends and receives framed data over a loopback Unix socket", async () => {
		await listen(echo);
		const transport = await connectUds({ socketPath });
		const { promise: received, resolve } = Promise.withResolvers<GjcFrame<unknown>>();
		transport.once("frame", resolve);
		await transport.write({ protocolVersion: 1, frameId: "f", sessionId: "s", seq: 3, direction: "client_to_server", kind: "command", type: "get_state", replay: false, payload: {} });
		expect(await received).toMatchObject({ frameId: "f", seq: 4, direction: "server_to_client" });
		transport.close();
	});

	test("emits transport error and closes on malformed frame JSON", async () => {
		const error = await transportErrorFromServer((socket) => {
			const body = Buffer.from("{not-json", "utf8");
			const prefix = Buffer.alloc(4);
			prefix.writeUInt32BE(body.byteLength, 0);
			socket.write(Buffer.concat([prefix, body]));
		});
		expect(error).toBeInstanceOf(SyntaxError);
	});

	test("emits transport error and closes on oversized declared length", async () => {
		const error = await transportErrorFromServer((socket) => {
			const prefix = Buffer.alloc(4);
			prefix.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
			socket.write(prefix);
		});
		expect(error).toBeInstanceOf(CodecError);
		expect(error.message).toContain("exceeds max");
	});

	test("emits truncated-frame error when socket closes with buffered bytes", async () => {
		const error = await transportErrorFromServer((socket) => {
			const prefix = Buffer.alloc(4);
			prefix.writeUInt32BE(100, 0);
			socket.write(Buffer.concat([prefix, Buffer.from("partial", "utf8")]));
		});
		expect(error).toBeInstanceOf(CodecError);
		expect(error.message).toContain("truncated frame");
	});
});
