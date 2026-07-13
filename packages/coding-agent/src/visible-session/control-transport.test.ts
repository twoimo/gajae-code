import { describe, expect, it, vi } from "bun:test";
import * as events from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { LocalControlClient, sendControlRequest } from "./control-client";
import {
	type AuthenticatedControlRequest,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_REQUEST_END_MARKER,
	ControlFrameDecoder,
	type ControlJson,
	type ControlRequest,
	controlFrameFromBody,
	createControlProof,
	decodeControlChallengeFrame,
	decodeControlHelloFrame,
	decodeControlProofFrame,
	decodeControlRequestCandidateFrame,
	decodeControlResponseFrame,
	decodeControlWriteRequest,
	encodeControlFrame,
	generateControlChallenge,
	generateControlHello,
	MAX_CONTROL_FRAME_BYTES,
	MAX_CONTROL_STREAM_BYTES,
	MAX_CONTROL_TERMINAL_DIMENSION,
	MAX_CONTROL_WRITE_BYTES,
	verifyControlProof,
	withoutControlToken,
} from "./control-protocol";
import { controlEndpointFor, LocalControlServer } from "./control-server";

async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-control-"));
	try {
		return await callback(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

function createRequest(token: string, generation = "generation-1"): ControlRequest {
	return { version: CONTROL_PROTOCOL_VERSION, id: "request-1", action: "status", generation, token };
}
async function listen(server: net.Server, endpoint: string): Promise<void> {
	const deferred = Promise.withResolvers<void>();
	server.once("error", deferred.reject);
	server.listen(endpoint, () => {
		server.removeListener("error", deferred.reject);
		deferred.resolve();
	});
	await deferred.promise;
}

async function close(server: net.Server): Promise<void> {
	const deferred = Promise.withResolvers<void>();
	server.close(() => deferred.resolve());
	await deferred.promise;
}
function encodeRawFrame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(body.length, 0);
	return Buffer.concat([header, body]);
}

async function sendRawFrameChunks(endpoint: string, chunks: readonly Buffer[]): Promise<unknown> {
	const deferred = Promise.withResolvers<unknown>();
	const decoder = new ControlFrameDecoder(1);
	let response: unknown;
	const socket = net.createConnection({ path: endpoint });
	socket.once("connect", () => {
		for (const chunk of chunks.slice(0, -1)) socket.write(chunk);
		const finalChunk = chunks.at(-1);
		if (!finalChunk) {
			socket.destroy();
			return;
		}
		socket.write(finalChunk);
	});
	socket.once("end", () => socket.end());
	socket.on("data", (chunk: Buffer) => {
		const frames = decoder.push(chunk);
		if (frames.length === 1) response = decodeControlResponseFrame(frames[0]);
	});
	socket.once("close", () => {
		try {
			decoder.finish();
			deferred.resolve(response);
		} catch (error) {
			deferred.reject(error);
		} finally {
			socket.destroy();
		}
	});
	socket.once("error", error => {
		socket.destroy();
		deferred.reject(error);
	});
	return deferred.promise;
}

async function sendRawAuthenticatedRequest(
	endpoint: string,
	request: ControlRequest,
	chunkRequest?: (frames: readonly Buffer[]) => readonly Buffer[],
): Promise<unknown> {
	const deferred = Promise.withResolvers<unknown>();
	const hello = generateControlHello();
	const helloFrame = encodeControlFrame(hello);
	const requestFrame = encodeControlFrame(withoutControlToken(request));
	const decoder = new ControlFrameDecoder(2);
	let challengeReceived = false;
	let response: unknown;
	const socket = net.createConnection({ path: endpoint });
	socket.once("connect", () => socket.write(helloFrame));
	socket.once("end", () => socket.end());
	socket.on("data", (chunk: Buffer) => {
		try {
			for (const frame of decoder.push(chunk)) {
				if (!challengeReceived) {
					decodeControlChallengeFrame(frame);
					const challengeFrame = controlFrameFromBody(frame);
					const proof = createControlProof(request.token, helloFrame, challengeFrame, requestFrame);
					const frames = [requestFrame, encodeControlFrame(proof), CONTROL_REQUEST_END_MARKER] as const;
					for (const requestChunk of chunkRequest?.(frames) ?? frames) socket.write(requestChunk);
					challengeReceived = true;
					continue;
				}
				response = decodeControlResponseFrame(frame);
			}
		} catch (error) {
			socket.destroy();
			deferred.reject(error);
		}
	});
	socket.once("close", () => {
		try {
			decoder.finish();
			deferred.resolve(response);
		} catch (error) {
			deferred.reject(error);
		} finally {
			socket.destroy();
		}
	});
	socket.once("error", error => {
		socket.destroy();
		deferred.reject(error);
	});
	return deferred.promise;
}
async function sendRawAfterChallenge(
	endpoint: string,
	chunks: (helloFrame: Buffer, challengeFrame: Buffer) => readonly Buffer[],
): Promise<unknown> {
	const deferred = Promise.withResolvers<unknown>();
	const decoder = new ControlFrameDecoder(2);
	const helloFrame = encodeControlFrame(generateControlHello());
	let challengeReceived = false;
	let response: unknown;
	const socket = net.createConnection({ path: endpoint });
	socket.once("connect", () => socket.write(helloFrame));
	socket.once("end", () => socket.end());
	socket.on("data", (chunk: Buffer) => {
		try {
			for (const frame of decoder.push(chunk)) {
				if (!challengeReceived) {
					decodeControlChallengeFrame(frame);
					const challengeFrame = controlFrameFromBody(frame);
					for (const requestChunk of chunks(helloFrame, challengeFrame)) socket.write(requestChunk);
					challengeReceived = true;
					continue;
				}
				response = decodeControlResponseFrame(frame);
			}
		} catch (error) {
			socket.destroy();
			deferred.reject(error);
		}
	});
	socket.once("close", () => {
		try {
			decoder.finish();
			deferred.resolve(response);
		} catch (error) {
			deferred.reject(error);
		} finally {
			socket.destroy();
		}
	});
	socket.once("error", error => {
		socket.destroy();
		deferred.reject(error);
	});
	return deferred.promise;
}
function rawRequestWithProof(
	token: string,
	helloFrame: Buffer,
	challengeFrame: Buffer,
	requestFrame: Buffer,
	requestChunks: readonly Buffer[] = [requestFrame],
): readonly Buffer[] {
	return [
		...requestChunks,
		encodeControlFrame(createControlProof(token, helloFrame, challengeFrame, requestFrame)),
		CONTROL_REQUEST_END_MARKER,
	];
}

describe.serial("visible session local control transport", () => {
	it("derives stable private endpoints without raw identities", () => {
		const identity = { privateGenerationRoot: "/private/NAME/generation", generation: "generation" };
		expect(controlEndpointFor(identity)).toBe(controlEndpointFor(identity));
		const windows = controlEndpointFor({ ...identity, platform: "win32" });
		expect(windows).toStartWith("\\\\.\\pipe\\gjc-visible-control-v1-");
		expect(windows).not.toContain("NAME");
		expect(windows).not.toContain("generation");
	});

	it("binds, authenticates, correlates, and closes locally", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const token = "a".repeat(64);
			let calls = 0;
			let observedRequest: AuthenticatedControlRequest | undefined;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token,
				handler: async request => {
					calls += 1;
					observedRequest = request;
					return { state: "ready" };
				},
			});
			await server.listen();
			if (process.platform !== "win32") {
				const stat = await fs.lstat(endpoint);
				expect(stat.mode & 0o777).toBe(0o600);
				if (typeof process.getuid === "function") expect(stat.uid).toBe(process.getuid());
			}
			const client = new LocalControlClient({ endpoint, generation: "generation-1", token });
			expect(await client.call({ action: "status", id: "request-1" })).toEqual({
				version: CONTROL_PROTOCOL_VERSION,
				id: "request-1",
				ok: true,
				result: { state: "ready" },
			});
			await expect(sendControlRequest(endpoint, createRequest("b".repeat(64)))).rejects.toMatchObject({
				code: "bad_response",
			});
			await expect(sendControlRequest(endpoint, createRequest(token, "wrong-generation"))).rejects.toMatchObject({
				code: "bad_response",
			});
			await expect(
				sendControlRequest(endpoint, createRequest("b".repeat(64), "wrong-generation")),
			).rejects.toMatchObject({
				code: "bad_response",
			});
			expect(observedRequest).toEqual({
				version: CONTROL_PROTOCOL_VERSION,
				id: "request-1",
				action: "status",
				generation: "generation-1",
			});
			expect(Object.keys(server)).not.toContain("options");
			expect(Object.keys(client)).not.toContain("options");
			expect(calls).toBe(1);
			await server.close();
			if (process.platform !== "win32") await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
	it("withholds tokens and request payloads from a pre-bound server until server authentication", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const token = "a".repeat(64);
			const prompt = "sensitive prompt";
			const captured: Buffer[] = [];
			const hellosCaptured = Promise.withResolvers<void>();
			const fake = net.createServer(socket => {
				const decoder = new ControlFrameDecoder(1);
				socket.on("data", (chunk: Buffer) => {
					for (const frame of decoder.push(chunk)) {
						captured.push(controlFrameFromBody(frame));
						socket.write(
							encodeControlFrame({
								version: CONTROL_PROTOCOL_VERSION,
								type: "challenge",
								endpoint,
								generation: "generation-1",
								nonce: "b".repeat(64),
								proof: "c".repeat(64),
							}),
						);
						if (captured.length === 2) hellosCaptured.resolve();
					}
				});
			});
			await listen(fake, endpoint);
			const client = new LocalControlClient({ endpoint, generation: "generation-1", token });
			await expect(client.call({ action: "prompt", data: { text: prompt } })).rejects.toMatchObject({
				code: "bad_response",
			});
			await expect(client.write(Uint8Array.of(0, 0xff))).rejects.toMatchObject({ code: "bad_response" });
			await hellosCaptured.promise;

			expect(captured).toHaveLength(2);
			for (const frame of captured)
				expect(decodeControlHelloFrame(frame.subarray(4))).toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					type: "hello",
					nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
			const wire = Buffer.concat(captured);
			expect(wire.includes(Buffer.from(token, "utf8"))).toBe(false);
			expect(wire.includes(Buffer.from(prompt, "utf8"))).toBe(false);
			expect(wire.includes(Buffer.from([0, 0xff]))).toBe(false);
			await close(fake);
		});
	});
	it("sends a request only after a server proves the configured endpoint and generation", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const token = "a".repeat(64);
			const received: Buffer[] = [];
			const server = net.createServer({ allowHalfOpen: true }, socket => {
				const decoder = new ControlFrameDecoder(3, true);
				let challengeFrame: Buffer | undefined;
				socket.on("data", (chunk: Buffer) => {
					const frames = decoder.push(chunk);
					for (const frame of frames) received.push(controlFrameFromBody(frame));
					if (received.length === 1) {
						const hello = decodeControlHelloFrame(received[0].subarray(4));
						const challenge = generateControlChallenge(token, endpoint, "generation-1", hello);
						challengeFrame = encodeControlFrame(challenge);
						socket.write(challengeFrame);
					}
					if (!decoder.ended || received.length !== 3 || !challengeFrame) return;
					const proof = decodeControlProofFrame(received[2].subarray(4));
					expect(verifyControlProof(token, received[0], challengeFrame, received[1], proof)).toBe(true);
					expect(decodeControlRequestCandidateFrame(received[1].subarray(4))).toMatchObject({
						action: "prompt",
						data: { text: "authenticated prompt" },
					});
					socket.end(
						encodeControlFrame({
							version: CONTROL_PROTOCOL_VERSION,
							id: "request-1",
							ok: true,
							result: {},
						}),
					);
				});
			});
			await listen(server, endpoint);
			await expect(
				sendControlRequest(endpoint, {
					...createRequest(token),
					action: "prompt",
					data: { text: "authenticated prompt" },
				}),
			).resolves.toEqual({
				version: CONTROL_PROTOCOL_VERSION,
				id: "request-1",
				ok: true,
				result: {},
			});
			expect(received).toHaveLength(3);
			await close(server);
		});
	});
	it("rejects timer values outside Node's supported delay range", () => {
		const timeout = 2_147_483_648;
		expect(() => sendControlRequest("unused", createRequest("a".repeat(64)), timeout)).toThrow(
			"invalid_control_client_timeout",
		);
		expect(
			() =>
				new LocalControlServer({
					endpoint: "unused",
					generation: "generation-1",
					token: "a".repeat(64),
					idleTimeoutMs: timeout,
					handler: async () => ({}),
				}),
		).toThrow("invalid_control_server_limits");
	});
	it("retries transient pre-connect endpoint failures within the original timeout", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			await server.listen();
			const transient = Object.assign(new Error("endpoint not ready"), { code: "ENOENT" });
			const socket = new net.Socket();
			const createConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
				queueMicrotask(() => {
					createConnection.mockRestore();
					socket.emit("error", transient);
				});
				return socket;
			});
			try {
				await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)), 1_000)).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: true,
					result: {},
				});
			} finally {
				createConnection.mockRestore();
				await server.close();
			}
		});
	});
	it("does not retry failures after connecting", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const server = net.createServer(socket => socket.destroy());
			await listen(server, endpoint);
			const createConnection = vi.spyOn(net, "createConnection");
			try {
				await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)), 250)).rejects.toBeDefined();
				expect(createConnection).toHaveBeenCalledTimes(1);
			} finally {
				createConnection.mockRestore();
				await close(server);
			}
		});
	});
	it("accepts a complete response when the peer closes without an end event", async () => {
		const writes: Buffer[] = [];
		const socket = new events.EventEmitter() as unknown as net.Socket;
		Object.assign(socket, {
			destroy: vi.fn(),
			end: vi.fn(),
			write: vi.fn((chunk: Uint8Array) => {
				writes.push(Buffer.from(chunk));
				if (writes.length === 1) {
					const hello = decodeControlHelloFrame(writes[0].subarray(4));
					queueMicrotask(() =>
						socket.emit(
							"data",
							encodeControlFrame(generateControlChallenge("a".repeat(64), "unused", "generation-1", hello)),
						),
					);
				}
				if (writes.length === 4)
					queueMicrotask(() => {
						socket.emit(
							"data",
							encodeControlFrame({
								version: CONTROL_PROTOCOL_VERSION,
								id: "request-1",
								ok: true,
								result: {},
							}),
						);
						socket.emit("close", false);
					});
			}),
		});
		const createConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
			queueMicrotask(() => socket.emit("connect"));
			return socket;
		});
		try {
			await expect(sendControlRequest("unused", createRequest("a".repeat(64)), 25)).resolves.toEqual({
				version: CONTROL_PROTOCOL_VERSION,
				id: "request-1",
				ok: true,
				result: {},
			});
		} finally {
			createConnection.mockRestore();
		}
	});
	it("retains nontransient connection causes without exposing request data", async () => {
		const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const socket = new net.Socket();
		const createConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
			queueMicrotask(() => socket.emit("error", cause));
			return socket;
		});
		try {
			const failure = await sendControlRequest("unused", createRequest("a".repeat(64))).then(
				() => new Error("expected request failure"),
				error => error,
			);
			expect(failure).toMatchObject({ code: "connect_failed", cause });
		} finally {
			createConnection.mockRestore();
		}
	});
	it("sends byte-exact writes and typed resizes through authenticated control requests", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const writes: Uint8Array[] = [];
			const resizes: Array<{ columns: number; rows: number }> = [];
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async request => {
					if (request.action === "write") writes.push(decodeControlWriteRequest(request));
					if (request.action === "resize") {
						const data = request.data;
						if (
							typeof data !== "object" ||
							data === null ||
							Array.isArray(data) ||
							typeof data.columns !== "number" ||
							typeof data.rows !== "number"
						)
							throw new Error("invalid resize");
						resizes.push({ columns: data.columns, rows: data.rows });
					}
					return {};
				},
			});
			await server.listen();
			const client = new LocalControlClient({ endpoint, generation: "generation-1", token: "a".repeat(64) });
			const raw = Uint8Array.from([0, 0xff, 0x80, 0x0a, 0x1b]);
			await expect(client.write(raw)).resolves.toMatchObject({ ok: true });
			await expect(client.resize(120, 40)).resolves.toMatchObject({ ok: true });
			expect(writes).toEqual([raw]);
			expect(resizes).toEqual([{ columns: 120, rows: 40 }]);
			await server.close();
		});
	});
	it("rejects oversized writes before connecting or dispatching", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			await server.listen();
			const createConnection = vi.spyOn(net, "createConnection");
			try {
				const client = new LocalControlClient({ endpoint, generation: "generation-1", token: "a".repeat(64) });
				await expect(client.write(new Uint8Array(MAX_CONTROL_WRITE_BYTES + 1))).rejects.toThrow(
					"invalid_control_write_request",
				);
				expect(createConnection).not.toHaveBeenCalled();
				expect(calls).toBe(0);
			} finally {
				createConnection.mockRestore();
				await server.close();
			}
		});
	});
	it("rejects out-of-range resize requests before dispatch", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			await server.listen();
			const client = new LocalControlClient({ endpoint, generation: "generation-1", token: "a".repeat(64) });
			await expect(client.resize(MAX_CONTROL_TERMINAL_DIMENSION + 1, 1)).rejects.toThrow(
				"invalid_control_resize_request",
			);
			await expect(
				sendControlRequest(endpoint, {
					...createRequest("a".repeat(64)),
					action: "resize",
					data: { columns: MAX_CONTROL_TERMINAL_DIMENSION + 1, rows: 1 },
				}),
			).resolves.toEqual({ version: CONTROL_PROTOCOL_VERSION, id: "request-1", ok: false, error: "bad_request" });
			expect(calls).toBe(0);
			await server.close();
		});
	});
	it("streams authenticated byte chunks with bounded cursor requests", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const requests: AuthenticatedControlRequest[] = [];
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async request => {
					requests.push(request);
					return {
						startCursor: 7,
						endCursor: 10,
						bytes: Buffer.from([0, 0xff, 0x80]).toString("base64"),
						truncated: false,
						running: true,
					};
				},
			});
			await server.listen();
			const client = new LocalControlClient({ endpoint, generation: "generation-1", token: "a".repeat(64) });
			await expect(client.stream(null, MAX_CONTROL_STREAM_BYTES)).resolves.toEqual({
				startCursor: 7,
				endCursor: 10,
				bytes: Uint8Array.from([0, 0xff, 0x80]),
				truncated: false,
				running: true,
			});
			expect(requests).toEqual([
				{
					version: CONTROL_PROTOCOL_VERSION,
					id: expect.any(String),
					action: "stream",
					generation: "generation-1",
					data: { cursor: null, maxBytes: MAX_CONTROL_STREAM_BYTES },
				},
			]);
			await expect(client.stream(-1, 1)).rejects.toThrow("invalid_control_stream_request");
			await expect(client.stream(0, 0)).rejects.toThrow("invalid_control_stream_request");
			await server.close();
		});
	});
	it("rejects malformed stream result data", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const results: ControlJson[] = [
				{ startCursor: 0, endCursor: 1, bytes: "AA=", truncated: false, running: true },
				{ startCursor: -1, endCursor: 0, bytes: "", truncated: false, running: true },
				{ startCursor: 2, endCursor: 1, bytes: "", truncated: false, running: true },
				{ startCursor: 0, endCursor: 0, bytes: "", truncated: false, running: true, extra: true },
				{ startCursor: 0, endCursor: 2, bytes: "AAE=", truncated: false, running: true },
			];
			let index = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => results[index++],
			});
			await server.listen();
			const client = new LocalControlClient({ endpoint, generation: "generation-1", token: "a".repeat(64) });
			for (let attempt = 0; attempt < results.length; attempt += 1)
				await expect(client.stream(0, 1)).rejects.toMatchObject({ code: "bad_response" });
			await server.close();
		});
	});
	it("requires an OK response from typed control helpers", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => {
					throw new Error("rejected");
				},
			});
			await server.listen();
			const client = new LocalControlClient({ endpoint, generation: "generation-1", token: "a".repeat(64) });
			await expect(client.write(Uint8Array.of(0))).rejects.toMatchObject({ code: "handler_failed" });
			await expect(client.resize(1, 1)).rejects.toMatchObject({ code: "handler_failed" });
			await expect(client.stream(null, 1)).rejects.toMatchObject({ code: "handler_failed" });
			await server.close();
		});
	});

	it("maps invalid handler output and secret-bearing failures to generic wire rejections while retaining private causes", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const token = "a".repeat(64);
			const invalidResult = new Date();
			const handlerFailure = new Error(`handler saw ${token}`);
			const privateFailures: Error[] = [];
			let attempt = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token,
				handler: async () => {
					attempt += 1;
					if (attempt === 1) return invalidResult as unknown as ControlJson;
					throw handlerFailure;
				},
				onHandlerFailure: error => {
					privateFailures.push(error);
					if (privateFailures.length === 1) throw new Error("diagnostic sink failed");
				},
			});
			await server.listen();
			for (let index = 0; index < 2; index += 1) {
				const response = await sendControlRequest(endpoint, createRequest(token));
				expect(response).toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: false,
					error: "handler_failed",
				});
				expect(JSON.stringify(response)).not.toContain(token);
			}
			expect(privateFailures).toHaveLength(2);
			expect(privateFailures[0]).toMatchObject({
				message: "control_handler_invalid_result",
				cause: invalidResult,
			});
			expect(privateFailures[1]).toBe(handlerFailure);
			await server.close();
		});
	});
	it("rejects non-inert handler results before serialization", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const sparse: unknown[] = [];
			sparse.length = 1;
			const accessor = Object.create(Object.prototype) as Record<string, unknown>;
			Object.defineProperty(accessor, "value", { enumerable: true, get: () => "unstable" });
			const withToJson = Object.create(Object.prototype) as Record<string, unknown>;
			Object.defineProperty(withToJson, "toJSON", { enumerable: false, value: () => ({ leaked: true }) });
			const cyclic = Object.create(Object.prototype) as Record<string, unknown>;
			cyclic.self = cyclic;
			const results: ControlJson[] = [
				sparse as unknown as ControlJson,
				accessor as unknown as ControlJson,
				withToJson as unknown as ControlJson,
				cyclic as unknown as ControlJson,
				{ value: Number.NaN },
			];
			let index = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => results[index++]!,
			});
			await server.listen();
			for (let attempt = 0; attempt < results.length; attempt += 1)
				await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)))).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: false,
					error: "handler_failed",
				});
			await server.close();
		});
	});
	it("fails closed for an existing unix endpoint without deleting it", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const stale = net.createServer();
			await listen(stale, endpoint);
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			await expect(server.listen()).rejects.toThrow("control_endpoint_exists");
			expect((await fs.lstat(endpoint)).isSocket()).toBe(true);
			await close(stale);
		});
	});
	it("fails closed for a symlinked unix endpoint parent", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const linked = path.join(root, "linked");
			await fs.symlink(root, linked);
			const server = new LocalControlServer({
				endpoint: path.join(linked, "control-v1.sock"),
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			await expect(server.listen()).rejects.toThrow("control_endpoint_parent_unsafe");
			await expect(fs.lstat(path.join(root, "control-v1.sock"))).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
	it("rejects group-writable unix endpoint parents", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			await fs.chmod(root, 0o770);
			try {
				const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
				const server = new LocalControlServer({
					endpoint,
					generation: "generation-1",
					token: "a".repeat(64),
					handler: async () => ({}),
				});
				await expect(server.listen()).rejects.toThrow("control_endpoint_parent_unsafe");
				await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await fs.chmod(root, 0o700);
			}
		});
	});

	it("cleans up the bound unix socket when post-bind hardening fails", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const chmod = vi.spyOn(fs, "chmod").mockImplementation(async target => {
				if (target === endpoint) throw new Error("chmod failed");
			});
			try {
				const fatal: Error[] = [];
				const server = new LocalControlServer({
					endpoint,
					generation: "generation-1",
					token: "a".repeat(64),
					handler: async () => ({}),
					onFatalError: error => fatal.push(error),
				});
				await expect(server.listen()).rejects.toThrow("chmod failed");
				expect(fatal.map(error => error.message)).toEqual(["chmod failed"]);
				await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				chmod.mockRestore();
			}
		});
	});
	it("does not dispatch until endpoint hardening completes", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const chmodStarted = Promise.withResolvers<void>();
			const releaseChmod = Promise.withResolvers<void>();
			const originalChmod = fs.chmod;
			const chmod = vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
				if (target === endpoint) {
					chmodStarted.resolve();
					await releaseChmod.promise;
				}
				await originalChmod(target, mode);
			});
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			const listening = server.listen();
			try {
				await chmodStarted.promise;
				const pendingRequest = sendControlRequest(endpoint, createRequest("a".repeat(64)));
				await Bun.sleep(25);
				expect(calls).toBe(0);
				releaseChmod.resolve();
				await listening;
				await expect(pendingRequest).resolves.toMatchObject({
					ok: true,
				});
				expect(calls).toBe(1);
			} finally {
				releaseChmod.resolve();
				await listening.catch(() => undefined);
				chmod.mockRestore();
				await server.close();
			}
		});
	});
	it("fails closed when chmod does not harden the endpoint mode", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const originalChmod = fs.chmod;
			const originalLstat = fs.lstat;
			const chmod = vi.spyOn(fs, "chmod").mockImplementation(async () => undefined);
			let endpointLstats = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async target => {
				if (target === endpoint && ++endpointLstats === 2) await originalChmod(endpoint, 0o640);
				return originalLstat(target);
			}) as typeof fs.lstat);
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			try {
				await expect(server.listen()).rejects.toThrow("control_endpoint_unsafe");
				await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				lstat.mockRestore();
				chmod.mockRestore();
				await server.close();
			}
		});
	});
	it("rolls back a captured unix endpoint when parent verification fails", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const hardeningError = new Error("post-bind parent verification failed");
			const originalLstat = fs.lstat;
			let rootLstats = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async target => {
				if (target === root && ++rootLstats === 2) throw hardeningError;
				return originalLstat(target);
			}) as typeof fs.lstat);
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			try {
				await expect(server.listen()).rejects.toThrow(hardeningError.message);
				await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				lstat.mockRestore();
				await server.close();
			}
		});
	});
	it("retries pre-identity capture during unix rollback before retaining cleanup state", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const identityError = new Error("post-bind identity capture failed");
			const originalLstat = fs.lstat;
			const capturedStats: unknown[] = [];
			let endpointLstats = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async target => {
				if (target !== endpoint) return originalLstat(target);
				endpointLstats++;
				if (endpointLstats === 2) {
					capturedStats.push(await originalLstat(target));
					throw identityError;
				}
				if (endpointLstats === 3 && capturedStats[0]) return capturedStats[0] as never;
				return originalLstat(target);
			}) as typeof fs.lstat);
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			try {
				await expect(server.listen()).rejects.toThrow(identityError.message);
				expect(endpointLstats).toBe(4);
				await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				lstat.mockRestore();
				await server.close();
			}
		});
	});
	it("retains a pre-identity rollback failure without unlinking an unverified endpoint", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const identityError = new Error("post-bind identity capture failed");
			const cleanupError = new Error("rollback identity capture failed");
			const originalLstat = fs.lstat;
			const unlink = vi.spyOn(fs, "unlink");
			let endpointLstats = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async target => {
				if (target !== endpoint) return originalLstat(target);
				endpointLstats++;
				if (endpointLstats === 1) return originalLstat(target);
				if (endpointLstats === 2) throw identityError;
				throw cleanupError;
			}) as typeof fs.lstat);
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			try {
				const failure = await server.listen().then(
					() => new Error("expected listen failure"),
					error => error,
				);
				expect(failure).toBeInstanceOf(AggregateError);
				if (!(failure instanceof AggregateError)) throw new Error("expected AggregateError");
				expect(failure.errors).toEqual([identityError, cleanupError, cleanupError]);
				expect(unlink).not.toHaveBeenCalledWith(endpoint);
			} finally {
				lstat.mockRestore();
				unlink.mockRestore();
				await server.close();
			}
		});
	});
	it("rolls back when a fatal observer throws during hardening", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const hardeningError = new Error("chmod failed");
			const observerError = new Error("fatal observer failed");
			const chmod = vi.spyOn(fs, "chmod").mockImplementation(async target => {
				if (target === endpoint) throw hardeningError;
			});
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
				onFatalError: () => {
					throw observerError;
				},
			});
			try {
				const failure = await server.listen().then(
					() => new Error("expected listen failure"),
					error => error,
				);
				expect(failure).toBeInstanceOf(AggregateError);
				if (!(failure instanceof AggregateError)) throw new Error("expected AggregateError");
				expect(failure.errors).toEqual([hardeningError, observerError]);
				await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				chmod.mockRestore();
				await server.close();
			}
		});
	});

	it("rejects mismatched response IDs and times out without a response", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const wrongId = net.createServer({ allowHalfOpen: true }, socket => {
				const decoder = new ControlFrameDecoder(3, true);
				let challengeSent = false;
				socket.on("data", (chunk: Buffer) => {
					const frames = decoder.push(chunk);
					if (!challengeSent && frames.length > 0) {
						const hello = decodeControlHelloFrame(frames[0]);
						socket.write(
							encodeControlFrame(generateControlChallenge("a".repeat(64), endpoint, "generation-1", hello)),
						);
						challengeSent = true;
					}
					if (decoder.ended)
						socket.end(
							encodeControlFrame({
								version: CONTROL_PROTOCOL_VERSION,
								id: "wrong-id",
								ok: true,
								result: {},
							}),
						);
				});
			});
			await listen(wrongId, endpoint);
			await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)), 1_000)).rejects.toMatchObject({
				code: "request_id_mismatch",
			});
			await close(wrongId);

			const noResponse = net.createServer({ allowHalfOpen: true }, () => undefined);
			await listen(noResponse, endpoint);
			await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)), 25)).rejects.toMatchObject({
				code: "timeout",
			});
			await close(noResponse);
		});
	});

	it("never dispatches unauthenticated frames", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				idleTimeoutMs: 25,
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			await server.listen();
			await expect(sendControlRequest(endpoint, createRequest("b".repeat(64)))).rejects.toMatchObject({
				code: "bad_response",
			});
			await expect(
				new LocalControlClient({ endpoint, generation: "generation-1", token: "b".repeat(64) }).write(
					Uint8Array.of(0),
				),
			).rejects.toMatchObject({ code: "bad_response" });
			expect(calls).toBe(0);
			await server.close();
		});
	});
	it("collects a split frame through EOF and dispatches exactly once", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => {
					calls += 1;
					return { calls };
				},
			});
			await server.listen();
			await expect(
				sendRawAuthenticatedRequest(endpoint, createRequest("a".repeat(64)), frames => {
					const combined = Buffer.concat(frames);
					return [combined.subarray(0, 3), combined.subarray(3)];
				}),
			).resolves.toMatchObject({
				ok: true,
				result: { calls: 1 },
			});
			expect(calls).toBe(1);
			await server.close();
		});
	});

	it("rejects coalesced trailing frames before dispatch", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			await server.listen();
			await expect(
				sendRawAuthenticatedRequest(endpoint, createRequest("a".repeat(64)), frames => [
					Buffer.concat([...frames, frames[1]]),
				]),
			).resolves.toMatchObject({
				ok: false,
				error: "too_many_frames",
			});
			expect(calls).toBe(0);
			await server.close();
		});
	});
	it("rejects malformed socket frames without dispatching", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			await server.listen();
			await expect(sendRawFrameChunks(endpoint, [Buffer.alloc(4)])).resolves.toMatchObject({
				ok: false,
				error: "bad_frame",
			});
			expect(calls).toBe(0);
			await server.close();
		});
	});

	it("aborts handler work when its peer disconnects", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const started = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async (_request, context) => {
					started.resolve();
					await new Promise<void>(resolve =>
						context.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
					aborted.resolve();
					return {};
				},
			});
			await server.listen();
			const token = "a".repeat(64);
			const hello = generateControlHello();
			const helloFrame = encodeControlFrame(hello);
			const requestFrame = encodeControlFrame(withoutControlToken(createRequest(token)));
			const socket = net.createConnection({ path: endpoint });
			const decoder = new ControlFrameDecoder(1);
			socket.once("connect", () => socket.write(helloFrame));
			socket.on("data", (chunk: Buffer) => {
				for (const frame of decoder.push(chunk)) {
					const proof = createControlProof(token, helloFrame, controlFrameFromBody(frame), requestFrame);
					socket.write(Buffer.concat([requestFrame, encodeControlFrame(proof), CONTROL_REQUEST_END_MARKER]));
				}
			});
			socket.once("error", () => undefined);
			await started.promise;
			socket.destroy();
			await aborted.promise;
			await server.close();
		});
	});

	it("does not enter a handler after the request deadline expires", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				requestTimeoutMs: 10,
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			await server.listen();
			const socket = net.createConnection({ path: endpoint });
			const closed = Promise.withResolvers<void>();
			socket.once("close", closed.resolve);
			socket.once("connect", () => socket.write(encodeControlFrame(generateControlHello())));
			await Bun.sleep(25);
			socket.end();
			await closed.promise;
			expect(calls).toBe(0);
			await server.close();
		});
	});
	it("maps a post-deadline handler rejection to timeout before the abort timer fires", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			let lateDeadline = 0;
			const realNow = Date.now.bind(Date);
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				now: () => (lateDeadline === 0 ? realNow() : lateDeadline),
				handler: async (_request, context) => {
					lateDeadline = context.deadline;
					expect(context.signal.aborted).toBe(false);
					throw new Error("late rejection");
				},
			});
			await server.listen();
			try {
				await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)))).resolves.toMatchObject({
					ok: false,
					error: "timeout",
				});
			} finally {
				await server.close();
			}
		});
	});
	it("finalizes exactly one timeout response when an aborted handler settles afterward", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const handlerSettled = Promise.withResolvers<void>();
			const end = vi.spyOn(net.Socket.prototype, "end");
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				requestTimeoutMs: 1_000,
				maxConnections: 1,
				handler: async (_request, context) => {
					calls++;
					if (calls > 1) return {};
					await new Promise<void>(resolve => {
						if (context.signal.aborted) {
							resolve();
							return;
						}
						context.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					handlerSettled.resolve();
					return {};
				},
			});
			await server.listen();
			try {
				await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)), 3_000)).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: false,
					error: "timeout",
				});
				await handlerSettled.promise;
				await Bun.sleep(0);
				const responses = end.mock.calls.flatMap(([chunk]) => {
					if (!Buffer.isBuffer(chunk)) return [];
					try {
						return [decodeControlResponseFrame(chunk.subarray(4))];
					} catch {
						return [];
					}
				});
				expect(responses).toEqual([
					{ version: CONTROL_PROTOCOL_VERSION, id: "request-1", ok: false, error: "timeout" },
				]);
				await expect(
					sendControlRequest(endpoint, { ...createRequest("a".repeat(64)), id: "request-2" }, 1_000),
				).resolves.toEqual({ version: CONTROL_PROTOCOL_VERSION, id: "request-2", ok: true, result: {} });
			} finally {
				end.mockRestore();
				await server.close();
			}
		});
	});
	it("preserves hardening and rollback failures in order", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const hardeningError = new Error("chmod failed");
			const rollbackError = new Error("rollback lstat failed");
			const chmod = vi.spyOn(fs, "chmod").mockImplementation(async target => {
				if (target === endpoint) throw hardeningError;
			});
			const originalLstat = fs.lstat;
			let endpointLstats = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async target => {
				if (target === endpoint && ++endpointLstats === 3) throw rollbackError;
				return originalLstat(target);
			}) as typeof fs.lstat);
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token: "a".repeat(64),
				handler: async () => ({}),
			});
			try {
				const failure = await server.listen().then(
					() => new Error("expected listen failure"),
					error => error,
				);
				expect(failure).toBeInstanceOf(AggregateError);
				if (!(failure instanceof AggregateError)) throw new Error("expected AggregateError");
				expect(failure.errors).toEqual([hardeningError, rollbackError]);
			} finally {
				chmod.mockRestore();
				lstat.mockRestore();
				await server.close();
				await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			}
		});
	});
	it("rejects malformed, reordered, and invalid-proof requests before dispatch", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const token = "a".repeat(64);
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token,
				handler: async () => {
					calls += 1;
					return {};
				},
			});
			await server.listen();
			const candidate = withoutControlToken(createRequest(token));
			const cases: ReadonlyArray<{ value: unknown; id: string }> = [
				{ value: { ...candidate, extra: true }, id: "0" },
				{ value: { ...candidate, token }, id: "0" },
				{ value: { ...candidate, version: 1 }, id: "0" },
				{ value: { ...candidate, action: "unknown" }, id: "0" },
				{ value: { ...candidate, action: "ready", data: {} }, id: "request-1" },
				{
					value: { ...candidate, action: "prompt", data: { text: "value", extra: true } },
					id: "request-1",
				},
				{
					value: { ...candidate, action: "write", data: { encoding: "base64", bytes: "AB==" } },
					id: "request-1",
				},
				{ value: { ...candidate, action: "resize", data: { columns: 1.5, rows: 1 } }, id: "request-1" },
				{ value: { ...candidate, action: "stream", data: { cursor: null } }, id: "request-1" },
			];
			try {
				for (const malformed of cases) {
					const requestFrame = encodeRawFrame(malformed.value);
					await expect(
						sendRawAfterChallenge(endpoint, (helloFrame, challengeFrame) =>
							rawRequestWithProof(token, helloFrame, challengeFrame, requestFrame),
						),
					).resolves.toEqual({
						version: CONTROL_PROTOCOL_VERSION,
						id: malformed.id,
						ok: false,
						error: "bad_request",
					});
				}

				const malformedFrame = encodeRawFrame({ ...candidate, action: "unknown" });
				const splits = [1, 3, 4, 5, Math.floor(malformedFrame.length / 2), malformedFrame.length - 1];
				for (const split of new Set(splits.filter(value => value > 0 && value < malformedFrame.length))) {
					await expect(
						sendRawAfterChallenge(endpoint, (helloFrame, challengeFrame) =>
							rawRequestWithProof(token, helloFrame, challengeFrame, malformedFrame, [
								malformedFrame.subarray(0, split),
								malformedFrame.subarray(split),
							]),
						),
					).resolves.toEqual({
						version: CONTROL_PROTOCOL_VERSION,
						id: "0",
						ok: false,
						error: "bad_request",
					});
				}

				const requestFrame = encodeControlFrame(candidate);
				const replayHello = encodeControlFrame(generateControlHello());
				const replayChallenge = generateControlChallenge(
					token,
					endpoint,
					"generation-1",
					decodeControlHelloFrame(replayHello.subarray(4)),
				);
				const replayProof = createControlProof(
					token,
					replayHello,
					encodeControlFrame(replayChallenge),
					requestFrame,
				);
				await expect(
					sendRawAfterChallenge(endpoint, (helloFrame, challengeFrame) => {
						const proof = createControlProof(token, helloFrame, challengeFrame, requestFrame);
						return [encodeControlFrame(proof), requestFrame, CONTROL_REQUEST_END_MARKER];
					}),
				).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "0",
					ok: false,
					error: "bad_frame",
				});
				await expect(
					sendRawAfterChallenge(endpoint, () => [requestFrame, CONTROL_REQUEST_END_MARKER]),
				).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: false,
					error: "bad_frame",
				});
				await expect(
					sendRawAfterChallenge(endpoint, (helloFrame, challengeFrame) => {
						const proof = createControlProof(token, helloFrame, challengeFrame, requestFrame);
						return [
							requestFrame,
							encodeControlFrame({ ...proof, proof: "b".repeat(64) }),
							CONTROL_REQUEST_END_MARKER,
						];
					}),
				).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: false,
					error: "unauthorized",
				});
				await expect(
					sendRawAfterChallenge(endpoint, () => [
						requestFrame,
						encodeControlFrame(replayProof),
						CONTROL_REQUEST_END_MARKER,
					]),
				).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: false,
					error: "unauthorized",
				});

				const oversizedHeader = Buffer.allocUnsafe(4);
				oversizedHeader.writeUInt32BE(MAX_CONTROL_FRAME_BYTES + 1, 0);
				await expect(sendRawFrameChunks(endpoint, [oversizedHeader])).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "0",
					ok: false,
					error: "bad_frame",
				});
				expect(calls).toBe(0);
			} finally {
				await server.close();
			}
		});
	});
	it("bounds connections and handlers while recovering counters after rejected work", async () => {
		await withTempDir(async root => {
			const endpoint = controlEndpointFor({ privateGenerationRoot: root, generation: "generation-1" });
			const token = "a".repeat(64);
			const releaseFirst = Promise.withResolvers<void>();
			const firstStarted = Promise.withResolvers<void>();
			const servers: net.Server[] = [];
			const originalCreateServer = net.createServer;
			const createServer = vi
				.spyOn(net, "createServer")
				.mockImplementation(
					(
						options?: net.ServerOpts | ((socket: net.Socket) => void),
						connectionListener?: (socket: net.Socket) => void,
					): net.Server => {
						const rawServer =
							typeof options === "function"
								? originalCreateServer(options)
								: originalCreateServer(options, connectionListener);
						servers.push(rawServer);
						return rawServer;
					},
				);
			let calls = 0;
			const server = new LocalControlServer({
				endpoint,
				generation: "generation-1",
				token,
				maxConnections: 2,
				maxInFlightHandlers: 1,
				handler: async () => {
					calls += 1;
					if (calls === 1) {
						firstStarted.resolve();
						await releaseFirst.promise;
					}
					return { calls };
				},
			});
			try {
				await server.listen();
				const rawServer = servers.at(0);
				if (!rawServer) throw new Error("control_server_not_created");
				const connectIdle = async (): Promise<{ client: net.Socket; peer: net.Socket }> => {
					const accepted = Promise.withResolvers<net.Socket>();
					rawServer.once("connection", socket => accepted.resolve(socket));
					const connected = Promise.withResolvers<void>();
					const client = net.createConnection({ path: endpoint });
					client.on("data", () => undefined);
					client.on("error", () => undefined);
					client.once("connect", () => connected.resolve());
					client.once("error", connected.reject);
					const [peer] = await Promise.all([accepted.promise, connected.promise]);
					return { client, peer };
				};
				const idleSockets = [await connectIdle(), await connectIdle()];
				const rejected = net.createConnection({ path: endpoint });
				const rejectedClosed = Promise.withResolvers<void>();
				rejected.once("close", () => rejectedClosed.resolve());
				rejected.on("error", () => undefined);
				await rejectedClosed.promise;
				await Promise.all(
					idleSockets.map(({ client, peer }) => {
						const clientClosed = Promise.withResolvers<void>();
						const peerClosed = Promise.withResolvers<void>();
						client.once("close", () => clientClosed.resolve());
						peer.once("close", () => peerClosed.resolve());
						client.destroy();
						peer.destroy();
						return Promise.all([clientClosed.promise, peerClosed.promise]);
					}),
				);
				const first = sendControlRequest(endpoint, createRequest(token));
				await firstStarted.promise;
				await expect(sendControlRequest(endpoint, { ...createRequest(token), id: "request-2" })).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-2",
					ok: false,
					error: "timeout",
				});
				releaseFirst.resolve();
				await expect(first).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-1",
					ok: true,
					result: { calls: 1 },
				});
				await expect(sendControlRequest(endpoint, { ...createRequest(token), id: "request-3" })).resolves.toEqual({
					version: CONTROL_PROTOCOL_VERSION,
					id: "request-3",
					ok: true,
					result: { calls: 2 },
				});
			} finally {
				createServer.mockRestore();
				await server.close();
			}
		});
	});
});
