import { createHash, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	runVisibleSessionAttach,
	type VisibleSessionAttachDependencies,
	type VisibleSessionAttachResult,
} from "./attach";
import { LocalControlClient } from "./control-client";
import {
	type ControlErrorCode,
	canonicalControlPromptForms,
	MAX_CONTROL_STREAM_BYTES,
	MAX_CONTROL_TERMINAL_DIMENSION,
	MAX_CONTROL_WRITE_BYTES,
} from "./control-protocol";
import { controlEndpointFor } from "./control-server";
import { launchVisibleSession, type VisibleSessionExecutableSpec, type VisibleSessionLaunchReceipt } from "./launch";
import { isSameOrDescendant, validateVisibleSessionName } from "./paths";
import {
	MAX_VISIBLE_SESSION_PANE_TAIL_BYTES,
	MAX_VISIBLE_SESSION_PANE_TAIL_LINES,
	type VisibleSessionPaneTailOptions,
	type VisibleSessionPublicState,
	VisibleSessionPublicStateError,
	VisibleSessionPublicStateReader,
} from "./public-state-reader";
import type { VisibleSessionRegistry } from "./registry";
import { VisibleSessionRegistryConflictError } from "./registry";
import {
	readVisibleSessionPrivateTerminal,
	type VisibleSessionRoleIdentity,
	type VisibleSessionTerminalRecord,
	type VisibleSessionVanishedRecord,
} from "./state";
import type { VisibleSessionGeneration, VisibleSessionRegistryEntry, VisibleSessionRegistryFile } from "./types";

const DEFAULT_TAIL: VisibleSessionPaneTailOptions = { bytes: 16 * 1024, lines: 200 };
const DEFAULT_MONITOR_INTERVAL_MS = 250;
const DEFAULT_MONITOR_ATTEMPTS = 120;

export type VisibleSessionCommandErrorCode =
	| "invalid_name"
	| "not_found"
	| "invalid_input"
	| "invalid_prompt"
	| "invalid_token"
	| "control_unavailable"
	| "registry_unavailable"
	| "control_rejected"
	| "public_state_unavailable"
	| "public_state_corrupt"
	| "generation_mismatch"
	| "liveness_uncertain"
	| "public_state_transient"
	| "not_recreatable"
	| "startup_failed"
	| "conflict";

export class VisibleSessionCommandError extends Error {
	constructor(readonly code: VisibleSessionCommandErrorCode) {
		super(code);
		this.name = "VisibleSessionCommandError";
	}
}

export type VisibleSessionPromptSource = { kind: "literal"; text: string } | { kind: "file"; path: string };
export interface VisibleSessionCommandServiceDependencies {
	registry: VisibleSessionRegistry;
	launch?: typeof launchVisibleSession;
	attach?: typeof runVisibleSessionAttach;
	createReader?: (
		publicRoot: string,
		generationId: string,
		expectedSchemaVersion?: 1 | 2,
	) => VisibleSessionPublicStateReader;
	createClient?: (options: { endpoint: string; generation: string; token: string }) => LocalControlClient;
	sleep?: (milliseconds: number) => Promise<void>;
	readPrivateTerminal?: (
		privateRoot: string,
		identity: VisibleSessionRoleIdentity,
	) => Promise<VisibleSessionTerminalRecord | VisibleSessionVanishedRecord | null>;
}
export interface VisibleSessionCreateRequest {
	name: string;
	repository: string;
	worktree: string;
	backend: "conpty";
	publicBase?: string;
	executable: VisibleSessionExecutableSpec;
}
export interface VisibleSessionRecreateRequest {
	name: string;
	expectedRevision: number;
	expectedActiveGeneration: string;
	executable: VisibleSessionExecutableSpec;
}
export interface VisibleSessionStatusReceipt {
	name: string;
	revision: number;
	generationId: string;
	phase: "terminal" | "ready" | "running" | "stale";
	terminal: "final" | "vanished" | null;
	recreatable: boolean;
}
export interface VisibleSessionAttachRequest {
	name: string;
	readOnly?: boolean;
	replayBytes?: number;
	pollBytes?: number;
	pollIntervalMs?: number;
	columns?: number;
	rows?: number;
	signal?: AbortSignal;
	dependencies?: VisibleSessionAttachDependencies;
}
interface CurrentVisibleSession extends VisibleSessionRegistryEntry {
	readonly registryRevision: number;
}

