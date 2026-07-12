import { describe, expect, it } from "bun:test";
import { evaluateRetainedRssGate, parseDuration, retainedRssStatus, theilSenSlopeBytesPerHour } from "./measure-retained-rss-slope";

const MEBIBYTE = 1024 * 1024;

describe("retained RSS slope measurement", () => {
	it("uses a robust median pairwise slope for timestamped samples", () => {
		const hour = 60 * 60 * 1000;
		const slope = theilSenSlopeBytesPerHour([
			{ timestampMs: 0, rssBytes: 100 * MEBIBYTE },
			{ timestampMs: hour, rssBytes: 101 * MEBIBYTE },
			{ timestampMs: hour * 2, rssBytes: 102 * MEBIBYTE },
			{ timestampMs: hour * 3, rssBytes: 123 * MEBIBYTE },
			{ timestampMs: hour * 4, rssBytes: 104 * MEBIBYTE },
		]);
		expect(slope).toBeCloseTo(1 * MEBIBYTE, 6);
	});

	it("rejects invalid sample ordering and accepts duration units", () => {
		expect(() => theilSenSlopeBytesPerHour([
			{ timestampMs: 1, rssBytes: 1 },
			{ timestampMs: 1, rssBytes: 2 },
		])).toThrow("strictly increasing");
		expect(parseDuration("2.5s")).toBe(2500);
		expect(parseDuration("3m")).toBe(180_000);
		expect(parseDuration("1h")).toBe(3_600_000);
	});

	it("fails --check's gate above 2 MiB/hour", () => {
		const passing = evaluateRetainedRssGate(2 * MEBIBYTE);
		const failing = evaluateRetainedRssGate(2 * MEBIBYTE + 1);
		expect(passing).toEqual({ name: "retained-rss-slope", actual: 2 * MEBIBYTE, limit: 2 * MEBIBYTE, pass: true });
		expect(retainedRssStatus(passing)).toBe("passed");
		expect(failing.pass).toBe(false);
		expect(retainedRssStatus(failing)).toBe("failed");
	});
});
