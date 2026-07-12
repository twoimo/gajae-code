import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { SdkClient } from "../client/client";
import { FileSessionStorage } from "../../session/session-storage";
import type { Broker, BrokerResponse } from "./broker";
import { isPidAlive } from "./discovery";

const READY_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
const CLOSE_TIMEOUT_MS = 2_000;
type Input = Record<string, unknown>;

export interface SessionLifecycleLaunchRequest {
	operation: "session.create" | "session.fork" | "session.resume";
	sessionId: string;
	stateRoot: string;
	sourceSessionId?: string;
	sourceSessionPath?: string;
	sessionPath?: string;
}

export function readSessionLifecycleLaunchRequest(value: string | undefined): SessionLifecycleLaunchRequest {
	if (!value) throw new Error("GJC_SDK_LIFECYCLE_REQUEST is required.");
	const request = JSON.parse(value) as Partial<SessionLifecycleLaunchRequest>;
	if (
		(request.operation !== "session.create" && request.operation !== "session.fork" && request.operation !== "session.resume") ||
		typeof request.sessionId !== "string" || !request.sessionId ||
		typeof request.stateRoot !== "string" || !request.stateRoot
	) throw new Error("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
	return request as SessionLifecycleLaunchRequest;
}

type SessionLaunch = {
	id: string;
	root: string;
	sourceSessionId?: string;
	sourceSessionPath?: string;
	sessionPath?: string;
};

const fail = (code: string, message: string): BrokerResponse => ({ ok: false, error: { code: code as never, message } });
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function sessionId(input: Input): string | undefined { return text(input.sessionId) ?? text(input.id); }
function stateRoot(input: Input): string | undefined {
	const target = input.target as Record<string, unknown> | undefined;
	const root = text(input.stateRoot) ?? text(target?.stateRoot);
	if (root) return root;
	const cwd = text(input.cwd) ?? text(input.path) ?? text(target?.path);
	return cwd ? path.join(cwd, ".gjc", "state") : undefined;
}
function command(): { file: string; args: string[] } {
	const configured = process.env.GJC_SDK_SESSION_COMMAND;
	if (configured) {
		const [file, ...args] = configured.trim().split(/\s+/);
		if (file) return { file, args };
	}
	const entrypoint = process.argv[1]?.endsWith("cli.ts") ? process.argv[1] : path.resolve(import.meta.dir, "../../cli.ts");
	return { file: process.execPath, args: [entrypoint, "sdk", "session-host-internal"] };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lifecycleMarkerPath = (root: string, id: string) => path.join(root, "sdk", `${id}.lifecycle.json`);
type EffectMarker = { pid: number; effectMarker: string; incarnation: string };

/** A PID is reusable; bind it to the OS-provided process start incarnation. */
function processIncarnation(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const startTicks = stat.slice(close + 2).trim().split(/\s+/)[19]; // field 22; suffix starts at field 3.
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch { return undefined; }
	}
	if (process.platform === "darwin") {
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
		const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
		return started ? `darwin:${started}` : undefined;
	}
	return undefined;
}
async function writeEffectMarker(root: string, id: string, marker: EffectMarker): Promise<void> {
	await fs.mkdir(path.join(root, "sdk"), { recursive: true, mode: 0o700 });
	await fs.writeFile(lifecycleMarkerPath(root, id), JSON.stringify(marker), { mode: 0o600 });
}
async function hasDurableProcessIdentity(root: string, id: string, pid: number): Promise<boolean> {
	try {
		const marker = JSON.parse(await fs.readFile(lifecycleMarkerPath(root, id), "utf8")) as Partial<EffectMarker>;
		return typeof marker.effectMarker === "string" && marker.effectMarker.length > 0 && marker.pid === pid &&
			typeof marker.incarnation === "string" && marker.incarnation.length > 0 && marker.incarnation === processIncarnation(pid);
	} catch { return false; }
}
async function recordTerminalUncertain(broker: Broker, id: string, root: string, pid: number): Promise<void> {
	await broker.index.refresh();
	const registered = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (registered) await broker.index.append({ type: "lifecycle_terminal", sessionId: id, locator: registered.locator, endpointGeneration: registered.endpointGeneration, pid: registered.pid, terminalUncertain: true });
	else await broker.index.append({ type: "lifecycle_terminal", sessionId: id, locator: { repo: "unknown", stateRoot: root }, endpointGeneration: 0, pid, terminalUncertain: true });
}
async function terminateSpawnedChild(child: ChildProcess, broker: Broker, id: string, root: string): Promise<boolean> {
	const pid = child.pid;
	if (!pid) return false;
	const incarnation = processIncarnation(pid);
	const alive = (): boolean => incarnation !== undefined && processIncarnation(pid) === incarnation;
	const signal = async (value: NodeJS.Signals): Promise<boolean> => !alive() || signalVerifiedSession({ locator: { stateRoot: root }, pid }, id, value);
	if (!await signal("SIGTERM")) { await recordTerminalUncertain(broker, id, root, pid); return false; }
	const deadline = Date.now() + CLOSE_TIMEOUT_MS;
	while (alive() && Date.now() < deadline) await sleep(POLL_MS);
	if (alive()) {
		if (!await signal("SIGKILL")) { await recordTerminalUncertain(broker, id, root, pid); return false; }
		const killDeadline = Date.now() + CLOSE_TIMEOUT_MS;
		while (alive() && Date.now() < killDeadline) await sleep(POLL_MS);
	}
	if (alive()) { await recordTerminalUncertain(broker, id, root, pid); return false; }
	await fs.rm(path.join(root, "sdk", `${id}.json`), { force: true });
	await fs.rm(lifecycleMarkerPath(root, id), { force: true });
	await broker.index.refresh();
	const registered = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (registered) await broker.index.append({ type: "session_closed", sessionId: id, locator: registered.locator, endpointGeneration: registered.endpointGeneration, pid: registered.pid });
	return true;
}
async function signalVerifiedSession(record: { locator: { stateRoot: string }; pid: number }, id: string, signal: NodeJS.Signals): Promise<boolean> {
	if (!await hasDurableProcessIdentity(record.locator.stateRoot, id, record.pid)) return false;
	try {
		if (!await hasDurableProcessIdentity(record.locator.stateRoot, id, record.pid)) return false;
		process.kill(record.pid, signal);
		return true;
	} catch { return false; }
}
async function endpointRemoved(root: string, id: string): Promise<boolean> {
	try {
		await fs.access(path.join(root, "sdk", `${id}.json`));
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}
async function waitForClose(broker: Broker, id: string, record: { locator: { stateRoot: string }; endpointGeneration: number; pid: number }, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await broker.index.refresh();
		if (
			broker.index.hasHostUnregistered(id, record.endpointGeneration, record.pid) &&
			(await endpointRemoved(record.locator.stateRoot, id)) &&
			!isPidAlive(record.pid)
		) return true;
		await sleep(POLL_MS);
	}
	return false;
}
async function waitForReady(broker: Broker, id: string, root: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
	const endpointPath = path.join(root, "sdk", `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const endpoint = JSON.parse(await fs.readFile(endpointPath, "utf8")) as { url?: unknown; token?: unknown; pid?: unknown };
			await broker.index.refresh();
			const record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
			if (!record || !record.live || endpoint.pid !== record.pid || typeof endpoint.url !== "string" || typeof endpoint.token !== "string") continue;
			const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: Math.min(2_000, timeoutMs), reconnectAttempts: 0 });
			try {
				const replay = await client.request({ type: "event_replay", sinceGeneration: record.endpointGeneration, sinceSeq: 0 });
				const events = (replay.events as unknown[]) ?? [];
				if (events.some(event => {
					const frame = event as Record<string, unknown>;
					return frame.type === "event" && frame.name === "session_ready" && frame.sessionId === id && frame.generation === record.endpointGeneration;
				})) return endpoint as Record<string, unknown>;
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
async function launchInput(broker: Broker, operation: "session.create" | "session.fork" | "session.resume", input: Input): Promise<SessionLaunch | BrokerResponse> {
	const root = stateRoot(input);
	if (!root) return fail("invalid_input", "A target path or stateRoot is required.");
	const requested = sessionId(input);
	if (operation === "session.create") return { id: randomUUID(), root };
	if (operation === "session.resume") {
		if (!requested) return fail("invalid_input", "sessionId is required to resume a saved session.");
		const savedPath = text(input.sessionPath);
		if (!savedPath) return fail("invalid_input", "sessionPath is required to resume a saved session.");
		try { await fs.access(savedPath); } catch { return fail("not_found", "Requested saved session does not exist."); }
		return { id: requested, root, sessionPath: savedPath };
	}
	const sourceSessionId = text(input.sourceSessionId) ?? text(input.sourceId);
	const sourceSessionPath = text(input.sourceSessionPath) ?? text(input.sourcePath) ?? text(input.sessionPath);
	if (!sourceSessionId && !sourceSessionPath) return fail("invalid_input", "sourceSessionId or sourceSessionPath is required to fork a session.");
	if (sourceSessionId && !sourceSessionPath && !broker.index.listSessions().sessions.some(session => session.sessionId === sourceSessionId))
		return fail("not_found", "Source session is not indexed.");
	if (sourceSessionPath) {
		try { await fs.access(sourceSessionPath); } catch { return fail("not_found", "Source saved session does not exist."); }
	}
	return { id: randomUUID(), root, sourceSessionId, sourceSessionPath };
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
async function validateDeletePath(broker: Broker, input: Input, id: string, record: { locator: { stateRoot: string } } | undefined): Promise<string | BrokerResponse> {
	const sessionPath = text(input.sessionPath);
	const cwd = text(input.cwd) ?? text((input.target as Record<string, unknown> | undefined)?.path);
	if (!sessionPath || !cwd) return fail("invalid_input", "session.delete requires sessionPath and its configured cwd.");
	const unresolved = path.resolve(sessionPath);
	const storageRoot = await fs.realpath(path.resolve(broker.settings.agentDir, "sessions")).catch(() => path.resolve(broker.settings.agentDir, "sessions"));
	const canonicalParent = await fs.realpath(path.dirname(unresolved)).catch(() => path.dirname(unresolved));
	const candidate = path.join(canonicalParent, path.basename(unresolved));
	if (!candidate.endsWith(".jsonl") || !within(storageRoot, candidate)) return fail("invalid_input", "session.delete path is outside the configured session storage root.");
	let resolved: string;
	try { resolved = await fs.realpath(candidate); }
	catch { return fail("not_found", "Requested saved session does not exist."); }
	if (!within(storageRoot, resolved)) return fail("invalid_input", "session.delete path resolves outside the configured session storage root.");
	if (record) {
		const requestedRoot = stateRoot(input);
		if (!requestedRoot || path.resolve(requestedRoot) !== path.resolve(record.locator.stateRoot)) return fail("invalid_input", "session.delete locator does not match the indexed session.");
	}
	try {
		const firstLine = (await fs.readFile(resolved, "utf8")).split("\n", 1)[0];
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		if (header.type !== "session" || header.id !== id) return fail("invalid_input", "session.delete path does not contain the requested session.");
	} catch { return fail("not_found", "Requested saved session does not exist or has an invalid header."); }
	return resolved;
}
/** Executes broker-owned global lifecycle effects. */
export async function executeLifecycle(broker: Broker, operation: string, input: Input, identity: string): Promise<BrokerResponse> {
	if (operation === "session.create" || operation === "session.fork" || operation === "session.resume") {
		await broker.index.refresh();
		const launch = await launchInput(broker, operation, input);
		if ("ok" in launch) return launch;
		const effectMarker = randomUUID();
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: launch.id, effectMarker });
		const cmd = command();
		const request: SessionLifecycleLaunchRequest = {
			operation,
			sessionId: launch.id,
			stateRoot: launch.root,
			...(launch.sourceSessionId ? { sourceSessionId: launch.sourceSessionId } : {}),
			...(launch.sourceSessionPath ? { sourceSessionPath: launch.sourceSessionPath } : {}),
			...(launch.sessionPath ? { sessionPath: launch.sessionPath } : {}),
		};
		let child: ChildProcess | undefined;
		try {
			const spawned = spawn(cmd.file, cmd.args, {
				cwd: text(input.cwd) ?? text((input.target as Record<string, unknown> | undefined)?.path) ?? process.cwd(),
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
			const incarnation = processIncarnation(pid);
			if (!incarnation) throw new Error("spawned session has no readable OS incarnation");
			await writeEffectMarker(launch.root, launch.id, { pid, effectMarker, incarnation });
			spawned.unref();
		} catch (error) {
			const terminated = child ? await terminateSpawnedChild(child, broker, launch.id, launch.root) : true;
			return terminated
				? fail("spawn_failed", `Unable to spawn session: ${error instanceof Error ? error.message : String(error)}`)
				: fail("terminal_uncertain", `Unable to establish spawned-session ownership and could not prove the child dead: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!child) return fail("spawn_failed", "Unable to retain the spawned session process identity.");
		await broker.ledger.transition(identity, "awaiting_ready", { intendedSessionId: launch.id, effectMarker });
		const endpoint = await waitForReady(broker, launch.id, launch.root, Number(input.readinessTimeoutMs) || READY_TIMEOUT_MS);
		if (!endpoint) {
			const terminated = await terminateSpawnedChild(child, broker, launch.id, launch.root);
			return terminated
				? fail("readiness_timeout", `Session ${launch.id} did not register an endpoint before the readiness timeout.`)
				: fail("terminal_uncertain", `Session ${launch.id} did not become ready and its spawned process could not be verified dead.`);
		}
		return { ok: true, result: { sessionId: launch.id, endpoint } };
	}

	const id = sessionId(input);
	if (!id) return fail("invalid_input", "sessionId is required.");
	await broker.index.refresh();
	const record = broker.index.listSessions().sessions.find(session => session.sessionId === id);
	if (operation === "session.close") {
		if (!record) return fail("not_found", "session is not indexed");
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: id, effectMarker: randomUUID() });
		let note: string | undefined;
		try {
			const endpoint = JSON.parse(await fs.readFile(path.join(record.locator.stateRoot, "sdk", `${id}.json`), "utf8")) as { url?: string; token?: string };
			if (!endpoint.url || !endpoint.token) throw new Error("endpoint has no URL or token");
			const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
			try {
				const response = await client.control("session.close");
				if ((response as { ok?: unknown }).ok !== true) throw new Error("endpoint rejected session.close");
			} finally {
				await client.close();
			}
		} catch {
			if (!await signalVerifiedSession(record, id, "SIGTERM"))
				return fail("close_refused", "Session endpoint is unavailable and its durable process identity could not be verified.");
			note = "Endpoint close unavailable; sent SIGTERM to the durably identified session process.";
		}
		if (!await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS)) {
			if (!await signalVerifiedSession(record, id, "SIGTERM"))
				return fail("close_refused", "Session did not close and its durable process identity could not be verified for SIGTERM.");
			note ??= "Graceful close did not complete within 2000ms; sent SIGTERM to the durably identified session process.";
			if (!await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS)) {
				if (!await signalVerifiedSession(record, id, "SIGKILL"))
					return fail("close_refused", "Session did not close after SIGTERM and its durable process identity could not be verified for SIGKILL.");
				note = "Graceful close and SIGTERM did not complete within bounded deadlines; sent SIGKILL to the durably identified session process.";
				if (!await waitForClose(broker, id, record, CLOSE_TIMEOUT_MS)) {
					await recordTerminalUncertain(broker, id, record.locator.stateRoot, record.pid);
					return fail("terminal_uncertain", "Session did not unregister, remove its endpoint, and exit after bounded SIGTERM/SIGKILL fallback.");
				}
			}
		}
		await broker.index.append({ type: "session_closed", sessionId: id, locator: record.locator, endpointGeneration: record.endpointGeneration, pid: record.pid });
		await fs.rm(lifecycleMarkerPath(record.locator.stateRoot, id), { force: true });
		return { ok: true, result: { sessionId: id, ...(note ? { note } : {}) } };
	}
	if (operation === "session.delete") {
		if (record?.live) return fail("live_session", "Refusing to delete a live session; close it first.");
		const validated = await validateDeletePath(broker, input, id, record);
		if (typeof validated !== "string") return validated;
		await broker.ledger.transition(identity, "effect_started", { intendedSessionId: id, effectMarker: randomUUID() });
		try {
			await new FileSessionStorage().deleteSessionWithArtifacts(validated);
			const metadataRoot = record?.locator.stateRoot ?? stateRoot(input);
			if (metadataRoot) await fs.rm(lifecycleMarkerPath(metadataRoot, id), { force: true });
		} catch (error) { return fail("not_found", `Unable to delete saved session artifacts: ${error instanceof Error ? error.message : String(error)}`); }
		return { ok: true, result: { sessionId: id } };
	}
	return fail("invalid_input", "Unknown lifecycle operation.");
}
