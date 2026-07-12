import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { aggregateStatus, evaluateBudgets, footprintStatus, npmPackageBytesForTarget, parseRss, percentile95, TARGET_IDS } from "./measure-arch-review-footprint";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("arch review footprint measurement", () => {
	it("uses all five release targets and computes p95 from measured samples", () => {
		expect(TARGET_IDS).toEqual(["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win32-x64"]);
		expect(percentile95([5, 1, 4, 2, 3])).toBe(5);
	});

	it("parses portable macOS and Linux RSS output", () => {
		expect(parseRss("12345  maximum resident set size", "darwin")).toBe(12345);
		expect(parseRss("Maximum resident set size (kbytes): 123", "linux")).toBe(123 * 1024);
	});

	it("gates compressed and npm bytes and keeps missing inputs pending", () => {
		const gates = evaluateBudgets({
			monolithAddonBytes: 100, monolithCompressedBytes: 50, coreAddonBytes: 60,
			fullAddonBytes: 110, fullCompressedBytes: 56, npmPackageBytes: 111,
			baselineNpmPackageBytes: 100, baselineRssBytes: 100, coreRssBytes: 85,
			baselineWallP95Ms: 100, coreWallP95Ms: 105,
		});
		expect(gates).toEqual([
			{ name: "core-addon", actual: 60, limit: 60, pass: true },
			{ name: "full-addons", actual: 110, limit: 110.00000000000001, pass: true },
			{ name: "full-addons-compressed", actual: 56, limit: 55.00000000000001, pass: false },
			{ name: "npm-package", actual: 111, limit: 110.00000000000001, pass: false },
			{ name: "core-binary", status: "pending-input" },
			{ name: "core-help-rss", actual: 85, limit: 85, pass: true },
			{ name: "help-wall-p95", actual: 105, limit: 105, pass: true },
		]);
	});

	it("does not block non-reference targets on intentionally unavailable runtime samples", () => {
		expect(footprintStatus([
			{ name: "core-addon", actual: 1, limit: 2, pass: true },
			{ name: "core-help-rss", status: "pending-runtime" },
		])).toBe("passed");
		expect(footprintStatus([{ name: "npm-package", status: "pending-input" }])).toBe("pending");
	});

	it("aggregates failed before pending and passes only all five targets", () => {
		expect(aggregateStatus([{ target: "darwin-arm64", status: "passed" }])).toBe("pending");
		expect(aggregateStatus([{ target: "darwin-arm64", status: "failed" }])).toBe("failed");
		expect(aggregateStatus(TARGET_IDS.map(target => ({ target, status: "passed" })))).toBe("passed");
	});

	it("ships the frozen npm package baseline used by default", async () => {
		const baseline = await Bun.file(new URL("./footprint-npm-baseline.json", import.meta.url)).json() as {
			npmPackageBytes: number;
			_comment: string;
		};
		expect(baseline.npmPackageBytes).toBe(46_808_100);
		expect(baseline._comment).toContain("Update only after measuring");
	});

	it("counts only manifest-approved native artifacts in npm package bytes", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-footprint-test-"));
		const nativeDir = path.join(tempDir, "packages/natives/native");
		const platformDir = path.join(tempDir, "packages/natives-linux-x64");
		await fs.mkdir(nativeDir, { recursive: true });
		await fs.mkdir(platformDir, { recursive: true });
		await fs.writeFile(path.join(tempDir, "packages/natives/package.json"), "stable");
		await fs.writeFile(path.join(platformDir, "package.json"), "platform");
		await fs.writeFile(path.join(nativeDir, "pi_natives.linux-x64-baseline.node"), "approved");

		const before = await npmPackageBytesForTarget(tempDir, "linux-x64");
		await fs.writeFile(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), "build-only-variant");
		const after = await npmPackageBytesForTarget(tempDir, "linux-x64");

		expect(after).toBe(before);
		expect(after).toBe("stable".length + "platform".length + "approved".length);
	});
});
