import * as crypto from "node:crypto";

export const CONTROL_PROTOCOL_VERSION = 2;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_CONTROL_REQUEST_ID_LENGTH = 128;
export const MAX_CONTROL_WRITE_BYTES = 45 * 1024;
export const MAX_CONTROL_STREAM_BYTES = 24 * 1024;
export const MAX_CONTROL_PROMPT_BYTES = Math.floor((64 * 1024) / 3);
export const MAX_CONTROL_TERMINAL_DIMENSION = 10_000;
export const CONTROL_REQUEST_END_MARKER = Buffer.alloc(4);
export const CONTROL_NONCE_BYTES = 32;
export const MAX_CONTROL_ENDPOINT_LENGTH = 512;
export const CONTROL_ACTIONS = [
	"ready",
	"status",
	"heartbeat",
	"cancel",
	"prompt",
	"write",
	"resize",
	"stream",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type ControlJson = null | boolean | number | string | ControlJson[] | { [key: string]: ControlJson };
export interface ControlRequest {
	version: 2;
	id: string;
	action: ControlAction;
	generation: string;
	token: string;
	data?: ControlJson;
}
export interface ControlRequestCandidate {
	version: 2;
	id: string;
	action: ControlAction;
	generation: string;
	data?: ControlJson;
}
export type AuthenticatedControlRequest = Omit<ControlRequest, "token">;
export interface ControlHello {
	version: 2;
	type: "hello";
	nonce: string;
}
export interface ControlChallenge {
	version: 2;
	type: "challenge";
	endpoint: string;
	generation: string;
	nonce: string;
	proof: string;
}
export interface ControlProof {
	version: 2;
	type: "proof";
	proof: string;
}
export type ControlWireMessage =
	| ControlRequestCandidate
	| ControlHello
	| ControlChallenge
	| ControlProof
	| ControlResponse;
export interface ControlSuccessResponse {
	version: 2;
	id: string;
	ok: true;
	result: ControlJson;
}
export interface ControlErrorResponse {
	version: 2;
	id: string;
	ok: false;
	error: ControlErrorCode;
}
export type ControlResponse = ControlSuccessResponse | ControlErrorResponse;
export type ControlErrorCode =
	| "bad_frame"
	| "bad_request"
	| "unauthorized"
	| "generation_mismatch"
	| "handler_failed"
	| "timeout"
	| "too_many_frames";

export class ControlProtocolError extends Error {
	constructor(readonly code: ControlErrorCode | "frame_too_large") {
		super(code);
		this.name = "ControlProtocolError";
	}
}

type PlainControlRecord = Record<string, unknown>;

function snapshotPlainControlRecord(value: unknown): PlainControlRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	try {
		const prototype = Object.getPrototypeOf(value);
		if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0)
			return undefined;
		const snapshot = Object.create(null) as PlainControlRecord;
		for (const key of Object.getOwnPropertyNames(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
			snapshot[key] = descriptor.value;
		}
		return snapshot;
	} catch {
		return undefined;
	}
}

function hasOnlyKeys(value: PlainControlRecord, keys: readonly string[]): boolean {
	return Object.keys(value).every(key => keys.includes(key));
}

export function snapshotControlJson(value: unknown): ControlJson | undefined {
	try {
		return snapshotControlJsonValue(value, new Set<object>());
	} catch {
		return undefined;
	}
}

export function isControlJson(value: unknown): value is ControlJson {
	return snapshotControlJson(value) !== undefined;
}