function error(code: VisibleSessionCommandErrorCode): VisibleSessionCommandError {
	return new VisibleSessionCommandError(code);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isOwnerStatus(
	value: unknown,
): value is { generation: string; ready: boolean; running: boolean; cancelRequested: boolean } {
	return (
		isRecord(value) &&
		exactKeys(value, ["generation", "ready", "running", "cancelRequested"]) &&
		typeof value.generation === "string" &&
		typeof value.ready === "boolean" &&
		typeof value.running === "boolean" &&
		typeof value.cancelRequested === "boolean"
	);
}
function sameFile(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
	);
}
function sameGenerationOwner(left: VisibleSessionGeneration, right: VisibleSessionGeneration): boolean {
	return (
		left.generationId === right.generationId &&
		left.status === right.status &&
		left.startIdentity === right.startIdentity &&
		left.leaseId === right.leaseId &&
		left.process?.pid === right.process?.pid &&
		left.process?.startedAt === right.process?.startedAt &&
		left.process?.hostname === right.process?.hostname &&
		(left.process === undefined) === (right.process === undefined)
	);
}

/** Internal-only coordinator for the authenticated visible-session control plane. */
export class VisibleSessionCommandService {
	readonly #registry: VisibleSessionRegistry;
	readonly #launch: typeof launchVisibleSession;
	readonly #attach: typeof runVisibleSessionAttach;
	readonly #createReader: (
		publicRoot: string,
		generationId: string,
		expectedSchemaVersion?: 1 | 2,
	) => VisibleSessionPublicStateReader;
	readonly #createClient: (options: { endpoint: string; generation: string; token: string }) => LocalControlClient;
	readonly #sleep: (milliseconds: number) => Promise<void>;
	readonly #readPrivateTerminal: (
		privateRoot: string,
		identity: VisibleSessionRoleIdentity,
	) => Promise<VisibleSessionTerminalRecord | VisibleSessionVanishedRecord | null>;

	constructor(dependencies: VisibleSessionCommandServiceDependencies) {
		this.#registry = dependencies.registry;
		this.#launch = dependencies.launch ?? launchVisibleSession;
		this.#attach = dependencies.attach ?? runVisibleSessionAttach;
		this.#createReader =
			dependencies.createReader ??
			((root, generation, expectedSchemaVersion = 2) =>
				new VisibleSessionPublicStateReader(root, generation, {
					expectedSchemaVersion,
				}));
		this.#createClient = dependencies.createClient ?? (options => new LocalControlClient(options));
		this.#sleep = dependencies.sleep ?? (milliseconds => Bun.sleep(milliseconds));
		this.#readPrivateTerminal = dependencies.readPrivateTerminal ?? readVisibleSessionPrivateTerminal;
	}

	async create(request: VisibleSessionCreateRequest): Promise<VisibleSessionLaunchReceipt> {
		this.#validateName(request.name);
		try {
			return await this.#launch({
				registry: this.#registry,
				input: {
					name: request.name,
					repository: request.repository,
					worktree: request.worktree,
					backend: request.backend,
					publicBase: request.publicBase,
				},
				executable: request.executable,
			});
		} catch (caught) {
			throw error(this.#isLaunchConflict(caught) ? "conflict" : "startup_failed");
		}
	}

	async prompt(
		name: string,
		source: VisibleSessionPromptSource,
	): Promise<{ source: "literal" | "file"; byteLength: number }> {
		const bytes = await this.#promptBytes(source);
		const current = await this.#current(name);
		await this.#call(current, {
			action: "prompt",
			data: { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) },
		});
		return { source: source.kind, byteLength: bytes.length };
	}
	async attach(request: VisibleSessionAttachRequest): Promise<VisibleSessionAttachResult> {
		this.#validateAttachRequest(request);
		const current = await this.#current(request.name);
		const token = await this.#token(current.active);
		const control = this.#createClient({
			endpoint: controlEndpointFor({
				privateGenerationRoot: current.active.privateRoot,
				generation: current.active.generationId,
			}),
			generation: current.active.generationId,
			token,
		});
		return this.#attach(
			{
				control,
				reader: this.#createReader(current.active.publicRoot, current.active.generationId),
				readOnly: request.readOnly,
				replayBytes: request.replayBytes,
				pollBytes: request.pollBytes,
				pollIntervalMs: request.pollIntervalMs,
				columns: request.columns,
				rows: request.rows,
				signal: request.signal,
			},
			request.dependencies,
		);
	}

	async tail(
		name: string,
		options: VisibleSessionPaneTailOptions = DEFAULT_TAIL,
	): Promise<VisibleSessionPublicState["pane"]> {
		if (
			!options ||
			!Number.isSafeInteger(options.bytes) ||
			!Number.isSafeInteger(options.lines) ||
			options.bytes <= 0 ||
			options.lines <= 0 ||
			options.bytes > MAX_VISIBLE_SESSION_PANE_TAIL_BYTES ||
			options.lines > MAX_VISIBLE_SESSION_PANE_TAIL_LINES
		)
			throw error("invalid_input");
		const current = await this.#current(name);
		try {
			return await this.#createReader(current.active.publicRoot, current.active.generationId).readPaneTail(options);
		} catch (caught) {
			throw error(this.#publicStateErrorCode(caught));
		}
	}

	async status(name: string): Promise<VisibleSessionStatusReceipt> {
		return this.#status(await this.#current(name));
	}

	async monitor(
		name: string,
		options: { attempts?: number; intervalMs?: number; signal?: AbortSignal } = {},
	): Promise<VisibleSessionStatusReceipt> {
		const attempts = options.attempts ?? DEFAULT_MONITOR_ATTEMPTS;
		const intervalMs = options.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
		if (!Number.isSafeInteger(attempts) || attempts < 1) throw error("invalid_input");
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw error("invalid_input");
		return this.#monitor(await this.#current(name), attempts, intervalMs, options.signal);
	}
	async cancel(name: string): Promise<{ cancelled: boolean; phase: "terminal" | "stale" | "live" }> {
		const current = await this.#current(name);
		const status = await this.#status(current);
		if (status.phase === "terminal") return { cancelled: false, phase: "terminal" };
		if (status.phase === "stale") return { cancelled: false, phase: "stale" };
		await this.#validateCurrentGeneration(current);
		await this.#call(current, { action: "cancel" });
		return { cancelled: true, phase: "live" };
	}

	async recreate(request: VisibleSessionRecreateRequest): Promise<VisibleSessionLaunchReceipt> {
		const current = await this.#current(request.name);
		if (current.backend !== "conpty") throw error("not_recreatable");
		if (request.expectedActiveGeneration !== current.active.generationId) throw error("conflict");
		const status = await this.#status(current);
		if (status.phase !== "terminal" || !status.recreatable) throw error("not_recreatable");
		const latest = await this.#validateCurrentGeneration(current);
		try {
			return await this.#launch({
				registry: this.#registry,
				recreate: true,
				input: {
					name: current.name.displayName,
					repository: current.repository,
					worktree: current.worktree,
					backend: current.backend,
					expectedRevision: latest.registryRevision,
					expectedActiveGeneration: latest.active.generationId,
				},
				executable: request.executable,
			});
		} catch (caught) {
			throw error(this.#isLaunchConflict(caught) ? "conflict" : "startup_failed");
		}
	}

	async #status(current: CurrentVisibleSession): Promise<VisibleSessionStatusReceipt> {
		const publicState = await this.#publicState(current.active);
		const privateTerminal = await this.#privateTerminal(current.active);
		const ownerEvidence = publicState ? this.#publicStateOwnerEvidence(publicState, current.active) : null;
		if (ownerEvidence === "mismatch" || ownerEvidence === "unsupported") throw error("liveness_uncertain");
		if (ownerEvidence === "legacy" && !privateTerminal && current.active.status !== "active")
			throw error("liveness_uncertain");
		if (privateTerminal) {
			if (!publicState) throw error("public_state_transient");
			const privateIsFinal = "ownerExitReason" in privateTerminal;
			if (
				privateIsFinal
					? publicState.final?.generationId !== privateTerminal.generationId
					: publicState.vanished?.generationId !== privateTerminal.generationId
			)
				throw error("public_state_corrupt");
			return this.#receipt(current, "terminal", privateIsFinal ? "final" : "vanished", true);
		}
		if (publicState?.final || publicState?.vanished) throw error("public_state_corrupt");
		if (current.active.status !== "active") return this.#receipt(current, "stale", null, false);
		try {
			const response = await this.#call(current, { action: "status" });
			if (!isOwnerStatus(response)) throw error("liveness_uncertain");
			if (response.generation !== current.active.generationId) throw error("generation_mismatch");
			if (!response.running && !response.cancelRequested) throw error("liveness_uncertain");
			return this.#receipt(
				current,
				response.ready && response.running && !response.cancelRequested ? "ready" : "running",
				null,
				false,
			);
		} catch (caught) {
			if (caught instanceof VisibleSessionCommandError) throw caught;
			throw error("liveness_uncertain");
		}
	}
	async #monitor(
		current: CurrentVisibleSession,
		attempts: number,
		intervalMs: number,
		signal?: AbortSignal,
	): Promise<VisibleSessionStatusReceipt> {
		let latest: VisibleSessionStatusReceipt | undefined;
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				latest = await this.#status(current);
				if (latest.phase !== "stale" || signal?.aborted) return latest;
			} catch (caught) {
				if (
					!(caught instanceof VisibleSessionCommandError) ||
					!["liveness_uncertain", "public_state_transient", "control_unavailable"].includes(caught.code)
				)
					throw caught;
				if (signal?.aborted) throw caught;
			}
			if (attempt + 1 < attempts && !(await this.#waitForMonitorInterval(intervalMs, signal))) {
				if (latest) return latest;
				throw error("liveness_uncertain");
			}
		}
		if (latest) return latest;
		throw error("liveness_uncertain");
	}
	async #waitForMonitorInterval(intervalMs: number, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return false;
		if (!signal) {
			await this.#sleep(intervalMs);
			return true;
		}
		const settled = Promise.withResolvers<boolean>();
		const onAbort = () => settled.resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([this.#sleep(intervalMs).then(() => true), settled.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
	async #validateCurrentGeneration(current: CurrentVisibleSession): Promise<CurrentVisibleSession> {
		const latest = await this.#current(current.name.displayName);
		if (!sameGenerationOwner(latest.active, current.active)) throw error("generation_mismatch");
		return latest;
	}
	#isLaunchConflict(caught: unknown): boolean {
		return caught instanceof VisibleSessionRegistryConflictError;
	}
	async #current(name: string): Promise<CurrentVisibleSession> {
		const validated = this.#validateName(name);
		let registry: VisibleSessionRegistryFile;
		try {
			registry = await this.#registry.read();
		} catch {
			throw error("registry_unavailable");
		}
		const entry = registry.entries.find(candidate => candidate.name.key === validated.key);
		if (!entry) throw error("not_found");
		return { ...entry, registryRevision: registry.revision };
	}
	#validateAttachRequest(request: VisibleSessionAttachRequest): void {
		for (const [value, maximum] of [
			[request.replayBytes, MAX_CONTROL_STREAM_BYTES],
			[request.pollBytes, MAX_CONTROL_STREAM_BYTES],
			[request.pollIntervalMs, 60_000],
			[request.columns, MAX_CONTROL_TERMINAL_DIMENSION],
			[request.rows, MAX_CONTROL_TERMINAL_DIMENSION],
		] as const) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum))
				throw error("invalid_input");
		}
	}
	#validateName(name: string) {
		try {
			return validateVisibleSessionName(name, process.platform === "win32" ? "win32" : "posix");
		} catch {
			throw error("invalid_name");
		}
	}
	#receipt(
		entry: CurrentVisibleSession,
		phase: VisibleSessionStatusReceipt["phase"],
		terminal: VisibleSessionStatusReceipt["terminal"],
		recreatable: boolean,
	): VisibleSessionStatusReceipt {
		return {
			name: entry.name.displayName,
			revision: entry.registryRevision,
			generationId: entry.active.generationId,
			phase,
			terminal,
			recreatable,
		};
	}
	#publicStateOwnerEvidence(
		state: VisibleSessionPublicState,
		generation: VisibleSessionGeneration,
	): "bound" | "legacy" | "mismatch" | "unsupported" {
		switch (state.metadata.schemaVersion) {
			case 1:
				return "legacy";
			case 2: {
				const processInfo = generation.process;
				return processInfo !== undefined &&
					state.metadata.owner.pid === processInfo.pid &&
					state.metadata.owner.startedAt === processInfo.startedAt
					? "bound"
					: "mismatch";
			}
			default:
				return "unsupported";
		}
	}
	async #privateTerminal(
		generation: VisibleSessionGeneration,
	): Promise<VisibleSessionTerminalRecord | VisibleSessionVanishedRecord | null> {
		const processInfo = generation.process;
		if (!processInfo) return null;
		try {
			return await this.#readPrivateTerminal(generation.privateRoot, {
				generationId: generation.generationId,
				leaseId: generation.leaseId,
				owner: { pid: processInfo.pid, startIdentity: generation.startIdentity },
				redactions: [],
			});
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error("liveness_uncertain");
		}
	}
	async #publicState(generation: VisibleSessionGeneration): Promise<VisibleSessionPublicState | null> {
		try {
			return await this.#createReader(generation.publicRoot, generation.generationId).read(DEFAULT_TAIL);
		} catch (caught) {
			if (!(caught instanceof VisibleSessionPublicStateError) || caught.code !== "corrupt") {
				const code = this.#publicStateErrorCode(caught);
				if (code === "public_state_transient") return null;
				throw error(code);
			}
		}
		try {
			return await this.#createReader(generation.publicRoot, generation.generationId, 1).read(DEFAULT_TAIL);
		} catch (caught) {
			const code = this.#publicStateErrorCode(caught);
			if (code === "public_state_transient") return null;
			throw error(code);
		}
	}
	#publicStateErrorCode(
		caught: unknown,
	): "generation_mismatch" | "public_state_corrupt" | "public_state_transient" | "public_state_unavailable" {
		if (!(caught instanceof VisibleSessionPublicStateError)) return "public_state_unavailable";
		if (caught.code === "generation_mismatch") return "generation_mismatch";
		if (caught.code === "corrupt") return "public_state_corrupt";
		if (caught.code === "partial_initialization" || caught.code === "unstable") return "public_state_transient";
		return "public_state_unavailable";
	}
	async #promptBytes(source: VisibleSessionPromptSource): Promise<Buffer> {
		let bytes: Buffer;
		if (!source || typeof source !== "object") throw error("invalid_prompt");
		if (source.kind === "literal") {
			if (typeof source.text !== "string" || canonicalControlPromptForms(source.text) === undefined)
				throw error("invalid_prompt");
			bytes = Buffer.from(source.text, "utf8");
		} else if (source.kind === "file") {
			if (typeof source.path !== "string") throw error("invalid_prompt");
			try {
				const before = await fs.lstat(source.path);
				if (
					!before.isFile() ||
					before.isSymbolicLink() ||
					before.size <= 0 ||
					before.size > MAX_CONTROL_WRITE_BYTES
				)
					throw error("invalid_prompt");
				const handle = await fs.open(source.path, "r");
				let during: Stats;
				try {
					during = await handle.stat();
					if (!during.isFile() || during.size !== before.size) throw error("invalid_prompt");
					bytes = await this.#readExact(handle, before.size, "invalid_prompt");
				} finally {
					await handle.close();
				}
				const after = await fs.lstat(source.path);
				if (!sameFile(before, during) || !sameFile(before, after)) throw error("invalid_prompt");
			} catch {
				throw error("invalid_prompt");
			}
		} else {
			throw error("invalid_prompt");
		}
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw error("invalid_prompt");
		}
		if (canonicalControlPromptForms(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) === undefined)
			throw error("invalid_prompt");
		return bytes;
	}
	async #call(
		entry: VisibleSessionRegistryEntry,
		call: { action: "prompt" | "status" | "cancel"; data?: { text: string } },
	): Promise<unknown> {
		const token = await this.#token(entry.active);
		try {
			const response = await this.#createClient({
				endpoint: controlEndpointFor({
					privateGenerationRoot: entry.active.privateRoot,
					generation: entry.active.generationId,
				}),
				generation: entry.active.generationId,
				token,
			}).call(call);
			if (!response.ok) throw error(this.#controlErrorCode(response.error));
			return response.result;
		} catch (caught) {
			if (caught instanceof VisibleSessionCommandError) throw caught;
			throw error("control_unavailable");
		}
	}
	#controlErrorCode(code: ControlErrorCode): "control_rejected" | "generation_mismatch" {
		switch (code) {
			case "generation_mismatch":
				return "generation_mismatch";
			case "bad_frame":
			case "bad_request":
			case "unauthorized":
			case "handler_failed":
			case "timeout":
			case "too_many_frames":
				return "control_rejected";
		}
	}
	async #token(generation: VisibleSessionGeneration): Promise<string> {
		const expected = path.join(generation.privateRoot, "control-token");
		if (generation.tokenFilePath !== expected || !isSameOrDescendant(expected, generation.privateRoot))
			throw error("invalid_token");
		try {
			const before = await fs.lstat(expected);
			if (!before.isFile() || before.isSymbolicLink() || before.size !== 32) throw error("invalid_token");
			const handle = await fs.open(expected, "r");
			let bytes: Buffer;
			let during: Stats;
			try {
				during = await handle.stat();
				if (!during.isFile() || during.size !== 32) throw error("invalid_token");
				bytes = await this.#readExact(handle, 32, "invalid_token");
			} finally {
				await handle.close();
			}
			const after = await fs.lstat(expected);
			if (!sameFile(before, during) || !sameFile(before, after)) throw error("invalid_token");
			const digest = createHash("sha256").update(bytes).digest();
			const expectedDigest = Buffer.from(generation.tokenSha256, "hex");
			if (expectedDigest.length !== digest.length || !timingSafeEqual(expectedDigest, digest))
				throw error("invalid_token");
			return bytes.toString("hex");
		} catch (caught) {
			if (caught instanceof VisibleSessionCommandError) throw caught;
			throw error("invalid_token");
		}
	}
	async #readExact(handle: fs.FileHandle, length: number, code: "invalid_prompt" | "invalid_token"): Promise<Buffer> {
		const bytes = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const { bytesRead } = await handle.read(bytes, offset, length - offset, offset);
			if (bytesRead === 0) throw error(code);
			offset += bytesRead;
		}
		const probe = Buffer.alloc(1);
		if ((await handle.read(probe, 0, 1, length)).bytesRead !== 0) throw error(code);
		return bytes;
	}
}
