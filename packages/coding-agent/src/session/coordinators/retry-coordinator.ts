import type { AttemptBudgetEnvelope, AttemptKind } from "@gajae-code/ai";
import { AttemptBudgetExceededError } from "@gajae-code/ai";

export interface RetryCoordinatorSettings {
	unbounded: boolean;
	maxTotalAttempts: number;
	maxElapsedMs: number;
	maxCostUsd?: number;
}

export interface RetryCoordinatorDiagnostics {
	outerRetryCount: number;
	totalPhysicalAttempts: number;
	attemptKind?: AttemptKind;
	attemptLayer?: "provider" | "credential" | "maintenance" | "gateway";
	provider?: string;
	model?: string;
	elapsedMs: number;
	deadlineMs: number;
	costKnown: boolean;
	accumulatedCostUsd?: number;
	costCeilingUsd?: number;
	terminalReason?:
		| "attempts"
		| "deadline"
		| "cost"
		| "outer_retries"
		| "cancelled"
		| "recovery_failure"
		| "non_retryable"
		| "success";
}

type Ledger = {
	attempts: number;
	startedAt?: number;
	knownCostUsd: number;
	costKnown: boolean;
	turnBudgetId: string;
	lastAttemptKind?: AttemptKind;
};

/** Single owner of per-turn retry accounting and its transferable budget identity. */
export class RetryCoordinator {
	#ledger: Ledger | undefined;

	beginTurn(): void {
		this.#ledger = { attempts: 0, knownCostUsd: 0, costKnown: true, turnBudgetId: crypto.randomUUID() };
	}

	hasActiveTurn(): boolean {
		return this.#ledger !== undefined;
	}

	ensureLedger(initialAttempt = false): Ledger {
		this.#ledger ??= {
			attempts: initialAttempt ? 1 : 0,
			startedAt: initialAttempt ? performance.now() : undefined,
			knownCostUsd: 0,
			costKnown: true,
			turnBudgetId: crypto.randomUUID(),
		};
		return this.#ledger;
	}

	snapshot(settings: RetryCoordinatorSettings, unbounded: boolean): AttemptBudgetEnvelope {
		const ledger = this.ensureLedger();
		if (unbounded)
			return {
				turnBudgetId: ledger.turnBudgetId,
				remainingAttempts: Number.MAX_SAFE_INTEGER,
				remainingDurationMs: Number.MAX_SAFE_INTEGER,
				maxAttempts: Number.MAX_SAFE_INTEGER,
			};
		const elapsedMs = ledger.startedAt === undefined ? 0 : performance.now() - ledger.startedAt;
		return {
			turnBudgetId: ledger.turnBudgetId,
			remainingAttempts: Math.max(0, settings.maxTotalAttempts - ledger.attempts),
			remainingDurationMs: Math.max(0, settings.maxElapsedMs - elapsedMs),
			maxAttempts: settings.maxTotalAttempts,
		};
	}

	reconcile(snapshot: AttemptBudgetEnvelope, settings: RetryCoordinatorSettings, unbounded: boolean): void {
		const ledger = this.#ledger;
		if (
			!ledger ||
			snapshot.turnBudgetId !== ledger.turnBudgetId ||
			unbounded ||
			snapshot.maxAttempts !== settings.maxTotalAttempts
		)
			return;
		ledger.attempts = Math.max(ledger.attempts, Math.max(0, snapshot.maxAttempts - snapshot.remainingAttempts));
	}

	reportCost(costUsd?: number): void {
		if (!this.#ledger) return;
		if (costUsd === undefined || !Number.isFinite(costUsd)) {
			this.#ledger.costKnown = false;
			return;
		}
		this.#ledger.knownCostUsd += Math.max(0, costUsd);
	}

	diagnostics(
		settings: RetryCoordinatorSettings,
		outerRetryCount: number,
		model: { provider?: string; id?: string } | undefined,
		terminalReason?: RetryCoordinatorDiagnostics["terminalReason"],
		pendingKind?: AttemptKind,
	): RetryCoordinatorDiagnostics {
		const ledger = this.#ledger;
		const kind = pendingKind ?? ledger?.lastAttemptKind;
		return {
			outerRetryCount,
			totalPhysicalAttempts: ledger?.attempts ?? 0,
			attemptKind: kind,
			attemptLayer: kind?.startsWith("credential-")
				? "credential"
				: kind === "maintenance"
					? "maintenance"
					: kind === "gateway-outer"
						? "gateway"
						: kind
							? "provider"
							: undefined,
			provider: model?.provider,
			model: model?.id,
			elapsedMs: ledger?.startedAt === undefined ? 0 : performance.now() - ledger.startedAt,
			deadlineMs: settings.maxElapsedMs,
			costKnown: ledger?.costKnown ?? true,
			accumulatedCostUsd: ledger?.costKnown === false ? undefined : (ledger?.knownCostUsd ?? 0),
			costCeilingUsd: settings.maxCostUsd,
			terminalReason,
		};
	}

	consume(
		kind: AttemptKind | undefined,
		settings: RetryCoordinatorSettings,
		unbounded: boolean,
		diagnostics: (reason: "attempts" | "deadline" | "cost") => RetryCoordinatorDiagnostics,
	): void {
		const ledger = this.ensureLedger();
		const now = performance.now();
		const elapsedMs = ledger.startedAt === undefined ? 0 : now - ledger.startedAt;
		const fail = (reason: "attempts" | "deadline" | "cost", message: string): never => {
			throw new AttemptBudgetExceededError(reason, message, { ...diagnostics(reason), terminalReason: reason });
		};
		if (!unbounded && ledger.attempts >= settings.maxTotalAttempts)
			fail("attempts", `Retry total-attempt budget exhausted (${ledger.attempts}/${settings.maxTotalAttempts}).`);
		if (!unbounded && elapsedMs >= settings.maxElapsedMs)
			fail(
				"deadline",
				`Retry elapsed-time budget exhausted (${Math.round(elapsedMs)}ms/${settings.maxElapsedMs}ms).`,
			);
		if (
			!unbounded &&
			ledger.costKnown &&
			settings.maxCostUsd !== undefined &&
			ledger.knownCostUsd >= settings.maxCostUsd
		)
			fail("cost", `Retry cost budget exhausted ($${ledger.knownCostUsd}/${settings.maxCostUsd}).`);
		ledger.startedAt ??= now;
		ledger.lastAttemptKind = kind;
		ledger.attempts++;
	}

	current(): Readonly<Ledger> | undefined {
		return this.#ledger;
	}
}
