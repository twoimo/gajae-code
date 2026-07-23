import { describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { computeMemoryGuardDomain } from "../../src/runtime/memory-domain";
import {
	chooseMemoryGuardAction,
	MemoryGuardHost,
	resolveMemoryGuardPolicy,
	revalidateMemoryGuardAction,
} from "../../src/runtime/memory-guard";

describe("resolveMemoryGuardPolicy", () => {
	it("stays disabled by default and converts MB values to bytes", () => {
		const policy = resolveMemoryGuardPolicy(Settings.isolated({}));
		expect(policy).toMatchObject({
			enabled: false,
			checkIntervalMs: 30_000,
			gcThresholdRatio: 0.7,
			restartThresholdRatio: 0.85,
			restartThresholdWindowMs: 90_000,
			cooldownMs: 600_000,
			parentReserveBytes: 1024 * 1024 * 1024,
			policyLimitBytes: null,
		});
	});

	it("rounds fractional megabyte settings to integer bytes", () => {
		const policy = resolveMemoryGuardPolicy(
			Settings.isolated({
				"memoryGuard.policyLimitMb": 100.1,
				"memoryGuard.parentReserveMb": 10.25,
			}),
		);
		expect(policy.policyLimitBytes).toBe(Math.round(100.1 * 1024 * 1024));
		expect(policy.parentReserveBytes).toBe(Math.round(10.25 * 1024 * 1024));
	});
});

describe("memory guard arbitration", () => {
	it("does not let an unsupported host candidate mask an executable worker candidate", () => {
		const decision = chooseMemoryGuardAction({
			domain: computeMemoryGuardDomain({
				effectiveLimitBytes: 100,
				totalUsageBytes: 80,
				parentBytes: 10,
				parentReserveBytes: 20,
				workers: [
					{ workerId: "worker-1", bytes: 55 },
					{ workerId: "worker-2", bytes: 15 },
				],
			}),
			hostSupported: false,
			workerSupported: workerId => workerId === "worker-1",
		});
		expect(decision).toEqual({ kind: "execute", target: { kind: "worker", workerId: "worker-1", excessBytes: 15 } });
	});

	it("revalidates out when the selected target is no longer over allowance", () => {
		const initial = chooseMemoryGuardAction({
			domain: computeMemoryGuardDomain({
				effectiveLimitBytes: 100,
				totalUsageBytes: 80,
				parentBytes: 10,
				parentReserveBytes: 20,
				workers: [
					{ workerId: "worker-1", bytes: 55 },
					{ workerId: "worker-2", bytes: 15 },
				],
			}),
			hostSupported: false,
			workerSupported: () => true,
		});
		if (initial.kind !== "execute") throw new Error("expected an initial executable target");
		const revalidated = chooseMemoryGuardAction({
			domain: computeMemoryGuardDomain({
				effectiveLimitBytes: 100,
				totalUsageBytes: 80,
				parentBytes: 10,
				parentReserveBytes: 20,
				workers: [
					{ workerId: "worker-1", bytes: 40 },
					{ workerId: "worker-2", bytes: 30 },
				],
			}),
			hostSupported: false,
			workerSupported: () => true,
		});
		expect(revalidateMemoryGuardAction(initial, revalidated)).toEqual({
			kind: "revalidated_out",
			reason: "memory_guard_action_revalidated_out",
		});
	});
});

describe("MemoryGuardHost", () => {
	it("serializes action execution so only one run is in flight", async () => {
		const gate = Promise.withResolvers<void>();
		const run = vi.fn(async () => {
			await gate.promise;
		});
		const host = new MemoryGuardHost({ run });
		const unregister = host.register({ ownerId: "worker-1", intervalMs: 100 });
		const first = host.runTick();
		await Promise.resolve();
		await host.runTick();
		expect(run).toHaveBeenCalledTimes(1);
		gate.resolve();
		await first;
		unregister();
	});
});
