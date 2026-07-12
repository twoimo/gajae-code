import { describe, expect, test } from "bun:test";
import {
	DYNAMIC_IMPORT_RUNTIME_CASES,
	parseDynamicImportRuntimeArgs,
	runDynamicImportRuntimeCase,
} from "./verify-dynamic-import-runtime";
import { assertBrowserWorkerProbeReachedConnect } from "../packages/coding-agent/src/cli";


describe("dynamic-import runtime verifier", () => {
	test("exports the reusable source/compiled smoke-case list", () => {
		expect(DYNAMIC_IMPORT_RUNTIME_CASES).toEqual(["help", "session", "web-search", "browser-worker", "manifest"]);
	});

	test("parses source/compiled mode, binary, and selected cases", () => {
		expect(parseDynamicImportRuntimeArgs([])).toEqual({
			mode: "source",
			binary: undefined,
			cases: [...DYNAMIC_IMPORT_RUNTIME_CASES],
		});
		expect(
			parseDynamicImportRuntimeArgs([
				"--mode",
				"compiled",
				"--binary",
				"dist/gjc",
				"--cases",
				"help,browser-worker",
			]),
		).toEqual({ mode: "compiled", binary: "dist/gjc", cases: ["help", "browser-worker"] });
		expect(() => parseDynamicImportRuntimeArgs(["--cases", "unknown"])).toThrow("Invalid --cases: unknown");
	});

	test("compiled mode fails clearly without a binary path", async () => {
		await expect(runDynamicImportRuntimeCase("help", { mode: "compiled" })).rejects.toThrow(
			"Compiled dynamic-import runtime verification requires --binary or GJC_DYNAMIC_IMPORT_BINARY",
		);
	});

	test("loads a real lazy command module in source mode", async () => {
		await runDynamicImportRuntimeCase("help");
	});

	test("initializes the browser worker far enough to load puppeteer", async () => {
		await runDynamicImportRuntimeCase("browser-worker");
	});

	test("rejects import-stage and untagged browser worker failures", () => {
		const error = { name: "Error", message: "missing puppeteer-core", isToolError: false, isAbort: false };
		expect(() => assertBrowserWorkerProbeReachedConnect({ type: "init-failed", stage: "import", error })).toThrow(
			"browser-worker probe failed to import puppeteer-core: missing puppeteer-core",
		);
		expect(() => assertBrowserWorkerProbeReachedConnect({ type: "init-failed", error })).toThrow(
			'browser-worker probe expected init-failed stage "connect"',
		);
		expect(() => assertBrowserWorkerProbeReachedConnect({ type: "init-failed", stage: "connect", error })).not.toThrow();
	});

	test("probes every manifest target", async () => {
		await runDynamicImportRuntimeCase("manifest");
	});
});
