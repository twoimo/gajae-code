import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeFileDependencySpec, packages as publishPackages, stageNativePlatformArtifacts } from "./ci-release-publish";
import { publishOrder, releasePlatforms } from "./release-manifest";

interface PackageManifest {
	name: string;
	version: string;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	private?: boolean;
	optionalDependencies?: Record<string, string>;
	files?: string[];
	os?: string[];
	cpu?: string[];
	libc?: string[];
}

const repoRoot = path.join(import.meta.dir, "..");
const tempRoots: string[] = [];
afterEach(async () => Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

async function nativeArtifactFixture(): Promise<{ sourceDir: string; targetDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-native-artifacts-"));
	tempRoots.push(root);
	const sourceDir = path.join(root, "source");
	const targetDir = path.join(root, "target");
	await fs.mkdir(sourceDir, { recursive: true });
	for (const filename of releasePlatforms.flatMap(target => target.nativeArtifacts)) {
		await Bun.write(path.join(sourceDir, filename), filename);
	}
	return { sourceDir, targetDir };
}


async function readManifest(relativePath: string): Promise<PackageManifest> {
	return (await Bun.file(path.join(repoRoot, relativePath, "package.json")).json()) as PackageManifest;
}

describe("unscoped gajae-code package publication", () => {
	test("manifest exposes gjc and depends on the scoped CLI package", async () => {
		const aliasManifest = await readManifest("packages/gajae-code");
		const codingAgentManifest = await readManifest("packages/coding-agent");

		expect(aliasManifest.private).toBeUndefined();
		expect(aliasManifest.name).toBe("gajae-code");
		// The unscoped wrapper may carry a patch-only hotfix version when an
		// immutable npm publish has to be superseded without republishing the
		// scoped CLI. Its dependency remains catalog-backed so the release
		// publisher resolves it to the current @gajae-code/coding-agent version.
		expect(aliasManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(aliasManifest.version.split(".").slice(0, 2)).toEqual(codingAgentManifest.version.split(".").slice(0, 2));
		expect(Number(aliasManifest.version.split(".")[2])).toBeGreaterThanOrEqual(
			Number(codingAgentManifest.version.split(".")[2]),
		);
		expect(aliasManifest.bin).toEqual({ gjc: "bin/gjc.js" });
		expect(aliasManifest.dependencies?.["@gajae-code/coding-agent"]).toBe("catalog:");
		const wrapper = await Bun.file(path.join(repoRoot, "packages/gajae-code/bin/gjc.js")).text();
		expect(wrapper).toContain('import { runCli } from "@gajae-code/coding-agent/cli";');
		expect(wrapper).toContain("await runCli(process.argv.slice(2));");
	});

	test("release dependency normalization collapses repeated file prefixes", () => {
		expect(normalizeFileDependencySpec("file:../packages/ai")).toBe("file:../packages/ai");
		expect(normalizeFileDependencySpec("file:file:../packages/ai")).toBe("file:../packages/ai");
		expect(normalizeFileDependencySpec("file:file:file:///tmp/gajae-code/packages/ai")).toBe(
			"file:///tmp/gajae-code/packages/ai",
		);
		expect(normalizeFileDependencySpec("catalog:")).toBe("catalog:");
	});

	test("release publish order publishes the alias after its scoped dependency", () => {
		const publishDirs = publishPackages.map(pkg => pkg.dir);
		const codingAgentIndex = publishDirs.indexOf("packages/coding-agent");
		const aliasIndex = publishDirs.indexOf("packages/gajae-code");
		expect(codingAgentIndex).toBeGreaterThan(-1);
		expect(aliasIndex).toBeGreaterThan(codingAgentIndex);
	});
	test("agent-wire publishes before both wire consumers", () => {
		const publishDirs = publishPackages.map(pkg => pkg.dir);
		const agentWireIndex = publishDirs.indexOf("packages/agent-wire");
		expect(agentWireIndex).toBeGreaterThan(-1);
		for (const consumer of ["packages/coding-agent", "packages/bridge-client"]) {
			expect(publishDirs.indexOf(consumer)).toBeGreaterThan(agentWireIndex);
		}
	});

	test("native platform packages publish before the stable loader package", () => {
		const publishDirs = publishPackages.map((pkg) => pkg.dir);
		const nativesIndex = publishDirs.indexOf("packages/natives");
		const platformDirs = [
			"packages/natives-darwin-arm64",
			"packages/natives-darwin-x64",
			"packages/natives-linux-arm64",
			"packages/natives-linux-x64",
			"packages/natives-win32-x64",
		];

		expect(nativesIndex).toBeGreaterThan(-1);
		for (const dir of platformDirs) {
			const platformIndex = publishDirs.indexOf(dir);
			expect(platformIndex).toBeGreaterThan(-1);
			expect(platformIndex).toBeLessThan(nativesIndex);
		}
	});

	test("stable natives package delegates binaries to optional platform packages", async () => {
		const manifest = await readManifest("packages/natives");
		expect(manifest.files).toEqual([
			"native/index.js",
			"native/index.d.ts",
			"native/loader-state.js",
			"native/loader-state.d.ts",
			"native/embedded-addon.js",
			"README.md",
		]);
		expect(manifest.files?.some((entry) => entry === "native" || entry.endsWith(".node"))).toBe(false);
		expect(manifest.optionalDependencies).toEqual({
			"@gajae-code/natives-darwin-arm64": "workspace:*",
			"@gajae-code/natives-darwin-x64": "workspace:*",
			"@gajae-code/natives-linux-arm64": "workspace:*",
			"@gajae-code/natives-linux-x64": "workspace:*",
			"@gajae-code/natives-win32-x64": "workspace:*",
		});
	});

	test("native platform package manifests constrain host os and cpu", async () => {
		const cases: Array<[string, string, string]> = [
			["packages/natives-darwin-arm64", "darwin", "arm64"],
			["packages/natives-darwin-x64", "darwin", "x64"],
			["packages/natives-linux-arm64", "linux", "arm64"],
			["packages/natives-linux-x64", "linux", "x64"],
			["packages/natives-win32-x64", "win32", "x64"],
		];

		for (const [dir, os, cpu] of cases) {
			const manifest = await readManifest(dir);
			expect(manifest.os).toEqual([os]);
			expect(manifest.cpu).toEqual([cpu]);
			expect(manifest.files).toEqual(["native", "README.md"]);
		}
	});

	test("native artifact staging requires every exact target file", async () => {
		const target = releasePlatforms.find(candidate => candidate.id === "darwin-arm64")!;
		const pkg = publishPackages.find(candidate => candidate.dir === "packages/natives-darwin-arm64")!;
		for (const missing of target.nativeArtifacts) {
			const { sourceDir, targetDir } = await nativeArtifactFixture();
			await fs.rm(path.join(sourceDir, missing));
			await expect(stageNativePlatformArtifacts(pkg, sourceDir, targetDir)).rejects.toThrow(missing);
		}
	});

	test("native artifact staging rejects stray node files", async () => {
		const pkg = publishPackages.find(candidate => candidate.dir === "packages/natives-darwin-arm64")!;
		const { sourceDir, targetDir } = await nativeArtifactFixture();
		await Bun.write(path.join(sourceDir, "stray.node"), "stray");
		await expect(stageNativePlatformArtifacts(pkg, sourceDir, targetDir)).rejects.toThrow("stray.node");
	});

	test("release publish dry-run does not rewrite source manifests", async () => {
		const manifestPaths = [
			"packages/natives/package.json",
			"packages/coding-agent/package.json",
			"packages/stats/package.json",
		];
		const before = await Promise.all(manifestPaths.map(async (relativePath) => await Bun.file(path.join(repoRoot, relativePath)).text()));
		const proc = Bun.spawn(["bun", "scripts/ci-release-publish.ts", "--dry-run"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("DRY RUN stage pi_natives.linux-x64-baseline.node,pi_natives_core.linux-x64-baseline.node,pi_natives_shell.linux-x64-baseline.node into packages/natives-linux-x64/native");
		expect(stdout).not.toContain("Building Tailwind CSS");
		const after = await Promise.all(manifestPaths.map(async (relativePath) => await Bun.file(path.join(repoRoot, relativePath)).text()));
		expect(after).toEqual(before);
	});
});

describe("canonical release metadata and tag gate", () => {
	test("publish and platform metadata come from the canonical release manifest", () => {
		expect(publishPackages.map(pkg => pkg.dir)).toEqual([...publishOrder]);
		expect(releasePlatforms).toHaveLength(5);
	});

	test("release script uses the server-side exact-SHA tag gate and never creates tags locally", async () => {
		const release = await Bun.file(path.join(repoRoot, "scripts/release.ts")).text();
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/release-tag.yml")).text();
		expect(release).toContain("gh workflow run release-tag.yml --ref main");
		expect(release).not.toContain('git(["tag"');
		expect(workflow.indexOf("verify-release-candidate-version.ts")).toBeLessThan(workflow.indexOf("collect-release-check-evidence.ts"));
		expect(workflow.indexOf("release-ci-gate.ts")).toBeLessThan(workflow.indexOf('git tag "v$RELEASE_VERSION"'));
		expect(workflow).toContain("Repository administrators MUST protect refs/tags/v*");
		expect(release).not.toContain("tag -f");
		expect(release).not.toContain("--force");
	});
});
describe("release bump set equals publish set", () => {
	test("every non-private packages/* manifest is published, and every published dir is non-private", async () => {
		const { Glob } = await import("bun");

		// release.ts bumps the version of EVERY non-private packages/*/package.json.
		const bumpableDirs = new Set<string>();
		const glob = new Glob("packages/*/package.json");
		for await (const rel of glob.scan(repoRoot)) {
			const manifest = (await Bun.file(path.join(repoRoot, rel)).json()) as PackageManifest;
			if (manifest.private === true) continue;
			bumpableDirs.add(path.dirname(rel).replaceAll(path.sep, "/"));
		}

		// ci-release-publish.ts publishes exactly the dirs in its exported `packages` array.
		const publishDirs = new Set<string>(publishPackages.map((pkg) => pkg.dir));

		expect(bumpableDirs.size).toBeGreaterThan(0);
		// Any non-private package that release.ts bumps but the publisher omits would
		// ship a 0.x tag whose npm version never advances. Any published dir that is
		// private would be skipped at publish time. Both break one-release-truth.
		expect([...publishDirs].sort()).toEqual([...bumpableDirs].sort());
	});
});

describe("native release binary coverage", () => {
	test("release workflow builds Intel macOS (darwin-x64) binaries again", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();

		// The deprecated macos-13 runner pool stays retired; Intel coverage now
		// rides the supported macos-15-intel runner.
		expect(workflow).not.toContain("{ os: macos-13, platform: darwin, arch: x64 }");
		expect(workflow).toContain("{ os: macos-15-intel, platform: darwin, arch: x64, variant: baseline }");
		expect(workflow).toContain("target_id: darwin-x64");
		expect(workflow).toContain("binary_path: packages/coding-agent/binaries/gjc-darwin-x64");
		expect(workflow).toContain("{ os: macos-14, platform: darwin, arch: arm64 }");
		expect(workflow).toContain("target_id: darwin-arm64");
		expect(workflow).toContain("pattern: pi-natives-${{ matrix.platform }}-${{ matrix.arch }}*-h${{ needs.rust-hash.outputs.hash }}");
	});

	test("linux native platform packages declare their glibc requirement", async () => {
		// The linux native addons are built against *-unknown-linux-gnu targets
		// only (see the ci.yml build matrix), so the platform packages must set
		// "libc" to keep npm/bun from installing a glibc-linked .node on musl
		// systems (e.g. Alpine), where dlopen fails with raw relocation errors.
		for (const dir of ["packages/natives-linux-x64", "packages/natives-linux-arm64"]) {
			const manifest = await readManifest(dir);
			expect(manifest.libc).toEqual(["glibc"]);
		}

		// libc is a linux-only selector; other platform packages must not set it.
		for (const dir of ["packages/natives-darwin-arm64", "packages/natives-darwin-x64", "packages/natives-win32-x64"]) {
			const manifest = await readManifest(dir);
			expect(manifest.libc).toBeUndefined();
		}
	});

	test("installer explains missing release assets with fallback guidance", async () => {
		const installer = await Bun.file(path.join(repoRoot, "scripts/install.sh")).text();

		expect(installer).toContain("No prebuilt GJC binary was found for ${PLATFORM}-${ARCH} in ${LATEST}.");
		expect(installer).toContain("Re-run this installer with --source");
		expect(installer).toContain("Expected asset URL: $BINARY_URL");
	});

	test("install tarball smoke includes linux x64 optional natives package", async () => {
		const installer = await Bun.file(path.join(repoRoot, "scripts/install-tests/run-ci.sh")).text();
		expect(installer).toContain("stage_linux_x64_optional_package");
		expect(installer).toContain("for pkg in utils natives-linux-x64 natives ai agent tui stats coding-agent gajae-code");
		expect(installer).toContain("@gajae-code/natives-linux-x64");
		expect(installer).toContain("gajae-code-natives-[0-9]*.tgz");
	});
});
