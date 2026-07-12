import { describe, expect, it } from "bun:test";
import { aggregateSymbolMeasurements, compareExports, reductionPercent, TARGET_IDS, type SymbolMeasurement } from "./measure-native-symbols";

function measurement(target: string, status: SymbolMeasurement["status"] = "passed"): SymbolMeasurement {
	return { target, profile: "dist", sourceSha: "a".repeat(40), unstrippedBytes: 100, strippedBytes: 95, reductionPercent: 5, exports: ["napi_register_module_v1"], unwind: "passed", debugSidecarBacktrace: "passed", crashId: "a".repeat(64), toolVersions: { bun: "test" }, status };
}

describe("native symbol measurement", () => {
	it("uses every release target and fails closed until each has a passing report", () => {
		expect(TARGET_IDS).toEqual(["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "win32-x64"]);
		expect(aggregateSymbolMeasurements([measurement("darwin-arm64")])).toBe("deferred");
		expect(aggregateSymbolMeasurements([...TARGET_IDS.map(target => measurement(target)), measurement("linux-x64", "failed")])).toBe("failed");
		expect(aggregateSymbolMeasurements(TARGET_IDS.map(target => measurement(target)))).toBe("passed");
	});

	it("calculates shipped-artifact reduction without rounding away a regression", () => {
		expect(reductionPercent(100, 95)).toBe(5);
		expect(reductionPercent(100, 101)).toBe(-1);
	});

	it("reports every export-set difference", () => {
		expect(compareExports(["napi_a", "napi_b"], ["napi_b", "napi_c"])).toEqual(["missing export: napi_a", "unexpected export: napi_c"]);
	});
});
