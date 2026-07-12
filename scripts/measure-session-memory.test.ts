import { describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../packages/coding-agent/src/session/session-manager";
import { generateSessionStorageFixture } from "./generate-session-storage-fixtures";
import { evaluateSessionMemoryGates, gateStatus, isProbativeMetadataMeasurement, percentile, runChild, summarizeMeasurements } from "./measure-session-memory";


const MEBIBYTE = 1024 * 1024;

describe("session memory measurement", () => {
	it("summarizes isolated samples using p50 and p95", () => {
		const summary = summarizeMeasurements([
			{ elapsedMs: 4, baselineRssBytes: 4, rssBytes: 40, metadataBytes: 4, entryCount: 1 },
			{ elapsedMs: 1, baselineRssBytes: 1, rssBytes: 10, metadataBytes: 1, entryCount: 1 },
			{ elapsedMs: 3, baselineRssBytes: 3, rssBytes: 30, metadataBytes: 3, entryCount: 1 },
			{ elapsedMs: 2, baselineRssBytes: 2, rssBytes: 20, metadataBytes: 2, entryCount: 1 },
		]);
		expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
		expect(summary.elapsedMs).toEqual({ p50: 2, p95: 4 });
		expect(summary.baselineRssBytes).toEqual({ p50: 2, p95: 4 });
		expect(summary.rssBytes).toEqual({ p50: 20, p95: 40 });
		expect(summary.metadataBytes).toEqual({ p50: 2, p95: 4, max: 4 });
	});

	it("evaluates all RSS, resume, switch, and metadata budgets", () => {
		const gates = evaluateSessionMemoryGates({
			baselineResumeRssBytes: 100 * MEBIBYTE,
			v2ResumeRssBytes: 135 * MEBIBYTE,
			baselineResumeP95Ms: 100,
			v2ResumeP95Ms: 110,
			baselineSwitchP95Ms: 400,
			v2SwitchP95Ms: 125,
			metadataRetainedBytes: 32 * MEBIBYTE,
		});
		expect(gates).toEqual([
			{ name: "resume-rss-delta", actual: 35 * MEBIBYTE, limit: 35 * MEBIBYTE, pass: true },
			{ name: "resume-p95", actual: 110, limit: 110.00000000000001, pass: true },
			{ name: "switch-p95-v2-resume", actual: 125, limit: 137.5, pass: true },
			{ name: "switch-p95-baseline", actual: 125, limit: 180, pass: true },
			{ name: "metadata-retained", actual: 32 * MEBIBYTE, limit: 32 * MEBIBYTE, pass: true },
			{ name: "metadata-probative", actual: 32 * MEBIBYTE, limit: Number.POSITIVE_INFINITY, pass: true },

		]);
		expect(gateStatus(gates)).toBe("passed");
	});

	it("makes --check fail whenever an individual budget is exceeded", () => {
		const gates = evaluateSessionMemoryGates({
			baselineResumeRssBytes: 100,
			v2ResumeRssBytes: 136,
			baselineResumeP95Ms: 100,
			v2ResumeP95Ms: 111,
			baselineSwitchP95Ms: 100,
			v2SwitchP95Ms: 250,
			metadataRetainedBytes: 32 * MEBIBYTE + 1,
		});
		expect(gates.slice(0, 5).every(gate => !gate.pass)).toBe(true);
		expect(gateStatus(gates)).toBe("failed");
	});

	it("rejects a zero metadata measurement as non-probative", () => {

		expect(isProbativeMetadataMeasurement(0)).toBeFalse();
		expect(evaluateSessionMemoryGates({
			baselineResumeRssBytes: 100,
			v2ResumeRssBytes: 100,
			baselineResumeP95Ms: 100,
			v2ResumeP95Ms: 100,
			baselineSwitchP95Ms: 100,
			v2SwitchP95Ms: 40,
			metadataRetainedBytes: 0,
		}).at(-1)).toMatchObject({ name: "metadata-probative", pass: false });
	});

	it("records nonzero pre-open metadata for the 10 MiB v2 corpus", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-memory-test-"));
		try {
			const fixture = await generateSessionStorageFixture({ outputDir: root, journalBytes: 10 * MEBIBYTE, name: "session" });
			const manager = await SessionManager.open(fixture.journalPath);
			await manager.setSessionName("session-memory-v2");
			await manager.close();
			const measurement = await runChild("resume", fixture.journalPath);
			expect(measurement.metadataBytes).toBeGreaterThan(0);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
