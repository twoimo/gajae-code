import type { GjcFrame } from "./protocol/types";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export class CodecError extends Error { constructor(message: string) { super(message); this.name = "CodecError"; } }

export function encodeFrame(frame: GjcFrame<unknown>): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(frame));
	if (body.byteLength > MAX_FRAME_BYTES) throw new CodecError(`frame length ${body.byteLength} exceeds max ${MAX_FRAME_BYTES}`);
	const out = new Uint8Array(4 + body.byteLength);
	new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, body.byteLength, false);
	out.set(body, 4);
	return out;
}

export class FrameDecoder {
	#buffer = new Uint8Array(0);
	push(bytes: Uint8Array): void { const next = new Uint8Array(this.#buffer.byteLength + bytes.byteLength); next.set(this.#buffer); next.set(bytes, this.#buffer.byteLength); this.#buffer = next; }
	nextFrame(): GjcFrame<unknown> | undefined {
		if (this.#buffer.byteLength < 4) return undefined;
		const declared = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength).getUint32(0, false);
		if (declared > MAX_FRAME_BYTES) throw new CodecError(`frame length ${declared} exceeds max ${MAX_FRAME_BYTES}`);
		if (this.#buffer.byteLength < 4 + declared) return undefined;
		const body = this.#buffer.slice(4, 4 + declared);
		this.#buffer = this.#buffer.slice(4 + declared);
		const decoded = JSON.parse(new TextDecoder().decode(body)) as GjcFrame;
		return decoded;
	}
	buffered(): number { return this.#buffer.byteLength; }
}