function snapshotControlJsonValue(value: unknown, ancestors: Set<object>): ControlJson | undefined {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "object" || value === null || ancestors.has(value)) return undefined;
	if (Array.isArray(value)) {
		if (
			Object.getPrototypeOf(value) !== Array.prototype ||
			Object.getOwnPropertySymbols(value).length !== 0 ||
			Object.getOwnPropertyNames(value).length !== value.length + 1
		)
			return undefined;
		ancestors.add(value);
		const snapshot: ControlJson[] = [];
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor)) {
				ancestors.delete(value);
				return undefined;
			}
			const item = snapshotControlJsonValue(descriptor.value, ancestors);
			if (item === undefined) {
				ancestors.delete(value);
				return undefined;
			}
			snapshot.push(item);
		}
		ancestors.delete(value);
		return snapshot;
	}
	const prototype = Object.getPrototypeOf(value);
	if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0)
		return undefined;
	ancestors.add(value);
	const snapshot = Object.create(null) as { [key: string]: ControlJson };
	for (const key of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (key === "toJSON" || !descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			ancestors.delete(value);
			return undefined;
		}
		const item = snapshotControlJsonValue(descriptor.value, ancestors);
		if (item === undefined) {
			ancestors.delete(value);
			return undefined;
		}
		snapshot[key] = item;
	}
	ancestors.delete(value);
	return snapshot;
}
function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_CONTROL_REQUEST_ID_LENGTH;
}
function isControlAction(value: unknown): value is ControlAction {
	return typeof value === "string" && CONTROL_ACTIONS.some(action => action === value);
}
function isControlErrorCode(value: unknown): value is ControlErrorCode {
	return (
		value === "bad_frame" ||
		value === "bad_request" ||
		value === "unauthorized" ||
		value === "generation_mismatch" ||
		value === "handler_failed" ||
		value === "timeout" ||
		value === "too_many_frames"
	);
}
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTROL_NONCE = /^[a-f0-9]{64}$/;
const CONTROL_PROOF = /^[a-f0-9]{64}$/;
const MAX_CONTROL_TEXT_ENVELOPE_IDENTIFIER = "\0".repeat(MAX_CONTROL_REQUEST_ID_LENGTH);
const MAX_CONTROL_TEXT_ENVELOPE_BYTES = {
	prompt: Buffer.byteLength(
		JSON.stringify({
			version: CONTROL_PROTOCOL_VERSION,
			id: MAX_CONTROL_TEXT_ENVELOPE_IDENTIFIER,
			action: "prompt",
			generation: MAX_CONTROL_TEXT_ENVELOPE_IDENTIFIER,
			token: "f".repeat(64),
			data: { text: "" },
		}),
		"utf8",
	),
	write: Buffer.byteLength(
		JSON.stringify({
			version: CONTROL_PROTOCOL_VERSION,
			id: MAX_CONTROL_TEXT_ENVELOPE_IDENTIFIER,
			action: "write",
			generation: MAX_CONTROL_TEXT_ENVELOPE_IDENTIFIER,
			token: "f".repeat(64),
			data: { text: "" },
		}),
		"utf8",
	),
} as const;

function hasControlTextFrameCapacity(action: keyof typeof MAX_CONTROL_TEXT_ENVELOPE_BYTES, value: string): boolean {
	return (
		Buffer.byteLength(JSON.stringify(value), "utf8") - 2 <=
		MAX_CONTROL_FRAME_BYTES - MAX_CONTROL_TEXT_ENVELOPE_BYTES[action]
	);
}
function containsUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			if (index + 1 >= value.length) return true;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}
function isControlEndpoint(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_CONTROL_ENDPOINT_LENGTH &&
		!value.includes("\0") &&
		!containsUnpairedSurrogate(value) &&
		Buffer.byteLength(value, "utf8") <= MAX_CONTROL_ENDPOINT_LENGTH
	);
}
function isControlNonce(value: unknown): value is string {
	return typeof value === "string" && CONTROL_NONCE.test(value);
}
function isControlProof(value: unknown): value is string {
	return typeof value === "string" && CONTROL_PROOF.test(value);
}

export function canonicalControlPromptForms(value: unknown): readonly string[] | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		containsUnpairedSurrogate(value) ||
		Buffer.byteLength(value, "utf8") > MAX_CONTROL_PROMPT_BYTES ||
		!hasControlTextFrameCapacity("prompt", value)
	)
		return undefined;
	const echoForm = value.replace(/\r\n|\r|\n/g, "\r\n");
	return echoForm === value ? [value] : [value, echoForm];
}

