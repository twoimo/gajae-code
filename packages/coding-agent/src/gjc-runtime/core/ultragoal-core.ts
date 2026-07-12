/**
 * Deterministic Ultragoal domain operations.
 *
 * This module deliberately has no storage, process, UI, CLI, git, or Node dependencies.
 * Runtime adapters provide clocks, ids, hashing, and persistence at their boundary.
 */
export type UltragoalGjcGoalMode = "aggregate" | "per-story";
export type UltragoalGoalStatus =
	| "pending"
	| "active"
	| "complete"
	| "failed"
	| "blocked"
	| "review_blocked"
	| "superseded";
export type UltragoalPipelineOverlapState =
	| "none"
	| "open"
	| "joined_clean"
	| "blocked_disjoint_continue"
	| "quarantine_required"
	| "rebaseline_complete";

export interface JsonObject {
	[key: string]: unknown;
}

export interface UltragoalPipelineTargets extends JsonObject {
	files: string[];
	surfaces: string[];
}

export interface UltragoalPipelineMetadata extends JsonObject {
	goalId: string;
	metadataHash: string;
	overlap: UltragoalPipelineOverlapState;
	targets: UltragoalPipelineTargets;
	overlapId?: string;
	priorGoalId?: string;
	nextGoalId?: string;
}

export interface UltragoalGoal {
	id: string;
	title: string;
	objective: string;
	status: UltragoalGoalStatus;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
	evidence?: string;
	pipelineMetadata?: UltragoalPipelineMetadata;
}

export interface UltragoalPlan {
	version: 1;
	brief: string;
	gjcGoalMode: UltragoalGjcGoalMode;
	gjcObjective: string;
	goals: UltragoalGoal[];
	createdAt: string;
	updatedAt: string;
}

export interface UltragoalLedgerEvent extends JsonObject {
	event?: string;
	goalId?: string;
}

export type UltragoalNudgeTargetKind = "story" | "final_aggregate_receipt";
export interface UltragoalNudgeTarget {
	goalId: string;
	targetKind: UltragoalNudgeTargetKind;
}

const TERMINAL_STATUSES = new Set<UltragoalGoalStatus>(["complete", "superseded"]);
const SCHEDULABLE_STATUSES = new Set<UltragoalGoalStatus>(["pending", "active", "failed"]);
const COMPLETE_PRE_STATUSES = new Set<UltragoalGoalStatus>(["active", "failed"]);

export function stableStructuredValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => stableStructuredValue(item));
	if (typeof value !== "object" || value === null) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const item = (value as Record<string, unknown>)[key];
		if (item !== undefined) sorted[key] = stableStructuredValue(item);
	}
	return sorted;
}

/** The adapter supplies its synchronous cryptographic implementation. */
export function hashStructuredValue(value: unknown, hash: (serialized: string) => string): string {
	return hash(JSON.stringify(stableStructuredValue(value)));
}

export function normalizeGoalStatus(value: unknown): UltragoalGoalStatus {
	return typeof value === "string" &&
		["pending", "active", "complete", "failed", "blocked", "review_blocked", "superseded"].includes(value)
		? (value as UltragoalGoalStatus)
		: "pending";
}

export function chooseNextGoal<TGoal extends { status: UltragoalGoalStatus }>(
	plan: { goals: readonly TGoal[] },
	retryFailed = false,
): TGoal | undefined {
	return (
		plan.goals.find(goal => goal.status === "active") ??
		plan.goals.find(goal => goal.status === "pending") ??
		(retryFailed ? plan.goals.find(goal => goal.status === "failed") : undefined)
	);
}

export function countUltragoalNudges(ledger: readonly UltragoalLedgerEvent[], goalId: string): number {
	return ledger.filter(event => event.event === "nudge" && event.goalId === goalId).length;
}

