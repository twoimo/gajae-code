import { describe, expect, test } from "bun:test";
import {
	mapAsyncJobStatus,
	mapCronStatus,
	mapSessionStatus,
	mapSubagentStatus,
	TasksAggregator,
} from "../src/modes/tasks-aggregator";

const noop = () => () => {};

describe("TasksAggregator status contract", () => {
	test("maps every source status to the unified lifecycle", () => {
		expect(
			Object.fromEntries(
				["running", "paused", "completed", "failed", "cancelled"].map(s => [s, mapAsyncJobStatus(s as never)]),
			),
		).toEqual({
			running: "running",
			paused: "waiting",
			completed: "done",
			failed: "failed",
			cancelled: "cancelled",
		});
		expect(
			Object.fromEntries(["active", "completed", "failed", "aborted"].map(s => [s, mapSessionStatus(s as never)])),
		).toEqual({
			active: "running",
			completed: "done",
			failed: "failed",
			aborted: "cancelled",
		});
		expect(
			Object.fromEntries(
				["running", "queued", "paused", "completed", "failed", "cancelled"].map(s => [
					s,
					mapSubagentStatus(s as never),
				]),
			),
		).toEqual({
			running: "running",
			queued: "waiting",
			paused: "waiting",
			completed: "done",
			failed: "failed",
			cancelled: "cancelled",
		});
		expect(mapCronStatus({ firing: false })).toBe("waiting");
		expect(mapCronStatus({ firing: true })).toBe("running");
	});

	test("uses registry lifecycle over a queued manager record and preserves resumability", () => {
		const manager = {
			onChange: noop,
			getAllJobs: () => [],
			getSubagentRecords: () => [{ subagentId: "a", status: "queued", resumable: true }],
		};
		const observer = {
			onChange: noop,
			getSnapshot: () => ({ monitors: [], crons: [], failedUnacknowledged: false }),
			acknowledgeFailures: () => {},
			getMonitorOutput: () => "",
		};
		const sessions = {
			onChange: noop,
			getSessions: () => [{ id: "a", kind: "subagent", label: "Live", status: "active", lastUpdate: 1 }],
		};
		const aggregator = new TasksAggregator(manager as never, observer as never, sessions as never);
		expect(aggregator.getSnapshot().rows).toEqual([
			{ id: "subagent:a", kind: "subagent", label: "Live", status: "running", startedAt: 1, resumable: true },
		]);
		aggregator.dispose();
	});
});