function decodeControlWriteData(data: PlainControlRecord): Uint8Array {
	if (hasOnlyKeys(data, ["text"]) && typeof data.text === "string") {
		const bytes = new TextEncoder().encode(data.text);
		if (bytes.length > MAX_CONTROL_WRITE_BYTES || !hasControlTextFrameCapacity("write", data.text))
			throw new ControlProtocolError("bad_request");
		return bytes;
	}
	if (
		!hasOnlyKeys(data, ["encoding", "bytes"]) ||
		data.encoding !== "base64" ||
		typeof data.bytes !== "string" ||
		!CANONICAL_BASE64.test(data.bytes)
	)
		throw new ControlProtocolError("bad_request");
	const bytes = Buffer.from(data.bytes, "base64");
	if (bytes.length > MAX_CONTROL_WRITE_BYTES || bytes.toString("base64") !== data.bytes)
		throw new ControlProtocolError("bad_request");
	return bytes;
}

export function decodeControlWriteRequest(request: ControlRequest | AuthenticatedControlRequest): Uint8Array {
	if (request.action !== "write") throw new ControlProtocolError("bad_request");
	const data = snapshotPlainControlRecord(request.data);
	if (!data) throw new ControlProtocolError("bad_request");
	return decodeControlWriteData(data);
}

function parseData(action: ControlAction, data: unknown, dataPresent: boolean): ControlJson | undefined {
	if (action === "prompt") {
		const prompt = snapshotPlainControlRecord(data);
		const text = prompt?.text;
		if (
			!dataPresent ||
			!prompt ||
			!hasOnlyKeys(prompt, ["text"]) ||
			typeof text !== "string" ||
			canonicalControlPromptForms(text) === undefined
		)
			throw new ControlProtocolError("bad_request");
		const snapshot = Object.create(null) as { [key: string]: ControlJson };
		snapshot.text = text;
		return snapshot;
	}
	if (action === "write") {
		const write = snapshotPlainControlRecord(data);
		if (!dataPresent || !write) throw new ControlProtocolError("bad_request");
		const bytes = decodeControlWriteData(write);
		const snapshot = Object.create(null) as { [key: string]: ControlJson };
		if (write.encoding === "base64") {
			snapshot.encoding = "base64";
			snapshot.bytes = Buffer.from(bytes).toString("base64");
		} else {
			snapshot.text = write.text as string;
		}
		return snapshot;
	}
	if (action === "resize") {
		const resize = snapshotPlainControlRecord(data);
		if (!dataPresent || !resize || !hasOnlyKeys(resize, ["columns", "rows"]))
			throw new ControlProtocolError("bad_request");
		const columns = resize.columns;
		const rows = resize.rows;
		if (
			typeof columns !== "number" ||
			typeof rows !== "number" ||
			!Number.isSafeInteger(columns) ||
			!Number.isSafeInteger(rows) ||
			columns < 1 ||
			rows < 1 ||
			columns > MAX_CONTROL_TERMINAL_DIMENSION ||
			rows > MAX_CONTROL_TERMINAL_DIMENSION
		)
			throw new ControlProtocolError("bad_request");
		const snapshot = Object.create(null) as { [key: string]: ControlJson };
		snapshot.columns = columns;
		snapshot.rows = rows;
		return snapshot;
	}
	if (action === "stream") {
		const stream = snapshotPlainControlRecord(data);
		if (!dataPresent || !stream || !hasOnlyKeys(stream, ["cursor", "maxBytes"]))
			throw new ControlProtocolError("bad_request");
		const cursor = stream.cursor;
		const maxBytes = stream.maxBytes;
		if (
			(cursor !== null && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) ||
			typeof maxBytes !== "number" ||
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1 ||
			maxBytes > MAX_CONTROL_STREAM_BYTES
		)
			throw new ControlProtocolError("bad_request");
		const snapshot = Object.create(null) as { [key: string]: ControlJson };
		snapshot.cursor = cursor;
		snapshot.maxBytes = maxBytes;
		return snapshot;
	}
	if (dataPresent) throw new ControlProtocolError("bad_request");
	return undefined;
}

