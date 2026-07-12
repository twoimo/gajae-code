import { describe, expect, it } from "bun:test";
import { compareExports, validateSymbolCompatibility, type SymbolMeasurement } from "./measure-native-symbols";

function report(overrides: Partial<SymbolMeasurement> = {}): SymbolMeasurement {
	return {
		target: "darwin-arm64", profile: "dist", sourceSha: "a".repeat(40), unstrippedBytes: 100, strippedBytes: 94,
		reductionPercent: 6, exports: ["napi_register_module_v1"], unwind: "passed", debugSidecarBacktrace: "passed",
		crashId: "b".repeat(64), toolVersions: { bun: "1" }, status: "passed", ...overrides,
	};
}

describe("native symbol compatibility", () => {
	it("requires baseline and candidate N-API export sets to be identical", () => {
		const baseline = report({ exports: ["napi_alpha", "napi_register_module_v1"] });
		const candidate = report({ exports: ["napi_register_module_v1", "napi_alpha"] });
		expect(compareExports(baseline.exports, candidate.exports)).toEqual([]);
	});

	it("rejects additions and removals, even when the artifact is smaller", () => {
		const baseline = report({ exports: ["napi_alpha", "napi_register_module_v1"] });
		const candidate = report({ exports: ["napi_beta", "napi_register_module_v1"], reductionPercent: 20 });
		expect(compareExports(baseline.exports, candidate.exports)).toEqual(["missing export: napi_alpha", "unexpected export: napi_beta"]);
	});

	it("rejects source, target, profile, and export mismatches through the compatibility validator", () => {
		const baseline = report({ exports: ["napi_alpha", "napi_register_module_v1"] });
		const candidate = report({
			sourceSha: "c".repeat(40), target: "linux-x64", profile: "ci", crashId: "d".repeat(64),
			exports: ["napi_beta", "napi_register_module_v1"],
		});
		expect(validateSymbolCompatibility(baseline, candidate)).toEqual([
			"source SHA mismatch", "target mismatch", "candidate profile mismatch: expected dist-symbols, got ci", "crash/build-ID mismatch",
			"missing export: napi_alpha", "unexpected export: napi_beta",
		]);
	});
});
