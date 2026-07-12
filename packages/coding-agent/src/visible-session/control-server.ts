import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import {
	type AuthenticatedControlRequest,
	CONTROL_PROTOCOL_VERSION,
	type ControlErrorCode,
	ControlFrameDecoder,
	type ControlJson,
	ControlProtocolError,
	type ControlRequest,
	type ControlResponse,
	decodeControlRequestFrame,
	encodeControlFrame,
	snapshotControlJson,
	verifyControlToken,
} from "./control-protocol";

export interface ControlEndpointIdentity {
	privateGenerationRoot: string;
	generation: string;
	platform?: NodeJS.Platform;
}
export interface ControlHandlerContext {
	signal: AbortSignal;
	deadline: number;
}
export interface ControlServerOptions {
	endpoint: string;
	generation: string;
	token: string;
	handler: (request: AuthenticatedControlRequest, context: ControlHandlerContext) => Promise<ControlJson>;
	onFatalError?: (error: Error) => void;
	/**
	 * Receives handler failures privately. This callback is never exposed on the control wire;
	 * errors it throws are contained.
	 */
	onHandlerFailure?: (error: Error) => void;
	idleTimeoutMs?: number;
	requestTimeoutMs?: number;
	maxConnections?: number;
	maxInFlightHandlers?: number;
	now?: () => number;
}
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_HANDLERS = 16;
/** Node timer delays are limited to signed 32-bit milliseconds. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function controlEndpointFor(identity: ControlEndpointIdentity): string {
	if ((identity.platform ?? process.platform) === "win32") {
		const digest = crypto
			.createHash("sha256")
			.update(`${identity.privateGenerationRoot}\u0000${identity.generation}`, "utf8")
			.digest("hex");
		return `\\\\.\\pipe\\gjc-visible-control-v1-${digest.slice(0, 40)}`;
	}
	return path.join(identity.privateGenerationRoot, "control-v1.sock");
}
function safeError(id: string, error: ControlErrorCode): ControlResponse {
	return { version: CONTROL_PROTOCOL_VERSION, id, ok: false, error };
}
function withoutControlToken(request: ControlRequest): AuthenticatedControlRequest {
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

function safeId(value: unknown): string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : "0";
}
function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function asError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(fallback, { cause: error });
}
function appendErrors(errors: Error[], error: unknown, fallback: string): void {
	if (error instanceof AggregateError) errors.push(...error.errors.map(nested => asError(nested, fallback)));
	else errors.push(asError(error, fallback));
}

function safeRequestIdFromFrame(frame: Uint8Array): string {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
		return typeof value === "object" && value !== null && "id" in value ? safeId(value.id) : "0";
	} catch {
		return "0";
	}
}

function currentUid(): number | null {
	if (typeof process.getuid !== "function") return null;
	const uid = process.getuid();
	return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function isOwnedByCurrentUser(stat: { uid?: number }): boolean {
	const uid = currentUid();
	return uid !== null && Number.isSafeInteger(stat.uid) && stat.uid === uid;
}

async function verifyUnixEndpointParent(endpoint: string): Promise<void> {
	const parent = path.dirname(endpoint);
	const stat = await fs.lstat(parent);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat) || (stat.mode & 0o022) !== 0)
		throw new Error("control_endpoint_parent_unsafe");
}

export class LocalControlServer {
	#server: net.Server | null = null;
	#identity: { dev: number; ino: number } | null = null;
	#endpointBound = false;
	#ready = false;
	#sockets = new Set<net.Socket>();
	#connections = 0;
	#controllers = new Set<AbortController>();
	#handlers = 0;
	#lifecycle: Promise<void> = Promise.resolve();
	readonly endpoint: string;
	readonly #generation: string;
	readonly #token: string;
	readonly #handler: (request: AuthenticatedControlRequest, context: ControlHandlerContext) => Promise<ControlJson>;
	readonly #onFatalError: ((error: Error) => void) | undefined;
	readonly #onHandlerFailure: ((error: Error) => void) | undefined;
	readonly #idleTimeoutMs: number;
	readonly #requestTimeoutMs: number;
	readonly #maxConnections: number;
	readonly #maxHandlers: number;
	readonly #now: () => number;

	constructor(options: ControlServerOptions) {
		this.endpoint = options.endpoint;
		this.#generation = options.generation;
		this.#token = options.token;
		this.#handler = options.handler;
		this.#onFatalError = options.onFatalError;
		this.#onHandlerFailure = options.onHandlerFailure;
		this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
		this.#maxHandlers = options.maxInFlightHandlers ?? DEFAULT_MAX_HANDLERS;
		this.#now = options.now ?? Date.now;
		if (
			![this.#maxConnections, this.#maxHandlers].every(value => Number.isInteger(value) && value > 0) ||
			![this.#idleTimeoutMs, this.#requestTimeoutMs].every(
				value => Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_DELAY_MS,
			)
		)
			throw new Error("invalid_control_server_limits");
	}

	listen(): Promise<void> {
		return this.#serialize(() => this.#listen());
	}
	close(): Promise<void> {
		return this.#serialize(() => this.#close());
	}
	#serialize(operation: () => Promise<void>): Promise<void> {
		const next = this.#lifecycle.then(operation, operation);
		this.#lifecycle = next.catch(() => undefined);
		return next;
	}
	async #captureUnixEndpointIdentity(): Promise<{ dev: number; ino: number }> {
		await verifyUnixEndpointParent(this.endpoint);
		const endpoint = await fs.lstat(this.endpoint);
		if (!endpoint.isSocket() || endpoint.isSymbolicLink() || !isOwnedByCurrentUser(endpoint))
			throw new Error("control_endpoint_unsafe");
		return { dev: endpoint.dev, ino: endpoint.ino };
	}
	async #listen(): Promise<void> {
		if (this.#server) throw new Error("control_server_already_listening");
		this.#ready = false;
		if (process.platform !== "win32") {
			await verifyUnixEndpointParent(this.endpoint);
			try {
				await fs.lstat(this.endpoint);
				throw new Error("control_endpoint_exists");
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
		const server = net.createServer({ allowHalfOpen: true }, socket => this.#onConnection(socket));
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen({ path: this.endpoint }, () => {
			server.removeListener("error", listening.reject);
			// Windows has no post-bind filesystem hardening. Mark it ready before accepting connections.
			if (process.platform === "win32") this.#ready = true;
			listening.resolve();
		});
		try {
			await listening.promise;
		} catch (error) {
			server.close();
			throw error;
		}
		this.#server = server;
		if (process.platform !== "win32") this.#endpointBound = true;
		server.on("error", error => {
			this.#notifyFatalError(error);
		});
		try {
			if (process.platform !== "win32") {
				const identity = await this.#captureUnixEndpointIdentity();
				this.#identity = identity;
				await verifyUnixEndpointParent(this.endpoint);
				await fs.chmod(this.endpoint, 0o600);
				const hardened = await fs.lstat(this.endpoint);
				if (
					!hardened.isSocket() ||
					hardened.isSymbolicLink() ||
					!isOwnedByCurrentUser(hardened) ||
					(hardened.mode & 0o777) !== 0o600 ||
					hardened.dev !== identity.dev ||
					hardened.ino !== identity.ino
				)
					throw new Error("control_endpoint_unsafe");
			}
			this.#ready = true;
		} catch (error) {
			const failures = [asError(error, "control_endpoint_hardening_failed")];
			const observerError = this.#notifyFatalError(failures[0]);
			if (observerError) failures.push(observerError);
			try {
				await this.#close();
			} catch (rollbackError) {
				appendErrors(failures, rollbackError, "control_endpoint_hardening_rollback_failed");
				try {
					await this.#close();
				} catch (retryError) {
					appendErrors(failures, retryError, "control_endpoint_hardening_rollback_failed");
				}
			}
			if (failures.length > 1) throw new AggregateError(failures, "control_endpoint_hardening_rollback_failed");
			throw failures[0];
		}
	}
	#notifyFatalError(error: Error): Error | undefined {
		try {
			this.#onFatalError?.(error);
		} catch (observerError) {
			return asError(observerError, "control_fatal_observer_failed");
		}
		return undefined;
	}
	#notifyHandlerFailure(error: Error): void {
		try {
			this.#onHandlerFailure?.(error);
		} catch {
			// Private diagnostic observers cannot affect the control transport.
		}
	}
	#onConnection(socket: net.Socket): void {
		if (!this.#ready || this.#connections >= this.#maxConnections) {
			socket.destroy();
			return;
		}
		this.#connections += 1;
		this.#sockets.add(socket);
		const decoder = new ControlFrameDecoder(1, true);
		let frame: Buffer | null = null;
		let dispatched = false;
		let responded = false;
		let cleaned = false;
		let responseId = "0";
		const deadline = this.#now() + this.#requestTimeoutMs;
		const controller = new AbortController();
		this.#controllers.add(controller);
		let timeout: NodeJS.Timeout;
		const respondOnce = (response: ControlResponse): void => {
			if (responded) return;
			responded = true;
			clearTimeout(timeout);
			if (socket.destroyed) return;
			try {
				socket.end(encodeControlFrame(response));
			} catch {
				socket.destroy();
			}
		};
		timeout = setTimeout(() => {
			controller.abort();
			respondOnce(safeError(responseId, "timeout"));
		}, this.#requestTimeoutMs);
		const cleanup = (): void => {
			if (cleaned) return;
			cleaned = true;
			clearTimeout(timeout);
			this.#controllers.delete(controller);
			this.#sockets.delete(socket);
			this.#connections -= 1;
		};
		socket.once("close", () => {
			controller.abort();
			cleanup();
		});
		socket.setTimeout(this.#idleTimeoutMs, () => socket.destroy());
		socket.on("error", () => undefined);
		socket.on("data", (chunk: Buffer) => {
			if (dispatched || responded) {
				socket.destroy();
				return;
			}
			try {
				const frames = decoder.push(chunk);
				if (frames.length === 1) {
					if (frame) throw new ControlProtocolError("too_many_frames");
					frame = frames[0];
				}
				if (frame && decoder.ended) {
					dispatched = true;
					void this.#dispatch(frame, deadline, controller, respondOnce, id => {
						responseId = id;
					});
				}
			} catch (error) {
				respondOnce(
					safeError(
						"0",
						error instanceof ControlProtocolError && error.code === "too_many_frames"
							? "too_many_frames"
							: "bad_frame",
					),
				);
			}
		});
		socket.once("end", () => {
			if (dispatched || responded || socket.destroyed) return;
			respondOnce(safeError("0", "bad_frame"));
		});
	}
	async #dispatch(
		frame: Buffer,
		deadline: number,
		controller: AbortController,
		respond: (response: ControlResponse) => void,
		setResponseId: (id: string) => void,
	): Promise<void> {
		let request: ControlRequest;
		try {
			request = decodeControlRequestFrame(frame);
		} catch {
			respond(safeError(safeRequestIdFromFrame(frame), "bad_request"));
			return;
		}
		setResponseId(request.id);
		if (!verifyControlToken(this.#token, request.token)) {
			respond(safeError(safeId(request.id), "unauthorized"));
			return;
		}
		if (request.generation !== this.#generation) {
			respond(safeError(safeId(request.id), "generation_mismatch"));
			return;
		}
		if (this.#now() >= deadline || controller.signal.aborted) {
			respond(safeError(safeId(request.id), "timeout"));
			return;
		}
		if (this.#handlers >= this.#maxHandlers) {
			respond(safeError(request.id, "timeout"));
			return;
		}
		this.#handlers += 1;
		try {
			let handlerResult: ControlJson;
			try {
				handlerResult = await this.#handler(withoutControlToken(request), {
					signal: controller.signal,
					deadline,
				});
			} catch (error) {
				this.#notifyHandlerFailure(asError(error, "control_handler_failed"));
				respond(
					safeError(
						request.id,
						this.#now() >= deadline || controller.signal.aborted ? "timeout" : "handler_failed",
					),
				);
				return;
			}
			const result = snapshotControlJson(handlerResult);
			if (result === undefined) {
				this.#notifyHandlerFailure(new Error("control_handler_invalid_result", { cause: handlerResult }));
				respond(
					safeError(
						request.id,
						this.#now() >= deadline || controller.signal.aborted ? "timeout" : "handler_failed",
					),
				);
				return;
			}
			if (this.#now() >= deadline || controller.signal.aborted) respond(safeError(request.id, "timeout"));
			else respond({ version: 1, id: request.id, ok: true, result });
		} finally {
			this.#handlers -= 1;
		}
	}
	async #close(): Promise<void> {
		this.#ready = false;
		const server = this.#server;
		let cleanupIdentity = this.#identity;
		const endpointBound = this.#endpointBound;
		this.#server = null;
		for (const socket of this.#sockets) socket.destroy();
		for (const controller of this.#controllers) controller.abort();
		const failures: Error[] = [];
		if (server) {
			try {
				const closed = Promise.withResolvers<void>();
				server.close(error => (error ? closed.reject(error) : closed.resolve()));
				await closed.promise;
			} catch (error) {
				failures.push(asError(error, "control_server_close_failed"));
			}
		}
		let retainEndpoint = false;
		if (process.platform !== "win32" && endpointBound) {
			if (!cleanupIdentity) {
				try {
					cleanupIdentity = await this.#captureUnixEndpointIdentity();
				} catch (error) {
					if (!isMissing(error)) {
						retainEndpoint = true;
						failures.push(asError(error, "control_endpoint_rollback_identity_capture_failed"));
					}
				}
			}
			if (cleanupIdentity) {
				try {
					const stat = await fs.lstat(this.endpoint);
					if (
						stat.isSocket() &&
						!stat.isSymbolicLink() &&
						stat.dev === cleanupIdentity.dev &&
						stat.ino === cleanupIdentity.ino
					)
						await fs.unlink(this.endpoint);
					else {
						retainEndpoint = true;
						failures.push(new Error("control_endpoint_rollback_identity_mismatch"));
					}
				} catch (error) {
					if (!isMissing(error)) {
						retainEndpoint = true;
						failures.push(asError(error, "control_endpoint_rollback_failed"));
					}
				}
			}
		}
		this.#endpointBound = retainEndpoint;
		this.#identity = retainEndpoint ? cleanupIdentity : null;
		if (failures.length > 1) throw new AggregateError(failures, "control_server_close_failed");
		if (failures[0]) throw failures[0];
	}
}
