import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { probeWindowsJobMemory } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import type { Settings } from "../config/settings";
import { computeMemoryGuardDomain } from "../runtime/memory-domain";
import { chooseMemoryGuardAction, MemoryGuardHost, resolveMemoryGuardPolicy } from "../runtime/memory-guard";
import { resolveEffectiveMemoryLimit } from "../runtime/memory-limit";
import { listTabsForGc, releaseTabIfGcEligible, type TabGcSnapshot } from "./browser/tab-supervisor";
import { cleanupStaleScreenshotFallbackDirs, hasCreatedScreenshotFallbackDir } from "./computer-gc";

/**
 * Mandatory, session-aware resource garbage collector.
 *
 * A single process-wide, reference-counted, unref'd, non-overlapping interval sweeps:
 *  - browser tabs (the heavyweight resource: one worker thread per tab + Chrome child
 *    processes) via an idle sweep and an opportunistic RSS-pressure sweep, and
 *  - stale computer-use screenshot fallback directories on disk (lazy-armed + throttled).
 *
 * Eviction targets ONLY alive, non-in-flight, GJC-managed headless/spawned tabs owned by a
 * registered session; connected/real-Chrome/held/in-flight tabs and ownerless tabs are never
 * touched. RSS is the GJC parent-process RSS only (`process.memoryUsage().rss`); pressure
 * eviction is best-effort and never force-evicts.
 */

const BYTES_PER_MB = 1024 * 1024;

export interface BrowserGcPolicy {
	enabled: boolean;
	idleMs: number;
	rssLimitBytes: number;
}

export interface ComputerGcPolicy {
	enabled: boolean;
	staleMs: number;
	scanIntervalMs: number;
}

export function resolveBrowserGcPolicy(settings: Settings): BrowserGcPolicy {
	return {
		enabled: settings.get("browser.gc.enabled"),
		idleMs: settings.get("browser.gc.idleMs"),
		rssLimitBytes: settings.get("browser.gc.rssLimitMb") * BYTES_PER_MB,
	};
}

export function resolveComputerGcPolicy(settings: Settings): ComputerGcPolicy {
	return {
		enabled: settings.get("computer.screenshotGc.enabled"),
		staleMs: settings.get("computer.screenshotGc.staleMs"),
		scanIntervalMs: settings.get("computer.screenshotGc.scanIntervalMs"),
	};
}

export function resolveSweepIntervalMs(settings: Settings): number {
	return settings.get("resourceGc.sweepIntervalMs");
}

/** Injectable seams so the controller is fully testable without real browsers/filesystem/RSS. */
export interface ResourceGcDeps {
	now: () => number;
	monotonicNow: () => number;
	rssBytes: () => number;
	memorySnapshot: () => Promise<MemoryPressureSnapshot>;
	runGc: () => void;
	logWarn: (msg: string, meta?: Record<string, unknown>) => void;
	listTabs: () => TabGcSnapshot[];
	releaseTab: (name: string, policy: { now: () => number; idleMs: number }) => Promise<boolean>;
	cleanupScreenshots: (opts: { now: () => number; staleMs: number }) => Promise<{ scanned: number; removed: number }>;
	screenshotArmed: () => boolean;
}

const defaultDeps: ResourceGcDeps = {
	now: () => Date.now(),
	monotonicNow: () => performance.now(),
	rssBytes: () => process.memoryUsage().rss,
	memorySnapshot: () => sampleMemoryPressure(),
	runGc: () => Bun.gc(true),
	logWarn: (msg, meta) => logger.warn(msg, meta),
	listTabs: () => listTabsForGc(),
	releaseTab: (name, policy) => releaseTabIfGcEligible(name, policy),
	cleanupScreenshots: opts => cleanupStaleScreenshotFallbackDirs(opts),
	screenshotArmed: () => hasCreatedScreenshotFallbackDir(),
};

// ── Controller state (process-global; tabs/browsers are module-global too) ──────────────────
const activeSessions = new Map<string, Settings>();
const scheduler = new MemoryGuardHost({
	run: async () => {
		await sweepOnce(deps);
	},
	logDebug: (message, meta) => logger.debug(message, meta),
});
let rssWarningActive = false;
let lastScreenshotScanAt = 0;
const memoryGuardGcActive = new Set<string>();
const memoryGuardRestartAboveSince = new Map<string, number>();
const memoryGuardRestartCooldownUntil = new Map<string, number>();
let deps: ResourceGcDeps = defaultDeps;

