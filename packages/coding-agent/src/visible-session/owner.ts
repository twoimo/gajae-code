import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PtyRunResult, PtySession, type PtyStartOptions } from "@gajae-code/natives";
import {
	type AuthenticatedControlRequest,
	type ControlJson,
	canonicalControlPromptForms,
	decodeControlWriteRequest,
	MAX_CONTROL_STREAM_BYTES,
} from "./control-protocol";
import { type ControlHandlerContext, LocalControlServer } from "./control-server";
import {
	readVisibleSessionOwnerManifest,
	type VisibleSessionOwnerManifest,
	visibleSessionControlToken,
} from "./launch";
import { VisibleSessionRegistry } from "./registry";
import {
	DEFAULT_PUBLIC_LOG_CAP_BYTES,
	MAX_PUBLIC_TEXT_BYTES,
	type VisibleSessionProjectedRuntime,
	type VisibleSessionProjectedRuntimeSummary,
	VisibleSessionStateOwner,
} from "./state";
import type { VisibleSessionRegistryFile } from "./types";

const REGISTRY_POLL_MS = 50;
const REDACTION_DELIMITER = "[redacted]";
const REDACTION_DELIMITER_SEARCH_START = 0xe000;
const REDACTION_DELIMITER_SEARCH_LENGTH = 64;
const MAX_REDACTION_PENDING_BYTES = 16 * 1024;
const MAX_PROMPT_SECRET_BYTES = 64 * 1024;
const MAX_PROMPT_SECRETS = 128;
const TURN_EVIDENCE_PATTERN = /Working|Tool|Running|Executing|function call|tool call/i;
const MAX_RUNTIME_STATE_BYTES = 64 * 1024;
const CONTROL_TOKEN_BYTES = 32;
const DEFAULT_GIT_PROBE_TIMEOUT_MS = 5_000;

interface PtyLike {
	start(options: PtyStartOptions, onChunk?: (error: Error | null, chunk: string) => void): Promise<PtyRunResult>;
	write(data: string | Uint8Array): void;
	resize(columns: number, rows: number): void;
	kill(): void;
}

interface ControlServerLike {
	listen(): Promise<void>;
	close(): Promise<void>;
}

interface RegistryLike {
	read(): Promise<VisibleSessionRegistryFile>;
}
type StateOwnerLike = Pick<
	VisibleSessionStateOwner,
	| "initialize"
	| "addRedactions"
	| "appendOutput"
	| "appendEvent"
	| "updateRuntime"
	| "recordPromptAccepted"
	| "commitFinal"
>;

type OwnerRuntimeSummary = Omit<VisibleSessionProjectedRuntimeSummary, "ownerExitReason" | "severity">;
type RuntimeReadState = "missing" | "malformed" | "overlimit" | "read_error" | "unstable" | "valid";
interface PrivateRuntimeSemantic {
	state: string | null;
	source: string | null;
	reason: string | null;
	readState: RuntimeReadState;
}
interface RuntimeObservation {
	public: OwnerRuntimeSummary;
	semantic: PrivateRuntimeSemantic;
}

export interface VisibleSessionOwnerDependencies {
	registry?: RegistryLike;
	state?: StateOwnerLike;
	pty?: PtyLike;
	createControlServer?: (options: ConstructorParameters<typeof LocalControlServer>[0]) => ControlServerLike;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	gitDirty?: (command: readonly string[]) => Promise<{ exitCode: number; stdout?: string; dirty?: boolean }>;
	cancelGraceMs?: number;
	gitProbeTimeoutMs?: number;
	pid?: number;
	installSignalHandlers?: boolean;
}

