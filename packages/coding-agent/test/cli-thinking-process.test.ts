import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const sourceEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const wrapperEntry = path.join(repoRoot, "packages", "coding-agent", "bin", "gjc.js");
const runtimeMarker = "GJC_TEST_H2_FETCH_INSTALLED";

let tempRoot: string;
let preloadPath: string;

interface CliRoute {
	name: string;
	entry: string;
	prefix: readonly string[];
	usageCommand: "launch" | "acp";
}

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const routes: readonly CliRoute[] = [
	{ name: "source default route", entry: sourceEntry, prefix: [], usageCommand: "launch" },
	{ name: "source explicit launch route", entry: sourceEntry, prefix: ["launch"], usageCommand: "launch" },
	{ name: "source explicit ACP route", entry: sourceEntry, prefix: ["acp"], usageCommand: "acp" },
	{ name: "wrapper default route", entry: wrapperEntry, prefix: [], usageCommand: "launch" },
	{ name: "wrapper explicit launch route", entry: wrapperEntry, prefix: ["launch"], usageCommand: "launch" },
	{ name: "wrapper explicit ACP route", entry: wrapperEntry, prefix: ["acp"], usageCommand: "acp" },
];

beforeAll(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-thinking-process-"));
	preloadPath = path.join(tempRoot, "observe-runtime-globals.js");
	await fs.writeFile(
		preloadPath,
		`const installed = Symbol.for("gajae-code.h2fetch.installed");
process.on("exit", () => {
	process.stdout.write("\\n${runtimeMarker}=" + String(globalThis.fetch?.[installed] === true) + "\\n");
});
`,
		"utf8",
	);
});

afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

function runRoute(route: CliRoute, args: readonly string[]): CliResult {
	const result = Bun.spawnSync([process.execPath, "--preload", preloadPath, route.entry, ...route.prefix, ...args], {
		cwd: repoRoot,
		env: { ...process.env, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("public CLI thinking validation", () => {
	for (const route of routes) {
		describe(route.name, () => {
			it("rejects missing values before help and version fast paths", () => {
				for (const fastFlag of ["--help", "--version"]) {
					const result = runRoute(route, ["--thinking", fastFlag]);
					expect(result.exitCode, `${fastFlag}\n${result.stdout}\n${result.stderr}`).toBe(2);
					expect(result.stderr.split(/\r?\n/, 1)[0]).toBe("--thinking requires <effort>");
					expect(result.stdout).toContain("USAGE");
					expect(result.stdout).toContain(`$ gjc ${route.usageCommand}`);
					expect(result.stdout).toContain(`${runtimeMarker}=false`);
				}
			});

			it("preserves equals syntax when flag-like efforts are invalid", () => {
				for (const rawEffort of ["--help", "--version"]) {
					const result = runRoute(route, [`--thinking=${rawEffort}`]);
					expect(result.exitCode, `${rawEffort}\n${result.stdout}\n${result.stderr}`).toBe(2);
					expect(result.stderr.split(/\r?\n/, 1)[0]).toBe(
						`Invalid --thinking effort "${rawEffort}". Valid values: minimal, low, medium, high, xhigh, max`,
					);
					expect(result.stdout).toContain(`${runtimeMarker}=false`);
				}
			});

			it("rejects invalid efforts before runtime globals are installed", () => {
				for (const args of [["--thinking", "ultra"], ["--thinking=invalid-effort"]] as const) {
					const result = runRoute(route, args);
					expect(result.exitCode, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(2);
					expect(result.stderr.split(/\r?\n/, 1)[0]).toStartWith("Invalid --thinking effort");
					expect(result.stdout).toContain(`${runtimeMarker}=false`);
				}
			});
		});
	}

	for (const route of routes) {
		it(`stops option scanning at -- for ${route.name}`, () => {
			const result = runRoute(route, ["--version", "--", "--thinking", "ultra"]);
			expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
			expect(result.stdout).toMatch(/^gjc\/\d+\.\d+\.\d+/);
			expect(result.stdout).toContain(`${runtimeMarker}=false`);
			expect(result.stderr).toBe("");
		});

		it(`preserves earlier fast paths for ${route.name}`, () => {
			for (const fastFlag of ["--help", "--version"]) {
				const result = runRoute(route, [fastFlag, "--thinking", "ultra"]);
				expect(result.exitCode, `${fastFlag}\n${result.stdout}\n${result.stderr}`).toBe(0);
				expect(result.stdout).toContain(`${runtimeMarker}=false`);
				expect(result.stderr).toBe("");
			}

			const versionFirst = runRoute(route, ["--version", "--thinking", "ultra", "--help"]);
			expect(versionFirst.exitCode, `${versionFirst.stdout}\n${versionFirst.stderr}`).toBe(0);
			expect(versionFirst.stdout).toMatch(/^gjc\/\d+\.\d+\.\d+/);
			expect(versionFirst.stdout).not.toContain("USAGE");
			expect(versionFirst.stdout).toContain(`${runtimeMarker}=false`);
			expect(versionFirst.stderr).toBe("");

			const worktreeName = runRoute(route, ["--worktree", "help", "--version"]);
			expect(worktreeName.exitCode, `${worktreeName.stdout}\n${worktreeName.stderr}`).toBe(0);
			expect(worktreeName.stdout).toMatch(/^gjc\/\d+\.\d+\.\d+/);
			expect(worktreeName.stdout).not.toContain("USAGE");
			expect(worktreeName.stderr).toBe("");
		});
	}

	for (const entry of [sourceEntry, wrapperEntry]) {
		it(`preserves launch option value ownership for ${path.basename(entry)}`, () => {
			const route = { name: entry, entry, prefix: [], usageCommand: "launch" } satisfies CliRoute;
			const consumedValue = runRoute(route, ["--model", "--thinking", "--version"]);
			expect(consumedValue.exitCode, `${consumedValue.stdout}\n${consumedValue.stderr}`).toBe(0);
			expect(consumedValue.stdout).toMatch(/^gjc\/\d+\.\d+\.\d+/);
			expect(consumedValue.stdout).toContain(`${runtimeMarker}=false`);
			expect(consumedValue.stderr).toBe("");
		});
	}
});
