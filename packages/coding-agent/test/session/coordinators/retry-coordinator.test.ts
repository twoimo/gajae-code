import { describe, expect, it } from "bun:test";
import { RetryCoordinator } from "../../../src/session/coordinators/retry-coordinator";

const settings = { unbounded: false, maxTotalAttempts: 2, maxElapsedMs: 60_000, maxCostUsd: 1 };

describe("RetryCoordinator", () => {
	it("retains a turn identity while reconciling authoritative attempts", () => {
		const coordinator = new RetryCoordinator();
		coordinator.beginTurn();
		const before = coordinator.snapshot(settings, false);
		coordinator.consume("provider-http", settings, false, () => coordinator.diagnostics(settings, 0, undefined));
		coordinator.reconcile({ ...before, remainingAttempts: 0 }, settings, false);
		expect(coordinator.snapshot(settings, false).turnBudgetId).toBe(before.turnBudgetId);
		expect(coordinator.diagnostics(settings, 0, undefined).totalPhysicalAttempts).toBe(2);
	});
});
