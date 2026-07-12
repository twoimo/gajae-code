import { describe, expect, it } from "bun:test";
import {
	deriveTeamPhase,
	type GjcTeamTask,
	type GjcTeamWorker,
	isLeaseActive,
	isReplayEligibleNotification,
	lifecycleStateForWorkerStatus,
	summarizeNotifications,
	taskClaimEligibilityReason,
	validateTaskTransition,
} from "../../../src/gjc-runtime/core/team-core";

const worker: GjcTeamWorker = {
	id: "worker-1",
	name: "Worker 1",
	index: 1,
	agent_type: "executor",
	role: "executor",
	status: "idle",
	last_heartbeat: "2026-01-01T00:00:00.000Z",
	assigned_tasks: [],
};
const task = (overrides: Partial<GjcTeamTask> = {}): GjcTeamTask => ({
	id: "task-1",
	subject: "Subject",
	description: "Description",
	title: "Subject",
	objective: "Description",
	status: "pending",
	version: 1,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
	...overrides,
});

describe("team core", () => {
	it("derives dependency and role-aware claim eligibility", () => {
		const dependency = task({
			id: "dependency",
			status: "completed",
			completion_evidence: {
				summary: "verified",
				recorded_by: "worker-1",
				recorded_at: "2026-01-01T00:00:00.000Z",
				items: [{ kind: "command", status: "passed", summary: "check", command: "bun test" }],
			},
		});
		expect(
			taskClaimEligibilityReason(task({ depends_on: [dependency.id], required_role: "executor" }), worker, [
				dependency,
			]),
		).toBeNull();
		expect(taskClaimEligibilityReason(task({ depends_on: [dependency.id] }), worker, [])).toBe(
			"task_dependency_incomplete:task-1:dependency",
		);
	});

	it("validates claim-owned transitions and explicit lease time", () => {
		const claimed = task({
			status: "in_progress",
			claim: { owner: worker.id, token: "claim-1", leased_until: "2026-01-01T00:30:00.000Z" },
		});
		expect(
			validateTaskTransition({ task: claimed, status: "completed", claimToken: "claim-1", workerId: worker.id }),
		).toBeNull();
		expect(validateTaskTransition({ task: claimed, status: "completed", claimToken: "wrong" })).toBe(
			"claim_token_mismatch:task-1",
		);
		expect(isLeaseActive(claimed.claim, "2026-01-01T00:00:00.000Z")).toBe(true);
		expect(isLeaseActive(claimed.claim, "2026-01-01T00:30:00.000Z")).toBe(false);
	});

	it("derives convergence, notifications, and lifecycle without runtime services", () => {
		const done = task({
			status: "completed",
			completion_evidence: {
				summary: "verified",
				recorded_by: "worker-1",
				recorded_at: "2026-01-01T00:00:00.000Z",
				items: [{ kind: "inspection", status: "verified", summary: "reviewed" }],
			},
		});
		expect(deriveTeamPhase({ storedPhase: "running", tasks: [done], hasPendingIntegration: true })).toBe(
			"awaiting_integration",
		);
		const summary = summarizeNotifications([
			{
				id: "n1",
				team_name: "team",
				recipient: "worker-1",
				source: { type: "event", id: "e1" },
				delivery_state: "deferred",
				replay_count: 0,
			},
			{
				id: "n2",
				team_name: "team",
				recipient: "worker-1",
				source: { type: "event", id: "e2" },
				delivery_state: "delivered",
				replay_count: 0,
			},
		]);
		expect(summary).toMatchObject({ total: 2, replay_eligible: 1, by_state: { deferred: 1, delivered: 1 } });
		expect(isReplayEligibleNotification("failed")).toBe(true);
		expect(lifecycleStateForWorkerStatus("done")).toBe("ready");
	});
});