function isControlRequestEncodable(request: ControlRequestCandidate): boolean {
	const requestWithToken: ControlRequest =
		request.data === undefined
			? {
					version: request.version,
					id: request.id,
					action: request.action,
					generation: request.generation,
					token: "f".repeat(64),
				}
			: {
					version: request.version,
					id: request.id,
					action: request.action,
					generation: request.generation,
					token: "f".repeat(64),
					data: request.data,
				};
	return Buffer.byteLength(JSON.stringify(requestWithToken), "utf8") <= MAX_CONTROL_FRAME_BYTES;
}
function parseTokenFreeControlRequest(request: PlainControlRecord): ControlRequestCandidate {
	const { version, id, action, generation } = request;
	if (
		!Object.hasOwn(request, "version") ||
		!Object.hasOwn(request, "id") ||
		!Object.hasOwn(request, "action") ||
		!Object.hasOwn(request, "generation") ||
		version !== CONTROL_PROTOCOL_VERSION ||
		!isIdentifier(id) ||
		!isIdentifier(generation) ||
		!isControlAction(action)
	)
		throw new ControlProtocolError("bad_request");
	const data = parseData(action, request.data, Object.hasOwn(request, "data"));
	const parsed: ControlRequestCandidate =
		data === undefined
			? { version: CONTROL_PROTOCOL_VERSION, id, action, generation }
			: { version: CONTROL_PROTOCOL_VERSION, id, action, generation, data };
	if (!isControlRequestEncodable(parsed)) throw new ControlProtocolError("bad_request");
	return parsed;
}
export function parseControlRequestCandidate(value: unknown): ControlRequestCandidate {
	const request = snapshotPlainControlRecord(value);
	if (!request || !hasOnlyKeys(request, ["version", "id", "action", "generation", "data"]))
		throw new ControlProtocolError("bad_request");
	return parseTokenFreeControlRequest(request);
}
/**
 * Validates the token-free request envelope without action-specific data semantics.
 * Its output is only valid for authentication; parseControlRequestCandidate must run before dispatch.
 */
export function parseControlRequestCandidateEnvelope(value: unknown): ControlRequestCandidate {
	const request = snapshotPlainControlRecord(value);
	if (!request || !hasOnlyKeys(request, ["version", "id", "action", "generation", "data"]))
		throw new ControlProtocolError("bad_request");
	const { version, id, action, generation } = request;
	if (
		!Object.hasOwn(request, "version") ||
		!Object.hasOwn(request, "id") ||
		!Object.hasOwn(request, "action") ||
		!Object.hasOwn(request, "generation") ||
		version !== CONTROL_PROTOCOL_VERSION ||
		!isIdentifier(id) ||
		!isControlAction(action) ||
		!isIdentifier(generation)
	)
		throw new ControlProtocolError("bad_request");
	const dataPresent = Object.hasOwn(request, "data");
	const data = dataPresent ? snapshotControlJson(request.data) : undefined;
	if (dataPresent && data === undefined) throw new ControlProtocolError("bad_request");
	const parsed: ControlRequestCandidate =
		data === undefined
			? { version: CONTROL_PROTOCOL_VERSION, id, action, generation }
			: { version: CONTROL_PROTOCOL_VERSION, id, action, generation, data };
	if (!isControlRequestEncodable(parsed)) throw new ControlProtocolError("bad_request");
	return parsed;
}
export function parseControlRequest(value: unknown): ControlRequest {
	const request = snapshotPlainControlRecord(value);
	if (!request || !hasOnlyKeys(request, ["version", "id", "action", "generation", "token", "data"]))
		throw new ControlProtocolError("bad_request");
	const token = request.token;
	if (!Object.hasOwn(request, "token") || !isControlProof(token)) throw new ControlProtocolError("bad_request");
	const parsed = parseTokenFreeControlRequest(request);
	return parsed.data === undefined
		? {
				version: parsed.version,
				id: parsed.id,
				action: parsed.action,
				generation: parsed.generation,
				token,
			}
		: {
				version: parsed.version,
				id: parsed.id,
				action: parsed.action,
				generation: parsed.generation,
				token,
				data: parsed.data,
			};
}
/**
 * Validates the authenticated client envelope without validating action-specific data.
 * The server validates that data only after its proof has authenticated the endpoint.
 */
