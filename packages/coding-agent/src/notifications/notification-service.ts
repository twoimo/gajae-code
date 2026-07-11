/**
 * Shared notification service contract.
 *
 * Transport-agnostic, secret-safe operations consumed by BOTH the `gjc notify`
 * CLI and the cross-mode `/notify` slash command (TUI + ACP). Every result is
 * free of raw secrets: bot tokens are only ever shown masked (`maskToken`) or
 * as a non-reversible fingerprint (`tokenFingerprint`).
 *
 * Daemon-ownership protection: `recoverNotifications` only ever removes
 * artifacts belonging to a DEAD owner (dead-PID / explicitly-stale). It never
 * touches a live owner's lock/state and never kills a process.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import {
	getNotificationConfig,
	isGloballyConfigured,
	isTelegramConfigured,
	maskToken,
	type NotificationConfig,
	tokenFingerprint,
} from "./config";
import { daemonPaths, HEARTBEAT_TTL_MS } from "./daemon-paths";
import type { DaemonState } from "./telegram-daemon";

const DEFAULT_API_BASE = "https://api.telegram.org";

/** Minimal filesystem surface the service needs; injectable for tests. */
export interface NotificationServiceFs {
	readdir(dir: string): Promise<string[]>;
	readFile(file: string, encoding: "utf8"): Promise<string>;
	unlink(file: string): Promise<void>;
}

const nodeServiceFs: NotificationServiceFs = {
	readdir: dir => fsPromises.readdir(dir),
	readFile: (file, encoding) => fsPromises.readFile(file, encoding),
	unlink: file => fsPromises.unlink(file),
};

/** Injectable dependencies shared across service operations. */
export interface NotificationServiceDeps {
	fs?: NotificationServiceFs;
	now?: () => number;
	pidAlive?: (pid: number) => boolean;
	fetchImpl?: typeof fetch;
	apiBase?: string;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but is owned by another user: still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultStateRoot(): string {
	return path.join(process.cwd(), ".gjc", "state");
}

function endpointDir(stateRoot: string): string {
	return path.join(stateRoot, "notifications");
}

// --- status -------------------------------------------------------------

export interface AdapterConfigView {
	botTokenMasked: string;
	channel: string | undefined;
	configured: boolean;
}

export interface NotificationStatusReport {
	enabled: boolean;
	redact: boolean;
	verbosity: "lean" | "verbose";
	globallyConfigured: boolean;
	telegram: AdapterConfigView & { tokenFingerprint: string | undefined };
	discord: AdapterConfigView;
	slack: AdapterConfigView;
}

function adapterConfigured(token: string | undefined, channel: string | undefined): boolean {
	return Boolean(token?.trim()) && Boolean(channel?.trim());
}

/** Build a secret-safe structured status snapshot from settings. */
export function buildNotificationStatusReport(settings: Settings): NotificationStatusReport {
	const cfg = getNotificationConfig(settings);
	return {
		enabled: cfg.enabled,
		redact: cfg.redact,
		verbosity: cfg.verbosity,
		globallyConfigured: isGloballyConfigured(cfg),
		telegram: {
			botTokenMasked: maskToken(cfg.botToken),
			channel: cfg.chatId,
			configured: isTelegramConfigured(cfg),
			tokenFingerprint: cfg.botToken?.trim() ? tokenFingerprint(cfg.botToken) : undefined,
		},
		discord: {
			botTokenMasked: maskToken(cfg.discord.botToken),
			channel: cfg.discord.channelId,
			configured: adapterConfigured(cfg.discord.botToken, cfg.discord.channelId),
		},
		slack: {
			botTokenMasked: maskToken(cfg.slack.botToken),
			channel: cfg.slack.channelId,
			configured: adapterConfigured(cfg.slack.botToken, cfg.slack.channelId),
		},
	};
}

/** Render a status report as human-readable lines (no secrets). */
export function formatNotificationStatusReport(report: NotificationStatusReport): string {
	const yesNo = (v: boolean): string => (v ? "yes" : "no");
	return [
		"Notifications",
		`  enabled: ${report.enabled}`,
		`  globally configured: ${yesNo(report.globallyConfigured)}`,
		`  redact: ${report.redact}`,
		`  verbosity: ${report.verbosity}`,
		`  telegram.botToken: ${report.telegram.botTokenMasked}`,
		`  telegram.chatId: ${report.telegram.channel ?? "(unset)"}`,
		`  telegram.fingerprint: ${report.telegram.tokenFingerprint ?? "(unset)"}`,
		`  telegram.configured: ${yesNo(report.telegram.configured)}`,
		`  discord.botToken: ${report.discord.botTokenMasked}`,
		`  discord.channelId: ${report.discord.channel ?? "(unset)"}`,
		`  slack.botToken: ${report.slack.botTokenMasked}`,
		`  slack.channelId: ${report.slack.channel ?? "(unset)"}`,
	].join("\n");
}

// --- endpoint / daemon file readers -------------------------------------

interface EndpointView {
	sessionId: string;
	pid: number | undefined;
	stale: boolean;
	updatedAt: number | undefined;
}

async function readEndpointView(fs: NotificationServiceFs, file: string): Promise<EndpointView | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const rec = parsed as Record<string, unknown>;
	const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : path.basename(file, ".json");
	return {
		sessionId,
		pid: typeof rec.pid === "number" ? rec.pid : undefined,
		stale: rec.stale === true,
		updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : undefined,
	};
}

