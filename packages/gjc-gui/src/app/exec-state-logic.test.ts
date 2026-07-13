import { describe, expect, test } from "bun:test";
import {
	cardFromRows,
	errorCard,
	mergeExecCards,
	monitorsCardFromResult,
	notificationRefreshCause,
	rowLine,
	shouldRefreshOnTurnBoundary,
} from "./exec-state-logic";

describe("exec-state logic", () => {
	test("maps loading empty populated and CJK rows", () => {
		expect(cardFromRows("todos", "Todos", undefined).status).toBe("loading");
		expect(cardFromRows("jobs", "Jobs", []).status).toBe("empty");
		const card = cardFromRows("todos", "Todos", [{ content: "レビューする", status: "pending" }]);
		expect(card.status).toBe("populated");
		expect(card.lines[0]).toContain("レビューする");
	});

	test("formats numeric usage rows", () => {
		expect(rowLine({ modelId: "gpt", input: 10, output: 5, cost: 0.1 })).toContain("input:10");
	});

	test("maps errors", () => {
		expect(errorCard("usage", "Usage", new Error("boom"))).toMatchObject({ status: "error", error: "boom" });
	});

	test("turn-boundary detector is stable under repeated identical activeTurnId", () => {
		expect(shouldRefreshOnTurnBoundary(undefined, "turn-1")).toBe(true);
		expect(shouldRefreshOnTurnBoundary("turn-1", undefined)).toBe(true);
		expect(shouldRefreshOnTurnBoundary("turn-1", "turn-1")).toBe(false);
		expect(shouldRefreshOnTurnBoundary("turn-1", "turn-1")).toBe(false);
	});

	test("keeps populated cards visible while refresh is loading", () => {
		const current = [cardFromRows("jobs", "Jobs", [{ id: "job-1", status: "running" }])];
		const merged = mergeExecCards(current, [cardFromRows("jobs", "Jobs", undefined)]);
		expect(merged[0]).toMatchObject({ status: "populated", lines: [expect.stringContaining("job-1")] });
	});

	test("jobs-changed notification triggers exec-state refresh", () => {
		expect(notificationRefreshCause({ method: "gjc/jobs/changed", params: { threadId: "thread-1" } })).toBe(
			"jobs-changed",
		);
		expect(notificationRefreshCause({ method: "gjc/event", params: { eventType: "todo_reminder" } })).toBe(
			"todos-changed",
		);
		expect(notificationRefreshCause({ method: "gjc/event", params: { eventType: "notice" } })).toBeUndefined();
	});

	test("monitors card combines monitor outputTail and cron rows", () => {
		const card = monitorsCardFromResult({
			monitors: [{ id: "mon-1", status: "running", outputTail: "latest monitor output" }],
			crons: [{ id: "cron-1", humanSchedule: "every hour", cronExpression: "0 * * * *", prompt: "check status" }],
		});

		expect(card.status).toBe("populated");
		expect(card.lines).toEqual([
			expect.stringContaining("latest monitor output"),
			expect.stringContaining("schedule — every hour"),
		]);
	});

	test("monitors card stays populated when only crons exist", () => {
		const card = monitorsCardFromResult({ crons: [{ id: "cron-1", cronExpression: "*/5 * * * *" }] });

		expect(card.status).toBe("populated");
		expect(card.lines).toHaveLength(1);
		expect(card.lines[0]).toContain("*/5 * * * *");
	});
});