export interface ResourceGcRegistration {
	sessionId: string;
	settings: Settings;
}

function resolveSessionSweepIntervalMs(settings: Settings): number {
	const memoryPolicy = resolveMemoryGuardPolicy(settings);
	return memoryPolicy.enabled
		? Math.min(resolveSweepIntervalMs(settings), memoryPolicy.checkIntervalMs)
		: resolveSweepIntervalMs(settings);
}

/**
 * Register a session with the resource GC. Starts the single shared timer on the first
 * registration. Returns an idempotent unregister function; the timer stops only when the last
 * session unregisters.
 */
export function registerResourceGcSession(reg: ResourceGcRegistration): () => void {
	activeSessions.set(reg.sessionId, reg.settings);
	const unregisterSchedule = scheduler.register({
		ownerId: reg.sessionId,
		intervalMs: resolveSessionSweepIntervalMs(reg.settings),
	});
	const unregisterSettings = reg.settings.onChanged(path => {
		if (
			path === "memoryGuard.enabled" ||
			path === "memoryGuard.checkIntervalMs" ||
			path === "resourceGc.sweepIntervalMs"
		) {
			scheduler.updateInterval(reg.sessionId, resolveSessionSweepIntervalMs(reg.settings));
		}
	});
	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		activeSessions.delete(reg.sessionId);
		memoryGuardGcActive.delete(reg.sessionId);
		memoryGuardRestartAboveSince.delete(reg.sessionId);
		memoryGuardRestartCooldownUntil.delete(reg.sessionId);
		unregisterSchedule();
		unregisterSettings();
	};
}

export async function sweepOnce(d: ResourceGcDeps = deps): Promise<void> {
	if (activeSessions.size === 0) return;
	const memorySweep = sweepMemoryPressureGuard(d);
	if (memorySweep) await memorySweep;
	await sweepBrowserTabs(d);
	await sweepScreenshots(d);
}

export interface MemoryPressureSnapshot {
	hardCapBytes: number;
	totalUsageBytes: number;
	parentBytes: number;
	source: "host" | "linux_cgroup_v2" | "linux_cgroup_v1" | "windows_job" | "windows_process_job_limit";
}

