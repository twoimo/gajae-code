import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { withFileLock } from "../config/file-lock";
import type { Settings } from "../config/settings";
import { getNotificationConfig, isTelegramConfigured } from "./config";
import { daemonPaths } from "./daemon-paths";
import {
	readDaemonState,
	type TelegramDaemonOptions,
} from "./telegram-daemon";
import {
	clearTelegramControlRequest,
	readTelegramControlRequest,
} from "./telegram-daemon-control";
import {
	readTelegramCustodyEpoch,
	withCurrentTelegramCustodyEpoch,
	type TelegramCustodyEpochBinding,
} from "./telegram-custody-epoch";

type TelegramDaemonRunner = {
	run(): Promise<void>;
	requestStop(reason?: "reload" | "signal" | "stop"): void;
};

type TelegramDaemonConstructor = new (opts: TelegramDaemonOptions) => TelegramDaemonRunner;

export interface RunDaemonInternalDeps {
	SettingsImpl?: {
		init: (options?: { agentDir?: string }) => Promise<Pick<Settings, "get" | "getAgentDir" | "set" | "flush">>;
	};
	DaemonImpl?: TelegramDaemonConstructor;
	processPid?: number;
	pidAlive?: (pid: number) => boolean;
}

function argValue(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
function parseCustodyEpochArg(argv: string[]): number {
	const indices = argv.reduce<number[]>((found, value, index) => {
		if (value === "--custody-epoch") found.push(index);
		return found;
	}, []);
	if (indices.length !== 1) throw new Error("missing or duplicate --custody-epoch");
	const raw = argv[indices[0]! + 1];
	if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
		throw new Error("invalid --custody-epoch");
	}
	const custodyEpoch = Number(raw);
	if (!Number.isSafeInteger(custodyEpoch) || String(custodyEpoch) !== raw) {
		throw new Error("invalid --custody-epoch");
	}
	return custodyEpoch;
}

async function withCurrentDaemonBinding<T>(
	settings: Settings,
	binding: TelegramCustodyEpochBinding,
	operation: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
	return await withFileLock(daemonPaths(settings.getAgentDir()).state, async () => {
		const guarded = await withCurrentTelegramCustodyEpoch(
			{ agentDir: settings.getAgentDir(), binding },
			async () => {
				const state = await readDaemonState(settings);
				if (state?.ownerId !== binding.ownerId || state.custodyEpoch !== binding.custodyEpoch) {
					return { ok: false } as const;
				}
				return { ok: true, value: await operation() } as const;
			},
		);
		if (!guarded.ok || !guarded.value.ok) return { ok: false };
		return guarded.value;
	});
}

