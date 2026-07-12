import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	canonicalVisibleSessionLifecycleReport,
	parseVisibleSessionLifecycleSmokeArgv,
	runVisibleSessionLifecycleSmoke,
	validateVisibleSessionLifecycleReport,
	writeVisibleSessionLifecycleReport,
	type VisibleSessionLifecycleReport,
	type VisibleSessionLifecycleSmokeEvidence,
} from "./visible-session-lifecycle-smoke";

const sourceHead = "a".repeat(40);
const binarySha256 = "b".repeat(64);

function successfulEvidence(compiled = false): VisibleSessionLifecycleSmokeEvidence {
	return {
		sourceHead,
		binarySha256: compiled ? binarySha256 : null,
		ownerPid: 101,
		monitorPid: 102,
		terminalKind: "final",
		finalCount: 1,
		vanishedCount: 0,
		tokenPresentAfter: false,
		manifestPresentAfter: false,
		endpointReachableAfter: false,
		survivingPids: [],
		failures: [],
	};
}

function successfulReport(): VisibleSessionLifecycleReport {
	return {
		schemaVersion: 1,
		scenario: "source",
		...successfulEvidence(),
		durationMs: 12,
	};
}

describe("visible-session lifecycle smoke argv", () => {
	test("requires exactly one explicit scenario and report path", () => {
		const parsed = parseVisibleSessionLifecycleSmokeArgv(["--report", "./receipt.json", "--scenario", "hard-kill"]);
		expect(parsed).toEqual({ scenario: "hard-kill", reportPath: path.resolve("./receipt.json") });
		for (const argv of [
			["--scenario", "source", "--report", "receipt.json"],
			["--scenario", "unknown", "--report", "./receipt.json"],
			["--scenario", "source", "--scenario", "compiled"],
		])
			expect(() => parseVisibleSessionLifecycleSmokeArgv(argv)).toThrow("malformed");
		expect(() =>
			parseVisibleSessionLifecycleSmokeArgv(["--scenario", "source", "--report", "./receipt.json", "extra"]),
		).toThrow("Expected exactly");
	});
});

describe("visible-session lifecycle report", () => {
	test("canonicalizes only the exact secret-free public schema", async () => {
		const report = successfulReport();
		const canonical = canonicalVisibleSessionLifecycleReport(report);
		expect(JSON.parse(canonical)).toEqual(report);
		expect(Object.keys(JSON.parse(canonical))).toEqual([
			"schemaVersion",
			"scenario",
			"sourceHead",
			"binarySha256",
			"ownerPid",
			"monitorPid",
			"terminalKind",
			"finalCount",
			"vanishedCount",
			"tokenPresentAfter",
			"manifestPresentAfter",
			"endpointReachableAfter",
			"survivingPids",
			"durationMs",
			"failures",
		]);
		expect(() => validateVisibleSessionLifecycleReport({ ...report, unexpected: true })).toThrow("schema");
		expect(() => validateVisibleSessionLifecycleReport({ ...report, failures: ["control-token-value"] })).toThrow("schema");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-report-test-"));
		try {
			const file = path.join(root, "report.json");
			await writeVisibleSessionLifecycleReport(file, report);
			expect(await fs.readFile(file, "utf8")).toBe(canonical);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("uses a hermetic compiled success seam and binds its supplied digest", async () => {
		let called = false;
		const report = await runVisibleSessionLifecycleSmoke(
			{ scenario: "compiled" },
			{
				execute: async scenario => {
					called = true;
					expect(scenario).toBe("compiled");
					return successfulEvidence(true);
				},
			},
		);
		expect(called).toBe(true);
		expect(report.failures).toEqual([]);
		expect(report.binarySha256).toBe(binarySha256);
		expect(report.sourceHead).toBe(sourceHead);
	});

	test("turns hermetic cleanup failures into static, token-free failure codes", async () => {
		const report = await runVisibleSessionLifecycleSmoke(
			{ scenario: "hard-kill" },
			{
				execute: async () => ({
					...successfulEvidence(),
					terminalKind: "final",
					tokenPresentAfter: true,
					manifestPresentAfter: true,
					endpointReachableAfter: true,
					survivingPids: [101],
					failures: ["internal_failure"],
				}),
			},
		);
		expect(report.failures).toEqual([
			"internal_failure",
			"unexpected_terminal_kind",
			"private_token_survived",
			"private_manifest_survived",
			"control_endpoint_survived",
			"role_process_survived",
		]);
		expect(canonicalVisibleSessionLifecycleReport(report)).not.toContain("control-token-value");
	});
});
