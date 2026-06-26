import { describe, expect, test } from "bun:test";
import { CodecError, encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from "../src/codec";
import type { GjcFrame } from "../src/protocol";

const frame = (seq: number): GjcFrame => ({ protocolVersion: 1, frameId: `f${seq}`, sessionId: "s", seq, direction: "server_to_client", kind: "event", type: "message_update", replay: false, payload: { n: seq } });

describe("GjcFrame codec", () => {
	test("encodes u32 big-endian length prefix and decodes round-trip", () => {
		const bytes = encodeFrame(frame(1));
		expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)).toBe(bytes.byteLength - 4);
		const decoder = new FrameDecoder();
		decoder.push(bytes);
		expect(decoder.nextFrame()).toEqual(frame(1));
		expect(decoder.nextFrame()).toBeUndefined();
	});
	test("reassembles partial reads and multiple frames", () => {
		const bytes = new Uint8Array([...encodeFrame(frame(1)), ...encodeFrame(frame(2))]);
		const decoder = new FrameDecoder();
		for (const b of bytes.slice(0, 6)) decoder.push(Uint8Array.of(b));
		expect(decoder.nextFrame()).toBeUndefined();
		decoder.push(bytes.slice(6));
		expect(decoder.nextFrame()?.seq).toBe(1);
		expect(decoder.nextFrame()?.seq).toBe(2);
	});
	test("rejects oversized declared body before allocation", () => {
		const decoder = new FrameDecoder();
		const prefix = new Uint8Array(4);
		new DataView(prefix.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
		decoder.push(prefix);
		expect(() => decoder.nextFrame()).toThrow(CodecError);
	});
});
