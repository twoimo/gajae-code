import { describe, expect, it } from "bun:test";
import {
	chooseNextGoal,
	countUltragoalNudges,
	deriveUltragoalStatus,
	hashStructuredValue,
	selectUltragoalNudgeTarget,
	transitionPipelineOverlap,
	type UltragoalPlan,
	validateCompleteCheckpointTargetGoal,
} from "../../../src/gjc-runtime/core/ultragoal-core";

function plan(
	statuses: UltragoalPlan["goals"][number]["status"][],
	mode: UltragoalPlan["gjcGoalMode"] = "aggregate",
): UltragoalPlan {
	return {
		version: 1,
		brief: "test",
		gjcGoalMode: mode,
		gjcObjective: "test",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		goals: statuses.map((status, index) => ({
			id: `G${String(index + 1).padStart(3, "0")}`,
			title: `Goal ${index + 1}`,
			objective: `Objective ${index + 1}`,
			status,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})),
	};
}

describe("ultragoal core", () => {
	it("uses canonical structured values before delegating deterministic hashing", () => {
		const serialized: string[] = [];
		const hash = (value: string) => {
			serialized.push(value);
			return "digest";
		};
		expect(hashStructuredValue({ b: undefined, a: { d: 2, c: 1 } }, hash)).toBe("digest");
		expect(serialized).toEqual(['{"a":{"c":1,"d":2}}']);
	});

	it("selects the current objective before the normal goal order and counts only exact nudge rows", () => {
		const value = plan(["pending", "active"]);
		expect(selectUltragoalNudgeTarget(value, { currentGoalObjective: "Objective 1" })).toEqual({
			goalId: "G001",
			targetKind: "story",
		});
		expect(chooseNextGoal(value)).toMatchObject({ id: "G002" });
		expect(
			countUltragoalNudges(
				[
					{ event: "nudge", goalId: "G001" },
					{ event: "nudge", goalId: "G002" },
					{ event: "other", goalId: "G001" },
				],
				"G001",
			),
		).toBe(1);
	});

	it("derives status and aggregate receipt nudge target from terminal goals", () => {
		const value = plan(["complete", "superseded"]);
		expect(deriveUltragoalStatus(value)).toMatchObject({
			status: "complete",
			counts: { complete: 1, superseded: 1 },
		});
		expect(selectUltragoalNudgeTarget(value)).toEqual({ goalId: "G001", targetKind: "final_aggregate_receipt" });
	});

	it("rejects invalid completion states and preserves pipeline join decisions", () => {
		expect(() => validateCompleteCheckpointTargetGoal(plan(["pending"]).goals[0]!)).toThrow(
			/durable goals\.json status is pending/,
		);
		expect(() => transitionPipelineOverlap("joined_clean", { clean: true, blockersDisjoint: true })).toThrow(
			/must be open/,
		);
		expect(transitionPipelineOverlap("open", { clean: false, blockersDisjoint: true })).toBe(
			"blocked_disjoint_continue",
		);
		expect(transitionPipelineOverlap("open", { clean: false, blockersDisjoint: false })).toBe("quarantine_required");
	});
});
