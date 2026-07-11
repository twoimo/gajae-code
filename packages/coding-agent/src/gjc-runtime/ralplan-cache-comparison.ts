import type { TaskTokenLog } from "../task/types";

export type RalplanCacheMode = "irc" | "legacy";
export type RalplanCacheRole = "architect" | "critic" | "planner";

/** Immutable pairing metadata recorded alongside a production token log. */
export interface RalplanCacheTurnKey {
	runId: string;
	mode: RalplanCacheMode;
	role: RalplanCacheRole;
	subagentId: string;
	pass: number;
	turn: number;
	provider: string;
	model: string;
	attemptId: string;
	attemptOrdinal: number;
	isRetry?: boolean;
}

/** Raw token evidence recorded for one role-model turn. */
export interface RalplanCacheTurn {
	runId: string;
	mode: RalplanCacheMode;
	role: RalplanCacheRole;
	subagentId: string;
	pass: number;
	turn: number;
	provider: string;
	model: string;
	inputTokens: number;
	cacheReadTokens: number;
	/** Stable identity of this attempted role turn in the paired evidence run. */
	attemptId: string;
	/** One-based declared attempt slot; retries occupy their declared ordinal. */
	attemptOrdinal: number;
	/** Explicit retries are retained as disqualified evidence. */
	isRetry?: boolean;
}

/**
 * Joins production token logs to their immutable ralplan evidence keys. Every
 * log must have exactly one key, preventing cache data from being relabelled
 * after collection.
 */
export function adaptTaskTokenLogsToRalplanCacheTurns(
	logs: readonly TaskTokenLog[],
	keys: readonly RalplanCacheTurnKey[],
): RalplanCacheTurn[] {
	const byLog = new Map<string, RalplanCacheTurnKey[]>();
	for (const key of keys) {
		const logKey = [key.subagentId, key.turn].join("\u0000");
		const matches = byLog.get(logKey) ?? [];
		matches.push(key);
		byLog.set(logKey, matches);
	}
	return logs.map(log => {
		const logKey = [log.subagentId, log.turn].join("\u0000");
		const matches = byLog.get(logKey) ?? [];
		if (matches.length !== 1)
			throw new Error(`Expected exactly one ralplan cache key for subagent=${log.subagentId} turn=${log.turn}.`);
		const key = matches[0]!;
		if (key.model !== log.model)
			throw new Error(
				`Ralplan cache key model does not match token log for subagent=${log.subagentId} turn=${log.turn}.`,
			);
		return {
			...key,
			inputTokens: log.input,
			cacheReadTokens: log.cacheRead,
		};
	});
}

export interface RalplanCacheComparison {
	irc: RalplanCacheTurn;
	legacy: RalplanCacheTurn;
	ircCacheHitRate: number | null;
	legacyCacheHitRate: number | null;
}

export interface RalplanCacheEvidence {
	comparisons: RalplanCacheComparison[];
	rawTurns: RalplanCacheTurn[];
	/** Evidence slots rejected rather than silently backfilled. */
	disqualifications: string[];
}

function cacheHitRate(turn: RalplanCacheTurn): number | null {
	const denominator = turn.inputTokens + turn.cacheReadTokens;
	return denominator === 0 ? null : turn.cacheReadTokens / denominator;
}

function comparable(turn: RalplanCacheTurn): boolean {
	return (
		(turn.role === "architect" || turn.role === "critic") &&
		turn.pass === 2 &&
		Number.isInteger(turn.attemptOrdinal) &&
		turn.attemptOrdinal > 0 &&
		turn.attemptId.length > 0
	);
}

function attemptSlotKey(turn: RalplanCacheTurn): string {
	return [turn.role, turn.subagentId, turn.pass, turn.provider, turn.model, turn.attemptOrdinal].join("\u0000");
}

function comparisonKey(turn: RalplanCacheTurn): string {
	return [turn.role, turn.subagentId, turn.pass, turn.provider, turn.model, turn.attemptId, turn.attemptOrdinal].join(
		"\u0000",
	);
}

