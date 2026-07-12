import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@gajae-code/natives";
import { type ControlCall, ControlClientError, LocalControlClient } from "./control-client";
import { controlEndpointFor } from "./control-server";
import {
	parseVisibleSessionOwnerReadyAcknowledgement,
	readVisibleSessionOwnerManifest,
	type VisibleSessionMonitorReadyAcknowledgement,
	type VisibleSessionOwnerManifest,
	type VisibleSessionOwnerReadyAcknowledgement,
	visibleSessionControlToken,
	visibleSessionMonitorReadyPath,
	visibleSessionOwnerReadyPath,
	visibleSessionStartupDiagnosticsPath,
} from "./launch";
import { isSameOrDescendant } from "./paths";
import { VisibleSessionRegistry } from "./registry";
import {
	type VisibleSessionRoleIdentity,
	VisibleSessionStateMonitor,
	type VisibleSessionStateProjection,
} from "./state";
import type { VisibleSessionGeneration, VisibleSessionRegistryFile } from "./types";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 1_000;
const DEFAULT_LOSS_CONFIRMATIONS = 3;
const DEFAULT_STATE_INITIALIZATION_ATTEMPTS = 30;
const CLEANUP_CLAIMANT = "visible-session-monitor";
const CLEANUP_RETRY_MS = 100;
const MAX_CLEANUP_RETRY_MS = 5_000;
const MAX_CONTROL_BACKOFF_MS = 5_000;

