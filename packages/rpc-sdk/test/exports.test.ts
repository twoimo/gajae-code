import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import packageJson from "../package.json" with { type: "json" };

type ExportTarget = string | { import?: string; types?: string };

const packageRoot = join(import.meta.dir, "..");

function importTarget(target: ExportTarget): string {
	return typeof target === "string" ? target : target.import ?? target.types ?? "";
}

function packageSpecifier(exportPath: string): string {
	return exportPath === "." ? packageJson.name : `${packageJson.name}/${exportPath.slice(2)}`;
}

async function concreteExportPaths(): Promise<string[]> {
	const paths: string[] = [];
	for (const [exportPath, target] of Object.entries(packageJson.exports)) {
		const importPath = importTarget(target);
		expect(importPath, `missing import target for ${exportPath}`).not.toBe("");
		if (!exportPath.includes("*") && !importPath.includes("*")) {
			paths.push(exportPath);
			continue;
		}

		const [targetPrefix, targetSuffix = ""] = importPath.split("*");
		const [exportPrefix, exportSuffix = ""] = exportPath.split("*");
		const lastSlash = targetPrefix.lastIndexOf("/");
		const dir = join(packageRoot, targetPrefix.slice(0, lastSlash));
		const filePrefix = targetPrefix.slice(lastSlash + 1);
		for (const entry of await readdir(dir)) {
			if (!entry.startsWith(filePrefix) || !entry.endsWith(targetSuffix)) continue;
			const wildcard = entry.slice(filePrefix.length, entry.length - targetSuffix.length);
			paths.push(`${exportPrefix}${wildcard}${exportSuffix}`);
		}
	}
	return [...new Set(paths)].sort();
}

describe("package exports", () => {
	test("declared export targets exist and package specifiers import", async () => {
		for (const [exportPath, target] of Object.entries(packageJson.exports)) {
			const importPath = importTarget(target);
			if (importPath.includes("*")) continue;
			const resolved = join(packageRoot, importPath);
			expect(existsSync(resolved), `${exportPath} target ${relative(packageRoot, resolved)} exists`).toBe(true);
		}

		const specifiers = await concreteExportPaths();
		expect(specifiers).toContain(".");
		expect(specifiers).toContain("./auth/hello");
		expect(specifiers).toContain("./protocol/types");

		for (const exportPath of specifiers) {
			await expect(import(packageSpecifier(exportPath)), packageSpecifier(exportPath)).resolves.toBeDefined();
		}
	});
});
