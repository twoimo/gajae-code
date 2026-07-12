import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { getSessionsDir } from "@gajae-code/utils";

import { prepareLaunchWorktree } from "../../gjc-runtime/launch-worktree";
import {
	FileSessionStorage,
	SessionDeleteVerificationError,
	type VerifiedSessionDeleteTarget,
} from "../../session/session-storage";
import { SdkClient, SdkClientError } from "../client/client";
import type { Broker, BrokerCleanupEvidence, BrokerResponse } from "./broker";

import { resolveSdkInternalSpawnCommand } from "./runtime";

const READY_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
const CLOSE_TIMEOUT_MS = 2_000;
type Input = Record<string, unknown>;
export const isCanonicalSessionId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const defaultStateRoot = (cwd: string) => path.join(path.resolve(cwd), ".gjc", "state");
const hasDefaultStateRoot = (cwd: string, root: string) => path.resolve(root) === defaultStateRoot(cwd);

export interface SessionLifecycleWorktreeTarget {
	enabled: true;
	name?: string;
}

export interface SessionLifecycleWorktreeReceipt {
	enabled: true;
	cwd: string;
	created: boolean;
	reused: boolean;
	branch?: string;
}

export interface SessionLifecycleLaunchRequest {
	operation: "session.create" | "session.fork" | "session.resume";
	sessionId: string;
	cwd: string;
	stateRoot: string;
	sourceSessionId?: string;
	sourceSessionPath?: string;
	sessionPath?: string;
	modelPreset?: string;
	worktree?: SessionLifecycleWorktreeTarget;
}

export function readSessionLifecycleLaunchRequest(value: string | undefined): SessionLifecycleLaunchRequest {
	if (!value) throw new Error("GJC_SDK_LIFECYCLE_REQUEST is required.");
	const request = JSON.parse(value) as Partial<SessionLifecycleLaunchRequest>;
	if (
		(request.operation !== "session.create" &&
			request.operation !== "session.fork" &&
			request.operation !== "session.resume") ||
		typeof request.sessionId !== "string" ||
		!isCanonicalSessionId(request.sessionId) ||
		typeof request.cwd !== "string" ||
		!request.cwd ||
		typeof request.stateRoot !== "string" ||
		!request.stateRoot ||
		!hasDefaultStateRoot(request.cwd, request.stateRoot) ||
		(request.sourceSessionId !== undefined &&
			(typeof request.sourceSessionId !== "string" || !isCanonicalSessionId(request.sourceSessionId))) ||
		(request.modelPreset !== undefined && (typeof request.modelPreset !== "string" || !request.modelPreset)) ||
		(request.worktree !== undefined && !isLifecycleWorktreeTarget(request.worktree))
	)
		throw new Error("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
	return request as SessionLifecycleLaunchRequest;
}

type SessionLaunch = {
	id: string;
	cwd: string;
	root: string;
	sourceSessionId?: string;
	sourceSessionPath?: string;
	sessionPath?: string;
	modelPreset?: string;
	worktree?: SessionLifecycleWorktreeTarget;
	worktreeReceipt?: SessionLifecycleWorktreeReceipt;
};

type CleanupEvidence = BrokerCleanupEvidence;

const fail = (code: string, message: string, cleanup?: CleanupEvidence): BrokerResponse => ({
	ok: false,
	error: { code: code as never, message, ...(cleanup ? { cleanup } : {}) },
});
function text(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}
function sessionId(input: Input): string | undefined {
	return text(input.sessionId) ?? text(input.id);
}
function lifecycleCwd(input: Input): string | undefined {
	const target = input.target as Record<string, unknown> | undefined;
	const cwd = text(input.cwd) ?? text(input.path) ?? text(target?.path);
	return cwd ? path.resolve(cwd) : undefined;
}
function stateRoot(input: Input, cwd: string | undefined): string | undefined {
	const target = input.target as Record<string, unknown> | undefined;
	const root = text(input.stateRoot) ?? text(target?.stateRoot);
	if (root) return path.resolve(root);
	return cwd ? path.join(cwd, ".gjc", "state") : undefined;
}

function isLifecycleWorktreeTarget(value: unknown): value is SessionLifecycleWorktreeTarget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const target = value as Record<string, unknown>;
	return (
		target.enabled === true &&
		(target.name === undefined || (typeof target.name === "string" && target.name.length > 0))
	);
}