async function readStableControlToken(tokenFilePath: string): Promise<Buffer> {
	const handle = await fs.open(tokenFilePath, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size !== CONTROL_TOKEN_BYTES)
			throw new Error("Visible session control token must be exactly 32 bytes");
		const token = Buffer.alloc(CONTROL_TOKEN_BYTES);
		let length = 0;
		while (length < token.length) {
			const { bytesRead } = await handle.read(token, length, token.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		if (
			!after.isFile() ||
			length !== CONTROL_TOKEN_BYTES ||
			after.size !== CONTROL_TOKEN_BYTES ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error("Visible session control token changed during read");
		return token;
	} finally {
		await handle.close();
	}
}
function activeGeneration(
	registry: VisibleSessionRegistryFile,
	manifest: VisibleSessionOwnerManifest,
	pid: number,
	token: Buffer,
): void {
	const entry = registry.entries.find(candidate => candidate.name.key === manifest.key);
	if (!entry) throw new Error("Visible session owner registry identity is not active");
	const generation = entry.active;
	if (generation.status !== "active") throw new Error("Visible session owner registry identity is not active");
	const ownerProcess = generation.process;
	if (
		entry.repository !== manifest.repo ||
		entry.worktree !== manifest.worktree ||
		generation.generationId !== manifest.generationId ||
		generation.startIdentity !== manifest.startIdentity ||
		generation.leaseId !== manifest.leaseId ||
		generation.publicRoot !== manifest.publicRoot ||
		generation.privateRoot !== manifest.privateRoot ||
		generation.tokenFilePath !== manifest.tokenFilePath ||
		!ownerProcess ||
		ownerProcess.pid !== pid ||
		ownerProcess.startedAt !== manifest.createdAt ||
		ownerProcess.hostname !== os.hostname() ||
		createHash("sha256").update(token).digest("hex") !== generation.tokenSha256
	)
		throw new Error("Visible session owner registry identity is not active");
}

function firstCharacter(value: string): string {
	const codePoint = value.codePointAt(0);
	if (codePoint === undefined) return "";
	return String.fromCodePoint(codePoint);
}
function markerIsSafe(marker: string, secrets: readonly string[]): boolean {
	return secrets.every(secret => {
		if (secret.length === 0 || secret.includes(marker) || marker.includes(secret)) return false;
		for (let length = 1; length < Math.min(marker.length, secret.length); length += 1) {
			if (marker.endsWith(secret.slice(0, length)) || secret.endsWith(marker.slice(0, length))) return false;
		}
		return true;
	});
}
function fallbackRedactionMarker(secrets: readonly string[]): string | undefined {
	for (
		let codePoint = REDACTION_DELIMITER_SEARCH_START;
		codePoint < REDACTION_DELIMITER_SEARCH_START + REDACTION_DELIMITER_SEARCH_LENGTH;
		codePoint += 1
	) {
		const candidate = String.fromCodePoint(codePoint);
		if (!markerIsSafe(candidate, secrets)) continue;
		return candidate;
	}
	return undefined;
}
function redactionDelimiter(secrets: readonly string[]): string | undefined {
	return markerIsSafe(REDACTION_DELIMITER, secrets) ? REDACTION_DELIMITER : fallbackRedactionMarker(secrets);
}
function truncationMarker(secrets: readonly string[]): string | undefined {
	const label = "[visible-session log truncated]\n";
	return markerIsSafe(label, secrets) ? label : fallbackRedactionMarker(secrets);
}
function appendPublicLog(previous: Buffer, entry: Buffer, cap: number, secrets: readonly string[]): Buffer | undefined {
	const combined = Buffer.concat([previous, entry]);
	const candidate = Buffer.from(redactVisibleText(combined.toString("utf8"), secrets), "utf8");
	if (candidate.length === 0 && combined.length > 0) return undefined;
	if (candidate.length <= cap) return candidate;
	const marker = truncationMarker(secrets);
	if (marker === undefined) return undefined;
	const markerBytes = Buffer.from(marker, "utf8");
	let start = candidate.length - (cap - markerBytes.length);
	while (start < candidate.length && (candidate[start] & 0xc0) === 0x80) start += 1;
	const output = Buffer.concat([markerBytes, candidate.subarray(start)]);
	return secrets.some(secret => secret.length > 0 && output.includes(secret)) ? undefined : output;
}
function terminalEscapeLength(value: string, offset: number): number {
	if (value.charCodeAt(offset) !== 0x1b) return 0;
	const next = value.charCodeAt(offset + 1);
	if (Number.isNaN(next)) return -1;
	if (next === 0x5b) {
		let index = offset + 2;
		while (index < value.length) {
			const code = value.charCodeAt(index);
			index += 1;
			if (code >= 0x40 && code <= 0x7e) return index - offset;
		}
		return -1;
	}
	if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
		let index = offset + 2;
		while (index < value.length) {
			const code = value.charCodeAt(index);
			if (next === 0x5d && code === 0x07) return index + 1 - offset;
			if (code === 0x1b) {
				if (index + 1 >= value.length) return -1;
				if (value.charCodeAt(index + 1) === 0x5c) return index + 2 - offset;
			}
			index += 1;
		}
		return -1;
	}
	return 2;
}
function incompleteTerminalEscape(value: string, offset: number): boolean {
	return terminalEscapeLength(value, offset) < 0;
}
function secretMatchLength(value: string, secret: string): number | undefined {
	let valueIndex = 0;
	let secretIndex = 0;
	while (secretIndex < secret.length) {
		const character = firstCharacter(value.slice(valueIndex));
		if (character === "") return undefined;
		if (secret.startsWith(character, secretIndex)) {
			valueIndex += character.length;
			secretIndex += character.length;
			continue;
		}
		const escapeLength = terminalEscapeLength(value, valueIndex);
		if (escapeLength > 0) {
			valueIndex += escapeLength;
			continue;
		}
		return undefined;
	}
	return valueIndex;
}
function secretPrefix(value: string, secret: string): boolean {
	let valueIndex = 0;
	let secretIndex = 0;
	while (valueIndex < value.length && secretIndex < secret.length) {
		const character = firstCharacter(value.slice(valueIndex));
		if (secret.startsWith(character, secretIndex)) {
			valueIndex += character.length;
			secretIndex += character.length;
			continue;
		}
		if (incompleteTerminalEscape(value, valueIndex)) return secretIndex > 0;
		const escapeLength = terminalEscapeLength(value, valueIndex);
		if (escapeLength > 0) {
			valueIndex += escapeLength;
			continue;
		}
		return false;
	}
	return valueIndex === value.length && secretIndex > 0 && secretIndex < secret.length;
}
function endsWithSecretPrefix(value: string, secrets: readonly string[]): boolean {
	for (let offset = 0; offset < value.length; ) {
		const suffix = value.slice(offset);
		if (secrets.some(secret => secretPrefix(suffix, secret))) return true;
		offset += firstCharacter(suffix).length;
	}
	return false;
}
function endingSecretPrefix(value: string, secrets: readonly string[]): string {
	let prefix = "";
	for (let offset = 0; offset < value.length; ) {
		const suffix = value.slice(offset);
		if (secrets.some(secret => secretPrefix(suffix, secret)) && suffix.length > prefix.length) prefix = suffix;
		offset += firstCharacter(suffix).length;
	}
	return prefix;
}
function redactVisibleText(value: string, secrets: readonly string[]): string {
	const delimiter = redactionDelimiter([...secrets]);
	if (delimiter === undefined) return "";
	let output = "";
	let pending = value;
	while (pending.length > 0) {
		const matches = secrets
			.map(secret => ({ length: secretMatchLength(pending, secret) }))
			.filter((match): match is { length: number } => match.length !== undefined);
		if (matches.length > 0) {
			const match = matches.reduce((longest, candidate) =>
				candidate.length > longest.length ? candidate : longest,
			);
			output += delimiter;
			pending = pending.slice(match.length);
			continue;
		}
		const character = firstCharacter(pending);
		output += character;
		pending = pending.slice(character.length);
	}
	return secrets.some(secret => secret.length > 0 && output.includes(secret)) ? "" : output;
}

function controlPromptForms(request: AuthenticatedControlRequest): readonly string[] {
	if (!request.data || typeof request.data !== "object" || Array.isArray(request.data) || !("text" in request.data))
		throw new Error("invalid control text");
	const forms = canonicalControlPromptForms(request.data.text);
	if (forms === undefined) throw new Error("invalid control text");
	return forms;
}

function resize(request: AuthenticatedControlRequest): { columns: number; rows: number } {
	if (!request.data || typeof request.data !== "object" || Array.isArray(request.data))
		throw new Error("invalid resize");
	const columns = request.data.columns;
	const rows = request.data.rows;
	if (
		typeof columns !== "number" ||
		typeof rows !== "number" ||
		!Number.isInteger(columns) ||
		!Number.isInteger(rows) ||
		columns < 1 ||
		rows < 1
	)
		throw new Error("invalid resize");
	return { columns, rows };
}

function streamRequest(request: AuthenticatedControlRequest): { cursor: number | null; maxBytes: number } {
	if (!request.data || typeof request.data !== "object" || Array.isArray(request.data))
		throw new Error("invalid stream");
	const cursor = request.data.cursor;
	const maxBytes = request.data.maxBytes;
	if (
		(cursor !== null && (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0)) ||
		typeof maxBytes !== "number" ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > MAX_CONTROL_STREAM_BYTES
	)
		throw new Error("invalid stream");
	return { cursor, maxBytes };
}
async function drainGitProbeStream(
	stream: ReadableStream<Uint8Array> | null,
	observeOutput: boolean,
): Promise<boolean> {
	if (!stream) return false;
	const reader = stream.getReader();
	let observed = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return observed;
			if (observeOutput && value.length > 0) observed = true;
		}
	} finally {
		reader.releaseLock();
	}
}

