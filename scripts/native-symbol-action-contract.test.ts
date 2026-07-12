import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const actionPath = path.join(import.meta.dir, "../.github/actions/build-native/action.yml");
const actionSource = await Bun.file(actionPath).text();

describe("native symbol CI action contract", () => {
	test("keeps the dist payload canonical while staging dist-symbols evidence separately", () => {
		const distBuild = actionSource.indexOf("PI_NATIVE_PROFILE=dist bun run ci:build:native");
		const candidateBuild = actionSource.indexOf("PI_NATIVE_PROFILE=dist-symbols bun run ci:build:native");
		expect(distBuild).toBeGreaterThanOrEqual(0);
		expect(candidateBuild).toBeGreaterThan(distBuild);
		expect(actionSource).toContain("PI_NATIVE_OUTPUT_DIR: artifacts/native-symbol-candidates");
		expect(actionSource).toContain("--baseline-addon packages/natives/native/pi_natives.");
		expect(actionSource).toContain("--candidate-addon artifacts/native-symbol-candidates/pi_natives.");
		expect(actionSource).toContain("path: packages/natives/native/pi_natives*.${{ inputs.platform }}-${{ inputs.arch }}*.node");
		expect(actionSource).not.toContain("PI_NATIVE_OUTPUT_DIR: packages/natives/native");
	});

	test("uploads the completed immutable report even when a valid candidate is rejected", () => {
		const reportUpload = actionSource.indexOf("- name: Upload immutable native symbol report");
		const nextStep = actionSource.indexOf("- name: Upload native footprint", reportUpload);
		const reportStep = actionSource.slice(reportUpload, nextStep);
		expect(reportStep).toContain("if: always()");
		expect(reportStep).toContain("path: artifacts/native-symbols-${{ inputs.platform }}-${{ inputs.arch }}-${{ github.sha }}.json");
		expect(reportStep).toContain("name: native-symbols-${{ inputs.platform }}-${{ inputs.arch }}-pdist-symbols-s${{ github.sha }}");
	});
});
