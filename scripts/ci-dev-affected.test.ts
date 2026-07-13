import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	describeTasks,
	normalizeRepoRelativePosixPath,
	decodeChangedPaths,
	encodeChangedPaths,
	packageScriptCommand,
	planTargetedTasks,
	planTasks,
	resolvePackageCwd,
	runCommand,
	toRepoRelativePosixPath,
	type WorkspacePackage,
} from "./ci-dev-affected";
type YamlRecord = Record<string, unknown>;

function isYamlRecord(value: unknown): value is YamlRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireYamlRecord(value: unknown, location: string): YamlRecord {
	if (!isYamlRecord(value)) throw new Error(`${location} must be a YAML mapping`);
	return value;
}

function requireWorkflowStep(steps: readonly unknown[], property: "name" | "run" | "uses", value: string): [YamlRecord, number] {
	const index = steps.findIndex(candidate => isYamlRecord(candidate) && candidate[property] === value);
	if (index < 0) throw new Error(`workflow step ${property}=${value} must exist`);
	return [requireYamlRecord(steps[index], `workflow step ${property}=${value}`), index];
}

const packages: WorkspacePackage[] = [
	{
		name: "@gajae-code/example",
		dir: "packages/example",
		manifest: { name: "@gajae-code/example", scripts: { check: "true", test: "true" } },
	},
];

function planForPaths(paths: readonly string[]) {
	return planTasks(paths, packages);
}

describe("planTasks command shape (issue #622)", () => {
	test("no scheduled command uses the false-green standalone `bun --cwd <dir>` form", () => {
		const tasks = planForPaths([
			"packages/example/src/index.ts",
			"python/robogjc/web/app.ts",
		]);
		expect(tasks.length).toBeGreaterThan(0);
		for (const task of tasks) {
			// The space-separated `--cwd` argument is the exact shape that makes
			// `bun run` print its usage banner and exit 0 without running the
			// script under Bun 1.3.x. It must never appear in a scheduled command.
			expect(task.command).not.toContain("--cwd");
			// Be strict about the equals form too: directory scoping is expressed
			// via `task.cwd`, never as a `--cwd=...` flag baked into the command.
			expect(task.command.some(arg => arg.startsWith("--cwd"))).toBe(false);
		}
	});

	test("package check/test tasks run `bun run <script>` in the package cwd", () => {
		const tasks = planForPaths(["packages/example/src/index.ts"]);
		const check = tasks.find(task => task.key === "check:@gajae-code/example");
		const runTest = tasks.find(task => task.key === "test:@gajae-code/example");
		expect(check).toBeDefined();
		expect(runTest).toBeDefined();
		expect(check?.command).toEqual(["bun", "run", "check"]);
		expect(runTest?.command).toEqual(["bun", "run", "test"]);
		expect(check?.cwd).toBe(resolvePackageCwd("packages/example"));
		expect(runTest?.cwd).toBe(resolvePackageCwd("packages/example"));
	});

	test("robogjc web tasks run `bun run <script>` in the web cwd", () => {
		const tasks = planForPaths(["python/robogjc/web/app.ts"]);
		const typecheck = tasks.find(task => task.key === "robogjc-web-typecheck");
		const build = tasks.find(task => task.key === "robogjc-web-build");
		expect(typecheck?.command).toEqual(["bun", "run", "typecheck"]);
		expect(build?.command).toEqual(["bun", "run", "build"]);
		expect(typecheck?.cwd).toBe(resolvePackageCwd("python/robogjc/web"));
		expect(build?.cwd).toBe(resolvePackageCwd("python/robogjc/web"));
	});

	test("python tasks install dev dependencies before invoking pytest and ruff modules", () => {
		const tasks = planForPaths(["python/robogjc/src/server.py"]);
		const lint = tasks.find(task => task.key === "python-lint");
		const runTest = tasks.find(task => task.key === "python-test");
		expect(lint?.command).toEqual([
			"bash",
			"-lc",
			"python3 -m pip install --user --upgrade 'pip>=24' 'setuptools>=69' wheel && python3 -m pip install --user -e python/gjc-rpc -e 'python/robogjc[dev]' && python3 -m ruff check python && python3 -m ruff format --check python/robogjc",
		]);
		expect(runTest?.command).toEqual([
			"bash",
			"-lc",
			"python3 -m pip install --user --upgrade 'pip>=24' 'setuptools>=69' wheel && python3 -m pip install --user -e python/gjc-rpc -e 'python/robogjc[dev]' && python3 -m pytest -x --import-mode=importlib python/gjc-rpc/tests python/robogjc/tests",
		]);
	});
});

	describe("deep-interview selector narrowing", () => {
		test("deep-interview-only changes avoid full workspace validation but still provide native artifacts", () => {
			const tasks = planForPaths([
				"packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md",
				"packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts",
				"packages/coding-agent/test/default-gjc-definitions.test.ts",
				"packages/coding-agent/test/gjc-runtime/deep-interview-runtime.test.ts",
			]);
			expect(tasks.map(task => task.key)).toEqual([
				"native-linux-x64",
				"deep-interview-definitions",
				"deep-interview-runtime",
			]);
			const entries = describeTasks(tasks);
			expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
			expect(entries.find(entry => entry.key === "deep-interview-definitions")?.native).toBe(true);
			expect(entries.find(entry => entry.key === "deep-interview-runtime")?.native).toBe(true);
			expect(tasks.some(task => task.key === "root-test")).toBe(false);
		});
	});

