import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { resolveResumableSession, SessionManager } from "../../session/session-manager";
import {
	BROKER_HEARTBEAT_TTL_MS,
	type BrokerDiscovery,
	brokerDiscoveryPath,
	isPidAlive,
	newBrokerToken,
	readBrokerDiscovery,
	redactBrokerDiscovery,
	writeBrokerDiscovery,
} from "./discovery";
import { deriveIdempotencyIdentity } from "./identity";
import { executeLifecycle } from "./lifecycle";
import { LifecycleLedger } from "./lifecycle-ledger";
import { type IndexedSession, SessionIndex } from "./session-index";
import { BrokerTransport } from "./transport";

export interface BrokerSettings {
	agentDir: string;
	packageGeneration?: string;
	port?: number;
	heartbeatTtlMs?: number;
}
export type BrokerErrorCode =
	| "idempotency_conflict"
	| "terminal_uncertain"
	| "broker_restarting"
	| "unavailable"
	| "endpoint_stale"
	| "resource_gone"
	| "invalid_input"
	| "spawn_failed"
	| "readiness_timeout"
	| "close_refused"
	| "not_found"
	| "live_session";
export type BrokerResponse =
	| { ok: true; result?: unknown; indexSeq?: number }
	| { ok: false; error: { code: BrokerErrorCode; message: string }; indexSeq?: number };
const error = (code: BrokerErrorCode, message: string): BrokerResponse => ({ ok: false, error: { code, message } });
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}
function lifecycleTarget(operation: string, input: Record<string, unknown>): unknown {
	const target = input.target as Record<string, unknown> | undefined;
	const string = (...values: unknown[]): string | undefined =>
		values.find((value): value is string => typeof value === "string" && value.length > 0);
	const explicitRoot = string(input.stateRoot, target?.stateRoot);
	const root =
		explicitRoot ??
		(() => {
			const cwd = string(input.cwd, input.path, target?.path);
			return cwd ? path.join(cwd, ".gjc", "state") : undefined;
		})();
	const id = string(input.sessionId, input.id);
	switch (operation) {
		case "session.create":
			return { root };
		case "session.fork":
			return {
				root,
				sourceSessionId: string(input.sourceSessionId, input.sourceId),
				sourceSessionPath: string(input.sourceSessionPath, input.sourcePath, input.sessionPath),
			};
		case "session.resume":
		case "session.close":
		case "session.delete":
			return { sessionId: id };
		default:
			return { operation, root, sessionId: id };
	}
}

const BROKER_LOCK_RECORD = "owner.json";
const BROKER_LOCK_STARTUP_WAIT_MS = 1_000;
const BROKER_LOCK_RETRY_MS = 10;

type BrokerLockSnapshot = {
	ownerId?: string;
	pid: number;
	identity: string;
};

