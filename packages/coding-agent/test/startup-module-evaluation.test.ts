import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

describe("startup module evaluation", () => {
	it("keeps no-model help paths away from the full catalog and workspace scanner", () => {
		const result = Bun.spawnSync([process.execPath, "packages/coding-agent/src/cli.ts", "--help"], {
			cwd: repoRoot,
			env: { ...process.env, GJC_STARTUP_TRACE: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = result.stderr.toString();
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("USAGE");
		expect(stderr).not.toContain("startup:models-catalog-parsed");
		expect(stderr).not.toContain("startup:workspace-scan-");
	});

	it("keeps export away from model discovery and the full catalog", () => {
		const outputPath = path.join(os.tmpdir(), `gjc-export-${crypto.randomUUID()}.html`);
		try {
			const result = Bun.spawnSync(
				[
					process.execPath,
					"packages/coding-agent/src/cli.ts",
					"--export",
					"packages/coding-agent/test/fixtures/before-compaction.jsonl",
					outputPath,
				],
				{
					cwd: repoRoot,
					env: { ...process.env, GJC_STARTUP_TRACE: "1" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = result.stderr.toString();
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("Exported to:");
			expect(stderr).not.toContain("startup:model-registry-constructed");
			expect(stderr).not.toContain("startup:workspace-scan-");
			expect(fs.existsSync(outputPath)).toBe(true);
		} finally {
			fs.rmSync(outputPath, { force: true });
		}
	});
});

it("does not evaluate a settings-disabled tool implementation module", () => {
	const script = `
		import { Settings } from "./packages/coding-agent/src/config/settings";
		import { createTools } from "./packages/coding-agent/src/tools";
		const tools = await createTools({
			cwd: process.cwd(),
			hasUI: false,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "browser.enabled": false }),
		}, ["browser", "read"]);
		process.stdout.write(tools.map(tool => tool.name).join(","));
	`;
	const result = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: repoRoot,
		env: { ...process.env, GJC_STARTUP_TRACE: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("read");
	expect(result.stdout.toString()).not.toContain("browser");
	expect(result.stderr.toString()).not.toContain("startup:tool-module:browser");
});
