import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { CodecError, encodeFrame, FrameDecoder } from "../codec";
import type { Cursor, GjcFrame } from "../protocol/types";

export interface UdsTransportOptions { socketPath: string; reconnectFromCursor?: (cursor: Cursor | undefined) => Promise<void> | void }
export interface UdsTransportEvents { frame: [GjcFrame<unknown>]; close: []; error: [Error] }

export class UdsTransport extends EventEmitter<UdsTransportEvents> {
	#socket: Socket | undefined;
	#decoder = new FrameDecoder();
	#cursor: Cursor | undefined;
	constructor(readonly options: UdsTransportOptions) { super(); }
	connect(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = createConnection(this.options.socketPath);
		this.#socket = socket;
		const cleanupConnect = () => { socket.off("connect", onConnect); socket.off("error", onConnectError); };
		const onConnect = () => { cleanupConnect(); resolve(); };
		const onConnectError = (error: Error) => { cleanupConnect(); reject(error); };
		socket.once("connect", onConnect);
		socket.once("error", onConnectError);
		socket.on("data", (chunk: Buffer) => this.#onData(chunk));
		socket.on("close", () => {
			if (this.#decoder.buffered() > 0) this.emit("error", new CodecError(`truncated frame: ${this.#decoder.buffered()} buffered bytes at EOF`));
			this.emit("close");
		});
		socket.on("error", (error) => this.emit("error", error));
		return promise;
	}
	write(frame: GjcFrame<unknown>): Promise<void> {
		const socket = this.#socket;
		if (!socket) return Promise.reject(new Error("UDS transport is not connected"));
		const bytes = encodeFrame(frame);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		socket.write(bytes, (error) => error ? reject(error) : resolve());
		return promise;
	}
	async reconnect(): Promise<void> { this.close(); await this.options.reconnectFromCursor?.(this.#cursor); this.#decoder = new FrameDecoder(); await this.connect(); }
	close(): void { this.#socket?.destroy(); this.#socket = undefined; }
	setCursor(cursor: Cursor | undefined): void { this.#cursor = cursor; }
	cursor(): Cursor | undefined { return this.#cursor; }
	#onData(chunk: Buffer): void {
		try {
			this.#decoder.push(chunk);
			for (;;) {
				const frame = this.#decoder.nextFrame();
				if (!frame) break;
				this.#cursor = { sessionId: frame.sessionId, seq: frame.seq };
				this.emit("frame", frame);
			}
		} catch (error) {
			const transportError = error instanceof Error ? error : new CodecError(String(error));
			this.#decoder = new FrameDecoder();
			this.emit("error", transportError);
			this.close();
		}
	}
}
export async function connectUds(options: UdsTransportOptions): Promise<UdsTransport> { const transport = new UdsTransport(options); await transport.connect(); return transport; }