function lifecycleWorktreeTarget(input: Input): SessionLifecycleWorktreeTarget | null | undefined {
	const target = input.target as Record<string, unknown> | undefined;
	const worktree = target?.worktree;
	if (worktree === undefined) return undefined;
	return isLifecycleWorktreeTarget(worktree) ? worktree : null;
}

async function reconcileReadyScope(broker: Broker, id: string, scope: string | undefined): Promise<void> {
	if (!scope) return;
	await broker.index.refresh();
	const record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (!record || record.locator.repo === scope) return;
	// The host records its physical cwd, which Darwin canonicalizes from /var to
	// /private/var. Preserve the lifecycle caller's lexical cwd for ACP's scoped
	// listing while retaining the host-provided state root for endpoint binding.
	await broker.index.append({
		type: "record_reconciled",
		sessionId: id,
		locator: { ...record.locator, repo: scope },
		endpointGeneration: record.endpointGeneration,
		pid: record.pid,
		endpointMtimeMs: record.endpointMtimeMs,
	});
}

function command(): { file: string; args: string[] } {
	const configured = process.env.GJC_SDK_SESSION_COMMAND;
	if (configured) {
		const [file, ...args] = configured.trim().split(/\s+/);
		if (file) return { file, args };
	}
	return resolveSdkInternalSpawnCommand("session-host-internal");
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lifecycleMarkerPath = (root: string, id: string) => path.join(root, "sdk", `${id}.lifecycle.json`);
type EffectMarker = { pid: number; effectMarker: string; incarnation: string };
const processIncarnationReadersForTest = new WeakMap<Broker, (pid: number) => string | undefined>();

export function setProcessIncarnationForTest(
	broker: Broker,
	value: ((pid: number) => string | undefined) | undefined,
): void {
	if (value) processIncarnationReadersForTest.set(broker, value);
	else processIncarnationReadersForTest.delete(broker);
}

function processIncarnationForBroker(broker: Broker, pid: number): string | undefined {
	return processIncarnationReadersForTest.get(broker)?.(pid) ?? processIncarnation(pid);
}

/** A PID is reusable; bind it to the OS-provided process start incarnation. */
function processIncarnation(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const startTicks = stat
				.slice(close + 2)
				.trim()
				.split(/\s+/)[19]; // field 22; suffix starts at field 3.
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === "darwin") {
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
		const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
		return started ? `darwin:${started}` : undefined;
	}
	return undefined;
}

type ProcessObservation = "alive" | "exited" | "uncertain";

/** Only ESRCH or a changed, readable incarnation proves the owned process exited. */
function observeProcess(
	pid: number,
	expectedIncarnation: string | undefined,
	readIncarnation: (pid: number) => string | undefined = processIncarnation,
): ProcessObservation {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "uncertain";
	}
	if (!expectedIncarnation) return "uncertain";
	const actualIncarnation = readIncarnation(pid);
	if (!actualIncarnation) return "uncertain";
	return actualIncarnation === expectedIncarnation ? "alive" : "exited";
}

