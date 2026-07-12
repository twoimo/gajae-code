import { describe, expect, it } from "bun:test";
import { boundedTopK, fixtureChecksum, fullSortOracle, generateGlobFixture, measureGlobTopK } from "./measure-glob-top-k";

describe("glob top-K measurement", () => {
	it("has a checked deterministic one-million-path fixture", () => {
		const fixture = generateGlobFixture();
		expect(fixture).toHaveLength(1_000_000);
		expect(fixtureChecksum(fixture)).toBe("5707815b433fe759957716ae6beb71be2a6e7c3c82f808a6861ef81f5d48f9f5");
	});

	it("has exact ordered parity with the full-sort oracle for one million paths", () => {
		const fixture = generateGlobFixture();
		expect(boundedTopK(fixture, 100)).toEqual(fullSortOracle(fixture, 100));
	});

	it("handles ties, Unicode paths, zero K, and fewer-than-K fixtures", () => {
		const fixture = [
			{ path: "zeta.ts", mtime: 10 },
			{ path: "alpha.ts", mtime: 10 },
			{ path: "nested\\beta.ts", mtime: 11 },
			{ path: "über.ts", mtime: 10 },
		];
		expect(boundedTopK(fixture, 0)).toEqual([]);
		expect(boundedTopK(fixture, 10)).toEqual(fullSortOracle(fixture, 10));
		expect(boundedTopK(fixture, 3)).toEqual(fullSortOracle(fixture, 3));
	});

	it("uses isolated children and records high-water RSS measurement policy", async () => {
		const report = await measureGlobTopK(10_000, 100);
		expect(report.parity).toBe(true);
		expect(report.baseline.pid).not.toBe(report.candidate.pid);
		expect(report.samplePolicy).toEqual({
			warmupRuns: 1,
			measuredRuns: 3,
			cacheWarmup: "one algorithm-local selection per child; excluded from wall samples and included in child high-water RSS",
			isolation: "one Bun child process per algorithm",
			peakRss: "getrusage ru_maxrss high-water",
		});
		expect(report.baseline.peakRssBytes).toBeGreaterThan(0);
		expect(report.candidate.peakRssBytes).toBeGreaterThan(0);
	});
});