export class Broker {
	readonly settings: Required<BrokerSettings>;
	readonly index: SessionIndex;
	readonly ledger: LifecycleLedger;
	discovery: BrokerDiscovery | null = null;
	#lock: string;
	#owner = randomBytes(12).toString("hex");
	#chains = new Map<string, Promise<void>>();
	#stopping = false;
	#transport: BrokerTransport | null = null;
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	#heartbeatWrite: Promise<void> = Promise.resolve();
	constructor(settings: BrokerSettings) {
		this.settings = { packageGeneration: "unknown", port: 0, heartbeatTtlMs: BROKER_HEARTBEAT_TTL_MS, ...settings };
		this.index = new SessionIndex(settings.agentDir);
		this.ledger = new LifecycleLedger(settings.agentDir);
		this.#lock = path.join(settings.agentDir, "sdk", "broker.lock");
	}
	#lockRecordPath(): string {
		return path.join(this.#lock, BROKER_LOCK_RECORD);
	}
	#lockSnapshot(raw: string): BrokerLockSnapshot {
		try {
			const lock = JSON.parse(raw) as { ownerId?: unknown; pid?: unknown };
			if (
				typeof lock.ownerId === "string" &&
				lock.ownerId.length > 0 &&
				typeof lock.pid === "number" &&
				Number.isInteger(lock.pid) &&
				lock.pid > 0
			)
				return { ownerId: lock.ownerId, pid: lock.pid, identity: `owner:${lock.ownerId}` };
		} catch {}
		return { pid: 0, identity: `contents:${createHash("sha256").update(raw).digest("hex")}` };
	}
	async #readLock(): Promise<BrokerLockSnapshot | null> {
		try {
			return this.#lockSnapshot(await fs.readFile(this.#lockRecordPath(), "utf8"));
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOTDIR") {
				try {
					return this.#lockSnapshot(await fs.readFile(this.#lock, "utf8"));
				} catch (legacyError) {
					if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw legacyError;
				}
			}
			if (code !== "ENOENT") throw e;
		}
		try {
			const lock = await fs.stat(this.#lock);
			return lock.isDirectory() ? { pid: 0, identity: `directory:${lock.dev}:${lock.ino}` } : null;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw e;
		}
	}
	async #createLock(): Promise<void> {
		await fs.mkdir(this.#lock, { mode: 0o700 });
		try {
			await fs.writeFile(
				this.#lockRecordPath(),
				JSON.stringify({ version: 1, ownerId: this.#owner, pid: process.pid, acquiredAt: Date.now() }),
				{ flag: "wx", mode: 0o600 },
			);
		} catch (e) {
			try {
				await fs.rmdir(this.#lock);
			} catch {}
			throw e;
		}
	}
	async #waitForBrokerDiscovery(): Promise<BrokerDiscovery | null> {
		const deadline = Date.now() + BROKER_LOCK_STARTUP_WAIT_MS;
		while (Date.now() < deadline) {
			const live = await readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
			if (live) return live;
			await Bun.sleep(BROKER_LOCK_RETRY_MS);
		}
		return readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
	}
	async #reclaimStaleLock(snapshot: BrokerLockSnapshot): Promise<void> {
		const current = await this.#readLock();
		if (!current || current.identity !== snapshot.identity || (current.pid > 0 && isPidAlive(current.pid))) return;

		// Keep the tombstone: its immutable-owner-derived pathname prevents a contender
		// holding an old snapshot from renaming a newly-created directory lock.
		const tombstone = path.join(
			path.dirname(this.#lock),
			`.broker.lock.stale-${createHash("sha256").update(snapshot.identity).digest("hex")}`,
		);
		try {
			await fs.rename(this.#lock, tombstone);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (["ENOENT", "EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR"].includes(code ?? "")) return;
			if (code === "EPERM") {
				try {
					await fs.lstat(tombstone);
					return;
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
				}
			}
			throw e;
		}
	}
	async start(): Promise<BrokerDiscovery> {
		this.#stopping = false;
		await Promise.all([
			this.index.assertSupportedStateVersions(),
			this.ledger.assertSupportedStateVersions(),
			readBrokerDiscovery(this.settings.agentDir),
		]);
		await fs.mkdir(path.dirname(this.#lock), { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				await this.#createLock();
				break;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}

			const live = await readBrokerDiscovery(this.settings.agentDir, this.settings.heartbeatTtlMs);
			if (live) {
				this.discovery = live;
				return live;
			}
			const snapshot = await this.#readLock();
			if (!snapshot) continue;
			if (snapshot.pid > 0 && isPidAlive(snapshot.pid)) {
				const starting = await this.#waitForBrokerDiscovery();
				if (starting) {
					this.discovery = starting;
					return starting;
				}
				const current = await this.#readLock();
				if (current && current.identity === snapshot.identity && current.pid > 0 && isPidAlive(current.pid))
					throw new Error("Broker lock is held by a live owner");
				continue;
			}
			await this.#reclaimStaleLock(snapshot);
		}
		await this.index.open();
		await this.ledger.open();
		const now = Date.now();
		const token = newBrokerToken();
		this.#transport = new BrokerTransport(this, token, this.settings.port);
		const port = await this.#transport.start();
		this.discovery = {
			version: 1,
			protocolVersion: 3,
			packageGeneration: this.settings.packageGeneration,
			ownerId: this.#owner,
			pid: process.pid,
			host: "127.0.0.1",
			port,
			url: `ws://127.0.0.1:${port}`,
			token,
			startedAt: now,
			heartbeatAt: now,
		};
		await writeBrokerDiscovery(this.settings.agentDir, this.discovery);
		this.#heartbeatTimer = setInterval(
			() => void this.heartbeat(),
			Math.max(1, Math.floor(this.settings.heartbeatTtlMs / 3)),
		);
		return this.discovery;
	}
	get ownsDiscovery(): boolean {
		return this.discovery?.ownerId === this.#owner;
	}
	status(): ReturnType<typeof redactBrokerDiscovery> | null {
		return this.discovery ? redactBrokerDiscovery(this.discovery) : null;
	}
	async heartbeat(): Promise<void> {
		if (!this.discovery || this.discovery.ownerId !== this.#owner) return;
		this.discovery = { ...this.discovery, heartbeatAt: Date.now() };
		const discovery = this.discovery;
		this.#heartbeatWrite = this.#heartbeatWrite.then(() => writeBrokerDiscovery(this.settings.agentDir, discovery));
		await this.#heartbeatWrite;
	}
	async stop(): Promise<void> {
		this.#stopping = true;
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		await this.#heartbeatWrite;
		await Promise.allSettled(this.#chains.values());
		await this.#transport?.stop();
		this.#transport = null;
		if (this.discovery?.ownerId === this.#owner) {
			try {
				const disk = JSON.parse(await fs.readFile(brokerDiscoveryPath(this.settings.agentDir), "utf8")) as {
					ownerId?: string;
				};
				if (disk.ownerId === this.#owner) await fs.unlink(brokerDiscoveryPath(this.settings.agentDir));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
			try {
				const lock = await this.#readLock();
				if (lock?.ownerId === this.#owner) {
					await fs.unlink(this.#lockRecordPath());
					await fs.rmdir(this.#lock);
				}
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}
		}
		this.discovery = null;
	}
	async #endpoint(input: Record<string, unknown>): Promise<BrokerResponse> {
		await this.index.refresh();
		const sessionId = input.sessionId;
		if (typeof sessionId !== "string" || !sessionId) return error("invalid_input", "sessionId is required");
		const record = this.index.listSessions().sessions.find(session => session.sessionId === sessionId);
		if (!record) return error("resource_gone", "session is not indexed");
		if (
			!record.live ||
			(typeof input.endpointGeneration === "number" && input.endpointGeneration !== record.endpointGeneration)
		)
			return error("endpoint_stale", "session endpoint is stale");
		return this.#readEndpoint(record);
	}
	async #readEndpoint(record: IndexedSession): Promise<BrokerResponse> {
		try {
			const endpointPath = path.join(record.locator.stateRoot, "sdk", `${record.sessionId}.json`);
			const [source, metadata] = await Promise.all([fs.readFile(endpointPath, "utf8"), fs.stat(endpointPath)]);
			const endpoint = JSON.parse(source) as Record<string, unknown>;
			if (
				endpoint.sessionId !== record.sessionId ||
				endpoint.pid !== record.pid ||
				endpoint.stale === true ||
				record.endpointMtimeMs === undefined ||
				metadata.mtimeMs !== record.endpointMtimeMs
			)
				return error("endpoint_stale", "session endpoint is stale");
			return { ok: true, result: endpoint };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT")
				return error("resource_gone", "session endpoint record is gone");
			throw e;
		}
	}
	async handleRequest(
		operation: string,
		input: Record<string, unknown>,
		idempotencyKey?: string,
	): Promise<BrokerResponse> {
		if (this.#stopping) return error("broker_restarting", "broker is stopping");
		if (operation === "session.list") {
			await this.index.refresh();
			const result = this.index.listSessions();
			const resolveSessionId = typeof input.resolveSessionId === "string" ? input.resolveSessionId : undefined;
			const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
			if (resolveSessionId && cwd) {
				const sessionDir = SessionManager.getDefaultSessionDir(cwd, this.settings.agentDir);
				const match = await resolveResumableSession(resolveSessionId, cwd, sessionDir);
				return {
					ok: true,
					result: {
						...result,
						savedSession:
							match && match.session.id === resolveSessionId
								? { id: match.session.id, path: match.session.path }
								: undefined,
					},
					indexSeq: result.indexSeq,
				};
			}
			return { ok: true, result, indexSeq: result.indexSeq };
		}
		if (operation === "session.get_endpoint") return this.#endpoint(input);
		if (!idempotencyKey) return error("invalid_input", "idempotencyKey is required for lifecycle operations");
		const target = createHash("sha256")
			.update(canonicalJson(lifecycleTarget(operation, input)))
			.digest("hex");
		const identity = await deriveIdempotencyIdentity(this.settings.agentDir, operation, idempotencyKey, target);
		const requestHash = createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
		const prev = this.#chains.get(target) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => (release = resolve));
		this.#chains.set(
			target,
			prev.then(() => current),
		);
		await prev;
		try {
			const begun = await this.ledger.begin(identity, requestHash);
			if (begun.kind === "replay") return begun.entry.response as BrokerResponse;
			if (begun.kind === "idempotency_conflict")
				return error("idempotency_conflict", "idempotency key was used with a different request");
			if (begun.kind === "terminal_uncertain")
				return error("terminal_uncertain", "prior lifecycle operation outcome is uncertain");
			if (begun.kind === "in_progress") return error("broker_restarting", "lifecycle operation is in progress");
			const response = await executeLifecycle(this, operation, input, identity);
			await this.ledger.transition(identity, response.ok ? "terminal_ok" : "terminal_error", {
				resultSessionId:
					response.ok && typeof (response.result as { sessionId?: unknown } | undefined)?.sessionId === "string"
						? (response.result as { sessionId: string }).sessionId
						: undefined,
				response: response,
				responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
			});
			return response;
		} finally {
			release();
			if (this.#chains.get(target) === current) this.#chains.delete(target);
		}
	}
}
