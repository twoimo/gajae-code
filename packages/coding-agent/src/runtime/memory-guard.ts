import type { Settings } from "../config/settings";
import type {
	MemoryGuardActionTarget,
	MemoryGuardDecision,
	MemoryGuardDomainSnapshot,
	MemoryGuardPolicy,
	MemoryGuardSchedulerState,
} from "./memory-guard-contract";

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

type ScheduleOwner = { generation: number; token: number };
type DeferredSchedule = { generation: number; deadline: number };
type WorkOwner = { generation: number; source: "timer" | "external" };

export interface MemoryGuardHostRegistration {
	ownerId: string;
	intervalMs: number;
}

export interface MemoryGuardHostOptions {
	run: () => Promise<void>;
	logDebug?: (message: string, meta?: Record<string, unknown>) => void;
	schedulerNow?: () => number;
}

function normalizePositiveIntervalMs(intervalMs: number): number {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("invalid_interval_ms");
	return intervalMs;
}

function toRatio(percent: number): number {
	return percent / 100;
}

function mbToBytes(value: number): number {
	return Math.round(value * BYTES_PER_MB);
}

function sortTargets(left: MemoryGuardActionTarget, right: MemoryGuardActionTarget): number {
	if (left.excessBytes !== right.excessBytes) return right.excessBytes - left.excessBytes;
	if (left.kind !== right.kind) return left.kind === "host" ? -1 : 1;
	if (left.kind === "worker" && right.kind === "worker") return left.workerId.localeCompare(right.workerId);
	return 0;
}

export function resolveMemoryGuardPolicy(settings: Settings): MemoryGuardPolicy {
	const configuredPolicyLimitMb = settings.get("memoryGuard.policyLimitMb");
	return {
		enabled: settings.get("memoryGuard.enabled"),
		checkIntervalMs: settings.get("memoryGuard.checkIntervalMs"),
		gcThresholdRatio: toRatio(settings.get("memoryGuard.gcThresholdPercent")),
		restartThresholdRatio: toRatio(settings.get("memoryGuard.restartThresholdPercent")),
		restartThresholdWindowMs: settings.get("memoryGuard.restartThresholdWindowMs"),
		cooldownMs: settings.get("memoryGuard.cooldownMs"),
		parentReserveBytes: mbToBytes(settings.get("memoryGuard.parentReserveMb")),
		policyLimitBytes: configuredPolicyLimitMb > 0 ? mbToBytes(configuredPolicyLimitMb) : null,
	};
}

export function chooseMemoryGuardAction(input: {
	domain: MemoryGuardDomainSnapshot;
	hostSupported: boolean;
	workerSupported: (workerId: string) => boolean;
}): MemoryGuardDecision {
	const candidates: MemoryGuardActionTarget[] = [];
	if (input.hostSupported && input.domain.hostExcessBytes > 0) {
		candidates.push({ kind: "host", excessBytes: input.domain.hostExcessBytes });
	}
	for (const worker of input.domain.workers) {
		if (!worker.accepted || worker.excessBytes <= 0 || !input.workerSupported(worker.workerId)) continue;
		candidates.push({ kind: "worker", workerId: worker.workerId, excessBytes: worker.excessBytes });
	}
	if (candidates.length > 0) {
		candidates.sort(sortTargets);
		return { kind: "execute", target: candidates[0]! };
	}
	const unsupportedExcessExists =
		input.domain.hostExcessBytes > 0 ||
		input.domain.workers.some(worker => worker.accepted && worker.excessBytes > 0);
	if (unsupportedExcessExists) return { kind: "noop", reason: "memory_guard_action_noop_unsupported" };
	return { kind: "noop", reason: "memory_guard_action_noop_unmanaged_or_within_allowance" };
}

export function revalidateMemoryGuardAction(
	previous: Extract<MemoryGuardDecision, { kind: "execute" }>,
	revalidated: MemoryGuardDecision,
): MemoryGuardDecision {
	if (revalidated.kind !== "execute")
		return { kind: "revalidated_out", reason: "memory_guard_action_revalidated_out" };
	if (previous.target.kind !== revalidated.target.kind)
		return { kind: "revalidated_out", reason: "memory_guard_action_revalidated_out" };
	if (
		previous.target.kind === "worker" &&
		revalidated.target.kind === "worker" &&
		previous.target.workerId !== revalidated.target.workerId
	) {
		return { kind: "revalidated_out", reason: "memory_guard_action_revalidated_out" };
	}
	return revalidated;
}

export class MemoryGuardHost {
	#run: () => Promise<void>;
	#logDebug: (message: string, meta?: Record<string, unknown>) => void;
	#defaultSchedulerNow: () => number;
	#schedulerNow: () => number;
	#registrations = new Map<string, number>();
	#pendingTimer: NodeJS.Timeout | null = null;
	#pendingDeadline: number | null = null;
	#pendingOwner: ScheduleOwner | null = null;
	#deferredSchedule: DeferredSchedule | null = null;
	#inProgressOwner: WorkOwner | null = null;
	#stopped = false;
	#generation = 0;
	#nextTimerToken = 0;

	constructor(options: MemoryGuardHostOptions) {
		this.#run = options.run;
		this.#logDebug = options.logDebug ?? (() => undefined);
		this.#defaultSchedulerNow = options.schedulerNow ?? (() => performance.now());
		this.#schedulerNow = this.#defaultSchedulerNow;
	}