export interface VisibleSessionMonitorControlClient {
	call(call: ControlCall): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export interface VisibleSessionMonitorProcess {
	args(): string[];
	status(): ProcessStatus;
}

export interface VisibleSessionMonitorDependencies {
	registry?: Pick<VisibleSessionRegistry, "read">;
	readManifest?: (file: string) => Promise<VisibleSessionOwnerManifest>;
	readToken?: (file: string) => Promise<Buffer>;
	createControlClient?: (options: {
		endpoint: string;
		generation: string;
		token: string;
		timeoutMs: number;
	}) => VisibleSessionMonitorControlClient;
	processFromPid?: (pid: number) => VisibleSessionMonitorProcess | null;
	createState?: (
		rootOrProjection: string | VisibleSessionStateProjection,
		identity: VisibleSessionRoleIdentity,
	) => VisibleSessionStateMonitor;
	sleep?: (milliseconds: number) => Promise<void>;
	rm?: (file: string) => Promise<void>;
	readOwnerReady?: (file: string) => Promise<VisibleSessionOwnerReadyAcknowledgement>;
	writeMonitorReady?: (file: string, acknowledgement: VisibleSessionMonitorReadyAcknowledgement) => Promise<void>;
	writeMonitorHealth?: (
		file: string,
		token: string,
		failureCode: string,
		error: unknown,
		now: () => Date,
	) => Promise<void>;
	now?: () => Date;
	/** Cancels startup only; a ready monitor remains responsible for the detached owner. */
	signal?: AbortSignal;
	pollIntervalMs?: number;
	controlTimeoutMs?: number;
	lossConfirmations?: number;
	maxPolls?: number;
	stateInitializationAttempts?: number;
}
function controlFailureCode(error: unknown): string {
	if (error instanceof ControlClientError) return error.code;
	if (!error || typeof error !== "object") return "unknown";
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" ? code : "unknown";
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

function boundedError(error: unknown, token: string): string {
	const message = error instanceof Error ? error.message.replaceAll(/\s+/g, " ") : "unknown";
	return truncateUtf8(message.replaceAll(token, "[redacted]"), 256);
}
function boundedFailureCode(value: string, token: string): string {
	return truncateUtf8(value.replaceAll(token, "[redacted]").replaceAll(/\s+/g, "_"), 64);
}

type OwnerObservation = "live" | "lost" | "unknown";
type OwnerStatus = { generation: string; ready: boolean; running: boolean; cancelRequested: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isOwnerStatus(value: unknown): value is OwnerStatus {
	return (
		isRecord(value) &&
		exactKeys(value, ["generation", "ready", "running", "cancelRequested"]) &&
		typeof value.generation === "string" &&
		typeof value.ready === "boolean" &&
		typeof value.running === "boolean" &&
		typeof value.cancelRequested === "boolean"
	);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Visible session monitor ${name} is invalid`);
	return result;
}

function sameGeneration(manifest: VisibleSessionOwnerManifest, generation: VisibleSessionGeneration): boolean {
	return (
		generation.status === "active" &&
		generation.generationId === manifest.generationId &&
		generation.startIdentity === manifest.startIdentity &&
		generation.leaseId === manifest.leaseId &&
		generation.publicRoot === manifest.publicRoot &&
		generation.privateRoot === manifest.privateRoot &&
		generation.manifestFilePath === path.resolve(manifest.privateRoot, "manifest.json") &&
		generation.tokenFilePath === manifest.tokenFilePath &&
		generation.process !== undefined &&
		generation.process.startedAt === manifest.createdAt &&
		generation.process.hostname === os.hostname()
	);
}

function activeGeneration(
	registry: VisibleSessionRegistryFile,
	manifest: VisibleSessionOwnerManifest,
): VisibleSessionGeneration | null {
	const entry = registry.entries.find(candidate => candidate.name.key === manifest.key);
	if (
		!entry ||
		entry.repository !== manifest.repo ||
		entry.worktree !== manifest.worktree ||
		!sameGeneration(manifest, entry.active)
	)
		return null;
	return entry.active;
}
function registeredGeneration(
	registry: VisibleSessionRegistryFile,
	manifest: VisibleSessionOwnerManifest,
): VisibleSessionGeneration | null {
	const entry = registry.entries.find(candidate => candidate.name.key === manifest.key);
	if (!entry || entry.repository !== manifest.repo || entry.worktree !== manifest.worktree) return null;
	return [entry.active, ...entry.history].find(generation => sameGeneration(manifest, generation)) ?? null;
}

function ownerArgvMatches(args: readonly string[], manifest: VisibleSessionOwnerManifest): OwnerObservation {
	if (args.length === 0) return "unknown";
	const expected = manifest.ownerRoleArgv;
	if (args.length === expected.length && args.every((argument, index) => argument === expected[index])) return "live";
	if (args.length < expected.length && args.every((argument, index) => argument === expected[index])) return "unknown";
	return "lost";
}

function observeOwner(process: VisibleSessionMonitorProcess, manifest: VisibleSessionOwnerManifest): OwnerObservation {
	try {
		if (process.status() === ProcessStatus.Exited) return "lost";
		return ownerArgvMatches(process.args(), manifest);
	} catch {
		return "unknown";
	}
}

function isSafeCleanupPath(candidate: string, privateRoot: string): boolean {
	return path.isAbsolute(candidate) && candidate !== privateRoot && isSameOrDescendant(candidate, privateRoot);
}

function isRetryableCleanupIo(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "EBUSY" || code === "EINTR" || code === "EMFILE" || code === "ENFILE";
}
function throwIfMonitorCancelledBeforeReadiness(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Visible session monitor was cancelled before readiness");
}

async function removeCleanupFiles(
	files: readonly string[],
	remove: (file: string) => Promise<void>,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			for (const file of files) await remove(file);
			return;
		} catch (error) {
			if (!isRetryableCleanupIo(error) || attempt === 7) throw error;
			await sleep(Math.min(MAX_CLEANUP_RETRY_MS, CLEANUP_RETRY_MS * 2 ** attempt));
		}
	}
}

async function readTerminalIfInitialized(state: VisibleSessionStateMonitor): Promise<object | null> {
	try {
		return await state.readTerminal();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
async function defaultReadOwnerReady(file: string): Promise<VisibleSessionOwnerReadyAcknowledgement> {
	return parseVisibleSessionOwnerReadyAcknowledgement(JSON.parse(await fs.readFile(file, "utf8")));
}

async function ownerReadyAcknowledged(
	manifest: VisibleSessionOwnerManifest,
	ownerPid: number,
	readOwnerReady: (file: string) => Promise<VisibleSessionOwnerReadyAcknowledgement>,
): Promise<boolean> {
	try {
		const acknowledgement = await readOwnerReady(visibleSessionOwnerReadyPath(manifest.privateRoot));
		if (
			acknowledgement.generationId !== manifest.generationId ||
			acknowledgement.leaseId !== manifest.leaseId ||
			acknowledgement.ownerPid !== ownerPid
		)
			throw new Error("Visible session owner readiness receipt identity does not match");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function finishCleanup(
	state: VisibleSessionStateMonitor,
	manifest: VisibleSessionOwnerManifest,
	remove: (file: string) => Promise<void>,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
	const manifestFile = manifestPathFor(manifest);
	const bootstrap = [manifest.tokenFilePath, manifestFile];
	const receipt = await state.claimCleanup(CLEANUP_CLAIMANT);
	if (!receipt) {
		await removeCleanupFiles(bootstrap, remove, sleep);
		return;
	}
	if (receipt.generationId !== manifest.generationId)
		throw new Error("Visible session cleanup generation does not match the monitor manifest");
	const endpoint = controlEndpointFor({
		privateGenerationRoot: manifest.privateRoot,
		generation: manifest.generationId,
	});
	const files = [
		visibleSessionMonitorReadyPath(manifest.privateRoot),
		visibleSessionOwnerReadyPath(manifest.privateRoot),
		visibleSessionMonitorHealthPath(manifest.privateRoot),
		visibleSessionMonitorHealthFailurePath(manifest.privateRoot),
		visibleSessionStartupDiagnosticsPath(manifest.privateRoot),
		manifest.runtimeStatePath,
	];
	if (process.platform !== "win32" && manifest.controlEndpoint === endpoint) files.push(endpoint);
	if (
		[...files, ...bootstrap].some(file => !isSafeCleanupPath(file, manifest.privateRoot)) ||
		manifest.tokenFilePath !== path.join(manifest.privateRoot, "control-token")
	)
		throw new Error("Visible session cleanup paths are not generation-owned");
	await removeCleanupFiles(files, remove, sleep);
	await state.ackCleanup(CLEANUP_CLAIMANT);
	await removeCleanupFiles(bootstrap, remove, sleep);
}

function manifestPathFor(manifest: VisibleSessionOwnerManifest): string {
	return path.join(manifest.privateRoot, "manifest.json");
}
export function visibleSessionMonitorHealthPath(privateRoot: string): string {
	return path.join(privateRoot, "monitor-health.json");
}
export function visibleSessionMonitorHealthFailurePath(privateRoot: string): string {
	return path.join(privateRoot, "monitor-health-failure.json");
}

async function writePrivateMonitorHealth(
	file: string,
	token: string,
	failureCode: string,
	error: unknown,
	now: () => Date,
): Promise<void> {
	const message = boundedError(error, token);
	const record = {
		schemaVersion: 1,
		observedAt: now().toISOString(),
		failureCode,
		message,
	};
	await fs.writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
async function writePrivateMonitorHealthFailure(
	file: string,
	token: string,
	failureCode: string,
	controlFailure: unknown,
	sinkFailure: unknown,
	now: () => Date,
): Promise<void> {
	const record = {
		schemaVersion: 1,
		observedAt: now().toISOString(),
		failureCode: boundedFailureCode(failureCode, token),
		controlFailure: boundedError(controlFailure, token),
		sinkFailure: boundedError(sinkFailure, token),
	};
	await fs.writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function writeVisibleSessionMonitorReady(
	file: string,
	acknowledgement: VisibleSessionMonitorReadyAcknowledgement,
): Promise<void> {
	const body = `${JSON.stringify(acknowledgement)}\n`;
	try {
		await fs.writeFile(file, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await fs.readFile(file, "utf8")) !== body)
			throw new Error("Visible session monitor readiness receipt belongs to another monitor");
	}
}

/**
 * Hidden watchdog role. It writes only the irreversible vanished terminal record after
 * authenticated control loss and repeated, exact owner-process loss observations.
 */
export async function runVisibleSessionMonitor(
	manifestPath: string,
	dependencies: VisibleSessionMonitorDependencies = {},
): Promise<void> {
	if (!path.isAbsolute(manifestPath)) throw new Error("Visible session monitor manifest path must be absolute");
	const pollIntervalMs = positiveInteger(dependencies.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "poll interval");
	const controlTimeoutMs = positiveInteger(
		dependencies.controlTimeoutMs,
		DEFAULT_CONTROL_TIMEOUT_MS,
		"control timeout",
	);
	const lossConfirmations = positiveInteger(
		dependencies.lossConfirmations,
		DEFAULT_LOSS_CONFIRMATIONS,
		"loss confirmations",
	);
	const maxPolls =
		dependencies.maxPolls === undefined
			? Number.POSITIVE_INFINITY
			: positiveInteger(dependencies.maxPolls, 1, "max polls");
	const stateInitializationAttempts = positiveInteger(
		dependencies.stateInitializationAttempts,
		DEFAULT_STATE_INITIALIZATION_ATTEMPTS,
		"state initialization attempts",
	);
	const readManifest = dependencies.readManifest ?? readVisibleSessionOwnerManifest;
	const readToken = dependencies.readToken ?? (file => fs.readFile(file));
	const sleep = dependencies.sleep ?? (milliseconds => Bun.sleep(milliseconds));
	const remove = dependencies.rm ?? (file => fs.rm(file, { force: true }));
	const writeMonitorReady = dependencies.writeMonitorReady ?? writeVisibleSessionMonitorReady;
	const readOwnerReady = dependencies.readOwnerReady ?? defaultReadOwnerReady;
	const now = dependencies.now ?? (() => new Date());
	const writeMonitorHealth = dependencies.writeMonitorHealth ?? writePrivateMonitorHealth;
	throwIfMonitorCancelledBeforeReadiness(dependencies.signal);
	const manifest = await readManifest(manifestPath);
	if (manifestPath !== manifestPathFor(manifest))
		throw new Error("Visible session monitor manifest path is not generation-owned");
	const registry = dependencies.registry ?? new VisibleSessionRegistry({ agentDir: manifest.agentDir });
	const initial = registeredGeneration(await registry.read(), manifest);
	if (!initial?.process) throw new Error("Visible session monitor generation is not active or retained in history");
	let tokenBytes: Buffer | null;
	try {
		tokenBytes = await readToken(manifest.tokenFilePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		tokenBytes = null;
	}
	if (tokenBytes && createHash("sha256").update(tokenBytes).digest("hex") !== initial.tokenSha256)
		throw new Error("Visible session monitor token is invalid");
	const token = tokenBytes ? visibleSessionControlToken(tokenBytes) : null;
	const identity: VisibleSessionRoleIdentity = {
		generationId: manifest.generationId,
		leaseId: manifest.leaseId,
		owner: { pid: initial.process.pid, startIdentity: manifest.startIdentity },
		redactions: token ? [token] : [],
	};
	const projection: VisibleSessionStateProjection = {
		publicRoot: manifest.publicRoot,
		privateRoot: manifest.privateRoot,
		session: manifest.name,
		workdir: manifest.worktree,
		branch: manifest.branch,
		createdAt: manifest.createdAt,
		gjcBin: manifest.executable,
		worktreeBaselineDirty: manifest.worktreeBaselineDirty,
		owner: { pid: initial.process.pid, startedAt: initial.process.startedAt },
		backend: "conpty",
	};
	const state =
		dependencies.createState?.(projection, identity) ?? new VisibleSessionStateMonitor(projection, identity);
	throwIfMonitorCancelledBeforeReadiness(dependencies.signal);
	// A missing token is safe only with durable terminal evidence; otherwise fail closed.
	if (!token) {
		const terminal = await readTerminalIfInitialized(state);
		if (!terminal) throw new Error("Visible session monitor control token is missing before terminal cleanup");
		await finishCleanup(state, manifest, remove, sleep);
		return;
	}
	const fromPid = dependencies.processFromPid ?? (pid => Process.fromPid(pid));
	const ownerProcess = fromPid(initial.process.pid);
	if (!ownerProcess) {
		if (await readTerminalIfInitialized(state)) {
			await finishCleanup(state, manifest, remove, sleep);
			return;
		}
		throw new Error("Visible session monitor owner process is absent at startup");
	}
	for (let attempt = 0; ; attempt += 1) {
		try {
			await state.readMetadata();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const owner = observeOwner(ownerProcess, manifest);
			if (owner === "lost") throw new Error("Visible session owner exited before state initialization");
			if (owner === "unknown") {
				if (attempt + 1 >= stateInitializationAttempts)
					throw new Error("Visible session owner state initialization timed out");
				await sleep(pollIntervalMs);
				continue;
			}
			if (attempt + 1 >= stateInitializationAttempts)
				throw new Error("Visible session owner state initialization timed out");
			await sleep(pollIntervalMs);
		}
	}
	throwIfMonitorCancelledBeforeReadiness(dependencies.signal);
	await writeMonitorReady(visibleSessionMonitorReadyPath(manifest.privateRoot), {
		schemaVersion: 1,
		generationId: manifest.generationId,
		leaseId: manifest.leaseId,
		monitorPid: process.pid,
	});
	const client = (dependencies.createControlClient ?? (options => new LocalControlClient(options)))({
		endpoint: manifest.controlEndpoint,
		generation: manifest.generationId,
		token,
		timeoutMs: controlTimeoutMs,
	});
	let consecutiveLosses = 0;
	let controlFailures = 0;
	let endpointWasReady = await ownerReadyAcknowledged(manifest, initial.process.pid, readOwnerReady);
	// Registry drift does not release watchdog responsibility for this generation's cleanup.
	let cleanupOnly = false;
	for (let polls = 0; polls < maxPolls; polls += 1) {
		endpointWasReady ||= await ownerReadyAcknowledged(manifest, initial.process.pid, readOwnerReady);
		const terminal = await readTerminalIfInitialized(state);
		if (terminal) {
			await finishCleanup(state, manifest, remove, sleep);
			return;
		}
		if (!cleanupOnly) {
			const current = activeGeneration(await registry.read(), manifest);
			if (!current?.process || current.process.pid !== initial.process.pid) {
				cleanupOnly = true;
				const terminalAfterDrift = await readTerminalIfInitialized(state);
				if (terminalAfterDrift) {
					await finishCleanup(state, manifest, remove, sleep);
					return;
				}
			}
		}
		let controlFailure: unknown;
		let failureCode = "invalid_status";
		try {
			const response = await client.call({ action: "status" });
			if (
				response.ok &&
				isOwnerStatus(response.result) &&
				response.result.generation === manifest.generationId &&
				(response.result.running || response.result.cancelRequested)
			) {
				consecutiveLosses = 0;
				controlFailures = 0;
				endpointWasReady ||= response.result.ready;
				if (polls + 1 < maxPolls) await sleep(pollIntervalMs);
				continue;
			}
			failureCode = response.ok ? "invalid_status" : (response.error ?? "control_rejected");
			controlFailure = new Error(failureCode);
		} catch (error) {
			failureCode = controlFailureCode(error);
			controlFailure = error;
		}
		controlFailures += 1;
		try {
			await writeMonitorHealth(
				visibleSessionMonitorHealthPath(manifest.privateRoot),
				token,
				boundedFailureCode(failureCode, token),
				controlFailure,
				now,
			);
		} catch (error) {
			try {
				await writePrivateMonitorHealthFailure(
					visibleSessionMonitorHealthFailurePath(manifest.privateRoot),
					token,
					boundedFailureCode(failureCode, token),
					controlFailure,
					error,
					now,
				);
			} catch (evidenceError) {
				throw new AggregateError(
					[controlFailure, error, evidenceError],
					"Visible session monitor health and health-failure evidence writes failed",
				);
			}
		}
		const owner = observeOwner(ownerProcess, manifest);
		consecutiveLosses = owner === "lost" ? consecutiveLosses + 1 : 0;
		if (consecutiveLosses >= lossConfirmations) {
			const latestTerminal = await readTerminalIfInitialized(state);
			if (latestTerminal) {
				await finishCleanup(state, manifest, remove, sleep);
				return;
			}
			endpointWasReady ||= await ownerReadyAcknowledged(manifest, initial.process.pid, readOwnerReady);
			const metadata = await state.readMetadata();
			const committedAt = now().toISOString();
			try {
				await state.commitVanished({
					expectedRevision: metadata.revision,
					record: {
						schemaVersion: 2,
						backend: "conpty",
						generation: manifest.generationId,
						generationId: manifest.generationId,
						owner: projection.owner,
						session: manifest.name,
						workdir: manifest.worktree,
						detectedAt: committedAt,
						committedAt,
						reason: "owner_process_lost",
						phase: "owner_lost",
						severity: "failure",
						promptAccepted: await state.hasPromptAccepted(),
						finalPresent: false,
						tuiReady: endpointWasReady,
						paneLog: path.join(manifest.publicRoot, "pane.log"),
						eventsLog: path.join(manifest.publicRoot, "events.log"),
						finalStatus: path.join(manifest.publicRoot, "final.json"),
						runtimeState: path.join(manifest.publicRoot, "runtime-state.json"),
						promptAcceptedStatus: path.join(manifest.publicRoot, "prompt-accepted.json"),
						evidenceSummary:
							"control unavailable and exact owner PID was absent or no longer carried the owner manifest argv",
					},
				});
			} catch (error) {
				const committed = await readTerminalIfInitialized(state);
				if (!committed) throw error;
				await finishCleanup(state, manifest, remove, sleep);
				return;
			}
			const committed = await readTerminalIfInitialized(state);
			if (committed) await finishCleanup(state, manifest, remove, sleep);
			return;
		}
		if (polls + 1 < maxPolls)
			await sleep(Math.min(MAX_CONTROL_BACKOFF_MS, pollIntervalMs * 2 ** Math.min(controlFailures - 1, 5)));
	}
}
