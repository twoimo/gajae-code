import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch } from "../src/edit/modes/patch";
import {
	__clearNativeFuzzyBindingsForTest,
	__findClosestSequenceMatchTypeScriptOracle,
	__setNativeFuzzyBindingsForTest,
} from "../src/edit/testing/native-edit-test-hooks";

let tempDir: string | undefined;

afterEach(async () => {
	__clearNativeFuzzyBindingsForTest();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("patch native no-match diagnostics", () => {
	test("does not use the TypeScript closest-sequence scan on the production error path", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-patch-error-test-"));
		await fs.writeFile(path.join(tempDir, "sample.txt"), "alpha beta gamma\nsecond line\n");
		__setNativeFuzzyBindingsForTest({
			h01FindBestFuzzyMatch() {
				return { aboveThresholdCount: 0, secondBestScore: 0 };
			},
			h02ScoreSequenceFuzzy() {
				return { confidence: 0.5, matchCount: 0, matchIndices: [], secondBestScore: 0.4 };
			},
		});

		const oracle = __findClosestSequenceMatchTypeScriptOracle(
			["alpha beta gamma", "second line", ""],
			["second lime"],
		);
		expect(oracle.index).toBe(1);
		expect(oracle.confidence).toBeGreaterThan(0);

		let error: Error | undefined;
		try {
			await applyPatch(
				{ path: "sample.txt", op: "update", diff: "@@\n alpha beta gamma\n-second lime\n+replacement" },
				{ cwd: tempDir },
			);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error).toBeDefined();

		if (!error) throw new Error("Expected applyPatch to fail");
		expect(error.message).toContain("Native fuzzy matching did not find expected lines in sample.txt");
		expect(error.message).not.toContain("Closest match");
		expect(error.message).not.toContain("similar");
	});
});
