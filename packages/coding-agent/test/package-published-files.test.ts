import { describe, expect, it } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function exportedSourcePaths(value: unknown): string[] {
	if (typeof value === "string") return value.startsWith("./src/") ? [value] : [];
	if (!value || typeof value !== "object") return [];
	return Object.values(value).flatMap(exportedSourcePaths);
}

describe("published package files", () => {
	it("packs exported source without test files under src", async () => {
		expect(packageJson.files).toContain("src");
		expect(exportedSourcePaths(packageJson.exports).length).toBeGreaterThan(0);

		const proc = Bun.spawn(["bun", "pm", "pack", "--dry-run"], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);

		const packedFiles = `${stdout}\n${stderr}`
			.split("\n")
			.map(line => line.match(/^packed\s+\S+\s+(.+)$/)?.[1])
			.filter((path): path is string => path !== undefined);
		expect(packedFiles.length).toBeGreaterThan(0);
		expect(packedFiles.filter(path => path.startsWith("src/") && /\.test\.[^/]+$/.test(path))).toEqual([]);
	});

	it("does not expose native edit test hooks through package exports", async () => {
		expect(Object.hasOwn(packageJson.exports, "./edit/testing/*")).toBe(false);
		const proc = Bun.spawn(["bun", "-e", 'import("../src/edit/testing/native-edit-test-hooks")'], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Cannot find module");
	});
});