export function selectUltragoalNudgeTarget(
	plan: UltragoalPlan,
	options: { currentGoalObjective?: string; retryFailed?: boolean } = {},
): UltragoalNudgeTarget | null {
	const objective = options.currentGoalObjective?.trim();
	if (objective) {
		const matched = plan.goals.find(
			goal => goal.objective.trim() === objective && SCHEDULABLE_STATUSES.has(goal.status),
		);
		if (matched) return { goalId: matched.id, targetKind: "story" };
	}
	const next = chooseNextGoal(plan, options.retryFailed === true);
	if (next) return { goalId: next.id, targetKind: "story" };
	const required = plan.goals.filter(goal => goal.status !== "superseded");
	if (plan.gjcGoalMode === "aggregate" && required.length > 0 && required.every(goal => goal.status === "complete")) {
		return { goalId: required.at(-1)?.id ?? "final-aggregate", targetKind: "final_aggregate_receipt" };
	}
	return null;
}

export function emptyCounts(): Record<UltragoalGoalStatus, number> {
	return { pending: 0, active: 0, complete: 0, failed: 0, blocked: 0, review_blocked: 0, superseded: 0 };
}

export function deriveUltragoalStatus(plan: UltragoalPlan): {
	status: "pending" | "active" | "complete" | "blocked" | "failed";
	counts: Record<UltragoalGoalStatus, number>;
	currentGoal?: UltragoalGoal;
} {
	const counts = emptyCounts();
	for (const goal of plan.goals) counts[goal.status] += 1;
	const currentGoal = plan.goals.find(goal => SCHEDULABLE_STATUSES.has(goal.status));
	const status =
		plan.goals.length > 0 && plan.goals.every(goal => TERMINAL_STATUSES.has(goal.status))
			? "complete"
			: counts.active > 0
				? "active"
				: counts.failed > 0
					? "failed"
					: counts.blocked > 0 || counts.review_blocked > 0
						? "blocked"
						: "pending";
	return { status, counts, currentGoal };
}

export function getUltragoalRunCompletionState(
	plan: UltragoalPlan,
	options: { retryFailed?: boolean } = {},
): {
	requiredGoals: UltragoalGoal[];
	incompleteGoals: UltragoalGoal[];
	nextGoal?: UltragoalGoal;
	allComplete: boolean;
	hasBlockers: boolean;
	needsFinalAggregateReceipt: boolean;
} {
	const requiredGoals = plan.goals.filter(goal => goal.status !== "superseded");
	const incompleteGoals = requiredGoals.filter(goal => !TERMINAL_STATUSES.has(goal.status));
	return {
		requiredGoals,
		incompleteGoals,
		nextGoal: chooseNextGoal(plan, options.retryFailed === true),
		allComplete: requiredGoals.length > 0 && incompleteGoals.length === 0,
		hasBlockers: incompleteGoals.some(goal => goal.status === "blocked" || goal.status === "review_blocked"),
		needsFinalAggregateReceipt: plan.gjcGoalMode === "aggregate" && incompleteGoals.length === 0,
	};
}

export function validateCompleteCheckpointTargetGoal(goal: UltragoalGoal): void {
	if (COMPLETE_PRE_STATUSES.has(goal.status)) return;
	if (goal.status === "pending")
		throw new Error(
			`Cannot checkpoint ${goal.id} as complete while its durable goals.json status is pending; start the goal before completing it.`,
		);
	if (goal.status === "complete")
		throw new Error(
			`Cannot checkpoint ${goal.id} as complete with different evidence because its durable goals.json status is already complete.`,
		);
	if (goal.status === "superseded")
		throw new Error(`Cannot checkpoint ${goal.id} as complete because its durable goals.json status is superseded.`);
	throw new Error(
		`Cannot checkpoint ${goal.id} as complete while its durable goals.json status is ${goal.status}; only active or retryable failed goals can be completed.`,
	);
}

export function transitionPipelineOverlap(
	state: UltragoalPipelineOverlapState,
	input: { clean: boolean; blockersDisjoint: boolean },
): UltragoalPipelineOverlapState {
	if (state !== "open") throw new Error("Pipeline overlap must be open before it can be joined");
	if (input.clean) return "joined_clean";
	return input.blockersDisjoint ? "blocked_disjoint_continue" : "quarantine_required";
}
