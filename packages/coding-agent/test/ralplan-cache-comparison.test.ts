import { describe, expect, it } from "bun:test";
import {
	adaptTaskTokenLogsToRalplanCacheTurns,
	compareRalplanCacheTurns,
	type RalplanCacheTurn,
	renderRalplanCacheEvidenceForAdr,
} from "@gajae-code/coding-agent/gjc-runtime/ralplan-cache-comparison";
import type { TaskTokenLog } from "@gajae-code/coding-agent/task/types";

function turn(overrides: Partial<RalplanCacheTurn> = {}): RalplanCacheTurn {
	return {
		runId: "run",
		mode: "irc",
		role: "architect",
		subagentId: "architect-1",
		pass: 2,
		turn: 1,
		provider: "openai",
		model: "gpt-test",
		attemptId: "architect-1-pass-2-attempt-1",
		attemptOrdinal: 1,

		inputTokens: 100,
		cacheReadTokens: 25,
		...overrides,
	};
}

function pair(overrides: Partial<RalplanCacheTurn> = {}): RalplanCacheTurn[] {
	const attemptOrdinal = overrides.attemptOrdinal ?? overrides.turn ?? 1;
	const attemptId =
		overrides.attemptId ??
		`${overrides.role ?? "architect"}-${overrides.subagentId ?? "architect-1"}-attempt-${attemptOrdinal}`;
	return [
		turn({ ...overrides, attemptId, attemptOrdinal }),
		turn({ ...overrides, attemptId, attemptOrdinal, mode: "legacy", runId: "legacy-run" }),
	];
}

describe("ralplan cache comparison", () => {
	it("selects only comparable second-pass Architect and Critic turns", () => {
		const evidence = compareRalplanCacheTurns([
			...pair(),
			...pair({ role: "critic", subagentId: "critic-1" }),
			...pair({ pass: 1 }),
			...pair({ role: "planner", subagentId: "planner-1" }),
		]);
		expect(evidence.comparisons.map(pairing => pairing.irc.role)).toEqual(["architect", "critic"]);
	});

	it("excludes parent Planner evidence and disqualifies explicit retry slots", () => {
		const evidence = compareRalplanCacheTurns([
			...pair({ role: "planner", subagentId: "parent", turn: 2 }),
			...pair({ isRetry: true, turn: 3 }),
			...pair(),
		]);
		expect(evidence.comparisons).toHaveLength(1);
		expect(evidence.comparisons[0]?.irc.turn).toBe(1);
		expect(evidence.disqualifications).toContainEqual(expect.stringContaining("explicit_retry"));
	});

	it("does not backfill an explicit retry slot with later favorable pairs", () => {
		const evidence = compareRalplanCacheTurns(
			[
				...pair({ isRetry: true, attemptOrdinal: 1, turn: 1 }),
				...pair({ attemptOrdinal: 2, turn: 2, cacheReadTokens: 90 }),
				...pair({ attemptOrdinal: 3, turn: 3, cacheReadTokens: 90 }),
			],
			1,
		);
		expect(evidence.comparisons).toHaveLength(0);
		expect(evidence.disqualifications).toContainEqual(expect.stringContaining("explicit_retry"));
	});

	it("adapts production-shaped token logs using immutable ralplan evidence keys", () => {
		const logs: TaskTokenLog[] = [
			{
				subagentId: "architect-1",
				agent: "architect",
				turn: 1,
				at: "2026-01-01T00:00:00.000Z",
				input: 100,
				output: 20,
				cacheRead: 40,
				cacheWrite: 10,
				totalTokens: 170,
				model: "gpt-test",
			},
		];
		const [adapted] = adaptTaskTokenLogsToRalplanCacheTurns(logs, [
			{
				runId: "irc-run",
				mode: "irc",
				role: "architect",
				subagentId: "architect-1",
				pass: 2,
				turn: 1,
				provider: "openai",
				model: "gpt-test",
				attemptId: "architect-1-1",
				attemptOrdinal: 1,
			},
		]);
		expect(adapted).toMatchObject({ runId: "irc-run", inputTokens: 100, cacheReadTokens: 40 });
	});

	it("computes cache hit rate from input and cache-read tokens", () => {
		const evidence = compareRalplanCacheTurns(pair({ inputTokens: 75, cacheReadTokens: 25 }));
		expect(evidence.comparisons[0]?.ircCacheHitRate).toBe(0.25);
	});

	it("returns null for a zero reusable-input denominator", () => {
		const evidence = compareRalplanCacheTurns(pair({ inputTokens: 0, cacheReadTokens: 0 }));
		expect(evidence.comparisons[0]?.ircCacheHitRate).toBeNull();
	});

	it("caps live comparison at three paired attempts without favorable-result retries", () => {
		const evidence = compareRalplanCacheTurns(
			[...pair({ turn: 1 }), ...pair({ turn: 2 }), ...pair({ turn: 3 }), ...pair({ turn: 4 })],
			99,
		);
		expect(evidence.comparisons).toHaveLength(3);
		expect(evidence.comparisons.map(pairing => pairing.irc.turn)).toEqual([1, 2, 3]);
	});

	it("does not backfill an unmatched first slot with a later favorable pair", () => {
		const evidence = compareRalplanCacheTurns([
			turn({ attemptId: "first", attemptOrdinal: 1, cacheReadTokens: 0 }),
			...pair({ attemptId: "second", attemptOrdinal: 2, turn: 2, cacheReadTokens: 90 }),
		]);
		expect(evidence.comparisons).toHaveLength(1);
		expect(evidence.comparisons[0]?.irc.attemptId).toBe("second");
		expect(evidence.disqualifications).toContainEqual(expect.stringContaining("unmatched_attempt"));
	});

	it("disqualifies duplicate declared attempt ordinals", () => {
		const evidence = compareRalplanCacheTurns([
			...pair(),
			turn({ attemptId: "duplicate", turn: 2, cacheReadTokens: 90 }),
		]);
		expect(evidence.comparisons).toHaveLength(0);
		expect(evidence.disqualifications).toContainEqual(expect.stringContaining("duplicate_attempt_ordinal"));
	});

	it("renders ADR cache evidence with run role subagent provider and model keys", () => {
		const rendered = renderRalplanCacheEvidenceForAdr(compareRalplanCacheTurns(pair()));
		for (const key of ["run=run", "role=architect", "subagent=architect-1", "provider=openai", "model=gpt-test"]) {
			expect(rendered).toContain(key);
		}
	});
});
