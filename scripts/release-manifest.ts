#!/usr/bin/env bun

import * as path from "node:path";

export interface ReleasePlatform {
	id: string;
	platform: NodeJS.Platform;
	arch: string;
	bunTarget: string;
	binaryPath: string;
	coreBinaryPath: string;
	nativePackage: string;
	nativeArtifacts: readonly string[];
	workflowRunner: string;
	variant?: "baseline";
	rustTarget?: string;
}

export const releasePlatforms: readonly ReleasePlatform[] = [
	{ id: "linux-x64", platform: "linux", arch: "x64", bunTarget: "bun-linux-x64-baseline", binaryPath: "packages/coding-agent/binaries/gjc-linux-x64", coreBinaryPath: "packages/coding-agent/binaries/gjc-core-linux-x64", nativePackage: "@gajae-code/natives-linux-x64", nativeArtifacts: ["pi_natives.linux-x64-baseline.node", "pi_natives_core.linux-x64-baseline.node", "pi_natives_shell.linux-x64-baseline.node"], workflowRunner: "ubuntu-22.04", variant: "baseline" },
	{ id: "linux-arm64", platform: "linux", arch: "arm64", bunTarget: "bun-linux-arm64", binaryPath: "packages/coding-agent/binaries/gjc-linux-arm64", coreBinaryPath: "packages/coding-agent/binaries/gjc-core-linux-arm64", nativePackage: "@gajae-code/natives-linux-arm64", nativeArtifacts: ["pi_natives.linux-arm64.node", "pi_natives_core.linux-arm64.node", "pi_natives_shell.linux-arm64.node"], workflowRunner: "ubuntu-24.04-arm", rustTarget: "aarch64-unknown-linux-gnu" },
	{ id: "darwin-arm64", platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64", binaryPath: "packages/coding-agent/binaries/gjc-darwin-arm64", coreBinaryPath: "packages/coding-agent/binaries/gjc-core-darwin-arm64", nativePackage: "@gajae-code/natives-darwin-arm64", nativeArtifacts: ["pi_natives.darwin-arm64.node", "pi_natives_core.darwin-arm64.node", "pi_natives_shell.darwin-arm64.node"], workflowRunner: "macos-14" },
	{ id: "darwin-x64", platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64-baseline", binaryPath: "packages/coding-agent/binaries/gjc-darwin-x64", coreBinaryPath: "packages/coding-agent/binaries/gjc-core-darwin-x64", nativePackage: "@gajae-code/natives-darwin-x64", nativeArtifacts: ["pi_natives.darwin-x64-baseline.node", "pi_natives_core.darwin-x64-baseline.node", "pi_natives_shell.darwin-x64-baseline.node"], workflowRunner: "macos-15-intel", variant: "baseline" },
	{ id: "win32-x64", platform: "win32", arch: "x64", bunTarget: "bun-windows-x64-modern", binaryPath: "packages/coding-agent/binaries/gjc-windows-x64.exe", coreBinaryPath: "packages/coding-agent/binaries/gjc-core-windows-x64.exe", nativePackage: "@gajae-code/natives-win32-x64", nativeArtifacts: ["pi_natives.win32-x64-baseline.node", "pi_natives_core.win32-x64-baseline.node", "pi_natives_shell.win32-x64-baseline.node"], workflowRunner: "windows-latest", variant: "baseline" },
];

export const publishOrder = [
	"packages/utils", "packages/ai",
	...releasePlatforms.map(target => `packages/natives-${target.id}`),
	"packages/natives", "packages/tui", "packages/stats", "packages/agent", "packages/agent-wire", "packages/coding-agent", "packages/bridge-client", "packages/gajae-code",
] as const;

export const versionSurfaceDescriptors = {
	packageGlob: "packages/*/package.json",
	cargoWorkspace: "Cargo.toml",
	nativeSentinel: ["crates/pi-natives/src/lib.rs", "packages/natives/native/index.d.ts", "packages/natives/native/index.js"],
	rootCatalog: "package.json",
} as const;

type Projection = Pick<ReleasePlatform, "id" | "platform" | "arch" | "binaryPath" | "coreBinaryPath" | "nativePackage" | "workflowRunner" | "variant" | "rustTarget">;

function stable(value: unknown): string {
	return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function compareProjection(label: string, expected: readonly unknown[], actual: readonly unknown[], errors: string[]): void {
	const expectedValues = expected.map(stable).sort();
	const actualValues = actual.map(stable).sort();
	if (JSON.stringify(expectedValues) !== JSON.stringify(actualValues)) errors.push(`${label} is stale`);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function parseLoaderPackages(loader: string): Array<{ id: string; nativePackage: string }> {
	const block = loader.match(/const OPTIONAL_PACKAGE_BY_PLATFORM_TAG = \{([\s\S]*?)\n\};/)?.[1] ?? "";
	return Array.from(block.matchAll(/"([^"]+)":\s*"([^"]+)"/g), match => ({ id: match[1], nativePackage: match[2] }));
}

export function parseWorkflowNativeProjections(workflowText: string): Array<Pick<Projection, "id" | "platform" | "arch" | "variant" | "rustTarget">> {
	const workflow = record(Bun.YAML.parse(workflowText));
	const jobs = record(workflow.jobs);
	const nativeRelease = record(jobs.native_release);
	const nativeInclude = array(record(record(nativeRelease.strategy).matrix).include).map(record).map(entry => ({
		id: `${String(entry.platform)}-${String(entry.arch)}`,
		platform: String(entry.platform) as NodeJS.Platform,
		arch: String(entry.arch),
		...(entry.variant === undefined ? {} : { variant: String(entry.variant) as "baseline" }),
		...(entry.target === undefined ? {} : { rustTarget: String(entry.target) }),
	}));
	const nativeLinux = record(jobs.native_linux);
	const linuxVariants = array(record(record(nativeLinux.strategy).matrix).include).map(record);
	return [{ id: "linux-x64", platform: "linux", arch: "x64", ...(linuxVariants.some(candidate => candidate.variant === "baseline") ? { variant: "baseline" as const } : {}) }, ...nativeInclude];
}

function parseWorkflowProjections(workflowText: string): Projection[] {
	const workflow = record(Bun.YAML.parse(workflowText));
	const jobs = record(workflow.jobs);
	const releaseBinary = record(jobs.release_binary);
	const binaryInclude = array(record(record(releaseBinary.strategy).matrix).include);
	const nativeRelease = record(jobs.native_release);
	const nativeInclude = array(record(record(nativeRelease.strategy).matrix).include).map(record);
	const nativeLinux = record(jobs.native_linux);
	const linuxVariants = array(record(record(nativeLinux.strategy).matrix).include).map(record);
	const nativeByKey = new Map(nativeInclude.map(entry => [`${String(entry.platform)}-${String(entry.arch)}`, entry]));
	return binaryInclude.map(record).map(entry => {
		const id = String(entry.target_id);
		const platform = String(entry.platform) as NodeJS.Platform;
		const arch = String(entry.arch);
		const native = id === "linux-x64" ? { os: nativeLinux["runs-on"], variant: linuxVariants.some(candidate => candidate.variant === "baseline") ? "baseline" : undefined } : nativeByKey.get(`${platform}-${arch}`) ?? {};
		return {
			id, platform, arch, binaryPath: String(entry.binary_path), coreBinaryPath: String(entry.core_binary_path), nativePackage: `@gajae-code/natives-${id}`,
			workflowRunner: String(entry.os),
			...(native.variant === undefined ? {} : { variant: String(native.variant) as "baseline" }),
			...(native.target === undefined ? {} : { rustTarget: String(native.target) }),
		};
	});
}

export async function checkReleaseManifest(repoRoot = path.join(import.meta.dir, "..")): Promise<string[]> {
	const errors: string[] = [];
	const expected = releasePlatforms.map(({ id, platform, arch, binaryPath, coreBinaryPath, nativePackage, workflowRunner, variant, rustTarget }) => ({ id, platform, arch, binaryPath, coreBinaryPath, nativePackage, workflowRunner, ...(variant === undefined ? {} : { variant }), ...(rustTarget === undefined ? {} : { rustTarget }) }));
	const natives = await Bun.file(path.join(repoRoot, "packages/natives/package.json")).json() as { optionalDependencies?: Record<string, string> };
	const actualOptional = Object.entries(natives.optionalDependencies ?? {}).map(([nativePackage, version]) => ({ nativePackage, version }));
	const expectedOptional = releasePlatforms.map(({ nativePackage }) => ({ nativePackage, version: "workspace:*" }));
	compareProjection("packages/natives/package.json optionalDependencies", expectedOptional, actualOptional, errors);
	const loader = await Bun.file(path.join(repoRoot, "packages/natives/native/loader-state.js")).text();
	compareProjection("loader-state.js platform packages", releasePlatforms.map(({ id, nativePackage }) => ({ id, nativePackage })), parseLoaderPackages(loader), errors);
	const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();
	compareProjection("ci.yml release platform projection", expected, parseWorkflowProjections(workflow), errors);
	compareProjection("ci.yml native build projection", expected.map(({ id, platform, arch, variant, rustTarget }) => ({ id, platform, arch, ...(variant === undefined ? {} : { variant }), ...(rustTarget === undefined ? {} : { rustTarget }) })), parseWorkflowNativeProjections(workflow), errors);
	return errors;
}

if (import.meta.main) {
	if (!process.argv.includes("--check")) throw new Error("release-manifest only supports --check");
	const errors = await checkReleaseManifest();
	if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
	console.log("Release manifest generated surfaces are current.");
}