/**
 * Select the first three declared attempt slots before matching modes. An
 * unmatched, duplicate, or explicit-retry slot is disqualified and cannot be
 * replaced by a later favorable pair.
 */
export function compareRalplanCacheTurns(turns: readonly RalplanCacheTurn[], maxPairs = 3): RalplanCacheEvidence {
	const cap = Number.isFinite(maxPairs) ? Math.max(0, Math.min(3, Math.floor(maxPairs))) : 3;
	const slots = new Map<string, RalplanCacheTurn[]>();
	for (const turn of turns) {
		if (!comparable(turn)) continue;
		const key = attemptSlotKey(turn);
		const slot = slots.get(key) ?? [];
		slot.push(turn);
		slots.set(key, slot);
	}

	const selected = [...slots.entries()]
		.sort(([a, turnsA], [b, turnsB]) => turnsA[0]!.attemptOrdinal - turnsB[0]!.attemptOrdinal || a.localeCompare(b))
		.slice(0, cap);
	const comparisons: RalplanCacheComparison[] = [];
	const disqualifications: string[] = [];
	for (const [slotKey, slot] of selected) {
		if (slot.some(turn => turn.isRetry === true)) {
			disqualifications.push(`slot=${slotKey} reason=explicit_retry`);
			continue;
		}
		const irc = slot.filter(turn => turn.mode === "irc");
		const legacy = slot.filter(turn => turn.mode === "legacy");
		if (irc.length !== 1 || legacy.length !== 1 || comparisonKey(irc[0]!) !== comparisonKey(legacy[0]!)) {
			disqualifications.push(
				`slot=${slotKey} reason=${irc.length > 1 || legacy.length > 1 ? "duplicate_attempt_ordinal" : "unmatched_attempt"}`,
			);
			continue;
		}
		comparisons.push({
			irc: irc[0]!,
			legacy: legacy[0]!,
			ircCacheHitRate: cacheHitRate(irc[0]!),
			legacyCacheHitRate: cacheHitRate(legacy[0]!),
		});
	}
	return { comparisons, rawTurns: [...turns], disqualifications };
}

export function renderRalplanCacheEvidenceForAdr(evidence: RalplanCacheEvidence): string {
	const rows = evidence.comparisons.map(
		({ irc, legacy, ircCacheHitRate, legacyCacheHitRate }) =>
			`- IRC run=${irc.runId} role=${irc.role} subagent=${irc.subagentId} provider=${irc.provider} model=${irc.model} pass=${irc.pass} turn=${irc.turn} attemptId=${irc.attemptId} attemptOrdinal=${irc.attemptOrdinal} input=${irc.inputTokens} cacheRead=${irc.cacheReadTokens} rate=${formatRate(ircCacheHitRate)}; legacy run=${legacy.runId} role=${legacy.role} subagent=${legacy.subagentId} provider=${legacy.provider} model=${legacy.model} pass=${legacy.pass} turn=${legacy.turn} attemptId=${legacy.attemptId} attemptOrdinal=${legacy.attemptOrdinal} input=${legacy.inputTokens} cacheRead=${legacy.cacheReadTokens} rate=${formatRate(legacyCacheHitRate)}`,
	);
	return [
		"## IRC Cache Evidence",
		"",
		...rows,
		"",
		"### Disqualified attempt slots",
		...evidence.disqualifications.map(value => `- ${value}`),
		"",
		"### Raw turn evidence",
		...evidence.rawTurns.map(
			turn =>
				`- run=${turn.runId} mode=${turn.mode} role=${turn.role} subagent=${turn.subagentId} pass=${turn.pass} turn=${turn.turn} attemptId=${turn.attemptId} attemptOrdinal=${turn.attemptOrdinal} provider=${turn.provider} model=${turn.model} input=${turn.inputTokens} cacheRead=${turn.cacheReadTokens} retry=${turn.isRetry === true}`,
		),
	].join("\n");
}

function formatRate(rate: number | null): string {
	return rate === null ? "null" : rate.toString();
}
