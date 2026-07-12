import { describe, expect, it } from "bun:test";
import {
	RETAINED_MEMORY_MAX_BUCKETS_PER_POOL,
	RETAINED_MEMORY_MAX_POOLS,
	RETAINED_MEMORY_MAX_REGISTRATIONS,
	RetainedMemoryRegistry,
} from "../src/retained-memory";

const memoryUsage = (): NodeJS.MemoryUsage => ({
	rss: 100,
	heapTotal: 200,
	heapUsed: 80,
	external: 30,
	arrayBuffers: 20,
});

describe("RetainedMemoryRegistry", () => {
	it("samples process gauges, registrations, and owner-reported shared pools", () => {
		const registry = new RetainedMemoryRegistry({ now: () => 123, memoryUsage });
		registry.register({ id: "agent-loop", sampleBytes: () => 40 });
		registry.registerPool({
			id: "session-history",
			bucketNames: ["index", "messages"],
			sampleBytes: () => 60,
			sampleBuckets: () => ({ index: 10, messages: 50, ignored: 999 }),
		});

		expect(registry.sample()).toEqual({
			sampledAt: 123,
			gauges: { rssBytes: 100, heapUsedBytes: 80, externalBytes: 30, nativeBytes: 20 },
			registrations: [{ id: "agent-loop", bytes: 40 }],
			pools: [{ id: "session-history", bytes: 60, buckets: { index: 10, messages: 50 } }],
			totalRetainedBytes: 100,
		});
	});

	it("enforces stable IDs and all cardinality bounds", () => {
		const registrations = new RetainedMemoryRegistry({ memoryUsage });
		for (let i = 0; i < RETAINED_MEMORY_MAX_REGISTRATIONS; i++) {
			registrations.register({ id: `registration-${i}`, sampleBytes: () => 0 });
		}
		expect(() => registrations.register({ id: "overflow", sampleBytes: () => 0 })).toThrow("registration limit");

		const pools = new RetainedMemoryRegistry({ memoryUsage });
		for (let i = 0; i < RETAINED_MEMORY_MAX_POOLS; i++) {
			pools.registerPool({ id: `pool-${i}`, sampleBytes: () => 0 });
		}
		expect(() => pools.registerPool({ id: "overflow", sampleBytes: () => 0 })).toThrow("pool limit");
		expect(() =>
			new RetainedMemoryRegistry({ memoryUsage }).registerPool({
				id: "too-many-buckets",
				bucketNames: Array.from({ length: RETAINED_MEMORY_MAX_BUCKETS_PER_POOL + 1 }, (_, i) => `bucket-${i}`),
				sampleBytes: () => 0,
			}),
		).toThrow("bucket limit");

		const duplicate = new RetainedMemoryRegistry({ memoryUsage });
		duplicate.registerPool({ id: "shared", sampleBytes: () => 0 });
		expect(() => duplicate.registerPool({ id: "shared", sampleBytes: () => 0 })).toThrow("already registered");
		expect(() => duplicate.register({ id: "shared", sampleBytes: () => 0 })).toThrow("already registered");
	});

	it("disposes idempotently and permits stable ID reuse", () => {
		const registry = new RetainedMemoryRegistry({ memoryUsage });
		const registration = registry.register({ id: "cache", sampleBytes: () => 12 });
		registration.dispose();
		registration.dispose();
		expect(registry.sample().registrations).toEqual([]);
		expect(registry.register({ id: "cache", sampleBytes: () => 7 }).id).toBe("cache");
	});

	it("runs targeted and aggregate eviction callbacks", async () => {
		const calls: string[] = [];
		const registry = new RetainedMemoryRegistry({ memoryUsage });
		registry.register({
			id: "plain",
			sampleBytes: () => 1,
			onEvict: reason => {
				calls.push(`plain:${reason}`);
			},
		});
		registry.registerPool({
			id: "pool",
			sampleBytes: () => 2,
			onEvict: reason => {
				calls.push(`pool:${reason}`);
			},
		});
		expect(await registry.evict("missing", "pressure")).toBe(false);
		expect(await registry.evict("pool", "pressure")).toBe(true);
		await registry.evictAll("shutdown");
		expect(calls).toEqual(["pool:pressure", "plain:shutdown", "pool:shutdown"]);
	});

	it("keeps snapshot cardinality and sampling cost independent of retained object count", () => {
		const counts = [1_000, 100_000, 1_000_000];
		const measurements: Array<{
			count: number;
			snapshotBytes: number;
			snapshotEntries: number;
			medianNs: number;
			allocationBytes: number;
		}> = [];
		let retained: Uint32Array = new Uint32Array();
		const registry = new RetainedMemoryRegistry({ memoryUsage });
		registry.registerPool({
			id: "objects",
			bucketNames: ["values"],
			sampleBytes: () => retained.byteLength,
			sampleBuckets: () => ({ values: retained.byteLength }),
		});

		for (const count of counts) {
			retained = new Uint32Array(count);
			for (let warmup = 0; warmup < 2_000; warmup++) registry.sample();
			Bun.gc(true);
			const before = process.memoryUsage().heapUsed;
			const snapshots = Array.from({ length: 2_000 }, () => registry.sample());
			const after = process.memoryUsage().heapUsed;
			const timings: number[] = [];
			for (let run = 0; run < 31; run++) {
				const started = Bun.nanoseconds();
				for (let sample = 0; sample < 2_000; sample++) registry.sample();
				timings.push((Bun.nanoseconds() - started) / 2_000);
			}
			timings.sort((a, b) => a - b);
			measurements.push({
				count,
				snapshotBytes: JSON.stringify(snapshots[0]).length,
				snapshotEntries: (snapshots[0]?.registrations.length ?? 0) + (snapshots[0]?.pools.length ?? 0),
				medianNs: timings[Math.floor(timings.length / 2)] ?? 0,
				allocationBytes: Math.max(0, after - before),
			});
		}

		const baseline = measurements[0] as (typeof measurements)[number];
		const largest = measurements[2] as (typeof measurements)[number];
		expect(measurements.map(value => value.snapshotEntries)).toEqual([1, 1, 1]);
		expect(largest.snapshotBytes).toBeLessThanOrEqual(baseline.snapshotBytes * 1.25);
		expect(largest.allocationBytes).toBeLessThanOrEqual(Math.max(1, baseline.allocationBytes) * 1.25);
		expect(largest.medianNs).toBeLessThanOrEqual(baseline.medianNs * 1.2);
		process.stdout.write(`retained-memory-stress ${JSON.stringify(measurements)}\n`);
	});
});
