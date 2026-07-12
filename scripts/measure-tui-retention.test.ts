import { describe, expect, it } from "bun:test";
import { TUI, type Terminal } from "@gajae-code/tui";
import { baselineBootstrapNotice, baselineCheckMode, checkedBaseline, evaluateTuiRetentionGates, fixtureHash, percentile95, retentionCheckExitCode, tuiRetentionStatus } from "./measure-tui-retention";


const MEBIBYTE = 1024 * 1024;
const passingInput = {
	documentBytes: MEBIBYTE,
	undoBytes: 2 * MEBIBYTE + 16 * MEBIBYTE,
	editP95Ms: 20,
	frameP95Ms: 16,
	frameAllocationBytes: 25,
	fullTranscriptAllocationBaselineBytes: 100,
	frameGrowthPercent: 10,
	markdownRegisteredBytes: 32 * MEBIBYTE,
	uniqueImageBytes: 100,
	duplicateImageOwnershipBytes: 5,
	terminalProtocolCacheBytes: 32 * MEBIBYTE,
};

describe("TUI retention measurement", () => {
	it("uses the upper nearest-rank p95", () => {
		expect(percentile95([1, 5, 2, 4, 3])).toBe(5);
	});

	it("passes every named budget exactly at its limit", () => {
		const gates = evaluateTuiRetentionGates(passingInput);
		expect(gates.map(gate => gate.name)).toEqual([
			"editor undo", "edit p95", "frame p95", "allocs/frame", "10K->100K off-screen frame-time growth",
			"markdown registered", "duplicate image ownership", "terminal protocol cache",
		]);
		expect(gates.every(gate => gate.pass)).toBe(true);
		expect(tuiRetentionStatus(gates)).toBe("passed");
	});

	it("fails each budget one unit over its limit", () => {
		const fields = [
			"undoBytes", "editP95Ms", "frameP95Ms", "frameAllocationBytes", "frameGrowthPercent",
			"markdownRegisteredBytes", "duplicateImageOwnershipBytes", "terminalProtocolCacheBytes",
		] as const;
		for (const field of fields) {
			const input = { ...passingInput, [field]: passingInput[field] + 1 };
			const gates = evaluateTuiRetentionGates(input);
			expect(gates.find(gate => !gate.pass)?.name).toBe(gates[fields.indexOf(field)]!.name);
			expect(tuiRetentionStatus(gates)).toBe("failed");
		}
	});

	it("gates a present matching baseline", () => {
		const file = {
			schemaVersion: 3,
			baselines: {
				"darwin-arm64:full": {
					fixtureHash: fixtureHash(),
					fullTranscriptAllocationBaselineBytes: 1,
					reviewNote: "platform-specific baseline",
				},
			},
		};
		expect(baselineCheckMode(file, undefined, "darwin", "arm64").baseline).toEqual(file.baselines["darwin-arm64:full"]);
		expect(retentionCheckExitCode(true, "failed", false)).toBe(1);
	});

	it("bootstraps a missing platform baseline without failing --check", () => {
		const file = { schemaVersion: 3, baselines: {} };
		const result = baselineCheckMode(file, undefined, "linux", "x64");
		expect(result.baseline).toBeUndefined();
		expect(retentionCheckExitCode(true, "failed", true)).toBe(0);
		expect(baselineBootstrapNotice("linux", "x64")).toBe(
			"baseline-bootstrap: no checked baseline for linux-x64, uploading measured values for review",
		);
	});

	it("fails closed for a mismatched baseline", () => {
		const file = {
			schemaVersion: 3,
			baselines: {
				"linux-x64:full": {
					fixtureHash: "wrong-fixture-hash",
					fullTranscriptAllocationBaselineBytes: 1,
					reviewNote: "platform-specific baseline",
				},
			},
		};
		expect(() => baselineCheckMode(file, undefined, "linux", "x64")).toThrow("--check fails closed");
		expect(() => baselineCheckMode({ ...file, schemaVersion: 2 }, undefined, "linux", "x64")).toThrow("Invalid tui retention baseline schema; --check fails closed.");
		expect(() => checkedBaseline(file, undefined, "darwin", "arm64")).toThrow("darwin-arm64:full");
	});
});

	it("audits deterministic row-array and metadata allocation accounting with reset", () => {
		const tui = new TUI({} as Terminal);
		tui.beginFrameAllocationMeasurement();
		tui.recordFrameAllocationRowArray(["abc", "de"]);
		expect(tui.getLastFrameAllocationBytes()).toBe(24 + 2 * 8 + 5);
		tui.recordFrameAllocationObjects(2);
		expect(tui.getLastFrameAllocationBytes()).toBe(24 + 2 * 8 + 5 + 2 * 24);
		tui.beginFrameAllocationMeasurement();
		expect(tui.getLastFrameAllocationBytes()).toBe(0);
	});