export function parseControlRequestEnvelope(value: unknown): ControlRequest {
	const request = snapshotPlainControlRecord(value);
	if (!request || !hasOnlyKeys(request, ["version", "id", "action", "generation", "token", "data"]))
		throw new ControlProtocolError("bad_request");
	const { version, id, action, generation, token } = request;
	if (
		!Object.hasOwn(request, "version") ||
		!Object.hasOwn(request, "id") ||
		!Object.hasOwn(request, "action") ||
		!Object.hasOwn(request, "generation") ||
		!Object.hasOwn(request, "token") ||
		version !== CONTROL_PROTOCOL_VERSION ||
		!isIdentifier(id) ||
		!isControlAction(action) ||
		!isIdentifier(generation) ||
		!isControlProof(token)
	)
		throw new ControlProtocolError("bad_request");
	const dataPresent = Object.hasOwn(request, "data");
	const data = dataPresent ? snapshotControlJson(request.data) : undefined;
	if (dataPresent && data === undefined) throw new ControlProtocolError("bad_request");
	const parsed: ControlRequest =
		data === undefined
			? { version: CONTROL_PROTOCOL_VERSION, id, action, generation, token }
			: { version: CONTROL_PROTOCOL_VERSION, id, action, generation, token, data };
	if (!isControlRequestEncodable(withoutControlToken(parsed))) throw new ControlProtocolError("bad_request");
	return parsed;
}
export function withoutControlToken(request: ControlRequest): AuthenticatedControlRequest {
	return request.data === undefined
		? {
				version: request.version,
				id: request.id,
				action: request.action,
				generation: request.generation,
			}
		: {
				version: request.version,
				id: request.id,
				action: request.action,
				generation: request.generation,
				data: request.data,
			};
}
export function authenticateControlRequest(request: ControlRequestCandidate): AuthenticatedControlRequest {
	return request.data === undefined
		? {
				version: request.version,
				id: request.id,
				action: request.action,
				generation: request.generation,
			}
		: {
				version: request.version,
				id: request.id,
				action: request.action,
				generation: request.generation,
				data: request.data,
			};
}
export function parseControlResponse(value: unknown): ControlResponse {
	const response = snapshotPlainControlRecord(value);
	if (!response || !hasOnlyKeys(response, ["version", "id", "ok", "result", "error"]))
		throw new ControlProtocolError("bad_frame");
	const { version, id, ok } = response;
	if (
		!Object.hasOwn(response, "version") ||
		!Object.hasOwn(response, "id") ||
		!Object.hasOwn(response, "ok") ||
		version !== CONTROL_PROTOCOL_VERSION ||
		!isIdentifier(id) ||
		typeof ok !== "boolean"
	)
		throw new ControlProtocolError("bad_frame");
	if (ok) {
		if (!Object.hasOwn(response, "result") || Object.hasOwn(response, "error"))
			throw new ControlProtocolError("bad_frame");
		const result = snapshotControlJson(response.result);
		if (result === undefined) throw new ControlProtocolError("bad_frame");
		return { version: CONTROL_PROTOCOL_VERSION, id, ok: true, result };
	}
	if (Object.hasOwn(response, "result") || !Object.hasOwn(response, "error") || !isControlErrorCode(response.error))
		throw new ControlProtocolError("bad_frame");
	return { version: CONTROL_PROTOCOL_VERSION, id, ok: false, error: response.error };
}
export function parseControlHello(value: unknown): ControlHello {
	const hello = snapshotPlainControlRecord(value);
	if (!hello || !hasOnlyKeys(hello, ["version", "type", "nonce"])) throw new ControlProtocolError("bad_frame");
	const { version, type, nonce } = hello;
	if (
		!Object.hasOwn(hello, "version") ||
		!Object.hasOwn(hello, "type") ||
		!Object.hasOwn(hello, "nonce") ||
		version !== CONTROL_PROTOCOL_VERSION ||
		type !== "hello" ||
		!isControlNonce(nonce)
	)
		throw new ControlProtocolError("bad_frame");
	return { version: CONTROL_PROTOCOL_VERSION, type, nonce };
}
export function parseControlChallenge(value: unknown): ControlChallenge {
	const challenge = snapshotPlainControlRecord(value);
	if (!challenge || !hasOnlyKeys(challenge, ["version", "type", "endpoint", "generation", "nonce", "proof"]))
		throw new ControlProtocolError("bad_frame");
	const { version, type, endpoint, generation, nonce, proof } = challenge;
	if (
		!Object.hasOwn(challenge, "version") ||
		!Object.hasOwn(challenge, "type") ||
		!Object.hasOwn(challenge, "endpoint") ||
		!Object.hasOwn(challenge, "generation") ||
		!Object.hasOwn(challenge, "nonce") ||
		!Object.hasOwn(challenge, "proof") ||
		version !== CONTROL_PROTOCOL_VERSION ||
		type !== "challenge" ||
		!isControlEndpoint(endpoint) ||
		!isIdentifier(generation) ||
		!isControlNonce(nonce) ||
		!isControlProof(proof)
	)
		throw new ControlProtocolError("bad_frame");
	return { version: CONTROL_PROTOCOL_VERSION, type, endpoint, generation, nonce, proof };
}
export function parseControlProof(value: unknown): ControlProof {
	const proof = snapshotPlainControlRecord(value);
	if (!proof || !hasOnlyKeys(proof, ["version", "type", "proof"])) throw new ControlProtocolError("bad_frame");
	const { version, type, proof: digest } = proof;
	if (
		!Object.hasOwn(proof, "version") ||
		!Object.hasOwn(proof, "type") ||
		!Object.hasOwn(proof, "proof") ||
		version !== CONTROL_PROTOCOL_VERSION ||
		type !== "proof" ||
		!isControlProof(digest)
	)
		throw new ControlProtocolError("bad_frame");
	return { version: CONTROL_PROTOCOL_VERSION, type, proof: digest };
}
function lengthDelimitedControlTranscript(domain: Buffer, fields: readonly Uint8Array[]): Buffer {
	const prefixed = [domain, Buffer.from([CONTROL_PROTOCOL_VERSION]), ...fields];
	const size = prefixed.reduce((total, field) => total + 4 + field.length, 0);
	const transcript = Buffer.allocUnsafe(size);
	let offset = 0;
	for (const field of prefixed) {
		transcript.writeUInt32BE(field.length, offset);
		offset += 4;
		transcript.set(field, offset);
		offset += field.length;
	}
	return transcript;
}
function controlHmac(token: string, transcript: Uint8Array): string {
	if (!isControlProof(token)) throw new Error("invalid_control_proof_token");
	return crypto.createHmac("sha256", Buffer.from(token, "utf8")).update(transcript).digest("hex");
}
function controlServerTranscript(
	endpoint: string,
	generation: string,
	clientNonce: string,
	serverNonce: string,
): Buffer {
	return lengthDelimitedControlTranscript(Buffer.from("gjc-visible-control/v2/server-auth", "utf8"), [
		Buffer.from(endpoint, "utf8"),
		Buffer.from(generation, "utf8"),
		Buffer.from(clientNonce, "hex"),
		Buffer.from(serverNonce, "hex"),
	]);
}
export function controlFrameFromBody(body: Uint8Array): Buffer {
	if (body.length === 0 || body.length > MAX_CONTROL_FRAME_BYTES) throw new ControlProtocolError("bad_frame");
	const frame = Buffer.allocUnsafe(body.length + 4);
	frame.writeUInt32BE(body.length, 0);
	frame.set(body, 4);
	return frame;
}
function completeControlFrame(frame: Uint8Array): Buffer {
	const complete = Buffer.from(frame);
	if (
		complete.length < 5 ||
		complete.readUInt32BE(0) !== complete.length - 4 ||
		complete.length - 4 > MAX_CONTROL_FRAME_BYTES
	)
		throw new ControlProtocolError("bad_frame");
	return complete;
}
function parseProofTranscriptFrames(
	helloFrame: Uint8Array,
	challengeFrame: Uint8Array,
	requestFrame: Uint8Array,
): void {
	decodeControlHelloFrame(completeControlFrame(helloFrame).subarray(4));
	decodeControlChallengeFrame(completeControlFrame(challengeFrame).subarray(4));
	completeControlFrame(requestFrame);
}
export function generateControlHello(): ControlHello {
	return {
		version: CONTROL_PROTOCOL_VERSION,
		type: "hello",
		nonce: crypto.randomBytes(CONTROL_NONCE_BYTES).toString("hex"),
	};
}
export function generateControlChallenge(
	token: string,
	endpoint: string,
	generation: string,
	hello: ControlHello,
): ControlChallenge {
	if (!isControlEndpoint(endpoint) || !isIdentifier(generation) || !isControlNonce(hello.nonce))
		throw new Error("invalid_control_challenge_identity");
	const nonce = crypto.randomBytes(CONTROL_NONCE_BYTES).toString("hex");
	return {
		version: CONTROL_PROTOCOL_VERSION,
		type: "challenge",
		endpoint,
		generation,
		nonce,
		proof: controlHmac(token, controlServerTranscript(endpoint, generation, hello.nonce, nonce)),
	};
}
export function verifyControlChallenge(
	expectedToken: string,
	expectedEndpoint: string,
	expectedGeneration: string,
	hello: ControlHello,
	challenge: ControlChallenge,
): boolean {
	if (
		!isControlProof(expectedToken) ||
		!isControlEndpoint(expectedEndpoint) ||
		!isIdentifier(expectedGeneration) ||
		!isControlNonce(hello.nonce) ||
		challenge.version !== CONTROL_PROTOCOL_VERSION ||
		challenge.type !== "challenge" ||
		challenge.endpoint !== expectedEndpoint ||
		challenge.generation !== expectedGeneration ||
		!isControlNonce(challenge.nonce) ||
		!isControlProof(challenge.proof)
	)
		return false;
	const expected = controlHmac(
		expectedToken,
		controlServerTranscript(expectedEndpoint, expectedGeneration, hello.nonce, challenge.nonce),
	);
	return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(challenge.proof, "hex"));
}
export function createControlProof(
	token: string,
	helloFrame: Uint8Array,
	challengeFrame: Uint8Array,
	requestFrame: Uint8Array,
): ControlProof {
	parseProofTranscriptFrames(helloFrame, challengeFrame, requestFrame);
	return {
		version: CONTROL_PROTOCOL_VERSION,
		type: "proof",
		proof: controlHmac(
			token,
			lengthDelimitedControlTranscript(Buffer.from("gjc-visible-control/v2/client-auth", "utf8"), [
				completeControlFrame(helloFrame),
				completeControlFrame(challengeFrame),
				completeControlFrame(requestFrame),
			]),
		),
	};
}
export function verifyControlProof(
	expectedToken: string,
	helloFrame: Uint8Array,
	challengeFrame: Uint8Array,
	requestFrame: Uint8Array,
	supplied: ControlProof,
): boolean {
	if (
		!isControlProof(expectedToken) ||
		supplied.version !== CONTROL_PROTOCOL_VERSION ||
		supplied.type !== "proof" ||
		!isControlProof(supplied.proof)
	)
		return false;
	try {
		parseProofTranscriptFrames(helloFrame, challengeFrame, requestFrame);
		const expected = createControlProof(expectedToken, helloFrame, challengeFrame, requestFrame);
		return crypto.timingSafeEqual(Buffer.from(expected.proof, "hex"), Buffer.from(supplied.proof, "hex"));
	} catch {
		return false;
	}
}
export function encodeControlFrame(value: ControlWireMessage): Buffer {
	if (typeof value === "object" && value !== null && Object.hasOwn(value, "token"))
		throw new ControlProtocolError("bad_frame");
	const body = Buffer.from(JSON.stringify(value), "utf8");
	if (body.length > MAX_CONTROL_FRAME_BYTES) throw new ControlProtocolError("frame_too_large");
	return controlFrameFromBody(body);
}
function parseJsonFrame(frame: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)) as unknown;
	} catch {
		throw new ControlProtocolError("bad_frame");
	}
}

