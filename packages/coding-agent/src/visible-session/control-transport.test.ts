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
	decodeControlResponseFrame,
	decodeControlWriteRequest,
	encodeControlFrame,
	MAX_CONTROL_FRAME_BYTES,
	MAX_CONTROL_STREAM_BYTES,
	MAX_CONTROL_TERMINAL_DIMENSION,
	MAX_CONTROL_WRITE_BYTES,
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
		if (process.platform === "win32") socket.write(finalChunk);
		else socket.end(finalChunk);
	});
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

async function sendRawRequest(endpoint: string, chunks: readonly Buffer[]): Promise<unknown> {
	return sendRawFrameChunks(endpoint, [...chunks, CONTROL_REQUEST_END_MARKER]);
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
				version: 1,
				id: "request-1",
				ok: true,
				result: { state: "ready" },
			});
			await expect(sendControlRequest(endpoint, createRequest("b".repeat(64)))).resolves.toMatchObject({
				ok: false,
				error: "unauthorized",
			});
			await expect(sendControlRequest(endpoint, createRequest(token, "wrong-generation"))).resolves.toMatchObject({
				ok: false,
				error: "generation_mismatch",
			});
			await expect(
				sendControlRequest(endpoint, createRequest("b".repeat(64), "wrong-generation")),
			).resolves.toMatchObject({
				ok: false,
				error: "unauthorized",
			});
			expect(observedRequest).toEqual({
				version: 1,
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
			const server = net.createServer(socket =>
				socket.once("data", () =>
					socket.end(encodeControlFrame({ version: 1, id: "request-1", ok: true, result: {} })),
				),
			);
			const request = sendControlRequest(endpoint, createRequest("a".repeat(64)), 250);
			await Bun.sleep(35);
			await listen(server, endpoint);
			await expect(request).resolves.toEqual({ version: 1, id: "request-1", ok: true, result: {} });
			await close(server);
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
		const socket = Object.assign(new events.EventEmitter(), {
			destroy: vi.fn(),
			end: vi.fn(),
			write: vi.fn(),
		}) as unknown as net.Socket;
		const createConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
			queueMicrotask(() => {
				socket.emit("connect");
				socket.emit("data", encodeControlFrame({ version: 1, id: "request-1", ok: true, result: {} }));
				socket.emit("close", false);
			});
			return socket;
		});
		try {
			await expect(sendControlRequest("unused", createRequest("a".repeat(64)), 25)).resolves.toEqual({
				version: 1,
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
			).resolves.toEqual({ version: 1, id: "request-1", ok: false, error: "bad_request" });
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
				expect(response).toEqual({ version: 1, id: "request-1", ok: false, error: "handler_failed" });
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
					version: 1,
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
				const socket = net.createConnection({ path: endpoint });
				const closed = Promise.withResolvers<void>();
				socket.once("error", () => undefined);
				socket.once("close", closed.resolve);
				socket.once("connect", () => {
					const message = Buffer.concat([
						encodeControlFrame(createRequest("a".repeat(64))),
						CONTROL_REQUEST_END_MARKER,
					]);
					socket.end(message);
				});
				await closed.promise;
				expect(calls).toBe(0);
				releaseChmod.resolve();
				await listening;
				await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)))).resolves.toMatchObject({
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
			const wrongId = net.createServer({ allowHalfOpen: true }, socket =>
				socket.once("data", () =>
					socket.end(encodeControlFrame({ version: 1, id: "wrong-id", ok: true, result: {} })),
				),
			);
			await listen(wrongId, endpoint);
			await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)), 100)).rejects.toMatchObject({
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
			const response = await sendControlRequest(endpoint, createRequest("b".repeat(64)));
			expect(response).toMatchObject({ ok: false, error: "unauthorized" });
			await expect(
				new LocalControlClient({ endpoint, generation: "generation-1", token: "b".repeat(64) }).write(
					Uint8Array.of(0),
				),
			).rejects.toMatchObject({ code: "unauthorized" });
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
			const frame = encodeControlFrame(createRequest("a".repeat(64)));
			await expect(sendRawRequest(endpoint, [frame.subarray(0, 3), frame.subarray(3)])).resolves.toMatchObject({
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
			const frame = encodeControlFrame(createRequest("a".repeat(64)));
			await expect(sendRawRequest(endpoint, [Buffer.concat([frame, frame])])).resolves.toMatchObject({
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
			await expect(sendRawRequest(endpoint, [Buffer.alloc(4)])).resolves.toMatchObject({
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
			const socket = net.createConnection({ path: endpoint });
			socket.once("connect", () => {
				const message = Buffer.concat([
					encodeControlFrame(createRequest("a".repeat(64))),
					CONTROL_REQUEST_END_MARKER,
				]);
				if (process.platform === "win32") socket.write(message);
				else socket.end(message);
			});
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
			socket.once("connect", () => socket.write(encodeControlFrame(createRequest("a".repeat(64)))));
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
				requestTimeoutMs: 10,
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
				await expect(sendControlRequest(endpoint, createRequest("a".repeat(64)), 100)).resolves.toEqual({
					version: 1,
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
				expect(responses).toEqual([{ version: 1, id: "request-1", ok: false, error: "timeout" }]);
				await expect(
					sendControlRequest(endpoint, { ...createRequest("a".repeat(64)), id: "request-2" }, 100),
				).resolves.toEqual({ version: 1, id: "request-2", ok: true, result: {} });
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
	it("rejects every malformed request schema before dispatch across frame boundaries", async () => {
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
			const request = createRequest(token);
			const cases: ReadonlyArray<{ name: string; value: unknown }> = [
				{ name: "unknown request key", value: { ...request, extra: true } },
				{
					name: "missing token",
					value: { version: 1, id: request.id, action: "status", generation: request.generation },
				},
				{ name: "noncanonical token", value: { ...request, token: "A".repeat(64) } },
				{ name: "unknown action", value: { ...request, action: "unknown" } },
				{ name: "ready data", value: { ...request, action: "ready", data: {} } },
				{ name: "status data", value: { ...request, action: "status", data: {} } },
				{ name: "heartbeat data", value: { ...request, action: "heartbeat", data: {} } },
				{ name: "cancel data", value: { ...request, action: "cancel", data: {} } },
				{ name: "prompt extra key", value: { ...request, action: "prompt", data: { text: "value", extra: true } } },
				{
					name: "write mixed encoding",
					value: { ...request, action: "write", data: { encoding: "base64", bytes: "AA==", text: "x" } },
				},
				{
					name: "write noncanonical base64",
					value: { ...request, action: "write", data: { encoding: "base64", bytes: "AB==" } },
				},
				{
					name: "resize fractional dimension",
					value: { ...request, action: "resize", data: { columns: 1.5, rows: 1 } },
				},
				{ name: "stream missing max bytes", value: { ...request, action: "stream", data: { cursor: null } } },
			];
			try {
				for (const malformed of cases) {
					const response = await sendRawRequest(endpoint, [encodeRawFrame(malformed.value)]);
					expect(response).toEqual({
						version: 1,
						id: "request-1",
						ok: false,
						error: "bad_request",
					});
				}

				const frame = Buffer.concat([
					encodeRawFrame({ ...request, action: "unknown" }),
					CONTROL_REQUEST_END_MARKER,
				]);
				for (let split = 1; split < frame.length; split += 1) {
					const response = await sendRawFrameChunks(endpoint, [frame.subarray(0, split), frame.subarray(split)]);
					expect(response).toEqual({ version: 1, id: "request-1", ok: false, error: "bad_request" });
				}

				const oversizedHeader = Buffer.allocUnsafe(4);
				oversizedHeader.writeUInt32BE(MAX_CONTROL_FRAME_BYTES + 1, 0);
				await expect(sendRawRequest(endpoint, [oversizedHeader])).resolves.toEqual({
					version: 1,
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
			await server.listen();
			const idleSockets = await Promise.all(
				[0, 1].map(
					() =>
						new Promise<net.Socket>((resolve, reject) => {
							const socket = net.createConnection({ path: endpoint });
							socket.once("connect", () => resolve(socket));
							socket.once("error", reject);
						}),
				),
			);
			const rejected = net.createConnection({ path: endpoint });
			const rejectedClosed = Promise.withResolvers<void>();
			rejected.once("close", rejectedClosed.resolve);
			rejected.once("error", () => undefined);
			await rejectedClosed.promise;
			for (const socket of idleSockets) socket.destroy();
			await Promise.all(idleSockets.map(socket => new Promise<void>(resolve => socket.once("close", resolve))));
			const first = sendControlRequest(endpoint, createRequest(token));
			await firstStarted.promise;
			await expect(sendControlRequest(endpoint, { ...createRequest(token), id: "request-2" })).resolves.toEqual({
				version: 1,
				id: "request-2",
				ok: false,
				error: "timeout",
			});
			releaseFirst.resolve();
			await expect(first).resolves.toEqual({ version: 1, id: "request-1", ok: true, result: { calls: 1 } });
			await expect(sendControlRequest(endpoint, { ...createRequest(token), id: "request-3" })).resolves.toEqual({
				version: 1,
				id: "request-3",
				ok: true,
				result: { calls: 2 },
			});
			await server.close();
		});
	});
});