function getByPath(obj: unknown, pathSegments: string[]): unknown {
	let current = obj;
	for (const segment of pathSegments) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function setByPath(obj: Record<string, unknown>, pathSegments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < pathSegments.length - 1; i++) {
		const segment = pathSegments[i]!;
		const next = current[segment];
		if (!next || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[pathSegments[pathSegments.length - 1]!] = value;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asIdleTimeoutMs(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 60_000;
}

export function createLightweightDaemonSettings(input: {
	agentDir: string;
	rawConfig?: unknown;
}): Pick<Settings, "get" | "getAgentDir" | "set" | "flush"> {
	const rawConfig = input.rawConfig && typeof input.rawConfig === "object" ? input.rawConfig : {};
	return {
		get(pathName: string): unknown {
			const value = getByPath(rawConfig, pathName.split("."));
			switch (pathName) {
				case "notifications.enabled":
					return asBoolean(value, false);
				case "notifications.telegram.botToken":
				case "notifications.telegram.chatId":
				case "notifications.discord.botToken":
				case "notifications.discord.channelId":
				case "notifications.slack.botToken":
				case "notifications.slack.channelId":
				case "notifications.telegram.topics.nameTemplate":
					return asString(value);
				case "notifications.telegram.rich.enabled":
					return asBoolean(value, true);
				case "notifications.telegram.richDraft.enabled":
					return asBoolean(value, false);
				case "notifications.redact":
					return asBoolean(value, false);
				case "notifications.verbosity":
					return value === "verbose" ? "verbose" : "lean";
				case "notifications.daemon.idleTimeoutMs":
					return asIdleTimeoutMs(value);
				default:
					return undefined;
			}
		},
		getAgentDir(): string {
			return input.agentDir;
		},
		async set(pathName: string, value: unknown): Promise<void> {
			// Back onto config.yml directly (the full Settings class is not loaded in
			// the spawned daemon process). Contend on the SAME per-file lock as
			// Settings.#saveNow and re-read UNDER the lock, patching only this key, so
			// a concurrent main-process save can never drop unrelated settings (no
			// whole-file last-writer-wins). The write is atomic (tmp + rename) so a
			// crash mid-write can never truncate config.yml, and any failure propagates
			// so the `/rich` handler leaves runtime state unchanged. The in-memory view
			// is updated only after the durable write succeeds.
			const segments = pathName.split(".");
			const configPath = path.join(input.agentDir, "config.yml");
			await withFileLock(configPath, async () => {
				let onDisk: Record<string, unknown> = {};
				try {
					const parsed = YAML.parse(await fs.promises.readFile(configPath, "utf8"));
					if (parsed && typeof parsed === "object") onDisk = parsed as Record<string, unknown>;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				setByPath(onDisk, segments, value);
				await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
				const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
				await fs.promises.writeFile(tmpPath, YAML.stringify(onDisk), { mode: 0o600 });
				await fs.promises.rename(tmpPath, configPath);
			});
			setByPath(rawConfig as Record<string, unknown>, segments, value);
		},
		async flush(): Promise<void> {
			// The set() above is synchronously durable (it awaits the atomic tmp+rename
			// write under the shared file lock), so there is never a pending save to
			// flush. Present so the daemon can await flush() uniformly regardless of
			// which Settings implementation is injected.
		},
	} as Pick<Settings, "get" | "getAgentDir" | "set" | "flush">;
}

export async function loadLightweightDaemonSettings(
	agentDir: string,
): Promise<Pick<Settings, "get" | "getAgentDir" | "set" | "flush">> {
	const configPath = path.join(agentDir, "config.yml");
	let rawConfig: unknown = {};
	try {
		rawConfig = YAML.parse(await fs.promises.readFile(configPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return createLightweightDaemonSettings({ agentDir, rawConfig });
}

async function resolveDaemonSettings(
	agentDir: string,
	deps: RunDaemonInternalDeps,
): Promise<Pick<Settings, "get" | "getAgentDir" | "set" | "flush">> {
	if (deps.SettingsImpl) return await deps.SettingsImpl.init({ agentDir });
	return await loadLightweightDaemonSettings(agentDir);
}

export function ownerPidFromOwnerId(ownerId: string): number | undefined {
	const match = /^(\d+)(?:-|$)/.exec(ownerId);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ownerProcessIsAlive(ownerId: string, deps: RunDaemonInternalDeps): boolean {
	const ownerPid = ownerPidFromOwnerId(ownerId);
	if (ownerPid === undefined) return true;
	return (deps.pidAlive ?? defaultPidAlive)(ownerPid);
}

export async function runDaemonSmoke(opts: { agentDir?: string } = {}): Promise<void> {
	const agentDir = opts.agentDir ?? fs.mkdtempSync(path.join(process.cwd(), ".telegram-daemon-smoke-"));
	const settings = createLightweightDaemonSettings({ agentDir, rawConfig: {} });
	const paths = daemonPaths(agentDir);
	await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	const tempLock = `${paths.lock}.smoke.${process.pid}`;
	const handle = await fs.promises.open(tempLock, "wx", 0o600);
	await handle.close();
	await fs.promises.unlink(tempLock);
	void settings;
}

export async function runDaemonInternal(argv: string[], deps: RunDaemonInternalDeps = {}): Promise<void> {
	const smoke = argv.includes("--smoke");
	const agentDir = argValue(argv, "--agent-dir");
	if (smoke) return runDaemonSmoke({ agentDir });
	const ownerId = argValue(argv, "--owner-id");
	if (!ownerId) throw new Error("missing --owner-id");
	const custodyEpoch = parseCustodyEpochArg(argv);
	if (!ownerProcessIsAlive(ownerId, deps)) {
		process.stderr.write(`GJC notify daemon exiting: owner process from --owner-id ${ownerId} is not alive.\n`);
		return;
	}
	const resolvedAgentDir = agentDir ?? process.env.GJC_CODING_AGENT_DIR ?? path.join(process.cwd(), ".gjc", "agent");
	const settings = await resolveDaemonSettings(resolvedAgentDir, deps);
	const binding = { ownerId, custodyEpoch };
	const state = await readDaemonState(settings as Settings);
	if (state?.ownerId !== binding.ownerId || state.custodyEpoch !== binding.custodyEpoch) {
		throw new Error("Telegram daemon ownership state does not match --owner-id and --custody-epoch");
	}
	const currentEpoch = await readTelegramCustodyEpoch({ agentDir: resolvedAgentDir });
	if (currentEpoch.ownerId !== binding.ownerId || currentEpoch.custodyEpoch !== binding.custodyEpoch) {
		throw new Error("Telegram custody epoch does not match daemon ownership state");
	}
	const cfg = getNotificationConfig(settings as Settings);
	if (!isTelegramConfigured(cfg)) return;
	const Daemon: TelegramDaemonConstructor =
		deps.DaemonImpl ?? (await import("./telegram-daemon")).TelegramNotificationDaemon;
	const daemon = new Daemon({
		settings: settings as Settings,
		ownerId,
		custodyEpoch,
		botToken: cfg.botToken,
		chatId: cfg.chatId,
		idleTimeoutMs: cfg.idleTimeoutMs,
		rich: cfg.rich,
		richDraft: cfg.richDraft,
		topics: cfg.topics,
		pid: deps.processPid ?? process.pid,
		control: {
			shouldStop: async (requestOwnerId, requestCustodyEpoch) => {
				const current = await withCurrentDaemonBinding(
					settings as Settings,
					{ ownerId: requestOwnerId, custodyEpoch: requestCustodyEpoch },
					async () => await readTelegramControlRequest(settings as Settings),
				);
				return Boolean(
					current.ok &&
						current.value !== undefined &&
						current.value.ownerId === requestOwnerId &&
						current.value.custodyEpoch === requestCustodyEpoch,
				);
			},
			clear: async (requestOwnerId, requestCustodyEpoch) => {
				await withCurrentDaemonBinding(
					settings as Settings,
					{ ownerId: requestOwnerId, custodyEpoch: requestCustodyEpoch },
					async () => {
						const request = await readTelegramControlRequest(settings as Settings);
						if (
							request?.ownerId === requestOwnerId &&
							request.custodyEpoch === requestCustodyEpoch
						) {
							await clearTelegramControlRequest(
								settings as Settings,
								request.requestId,
								undefined,
								{ ownerId: requestOwnerId, custodyEpoch: requestCustodyEpoch },
							);
						}
					},
				);
			},
		},
	});
	// Signals are a process concern: install them at the daemon-internal boundary,
	// not inside the embeddable daemon class. SIGTERM is the reload wakeup path.
	const onSignal = (): void => daemon.requestStop("signal");
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	try {
		await daemon.run();
	} finally {
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
	}
}