function parseDaemonState(raw: string): DaemonState | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const rec = parsed as Record<string, unknown>;
	if (typeof rec.pid !== "number" || typeof rec.ownerId !== "string") return undefined;
	return parsed as DaemonState;
}

async function readDaemonStateFile(fs: NotificationServiceFs, file: string): Promise<DaemonState | undefined> {
	try {
		return parseDaemonState(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

async function listEndpointFiles(fs: NotificationServiceFs, dir: string): Promise<string[]> {
	try {
		return (await fs.readdir(dir)).filter(name => name.endsWith(".json"));
	} catch {
		return [];
	}
}

// --- health -------------------------------------------------------------

export type HealthLevel = "ok" | "warn" | "error";

export interface HealthCheck {
	name: string;
	level: HealthLevel;
	detail: string;
}

export interface DaemonHealth {
	present: boolean;
	ownerId: string | undefined;
	pid: number | undefined;
	alive: boolean;
	heartbeatFresh: boolean;
	identityMatches: boolean;
	stopped: boolean;
}

export interface EndpointHealth {
	total: number;
	live: number;
	stale: number;
	unreadable: number;
}

export interface NotificationHealthReport {
	overall: HealthLevel;
	configured: boolean;
	checks: HealthCheck[];
	daemon: DaemonHealth;
	endpoints: EndpointHealth;
	reachability: { probed: boolean; ok: boolean; detail: string };
}

export interface HealthOptions {
	settings: Settings;
	stateRoot?: string;
	deps?: NotificationServiceDeps;
	/** When true and Telegram is configured, probe the Bot API (getMe) for reachability. */
	probe?: boolean;
}

async function probeTelegramReachability(
	fetchImpl: typeof fetch,
	apiBase: string,
	token: string,
): Promise<{ ok: boolean; detail: string }> {
	try {
		const response = await fetchImpl(`${apiBase.replace(/\/$/, "")}/bot${token}/getMe`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		const payload = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; description?: string; result?: { username?: string } }
			| undefined;
		if (response.ok && payload?.ok) {
			const username = payload.result?.username;
			return { ok: true, detail: username ? `reachable as @${username}` : "reachable" };
		}
		return { ok: false, detail: payload?.description ?? `Telegram getMe failed (HTTP ${response.status})` };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : "network error" };
	}
}

function worst(a: HealthLevel, b: HealthLevel): HealthLevel {
	const rank: Record<HealthLevel, number> = { ok: 0, warn: 1, error: 2 };
	return rank[a] >= rank[b] ? a : b;
}

/** Structural (offline-by-default) health of the notification subsystem. */
export async function checkNotificationHealth(opts: HealthOptions): Promise<NotificationHealthReport> {
	const deps = opts.deps ?? {};
	const fs = deps.fs ?? nodeServiceFs;
	const now = (deps.now ?? Date.now)();
	const pidAlive = deps.pidAlive ?? defaultPidAlive;
	const stateRoot = opts.stateRoot ?? defaultStateRoot();

	const cfg: NotificationConfig = getNotificationConfig(opts.settings);
	const configured = isGloballyConfigured(cfg);
	const telegramConfigured = isTelegramConfigured(cfg);
	const checks: HealthCheck[] = [];

	if (!cfg.enabled) {
		checks.push({
			name: "config",
			level: "warn",
			detail: "notifications are disabled (notifications.enabled=false)",
		});
	} else if (!configured) {
		checks.push({ name: "config", level: "warn", detail: "no notification adapter is fully configured" });
	} else {
		checks.push({ name: "config", level: "ok", detail: "enabled with at least one configured adapter" });
	}

	// Daemon ownership state (offline; read the persisted state file directly).
	const paths = daemonPaths(opts.settings.getAgentDir());
	const state = await readDaemonStateFile(fs, paths.state);
	const daemon: DaemonHealth = {
		present: Boolean(state),
		ownerId: state?.ownerId,
		pid: state?.pid,
		alive: state ? pidAlive(state.pid) : false,
		heartbeatFresh: state ? now - state.heartbeatAt <= HEARTBEAT_TTL_MS : false,
		identityMatches:
			Boolean(state) &&
			telegramConfigured &&
			state?.tokenFingerprint === tokenFingerprint(cfg.botToken) &&
			state?.chatId === cfg.chatId,
		stopped: typeof state?.stoppedAt === "number",
	};
	if (!state) {
		checks.push({ name: "daemon", level: "ok", detail: "no daemon ownership record (none running)" });
	} else if (!daemon.alive) {
		checks.push({
			name: "daemon",
			level: "warn",
			detail: `daemon owner pid ${daemon.pid} is not alive; run recovery to clear the stale lock`,
		});
	} else if (!daemon.heartbeatFresh) {
		checks.push({ name: "daemon", level: "warn", detail: `daemon pid ${daemon.pid} heartbeat is stale` });
	} else if (telegramConfigured && !daemon.identityMatches) {
		checks.push({
			name: "daemon",
			level: "warn",
			detail: "a live daemon owns a different bot token or chat id",
		});
	} else {
		checks.push({ name: "daemon", level: "ok", detail: `daemon pid ${daemon.pid} alive with a fresh heartbeat` });
	}

	// Per-session endpoint discovery files.
	const dir = endpointDir(stateRoot);
	const files = await listEndpointFiles(fs, dir);
	let live = 0;
	let stale = 0;
	let unreadable = 0;
	for (const name of files) {
		const view = await readEndpointView(fs, path.join(dir, name));
		if (!view) {
			unreadable += 1;
			continue;
		}
		const dead = view.pid === undefined || !pidAlive(view.pid);
		if (view.stale || dead) stale += 1;
		else live += 1;
	}
	const endpoints: EndpointHealth = { total: files.length, live, stale, unreadable };
	if (stale > 0 || unreadable > 0) {
		checks.push({
			name: "endpoints",
			level: "warn",
			detail: `${stale} stale / ${unreadable} unreadable of ${files.length} endpoint file(s); run recovery`,
		});
	} else {
		checks.push({ name: "endpoints", level: "ok", detail: `${live} live endpoint file(s)` });
	}

	// Optional network reachability probe.
	let reachability = { probed: false, ok: false, detail: "not probed" };
	if (opts.probe && telegramConfigured) {
		const result = await probeTelegramReachability(
			deps.fetchImpl ?? globalThis.fetch,
			deps.apiBase ?? DEFAULT_API_BASE,
			cfg.botToken,
		);
		reachability = { probed: true, ...result };
		checks.push({
			name: "reachability",
			level: result.ok ? "ok" : "error",
			detail: `Telegram: ${result.detail}`,
		});
	}

	const overall = checks.reduce<HealthLevel>((acc, check) => worst(acc, check.level), "ok");
	return { overall, configured, checks, daemon, endpoints, reachability };
}

/** Render a health report as human-readable lines (no secrets). */
export function formatNotificationHealthReport(report: NotificationHealthReport): string {
	const icon: Record<HealthLevel, string> = { ok: "[ok]", warn: "[warn]", error: "[error]" };
	const lines = [`Notification health: ${report.overall.toUpperCase()}`];
	for (const check of report.checks) {
		lines.push(`  ${icon[check.level]} ${check.name}: ${check.detail}`);
	}
	return lines.join("\n");
}

// --- test ---------------------------------------------------------------

export interface NotificationTestResult {
	ok: boolean;
	adapter: "telegram";
	chatId: string | undefined;
	detail: string;
}

export interface TestOptions {
	settings: Settings;
	deps?: NotificationServiceDeps;
	text?: string;
}

/** Send a one-off test notification through the configured Telegram adapter. */
export async function sendNotificationTest(opts: TestOptions): Promise<NotificationTestResult> {
	const deps = opts.deps ?? {};
	const cfg = getNotificationConfig(opts.settings);
	if (!isTelegramConfigured(cfg)) {
		return {
			ok: false,
			adapter: "telegram",
			chatId: cfg.chatId,
			detail: "Telegram is not configured (need notifications.enabled + botToken + chatId). Run `gjc notify setup`.",
		};
	}
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const apiBase = (deps.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
	const text = opts.text ?? "GJC notifications test message. If you can read this, delivery works.";
	try {
		const response = await fetchImpl(`${apiBase}/bot${cfg.botToken}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: cfg.chatId, text }),
		});
		const payload = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; description?: string }
			| undefined;
		if (response.ok && payload?.ok) {
			return { ok: true, adapter: "telegram", chatId: cfg.chatId, detail: `delivered to chat ${cfg.chatId}` };
		}
		return {
			ok: false,
			adapter: "telegram",
			chatId: cfg.chatId,
			detail: payload?.description ?? `Telegram sendMessage failed (HTTP ${response.status})`,
		};
	} catch (err) {
		return {
			ok: false,
			adapter: "telegram",
			chatId: cfg.chatId,
			detail: err instanceof Error ? err.message : "network error",
		};
	}
}

/** Render a test result as a single human-readable line (no secrets). */
export function formatNotificationTestResult(result: NotificationTestResult): string {
	return `Notification test (${result.adapter}): ${result.ok ? "OK" : "FAILED"} — ${result.detail}`;
}

// --- recovery -----------------------------------------------------------

export interface RecoveredEndpoint {
	sessionId: string;
	pid: number | undefined;
	reason: "stale-flag" | "dead-pid";
}

export type DaemonRecoveryAction = "none" | "cleared-dead-owner-lock" | "left-active" | "orphan-lock-left";

export interface NotificationRecoveryReport {
	endpointsScanned: number;
	endpointsRemoved: RecoveredEndpoint[];
	endpointsKept: number;
	endpointsUnreadable: number;
	daemon: {
		action: DaemonRecoveryAction;
		detail: string;
		ownerId: string | undefined;
		pid: number | undefined;
	};
}

export interface RecoveryOptions {
	settings: Settings;
	stateRoot?: string;
	deps?: NotificationServiceDeps;
}

/**
 * Ownership-protected cleanup. Removes only DEAD-owner artifacts:
 * per-session endpoint files flagged stale or whose pid is dead, and a daemon
 * lock whose recorded owner pid is confirmed dead. Never removes a live owner's
 * lock, never deletes unreadable files, and never kills a process.
 */
export async function recoverNotifications(opts: RecoveryOptions): Promise<NotificationRecoveryReport> {
	const deps = opts.deps ?? {};
	const fs = deps.fs ?? nodeServiceFs;
	const pidAlive = deps.pidAlive ?? defaultPidAlive;
	const stateRoot = opts.stateRoot ?? defaultStateRoot();

	const dir = endpointDir(stateRoot);
	const files = await listEndpointFiles(fs, dir);
	const removed: RecoveredEndpoint[] = [];
	let kept = 0;
	let unreadable = 0;
	for (const name of files) {
		const view = await readEndpointView(fs, path.join(dir, name));
		if (!view) {
			// Leave unparseable files untouched: they may be mid-write by a live server.
			unreadable += 1;
			continue;
		}
		const dead = view.pid === undefined || !pidAlive(view.pid);
		if (!view.stale && !dead) {
			kept += 1;
			continue;
		}
		try {
			await fs.unlink(path.join(dir, name));
			removed.push({ sessionId: view.sessionId, pid: view.pid, reason: view.stale ? "stale-flag" : "dead-pid" });
		} catch {
			kept += 1;
		}
	}

	// Daemon lock: clear only when the recorded owner process is dead.
	const paths = daemonPaths(opts.settings.getAgentDir());
	let daemonFiles: string[] = [];
	try {
		daemonFiles = await fs.readdir(paths.dir);
	} catch {
		// directory absent: nothing to recover
	}
	const hasLock = daemonFiles.includes(path.basename(paths.lock));
	const state = await readDaemonStateFile(fs, paths.state);
	let daemon: NotificationRecoveryReport["daemon"];
	if (!state) {
		daemon = hasLock
			? {
					action: "orphan-lock-left",
					detail: "daemon lock present without an ownership record; left untouched to protect a starting owner",
					ownerId: undefined,
					pid: undefined,
				}
			: { action: "none", detail: "no daemon ownership record", ownerId: undefined, pid: undefined };
	} else if (pidAlive(state.pid)) {
		daemon = {
			action: "left-active",
			detail: `live daemon owned by pid ${state.pid} left untouched`,
			ownerId: state.ownerId,
			pid: state.pid,
		};
	} else if (hasLock) {
		try {
			await fs.unlink(paths.lock);
			daemon = {
				action: "cleared-dead-owner-lock",
				detail: `cleared lock of dead owner pid ${state.pid}`,
				ownerId: state.ownerId,
				pid: state.pid,
			};
		} catch {
			daemon = {
				action: "orphan-lock-left",
				detail: `could not remove lock of dead owner pid ${state.pid}`,
				ownerId: state.ownerId,
				pid: state.pid,
			};
		}
	} else {
		daemon = {
			action: "none",
			detail: `dead owner pid ${state.pid} recorded but no lock present`,
			ownerId: state.ownerId,
			pid: state.pid,
		};
	}

	return {
		endpointsScanned: files.length,
		endpointsRemoved: removed,
		endpointsKept: kept,
		endpointsUnreadable: unreadable,
		daemon,
	};
}

/** Render a recovery report as human-readable lines (no secrets). */
export function formatNotificationRecoveryReport(report: NotificationRecoveryReport): string {
	const lines = ["Notification recovery"];
	lines.push(
		`  endpoints: scanned ${report.endpointsScanned}, removed ${report.endpointsRemoved.length}, kept ${report.endpointsKept}, unreadable ${report.endpointsUnreadable}`,
	);
	for (const ep of report.endpointsRemoved) {
		lines.push(`    - removed ${ep.sessionId} (pid ${ep.pid ?? "?"}, ${ep.reason})`);
	}
	lines.push(`  daemon: ${report.daemon.action} — ${report.daemon.detail}`);
	return lines.join("\n");
}
