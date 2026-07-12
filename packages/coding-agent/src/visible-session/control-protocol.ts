import * as crypto from "node:crypto";

export const CONTROL_PROTOCOL_VERSION = 1;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_CONTROL_REQUEST_ID_LENGTH = 128;
export const MAX_CONTROL_WRITE_BYTES = 45 * 1024;
export const MAX_CONTROL_STREAM_BYTES = 24 * 1024;
export const MAX_CONTROL_PROMPT_BYTES = Math.floor((64 * 1024) / 3);
export const MAX_CONTROL_TERMINAL_DIMENSION = 10_000;
export const CONTROL_REQUEST_END_MARKER = Buffer.alloc(4);
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
	version: 1;
	id: string;
	action: ControlAction;
	generation: string;
	token: string;
	data?: ControlJson;
}
export type AuthenticatedControlRequest = Omit<ControlRequest, "token">;
export interface ControlSuccessResponse {
	version: 1;
	id: string;
	ok: true;
	result: ControlJson;
}
export interface ControlErrorResponse {
	version: 1;
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

function isControlRequestEncodable(request: ControlRequest): boolean {
	return Buffer.byteLength(JSON.stringify(request), "utf8") <= MAX_CONTROL_FRAME_BYTES;
}

export function parseControlRequest(value: unknown): ControlRequest {
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
		!isIdentifier(generation) ||
		typeof token !== "string" ||
		!/^[a-f0-9]{64}$/.test(token) ||
		!isControlAction(action)
	)
		throw new ControlProtocolError("bad_request");
	const data = parseData(action, request.data, Object.hasOwn(request, "data"));
	const parsed: ControlRequest =
		data === undefined
			? { version: 1, id, action, generation, token }
			: { version: 1, id, action, generation, token, data };
	if (!isControlRequestEncodable(parsed)) throw new ControlProtocolError("bad_request");
	return parsed;
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
		version !== 1 ||
		!isIdentifier(id) ||
		typeof ok !== "boolean"
	)
		throw new ControlProtocolError("bad_frame");
	if (ok) {
		if (!Object.hasOwn(response, "result") || Object.hasOwn(response, "error"))
			throw new ControlProtocolError("bad_frame");
		const result = snapshotControlJson(response.result);
		if (result === undefined) throw new ControlProtocolError("bad_frame");
		return { version: 1, id, ok: true, result };
	}
	if (Object.hasOwn(response, "result") || !Object.hasOwn(response, "error") || !isControlErrorCode(response.error))
		throw new ControlProtocolError("bad_frame");
	return { version: 1, id, ok: false, error: response.error };
}
function parseJsonFrame(frame: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)) as unknown;
	} catch {
		throw new ControlProtocolError("bad_frame");
	}
}
export function encodeControlFrame(value: ControlRequest | ControlResponse): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	if (body.length > MAX_CONTROL_FRAME_BYTES) throw new ControlProtocolError("frame_too_large");
	const frame = Buffer.allocUnsafe(body.length + 4);
	frame.writeUInt32BE(body.length, 0);
	body.copy(frame, 4);
	return frame;
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