	register(registration: MemoryGuardHostRegistration): () => void {
		const intervalMs = normalizePositiveIntervalMs(registration.intervalMs);
		const isNewRegistration = !this.#registrations.has(registration.ownerId);
		this.#registrations.set(registration.ownerId, intervalMs);
		this.#stopped = false;
		if (isNewRegistration) {
			const deadline = this.#schedulerNow() + intervalMs;
			if (
				this.#inProgressOwner?.generation === this.#generation &&
				(this.#pendingDeadline === null || this.#pendingDeadline <= deadline)
			) {
				this.#deferSchedule(this.#generation, deadline);
			} else {
				this.#requestSchedule(deadline);
			}
		}
		let unregistered = false;
		return () => {
			if (unregistered) return;
			unregistered = true;
			this.#registrations.delete(registration.ownerId);
			if (this.#registrations.size === 0) this.#stop();
		};
	}

	updateInterval(ownerId: string, intervalMs: number): void {
		if (!this.#registrations.has(ownerId)) return;
		const normalized = normalizePositiveIntervalMs(intervalMs);
		if (this.#registrations.get(ownerId) === normalized) return;
		this.#registrations.set(ownerId, normalized);
		if (this.#inProgressOwner) return;
		this.#requestSchedule(this.#schedulerNow() + this.#currentSweepIntervalMs());
	}

	async runTick(generation = this.#generation, source: WorkOwner["source"] = "external"): Promise<void> {
		if (this.#inProgressOwner || this.#registrations.size === 0) return;
		const owner: WorkOwner = { generation, source };
		this.#inProgressOwner = owner;
		try {
			await this.#run();
		} catch (error) {
			this.#logDebug("memory guard tick failed", { error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (this.#inProgressOwner === owner) this.#inProgressOwner = null;
			this.#reconcileCurrentSchedule();
		}
	}

	async runTimerCallbackForTest(owner: { generation: number; token: number }, deadline: number): Promise<void> {
		await this.#handleTimerCallback(owner, deadline);
	}

	setSchedulerNowForTest(now: () => number): void {
		this.#schedulerNow = now;
	}

	getStateForTest(): MemoryGuardSchedulerState {
		return {
			timerActive: this.#pendingTimer !== null,
			registrationCount: this.#registrations.size,
			inProgress: this.#inProgressOwner !== null,
			generation: this.#generation,
			pendingDeadline: this.#pendingDeadline,
			pendingOwner: this.#pendingOwner ? { ...this.#pendingOwner } : null,
			deferredDeadline: this.#deferredSchedule?.deadline ?? null,
			deferredGeneration: this.#deferredSchedule?.generation ?? null,
			activeGeneration: this.#inProgressOwner?.generation ?? null,
		};
	}

	resetForTest(): void {
		this.#stop();
		this.#registrations.clear();
		this.#inProgressOwner = null;
		this.#deferredSchedule = null;
		this.#nextTimerToken = 0;
		this.#schedulerNow = this.#defaultSchedulerNow;
	}

	#currentSweepIntervalMs(): number {
		let min = Number.POSITIVE_INFINITY;
		for (const intervalMs of this.#registrations.values()) min = Math.min(min, intervalMs);
		return Number.isFinite(min) ? min : DEFAULT_CHECK_INTERVAL_MS;
	}

	#clearPendingSchedule(): void {
		if (this.#pendingTimer) clearTimeout(this.#pendingTimer);
		this.#pendingTimer = null;
		this.#pendingDeadline = null;
		this.#pendingOwner = null;
	}

	#requestSchedule(deadline: number): void {
		if (this.#stopped || this.#registrations.size === 0) return;
		if (this.#pendingDeadline !== null && this.#pendingDeadline <= deadline) return;
		this.#clearPendingSchedule();
		const owner = { generation: this.#generation, token: ++this.#nextTimerToken };
		this.#pendingDeadline = deadline;
		this.#pendingOwner = owner;
		this.#pendingTimer = setTimeout(
			() => {
				void this.#handleTimerCallback(owner, deadline);
			},
			Math.max(0, deadline - this.#schedulerNow()),
		);
		this.#pendingTimer.unref?.();
	}

	#deferSchedule(generation: number, deadline: number): void {
		if (generation !== this.#generation) return;
		if (this.#deferredSchedule?.generation === generation) {
			this.#deferredSchedule.deadline = Math.min(this.#deferredSchedule.deadline, deadline);
			return;
		}
		this.#deferredSchedule = { generation, deadline };
	}

	async #handleTimerCallback(owner: ScheduleOwner, deadline: number): Promise<void> {
		if (this.#pendingOwner?.generation !== owner.generation || this.#pendingOwner.token !== owner.token) return;
		this.#pendingTimer = null;
		this.#pendingDeadline = null;
		this.#pendingOwner = null;
		if (this.#inProgressOwner) {
			this.#deferSchedule(owner.generation, deadline);
			return;
		}
		await this.runTick(owner.generation, "timer");
	}

	#reconcileCurrentSchedule(): void {
		if (this.#stopped || this.#registrations.size === 0 || this.#inProgressOwner) return;
		const normalDeadline = this.#schedulerNow() + this.#currentSweepIntervalMs();
		const deferredDeadline =
			this.#deferredSchedule?.generation === this.#generation ? this.#deferredSchedule.deadline : null;
		if (deferredDeadline !== null) this.#deferredSchedule = null;
		this.#requestSchedule(deferredDeadline === null ? normalDeadline : Math.min(deferredDeadline, normalDeadline));
	}

	#stop(): void {
		this.#stopped = true;
		this.#generation++;
		this.#clearPendingSchedule();
		this.#deferredSchedule = null;
	}
}