/** Incrementally decodes bounded frames without allocating a body until its declared length is validated. */
export class ControlFrameDecoder {
	#header = Buffer.allocUnsafe(4);
	#headerLength = 0;
	#body: Buffer | null = null;
	#bodyLength = 0;
	#declaredLength = 0;
	#frames = 0;
	readonly #maxFrames: number;
	readonly #allowEndMarker: boolean;
	#ended = false;
	constructor(maxFrames = 32, allowEndMarker = false) {
		if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new Error("invalid_control_frame_limit");
		this.#maxFrames = maxFrames;
		this.#allowEndMarker = allowEndMarker;
	}
	get ended(): boolean {
		return this.#ended;
	}
	push(chunk: Uint8Array): Buffer[] {
		const frames: Buffer[] = [];
		let offset = 0;
		while (offset < chunk.length) {
			if (this.#ended) throw new ControlProtocolError("too_many_frames");
			if (this.#headerLength < 4) {
				const count = Math.min(4 - this.#headerLength, chunk.length - offset);
				this.#header.set(chunk.subarray(offset, offset + count), this.#headerLength);
				this.#headerLength += count;
				offset += count;
				if (this.#headerLength < 4) continue;
				this.#declaredLength = this.#header.readUInt32BE(0);
				if (this.#declaredLength === 0) {
					if (!this.#allowEndMarker || this.#frames === 0) throw new ControlProtocolError("bad_frame");
					this.#ended = true;
					this.#headerLength = 0;
					this.#declaredLength = 0;
					continue;
				}
				if (this.#declaredLength > MAX_CONTROL_FRAME_BYTES) throw new ControlProtocolError("frame_too_large");
				this.#body = Buffer.allocUnsafe(this.#declaredLength);
				this.#bodyLength = 0;
			}
			const body = this.#body;
			if (!body) throw new ControlProtocolError("bad_frame");
			const count = Math.min(this.#declaredLength - this.#bodyLength, chunk.length - offset);
			body.set(chunk.subarray(offset, offset + count), this.#bodyLength);
			this.#bodyLength += count;
			offset += count;
			if (this.#bodyLength !== this.#declaredLength) continue;
			this.#frames += 1;
			if (this.#frames > this.#maxFrames) throw new ControlProtocolError("too_many_frames");
			frames.push(body);
			this.#headerLength = 0;
			this.#body = null;
			this.#bodyLength = 0;
			this.#declaredLength = 0;
		}
		return frames;
	}
	finish(): void {
		if (this.#headerLength !== 0 || this.#body !== null || (this.#allowEndMarker && !this.#ended))
			throw new ControlProtocolError("bad_frame");
	}
}
export function decodeControlRequestFrame(frame: Uint8Array): ControlRequest {
	return parseControlRequest(parseJsonFrame(frame));
}
export function decodeControlRequestCandidateFrame(frame: Uint8Array): ControlRequestCandidate {
	return parseControlRequestCandidate(parseJsonFrame(frame));
}
export function decodeControlRequestCandidateEnvelopeFrame(frame: Uint8Array): ControlRequestCandidate {
	return parseControlRequestCandidateEnvelope(parseJsonFrame(frame));
}
export function decodeControlHelloFrame(frame: Uint8Array): ControlHello {
	return parseControlHello(parseJsonFrame(frame));
}
export function decodeControlChallengeFrame(frame: Uint8Array): ControlChallenge {
	return parseControlChallenge(parseJsonFrame(frame));
}
export function decodeControlProofFrame(frame: Uint8Array): ControlProof {
	return parseControlProof(parseJsonFrame(frame));
}
export function decodeControlResponseFrame(frame: Uint8Array): ControlResponse {
	return parseControlResponse(parseJsonFrame(frame));
}
export function decodeSingleControlRequest(frame: Uint8Array): ControlRequest {
	const decoder = new ControlFrameDecoder(1);
	const frames = decoder.push(frame);
	decoder.finish();
	if (frames.length !== 1) throw new ControlProtocolError("bad_frame");
	return decodeControlRequestFrame(frames[0]);
}
export function generateControlToken(): string {
	return crypto.randomBytes(32).toString("hex");
}
export function controlTokenFingerprint(token: string): string {
	return crypto.createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}
export function verifyControlToken(expected: string, supplied: string): boolean {
	return crypto.timingSafeEqual(
		crypto.createHash("sha256").update(expected, "utf8").digest(),
		crypto.createHash("sha256").update(supplied, "utf8").digest(),
	);
}