function decodeMountInfoPath(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

interface CgroupDirectoryCandidate {
	directory: string;
	mountPoint: string;
}

function resolveCgroupDirectories(
	mountInfo: string,
	membershipPath: string,
	fsType: "cgroup" | "cgroup2",
): CgroupDirectoryCandidate[] {
	const contained: CgroupDirectoryCandidate[] = [];
	const fallbacks: CgroupDirectoryCandidate[] = [];
	const seen = new Set<string>();
	for (const line of mountInfo.split("\n")) {
		const [left, right] = line.split(" - ", 2);
		if (!left || !right) continue;
		const leftFields = left.split(" ");
		const rightFields = right.split(" ");
		if (leftFields.length < 5 || rightFields[0] !== fsType) continue;
		if (fsType === "cgroup" && !rightFields.slice(2).join(",").split(",").includes("memory")) continue;
		const mountRoot = decodeMountInfoPath(leftFields[3]!);
		const mountPoint = decodeMountInfoPath(leftFields[4]!);
		const relative = path.posix.relative(mountRoot, membershipPath);
		const directory =
			!relative.startsWith("..") && !path.posix.isAbsolute(relative)
				? path.join(mountPoint, relative)
				: path.join(mountPoint, membershipPath.replace(/^\/+/, ""));
		if (seen.has(directory)) continue;
		seen.add(directory);
		const candidate = { directory, mountPoint };
		if (!relative.startsWith("..") && !path.posix.isAbsolute(relative)) contained.push(candidate);
		else fallbacks.push(candidate);
	}
	return [...contained, ...fallbacks];
}

async function readMemoryCounter(file: string): Promise<number | null> {
	try {
		const value = (await fs.readFile(file, "utf8")).trim();
		if (value === "max" || !/^\d+$/.test(value)) return null;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}

function parseCgroupEntry(line: string): [string, string, string] | null {
	const first = line.indexOf(":");
	const second = first < 0 ? -1 : line.indexOf(":", first + 1);
	if (first < 0 || second < 0) return null;
	return [line.slice(0, first), line.slice(first + 1, second), line.slice(second + 1)];
}

async function sampleLinuxCgroupDirectory(
	candidate: CgroupDirectoryCandidate,
	fsType: "cgroup" | "cgroup2",
	hostBytes: number,
	parentBytes: number,
): Promise<{ snapshot: MemoryPressureSnapshot; hasFiniteLimit: boolean } | null> {
	const limitName = fsType === "cgroup2" ? "memory.max" : "memory.limit_in_bytes";
	const usageName = fsType === "cgroup2" ? "memory.current" : "memory.usage_in_bytes";
	let selectedDomain: { limit: number; usage: number } | null = null;
	let unlimitedUsageBytes: number | null = null;
	let hasMeasurement = false;
	let current = candidate.directory;
	while (true) {
		const [limit, usage] = await Promise.all([
			readMemoryCounter(path.join(current, limitName)),
			readMemoryCounter(path.join(current, usageName)),
		]);
		if (usage !== null) {
			hasMeasurement = true;
			unlimitedUsageBytes = unlimitedUsageBytes === null ? usage : Math.max(unlimitedUsageBytes, usage);
		}
		if (limit !== null) {
			hasMeasurement = true;
			if (
				usage !== null &&
				(selectedDomain === null ||
					usage / Math.min(hostBytes, limit) > selectedDomain.usage / Math.min(hostBytes, selectedDomain.limit))
			) {
				selectedDomain = { limit, usage };
			}
		}
		if (current === candidate.mountPoint) break;
		const parent = path.dirname(current);
		if (
			parent === current ||
			(parent !== candidate.mountPoint && !parent.startsWith(`${candidate.mountPoint}${path.sep}`))
		) {
			break;
		}
		current = parent;
	}
	if (!hasMeasurement) return null;
	return {
		hasFiniteLimit: selectedDomain !== null,
		snapshot: {
			hardCapBytes: selectedDomain === null ? hostBytes : Math.min(hostBytes, selectedDomain.limit),
			totalUsageBytes: Math.max(parentBytes, selectedDomain?.usage ?? unlimitedUsageBytes ?? parentBytes),
			parentBytes,
			source: fsType === "cgroup2" ? "linux_cgroup_v2" : "linux_cgroup_v1",
		},
	};
}

export async function __sampleLinuxCgroupHierarchyForTest(
	mountInfo: string,
	membership: string,
	fsType: "cgroup" | "cgroup2",
	hostBytes: number,
	parentBytes: number,
): Promise<MemoryPressureSnapshot | null> {
	let unlimitedSnapshot: MemoryPressureSnapshot | null = null;
	for (const candidate of resolveCgroupDirectories(mountInfo, membership, fsType)) {
		const sampled = await sampleLinuxCgroupDirectory(candidate, fsType, hostBytes, parentBytes);
		if (!sampled) continue;
		if (sampled.hasFiniteLimit) return sampled.snapshot;
		unlimitedSnapshot ??= sampled.snapshot;
	}
	return unlimitedSnapshot;
}

async function sampleLinuxCgroupMemory(hostBytes: number, parentBytes: number): Promise<MemoryPressureSnapshot | null> {
	let cgroup: string;
	let mountInfo: string;
	try {
		[cgroup, mountInfo] = await Promise.all([
			fs.readFile("/proc/self/cgroup", "utf8"),
			fs.readFile("/proc/self/mountinfo", "utf8"),
		]);
	} catch {
		return null;
	}

	const entries = cgroup
		.split("\n")
		.map(parseCgroupEntry)
		.filter((entry): entry is [string, string, string] => entry !== null);
	const v2Membership = entries.find(parts => parts[0] === "0" && parts[1] === "")?.[2];
	const v1Membership = entries.find(parts => parts[1].split(",").includes("memory"))?.[2];
	if (v2Membership) {
		const snapshot = await __sampleLinuxCgroupHierarchyForTest(
			mountInfo,
			v2Membership,
			"cgroup2",
			hostBytes,
			parentBytes,
		);
		if (snapshot) return snapshot;
	}
	if (v1Membership) {
		return __sampleLinuxCgroupHierarchyForTest(mountInfo, v1Membership, "cgroup", hostBytes, parentBytes);
	}
	return null;
}

function sampleWindowsJobMemory(hostBytes: number, parentBytes: number): MemoryPressureSnapshot | null {
	const result = probeWindowsJobMemory();
	if (result.kind !== "job_snapshot") return null;
	const candidates = [
		{
			limit: Number(result.jobMemoryLimitBytes),
			usage: Number(result.jobMemoryUsedBytes),
			source: "job" as const,
		},
		{
			limit: Number(result.processMemoryLimitBytes),
			usage: Number(result.processPrivateUsageBytes),
			source: "process" as const,
		},
	].filter(
		(candidate): candidate is { limit: number; usage: number; source: "job" | "process" } =>
			Number.isSafeInteger(candidate.limit) &&
			candidate.limit > 0 &&
			Number.isSafeInteger(candidate.usage) &&
			candidate.usage >= 0,
	);
	if (candidates.length === 0) return null;
	const pressured = candidates.reduce((selected, candidate) =>
		candidate.usage / Math.min(hostBytes, candidate.limit) > selected.usage / Math.min(hostBytes, selected.limit)
			? candidate
			: selected,
	);
	const processLimitSelected = pressured.source === "process";
	return {
		hardCapBytes: Math.min(hostBytes, pressured.limit),
		totalUsageBytes: pressured.usage,
		parentBytes,
		source: processLimitSelected ? "windows_process_job_limit" : "windows_job",
	};
}

async function sampleMemoryPressure(): Promise<MemoryPressureSnapshot> {
	const parentBytes = process.memoryUsage().rss;
	const hostBytes = os.totalmem();
	if (process.platform === "linux") {
		const cgroup = await sampleLinuxCgroupMemory(hostBytes, parentBytes);
		if (cgroup) return cgroup;
	}
	if (process.platform === "win32") {
		const job = sampleWindowsJobMemory(hostBytes, parentBytes);
		if (job) return job;
	}
	return { hardCapBytes: hostBytes, totalUsageBytes: parentBytes, parentBytes, source: "host" };
}

function sweepMemoryPressureGuard(d: ResourceGcDeps): Promise<void> | undefined {
	let enabled = false;
	for (const [sessionId, settings] of activeSessions) {
		if (resolveMemoryGuardPolicy(settings).enabled) {
			enabled = true;
			continue;
		}
		memoryGuardGcActive.delete(sessionId);
		memoryGuardRestartAboveSince.delete(sessionId);
		memoryGuardRestartCooldownUntil.delete(sessionId);
	}
	if (!enabled) return undefined;
	return sweepEnabledMemoryPressureGuard(d);
}

async function sweepEnabledMemoryPressureGuard(d: ResourceGcDeps): Promise<void> {
	const snapshot = await d.memorySnapshot();
	let gcRequested = false;
	const gcTelemetry: Record<string, unknown>[] = [];
	for (const [sessionId, settings] of activeSessions) {
		const policy = resolveMemoryGuardPolicy(settings);
		if (!policy.enabled) {
			memoryGuardGcActive.delete(sessionId);
			memoryGuardRestartAboveSince.delete(sessionId);
			memoryGuardRestartCooldownUntil.delete(sessionId);
			continue;
		}
		const limit = resolveEffectiveMemoryLimit({
			hardCapBytes: snapshot.hardCapBytes,
			policyLimitBytes: policy.policyLimitBytes,
		});
		if (limit.effectiveBytes === null) continue;
		const domain = computeMemoryGuardDomain({
			effectiveLimitBytes: limit.effectiveBytes,
			totalUsageBytes: snapshot.totalUsageBytes,
			parentBytes: snapshot.parentBytes,
			parentReserveBytes: policy.parentReserveBytes,
			workers: [],
		});
		const decision = chooseMemoryGuardAction({
			domain,
			hostSupported: false,
			workerSupported: () => false,
		});
		const usageRatio = snapshot.totalUsageBytes / limit.effectiveBytes;
		if (usageRatio >= policy.gcThresholdRatio) {
			if (!memoryGuardGcActive.has(sessionId)) {
				memoryGuardGcActive.add(sessionId);
				gcRequested = true;
				gcTelemetry.push({
					sessionId,
					parentBytes: snapshot.parentBytes,
					totalUsageBytes: snapshot.totalUsageBytes,
					effectiveLimitBytes: limit.effectiveBytes,
					domainSource: snapshot.source,
					limitSource: limit.source,
					usageRatio,
					decision: decision.kind,
				});
			}
		} else {
			memoryGuardGcActive.delete(sessionId);
		}

		if (usageRatio < policy.restartThresholdRatio) {
			memoryGuardRestartAboveSince.delete(sessionId);
			continue;
		}
		const now = d.monotonicNow();
		const aboveSince = memoryGuardRestartAboveSince.get(sessionId);
		if (aboveSince === undefined) {
			memoryGuardRestartAboveSince.set(sessionId, now);
			continue;
		}
		const cooldownUntil = memoryGuardRestartCooldownUntil.get(sessionId) ?? 0;
		if (now - aboveSince < policy.restartThresholdWindowMs || now < cooldownUntil) continue;
		memoryGuardRestartCooldownUntil.set(sessionId, now + policy.cooldownMs);
		d.logWarn("Memory guard: restart threshold sustained; restart remains advisory-only", {
			sessionId,
			parentBytes: snapshot.parentBytes,
			totalUsageBytes: snapshot.totalUsageBytes,
			effectiveLimitBytes: limit.effectiveBytes,
			domainSource: snapshot.source,
			limitSource: limit.source,
			usageRatio,
			windowMs: policy.restartThresholdWindowMs,
			cooldownMs: policy.cooldownMs,
			decision: decision.kind,
		});
	}
	if (gcRequested) {
		d.runGc();
		for (const telemetry of gcTelemetry) d.logWarn("Memory guard: GC threshold reached", telemetry);
	}
}

function ownerBrowserPolicy(snapshot: TabGcSnapshot): BrowserGcPolicy | null {
	if (!snapshot.ownerId) return null;
	const settings = activeSessions.get(snapshot.ownerId);
	if (!settings) return null;
	return resolveBrowserGcPolicy(settings);
}

/** Coarse, ordering-only eligibility; the live recheck in releaseTabIfGcEligible is authoritative. */
function isCoarselyEligible(snapshot: TabGcSnapshot): boolean {
	return (
		(snapshot.state === "alive" || snapshot.state === "dead") &&
		snapshot.pendingCount === 0 &&
		(snapshot.kindTag === "headless" || snapshot.kindTag === "spawned")
	);
}

/** Collect idle, non-in-flight, GJC-managed, owned-and-enabled tabs, sorted LRU (oldest first). */
function collectIdleCandidates(d: ResourceGcDeps): Array<{ snapshot: TabGcSnapshot; policy: BrowserGcPolicy }> {
	const candidates: Array<{ snapshot: TabGcSnapshot; policy: BrowserGcPolicy }> = [];
	for (const snapshot of d.listTabs()) {
		if (!isCoarselyEligible(snapshot)) continue;
		const policy = ownerBrowserPolicy(snapshot);
		if (!policy?.enabled) continue;
		if (d.now() - snapshot.lastUsedAt <= policy.idleMs) continue;
		candidates.push({ snapshot, policy });
	}
	candidates.sort((a, b) => a.snapshot.lastUsedAt - b.snapshot.lastUsedAt);
	return candidates;
}

async function sweepBrowserTabs(d: ResourceGcDeps): Promise<void> {
	// Reclamation honors IR-1 strictly: ONLY idle, non-in-flight, GJC-managed, owned tabs are ever
	// evicted. RSS pressure never relaxes that boundary — it only drives the warning below.
	for (const { snapshot, policy } of collectIdleCandidates(d)) {
		await d.releaseTab(snapshot.name, { now: d.now, idleMs: policy.idleMs });
	}
	evaluateRssPressureWarning(d);
}

/** Owners whose own RSS limit is exceeded by the single shared parent-process RSS sample. */
function pressuredOwnerIds(d: ResourceGcDeps): Set<string> {
	const rss = d.rssBytes();
	const owners = new Set<string>();
	for (const [sessionId, settings] of activeSessions) {
		const policy = resolveBrowserGcPolicy(settings);
		if (policy.enabled && rss > policy.rssLimitBytes) owners.add(sessionId);
	}
	return owners;
}

/**
 * RSS pressure is a best-effort warning signal only. Because eviction is always idle-gated
 * (IR-1), when parent-process RSS stays over an enabled owner's limit and no idle, unheld tab
 * remains to reclaim for a pressured owner, we warn exactly once per continuous episode and
 * never force-evict. The warning episode resets when RSS recovers or a reclaimable tab appears.
 */
function evaluateRssPressureWarning(d: ResourceGcDeps): void {
	const pressured = pressuredOwnerIds(d);
	if (pressured.size === 0) {
		rssWarningActive = false;
		return;
	}
	const reclaimableRemains = collectIdleCandidates(d).some(
		c => c.snapshot.state === "alive" && c.snapshot.ownerId !== undefined && pressured.has(c.snapshot.ownerId),
	);
	if (reclaimableRemains) {
		rssWarningActive = false;
		return;
	}
	if (!rssWarningActive) {
		rssWarningActive = true;
		d.logWarn("Browser GC: RSS over limit but no safe (idle, unheld) browser tabs are evictable", {
			rssBytes: d.rssBytes(),
		});
	}
}

async function sweepScreenshots(d: ResourceGcDeps): Promise<void> {
	if (!d.screenshotArmed()) return;

	let staleMs: number | null = null;
	let scanIntervalMs = Number.POSITIVE_INFINITY;
	for (const settings of activeSessions.values()) {
		const policy = resolveComputerGcPolicy(settings);
		if (!policy.enabled) continue;
		staleMs = staleMs === null ? policy.staleMs : Math.min(staleMs, policy.staleMs);
		scanIntervalMs = Math.min(scanIntervalMs, policy.scanIntervalMs);
	}
	if (staleMs === null) return; // no session has screenshot GC enabled

	const now = d.now();
	if (now - lastScreenshotScanAt < scanIntervalMs) return;
	lastScreenshotScanAt = now;
	await d.cleanupScreenshots({ now: d.now, staleMs });
}

// ── Test-only seams ─────────────────────────────────────────────────────────────────────────
export function __setResourceGcDepsForTest(overrides: Partial<ResourceGcDeps>): void {
	deps = {
		...defaultDeps,
		...overrides,
		monotonicNow: overrides.monotonicNow ?? overrides.now ?? defaultDeps.monotonicNow,
	};
}

export function __setResourceGcSchedulerNowForTest(now: () => number): void {
	scheduler.setSchedulerNowForTest(now);
}

export async function __runResourceGcTickForTest(): Promise<void> {
	await scheduler.runTick();
}

export async function __runResourceGcTimerCallbackForTest(
	owner: { generation: number; token: number },
	deadline: number,
): Promise<void> {
	await scheduler.runTimerCallbackForTest(owner, deadline);
}

export function __getResourceGcStateForTest(): {
	timerActive: boolean;
	sessionCount: number;
	rssWarningActive: boolean;
	inProgress: boolean;
	generation: number;
	pendingDeadline: number | null;
	pendingOwner: { generation: number; token: number } | null;
	deferredDeadline: number | null;
	deferredGeneration: number | null;
	activeGeneration: number | null;
} {
	const state = scheduler.getStateForTest();
	return {
		timerActive: state.timerActive,
		sessionCount: activeSessions.size,
		rssWarningActive,
		inProgress: state.inProgress,
		generation: state.generation,
		pendingDeadline: state.pendingDeadline,
		pendingOwner: state.pendingOwner,
		deferredDeadline: state.deferredDeadline,
		deferredGeneration: state.deferredGeneration,
		activeGeneration: state.activeGeneration,
	};
}

export function __resetResourceGcForTest(): void {
	scheduler.resetForTest();
	activeSessions.clear();
	rssWarningActive = false;
	memoryGuardGcActive.clear();
	memoryGuardRestartAboveSince.clear();
	memoryGuardRestartCooldownUntil.clear();
	lastScreenshotScanAt = 0;
	deps = defaultDeps;
}
