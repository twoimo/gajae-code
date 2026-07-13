import { describe, expect, it } from "bun:test";
import {
	CONTROL_NONCE_BYTES,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_REQUEST_END_MARKER,
	ControlFrameDecoder,
	type ControlHello,
	ControlProtocolError,
	type ControlRequest,
	controlTokenFingerprint,
	createControlProof,
	decodeControlChallengeFrame,
	decodeControlHelloFrame,
	decodeControlProofFrame,
	decodeControlRequestCandidateEnvelopeFrame,
	decodeControlRequestCandidateFrame,
	decodeControlWriteRequest,
	decodeSingleControlRequest,
	encodeControlFrame,
	generateControlChallenge,
	generateControlToken,
	MAX_CONTROL_ENDPOINT_LENGTH,
	MAX_CONTROL_FRAME_BYTES,
	MAX_CONTROL_REQUEST_ID_LENGTH,
	MAX_CONTROL_STREAM_BYTES,
	MAX_CONTROL_TERMINAL_DIMENSION,
	MAX_CONTROL_WRITE_BYTES,
	parseControlRequest,
	parseControlRequestCandidate,
	parseControlResponse,
	verifyControlChallenge,
	verifyControlProof,
	verifyControlToken,
	withoutControlToken,
} from "./control-protocol";

const request: ControlRequest = {
	version: CONTROL_PROTOCOL_VERSION,
	id: "request-1",
	action: "write",
	generation: "generation-1",
	token: "a".repeat(64),
	data: { text: "in memory only" },
};
function encodeRawFrame(body: Uint8Array): Buffer {
	const frame = Buffer.allocUnsafe(body.length + 4);
	frame.writeUInt32BE(body.length, 0);
	frame.set(body, 4);
	return frame;
}
function encodeRawControlRequest(value: unknown): Buffer {
	const serialized = JSON.stringify(value);
	if (typeof serialized !== "string") throw new Error("invalid_raw_control_request");
	return encodeRawFrame(Buffer.from(serialized, "utf8"));
}

function expectControlProtocolError(callback: () => unknown, code: ControlProtocolError["code"]): void {
	try {
		callback();
	} catch (error) {
		expect(error).toBeInstanceOf(ControlProtocolError);
		expect(error).toMatchObject({ code });
		return;
	}
	throw new Error(`Expected control protocol error: ${code}`);
}