function hasObservedProcessExit(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function writeEffectMarker(root: string, id: string, marker: EffectMarker): Promise<void> {
	await fs.mkdir(path.join(root, "sdk"), { recursive: true, mode: 0o700 });
	await fs.writeFile(lifecycleMarkerPath(root, id), JSON.stringify(marker), { mode: 0o600 });
}
async function hasDurableProcessIdentity(root: string, id: string, pid: number): Promise<boolean> {
	try {
		const marker = JSON.parse(await fs.readFile(lifecycleMarkerPath(root, id), "utf8")) as Partial<EffectMarker>;
		return (
			typeof marker.effectMarker === "string" &&
			marker.effectMarker.length > 0 &&
			marker.pid === pid &&
			typeof marker.incarnation === "string" &&
			marker.incarnation.length > 0 &&
			marker.incarnation === processIncarnation(pid)
		);
	} catch {
		return false;
	}
}
async function recordTerminalUncertain(broker: Broker, id: string, root: string, pid: number): Promise<void> {
	await broker.index.refresh();
	const registered = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (registered)
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId: id,
			locator: registered.locator,
			endpointGeneration: registered.endpointGeneration,
			pid: registered.pid,
			terminalUncertain: true,
		});
	else
		await broker.index.append({
			type: "lifecycle_terminal",
			sessionId: id,
			locator: { repo: "unknown", stateRoot: root },
			endpointGeneration: 0,
			pid,
			terminalUncertain: true,
		});
}
async function terminateSpawnedChild(child: ChildProcess, broker: Broker, id: string, root: string): Promise<boolean> {
	const pid = child.pid;
	if (!pid) return false;
	const incarnation = processIncarnationForBroker(broker, pid);
	const observe = (): ProcessObservation =>
		child.exitCode !== null
			? "exited"
			: observeProcess(pid, incarnation, value => processIncarnationForBroker(broker, value));
	const waitForExit = async (deadline: number): Promise<ProcessObservation> => {
		let observation = observe();
		while (observation === "alive" && Date.now() < deadline) {
			await sleep(POLL_MS);
			observation = observe();
		}
		return observation;
	};

	let observation = observe();
	if (observation === "alive") {
		if (!(await signalVerifiedSession({ locator: { stateRoot: root }, pid }, id, "SIGTERM"))) {
			observation = observe();
			if (observation !== "exited") {
				await recordTerminalUncertain(broker, id, root, pid);
				return false;
			}
		} else {
			observation = await waitForExit(Date.now() + CLOSE_TIMEOUT_MS);
		}
	}
	if (observation === "alive") {
		if (!(await signalVerifiedSession({ locator: { stateRoot: root }, pid }, id, "SIGKILL"))) {
			observation = observe();
			if (observation !== "exited") {
				await recordTerminalUncertain(broker, id, root, pid);
				return false;
			}
		} else {
			observation = await waitForExit(Date.now() + CLOSE_TIMEOUT_MS);
		}
	}
	if (observation !== "exited") {
		await recordTerminalUncertain(broker, id, root, pid);
		return false;
	}
	await fs.rm(path.join(root, "sdk", `${id}.json`), { force: true });
	await fs.rm(lifecycleMarkerPath(root, id), { force: true });
	await broker.index.refresh();
	const registered = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (registered)
		await broker.index.append({
			type: "session_closed",
			sessionId: id,
			locator: registered.locator,
			endpointGeneration: registered.endpointGeneration,
			pid: registered.pid,
		});
	return true;
}

