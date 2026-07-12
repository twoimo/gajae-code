import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	scanDynamicImports,
	type DynamicImportException,
	validateDynamicImportPolicy,
} from "./check-dynamic-import-policy";

const baseException: DynamicImportException = {
	importer: "packages/coding-agent/src/example.ts",
	target: "./lazy",
	reason: "Keeps the example cold path out of startup.",
	smokeCase: "help",
	owner: "coding-agent",
	probe: "load",
};

describe("dynamic-import policy", () => {
	test("scans import expressions without mistaking type imports, strings, or comments for runtime imports", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dynamic-import-policy-"));
		try {
			await fs.mkdir(path.join(dir, "src"));
			await Bun.write(
				path.join(dir, "src/example.ts"),
				`type Value = import("./types").Value;\n// import("./comment")\nconst text = 'import("./string")';\nawait import("./lazy");\nawait import(target);\n`,
			);
			const found = await scanDynamicImports(dir, ["src"]);
			expect(found).toEqual([
				{ importer: "src/example.ts", target: "./lazy", line: 4 },
				{ importer: "src/example.ts", target: "expression:target", line: 5 },
			]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("rejects both unlisted imports and stale manifest entries", () => {
		const occurrence = { importer: baseException.importer, target: "./lazy", line: 1 };
		expect(validateDynamicImportPolicy([occurrence], [])).toEqual([
			`Unlisted dynamic import: ${baseException.importer}:1 -> ./lazy`,
		]);
		expect(validateDynamicImportPolicy([], [baseException])).toEqual([
			`Stale manifest entry: ${baseException.importer} -> ./lazy`,
		]);
		expect(validateDynamicImportPolicy([occurrence], [baseException])).toEqual([]);
	});

	test("enforces occurrence and manifest multiplicity for literal and expression targets", () => {
		const literal = { importer: baseException.importer, target: "./lazy", line: 1 };
		expect(validateDynamicImportPolicy([literal, { ...literal, line: 2 }], [baseException])).toContain(
			`Unlisted dynamic import: ${baseException.importer}:1 -> ./lazy`,
		);
		expect(validateDynamicImportPolicy([literal], [baseException, baseException])).toContain(
			`Stale manifest entry: ${baseException.importer} -> ./lazy`,
		);
		const expressionException = { ...baseException, target: "expression:loader()" };
		const expression = { importer: baseException.importer, target: "expression:loader()", line: 3 };
		expect(validateDynamicImportPolicy([expression, { ...expression, line: 4 }], [expressionException])).toContain(
			`Unlisted dynamic import: ${baseException.importer}:3 -> expression:loader()`,
		);
	});

	test("rejects unsupported probe kinds and invalid handshake labels", () => {
		expect(validateDynamicImportPolicy([], [{ ...baseException, probe: "unknown" as "load" }])).toContain(
			"Manifest entry 1 has invalid probe: unknown",
		);
		expect(validateDynamicImportPolicy([], [{ ...baseException, probe: "handshake" }])).toContain(
			"Manifest entry 1 handshake probe must use browser-worker smokeCase",
		);
	});

	test("allows duplicate occurrences to share only target-level handshake coverage", () => {
		const occurrence = { importer: baseException.importer, target: baseException.target, line: 1 };
		const handshake = { ...baseException, smokeCase: "browser-worker" as const, probe: "handshake" as const };
		expect(validateDynamicImportPolicy([occurrence, { ...occurrence, line: 2 }], [handshake, handshake])).toEqual([]);
		expect(validateDynamicImportPolicy([occurrence, { ...occurrence, line: 2 }], [handshake, baseException])).toContain(
			`Handshake coverage must be target-level for ${baseException.importer} -> ${baseException.target}`,
		);
	});

	test("default roots reject unlisted imports in coding-agent and ai", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dynamic-import-default-roots-"));
		try {
			await fs.mkdir(path.join(dir, "packages/coding-agent/src"), { recursive: true });
			await fs.mkdir(path.join(dir, "packages/ai/src"), { recursive: true });
			await Bun.write(path.join(dir, "packages/coding-agent/src/unlisted.ts"), 'import("./cold");\n');
			await Bun.write(path.join(dir, "packages/ai/src/unlisted.ts"), 'import("./provider");\n');
			await fs.mkdir(path.join(dir, "scripts"));
			await Bun.write(path.join(dir, "scripts/dynamic-import-exceptions.json"), "[]\n");
			const { checkDynamicImportPolicy } = await import("./check-dynamic-import-policy");
			await expect(checkDynamicImportPolicy({ repoRoot: dir })).rejects.toThrow(
				/Unlisted dynamic import: packages\/coding-agent\/src\/unlisted\.ts:1 -> \.\/cold/,
			);
			await expect(checkDynamicImportPolicy({ repoRoot: dir })).rejects.toThrow(
				/Unlisted dynamic import: packages\/ai\/src\/unlisted\.ts:1 -> \.\/provider/,
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
