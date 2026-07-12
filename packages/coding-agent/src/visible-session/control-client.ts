import * as crypto from "node:crypto";
import * as net from "node:net";
import {
	CONTROL_PROTOCOL_VERSION,
	CONTROL_REQUEST_END_MARKER,
	type ControlAction,
	type ControlErrorCode,
	ControlFrameDecoder,
	type ControlJson,
	type ControlRequest,
	type ControlResponse,
	type ControlSuccessResponse,
	decodeControlResponseFrame,
	encodeControlFrame,
	MAX_CONTROL_STREAM_BYTES,
	MAX_CONTROL_TERMINAL_DIMENSION,
	MAX_CONTROL_WRITE_BYTES,
} from "./control-protocol";

export class ControlClientError extends Error {
	constructor(
		readonly code: "connect_failed" | "bad_response" | "request_id_mismatch" | ControlErrorCode,
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "ControlClientError";
	}
}
export interface ControlClientOptions {
	endpoint: string;
	generation: string;
	token: string;
	timeoutMs?: number;
}
export interface ControlCall {
	action: ControlAction;
	data?: ControlJson;
	id?: string;
}
export interface ControlStreamResult {
	startCursor: number;
	endCursor: number;
	bytes: Uint8Array;
	truncated: boolean;
	running: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const STREAM_RESULT_KEYS = ["startCursor", "endCursor", "bytes", "truncated", "running"] as const;
const PRE_CONNECT_RETRY_MS = 25;
const MAX_PRE_CONNECT_RETRIES = 3;
const TRANSIENT_PRE_CONNECT_CODES = new Set(["ECONNREFUSED", "ENOENT", "EAGAIN", "EINTR"]);
/** Node timer delays are limited to signed 32-bit milliseconds. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

class PreConnectEndpointError extends ControlClientError {}

function isTransientPreConnectError(error: unknown): boolean {
	return (
		error instanceof PreConnectEndpointError &&
		typeof error.cause === "object" &&
		error.cause !== null &&
		"code" in error.cause &&
		typeof error.cause.code === "string" &&
		TRANSIENT_PRE_CONNECT_CODES.has(error.cause.code)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeStreamResult(value: unknown, maxBytes: number): ControlStreamResult {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== STREAM_RESULT_KEYS.length ||
		!Object.keys(value).every(key => STREAM_RESULT_KEYS.includes(key as (typeof STREAM_RESULT_KEYS)[number])) ||
		typeof value.startCursor !== "number" ||
		!Number.isSafeInteger(value.startCursor) ||
		value.startCursor < 0 ||
		typeof value.endCursor !== "number" ||
		!Number.isSafeInteger(value.endCursor) ||
		value.endCursor < value.startCursor ||
		typeof value.bytes !== "string" ||
		!CANONICAL_BASE64.test(value.bytes) ||
		typeof value.truncated !== "boolean" ||
		typeof value.running !== "boolean"
	)
		throw new ControlClientError("bad_response");

	const bytes = Buffer.from(value.bytes, "base64");
	if (
		bytes.toString("base64") !== value.bytes ||
		bytes.length > maxBytes ||
		value.endCursor - value.startCursor !== bytes.length
	)
		throw new ControlClientError("bad_response");
	return {
		startCursor: value.startCursor,
		endCursor: value.endCursor,
		bytes,
		truncated: value.truncated,
		running: value.running,
	};
}

export function sendControlRequest(
	endpoint: string,
	request: ControlRequest,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ControlResponse> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS)
		throw new Error("invalid_control_client_timeout");
	const encoded = encodeControlFrame(request);
	const deadline = Date.now() + timeoutMs;
	const sendAttempt = (remainingMs: number): Promise<ControlResponse> => {
		const deferred = Promise.withResolvers<ControlResponse>();
		const socket = net.createConnection({ path: endpoint });
		const decoder = new ControlFrameDecoder(1);
		let response: ControlResponse | null = null;
		let settled = false;
		let connected = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			callback();
		};
		const timer = setTimeout(() => finish(() => deferred.reject(new ControlClientError("timeout"))), remainingMs);
		socket.once("connect", () => {
			connected = true;
			const message = Buffer.concat([encoded, CONTROL_REQUEST_END_MARKER]);
			// The explicit marker completes request framing without depending on half-close behavior.
			socket.write(message);
		});
		socket.on("data", (chunk: Buffer) => {
			if (settled) return;
			try {
				const [frame] = decoder.push(chunk);
				if (!frame) return;
				if (response) throw new ControlClientError("bad_response");
				response = decodeControlResponseFrame(frame);
			} catch {
				finish(() => deferred.reject(new ControlClientError("bad_response")));
			}
		});
		const finalizeResponse = (): void => {
			if (settled) return;
			try {
				decoder.finish();
				const received = response;
				if (!received) throw new ControlClientError("bad_response");
				if (received.id !== request.id) throw new ControlClientError("request_id_mismatch");
				finish(() => deferred.resolve(received));
			} catch (error) {
				finish(() =>
					deferred.reject(error instanceof ControlClientError ? error : new ControlClientError("bad_response")),
				);
			}
		};
		socket.once("end", () => socket.end());
		socket.once("close", finalizeResponse);
		socket.once("error", error => {
			const transient = !connected && TRANSIENT_PRE_CONNECT_CODES.has((error as NodeJS.ErrnoException).code ?? "");
			finish(() =>
				deferred.reject(
					transient
						? new PreConnectEndpointError("connect_failed", { cause: error })
						: new ControlClientError("connect_failed", { cause: error }),
				),
			);
		});
		return deferred.promise;
	};
	return (async () => {
		for (let attempt = 0; ; attempt += 1) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw new ControlClientError("timeout");
			try {
				return await sendAttempt(remainingMs);
			} catch (error) {
				if (!isTransientPreConnectError(error) || attempt >= MAX_PRE_CONNECT_RETRIES) throw error;
				const retryDelay = Math.min(PRE_CONNECT_RETRY_MS, deadline - Date.now());
				if (retryDelay <= 0) throw new ControlClientError("timeout");
				await Bun.sleep(retryDelay);
			}
		}
	})();
}
export class LocalControlClient {
	readonly #endpoint: string;
	readonly #generation: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	constructor(options: ControlClientOptions) {
		this.#endpoint = options.endpoint;
		this.#generation = options.generation;
		this.#token = options.token;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}
	#requireOk(response: ControlResponse): ControlSuccessResponse {
		if (!response.ok) throw new ControlClientError(response.error);
		return response;
	}
	async write(bytes: Uint8Array): Promise<ControlSuccessResponse> {
		if (bytes.length > MAX_CONTROL_WRITE_BYTES) throw new Error("invalid_control_write_request");
		return this.#requireOk(
			await this.call({
				action: "write",
				data: { encoding: "base64", bytes: Buffer.from(bytes).toString("base64") },
			}),
		);
	}
	async resize(columns: number, rows: number): Promise<ControlSuccessResponse> {
		if (
			!Number.isSafeInteger(columns) ||
			!Number.isSafeInteger(rows) ||
			columns < 1 ||
			rows < 1 ||
			columns > MAX_CONTROL_TERMINAL_DIMENSION ||
			rows > MAX_CONTROL_TERMINAL_DIMENSION
		)
			throw new Error("invalid_control_resize_request");
		return this.#requireOk(await this.call({ action: "resize", data: { columns, rows } }));
	}
	async stream(cursor: number | null, maxBytes: number): Promise<ControlStreamResult> {
		if (
			(cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) ||
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1 ||
			maxBytes > MAX_CONTROL_STREAM_BYTES
		)
			throw new Error("invalid_control_stream_request");
		const response = this.#requireOk(await this.call({ action: "stream", data: { cursor, maxBytes } }));
		return decodeStreamResult(response.result, maxBytes);
	}
	call(call: ControlCall): Promise<ControlResponse> {
		const request: ControlRequest = {
			version: CONTROL_PROTOCOL_VERSION,
			id: call.id ?? crypto.randomUUID(),
			action: call.action,
			generation: this.#generation,
			token: this.#token,
			...(call.data === undefined ? {} : { data: call.data }),
		};
		return sendControlRequest(this.#endpoint, request, this.#timeoutMs);
	}
}
