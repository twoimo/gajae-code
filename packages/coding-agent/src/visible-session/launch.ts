import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ReadableStreamDefaultReader as NodeReadableStreamDefaultReader } from "node:stream/web";
import { type GjcRuntimeSpawnInfo, resolveGjcRuntimeSpawnInfo } from "../daemon/runtime";
import { type ControlCall, LocalControlClient } from "./control-client";
import { controlEndpointFor } from "./control-server";
import { isSameOrDescendant } from "./paths";
import type { VisibleSessionRegistry } from "./registry";
import type {
	CreateVisibleSessionInput,
	CreateVisibleSessionResult,
	RecreateVisibleSessionInput,
	VisibleSessionProcessIdentity,
} from "./types";

export function visibleSessionControlToken(bytes: Buffer): string {
	if (bytes.length !== 32) throw new Error("Visible session control token must be exactly 32 bytes");
	return bytes.toString("hex");
}

export const VISIBLE_SESSION_OWNER_MANIFEST_SCHEMA_VERSION = 3 as const;
const ROLE_PREFIX = "visible-session";
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const READY_RETRY_MS = 100;

export interface VisibleSessionExecutableSpec {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

/** Private, schema-versioned input consumed only by the owner and monitor roles. */
export interface VisibleSessionOwnerManifest {
	schemaVersion: typeof VISIBLE_SESSION_OWNER_MANIFEST_SCHEMA_VERSION;
	generationId: string;
	startIdentity: string;
	leaseId: string;
	agentDir: string;
	name: string;
	key: string;
	repo: string;
	worktree: string;
	backend: "conpty";
	publicRoot: string;
	privateRoot: string;
	tokenFilePath: string;
	controlEndpoint: string;
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	ownerReadyDeadline: string;
	createdAt: string;
	branch: string;
	worktreeBaselineDirty: boolean;
	runtimeStatePath: string;
	ownerRoleArgv: string[];
}

export interface VisibleSessionSpawnOptions {
	detached: true;
	stdin: "ignore";
	stdout: "ignore";
	stderr: "pipe";
	shell: false;
}
export interface VisibleSessionSpawnedProcess {
	pid: number;
	unref(): void;
	kill(signal?: NodeJS.Signals): void;
	exited?: Promise<number>;
	stderr?: ReadableStream<Uint8Array> | null;
}
export type VisibleSessionSpawn = (
	command: readonly string[],
	options: VisibleSessionSpawnOptions,
) => VisibleSessionSpawnedProcess;
export interface VisibleSessionReadyClient {
	call(call: ControlCall): Promise<{ ok: boolean; result?: unknown }>;
}
export interface VisibleSessionGitProbeResult {
	exitCode: number;
	stdout: string;
}

/** On abort, the runner must cancel its work and settle only after all owned resources are joined. */
export type VisibleSessionGitProbeRunner = (
	command: readonly string[],
	options: { deadline: number; signal: AbortSignal },
) => Promise<VisibleSessionGitProbeResult>;

export interface VisibleSessionMonitorReadyAcknowledgement {
	schemaVersion: 1;
	generationId: string;
	leaseId: string;
	monitorPid: number;
}
export interface VisibleSessionOwnerReadyAcknowledgement {
	schemaVersion: 1;
	generationId: string;
	leaseId: string;
	ownerPid: number;
}

export interface VisibleSessionTerminalAcknowledgement {
	generationId: string;
}

export interface VisibleSessionVanishedAcknowledgement {
	generationId: string;
}

export interface VisibleSessionLaunchRequest {
	registry: VisibleSessionRegistry;
	input: CreateVisibleSessionInput | RecreateVisibleSessionInput;
	executable: VisibleSessionExecutableSpec;
	/** Set only for compare-and-swap recreation requests. */
	recreate?: boolean;
	ownerReadyTimeoutMs?: number;
}
export interface VisibleSessionLaunchDependencies {
	runtime?: GjcRuntimeSpawnInfo;
	spawn?: VisibleSessionSpawn;
	createReadyClient?: (options: { endpoint: string; generation: string; token: string }) => VisibleSessionReadyClient;
	now?: () => number;
	gitProbe?: VisibleSessionGitProbeRunner;
	readMonitorReady?: (
		file: string,
		options?: { signal?: AbortSignal },
	) => Promise<VisibleSessionMonitorReadyAcknowledgement>;
	writeOwnerReady?: (
		file: string,
		acknowledgement: VisibleSessionOwnerReadyAcknowledgement,
		options?: { signal?: AbortSignal },
	) => Promise<void>;
	sleep?: (milliseconds: number) => Promise<void>;
	readTerminal?: (
		files: { final: string; vanished: string },
		options?: { signal?: AbortSignal },
	) => Promise<VisibleSessionTerminalAcknowledgement>;
	readVanished?: (file: string, options?: { signal?: AbortSignal }) => Promise<VisibleSessionVanishedAcknowledgement>;
	privateCredentialsPresent?: (
		manifest: VisibleSessionOwnerManifest,
		options?: { signal?: AbortSignal },
	) => Promise<boolean>;
}
export interface VisibleSessionLaunchReceipt {
	generationId: string;
	backend: string;
	publicRoot: string;
	ownerPid: number;
	monitorPid: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
	return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
		? value
		: null;
}
function nonEmptyText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function absolute(value: unknown): value is string {
	return nonEmptyText(value) && path.isAbsolute(value);
}
function environment(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.entries(value).every(([key, entry]) => key.length > 0 && typeof entry === "string");
}
function safePid(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}
function privatePath(candidate: string, root: string): boolean {
	return isSameOrDescendant(candidate, root) && candidate !== root;
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}
function agentDirForPrivateRoot(privateRoot: string, key: string, generationId: string): string | null {
	const keyRoot = path.dirname(privateRoot);
	const privateBase = path.dirname(keyRoot);
	const sessionsRoot = path.dirname(privateBase);
	const agentDir = path.dirname(sessionsRoot);
	if (
		path.basename(privateRoot) !== generationId ||
		path.basename(keyRoot) !== key ||
		path.basename(privateBase) !== "private" ||
		path.basename(sessionsRoot) !== "visible-sessions" ||
		!path.isAbsolute(agentDir) ||
		path.resolve(agentDir) !== agentDir ||
		privateRoot !== path.join(agentDir, "visible-sessions", "private", key, generationId)
	)
		return null;
	return agentDir;
}
function requiredAgentDirForPrivateRoot(privateRoot: string, key: string, generationId: string): string {
	const agentDir = agentDirForPrivateRoot(privateRoot, key, generationId);
	if (!agentDir) throw new Error("Visible session private generation root is invalid");
	return agentDir;
}

/** Builds the exact hidden role argv. No user configuration or secrets cross this boundary. */
export function visibleSessionRoleArgv(
	runtime: GjcRuntimeSpawnInfo,
	role: "owner-internal" | "monitor-internal",
	manifestPath: string,
): string[] {
	if (!path.isAbsolute(manifestPath)) throw new Error("Visible session manifest path must be absolute");
	return [...runtime.argsPrefix, ROLE_PREFIX, role, "--manifest", manifestPath];
}

export function parseVisibleSessionOwnerManifest(value: unknown): VisibleSessionOwnerManifest {
	const manifest = exactRecord(value, [
		"schemaVersion",
		"generationId",
		"startIdentity",
		"leaseId",
		"agentDir",
		"name",
		"key",
		"repo",
		"worktree",
		"backend",
		"publicRoot",
		"privateRoot",
		"tokenFilePath",
		"controlEndpoint",
		"executable",
		"args",
		"cwd",
		"env",
		"ownerReadyDeadline",
		"createdAt",
		"branch",
		"worktreeBaselineDirty",
		"runtimeStatePath",
		"ownerRoleArgv",
	]);
	if (
		!manifest ||
		manifest.schemaVersion !== VISIBLE_SESSION_OWNER_MANIFEST_SCHEMA_VERSION ||
		!nonEmptyText(manifest.generationId) ||
		!nonEmptyText(manifest.startIdentity) ||
		!nonEmptyText(manifest.leaseId) ||
		!absolute(manifest.agentDir) ||
		!nonEmptyText(manifest.name) ||
		!nonEmptyText(manifest.key) ||
		!absolute(manifest.repo) ||
		!absolute(manifest.worktree) ||
		manifest.backend !== "conpty" ||
		!absolute(manifest.publicRoot) ||
		!absolute(manifest.privateRoot) ||
		!absolute(manifest.tokenFilePath) ||
		!nonEmptyText(manifest.controlEndpoint) ||
		!absolute(manifest.executable) ||
		!strings(manifest.args) ||
		!absolute(manifest.cwd) ||
		!environment(manifest.env) ||
		!nonEmptyText(manifest.ownerReadyDeadline) ||
		!Number.isFinite(Date.parse(manifest.ownerReadyDeadline)) ||
		!nonEmptyText(manifest.createdAt) ||
		!Number.isFinite(Date.parse(manifest.createdAt)) ||
		!nonEmptyText(manifest.branch) ||
		manifest.branch === "HEAD" ||
		typeof manifest.worktreeBaselineDirty !== "boolean" ||
		!absolute(manifest.runtimeStatePath) ||
		manifest.runtimeStatePath !== path.join(manifest.privateRoot, "runtime-state.json") ||
		!strings(manifest.ownerRoleArgv) ||
		manifest.ownerRoleArgv.length === 0 ||
		!privatePath(manifest.tokenFilePath, manifest.privateRoot) ||
		path.basename(manifest.privateRoot) !== manifest.generationId ||
		path.basename(manifest.publicRoot) !== manifest.generationId ||
		agentDirForPrivateRoot(manifest.privateRoot, manifest.key, manifest.generationId) !== manifest.agentDir ||
		path.basename(path.dirname(manifest.publicRoot)) !== manifest.key ||
		manifest.controlEndpoint !==
			controlEndpointFor({ privateGenerationRoot: manifest.privateRoot, generation: manifest.generationId })
	) {
		throw new Error("Visible session owner manifest has an unsupported or corrupt schema");
	}
	return {
		schemaVersion: VISIBLE_SESSION_OWNER_MANIFEST_SCHEMA_VERSION,
		generationId: manifest.generationId,
		startIdentity: manifest.startIdentity,
		leaseId: manifest.leaseId,
		agentDir: manifest.agentDir,
		name: manifest.name,
		key: manifest.key,
		repo: manifest.repo,
		worktree: manifest.worktree,
		backend: manifest.backend,
		publicRoot: manifest.publicRoot,
		privateRoot: manifest.privateRoot,
		tokenFilePath: manifest.tokenFilePath,
		controlEndpoint: manifest.controlEndpoint,
		executable: manifest.executable,
		args: [...manifest.args],
		cwd: manifest.cwd,
		env: { ...manifest.env },
		ownerReadyDeadline: manifest.ownerReadyDeadline,
		createdAt: manifest.createdAt,
		branch: manifest.branch,
		worktreeBaselineDirty: manifest.worktreeBaselineDirty,
		runtimeStatePath: manifest.runtimeStatePath,
		ownerRoleArgv: [...manifest.ownerRoleArgv],
	};
}

export async function readVisibleSessionOwnerManifest(file: string): Promise<VisibleSessionOwnerManifest> {
	return parseVisibleSessionOwnerManifest(JSON.parse(await fs.readFile(file, "utf8")));
}

/** Writes the manifest through a private temporary file so readers never see partial JSON. */
export async function writeVisibleSessionOwnerManifest(
	file: string,
	manifest: VisibleSessionOwnerManifest,
): Promise<void> {
	parseVisibleSessionOwnerManifest(manifest);
	const parent = path.dirname(file);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	await fs.chmod(parent, 0o700);
	const temporary = path.join(parent, `.manifest-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
	await fs.writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	try {
		await fs.rename(temporary, file);
		await fs.chmod(file, 0o600);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

function defaultSpawn(command: readonly string[], options: VisibleSessionSpawnOptions): VisibleSessionSpawnedProcess {
	const child = Bun.spawn([...command], options);
	return {
		pid: child.pid,
		unref: () => child.unref(),
		kill: signal => child.kill(signal),
		exited: child.exited,
		stderr: child.stderr,
	};
}
function defaultReadyClient(options: {
	endpoint: string;
	generation: string;
	token: string;
}): VisibleSessionReadyClient {
	return new LocalControlClient(options);
}
function defaultSleep(milliseconds: number): Promise<void> {
	return Bun.sleep(milliseconds);
}
export function visibleSessionStartupDiagnosticsPath(privateRoot: string): string {
	return path.join(privateRoot, "startup-diagnostics.log");
}

function truncateUtf8(value: string, limit: number): string {
	if (Buffer.byteLength(value, "utf8") <= limit) return value;
	let result = "";
	for (const character of value) {
		if (Buffer.byteLength(result + character, "utf8") > limit) break;
		result += character;
	}
	return result;
}

interface Deadline {
	promise: Promise<never>;
	cancel(): void;
}

function deadlineAfter(milliseconds: number, message: string): Deadline {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(message)), milliseconds);
	return { promise: deadline.promise, cancel: () => clearTimeout(timer) };
}

class StartupDiagnosticsSink {
	#retainedBytes = 0;
	#closed = false;
	#capture = true;
	#serial: Promise<void> = Promise.resolve();
	#failures: unknown[] = [];
	readonly #sink: fs.FileHandle;
	readonly #redactions: readonly string[];
	readonly #readers = new Set<NodeReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>>();
	readonly #drains = new Set<Promise<void>>();

	constructor(sink: fs.FileHandle, redactions: readonly string[]) {
		this.#sink = sink;
		this.#redactions = [...redactions];
	}

	attach(role: string, stream: ReadableStream<Uint8Array> | null | undefined): void {
		const drain = this.#drain(role, stream);
		this.#drains.add(drain);
		void drain
			.catch(error => {
				this.#failures.push(error);
			})
			.finally(() => {
				this.#drains.delete(drain);
			});
	}

	async cutoff(): Promise<void> {
		this.#capture = false;
		const cancellations = await Promise.allSettled([...this.#readers].map(reader => reader.cancel()));
		for (const cancellation of cancellations) {
			if (cancellation.status === "rejected") this.#failures.push(cancellation.reason);
		}
		const drains = await Promise.allSettled([...this.#drains]);
		for (const drain of drains) {
			if (drain.status === "rejected" && !this.#failures.includes(drain.reason)) this.#failures.push(drain.reason);
		}
		try {
			await this.#serial;
		} catch (error) {
			if (!this.#failures.includes(error)) this.#failures.push(error);
		}
		if (!this.#closed) {
			this.#closed = true;
			try {
				await this.#sink.close();
			} catch (error) {
				this.#failures.push(error);
			}
		}
		if (this.#failures.length > 0)
			throw new AggregateError(this.#failures, "Visible session startup diagnostics could not be retained");
	}

	#append(text: string): Promise<void> {
		this.#serial = this.#serial.then(async () => {
			if (this.#retainedBytes >= 8_192) return;
			const output = truncateUtf8(text, 8_192 - this.#retainedBytes);
			if (output.length === 0) return;
			this.#retainedBytes += Buffer.byteLength(output, "utf8");
			await this.#sink.write(output);
		});
		return this.#serial;
	}

	async #drain(role: string, stream: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
		if (!stream) return;
		const reader = stream.getReader();
		this.#readers.add(reader);
		const decoder = new TextDecoder();
		const overlap = Math.max(0, ...this.#redactions.map(redaction => redaction.length - 1));
		let pending = "";
		let started = false;
		const write = async (text: string, final: boolean): Promise<void> => {
			pending += text;
			for (const redaction of this.#redactions) pending = pending.replaceAll(redaction, "[redacted]");
			const flushLength = final ? pending.length : Math.max(0, pending.length - overlap);
			if (flushLength === 0) return;
			const output = pending.slice(0, flushLength).replaceAll(/\s+/g, " ");
			pending = pending.slice(flushLength);
			if (!started && output.length > 0) {
				started = true;
				await this.#append(`\n--- ${role} stderr ---\n`);
			}
			await this.#append(output);
		};
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				if (!this.#capture) continue;
				await write(decoder.decode(chunk.value, { stream: true }), false);
			}
			if (this.#capture) await write(decoder.decode(), true);
		} finally {
			this.#readers.delete(reader);
			reader.releaseLock();
		}
	}
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit = 8_192): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return text;
			if (text.length < limit) text += decoder.decode(chunk.value, { stream: true }).slice(0, limit - text.length);
		}
	} finally {
		reader.releaseLock();
	}
}

async function defaultGitProbe(
	command: readonly string[],
	options: { deadline: number; signal: AbortSignal } = {
		deadline: Date.now() + DEFAULT_READY_TIMEOUT_MS,
		signal: new AbortController().signal,
	},
): Promise<VisibleSessionGitProbeResult> {
	const remaining = options.deadline - Date.now();
	if (remaining <= 0 || options.signal.aborted)
		throw new Error("Visible session Git probe exceeded the launch deadline");
	const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const output = readBounded(child.stdout);
	const errors = readBounded(child.stderr);
	const deadline = deadlineAfter(remaining, "Visible session Git probe exceeded the launch deadline");
	const aborted = Promise.withResolvers<never>();
	const abort = () => aborted.reject(new Error("Visible session Git probe was cancelled"));
	options.signal.addEventListener("abort", abort, { once: true });
	if (options.signal.aborted) abort();
	try {
		const [exitCode, [stdout]] = await Promise.race([
			Promise.all([child.exited, Promise.all([output, errors])]),
			deadline.promise,
			aborted.promise,
		]);
		return { exitCode, stdout };
	} catch (error) {
		try {
			child.kill("SIGKILL");
		} finally {
			await Promise.allSettled([child.exited, output, errors]);
		}
		throw error;
	} finally {
		options.signal.removeEventListener("abort", abort);
		deadline.cancel();
	}
}

export function visibleSessionMonitorReadyPath(privateRoot: string): string {
	return path.join(privateRoot, "monitor-ready.json");
}

export function parseVisibleSessionMonitorReadyAcknowledgement(
	value: unknown,
): VisibleSessionMonitorReadyAcknowledgement {
	const acknowledgement = exactRecord(value, ["schemaVersion", "generationId", "leaseId", "monitorPid"]);
	if (
		acknowledgement?.schemaVersion !== 1 ||
		!nonEmptyText(acknowledgement.generationId) ||
		!nonEmptyText(acknowledgement.leaseId) ||
		typeof acknowledgement.monitorPid !== "number" ||
		!safePid(acknowledgement.monitorPid)
	)
		throw new Error("Visible session monitor readiness acknowledgement is corrupt");
	return {
		schemaVersion: 1,
		generationId: acknowledgement.generationId,
		leaseId: acknowledgement.leaseId,
		monitorPid: acknowledgement.monitorPid,
	};
}
export function visibleSessionOwnerReadyPath(privateRoot: string): string {
	return path.join(privateRoot, "owner-ready.json");
}

export function parseVisibleSessionOwnerReadyAcknowledgement(value: unknown): VisibleSessionOwnerReadyAcknowledgement {
	const acknowledgement = exactRecord(value, ["schemaVersion", "generationId", "leaseId", "ownerPid"]);
	if (
		acknowledgement?.schemaVersion !== 1 ||
		!nonEmptyText(acknowledgement.generationId) ||
		!nonEmptyText(acknowledgement.leaseId) ||
		typeof acknowledgement.ownerPid !== "number" ||
		!safePid(acknowledgement.ownerPid)
	)
		throw new Error("Visible session owner readiness acknowledgement is corrupt");
	return {
		schemaVersion: 1,
		generationId: acknowledgement.generationId,
		leaseId: acknowledgement.leaseId,
		ownerPid: acknowledgement.ownerPid,
	};
}

export async function writeVisibleSessionOwnerReady(
	file: string,
	acknowledgement: VisibleSessionOwnerReadyAcknowledgement,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const body = `${JSON.stringify(parseVisibleSessionOwnerReadyAcknowledgement(acknowledgement))}\n`;
	try {
		await fs.writeFile(file, body, { encoding: "utf8", flag: "wx", mode: 0o600, signal: options.signal });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await fs.readFile(file, "utf8")) !== body)
			throw new Error("Visible session owner readiness receipt belongs to another owner");
	}
}

async function defaultReadMonitorReady(file: string): Promise<VisibleSessionMonitorReadyAcknowledgement> {
	return parseVisibleSessionMonitorReadyAcknowledgement(JSON.parse(await fs.readFile(file, "utf8")));
}
function parseVisibleSessionVanishedAcknowledgement(value: unknown): VisibleSessionVanishedAcknowledgement {
	if (!isRecord(value) || !nonEmptyText(value.generationId))
		throw new Error("Visible session vanished receipt is corrupt");
	if (
		value.schemaVersion === 1 &&
		exactRecord(value, ["schemaVersion", "generationId", "committedAt", "reason", "evidenceSummary"]) &&
		nonEmptyText(value.committedAt) &&
		Number.isFinite(Date.parse(value.committedAt)) &&
		nonEmptyText(value.reason) &&
		nonEmptyText(value.evidenceSummary)
	)
		return { generationId: value.generationId };
	if (
		value.schemaVersion === 2 &&
		exactRecord(value, [
			"schemaVersion",
			"backend",
			"generation",
			"generationId",
			"owner",
			"session",
			"workdir",
			"detectedAt",
			"committedAt",
			"reason",
			"phase",
			"severity",
			"promptAccepted",
			"finalPresent",
			"tuiReady",
			"paneLog",
			"eventsLog",
			"finalStatus",
			"runtimeState",
			"promptAcceptedStatus",
			"evidenceSummary",
		]) &&
		value.backend === "conpty" &&
		value.generation === value.generationId &&
		isRecord(value.owner) &&
		typeof value.owner.pid === "number" &&
		safePid(value.owner.pid) &&
		nonEmptyText(value.owner.startedAt) &&
		nonEmptyText(value.session) &&
		absolute(value.workdir) &&
		nonEmptyText(value.detectedAt) &&
		Number.isFinite(Date.parse(value.detectedAt)) &&
		nonEmptyText(value.committedAt) &&
		Number.isFinite(Date.parse(value.committedAt)) &&
		nonEmptyText(value.reason) &&
		nonEmptyText(value.phase) &&
		value.severity === "failure" &&
		typeof value.promptAccepted === "boolean" &&
		value.finalPresent === false &&
		typeof value.tuiReady === "boolean" &&
		absolute(value.paneLog) &&
		absolute(value.eventsLog) &&
		absolute(value.finalStatus) &&
		absolute(value.runtimeState) &&
		absolute(value.promptAcceptedStatus) &&
		nonEmptyText(value.evidenceSummary)
	)
		return { generationId: value.generationId };
	throw new Error("Visible session vanished receipt is corrupt");
}

async function defaultReadVanished(file: string): Promise<VisibleSessionVanishedAcknowledgement> {
	return parseVisibleSessionVanishedAcknowledgement(JSON.parse(await fs.readFile(file, "utf8")));
}
function publicText(value: unknown): value is string {
	return typeof value === "string" && !value.includes("\0");
}

function nullablePublicText(value: unknown): value is string | null {
	return value === null || publicText(value);
}

type StrictRuntimeStateSummary = {
	terminal: boolean;
	terminalState: string | null;
	terminalSource: string | null;
	ownerExitReason: string;
	severity: "normal" | "failure";
};

function strictRuntimeStateSummary(value: unknown): value is StrictRuntimeStateSummary {
	return (
		isRecord(value) &&
		exactRecord(value, [
			"summary",
			"status",
			"updatedAt",
			"present",
			"valid",
			"state",
			"source",
			"event",
			"reason",
			"terminal",
			"terminalState",
			"terminalSource",
			"finalResponsePresent",
			"previousRuntimeState",
			"sessionMatches",
			"cwdMatches",
			"ownerExitReason",
			"severity",
		]) !== null &&
		["summary", "status", "updatedAt", "ownerExitReason"].every(key => publicText(value[key])) &&
		["present", "valid", "terminal", "finalResponsePresent", "sessionMatches", "cwdMatches"].every(
			key => typeof value[key] === "boolean",
		) &&
		["state", "source", "event", "reason", "terminalState", "terminalSource", "previousRuntimeState"].every(key =>
			nullablePublicText(value[key]),
		) &&
		(value.severity === "normal" || value.severity === "failure")
	);
}

export function parseVisibleSessionFinalAcknowledgement(value: unknown): VisibleSessionTerminalAcknowledgement {
	const final = exactRecord(value, [
		"schemaVersion",
		"backend",
		"generation",
		"generationId",
		"owner",
		"session",
		"status",
		"startedAt",
		"finishedAt",
		"paneLog",
		"runtimeState",
		"turnEvidencePresent",
		"promptAccepted",
		"ownerExitReason",
		"severity",
		"runtimeTerminal",
		"runtimeTerminalState",
		"runtimeTerminalSource",
		"worktreeBaselineDirty",
		"observedRecoverableWorktreeChanges",
		"worktreeChangedSinceBaseline",
		"runtimeStateSummary",
		"committedAt",
		"runtimeSummary",
		"worktreeSummary",
		"evidenceSummary",
	]);
	const summary = final?.runtimeStateSummary;
	if (
		final?.schemaVersion !== 2 ||
		final.backend !== "conpty" ||
		!nonEmptyText(final.generationId) ||
		final.generation !== final.generationId ||
		!isRecord(final.owner) ||
		exactRecord(final.owner, ["pid", "startedAt"]) === null ||
		typeof final.owner.pid !== "number" ||
		!safePid(final.owner.pid) ||
		!publicText(final.owner.startedAt) ||
		typeof final.status !== "number" ||
		!Number.isSafeInteger(final.status) ||
		final.status < 0 ||
		[
			"session",
			"startedAt",
			"finishedAt",
			"paneLog",
			"runtimeState",
			"ownerExitReason",
			"committedAt",
			"runtimeSummary",
			"worktreeSummary",
			"evidenceSummary",
		].some(key => !publicText(final[key])) ||
		typeof final.turnEvidencePresent !== "boolean" ||
		typeof final.promptAccepted !== "boolean" ||
		(final.severity !== "normal" && final.severity !== "failure") ||
		typeof final.runtimeTerminal !== "boolean" ||
		!nullablePublicText(final.runtimeTerminalState) ||
		!nullablePublicText(final.runtimeTerminalSource) ||
		typeof final.worktreeBaselineDirty !== "boolean" ||
		typeof final.observedRecoverableWorktreeChanges !== "boolean" ||
		typeof final.worktreeChangedSinceBaseline !== "boolean" ||
		!strictRuntimeStateSummary(summary) ||
		final.runtimeTerminal !== summary.terminal ||
		final.runtimeTerminalState !== summary.terminalState ||
		final.runtimeTerminalSource !== summary.terminalSource ||
		final.ownerExitReason !== summary.ownerExitReason ||
		final.severity !== summary.severity
	)
		throw new Error("Visible session final receipt is corrupt");
	return { generationId: final.generationId };
}

async function defaultReadTerminal(files: {
	final: string;
	vanished: string;
}): Promise<VisibleSessionTerminalAcknowledgement> {
	try {
		return parseVisibleSessionFinalAcknowledgement(JSON.parse(await fs.readFile(files.final, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return defaultReadVanished(files.vanished);
}

async function defaultPrivateCredentialsPresent(manifest: VisibleSessionOwnerManifest): Promise<boolean> {
	for (const file of [
		manifest.tokenFilePath,
		manifestPathFor(manifest),
		visibleSessionMonitorReadyPath(manifest.privateRoot),
		visibleSessionOwnerReadyPath(manifest.privateRoot),
		manifest.runtimeStatePath,
		...(process.platform === "win32" ? [] : [manifest.controlEndpoint]),
	]) {
		try {
			await fs.access(file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return false;
}

class VisibleSessionReadinessError extends Error {
	readonly monitorReady: boolean;

	constructor(message: string, monitorReady: boolean) {
		super(message);
		this.monitorReady = monitorReady;
	}
}

async function waitForRecovery(
	manifest: VisibleSessionOwnerManifest,
	deadline: number,
	now: () => number,
	sleep: (milliseconds: number) => Promise<void>,
	readTerminal: (
		files: { final: string; vanished: string },
		options?: { signal?: AbortSignal },
	) => Promise<VisibleSessionTerminalAcknowledgement>,
	privateCredentialsPresent: (
		manifest: VisibleSessionOwnerManifest,
		options?: { signal?: AbortSignal },
	) => Promise<boolean>,
): Promise<void> {
	const terminalFiles = {
		final: path.join(manifest.publicRoot, "final.json"),
		vanished: path.join(manifest.publicRoot, "vanished.json"),
	};
	let terminalized = false;
	let privateCleanupComplete = false;
	let lastError: unknown;
	while (now() < deadline) {
		if (!terminalized) {
			try {
				terminalized =
					(await beforeDeadline(signal => readTerminal(terminalFiles, { signal }), deadline, now)).generationId ===
					manifest.generationId;
				if (!terminalized) lastError = new Error("terminal receipt generation does not match");
			} catch (error) {
				lastError = error;
			}
		}
		if (!privateCleanupComplete) {
			try {
				privateCleanupComplete = !(await beforeDeadline(
					signal => privateCredentialsPresent(manifest, { signal }),
					deadline,
					now,
				));
			} catch (error) {
				lastError = error;
			}
		}
		if (terminalized && privateCleanupComplete) return;
		const remaining = deadline - now();
		if (remaining > 0) await sleep(Math.min(READY_RETRY_MS, remaining));
	}
	throw new Error(
		`Visible session recovery monitor did not terminalize and clean up before its deadline${
			lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""
		}`,
	);
}

async function probeWorktreeBaseline(
	worktree: string,
	run: VisibleSessionGitProbeRunner,
	deadline: number,
	now: () => number,
): Promise<{ branch: string; worktreeBaselineDirty: boolean }> {
	const branchResult = await beforeGitDeadline(
		signal => run(["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { deadline, signal }),
		deadline,
		now,
	);
	const branch = branchResult.stdout.trim();
	if (branchResult.exitCode !== 0 || branch.length === 0 || branch === "HEAD")
		throw new Error("Visible session worktree branch probe failed");
	const statusResult = await beforeGitDeadline(
		signal =>
			run(["git", "-C", worktree, "status", "--porcelain=v1", "--untracked-files=normal"], { deadline, signal }),
		deadline,
		now,
	);
	if (statusResult.exitCode !== 0) throw new Error("Visible session worktree status probe failed");
	return { branch, worktreeBaselineDirty: statusResult.stdout.length > 0 };
}
function createManifest(
	result: CreateVisibleSessionResult,
	spec: VisibleSessionExecutableSpec,
	runtime: GjcRuntimeSpawnInfo,
	deadline: number,
	createdAt: number,
	baseline: { branch: string; worktreeBaselineDirty: boolean },
): VisibleSessionOwnerManifest {
	const { entry, generation } = result;
	return {
		schemaVersion: VISIBLE_SESSION_OWNER_MANIFEST_SCHEMA_VERSION,
		generationId: generation.generationId,
		startIdentity: generation.startIdentity,
		leaseId: generation.leaseId,
		agentDir: requiredAgentDirForPrivateRoot(generation.privateRoot, entry.name.key, generation.generationId),
		name: entry.name.displayName,
		key: entry.name.key,
		repo: entry.repository,
		worktree: entry.worktree,
		backend: "conpty",
		publicRoot: generation.publicRoot,
		privateRoot: generation.privateRoot,
		tokenFilePath: generation.tokenFilePath,
		controlEndpoint: controlEndpointFor({
			privateGenerationRoot: generation.privateRoot,
			generation: generation.generationId,
		}),
		executable: spec.executable,
		args: [...spec.args],
		cwd: spec.cwd,
		env: { ...spec.env },
		ownerReadyDeadline: new Date(deadline).toISOString(),
		createdAt: new Date(createdAt).toISOString(),
		branch: baseline.branch,
		worktreeBaselineDirty: baseline.worktreeBaselineDirty,
		runtimeStatePath: path.join(generation.privateRoot, "runtime-state.json"),
		ownerRoleArgv: [
			runtime.execPath,
			...visibleSessionRoleArgv(runtime, "owner-internal", generation.manifestFilePath),
		],
	};
}
function assertBeforeDeadline(deadline: number, now: () => number): void {
	if (deadline - now() <= 0) throw new Error("Visible session launch deadline elapsed");
}
type DeadlineOperationResult<T> = { kind: "success"; value: T } | { kind: "failure"; error: unknown };
type DeadlineOperation<T> = (signal: AbortSignal) => Promise<T>;
async function deadlineOutcome<T>(operation: Promise<T>): Promise<DeadlineOperationResult<T>> {
	return operation.then(
		value => ({ kind: "success", value }),
		error => ({ kind: "failure", error }),
	);
}
const deadlineTimeout = Symbol.for("visible-session-launch-deadline-timeout");
async function observeDeadlineOperation<T>(operation: Promise<DeadlineOperationResult<T>>): Promise<void> {
	await operation;
}
async function beforeDeadline<T>(operation: DeadlineOperation<T>, deadline: number, now: () => number): Promise<T> {
	const remaining = deadline - now();
	if (remaining <= 0) throw new Error("Visible session launch deadline elapsed");
	const timeout = deadlineAfter(remaining, "Visible session launch deadline elapsed");
	const controller = new AbortController();
	const started = deadlineOutcome(operation(controller.signal));
	const result = await Promise.race([
		started,
		timeout.promise
			.then<DeadlineOperationResult<T>>(() => ({
				kind: "failure",
				error: deadlineTimeout,
			}))
			.catch<DeadlineOperationResult<T>>(() => ({
				kind: "failure",
				error: deadlineTimeout,
			})),
	]);
	timeout.cancel();
	if (result.kind === "failure" && result.error === deadlineTimeout) {
		controller.abort();
		await observeDeadlineOperation(started);
		throw new Error("Visible session launch deadline elapsed");
	}
	if (result.kind === "failure") {
		if (deadline - now() <= 0) throw new Error("Visible session launch deadline elapsed");
		throw result.error;
	}
	assertBeforeDeadline(deadline, now);
	return result.value;
}
async function beforeGitDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	deadline: number,
	now: () => number,
): Promise<T> {
	return beforeDeadline(operation, deadline, now);
}

async function waitForReady(
	client: VisibleSessionReadyClient,
	monitorReadyPath: string,
	ownerReadyPath: string,
	generationId: string,
	leaseId: string,
	ownerPid: number,
	monitorPid: number,
	deadline: number,
	now: () => number,
	sleep: (milliseconds: number) => Promise<void>,
	readMonitorReady: (
		file: string,
		options?: { signal?: AbortSignal },
	) => Promise<VisibleSessionMonitorReadyAcknowledgement>,
	writeOwnerReady: (
		file: string,
		acknowledgement: VisibleSessionOwnerReadyAcknowledgement,
		options?: { signal?: AbortSignal },
	) => Promise<void>,
): Promise<void> {
	let monitorReady = false;
	let lastError: unknown;
	while (now() < deadline) {
		try {
			const acknowledgement = await beforeDeadline(
				signal => readMonitorReady(monitorReadyPath, { signal }),
				deadline,
				now,
			);
			monitorReady =
				acknowledgement.generationId === generationId &&
				acknowledgement.leaseId === leaseId &&
				acknowledgement.monitorPid === monitorPid;
			if (!monitorReady) {
				lastError = new Error("monitor readiness acknowledgement identity does not match");
			} else {
				const response = await beforeDeadline(() => client.call({ action: "ready" }), deadline, now);
				if (response.ok && response.result === true) {
					await beforeDeadline(
						signal =>
							writeOwnerReady(ownerReadyPath, { schemaVersion: 1, generationId, leaseId, ownerPid }, { signal }),
						deadline,
						now,
					);
					return;
				}
				lastError = new Error("owner readiness response was not an affirmative protocol acknowledgement");
			}
		} catch (error) {
			lastError = error;
		}
		const remaining = deadline - now();
		if (remaining > 0) await sleep(Math.min(READY_RETRY_MS, remaining));
	}
	throw new VisibleSessionReadinessError(
		`Visible session roles did not become ready before their deadline${
			lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""
		}`,
		monitorReady,
	);
}
async function stop(
	process: VisibleSessionSpawnedProcess | undefined,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<{ stopped: boolean; error?: unknown }> {
	if (!process) return { stopped: true };
	const exited = process.exited;
	if (!exited) return { stopped: false, error: new Error("Visible session process exit cannot be observed") };
	const waitForExit = async (): Promise<boolean> =>
		Promise.race([exited.then(() => true), sleep(READY_RETRY_MS).then(() => false)]);
	try {
		process.kill();
		if (await waitForExit()) return { stopped: true };
		process.kill("SIGKILL");
		if (await waitForExit()) return { stopped: true };
		return { stopped: false, error: new Error("Visible session process did not exit after hard kill") };
	} catch (error) {
		return { stopped: false, error };
	}
}

function manifestPathFor(manifest: VisibleSessionOwnerManifest): string {
	return path.join(manifest.privateRoot, "manifest.json");
}
interface RoleExitObservation {
	hasExited(): boolean;
	failure: Promise<never>;
}

function observeRoleExit(role: string, child: VisibleSessionSpawnedProcess): RoleExitObservation {
	if (!child.exited) {
		return {
			hasExited: () => true,
			failure: Promise.reject(new Error(`Visible session ${role} role exit cannot be observed during readiness`)),
		};
	}
	let exited = false;
	const settled = child.exited.then(code => {
		exited = true;
		return code;
	});
	const failure: Promise<never> = settled.then(code => {
		throw new Error(`Visible session ${role} role exited before readiness (exit code ${code})`);
	});
	void failure.catch(() => undefined);
	return {
		hasExited: () => exited,
		failure,
	};
}

async function waitForMonitorAcknowledgement(
	monitorReadyPath: string,
	generationId: string,
	leaseId: string,
	monitorPid: number,
	deadline: number,
	now: () => number,
	sleep: (milliseconds: number) => Promise<void>,
	readMonitorReady: (
		file: string,
		options?: { signal?: AbortSignal },
	) => Promise<VisibleSessionMonitorReadyAcknowledgement>,
): Promise<void> {
	let lastError: unknown;
	while (now() < deadline) {
		try {
			const acknowledgement = await beforeDeadline(
				signal => readMonitorReady(monitorReadyPath, { signal }),
				deadline,
				now,
			);
			if (
				acknowledgement.generationId === generationId &&
				acknowledgement.leaseId === leaseId &&
				acknowledgement.monitorPid === monitorPid
			)
				return;
			lastError = new Error("monitor readiness acknowledgement identity does not match");
		} catch (error) {
			lastError = error;
		}
		const remaining = deadline - now();
		if (remaining > 0) await sleep(Math.min(READY_RETRY_MS, remaining));
	}
	throw new Error(
		`Visible session recovery monitor did not acknowledge before its deadline${
			lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""
		}`,
	);
}

/**
 * Allocates a prepared generation, starts private owner and monitor roles, and reports only after authenticated readiness.
 * Failed active launches leave terminal public evidence and are cleaned up by the monitor role.
 */
export async function launchVisibleSession(
	request: VisibleSessionLaunchRequest,
	dependencies: VisibleSessionLaunchDependencies = {},
): Promise<VisibleSessionLaunchReceipt> {
	if (
		!Number.isInteger(request.ownerReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) ||
		(request.ownerReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) < 1
	)
		throw new Error("Visible session owner readiness timeout is invalid");
	if (request.input.backend !== "conpty")
		throw new Error("Visible session launch requires the conpty backend");
	const now = dependencies.now ?? Date.now;
	const createdAt = now();
	const deadline = createdAt + (request.ownerReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
	const runtime = dependencies.runtime ?? resolveGjcRuntimeSpawnInfo();
	const spawn = dependencies.spawn ?? defaultSpawn;
	const createReadyClient = dependencies.createReadyClient ?? defaultReadyClient;
	const sleep = dependencies.sleep ?? defaultSleep;
	const readMonitorReady = dependencies.readMonitorReady ?? defaultReadMonitorReady;
	const writeOwnerReady = dependencies.writeOwnerReady ?? writeVisibleSessionOwnerReady;
	const readTerminal =
		dependencies.readTerminal ??
		(dependencies.readVanished
			? async (files: { final: string; vanished: string }) => dependencies.readVanished!(files.vanished)
			: defaultReadTerminal);
	const privateCredentialsPresent = dependencies.privateCredentialsPresent ?? defaultPrivateCredentialsPresent;
	const baseline = await probeWorktreeBaseline(
		request.input.worktree,
		dependencies.gitProbe ?? defaultGitProbe,
		deadline,
		now,
	);
	assertBeforeDeadline(deadline, now);
	const created = request.recreate
		? await request.registry.recreate(request.input as RecreateVisibleSessionInput)
		: await request.registry.create(request.input);
	assertBeforeDeadline(deadline, now);
	const token = visibleSessionControlToken(await fs.readFile(created.generation.tokenFilePath));
	const manifest = createManifest(created, request.executable, runtime, deadline, createdAt, baseline);
	if (JSON.stringify(manifest).includes(token))
		throw new Error("Visible session owner manifest must not contain a control token value");
	assertBeforeDeadline(deadline, now);
	await writeVisibleSessionOwnerManifest(created.generation.manifestFilePath, manifest);
	assertBeforeDeadline(deadline, now);
	const diagnostics = new StartupDiagnosticsSink(
		await fs.open(visibleSessionStartupDiagnosticsPath(manifest.privateRoot), "a", 0o600),
		[token],
	);
	let owner: VisibleSessionSpawnedProcess | undefined;
	let monitor: VisibleSessionSpawnedProcess | undefined;
	let activated: CreateVisibleSessionResult | undefined;
	let processIdentity: VisibleSessionProcessIdentity | undefined;
	let ownerExit: RoleExitObservation | undefined;
	let monitorExit: RoleExitObservation | undefined;
	try {
		assertBeforeDeadline(deadline, now);
		owner = spawn(
			[runtime.execPath, ...visibleSessionRoleArgv(runtime, "owner-internal", created.generation.manifestFilePath)],
			{
				detached: true,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				shell: false,
			},
		);
		if (!safePid(owner.pid)) throw new Error("Visible session owner spawn returned an invalid PID");
		owner.unref();
		diagnostics.attach("owner", owner.stderr);
		ownerExit = observeRoleExit("owner", owner);
		processIdentity = { pid: owner.pid, startedAt: manifest.createdAt, hostname: os.hostname() };
		assertBeforeDeadline(deadline, now);
		activated = await request.registry.activateOwner({
			expectedRevision: created.revision,
			generationId: created.generation.generationId,
			startIdentity: created.generation.startIdentity,
			process: processIdentity,
		});
		assertBeforeDeadline(deadline, now);
		monitor = spawn(
			[
				runtime.execPath,
				...visibleSessionRoleArgv(runtime, "monitor-internal", created.generation.manifestFilePath),
			],
			{
				detached: true,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				shell: false,
			},
		);
		if (!safePid(monitor.pid)) throw new Error("Visible session monitor spawn returned an invalid PID");
		monitor.unref();
		diagnostics.attach("monitor", monitor.stderr);
		monitorExit = observeRoleExit("monitor", monitor);
		assertBeforeDeadline(deadline, now);
		const readyClient = createReadyClient({
			endpoint: manifest.controlEndpoint,
			generation: manifest.generationId,
			token,
		});
		const ready = waitForReady(
			readyClient,
			visibleSessionMonitorReadyPath(manifest.privateRoot),
			visibleSessionOwnerReadyPath(manifest.privateRoot),
			manifest.generationId,
			manifest.leaseId,
			owner.pid,
			monitor.pid,
			deadline,
			now,
			sleep,
			readMonitorReady,
			writeOwnerReady,
		);
		await Promise.race([ready, ownerExit.failure, monitorExit.failure]);
		await Promise.race([Bun.sleep(0), ownerExit.failure, monitorExit.failure]);
		if (ownerExit.hasExited()) throw new Error("Visible session owner role exited during readiness");
		if (monitorExit.hasExited()) throw new Error("Visible session monitor role exited during readiness");
		await Promise.race([diagnostics.cutoff(), ownerExit.failure, monitorExit.failure]);
		if (ownerExit.hasExited()) throw new Error("Visible session owner role exited during readiness");
		if (monitorExit.hasExited()) throw new Error("Visible session monitor role exited during readiness");
		return {
			generationId: activated.generation.generationId,
			backend: "conpty",
			publicRoot: activated.generation.publicRoot,
			ownerPid: owner.pid,
			monitorPid: monitor.pid,
		};
	} catch (error) {
		const failures: unknown[] = [error];
		if (activated && processIdentity) {
			let recoveryMonitor = monitor;
			let recoveryExit = monitorExit;
			const roleExitedDuringReadiness = Boolean(ownerExit?.hasExited() || monitorExit?.hasExited());
			let monitorsSettled = true;
			let monitorAcknowledged =
				error instanceof VisibleSessionReadinessError && error.monitorReady && !monitorExit?.hasExited();
			if (!monitorAcknowledged) {
				const monitorStop = await stop(monitor, sleep);
				if (!monitorStop.stopped) {
					failures.push(monitorStop.error);
					monitorsSettled = false;
				}
				if (monitorStop.stopped && !roleExitedDuringReadiness) {
					recoveryMonitor = undefined;
					recoveryExit = undefined;
					try {
						await fs.rm(visibleSessionMonitorReadyPath(manifest.privateRoot), { force: true });
						recoveryMonitor = spawn(
							[
								runtime.execPath,
								...visibleSessionRoleArgv(runtime, "monitor-internal", created.generation.manifestFilePath),
							],
							{
								detached: true,
								stdin: "ignore",
								stdout: "ignore",
								stderr: "pipe",
								shell: false,
							},
						);
						if (!safePid(recoveryMonitor.pid))
							throw new Error("Visible session recovery monitor spawn returned an invalid PID");
						recoveryMonitor.unref();
						diagnostics.attach("recovery monitor", recoveryMonitor.stderr);
						recoveryExit = observeRoleExit("recovery monitor", recoveryMonitor);
						await Promise.race([
							waitForMonitorAcknowledgement(
								visibleSessionMonitorReadyPath(manifest.privateRoot),
								manifest.generationId,
								manifest.leaseId,
								recoveryMonitor.pid,
								now() + (request.ownerReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
								now,
								sleep,
								readMonitorReady,
							),
							recoveryExit.failure,
						]);
						await Promise.resolve();
						monitorAcknowledged = !recoveryExit.hasExited();
						if (!monitorAcknowledged)
							throw new Error("Visible session recovery monitor exited before acknowledgement");
					} catch (caught) {
						failures.push(caught);
						const recoveryStop = await stop(recoveryMonitor, sleep);
						if (!recoveryStop.stopped) {
							failures.push(recoveryStop.error);
							monitorsSettled = false;
						}
						recoveryMonitor = recoveryStop.stopped ? undefined : recoveryMonitor;
						recoveryExit = recoveryStop.stopped ? undefined : recoveryExit;
					}
				}
			}
			const ownerStop = await stop(owner, sleep);
			if (!ownerStop.stopped) failures.push(ownerStop.error);
			let rollback =
				monitorsSettled && (roleExitedDuringReadiness || !monitorAcknowledged || !recoveryMonitor || !recoveryExit);
			if (ownerStop.stopped && !rollback && recoveryMonitor && recoveryExit) {
				try {
					await Promise.race([
						waitForRecovery(
							manifest,
							now() + (request.ownerReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
							now,
							sleep,
							readTerminal,
							privateCredentialsPresent,
						),
						recoveryExit.failure,
					]);
				} catch (caught) {
					failures.push(caught);
					if (recoveryExit.hasExited()) rollback = true;
				}
			}
			if (ownerStop.stopped && rollback) {
				try {
					await request.registry.rollbackOwnerActivation({
						expectedRevision: activated.revision,
						generationId: activated.generation.generationId,
						startIdentity: activated.generation.startIdentity,
						process: processIdentity,
					});
				} catch (caught) {
					failures.push(caught);
				}
			}
		} else {
			const ownerStop = await stop(owner, sleep);
			if (!ownerStop.stopped) failures.push(ownerStop.error);
		}
		await Bun.sleep(0);
		try {
			await diagnostics.cutoff();
		} catch (caught) {
			failures.push(caught);
		}
		if (failures.length > 1)
			throw new AggregateError(
				failures,
				`Visible session launch failed during recovery: ${failures
					.map(failure => (failure instanceof Error ? failure.message : String(failure)))
					.join("; ")}`,
			);
		throw error;
	}
}
