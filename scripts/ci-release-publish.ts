#!/usr/bin/env bun
/**
 * Publish workspace packages.
 *
 * For each public TypeScript package we:
 *   1. Emit `.d.ts` declarations into `dist/types/` so consumers get
 *      stable types regardless of their tsconfig `lib`.
 *   2. Rewrite `package.json` in place — every `types`/`exports[*].types`
 *      that points at `./src/*.ts(x)` is repointed to `./dist/types/*.d.ts`
 *      and `dist/types` (plus `dist/client` for `stats`) is added to
 *      `files`. The on-repo manifest keeps pointing at source so local
 *      dev resolves types without any build.
 *   3. Invoke `bun publish` on the (now publish-shaped) manifest.
 *
 * Intended for CI. Mutates `package.json` in place — if you run this
 * locally, expect a dirty working tree and `git restore` after.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { publishOrder, releasePlatforms } from "./release-manifest";

interface PublishPackage {
	dir: string;
	kind: "typescript" | "native" | "native-platform" | "manifest";
	/** Extra build steps before manifest rewrite (e.g. esbuild bundles). */
	preBuild?: readonly (readonly string[])[];
	/** Extra entries to splice into `files`. */
	extraFiles?: readonly string[];
	/** Extra TypeScript declaration configs beyond `tsconfig.publish.json`. */
	extraTypeConfigs?: readonly string[];
	/** Exact native addon filenames staged into a per-platform optional package. */
	nativeArtifacts?: readonly string[];
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}
interface PackageManifest {
	[key: string]: JsonValue | undefined;
	name?: string;
	version?: string;
	private?: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
const isTypeCheck = process.argv.includes("--check-types");
const nativePlatformPackages: readonly PublishPackage[] = releasePlatforms.map(target => ({
	dir: `packages/natives-${target.id}`,
	kind: "native-platform",
	nativeArtifacts: target.nativeArtifacts,
}));
const packageOverrides = new Map<string, Omit<PublishPackage, "dir">>([
	["packages/stats", { kind: "typescript", preBuild: [["bun", "run", "build"]], extraFiles: ["dist/client"], extraTypeConfigs: ["tsconfig.publish.client.json"] }],
	...nativePlatformPackages.map(pkg => [pkg.dir, { kind: pkg.kind, nativeArtifacts: pkg.nativeArtifacts }] as const),
	["packages/natives", { kind: "native" }],
	["packages/gajae-code", { kind: "manifest" }],
]);
export const packages: PublishPackage[] = publishOrder.map(dir => ({
	dir,
	kind: "typescript",
	...packageOverrides.get(dir),
}));
const dependencyFieldNames = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

let rootCatalog: Readonly<Record<string, string>> | undefined;
let workspaceVersions: Readonly<Record<string, string>> | undefined;

function asStringRecord(value: JsonValue | undefined): Record<string, string> {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const record: Record<string, string> = {};
	for (const key in value) {
		const entry = (value as JsonObject)[key];
		if (typeof entry === "string") record[key] = entry;
	}
	return record;
}

async function loadRootCatalog(): Promise<Readonly<Record<string, string>>> {
	if (rootCatalog !== undefined) return rootCatalog;
	const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as PackageManifest;
	if (manifest.workspaces === null || typeof manifest.workspaces !== "object" || Array.isArray(manifest.workspaces)) {
		rootCatalog = {};
		return rootCatalog;
	}
	rootCatalog = asStringRecord((manifest.workspaces as JsonObject).catalog);
	return rootCatalog;
}

async function loadWorkspaceVersions(): Promise<Readonly<Record<string, string>>> {
	if (workspaceVersions !== undefined) return workspaceVersions;
	const versions: Record<string, string> = {};
	for (const pkg of packages) {
		const manifest = (await Bun.file(path.join(repoRoot, pkg.dir, "package.json")).json()) as PackageManifest;
		if (typeof manifest.name === "string" && typeof manifest.version === "string") {
			versions[manifest.name] = manifest.version;
		}
	}
	workspaceVersions = versions;
	return workspaceVersions;
}

export function normalizeFileDependencySpec(spec: string): string {
	if (!spec.startsWith("file:")) return spec;
	return `file:${spec.replace(/^(?:file:)+/u, "")}`;
}

function rewriteSrcPath(value: string): string {
	if (!value.startsWith("./src/")) return value;
	const rel = value.slice("./src/".length).replace(/\.tsx?$/, "");
	return `./dist/types/${rel}.d.ts`;
}

export async function resolvePublishDependency(name: string, spec: string): Promise<string> {
	let resolved = normalizeFileDependencySpec(spec);
	if (spec === "catalog:" || spec.startsWith("catalog:")) {
		const catalog = await loadRootCatalog();
		const catalogEntry = catalog[name];
		if (catalogEntry === undefined) throw new Error(`Missing catalog version for ${name}`);
		resolved = normalizeFileDependencySpec(catalogEntry);
	}
	if (resolved === "workspace:*" || resolved.startsWith("workspace:")) {
		const versions = await loadWorkspaceVersions();
		const workspaceVersion = versions[name];
		if (workspaceVersion === undefined) throw new Error(`Missing workspace package version for ${name}`);
		return workspaceVersion;
	}
	return normalizeFileDependencySpec(resolved);
}

async function rewriteDependencyFields(manifest: PackageManifest): Promise<void> {
	for (const fieldName of dependencyFieldNames) {
		const field = manifest[fieldName];
		if (field === undefined || field === null || typeof field !== "object" || Array.isArray(field)) continue;
		const dependencies = field as JsonObject;
		for (const dependencyName in dependencies) {
			const spec = dependencies[dependencyName];
			if (typeof spec === "string") {
				dependencies[dependencyName] = await resolvePublishDependency(dependencyName, spec);
			}
		}
	}
}

function rewriteExports(exports: JsonValue): JsonValue {
	if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return exports;
	const src = exports as JsonObject;
	const out: JsonObject = {};
	for (const key in src) {
		const val = src[key];
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			typeof (val as JsonObject).types === "string" &&
			((val as JsonObject).types as string).startsWith("./src/")
		) {
			const next: JsonObject = { ...(val as JsonObject) };
			next.types = rewriteSrcPath(next.types as string);
			out[key] = next;
		} else {
			out[key] = val;
		}
	}
	return out;
}