async function defaultGitDirty(
	command: readonly string[],
	timeoutMs = DEFAULT_GIT_PROBE_TIMEOUT_MS,
): Promise<{ exitCode: number; dirty: boolean }> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
		throw new Error("Visible session Git probe timeout is invalid");
	const process = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const stdout = drainGitProbeStream(process.stdout, true);
	const stderr = drainGitProbeStream(process.stderr, false);
	const timeout = Promise.withResolvers<void>();
	const timer = setTimeout(() => timeout.resolve(), timeoutMs);
	try {
		const result = await Promise.race([
			Promise.all([process.exited, stdout, stderr]).then(([exitCode, dirty]) => ({
				exitCode,
				dirty,
				timedOut: false as const,
			})),
			timeout.promise.then(() => ({ timedOut: true as const })),
		]);
		if (result.timedOut) throw new Error("Visible session Git probe timed out");
		return { exitCode: result.exitCode, dirty: result.dirty };
	} catch (error) {
		try {
			process.kill("SIGKILL");
		} finally {
			await Promise.allSettled([process.exited, stdout, stderr]);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

interface RuntimeFileRead {
	state: RuntimeReadState;
	value: unknown;
}

async function readBoundedRuntimeState(runtimeStatePath: string): Promise<RuntimeFileRead> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(runtimeStatePath, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", value: null };
		return { state: "read_error", value: null };
	}
	let result: RuntimeFileRead = { state: "read_error", value: null };
	try {
		const before = await handle.stat();
		if (!before.isFile()) {
			result = { state: "read_error", value: null };
		} else if (before.size > MAX_RUNTIME_STATE_BYTES) {
			result = { state: "overlimit", value: null };
		} else {
			const bytes = Buffer.alloc(MAX_RUNTIME_STATE_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			const after = await handle.stat();
			if (length > MAX_RUNTIME_STATE_BYTES || after.size > MAX_RUNTIME_STATE_BYTES) {
				result = { state: "overlimit", value: null };
			} else if (
				length !== before.size ||
				length !== after.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ino !== after.ino
			) {
				result = { state: "unstable", value: null };
			} else {
				try {
					const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
					result =
						text.trim() === ""
							? { state: "malformed", value: null }
							: { state: "valid", value: JSON.parse(text) };
				} catch {
					result = { state: "malformed", value: null };
				}
			}
		}
	} catch {
		result = { state: "read_error", value: null };
	}
	try {
		await handle.close();
	} catch {
		result = { state: "read_error", value: null };
	}
	return result;
}

function runtimeCwdIdentity(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function runtimeSummary(
	value: unknown,
	session: string,
	worktree: string,
	updatedAt: string,
	redactions: readonly string[],
	readState: RuntimeReadState,
): RuntimeObservation {
	const empty: OwnerRuntimeSummary = {
		summary: "runtime state unavailable",
		status: "unavailable",
		updatedAt,
		present: false,
		valid: false,
		state: null,
		source: null,
		event: null,
		reason: null,
		terminal: false,
		terminalState: null,
		terminalSource: null,
		finalResponsePresent: false,
		previousRuntimeState: null,
		sessionMatches: true,
		cwdMatches: true,
	};
	const unavailable = (failure: Exclude<RuntimeReadState, "valid">): RuntimeObservation => {
		const evidence = {
			missing: { summary: "runtime state missing", status: "missing" },
			malformed: { summary: "runtime state malformed", status: "malformed" },
			overlimit: { summary: "runtime state exceeds size limit", status: "overlimit" },
			read_error: { summary: "runtime state read failed", status: "read_error" },
			unstable: { summary: "runtime state changed during read", status: "unstable" },
		}[failure];
		return {
			public: {
				...empty,
				...evidence,
				present: failure !== "missing",
				sessionMatches: failure === "missing",
				cwdMatches: failure === "missing",
			},
			semantic: { state: null, source: null, reason: null, readState: failure },
		};
	};
	if (readState !== "valid") return unavailable(readState);
	if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable("malformed");
	const raw = value as Record<string, unknown>;
	const rawString = (key: string): string | null => (typeof raw[key] === "string" ? raw[key] : null);
	const string = (key: string): string | null => {
		const item = rawString(key);
		return item === null ? null : redactVisibleText(item, redactions);
	};
	const sessionId = rawString("session_id");
	const cwd = rawString("cwd") ?? rawString("workdir");
	const sessionMatches = !sessionId || sessionId === session;
	const cwdMatches = !cwd || runtimeCwdIdentity(cwd) === runtimeCwdIdentity(worktree);
	const state = string("state");
	const source = string("source");
	const finalResponse = raw.final_response;
	const finalResponseRecord =
		finalResponse !== null && typeof finalResponse === "object" && !Array.isArray(finalResponse)
			? (finalResponse as Record<string, unknown>)
			: null;
	const scalarKeys = ["session_id", "cwd", "workdir", "state", "source", "event", "reason", "previous_runtime_state"];
	const scalarsValid = scalarKeys.every(key => raw[key] === undefined || typeof raw[key] === "string");
	const finalResponseValid =
		finalResponse === undefined ||
		(finalResponseRecord !== null &&
			["text", "artifact_path", "source"].every(
				key => finalResponseRecord[key] === undefined || typeof finalResponseRecord[key] === "string",
			));
	if (!scalarsValid || !finalResponseValid) return unavailable("malformed");
	const finalResponsePresent =
		finalResponseRecord !== null &&
		((typeof finalResponseRecord.text === "string" && finalResponseRecord.text.trim() !== "") ||
			(typeof finalResponseRecord.artifact_path === "string" && finalResponseRecord.artifact_path.trim() !== ""));
	const terminal =
		(rawString("state") === "completed" || rawString("state") === "errored") && sessionMatches && cwdMatches;
	const finalResponseSource =
		finalResponseRecord && typeof finalResponseRecord.source === "string" ? finalResponseRecord.source : null;
	const terminalSource =
		terminal && finalResponseSource !== null
			? redactVisibleText(finalResponseSource, redactions)
			: terminal
				? (source ?? "runtime_state")
				: null;
	return {
		public: {
			summary: terminal
				? "runtime terminal state observed"
				: state
					? "runtime state observed"
					: "runtime state unavailable",
			status: terminal ? "terminal" : state ? "observed" : "unavailable",
			updatedAt,
			present: true,
			valid: true,
			state,
			source,
			event: string("event"),
			reason: string("reason"),
			terminal,
			terminalState: terminal ? state : null,
			terminalSource,
			finalResponsePresent,
			previousRuntimeState: string("previous_runtime_state"),
			sessionMatches,
			cwdMatches,
		},
		semantic: {
			state: rawString("state"),
			source: rawString("source"),
			reason: rawString("reason"),
			readState: "valid",
		},
	};
}

/** Runs the private detached owner role. It intentionally exposes no CLI surface. */
export async function runVisibleSessionOwner(
	manifestPath: string,
	dependencies: VisibleSessionOwnerDependencies = {},
): Promise<void> {
	const manifest = await readVisibleSessionOwnerManifest(manifestPath);
	const tokenBytes = await readStableControlToken(manifest.tokenFilePath);
	const token = visibleSessionControlToken(tokenBytes);
	const now = dependencies.now ?? Date.now;
	const sleep = dependencies.sleep ?? (milliseconds => Bun.sleep(milliseconds));
	const pid = dependencies.pid ?? process.pid;
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Visible session owner PID is invalid");
	const deadline = Date.parse(manifest.ownerReadyDeadline);
	if (deadline <= now()) throw new Error("Visible session owner readiness deadline expired");
	const registry = dependencies.registry ?? new VisibleSessionRegistry({ agentDir: manifest.agentDir });
	for (;;) {
		try {
			activeGeneration(await registry.read(), manifest, pid, tokenBytes);
			break;
		} catch (error) {
			if (now() >= deadline) throw error;
			await sleep(Math.min(REGISTRY_POLL_MS, deadline - now()));
		}
	}

	const launchSecrets = [...manifest.args, ...Object.values(manifest.env)].filter(value => value.length > 0);
	const secrets = [token, ...launchSecrets, manifest.leaseId, manifest.startIdentity];
	const gitDirty =
		dependencies.gitDirty ??
		((command: readonly string[]) => defaultGitDirty(command, dependencies.gitProbeTimeoutMs));
	const probeDirty = async (): Promise<boolean> => {
		const result = await gitDirty([
			"git",
			"-C",
			manifest.worktree,
			"status",
			"--porcelain=v1",
			"--untracked-files=normal",
		]);
		if (result.exitCode !== 0) throw new Error("Visible session worktree dirty probe failed");
		return result.dirty ?? (result.stdout?.length ?? 0) > 0;
	};
	const identity = {
		generationId: manifest.generationId,
		leaseId: manifest.leaseId,
		owner: { pid, startIdentity: manifest.startIdentity },
		redactions: [token],
		logRedactions: secrets,
	};
	const projection = {
		publicRoot: manifest.publicRoot,
		privateRoot: manifest.privateRoot,
		session: manifest.name,
		workdir: manifest.worktree,
		branch: manifest.branch,
		createdAt: manifest.createdAt,
		gjcBin: manifest.executable,
		worktreeBaselineDirty: manifest.worktreeBaselineDirty,
		owner: { pid, startedAt: manifest.createdAt },
		backend: "conpty" as const,
	};
	const state = dependencies.state ?? new VisibleSessionStateOwner(projection, identity);
	let revision = (await state.initialize()).revision;
	let promptBaselineDirty: boolean | undefined;
	const promptSecrets: string[] = [];
	const promptSecretSet = new Set<string>();
	let promptSecretBytes = 0;
	const readRuntime = async (): Promise<RuntimeObservation> => {
		const updatedAt = new Date(now()).toISOString();
		const runtimeFile = await readBoundedRuntimeState(manifest.runtimeStatePath);
		const summary = runtimeSummary(
			runtimeFile.value,
			manifest.name,
			manifest.worktree,
			updatedAt,
			[...secrets, ...promptSecrets],
			runtimeFile.state,
		);
		const runtime: VisibleSessionProjectedRuntime = {
			schemaVersion: 2,
			backend: "conpty",
			generation: manifest.generationId,
			generationId: manifest.generationId,
			owner: projection.owner,
			...summary.public,
		};
		revision = await state.updateRuntime({ expectedRevision: revision }, runtime);
		revision = await state.appendEvent({
			expectedRevision: revision,
			entry: `runtime state updated read=${runtimeFile.state} state=${summary.public.state ?? "none"}`,
		});
		return summary;
	};
	await readRuntime();
	let queue: Promise<void> = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = queue.then(operation);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const pty = dependencies.pty ?? new PtySession();
	let ptyStarted = false;
	let ptySettled = false;
	let accepting = false;
	let finalizing = false;
	let fatalWriterError: unknown;
	let fatalMutationError: unknown;
	let promptDeliveryFailure: unknown;
	let controlCloseAttempted = false;
	const failures: unknown[] = [];
	const recordFailure = (error: unknown): void => {
		if (error instanceof AggregateError) {
			for (const cause of error.errors) recordFailure(cause);
			return;
		}
		if (!failures.includes(error)) failures.push(error);
	};
	let closeForFatal: (() => Promise<void>) | undefined;
	let fatalCloseTask: Promise<void> | undefined;
	const failWriter = (error: unknown): void => {
		if (fatalWriterError !== undefined) return;
		fatalWriterError = error;
		recordFailure(error);
		accepting = false;
		finalizing = true;
		try {
			pty.kill();
		} catch (killError) {
			recordFailure(killError);
		}
		void closeForFatal?.();
	};
	const failMutation = (error: unknown): void => {
		fatalMutationError ??= error;
		failWriter(error);
	};
	const failPromptDelivery = (error: unknown): void => {
		if (promptDeliveryFailure !== undefined) return;
		promptDeliveryFailure = error;
		recordFailure(error);
		accepting = false;
		finalizing = true;
		try {
			pty.kill();
		} catch (killError) {
			recordFailure(killError);
		}
		void closeForFatal?.();
	};
	let pendingOutput = "";
	let pendingHighSurrogate = "";
	let outputSuppressed = false;
	let outputSuppressionReason: "redaction-marker-exhausted" | "redaction-buffer-exhausted" | undefined;
	let cancelRequested = false;
	let cancellationAccepted = false;
	let cancelTask: Promise<void> | undefined;
	// outputStartCursor is monotonic and is the sole lower bound for retained stream bytes.
	let outputStartCursor = 0;
	let outputEndCursor = 0;
	let outputRing: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let turnEvidenceObserved = false;
	let evidenceWindow = "";
	const appendPublicOutput = (value: string): void => {
		const bytes = Buffer.from(value, "utf8");
		if (bytes.length === 0) return;
		outputEndCursor += bytes.length;
		const allSecrets = [...secrets, ...promptSecrets].filter(secret => secret.length > 0);
		const next = appendPublicLog(outputRing, bytes, DEFAULT_PUBLIC_LOG_CAP_BYTES, allSecrets);
		if (next === undefined) {
			outputRing = Buffer.alloc(0);
			suppressOutput("redaction-marker-exhausted");
		} else {
			outputRing = next;
		}
		outputStartCursor = outputEndCursor - outputRing.length;
	};
	const invalidateOutputRing = (): void => {
		outputRing = Buffer.alloc(0);
		outputEndCursor += 1;
		outputStartCursor = outputEndCursor;
	};
	let pendingPersistence: Buffer = Buffer.alloc(0);
	let persistenceScheduled = false;
	const schedulePersistence = (): void => {
		if (persistenceScheduled || outputSuppressed) return;
		persistenceScheduled = true;
		void enqueue(async () => {
			for (;;) {
				const pending = pendingPersistence;
				pendingPersistence = Buffer.alloc(0);
				if (pending.length === 0) {
					persistenceScheduled = false;
					return;
				}
				let entry = "";
				let entryBytes = 0;
				const appendEntry = async (): Promise<void> => {
					if (entry.length === 0) return;
					const output = entry;
					const bytes = entryBytes;
					entry = "";
					entryBytes = 0;
					revision = await state.appendOutput({ expectedRevision: revision, entry: output });
					revision = await state.appendEvent({
						expectedRevision: revision,
						entry: `pty-output ${bytes} bytes`,
					});
				};
				for (const character of pending.toString("utf8")) {
					const bytes = Buffer.byteLength(character, "utf8");
					if (entryBytes + bytes > MAX_PUBLIC_TEXT_BYTES) await appendEntry();
					entry += character;
					entryBytes += bytes;
				}
				await appendEntry();
			}
		}).catch(failMutation);
	};
	const suppressOutput = (reason: "redaction-marker-exhausted" | "redaction-buffer-exhausted"): void => {
		if (outputSuppressed) return;
		outputSuppressed = true;
		outputSuppressionReason = reason;
		pendingOutput = "";
		pendingHighSurrogate = "";
		pendingPersistence = Buffer.alloc(0);
	};
	const appendRedactedOutput = (value: string): void => {
		evidenceWindow = `${evidenceWindow}${value}`.slice(-256);
		if (TURN_EVIDENCE_PATTERN.test(evidenceWindow)) turnEvidenceObserved = true;
		const bytes = Buffer.from(value, "utf8");
		if (bytes.length === 0) return;
		appendPublicOutput(value);
		const pending = appendPublicLog(
			pendingPersistence,
			bytes,
			DEFAULT_PUBLIC_LOG_CAP_BYTES,
			[...secrets, ...promptSecrets].filter(secret => secret.length > 0),
		);
		if (pending === undefined) {
			suppressOutput("redaction-marker-exhausted");
			return;
		}
		pendingPersistence = pending;
		schedulePersistence();
	};
	const redactOutput = (flush = false): void => {
		if (outputSuppressed) return;
		const allSecrets = [...secrets, ...promptSecrets].filter(secret => secret.length > 0);
		let safe = "";
		const appendSafe = (): void => {
			if (safe.length > 0) appendRedactedOutput(safe);
			safe = "";
		};
		for (;;) {
			const matchingSecrets = allSecrets
				.map(secret => ({ secret, length: secretMatchLength(pendingOutput, secret) }))
				.filter((match): match is { secret: string; length: number } => match.length !== undefined);
			if (matchingSecrets.length > 0) {
				if (!flush && allSecrets.some(secret => secretPrefix(pendingOutput, secret))) {
					appendSafe();
					return;
				}
				const match = matchingSecrets.reduce((longest, candidate) =>
					candidate.length > longest.length ? candidate : longest,
				);
				const delimiter = redactionDelimiter(allSecrets);
				if (delimiter === undefined) {
					suppressOutput("redaction-marker-exhausted");
					return;
				}
				appendSafe();
				appendRedactedOutput(delimiter);
				pendingOutput = pendingOutput.slice(match.length);
				continue;
			}
			if (!flush && allSecrets.some(secret => secretPrefix(pendingOutput, secret))) {
				appendSafe();
				return;
			}
			if (!flush && incompleteTerminalEscape(pendingOutput, 0)) {
				appendSafe();
				return;
			}
			if (pendingOutput.length === 0) {
				appendSafe();
				return;
			}
			const character = firstCharacter(pendingOutput);
			safe += character;
			pendingOutput = pendingOutput.slice(character.length);
		}
	};
	const appendOutput = (chunk: string): void => {
		if (outputSuppressed) return;
		const combined = `${pendingHighSurrogate}${chunk}`;
		pendingHighSurrogate = "";
		const last = combined.charCodeAt(combined.length - 1);
		let remaining = last >= 0xd800 && last <= 0xdbff ? combined.slice(0, -1) : combined;
		if (remaining.length !== combined.length) pendingHighSurrogate = combined.slice(-1);
		while (remaining.length > 0) {
			let segment = remaining.slice(0, 4_096);
			const segmentLast = segment.charCodeAt(segment.length - 1);
			if (segment.length < remaining.length && segmentLast >= 0xd800 && segmentLast <= 0xdbff)
				segment = segment.slice(0, -1);
			pendingOutput += segment;
			remaining = remaining.slice(segment.length);
			redactOutput();
			if (Buffer.byteLength(pendingOutput, "utf8") > MAX_REDACTION_PENDING_BYTES) {
				suppressOutput("redaction-buffer-exhausted");
				return;
			}
		}
	};
	const flushOutput = (): void => {
		pendingOutput += pendingHighSurrogate;
		pendingHighSurrogate = "";
		redactOutput(true);
	};
	let inFlightMutations = 0;
	let mutationIdle = Promise.withResolvers<void>();
	mutationIdle.resolve();
	const assertHandlerActive = (context: ControlHandlerContext): void => {
		if (
			finalizing ||
			cancelRequested ||
			!accepting ||
			context.signal?.aborted ||
			(typeof context.deadline === "number" && now() >= context.deadline)
		)
			throw new Error("visible session owner request expired");
	};
	const installPromptRedactions = (forms: readonly string[]): readonly string[] => {
		const newForms = forms.filter(secret => !promptSecretSet.has(secret));
		const newFormBytes = newForms.reduce((total, secret) => total + Buffer.byteLength(secret, "utf8"), 0);
		if (
			promptSecrets.length + newForms.length > MAX_PROMPT_SECRETS ||
			promptSecretBytes + newFormBytes > MAX_PROMPT_SECRET_BYTES
		)
			throw new Error("Visible session prompt redaction budget exhausted");
		const ringText = outputRing.toString("utf8");
		const preserveRing =
			redactVisibleText(ringText, newForms) === ringText && !endsWithSecretPrefix(ringText, newForms);
		for (const secret of newForms) {
			promptSecretSet.add(secret);
			promptSecrets.push(secret);
		}
		promptSecretBytes += newFormBytes;
		if (!preserveRing) {
			pendingOutput += endingSecretPrefix(ringText, newForms);
			invalidateOutputRing();
		}
		redactOutput();
		return newForms;
	};
	const handler = async (
		request: AuthenticatedControlRequest,
		context: ControlHandlerContext,
	): Promise<ControlJson> => {
		if (request.action === "ready") return accepting;
		if (request.action === "status" || request.action === "heartbeat")
			return {
				ready: accepting,
				running: ptyStarted && !finalizing,
				generation: manifest.generationId,
				cancelRequested,
			};
		if (request.action === "stream") {
			const { cursor, maxBytes } = streamRequest(request);
			const requestedCursor = cursor ?? Math.max(outputStartCursor, outputEndCursor - maxBytes);
			const truncated = cursor === null ? requestedCursor > outputStartCursor : cursor < outputStartCursor;
			const startCursor = Math.min(Math.max(requestedCursor, outputStartCursor), outputEndCursor);
			const bytes = outputRing.subarray(
				startCursor - outputStartCursor,
				Math.min(outputRing.length, startCursor - outputStartCursor + maxBytes),
			);
			return {
				startCursor,
				endCursor: startCursor + bytes.length,
				bytes: bytes.toString("base64"),
				truncated,
				running: ptyStarted && !finalizing,
			};
		}
		if (request.action === "cancel" && cancelTask) {
			await cancelTask;
			return { accepted: true, idempotent: true, cancelRequested: true };
		}
		if (!accepting || finalizing) throw new Error("visible session owner is not ready");
		assertHandlerActive(context);
		if (request.action === "cancel") {
			cancelRequested = true;
			cancellationAccepted = true;
			cancelTask = enqueue(async () => {
				let cancellationFailure: unknown;
				let ctrlCWriteFailed = false;
				try {
					pty.write(Uint8Array.of(3));
				} catch (error) {
					failWriter(error);
					cancellationFailure = error;
					ctrlCWriteFailed = true;
				}
				try {
					await sleep(dependencies.cancelGraceMs ?? 1_000);
				} catch (error) {
					recordFailure(error);
					cancellationFailure ??= error;
				}
				if (!ptySettled && !ctrlCWriteFailed)
					try {
						pty.kill();
					} catch (error) {
						recordFailure(error);
						cancellationFailure ??= error;
					}
				if (cancellationFailure) throw cancellationFailure;
			});
			await cancelTask;
			return { accepted: true, idempotent: false, cancelRequested: true };
		}
		if (request.action === "write") {
			assertHandlerActive(context);
			pty.write(decodeControlWriteRequest(request));
			return { accepted: true };
		}
		if (request.action === "prompt") {
			inFlightMutations += 1;
			mutationIdle = Promise.withResolvers<void>();
			try {
				await enqueue(async () => {
					assertHandlerActive(context);
					const forms = controlPromptForms(request);
					// Request expiry is checked before this durable admission; the admitted transaction then completes.
					const newForms = installPromptRedactions(forms);
					try {
						if (newForms.length > 0) await state.addRedactions(newForms);
					} catch (error) {
						failMutation(error);
						throw error;
					}
					const baselineDirty = await probeDirty();
					try {
						revision = await state.recordPromptAccepted(
							{ expectedRevision: revision },
							{
								schemaVersion: 2,
								backend: "conpty",
								generation: manifest.generationId,
								generationId: manifest.generationId,
								owner: projection.owner,
								session: manifest.name,
								acceptedAt: new Date(now()).toISOString(),
								summary: "prompt accepted",
								worktreeBaselineDirty: baselineDirty,
							},
						);
					} catch (error) {
						failMutation(error);
						throw error;
					}
					promptBaselineDirty = baselineDirty;
					try {
						pty.write(`${forms[0]}\r\n`);
					} catch (error) {
						failPromptDelivery(error);
						throw error;
					}
					try {
						revision = await state.appendEvent({ expectedRevision: revision, entry: "prompt accepted" });
					} catch (error) {
						failMutation(error);
						throw error;
					}
				});
				return { accepted: true };
			} finally {
				inFlightMutations -= 1;
				if (inFlightMutations === 0) mutationIdle.resolve();
			}
		}
		if (request.action === "resize") {
			assertHandlerActive(context);
			const dimensions = resize(request);
			pty.resize(dimensions.columns, dimensions.rows);
			return { accepted: true };
		}
		throw new Error("unsupported visible session action");
	};
	const control = (dependencies.createControlServer ?? (options => new LocalControlServer(options)))({
		endpoint: manifest.controlEndpoint,
		generation: manifest.generationId,
		token,
		handler,
		onFatalError: failWriter,
	});
	closeForFatal = (): Promise<void> => {
		if (!fatalCloseTask) {
			controlCloseAttempted = true;
			fatalCloseTask = control.close().catch(error => {
				recordFailure(error);
			});
		}
		return fatalCloseTask;
	};
	const kill = (): void => {
		if (cancelRequested) return;
		cancelRequested = true;
		try {
			pty.kill();
		} catch (error) {
			recordFailure(error);
		}
	};
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	if (dependencies.installSignalHandlers !== false) for (const signal of signals) process.on(signal, kill);
	let completionFailure: unknown;
	let outcome: PtyRunResult = { cancelled: false, timedOut: false };
	try {
		await control.listen();
		if (cancelRequested || fatalWriterError !== undefined) {
			finalizing = true;
			await closeForFatal();
		} else {
			accepting = true;
			ptyStarted = true;
			try {
				outcome = await pty.start(
					{
						executable: manifest.executable,
						args: manifest.args,
						cwd: manifest.cwd,
						env: manifest.env,
					},
					(error, chunk) => {
						if (chunk) appendOutput(chunk);
						if (error) failWriter(error);
					},
				);
			} catch (error) {
				completionFailure = error;
				recordFailure(error);
				try {
					pty.kill();
				} catch (killError) {
					recordFailure(killError);
				}
			} finally {
				ptySettled = true;
			}
		}
		finalizing = true;
		accepting = false;
		flushOutput();
		await mutationIdle.promise;
		await queue;
		if (fatalMutationError !== undefined) throw fatalMutationError;
		if (cancelTask) {
			try {
				await cancelTask;
			} catch (error) {
				recordFailure(error);
				completionFailure ??= error;
			}
		}
		const finalFailure = completionFailure ?? fatalWriterError ?? promptDeliveryFailure;
		const runtimeObservation = await readRuntime();
		const runtime = runtimeObservation.public;
		const runtimeSemantic = runtimeObservation.semantic;
		const currentDirty = await probeDirty();
		const baselineDirty = promptBaselineDirty ?? manifest.worktreeBaselineDirty;
		const turnEvidencePresent = turnEvidenceObserved;
		const runtimeMatches = runtime.valid && runtime.sessionMatches && runtime.cwdMatches;
		const failureStatus = outcome.exitCode !== undefined && outcome.exitCode !== 0 ? outcome.exitCode : 1;
		const classification = (() => {
			if (completionFailure !== undefined)
				return { reason: "owner_completion_failure", severity: "failure" as const, status: failureStatus };
			if (fatalWriterError !== undefined)
				return { reason: "owner_fatal_writer_error", severity: "failure" as const, status: failureStatus };
			if (promptDeliveryFailure !== undefined)
				return { reason: "owner_prompt_delivery_failure", severity: "failure" as const, status: failureStatus };
			if (outcome.timedOut)
				return {
					reason: "pty_timed_out",
					severity: "failure" as const,
					status: outcome.exitCode !== undefined && outcome.exitCode !== 0 ? outcome.exitCode : 124,
				};
			if (outcome.cancelled || cancellationAccepted)
				return {
					reason: "pty_cancelled",
					severity: "failure" as const,
					status: outcome.exitCode !== undefined && outcome.exitCode !== 0 ? outcome.exitCode : 130,
				};
			if (outcome.exitCode !== undefined && outcome.exitCode !== 0)
				return { reason: "pty_exited_nonzero", severity: "failure" as const, status: outcome.exitCode };
			if (runtimeMatches && runtimeSemantic.state === "errored")
				return {
					reason:
						runtimeSemantic.source === "process_postmortem"
							? (runtimeSemantic.reason ?? "process_postmortem")
							: "runtime_errored",
					severity: "failure" as const,
					status: failureStatus,
				};
			if (runtimeMatches && runtimeSemantic.state === "completed")
				return {
					reason: "runtime_completed",
					severity: "normal" as const,
					status: outcome.exitCode ?? 0,
				};
			if (runtimeSemantic.readState !== "missing" && runtimeSemantic.readState !== "valid")
				return {
					reason: `runtime_state_${runtimeSemantic.readState}`,
					severity: "failure" as const,
					status: failureStatus,
				};
			if (!turnEvidencePresent)
				return { reason: "owner_exited_before_turn_evidence", severity: "failure" as const, status: failureStatus };
			if (runtimeMatches && (runtimeSemantic.state === "running" || runtimeSemantic.state === "needs_user_input"))
				return {
					reason: "owner_exited_after_runtime_acknowledgement_before_terminal_status",
					severity: "failure" as const,
					status: failureStatus,
				};
			if (promptBaselineDirty !== undefined && baselineDirty === false && currentDirty)
				return {
					reason: "accepted_prompt_observed_recoverable_worktree_changes",
					severity: "failure" as const,
					status: failureStatus,
				};
			if (promptBaselineDirty !== undefined && currentDirty)
				return {
					reason: "accepted_prompt_dirty_worktree_observed_without_new_change_proof",
					severity: "failure" as const,
					status: failureStatus,
				};
			if (promptBaselineDirty !== undefined)
				return { reason: "accepted_prompt_no_useful_output", severity: "failure" as const, status: failureStatus };
			return {
				reason: "owner_exited_before_prompt_acceptance",
				severity: "failure" as const,
				status: failureStatus,
			};
		})();
		const publicClassificationReason = redactVisibleText(classification.reason, [...secrets, ...promptSecrets]);
		const runtimeStateSummary = {
			...runtime,
			ownerExitReason: publicClassificationReason,
			severity: classification.severity,
		};
		revision = await state.appendEvent({
			expectedRevision: revision,
			entry: `owner exited reason=${publicClassificationReason}`,
		});
		await state.commitFinal({
			expectedRevision: revision,
			record: {
				schemaVersion: 2,
				backend: "conpty",
				generation: manifest.generationId,
				generationId: manifest.generationId,
				owner: projection.owner,
				session: manifest.name,
				status: classification.status,
				startedAt: manifest.createdAt,
				finishedAt: new Date(now()).toISOString(),
				paneLog: path.join(manifest.publicRoot, "pane.log"),
				runtimeState: path.join(manifest.publicRoot, "runtime-state.json"),
				turnEvidencePresent,
				promptAccepted: promptBaselineDirty !== undefined,
				ownerExitReason: publicClassificationReason,
				severity: classification.severity,
				runtimeTerminal: runtime.terminal,
				runtimeTerminalState: runtime.terminalState,
				runtimeTerminalSource: runtime.terminalSource,
				worktreeBaselineDirty: baselineDirty,
				observedRecoverableWorktreeChanges: currentDirty,
				worktreeChangedSinceBaseline: baselineDirty === false && currentDirty,
				runtimeStateSummary,
				committedAt: new Date(now()).toISOString(),
				runtimeSummary: runtime.summary,
				worktreeSummary: currentDirty
					? "recoverable worktree changes observed"
					: "no recoverable worktree changes observed",
				evidenceSummary:
					outputSuppressionReason ??
					(turnEvidencePresent ? "turn evidence observed" : "no turn evidence observed"),
			},
		});
		await queue;
		if (!controlCloseAttempted) {
			controlCloseAttempted = true;
			try {
				await control.close();
			} catch (error) {
				recordFailure(error);
			}
		} else if (fatalCloseTask) {
			await fatalCloseTask;
		}
		if (finalFailure !== undefined) throw finalFailure;
	} catch (error) {
		recordFailure(error);
	} finally {
		accepting = false;
		finalizing = true;
		if (dependencies.installSignalHandlers !== false)
			for (const signal of signals) process.removeListener(signal, kill);
		if (!controlCloseAttempted) {
			controlCloseAttempted = true;
			try {
				await control.close();
			} catch (error) {
				recordFailure(error);
			}
		} else if (fatalCloseTask) {
			await fatalCloseTask;
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Visible session owner failed");
}