async function signalVerifiedSession(
	record: { locator: { stateRoot: string }; pid: number },
	id: string,
	signal: NodeJS.Signals,
): Promise<boolean> {
	if (!(await hasDurableProcessIdentity(record.locator.stateRoot, id, record.pid))) return false;
	try {
		if (!(await hasDurableProcessIdentity(record.locator.stateRoot, id, record.pid))) return false;
		process.kill(record.pid, signal);
		return true;
	} catch {
		return false;
	}
}
async function endpointRemoved(root: string, id: string): Promise<boolean> {
	try {
		await fs.access(path.join(root, "sdk", `${id}.json`));
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}
async function waitForClose(
	broker: Broker,
	id: string,
	record: { locator: { stateRoot: string }; endpointGeneration: number; pid: number },
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await broker.index.refresh();
		if (
			broker.index.hasHostUnregistered(id, record.endpointGeneration, record.pid) &&
			(await endpointRemoved(record.locator.stateRoot, id)) &&
			hasObservedProcessExit(record.pid)
		)
			return true;
		await sleep(POLL_MS);
	}
	return false;
}
async function waitForReady(
	broker: Broker,
	id: string,
	root: string,
	timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
	const endpointPath = path.join(root, "sdk", `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const endpoint = JSON.parse(await fs.readFile(endpointPath, "utf8")) as {
				url?: unknown;
				token?: unknown;
				pid?: unknown;
			};
			await broker.index.refresh();
			const record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
			if (
				!record?.live ||
				endpoint.pid !== record.pid ||
				typeof endpoint.url !== "string" ||
				typeof endpoint.token !== "string"
			)
				continue;
			const client = await SdkClient.connect(endpoint.url, endpoint.token, {
				timeoutMs: Math.min(2_000, timeoutMs),
				reconnectAttempts: 0,
			});
			try {
				const replay = await client.request({
					type: "event_replay",
					sinceGeneration: record.endpointGeneration,
					sinceSeq: 0,
				});
				const events = (replay.events as unknown[]) ?? [];
				if (
					events.some(event => {
						const frame = event as Record<string, unknown>;
						return (
							frame.type === "event" &&
							frame.name === "session_ready" &&
							frame.sessionId === id &&
							frame.generation === record.endpointGeneration
						);
					})
				)
					return endpoint as Record<string, unknown>;
			} finally {
				await client.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// A partially initialized or unauthenticated endpoint is not ready yet.
			}
		}
		await new Promise(resolve => setTimeout(resolve, POLL_MS));
	}
	return undefined;
}
async function launchInput(
	broker: Broker,
	operation: "session.create" | "session.fork" | "session.resume",
	input: Input,
): Promise<SessionLaunch | BrokerResponse> {
	const requestedCwd = lifecycleCwd(input);
	if (!requestedCwd) return fail("invalid_input", "A target path is required.");
	const sourceCwd = requestedCwd;
	const suppliedRoot = stateRoot(input, requestedCwd);
	if (!suppliedRoot || !hasDefaultStateRoot(requestedCwd, suppliedRoot))
		return fail("invalid_input", "stateRoot must be the default .gjc/state for cwd.");

	try {
		if (!(await fs.stat(sourceCwd)).isDirectory())
			return fail("invalid_input", "Lifecycle worktree must be a directory.");
	} catch {
		return fail("invalid_input", "Lifecycle worktree does not exist.");
	}
	const worktree = lifecycleWorktreeTarget(input);
	if (worktree === null || (worktree !== undefined && requestedCwd === undefined))
		return fail("invalid_input", "Lifecycle worktree target is invalid.");
	let cwd = sourceCwd;
	let worktreeReceipt: SessionLifecycleWorktreeReceipt | undefined;
	if (worktree) {
		try {
			const prepared = prepareLaunchWorktree(sourceCwd, [
				worktree.name ? `--worktree=${worktree.name}` : "--worktree",
			]);
			if (!prepared.worktree.enabled) return fail("invalid_input", "Lifecycle worktree target is invalid.");
			cwd = path.resolve(prepared.cwd);
			worktreeReceipt = {
				enabled: true,
				cwd,
				created: prepared.worktree.created,
				reused: prepared.worktree.reused,
				...(prepared.worktree.branchName ? { branch: prepared.worktree.branchName } : {}),
			};
		} catch (error) {
			return fail(
				"invalid_input",
				`Unable to prepare lifecycle worktree: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const resolvedRoot = defaultStateRoot(cwd);

	const requested = sessionId(input);
	if (requested !== undefined && !isCanonicalSessionId(requested))
		return fail("invalid_input", "sessionId must be a canonical safe identifier.");
	const modelPreset = text(input.modelPreset);

	if (operation === "session.create")
		return { id: randomUUID(), cwd, root: resolvedRoot, modelPreset, worktree, worktreeReceipt };
	if (operation === "session.resume") {
		if (!requested) return fail("invalid_input", "sessionId is required to resume a saved session.");
		const savedPath = text(input.sessionPath);
		if (!savedPath) return fail("invalid_input", "sessionPath is required to resume a saved session.");
		try {
			await fs.access(savedPath);
		} catch {
			return fail("not_found", "Requested saved session does not exist.");
		}
		return { id: requested, cwd, root: resolvedRoot, sessionPath: savedPath, modelPreset, worktree, worktreeReceipt };
	}
	const sourceSessionId = text(input.sourceSessionId) ?? text(input.sourceId);
	if (sourceSessionId !== undefined && !isCanonicalSessionId(sourceSessionId))
		return fail("invalid_input", "sourceSessionId must be a canonical safe identifier.");
	const sourceSessionPath = text(input.sourceSessionPath) ?? text(input.sourcePath) ?? text(input.sessionPath);
	if (!sourceSessionId && !sourceSessionPath)
		return fail("invalid_input", "sourceSessionId or sourceSessionPath is required to fork a session.");
	if (
		sourceSessionId &&
		!sourceSessionPath &&
		!broker.index.listSessions().sessions.some(session => session.sessionId === sourceSessionId)
	)
		return fail("not_found", "Source session is not indexed.");
	if (sourceSessionPath) {
		try {
			await fs.access(sourceSessionPath);
		} catch {
			return fail("not_found", "Source saved session does not exist.");
		}
	}
	return {
		id: randomUUID(),
		cwd,
		root: resolvedRoot,
		sourceSessionId,
		sourceSessionPath,
		modelPreset,
		worktree,
		worktreeReceipt,
	};
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
type ValidatedDelete = {
	storage: FileSessionStorage;
	target: VerifiedSessionDeleteTarget;
	metadataRoot: string;
};

async function validateDeletePath(
	broker: Broker,
	input: Input,
	id: string,
	record: { locator: { repo: string; stateRoot: string } } | undefined,
): Promise<ValidatedDelete | BrokerResponse> {
	const sessionPath = text(input.sessionPath);
	const cwd = lifecycleCwd(input);
	if (!sessionPath || !cwd)
		return fail("invalid_input", "session.delete requires sessionPath and its configured cwd.");
	const requestedRoot = stateRoot(input, cwd);
	if (!requestedRoot || !hasDefaultStateRoot(cwd, requestedRoot))
		return fail("invalid_input", "stateRoot must be the default .gjc/state for cwd.");
	if (
		record &&
		(path.resolve(record.locator.repo) !== cwd || path.resolve(record.locator.stateRoot) !== requestedRoot)
	)
		return fail("invalid_input", "session.delete locator does not match the indexed session.");

	const unresolved = path.resolve(sessionPath);
	const storageRoot = await fs
		.realpath(getSessionsDir(broker.settings.agentDir))
		.catch(() => path.resolve(getSessionsDir(broker.settings.agentDir)));
	const canonicalParent = await fs.realpath(path.dirname(unresolved)).catch(() => path.dirname(unresolved));
	const candidate = path.join(canonicalParent, path.basename(unresolved));
	if (!candidate.endsWith(".jsonl") || !within(storageRoot, candidate))
		return fail("invalid_input", "session.delete path is outside the configured session storage root.");
	try {
		if ((await fs.lstat(candidate)).isSymbolicLink())
			return fail("invalid_input", "session.delete path is a symlink.");
	} catch {
		return fail("not_found", "Requested saved session does not exist.");
	}
	let resolved: string;
	try {
		resolved = await fs.realpath(candidate);
	} catch {
		return fail("not_found", "Requested saved session does not exist.");
	}
	if (!within(storageRoot, resolved))
		return fail("invalid_input", "session.delete path resolves outside the configured session storage root.");

	const storage = new FileSessionStorage();
	let snapshot: ReturnType<FileSessionStorage["readSnapshotSync"]>;
	try {
		snapshot = storage.readSnapshotSync(resolved);
	} catch {
		return fail("not_found", "Requested saved session does not exist or cannot be read.");
	}
	try {
		const newline = snapshot.bytes.indexOf(0x0a);
		const firstLine = Buffer.from(
			snapshot.bytes.subarray(0, newline === -1 ? snapshot.bytes.length : newline),
		).toString("utf8");
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
		if (header.type !== "session" || header.id !== id)
			return fail("invalid_input", "session.delete path does not contain the requested session.");
		if (typeof header.cwd !== "string")
			return fail("invalid_input", "session.delete transcript cwd does not match the configured cwd.");
		const transcriptCwd = header.cwd;
		const headerCwd = await fs.realpath(transcriptCwd).catch(() => path.resolve(transcriptCwd));
		const requestedCwd = await fs.realpath(cwd).catch(() => cwd);
		if (headerCwd !== requestedCwd)
			return fail("invalid_input", "session.delete transcript cwd does not match the configured cwd.");
	} catch {
		return fail("invalid_input", "Requested saved session has an invalid header.");
	}
	return {
		storage,
		target: {
			sessionsRoot: storageRoot,
			transcriptPath: resolved,
			sessionId: id,
			cwd,
			transcriptIdentity: { dev: snapshot.stat.dev, ino: snapshot.stat.ino },
		},
		metadataRoot: requestedRoot,
	};
}
type CloseAuthority = { endpointGeneration: number; endpointIncarnation: string };
type CloseRecord = {
	locator: { repo: string; stateRoot: string };
	endpointGeneration: number;
	pid: number;
	endpointMtimeMs?: number;
};

function endpointIncarnation(record: CloseRecord, sessionId: string): string | undefined {
	if (
		!Number.isSafeInteger(record.endpointGeneration) ||
		record.endpointGeneration <= 0 ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.endpointMtimeMs !== "number" ||
		!Number.isFinite(record.endpointMtimeMs) ||
		record.endpointMtimeMs <= 0
	)
		return undefined;
	return createHash("sha256")
		.update(
			JSON.stringify({
				endpointGeneration: record.endpointGeneration,
				endpointMtimeMs: record.endpointMtimeMs,
				pid: record.pid,
				sessionId,
			}),
		)
		.digest("hex");
}

function requestedCloseAuthority(input: Input): { authority: CloseAuthority | undefined } | { error: BrokerResponse } {
	const endpointGeneration = input.endpointGeneration;
	const endpointIncarnation = input.endpointIncarnation;
	if (endpointGeneration === undefined && endpointIncarnation === undefined) return { authority: undefined };
	if (
		typeof endpointGeneration !== "number" ||
		!Number.isSafeInteger(endpointGeneration) ||
		endpointGeneration <= 0 ||
		typeof endpointIncarnation !== "string" ||
		!/^[a-f0-9]{64}$/.test(endpointIncarnation)
	)
		return {
			error: fail("invalid_input", "session.close endpoint authority is invalid"),
		};
	return { authority: { endpointGeneration, endpointIncarnation } };
}

function sameCloseAuthority(authority: CloseAuthority, record: CloseRecord, sessionId: string): boolean {
	return (
		authority.endpointGeneration === record.endpointGeneration &&
		authority.endpointIncarnation === endpointIncarnation(record, sessionId)
	);
}

function sameCloseGeneration(expected: CloseRecord, current: CloseRecord & { live: boolean }): boolean {
	return (
		current.live &&
		current.endpointGeneration === expected.endpointGeneration &&
		current.pid === expected.pid &&
		current.endpointMtimeMs === expected.endpointMtimeMs &&
		path.resolve(current.locator.repo) === path.resolve(expected.locator.repo) &&
		path.resolve(current.locator.stateRoot) === path.resolve(expected.locator.stateRoot)
	);
}

async function revalidateCloseGeneration(
	broker: Broker,
	id: string,
	expected: CloseRecord,
	authority: CloseAuthority | undefined,
): Promise<BrokerResponse | undefined> {
	await broker.index.refresh();
	const current = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	return current &&
		sameCloseGeneration(expected, current) &&
		(!authority || sameCloseAuthority(authority, current, id))
		? undefined
		: fail("endpoint_stale", "session endpoint is stale");
}

function isTransportFailure(error: unknown): error is SdkClientError {
	return (
		error instanceof SdkClientError &&
		["unavailable", "timeout", "connection_closed", "reconnect_exhausted"].includes(error.code)
	);
}

function closeEndpoint(endpoint: unknown): { url: string; token: string } | undefined {
	if (typeof endpoint !== "object" || endpoint === null) return undefined;
	const value = endpoint as { url?: unknown; token?: unknown };
	return typeof value.url === "string" && typeof value.token === "string"
		? { url: value.url, token: value.token }
		: undefined;
}

/** Executes broker-owned global lifecycle effects. */
export async function executeLifecycle(
	broker: Broker,
	operation: string,
	input: Input,
	identity: string,
): Promise<BrokerResponse> {
	const requestedSessionId = sessionId(input);
	if (requestedSessionId !== undefined && !isCanonicalSessionId(requestedSessionId))
		return fail("invalid_input", "sessionId must be a canonical safe identifier.");
	const requestedSourceSessionId = text(input.sourceSessionId) ?? text(input.sourceId);
	if (requestedSourceSessionId !== undefined && !isCanonicalSessionId(requestedSourceSessionId))
		return fail("invalid_input", "sourceSessionId must be a canonical safe identifier.");
	if (operation === "session.create" || operation === "session.fork" || operation === "session.resume") {
		await broker.index.refresh();
		if (operation === "session.resume") {
			const requestedSessionId = sessionId(input);
			const existing = requestedSessionId
				? broker.index.listSessions().sessions.find(session => session.sessionId === requestedSessionId)
				: undefined;
			if (existing?.live) {
				const endpoint = await broker.handleRequest("session.get_endpoint", {
					sessionId: requestedSessionId,
					endpointGeneration: existing.endpointGeneration,
				});
				if (!endpoint.ok)
					return fail("live_session", "Session is already live but its generation-bound endpoint is unavailable.");
				return {
					ok: true,
					result: {
						sessionId: requestedSessionId,
						cwd: existing.locator.repo,
						endpointGeneration: existing.endpointGeneration,
						endpoint: endpoint.result,
						reused: true,
					},
				};
			}
		}
		const launch = await launchInput(broker, operation, input);
		if ("ok" in launch) return launch;
		const effectMarker = randomUUID();
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: launch.id, effectMarker });
		const cmd = command();
		const request: SessionLifecycleLaunchRequest = {
			operation,
			sessionId: launch.id,
			cwd: launch.cwd,
			stateRoot: launch.root,
			...(launch.sourceSessionId ? { sourceSessionId: launch.sourceSessionId } : {}),
			...(launch.sourceSessionPath ? { sourceSessionPath: launch.sourceSessionPath } : {}),
			...(launch.sessionPath ? { sessionPath: launch.sessionPath } : {}),
			...(launch.modelPreset ? { modelPreset: launch.modelPreset } : {}),
			...(launch.worktree ? { worktree: launch.worktree } : {}),
		};
		let child: ChildProcess | undefined;
		try {
			const spawned = spawn(cmd.file, cmd.args, {
				cwd: launch.cwd,
				detached: true,
				stdio: "ignore",
				env: {
					...process.env,
					GJC_AGENT_DIR: broker.settings.agentDir,
					GJC_CODING_AGENT_DIR: broker.settings.agentDir,
					GJC_SESSION_ID: launch.id,
					GJC_STATE_ROOT: launch.root,
					GJC_LIFECYCLE_REQUEST_ID: effectMarker,
					GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify(request),
				},
			});
			child = spawned;
			const pid = spawned.pid;
			if (!pid) throw new Error("spawned session has no pid");
			const incarnation = processIncarnationForBroker(broker, pid);
			if (!incarnation) throw new Error("spawned session has no readable OS incarnation");
			await writeEffectMarker(launch.root, launch.id, { pid, effectMarker, incarnation });
			spawned.unref();
		} catch (error) {
			const terminated = child ? await terminateSpawnedChild(child, broker, launch.id, launch.root) : true;
			return terminated
				? fail("spawn_failed", `Unable to spawn session: ${error instanceof Error ? error.message : String(error)}`)
				: fail(
						"terminal_uncertain",
						`Unable to establish spawned-session ownership and could not prove the child dead: ${error instanceof Error ? error.message : String(error)}`,
					);
		}
		if (!child) return fail("spawn_failed", "Unable to retain the spawned session process identity.");
		await broker.ledger.transition(identity, "awaiting_ready", { intendedSessionId: launch.id, effectMarker });
		const endpoint = await waitForReady(
			broker,
			launch.id,
			launch.root,
			Number(input.readinessTimeoutMs) || READY_TIMEOUT_MS,
		);
		if (!endpoint) {
			const terminated = await terminateSpawnedChild(child, broker, launch.id, launch.root);
			return terminated
				? fail(
						"readiness_timeout",
						`Session ${launch.id} did not register an endpoint before the readiness timeout.`,
					)
				: fail(
						"terminal_uncertain",
						`Session ${launch.id} did not become ready and its spawned process could not be verified dead.`,
					);
		}
		await reconcileReadyScope(broker, launch.id, launch.cwd);
		return {
			ok: true,
			result: {
				sessionId: launch.id,
				cwd: launch.cwd,
				endpoint,
				...(launch.worktreeReceipt ? { worktree: launch.worktreeReceipt } : {}),
			},
		};
	}

	const id = sessionId(input);
	if (!id) return fail("invalid_input", "sessionId is required.");
	if (!isCanonicalSessionId(id)) return fail("invalid_input", "sessionId must be a canonical safe identifier.");
	await broker.index.refresh();
	const record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (operation === "session.close") {
		if (!record) return fail("not_found", "session is not indexed");
		if (record.terminalUncertain)
			return fail("terminal_uncertain", "Session ownership is uncertain and cannot be closed safely.");
		const requestedAuthority = requestedCloseAuthority(input);
		if ("error" in requestedAuthority) return requestedAuthority.error;
		if (requestedAuthority.authority && !sameCloseAuthority(requestedAuthority.authority, record, id))
			return fail("endpoint_stale", "session endpoint is stale");
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: id, effectMarker: randomUUID() });

		let usedSignalFallback = false;
		let note: string | undefined;
		const endpointResult = await broker.handleRequest("session.get_endpoint", {
			sessionId: id,
			endpointGeneration: record.endpointGeneration,
		});
		if (!endpointResult.ok) {
			if (endpointResult.error.code === "endpoint_stale") return endpointResult;
			if (endpointResult.error.code !== "resource_gone") return endpointResult;
			usedSignalFallback = true;
		} else {
			const endpoint = closeEndpoint(endpointResult.result);
			if (!endpoint) return fail("close_refused", "Session endpoint is malformed.");
			let client: SdkClient | undefined;
			try {
				client = await SdkClient.connect(endpoint.url, endpoint.token, {
					timeoutMs: 2_000,
					reconnectAttempts: 0,
				});
				const refreshedEndpointResult = await broker.handleRequest("session.get_endpoint", {
					sessionId: id,
					endpointGeneration: record.endpointGeneration,
				});
				if (!refreshedEndpointResult.ok) return refreshedEndpointResult;
				const refreshedEndpoint = closeEndpoint(refreshedEndpointResult.result);
				if (
					!refreshedEndpoint ||
					refreshedEndpoint.url !== endpoint.url ||
					refreshedEndpoint.token !== endpoint.token
				)
					return fail("endpoint_stale", "session endpoint is stale");
				const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
				if (stale) return stale;
				const response = await client.control("session.close");
				if ((response as { ok?: unknown }).ok !== true)
					return fail("close_refused", "Session endpoint rejected session.close.");
			} catch (error) {
				if (isTransportFailure(error)) usedSignalFallback = true;
				else if (error instanceof SdkClientError) return fail(error.code, error.message);
				else
					return fail(
						"close_refused",
						`Session endpoint close failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			} finally {
				await client?.close();
			}
		}

		if (usedSignalFallback) {
			const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
			if (stale) return stale;
			if (!(await signalVerifiedSession(record, id, "SIGTERM")))
				return fail(
					"close_refused",
					"Session endpoint is unavailable and its durable process identity could not be verified.",
				);
			note = "Endpoint close was unreachable; sent SIGTERM to the durably identified session process.";
			if (!(await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS))) {
				const stale = await revalidateCloseGeneration(broker, id, record, requestedAuthority.authority);
				if (stale) return stale;
				if (!(await signalVerifiedSession(record, id, "SIGKILL")))
					return fail(
						"close_refused",
						"Session did not close after transport fallback and its durable process identity could not be verified for SIGKILL.",
					);
				note =
					"Endpoint close was unreachable and SIGTERM did not complete within the bounded deadline; sent SIGKILL to the durably identified session process.";
				if (!(await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS))) {
					await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
					return fail(
						"terminal_uncertain",
						"Session did not unregister, remove its endpoint, and exit after bounded transport fallback.",
					);
				}
			}
		} else if (!(await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS))) {
			await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
			return fail(
				"terminal_uncertain",
				"Session acknowledged session.close but did not unregister, remove its endpoint, and exit before the deadline.",
			);
		}

		return { ok: true, result: { sessionId: id, ...(note ? { note } : {}) } };
	}
	if (operation === "session.delete") {
		if (record?.terminalUncertain)
			return fail("terminal_uncertain", "Session ownership is uncertain and cannot be deleted safely.");
		if (record?.live) return fail("live_session", "Refusing to delete a live session; close it first.");
		const validated = await validateDeletePath(broker, input, id, record);
		if ("ok" in validated) return validated;
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: id, effectMarker: randomUUID() });
		let deleted: Awaited<ReturnType<FileSessionStorage["deleteSessionVerified"]>>;
		try {
			deleted = await validated.storage.deleteSessionVerified(validated.target);
		} catch (error) {
			if (error instanceof SessionDeleteVerificationError)
				return fail(
					"invalid_input",
					`Saved session deletion verification failed (${error.kind}): ${error.message}`,
				);
			return fail(
				"unavailable",
				`Unable to delete saved session artifacts: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (deleted.kind === "cleanup_pending")
			return fail(
				"cleanup_pending",
				`Saved session cleanup is pending in ${deleted.phase}: ${deleted.error.message}`,
				{
					phase: deleted.phase,
					transcriptIdentity: {
						dev: deleted.transcriptIdentity.dev.toString(),
						ino: deleted.transcriptIdentity.ino.toString(),
					},
					...(deleted.phase === "artifacts" && deleted.artifactsIdentity
						? {
								artifactsIdentity: {
									dev: deleted.artifactsIdentity.dev.toString(),
									ino: deleted.artifactsIdentity.ino.toString(),
								},
							}
						: {}),
				},
			);

		if (record)
			await broker.index.append({
				type: "session_closed",
				sessionId: id,
				locator: record.locator,
				endpointGeneration: record.endpointGeneration,
				pid: record.pid,
			});
		try {
			await fs.rm(lifecycleMarkerPath(validated.metadataRoot, id), { force: true });
		} catch (error) {
			return fail(
				"cleanup_pending",
				`Saved session was deleted but lifecycle metadata cleanup is pending: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ phase: "metadata" },
			);
		}
		return { ok: true, result: { sessionId: id } };
	}
	return fail("invalid_input", "Unknown lifecycle operation.");
}