async function rewriteManifest(pkgDir: string, extraFiles: readonly string[]): Promise<PackageManifest> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	await rewriteDependencyFields(manifest);
	if (typeof manifest.types === "string" && manifest.types.startsWith("./src/")) {
		manifest.types = rewriteSrcPath(manifest.types);
	}
	if (manifest.exports !== undefined) manifest.exports = rewriteExports(manifest.exports);
	const files = Array.isArray(manifest.files) ? [...manifest.files] : [];
	const hasDist = files.includes("dist");
	if (!hasDist && !files.includes("dist/types")) files.push("dist/types");
	for (const extra of extraFiles) {
		if (!hasDist && !files.includes(extra)) files.push(extra);
	}
	manifest.files = files;
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

async function rewriteNativeManifest(pkgDir: string): Promise<PackageManifest> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	await rewriteDependencyFields(manifest);
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

export async function stageNativePlatformArtifacts(
	pkg: PublishPackage,
	sourceDir = path.join(repoRoot, "packages", "natives", "native"),
	targetDir = path.join(repoRoot, pkg.dir, "native"),
): Promise<void> {
	const expected = pkg.nativeArtifacts ?? [];
	if (expected.length === 0) throw new Error(`Native platform package ${pkg.dir} has no nativeArtifacts`);
	if (isDryRun) {
		console.log(`DRY RUN stage ${expected.join(",")} into ${pkg.dir}/native`);
		return;
	}

	const entries = await fs.readdir(sourceDir).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Cannot read native artifact directory ${sourceDir}: ${message}`);
	});
	const nodeEntries = entries.filter(entry => entry.endsWith(".node"));
	const allExpected = new Set(releasePlatforms.flatMap(target => target.nativeArtifacts));
	const unexpected = nodeEntries.filter(entry => !allExpected.has(entry));
	if (unexpected.length > 0) {
		throw new Error(`Unexpected native artifact(s) in ${sourceDir}: ${unexpected.sort().join(", ")}`);
	}
	const missing = expected.filter(entry => !nodeEntries.includes(entry));
	if (missing.length > 0) {
		throw new Error(`Missing native artifact(s) for ${pkg.dir}: ${missing.join(", ")}`);
	}

	await fs.rm(targetDir, { recursive: true, force: true });
	await fs.mkdir(targetDir, { recursive: true });
	for (const entry of expected) {
		await fs.copyFile(path.join(sourceDir, entry), path.join(targetDir, entry));
	}
}

async function emitTypeDeclarations(pkg: PublishPackage, temporaryRoot?: string): Promise<void> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	const configs = ["tsconfig.publish.json", ...(pkg.extraTypeConfigs ?? [])];
	for (const config of configs) {
		if (temporaryRoot === undefined) {
			await $`bun x tsc -p ${config}`.cwd(pkgDir);
			continue;
		}
		const outputName = path.basename(config, path.extname(config));
		const outputDir = path.join(temporaryRoot, pkg.dir.replaceAll(/[\\/]/g, "__"), outputName);
		await fs.mkdir(outputDir, { recursive: true });
		await $`bun x tsc -p ${config} --outDir ${outputDir}`.cwd(pkgDir);
	}
}

async function checkTypeDeclarations(): Promise<void> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-code-types-"));
	try {
		for (const pkg of packages) {
			if (pkg.kind !== "typescript") continue;
			await emitTypeDeclarations(pkg, temporaryRoot);
			console.log(`Checked declarations (${pkg.dir})`);
		}
	} finally {
		await fs.rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function preparePackage(pkg: PublishPackage): Promise<PackageManifest> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	if (pkg.kind === "native-platform") {
		await stageNativePlatformArtifacts(pkg);
		return rewriteNativeManifest(pkgDir);
	}
	if (pkg.kind === "native" || pkg.kind === "manifest") {
		return rewriteNativeManifest(pkgDir);
	}
	for (const argv of pkg.preBuild ?? []) {
		await $`${argv}`.cwd(pkgDir);
	}
	await emitTypeDeclarations(pkg);
	return rewriteManifest(pkgDir, pkg.extraFiles ?? []);
}

async function readPackageManifest(pkgDir: string): Promise<PackageManifest> {
	return (await Bun.file(path.join(pkgDir, "package.json")).json()) as PackageManifest;
}

async function publishPackage(pkg: PublishPackage): Promise<void> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	const manifest = isDryRun ? await readPackageManifest(pkgDir) : await preparePackage(pkg);
	const name = manifest.name ?? path.basename(pkg.dir);
	if (manifest.private) {
		console.log(`Skipping ${name} (private)`);
		return;
	}
	if (isDryRun) {
		if (pkg.kind === "native-platform") await stageNativePlatformArtifacts(pkg);
		console.log(`DRY RUN npm publish --access public (${pkg.dir})`);
		return;
	}
	const version = typeof manifest.version === "string" ? manifest.version : undefined;
	if (version !== undefined) {
		const existing = await $`npm view ${`${name}@${version}`} version --json`.quiet().nothrow();
		if (existing.exitCode === 0) {
			console.log(`Skipping ${name}@${version} (already published)`);
			return;
		}
	}
	console.log(`Publishing ${name}…`);
	const result = await $`npm publish --access public`.cwd(pkgDir).quiet().nothrow();
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	if (output) console.log(output);
	if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

async function main(): Promise<void> {
	if (isTypeCheck) {
		await checkTypeDeclarations();
		return;
	}
	if (!isDryRun) {
		await checkTypeDeclarations();
	}
	for (const pkg of packages) {
		await publishPackage(pkg);
	}
}

if (import.meta.main) {
	await main();
}