describe("visible session control protocol", () => {
	it("decodes split and coalesced token-free request frames", () => {
		const candidate = withoutControlToken(request);
		const encoded = encodeControlFrame(candidate);
		const decoder = new ControlFrameDecoder();
		expect(decoder.push(encoded.subarray(0, 3))).toEqual([]);
		expect(decodeControlRequestCandidateFrame(decoder.push(encoded.subarray(3))[0])).toEqual(candidate);
		const second = { ...candidate, id: "request-2" };
		const combined = Buffer.concat([encoded, encodeControlFrame(second)]);
		expect(new ControlFrameDecoder().push(combined)).toHaveLength(2);
		expect(() => encodeControlFrame(request)).toThrow(ControlProtocolError);
	});
	it("retains a structural request identity until action data is authenticated and validated", () => {
		const structural = {
			...withoutControlToken(request),
			action: "resize" as const,
			data: { columns: MAX_CONTROL_TERMINAL_DIMENSION + 1, rows: 1 },
		};
		const frame = encodeRawControlRequest(structural);
		expect(decodeControlRequestCandidateEnvelopeFrame(frame.subarray(4))).toEqual(structural);
		expectControlProtocolError(() => decodeControlRequestCandidateFrame(frame.subarray(4)), "bad_request");
	});
	it("authenticates the bounded mutual transcript without serializing tokens", () => {
		const endpoint = "\\\\.\\pipe\\gjc-visible-control-v2-example";
		const hello: ControlHello = {
			version: CONTROL_PROTOCOL_VERSION,
			type: "hello" as const,
			nonce: "1".repeat(CONTROL_NONCE_BYTES * 2),
		};
		const helloFrame = encodeControlFrame(hello);
		const challenge = generateControlChallenge(request.token, endpoint, request.generation, hello);
		const challengeFrame = encodeControlFrame(challenge);
		const candidate = withoutControlToken(request);
		const requestFrame = encodeControlFrame(candidate);
		const proof = createControlProof(request.token, helloFrame, challengeFrame, requestFrame);
		const serialized = Buffer.concat([helloFrame, challengeFrame, requestFrame, encodeControlFrame(proof)]).toString(
			"utf8",
		);

		expect(serialized).not.toContain(request.token);
		expect(decodeControlHelloFrame(helloFrame.subarray(4))).toEqual(hello);
		expect(decodeControlRequestCandidateFrame(requestFrame.subarray(4))).toEqual(candidate);
		expect(decodeControlChallengeFrame(challengeFrame.subarray(4))).toEqual(challenge);
		expect(decodeControlProofFrame(encodeControlFrame(proof).subarray(4))).toEqual(proof);
		expect(verifyControlChallenge(request.token, endpoint, request.generation, hello, challenge)).toBe(true);
		expect(verifyControlProof(request.token, helloFrame, challengeFrame, requestFrame, proof)).toBe(true);

		const replayHello = encodeControlFrame({
			...hello,
			nonce: Buffer.alloc(CONTROL_NONCE_BYTES, 2).toString("hex"),
		});
		const reorderedRequest = encodeRawFrame(
			Buffer.from(
				JSON.stringify({
					version: candidate.version,
					generation: candidate.generation,
					id: candidate.id,
					action: candidate.action,
					data: candidate.data,
				}),
				"utf8",
			),
		);
		expect(verifyControlChallenge("b".repeat(64), endpoint, request.generation, hello, challenge)).toBe(false);
		expect(
			verifyControlChallenge(request.token, endpoint, request.generation, hello, {
				...challenge,
				proof: "b".repeat(64),
			}),
		).toBe(false);
		expect(verifyControlChallenge(request.token, endpoint, "generation-2", hello, challenge)).toBe(false);
		expect(verifyControlProof(request.token, replayHello, challengeFrame, requestFrame, proof)).toBe(false);
		expect(verifyControlProof(request.token, helloFrame, challengeFrame, reorderedRequest, proof)).toBe(false);
		expect(verifyControlProof(request.token, helloFrame, requestFrame, challengeFrame, proof)).toBe(false);
		expect(
			verifyControlProof(request.token, helloFrame, challengeFrame, requestFrame, {
				...proof,
				proof: "b".repeat(64),
			}),
		).toBe(false);
		expectControlProtocolError(
			() => parseControlRequestCandidate({ ...candidate, token: request.token }),
			"bad_request",
		);
		expectControlProtocolError(
			() =>
				decodeControlChallengeFrame(
					encodeRawFrame(Buffer.from(JSON.stringify({ ...challenge, nonce: "a".repeat(63) }))).subarray(4),
				),
			"bad_frame",
		);
		expectControlProtocolError(
			() =>
				decodeControlChallengeFrame(
					encodeRawFrame(
						Buffer.from(
							JSON.stringify({ ...challenge, endpoint: "x".repeat(MAX_CONTROL_ENDPOINT_LENGTH + 1) }),
							"utf8",
						),
					).subarray(4),
				),
			"bad_frame",
		);
	});

	it("rejects hostile sizes, malformed UTF-8, unknown fields, and extra frames", () => {
		const oversized = Buffer.alloc(4);
		oversized.writeUInt32BE(MAX_CONTROL_FRAME_BYTES + 1, 0);
		expect(() => new ControlFrameDecoder().push(oversized)).toThrow(ControlProtocolError);
		expect(() => new ControlFrameDecoder().push(Buffer.alloc(4))).toThrow(ControlProtocolError);
		const malformed = Buffer.from([0, 0, 0, 1, 0xff]);
		expect(() => decodeSingleControlRequest(malformed)).toThrow(ControlProtocolError);
		expect(() => decodeSingleControlRequest(Buffer.alloc(4))).toThrow(ControlProtocolError);
		expect(() => decodeSingleControlRequest(encodeRawControlRequest({ ...request, version: 1 }))).toThrow(
			ControlProtocolError,
		);
		expect(() => decodeSingleControlRequest(encodeRawControlRequest({ ...request, action: "unknown" }))).toThrow(
			ControlProtocolError,
		);
		const unknown = encodeRawControlRequest({ ...request, unexpected: true });
		expect(() => decodeSingleControlRequest(unknown)).toThrow(ControlProtocolError);
		expect(() =>
			decodeSingleControlRequest(
				Buffer.concat([encodeRawControlRequest(request), encodeRawControlRequest(request)]),
			),
		).toThrow(ControlProtocolError);
	});
	it("rejects non-object and invalid JSON request frames", () => {
		for (const value of [null, false, 0, "request", []]) {
			expectControlProtocolError(
				() => decodeSingleControlRequest(encodeControlFrame(value as unknown as ControlRequest)),
				"bad_request",
			);
		}
		expectControlProtocolError(
			() => decodeSingleControlRequest(encodeRawFrame(Buffer.from("{", "utf8"))),
			"bad_frame",
		);
	});
	it("rejects missing, wrong, empty, and malformed request identifiers and tokens", () => {
		const invalidFields: ReadonlyArray<{
			field: "id" | "generation" | "token";
			values: ReadonlyArray<unknown>;
		}> = [
			{
				field: "id",
				values: [undefined, 1, "", "a".repeat(MAX_CONTROL_REQUEST_ID_LENGTH + 1)],
			},
			{
				field: "generation",
				values: [undefined, 1, "", "a".repeat(MAX_CONTROL_REQUEST_ID_LENGTH + 1)],
			},
			{
				field: "token",
				values: [undefined, 1, "", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)],
			},
		];
		for (const { field, values } of invalidFields) {
			for (const value of values) {
				const invalid: Record<string, unknown> = { ...request, [field]: value };
				if (value === undefined) delete invalid[field];
				expectControlProtocolError(
					() => decodeSingleControlRequest(encodeRawControlRequest(invalid)),
					"bad_request",
				);
			}
		}
	});
	it("accepts only exact no-data schemas for ready, status, heartbeat, and cancel", () => {
		for (const action of ["ready", "status", "heartbeat", "cancel"] as const) {
			const noDataRequest: ControlRequest = {
				version: CONTROL_PROTOCOL_VERSION,
				id: request.id,
				action,
				generation: request.generation,
				token: request.token,
			};
			expect(decodeSingleControlRequest(encodeRawControlRequest(noDataRequest))).toEqual(noDataRequest);
			for (const data of [null, {}, { unexpected: true }, "unexpected"]) {
				expectControlProtocolError(
					() => decodeSingleControlRequest(encodeRawControlRequest({ ...noDataRequest, data })),
					"bad_request",
				);
			}
		}
	});
	it("accepts legacy UTF-8 write text and canonical base64 bytes exactly", () => {
		const legacy = decodeSingleControlRequest(encodeRawControlRequest(request));
		expect(decodeControlWriteRequest(legacy)).toEqual(new TextEncoder().encode("in memory only"));

		const raw = Uint8Array.from([0, 0xff, 0x80, 0x0a, 0x1b]);
		const encoded = Buffer.from(raw).toString("base64");
		const parsed = decodeSingleControlRequest(
			encodeRawControlRequest({ ...request, data: { encoding: "base64", bytes: encoded } }),
		);
		expect(parsed.data).toEqual({ encoding: "base64", bytes: encoded });
		expect(decodeControlWriteRequest(parsed)).toEqual(raw);
	});
	it("rejects noncanonical, oversized, and extra write data", () => {
		const invalid = [
			{ encoding: "base64", bytes: "A" },
			{ encoding: "base64", bytes: "AA=" },
			{ encoding: "base64", bytes: "AB==" },
			{ encoding: "base64", bytes: "AA==\n" },
			{ encoding: "base64", bytes: "AA==", unexpected: true },
		];
		for (const data of invalid) {
			expect(() => decodeSingleControlRequest(encodeRawControlRequest({ ...request, data }))).toThrow(
				ControlProtocolError,
			);
		}
		const oversized = Buffer.alloc(MAX_CONTROL_WRITE_BYTES + 1).toString("base64");
		expect(() =>
			decodeSingleControlRequest(
				encodeRawControlRequest({ ...request, data: { encoding: "base64", bytes: oversized } }),
			),
		).toThrow(ControlProtocolError);
		const exactMultibyte = "😀".repeat(Math.floor(MAX_CONTROL_WRITE_BYTES / 4));
		expect(new TextEncoder().encode(exactMultibyte)).toHaveLength(MAX_CONTROL_WRITE_BYTES);
		expect(
			decodeSingleControlRequest(encodeRawControlRequest({ ...request, data: { text: exactMultibyte } })),
		).toMatchObject({ data: { text: exactMultibyte } });
		const oversizedMultibyte = `${exactMultibyte}😀`;
		expect(new TextEncoder().encode(oversizedMultibyte)).toHaveLength(MAX_CONTROL_WRITE_BYTES + 4);
		expect(() =>
			decodeSingleControlRequest(encodeRawControlRequest({ ...request, data: { text: oversizedMultibyte } })),
		).toThrow(ControlProtocolError);
		expect(() => decodeControlWriteRequest({ ...request, action: "status" })).toThrow(ControlProtocolError);
	});
	it("round-trips prompt and text writes at the exact encodable frame boundary", () => {
		for (const action of ["prompt", "write"] as const) {
			const envelope = {
				version: CONTROL_PROTOCOL_VERSION,
				id: "\0".repeat(MAX_CONTROL_REQUEST_ID_LENGTH),
				action,
				generation: "\0".repeat(MAX_CONTROL_REQUEST_ID_LENGTH),
				token: "a".repeat(64),
				data: { text: "" },
			};
			const text = "\u0001".repeat(
				Math.floor((MAX_CONTROL_FRAME_BYTES - Buffer.byteLength(JSON.stringify(envelope), "utf8")) / 6),
			);
			const parsed = parseControlRequest({ ...envelope, data: { text } });
			const frame = encodeRawControlRequest(parsed);
			expect(frame.byteLength).toBeGreaterThan(MAX_CONTROL_FRAME_BYTES + 4 - 6);
			expect(frame.byteLength).toBeLessThanOrEqual(MAX_CONTROL_FRAME_BYTES + 4);
			expect(decodeSingleControlRequest(frame)).toEqual(parsed);
			expectControlProtocolError(
				() => parseControlRequest({ ...envelope, data: { text: `${text}\u0001` } }),
				"bad_request",
			);
		}
	});
	it("rejects accessor-backed and inherited protocol fields", () => {
		const accessorData: Record<string, unknown> = {};
		Object.defineProperty(accessorData, "text", {
			enumerable: true,
			get: () => "accessor",
		});
		expectControlProtocolError(
			() => parseControlRequest({ ...request, action: "prompt", data: accessorData }),
			"bad_request",
		);

		const inheritedData = Object.create({ text: "inherited" }) as Record<string, unknown>;
		expectControlProtocolError(
			() => parseControlRequest({ ...request, action: "prompt", data: inheritedData }),
			"bad_request",
		);

		const { token, ...ownRequest } = request;
		const inheritedTokenRequest = Object.assign(Object.create({ token }), ownRequest);
		expectControlProtocolError(() => parseControlRequest(inheritedTokenRequest), "bad_request");

		const accessorResponse: Record<string, unknown> = { version: CONTROL_PROTOCOL_VERSION, id: "response", ok: true };
		Object.defineProperty(accessorResponse, "result", {
			enumerable: true,
			get: () => null,
		});
		expectControlProtocolError(() => parseControlResponse(accessorResponse), "bad_frame");
	});
	it("returns hardened snapshots that survive source mutation", () => {
		const result: { nested: { value: unknown } } = { nested: { value: "before" } };
		const parsed = parseControlResponse({ version: CONTROL_PROTOCOL_VERSION, id: "response", ok: true, result });
		result.nested.value = () => undefined;

		expect(parsed).toEqual({
			version: CONTROL_PROTOCOL_VERSION,
			id: "response",
			ok: true,
			result: { nested: { value: "before" } },
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected success response");
		expect(Object.getPrototypeOf(parsed.result)).toBeNull();
		expect(Object.getPrototypeOf((parsed.result as { nested: unknown }).nested)).toBeNull();
	});
	it("accepts bounded stream requests and rejects malformed cursor data", () => {
		const streamRequest: ControlRequest = {
			...request,
			action: "stream",
			data: { cursor: null, maxBytes: MAX_CONTROL_STREAM_BYTES },
		};
		expect(decodeSingleControlRequest(encodeRawControlRequest(streamRequest))).toEqual(streamRequest);
		expect(
			decodeSingleControlRequest(encodeRawControlRequest({ ...streamRequest, data: { cursor: 0, maxBytes: 1 } })),
		).toMatchObject({ data: { cursor: 0, maxBytes: 1 } });

		const invalid = [
			{ cursor: -1, maxBytes: 1 },
			{ cursor: 1.5, maxBytes: 1 },
			{ cursor: Number.MAX_SAFE_INTEGER + 1, maxBytes: 1 },
			{ cursor: null, maxBytes: 0 },
			{ cursor: null, maxBytes: 1.5 },
			{ cursor: null, maxBytes: MAX_CONTROL_STREAM_BYTES + 1 },
			{ cursor: null, maxBytes: 1, unexpected: true },
		];
		for (const data of invalid) {
			expect(() => decodeSingleControlRequest(encodeRawControlRequest({ ...streamRequest, data }))).toThrow(
				ControlProtocolError,
			);
		}
	});
	it("bounds resize dimensions to safe terminal sizes", () => {
		const resize = { ...request, action: "resize" as const, data: { columns: 1, rows: 1 } };
		expect(decodeSingleControlRequest(encodeRawControlRequest(resize))).toEqual(resize);
		for (const data of [
			{ columns: 0, rows: 1 },
			{ columns: 1, rows: 0 },
			{ columns: 1.5, rows: 1 },
			{ columns: Number.MAX_SAFE_INTEGER + 1, rows: 1 },
			{ columns: MAX_CONTROL_TERMINAL_DIMENSION + 1, rows: 1 },
			{ columns: 1, rows: MAX_CONTROL_TERMINAL_DIMENSION + 1 },
		])
			expect(() => decodeSingleControlRequest(encodeRawControlRequest({ ...resize, data }))).toThrow(
				ControlProtocolError,
			);
	});

	it("enforces the exact frame limit", () => {
		const exact = Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 4);
		exact.writeUInt32BE(MAX_CONTROL_FRAME_BYTES, 0);
		expect(new ControlFrameDecoder().push(exact)).toHaveLength(1);
		const over = Buffer.alloc(4);
		over.writeUInt32BE(MAX_CONTROL_FRAME_BYTES + 1, 0);
		expect(() => new ControlFrameDecoder().push(over)).toThrow(ControlProtocolError);
	});
	it("rejects a second frame delivered after the first frame", () => {
		const decoder = new ControlFrameDecoder(1);
		const frame = encodeControlFrame(withoutControlToken(request));
		expect(decoder.push(frame)).toHaveLength(1);
		expect(() => decoder.push(encodeControlFrame({ ...withoutControlToken(request), id: "request-2" }))).toThrow(
			ControlProtocolError,
		);
	});
	it("fails closed while finalizing partial frames and end-marker-delimited requests", () => {
		const frame = encodeControlFrame(withoutControlToken(request));
		const missingMarker = new ControlFrameDecoder(1, true);
		expect(missingMarker.push(frame)).toHaveLength(1);
		expectControlProtocolError(() => missingMarker.finish(), "bad_frame");
		for (const length of [1, 2, 3]) {
			const truncatedPrefix = new ControlFrameDecoder(1);
			expect(truncatedPrefix.push(frame.subarray(0, length))).toEqual([]);
			expectControlProtocolError(() => truncatedPrefix.finish(), "bad_frame");
		}

		const truncatedBody = new ControlFrameDecoder(1, true);
		expect(truncatedBody.push(frame.subarray(0, -1))).toEqual([]);
		expectControlProtocolError(() => truncatedBody.finish(), "bad_frame");

		const truncatedMarker = new ControlFrameDecoder(1, true);
		expect(truncatedMarker.push(frame)).toHaveLength(1);
		expect(truncatedMarker.push(CONTROL_REQUEST_END_MARKER.subarray(0, 1))).toEqual([]);
		expectControlProtocolError(() => truncatedMarker.finish(), "bad_frame");

		const splitMarker = new ControlFrameDecoder(1, true);
		expect(splitMarker.push(frame)).toHaveLength(1);
		expect(splitMarker.push(CONTROL_REQUEST_END_MARKER.subarray(0, 1))).toEqual([]);
		expect(splitMarker.push(CONTROL_REQUEST_END_MARKER.subarray(1))).toEqual([]);
		expect(splitMarker.ended).toBe(true);
		splitMarker.finish();

		const coalescedMarker = new ControlFrameDecoder(1, true);
		expect(coalescedMarker.push(Buffer.concat([frame, CONTROL_REQUEST_END_MARKER]))).toHaveLength(1);
		expect(coalescedMarker.ended).toBe(true);
		coalescedMarker.finish();

		expectControlProtocolError(
			() =>
				new ControlFrameDecoder(1, true).push(Buffer.concat([frame, CONTROL_REQUEST_END_MARKER, Buffer.from([1])])),
			"too_many_frames",
		);

		const earlyMarker = new ControlFrameDecoder(1, true);
		expectControlProtocolError(() => earlyMarker.push(CONTROL_REQUEST_END_MARKER), "bad_frame");

		const duplicateMarker = new ControlFrameDecoder(1, true);
		expect(duplicateMarker.push(frame)).toHaveLength(1);
		expect(duplicateMarker.push(CONTROL_REQUEST_END_MARKER)).toEqual([]);
		expectControlProtocolError(() => duplicateMarker.push(CONTROL_REQUEST_END_MARKER), "too_many_frames");
	});

	it("generates unique tokens, fingerprints safely, and rejects mismatches", () => {
		const first = generateControlToken();
		const second = generateControlToken();
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(first).not.toBe(second);
		expect(controlTokenFingerprint(first)).toMatch(/^[a-f0-9]{16}$/);
		expect(controlTokenFingerprint(first)).toBe(controlTokenFingerprint(first));
		expect(controlTokenFingerprint(first)).not.toBe(controlTokenFingerprint(second));
		expect(verifyControlToken(first, first)).toBe(true);
		expect(verifyControlToken(first, second)).toBe(false);
		expect(verifyControlToken(first, "short")).toBe(false);
	});
});