describe("runCommand executes package scripts in the target cwd (issue #622)", () => {
	const tempDirs: string[] = [];

	afterAll(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function makePackage(): Promise<{ pkgDir: string; markerPath: string }> {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-"));
		tempDirs.push(tempDir);
		const pkgDir = path.join(tempDir, "pkg");
		await fs.mkdir(pkgDir, { recursive: true });
		const marker = "ran.marker";
		await fs.writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({
				name: "marker-pkg",
				scripts: {
					check: `node -e "require('node:fs').writeFileSync('${marker}','ran')"`,
					fail: "node -e \"process.exit(3)\"",
				},
			}),
		);
		return { pkgDir, markerPath: path.join(pkgDir, marker) };
	}

	test("the produced command actually runs the package script", async () => {
		const { pkgDir, markerPath } = await makePackage();
		const exitCode = await runCommand(packageScriptCommand("check"), pkgDir);
		expect(exitCode).toBe(0);
		expect(await Bun.file(markerPath).exists()).toBe(true);
	});

	test("a failing package script propagates its non-zero exit code", async () => {
		const { pkgDir } = await makePackage();
		const exitCode = await runCommand(packageScriptCommand("fail"), pkgDir);
		expect(exitCode).toBe(3);
	});

	test("the legacy `bun --cwd <dir>` form is a false green: exits 0 without running the script", async () => {
		const { pkgDir, markerPath } = await makePackage();
		// Spawn the buggy shape directly (captured, so the usage banner does not
		// flood test output) from a cwd that is NOT the package directory.
		const proc = Bun.spawn(["bun", "--cwd", pkgDir, "run", "check"], {
			cwd: os.tmpdir(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const output = stdout + stderr;
		expect(exitCode).toBe(0); // false green
		expect(await Bun.file(markerPath).exists()).toBe(false); // script never ran
		expect(output).toContain("Usage: bun run"); // it only printed help
	});
});

describe("repo-relative POSIX path serialization", () => {
	test("normalizes POSIX and Windows nested relative paths without backslashes", () => {
		const posixRelative = path.posix.relative("/repo", "/repo/packages/coding-agent");
		const windowsRelative = path.win32.relative("C:\\repo", "C:\\repo\\packages\\coding-agent");

		expect(normalizeRepoRelativePosixPath(posixRelative, path.posix.sep)).toBe("packages/coding-agent");
		expect(normalizeRepoRelativePosixPath(windowsRelative, path.win32.sep)).toBe("packages/coding-agent");
		expect(normalizeRepoRelativePosixPath(windowsRelative, path.win32.sep)).not.toContain("\\");
	});

	test("serializes nested paths and the repository root with host path semantics", () => {
		const root = path.join("repo");
		const nested = path.join(root, "packages", "coding-agent");

		expect(toRepoRelativePosixPath(root, nested)).toBe("packages/coding-agent");
		expect(toRepoRelativePosixPath(root, root)).toBe(".");
	});
});

describe("describeTasks matrix emission", () => {
	test("package test task needs native, native build task is flagged, check does not", () => {
		const entries = describeTasks(planForPaths(["packages/example/src/index.ts"]));
		const nativeBuild = entries.find(entry => entry.key === "native-linux-x64");
		const pkgTest = entries.find(entry => entry.key === "test:@gajae-code/example");
		const pkgCheck = entries.find(entry => entry.key === "check:@gajae-code/example");

		expect(nativeBuild?.nativeBuild).toBe(true);
		expect(nativeBuild?.native).toBe(false);
		expect(pkgTest?.native).toBe(true);
		expect(pkgTest?.nativeBuild).toBe(false);
		expect(pkgCheck?.native).toBe(false);
		expect(pkgCheck?.nativeBuild).toBe(false);

		// Every descriptor carries the serialized command plus boolean setup flags.
		for (const entry of entries) {
			expect(Array.isArray(entry.command)).toBe(true);
			expect(typeof entry.native).toBe("boolean");
			expect(typeof entry.rust).toBe("boolean");
			expect(typeof entry.nativeBuild).toBe("boolean");
		}
	});

	test("root-check shards need native artifacts for schema generation", () => {
		const entries = describeTasks(planTasks(["tsconfig.json"], packages));
		const nativeBuild = entries.find(entry => entry.key === "native-linux-x64");
		const rootCheck = entries.find(entry => entry.key === "root-check");

		expect(nativeBuild?.nativeBuild).toBe(true);
		expect(rootCheck).toMatchObject({ native: true, nativeBuild: false });
	});

	test("rust tasks are flagged rust and need no native addon", () => {
		const entries = describeTasks(planTasks(["crates/pi-natives/src/lib.rs"], packages));
		const check = entries.find(entry => entry.key === "rust-check");
		const runTest = entries.find(entry => entry.key === "rust-test");

		expect(check?.rust).toBe(true);
		expect(check?.native).toBe(false);
		expect(runTest?.rust).toBe(true);
		expect(entries.every(entry => !entry.nativeBuild)).toBe(true);
	});

	test("cwd is emitted repo-relative with POSIX separators for package-scoped tasks", () => {
		const entries = describeTasks(planForPaths(["packages/example/src/index.ts"]));
		const pkgCheck = entries.find(entry => entry.key === "check:@gajae-code/example");

		expect(pkgCheck?.cwd).toBe("packages/example");
		expect(pkgCheck?.cwd).not.toContain("\\");
	});
});

describe("--matrix-json and --task CLI fan-out", () => {
	const scriptPath = path.join(import.meta.dir, "ci-dev-affected.ts");
	const repoRoot = path.join(import.meta.dir, "..");
	const tempDirs: string[] = [];

	afterAll(async () => {
		await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function runScript(
		args: readonly string[],
		changedPaths: string | undefined,
		extraEnv: Record<string, string> = {},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const proc = Bun.spawn(["bun", scriptPath, ...args], {
			cwd: repoRoot,
			// Default to push (broad) mode so these CLI cases stay deterministic
			// regardless of the GITHUB_EVENT_NAME/CI_DEV_PLAN_MODE of the CI run
			// executing them; PR-mode behavior is asserted via planTargetedTasks unit
			// tests and explicit shard-mode cases.
			env: {
				...process.env,
				GITHUB_EVENT_NAME: "push",
				CI_DEV_PLAN_MODE: "push",
				CI_DEV_CHANGED_PATHS: changedPaths ?? "",
				CI_DEV_CHANGED_PATHS_JSON_BASE64: "",
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	test("--matrix-json emits JSON descriptors and GitHub planner outputs", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-matrix-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");

		const { stdout, exitCode } = await runScript(["--matrix-json"], "crates/pi-natives/src/lib.rs", {
			GITHUB_OUTPUT: outputFile,
		});
		expect(exitCode).toBe(0);

		const entries = JSON.parse(stdout.trim());
		expect(entries.some((entry: { key: string; rust: boolean; native: boolean }) => entry.key === "rust-check" && entry.rust === true && entry.native === false)).toBe(true);

		const output = await Bun.file(outputFile).text();
		expect(output).toContain("has_tasks=true");
		expect(output).toContain("has_native=false");
		expect(output).toContain("has_platform_policy=false");

		const outputLines = output.trim().split("\n");
		const changedPathsLine = outputLines.find(line => line.startsWith("changed_paths="));
		expect(changedPathsLine).toBeDefined();
		expect(decodeChangedPaths((changedPathsLine as string).slice("changed_paths=".length))).toEqual([
			"crates/pi-natives/src/lib.rs",
		]);

		const matrixLine = outputLines.find(line => line.startsWith("matrix="));
		expect(matrixLine).toBeDefined();
		const matrix = JSON.parse((matrixLine as string).slice("matrix=".length));
		expect(matrix.include.some((shard: { key: string }) => shard.key === "rust-check")).toBe(true);
		// Native build tasks never appear as shards.
		expect(matrix.include.every((shard: { key: string }) => shard.key !== "native-linux-x64")).toBe(true);
	});

	test("pull request planning uses the event base SHA instead of the fork's base branch", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-pr-base-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");
		const expectedPaths = [
			".github/workflows/ci.yml",
			".github/workflows/dev-ci.yml",
			"packages/coding-agent/CHANGELOG.md",
			"scripts/ci-dev-affected.test.ts",
			"scripts/ci-dev-affected.ts",
			"scripts/gjc-session/create.test.ts",
			"scripts/release-publish-order.test.ts",
			"scripts/verify-platform-test-policy.test.ts",
			"scripts/verify-platform-test-policy.ts",
		];

		const { exitCode } = await runScript(["--matrix-json"], undefined, {
			CI_DEV_PLAN_MODE: "pr",
			CI_DEV_WORKSPACE_SHA: "bfc589b212dbf7857da567d5d214a1e917e60e68",
			GITHUB_BASE_REF: "dev",
			GITHUB_BASE_SHA: "96eed5e39347e0778f68afea9872176dc82aa3b6",
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_OUTPUT: outputFile,
			GITHUB_SHA: "bfc589b212dbf7857da567d5d214a1e917e60e68",
		});
		expect(exitCode).toBe(0);

		const output = await Bun.file(outputFile).text();
		const changedPathsLine = output
			.trim()
			.split("\n")
			.find(line => line.startsWith("changed_paths="));
		expect(changedPathsLine).toBeDefined();
		const transportedPaths = (changedPathsLine as string).slice("changed_paths=".length);
		const plannedPaths = decodeChangedPaths(transportedPaths);

		expect(plannedPaths).toEqual(expectedPaths);
		expect(Buffer.byteLength(JSON.stringify(plannedPaths), "utf8")).toBeLessThan(48 * 1024);
		expect(transportedPaths.length).toBeLessThan(64 * 1024);
	});
	test("workflow fetches the exact validated pull request base before planning", async () => {
		const workflow = requireYamlRecord(
			Bun.YAML.parse(await Bun.file(path.join(repoRoot, ".github/workflows/dev-ci.yml")).text()),
			"Dev CI workflow",
		);
		const affectedPlan = requireYamlRecord(
			requireYamlRecord(workflow.jobs, "Dev CI workflow jobs")["affected-plan"],
			"affected-plan job",
		);
		const steps = affectedPlan.steps;
		expect(Array.isArray(steps)).toBe(true);
		if (!Array.isArray(steps)) throw new Error("affected-plan steps must be a YAML sequence");

		const [, checkoutIndex] = requireWorkflowStep(steps, "uses", "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5");
		const [attestation, attestationIndex] = requireWorkflowStep(steps, "name", "Attest checked-out workspace SHA");
		const [fetchBase, fetchBaseIndex] = requireWorkflowStep(steps, "name", "Fetch pull request base commit");
		const [, planIndex] = requireWorkflowStep(steps, "name", "Compute affected task matrix");

		expect(checkoutIndex).toBeLessThan(attestationIndex);
		expect(attestationIndex).toBeLessThan(fetchBaseIndex);
		expect(fetchBaseIndex).toBeLessThan(planIndex);
		expect(requireYamlRecord(attestation.env, "head attestation env").EXPECTED_WORKSPACE_SHA).toBe(
			"${{ github.event.pull_request.head.sha || github.sha }}",
		);
		expect(requireYamlRecord(affectedPlan.env, "affected-plan env").GITHUB_BASE_SHA).toBe(
			"${{ github.event.pull_request.base.sha }}",
		);
		expect(fetchBase.if).toBe("${{ github.event_name == 'pull_request' }}");
		expect(requireYamlRecord(fetchBase.env, "base fetch env")).toEqual({
			BASE_REPOSITORY: "${{ github.event.pull_request.base.repo.full_name }}",
			BASE_REF: "${{ github.event.pull_request.base.ref }}",
			BASE_SHA: "${{ github.event.pull_request.base.sha }}",
		});

		const fetchRun = fetchBase.run;
		expect(typeof fetchRun).toBe("string");
		if (typeof fetchRun !== "string") throw new Error("base fetch run command must be a string");
		expect(fetchRun).toContain('workspace_sha="$(git rev-parse HEAD)"');
		expect(fetchRun).toContain('git fetch --no-tags "https://github.com/${BASE_REPOSITORY}.git" "+refs/heads/${BASE_REF}:refs/remotes/gjc-base/base"');
		expect(fetchRun).toContain('fetched_base_sha="$(git rev-parse --verify refs/remotes/gjc-base/base^{commit})"');
		expect(fetchRun).toContain('if [ "$fetched_base_sha" != "$BASE_SHA" ]; then');
		expect(fetchRun).toContain('if [ "$(git rev-parse HEAD)" != "$workspace_sha" ]; then');
		expect(fetchRun).toContain('[[ "$BASE_REPOSITORY" =~ ^[A-Za-z0-9]');
		expect(fetchRun).toContain('git check-ref-format --branch "$BASE_REF" >/dev/null');
		expect(fetchRun).toContain('[[ "$BASE_SHA" =~ ^[0-9A-Fa-f]{40}$ ]]');
		expect(fetchRun).not.toContain("origin/dev");
	});

	test("base64 path transport cannot forge GitHub planner outputs with newline or delimiter filenames", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-dev-affected-hostile-path-"));
		tempDirs.push(tempDir);
		const outputFile = path.join(tempDir, "github-output.txt");
		const hostilePath = 'docs/innocuous\n__GJC_PATHS_EOF__\nhas_tasks=false\nhas_native=false\nmatrix={"include":[]}';
		const transportedPaths = encodeChangedPaths([
			"packages/coding-agent/src/main.ts",
			"scripts/verify-platform-test-policy.ts",
			hostilePath,
		]);

		const { exitCode } = await runScript(["--matrix-json"], "docs/placeholder.md", {
			GITHUB_OUTPUT: outputFile,
			CI_DEV_CHANGED_PATHS_JSON_BASE64: transportedPaths,
		});
		expect(exitCode).toBe(0);

		const output = await Bun.file(outputFile).text();
		const outputLines = output.trim().split("\n");
		expect(output).not.toContain(hostilePath);
		expect(outputLines.filter(line => line.startsWith("has_tasks="))).toEqual(["has_tasks=true"]);
		expect(outputLines.filter(line => line.startsWith("has_native="))).toEqual(["has_native=true"]);
		expect(outputLines.filter(line => line.startsWith("has_platform_policy="))).toEqual(["has_platform_policy=true"]);
		const matrixLines = outputLines.filter(line => line.startsWith("matrix="));
		expect(matrixLines).toHaveLength(1);
		const matrix = JSON.parse((matrixLines[0] as string).slice("matrix=".length));
		expect(matrix.include.length).toBeGreaterThan(0);

		const changedPathsLine = outputLines.find(line => line.startsWith("changed_paths="));
		expect(changedPathsLine).toBeDefined();
		expect(decodeChangedPaths((changedPathsLine as string).slice("changed_paths=".length))).toEqual([
			hostilePath,
			"packages/coding-agent/src/main.ts",
			"scripts/verify-platform-test-policy.ts",
		].sort());
	});

	test("rejects oversized count, serialized-byte, and base64 transports", () => {
		expect(() =>
			encodeChangedPaths(Array.from({ length: 1_001 }, (_, index) => `docs/changed-${index}.md`)),
		).toThrow("limit 1000");
		expect(() => encodeChangedPaths([`docs/${"x".repeat(48 * 1024)}`])).toThrow("limit 49152 bytes");
		expect(() => decodeChangedPaths("A".repeat(64 * 1024 + 4))).toThrow("limit 65536");
	});

	test("--task runs exactly the selected planned task", async () => {
		const { stdout, exitCode } = await runScript(["--task=affected-dry-run"], "scripts/ci-dev-affected.ts");
		expect(exitCode).toBe(0);
		// The selected task's group header proves the right single task was chosen,
		// and the nested --dry-run output proves it actually executed.
		expect(stdout).toContain("Affected CI selector self-check");
		expect(stdout).toContain("Dev affected-path CI");
	});

	test("--dry-run displays package cwd with POSIX separators", async () => {
		const { stdout, exitCode } = await runScript(["--dry-run"], "python/robogjc/web/app.ts");

		expect(exitCode).toBe(0);
		expect(stdout).toContain("cwd: python/robogjc/web");
		expect(stdout).not.toContain("cwd: python\\robogjc\\web");
	});

	test("--task fails loudly on a key absent from the current plan", async () => {
		const { stderr, exitCode } = await runScript(["--task=does-not-exist"], "docs/readme.md");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("not in the current plan");
	});

	test("--native-build is a no-op when the plan has no native build task", async () => {
		const { stdout, exitCode } = await runScript(["--native-build"], "docs/readme.md");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("no native build tasks in plan");
	});
});

describe("planTargetedTasks PR-mode targeting", () => {
	const codingAgent: WorkspacePackage = {
		name: "@gajae-code/coding-agent",
		dir: "packages/coding-agent",
		manifest: { name: "@gajae-code/coding-agent", scripts: { check: "biome check .", test: "bun test" } },
	};
	const targetingPackages: WorkspacePackage[] = [codingAgent];
	const testFiles = [
		"packages/coding-agent/test/edit/foo.test.ts",
		"packages/coding-agent/test/edit/bar.test.ts",
		"packages/coding-agent/test/cli.test.ts",
		"packages/coding-agent/test/rlm-live-model-e2e.test.ts",
		"packages/coding-agent/test/startup-update-contract.test.ts",
		"scripts/verify-platform-test-policy.test.ts",
	];

	function targeted(paths: readonly string[]) {
		return planTargetedTasks(paths, targetingPackages, testFiles);
	}

	test("a single coding-agent test change runs only that test, not the whole package suite", () => {
		const tasks = targeted(["packages/coding-agent/test/edit/foo.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/edit/foo.test.ts");
		// No broad package-wide test, and no other coding-agent test file.
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).not.toContain("test:packages/coding-agent/test/edit/bar.test.ts");
		const testTask = tasks.find(task => task.key === "test:packages/coding-agent/test/edit/foo.test.ts");
		expect(testTask?.command).toEqual(["bun", "test", "packages/coding-agent/test/edit/foo.test.ts"]);
	});

	test("a deleted test path is not scheduled as a runnable test shard", () => {
		const tasks = targeted(["packages/coding-agent/test/edit/deleted.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).not.toContain("test:packages/coding-agent/test/edit/deleted.test.ts");
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("cli-smoke");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);
	});

	test("the live RLM e2e test gets native artifacts for skipped import-time setup", () => {
		const tasks = targeted(["packages/coding-agent/test/rlm-live-model-e2e.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/rlm-live-model-e2e.test.ts");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).not.toContain("check:@gajae-code/coding-agent");

		const entries = describeTasks(tasks);
		const liveShard = entries.find(entry => entry.key === "test:packages/coding-agent/test/rlm-live-model-e2e.test.ts");
		expect(liveShard).toEqual({
			key: "test:packages/coding-agent/test/rlm-live-model-e2e.test.ts",
			description: "Test packages/coding-agent/test/rlm-live-model-e2e.test.ts",
			command: ["bun", "test", "packages/coding-agent/test/rlm-live-model-e2e.test.ts"],
			native: true,
			rust: false,
			nativeBuild: false,
		});
		expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
	});

	test("a source file with a directly-named test maps exclusively to that test", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/foo.ts"]);
		expect(tasks.map(task => task.key)).toEqual([
			"test:packages/coding-agent/test/edit/foo.test.ts",
			"native-linux-x64",
		]);
	});

	test("a source file with no mapped test runs the owning package check, not its test suite", () => {
		const tasks = targeted(["packages/coding-agent/src/edit/unmapped.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("check:@gajae-code/coding-agent");
		expect(keys).toContain("cli-smoke"); // coding-agent runtime smoke
		expect(keys.some(key => key.startsWith("test:"))).toBe(false);
	});

	test("main entrypoint adds its behavioral contract test without replacing owner fallback coverage", () => {
		const tasks = targeted(["packages/coding-agent/src/main.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toEqual([
			"test:packages/coding-agent/test/startup-update-contract.test.ts",
			"check:@gajae-code/coding-agent",
			"cli-smoke",
			"native-linux-x64",
		]);
		expect(tasks[0]?.command).toEqual(["bun", "test", "packages/coding-agent/test/startup-update-contract.test.ts"]);
		expect(tasks[1]).toMatchObject({
			command: ["bun", "run", "check"],
			cwd: resolvePackageCwd("packages/coding-agent"),
		});
		expect(tasks[2]?.command).toEqual(["bun", "run", "ci:test:smoke"]);
		expect(keys.filter(key => key === "native-linux-x64")).toHaveLength(1);
	});

	test("a CI workflow change plans yaml-parse + ci-selftest + ci-dry-run only", () => {
		const tasks = targeted([".github/workflows/dev-ci.yml"]);
		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", "ci-selftest", "yaml-parse"]);
	});

	test.each([
		["selector source", "scripts/ci-dev-affected.ts"],
		["selector test", "scripts/ci-dev-affected.test.ts"],
	])("a CI harness %s change plans ci-selftest + ci-dry-run exactly once (no yaml-parse)", (_kind, changedPath) => {
		const tasks = targeted([changedPath]);
		const selftestKey = "ci-selftest";

		expect(tasks.map(task => task.key).sort()).toEqual(["ci-dry-run", selftestKey]);
		expect(tasks.filter(task => task.key === selftestKey)).toHaveLength(1);
		expect(tasks.find(task => task.key === selftestKey)?.command).toEqual(["bun", "test", "scripts/ci-dev-affected.test.ts"]);
	});
	test.each([
		["verifier source", "scripts/verify-platform-test-policy.ts"],
		["verifier test", "scripts/verify-platform-test-policy.test.ts"],
	])("a platform test policy %s change schedules its focused verifier test once", (_kind, changedPath) => {
		const tasks = targeted([changedPath]);
		const focusedKey = "test:scripts/verify-platform-test-policy.test.ts";

		expect(tasks.map(task => task.key)).toEqual([focusedKey]);
		expect(tasks.find(task => task.key === focusedKey)?.command).toEqual([
			"bun",
			"test",
			"scripts/verify-platform-test-policy.test.ts",
		]);
		expect(tasks.filter(task => task.key === focusedKey)).toHaveLength(1);
	});
	const codingAgentShards = [
		"test:@gajae-code/coding-agent:shard-1-of-8",
		"test:@gajae-code/coding-agent:shard-2-of-8",
		"test:@gajae-code/coding-agent:shard-3-of-8",
		"test:@gajae-code/coding-agent:shard-4-of-8",
		"test:@gajae-code/coding-agent:shard-5-of-8",
		"test:@gajae-code/coding-agent:shard-6-of-8",
		"test:@gajae-code/coding-agent:shard-7-of-8",
		"test:@gajae-code/coding-agent:shard-8-of-8",
	];
	const r1PathCases = [
		{
			label: "workflow",
			changedPath: ".github/workflows/ci.yml",
			pr: ["ci-dry-run", "ci-selftest", "yaml-parse"],
			push: ["affected-dry-run", "affected-selftest", "workflow-yaml-parse"],
		},
		{
			label: "changelog",
			changedPath: "packages/coding-agent/CHANGELOG.md",
			pr: [],
			push: ["check:@gajae-code/coding-agent", "cli-smoke", "native-linux-x64", ...codingAgentShards],
		},
		{
			label: "affected planner test",
			changedPath: "scripts/ci-dev-affected.test.ts",
			pr: ["ci-dry-run", "ci-selftest"],
			push: ["affected-dry-run", "affected-selftest"],
		},
		{
			label: "affected planner source",
			changedPath: "scripts/ci-dev-affected.ts",
			pr: ["ci-dry-run", "ci-selftest"],
			push: ["affected-dry-run", "affected-selftest"],
		},
		{
			label: "session fixture test",
			changedPath: "scripts/gjc-session/create.test.ts",
			pr: ["test:scripts/gjc-session/create.test.ts"],
			push: ["test:scripts/gjc-session/create.test.ts"],
		},
		{
			label: "release ordering test",
			changedPath: "scripts/release-publish-order.test.ts",
			pr: ["test:scripts/release-publish-order.test.ts"],
			push: ["test:scripts/release-publish-order.test.ts"],
		},
		{
			label: "platform verifier test",
			changedPath: "scripts/verify-platform-test-policy.test.ts",
			pr: ["test:scripts/verify-platform-test-policy.test.ts"],
			push: ["test:scripts/verify-platform-test-policy.test.ts"],
		},
		{
			label: "platform verifier source",
			changedPath: "scripts/verify-platform-test-policy.ts",
			pr: ["test:scripts/verify-platform-test-policy.test.ts"],
			push: ["test:scripts/verify-platform-test-policy.test.ts"],
		},
	];

	for (const { label, changedPath, pr, push } of r1PathCases) {
		test(`R1 ${label} path has an exact PR and push matrix`, () => {
			expect(targeted([changedPath]).map(task => task.key).sort()).toEqual([...pr].sort());
			expect(planTasks([changedPath], targetingPackages).map(task => task.key).sort()).toEqual([...push].sort());
		});
	}

	test("native platform package changes plan release publish validation", () => {
		const tasks = targeted(["packages/natives-linux-x64/package.json"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("release-publish-contract");
		expect(keys).toContain("release-publish-dry-run");
	});

	test("unscoped wrapper package changes keep wrapper-version smoke with release validation", () => {
		const tasks = targeted(["packages/gajae-code/bin/gjc.js"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("release-publish-contract");
		expect(keys).toContain("release-publish-dry-run");
		expect(keys).toContain("wrapper-version");
	});

	test("root-level codeish changes that fall back to root-check provide native artifacts", () => {
		const tasks = targeted(["scripts/unmapped-tool.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("root-check");
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);

		const entries = describeTasks(tasks);
		expect(entries.find(entry => entry.key === "root-check")?.native).toBe(true);
		expect(entries.find(entry => entry.key === "native-linux-x64")?.nativeBuild).toBe(true);
	});

	test("docs/changelog-only changes plan nothing expensive", () => {
		expect(targeted(["docs/guide.md", "CHANGELOG.md", "packages/coding-agent/README.md"])).toEqual([]);
	});

	test("robogjc static asset changes plan no Python lint/test shards", () => {
		expect(targeted(["python/robogjc/assets/icon.png", "python/robogjc/assets/icon.jpg"])).toEqual([]);
	});

	test("native-consuming test files pull in a single native build task", () => {
		const tasks = targeted(["packages/coding-agent/test/cli.test.ts"]);
		const keys = tasks.map(task => task.key);
		expect(keys).toContain("test:packages/coding-agent/test/cli.test.ts");
		// ensureNativeBuild adds exactly one native build task (built once, shared).
		expect(keys.filter(key => key === "native-linux-x64" || key === "native-build")).toEqual(["native-linux-x64"]);

		const entries = describeTasks(tasks);
		const cliShard = entries.find(entry => entry.key === "test:packages/coding-agent/test/cli.test.ts");
		expect(cliShard?.native).toBe(true);
	});
});

describe("push-mode broad planning still runs the fuller suite", () => {
	const codingAgent: WorkspacePackage = {
		name: "@gajae-code/coding-agent",
		dir: "packages/coding-agent",
		manifest: { name: "@gajae-code/coding-agent", scripts: { check: "biome check .", test: "bun test" } },
	};

	test("push mode splits the package-wide coding-agent test across bounded shards", () => {
		const tasks = planTasks(["packages/coding-agent/src/edit/foo.ts"], [codingAgent]);
		const keys = tasks.map(task => task.key);
		const testShards = tasks.filter(task => task.key.startsWith("test:@gajae-code/coding-agent:shard-"));
		// Broad planner keeps the post-merge fuller suite, but not as one 30m shard.
		expect(testShards.map(task => task.key)).toEqual([
			"test:@gajae-code/coding-agent:shard-1-of-8",
			"test:@gajae-code/coding-agent:shard-2-of-8",
			"test:@gajae-code/coding-agent:shard-3-of-8",
			"test:@gajae-code/coding-agent:shard-4-of-8",
			"test:@gajae-code/coding-agent:shard-5-of-8",
			"test:@gajae-code/coding-agent:shard-6-of-8",
			"test:@gajae-code/coding-agent:shard-7-of-8",
			"test:@gajae-code/coding-agent:shard-8-of-8",
		]);
		expect(testShards[0]?.command).toEqual(["bun", "test", "--shard=1/8"]);
		expect(testShards[0]?.cwd).toBe(resolvePackageCwd("packages/coding-agent"));
		expect(keys).not.toContain("test:@gajae-code/coding-agent");
		expect(keys).toContain("check:@gajae-code/coding-agent");

		const entries = describeTasks(tasks);
		expect(entries.find(entry => entry.key === "test:@gajae-code/coding-agent:shard-1-of-8")?.native).toBe(true);
	});
	test.each([
		["verifier source", "scripts/verify-platform-test-policy.ts"],
		["verifier test", "scripts/verify-platform-test-policy.test.ts"],
	])("push mode routes a platform test policy %s change to its focused verifier test", (_kind, changedPath) => {
		const tasks = planTasks([changedPath], [codingAgent]);
		const focusedKey = "test:scripts/verify-platform-test-policy.test.ts";

		expect(tasks.map(task => task.key)).toEqual([focusedKey]);
		expect(tasks.find(task => task.key === focusedKey)?.command).toEqual([
			"bun",
			"test",
			"scripts/verify-platform-test-policy.test.ts",
		]);
		expect(tasks.filter(task => task.key === focusedKey)).toHaveLength(1);
	});

	test.each([
		["selector source", "scripts/ci-dev-affected.ts"],
		["selector test", "scripts/ci-dev-affected.test.ts"],
	])("push mode routes a CI harness %s change to its selftest exactly once", (_kind, changedPath) => {
		const tasks = planTasks([changedPath], [codingAgent]);
		const selftestKey = "affected-selftest";

		expect(tasks.map(task => task.key).sort()).toEqual(["affected-dry-run", selftestKey]);
		expect(tasks.filter(task => task.key === selftestKey)).toHaveLength(1);
		expect(tasks.find(task => task.key === selftestKey)?.command).toEqual(["bun", "test", "scripts/ci-dev-affected.test.ts"]);
	});
	test("full-workspace changes partition root tests into matrix shards", () => {
		const tasks = planTasks(["tsconfig.json"], [codingAgent]);
		const keys = tasks.map(task => task.key);

		expect(keys).toContain("root-check");
		expect(keys).toContain("root-test:release");
		expect(keys).not.toContain("root-test");
		expect(tasks.filter(task => task.key.startsWith("test:@gajae-code/coding-agent:shard-")).map(task => task.key)).toEqual([
			"test:@gajae-code/coding-agent:shard-1-of-8",
			"test:@gajae-code/coding-agent:shard-2-of-8",
			"test:@gajae-code/coding-agent:shard-3-of-8",
			"test:@gajae-code/coding-agent:shard-4-of-8",
			"test:@gajae-code/coding-agent:shard-5-of-8",
			"test:@gajae-code/coding-agent:shard-6-of-8",
			"test:@gajae-code/coding-agent:shard-7-of-8",
			"test:@gajae-code/coding-agent:shard-8-of-8",
		]);
	});
});
