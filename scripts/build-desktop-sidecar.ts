#!/usr/bin/env bun
/**
 * Build the gjc CLI sidecar for the Tauri desktop app.
 *
 * `crates/gjc-desktop/tauri.conf.json` declares `bundle.externalBin:
 * ["binaries/gjc"]`, which Tauri v2 resolves at bundle time to
 * `crates/gjc-desktop/binaries/gjc-<target-triple>` (e.g.
 * `gjc-aarch64-apple-darwin`). That directory is gitignored — sidecar
 * binaries are build artifacts and must never be committed (GitHub's 100MB
 * limit aside, they are reproducible from source).
 *
 * This script reuses the release binary pipeline
 * (`scripts/ci-release-build-binaries.ts`) for the host target and copies
 * the output into place under the Rust target-triple name Tauri expects. A
 * cold build also requires the Rust toolchain to build the native addon.
 *
 * Usage:
 *   bun scripts/build-desktop-sidecar.ts             # build + stage host sidecar
 *   bun scripts/build-desktop-sidecar.ts --copy-only # stage an existing release binary
 */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { releaseTargets, type BinaryTarget } from "./lib/release-targets";

const repoRoot = path.join(import.meta.dir, "..");

function hostTarget(): BinaryTarget {
	const target = releaseTargets.find(target => target.platform === process.platform && target.arch === process.arch);
	if (!target) {
		throw new Error(`No sidecar target for host ${process.platform}-${process.arch}`);
	}
	return target;
}

function parseArguments(): { copyOnly: boolean } {
	const args = process.argv.slice(2);
	if (args.every(arg => arg === "--copy-only")) {
		return { copyOnly: args.includes("--copy-only") };
	}
	throw new Error("Usage: bun scripts/build-desktop-sidecar.ts [--copy-only]");
}

function nativeAddonPath(target: BinaryTarget): string {
	const variantSuffix = target.arch === "x64" ? "-baseline" : "";
	return path.join(repoRoot, "packages", "natives", "native", `pi_natives.${target.platform}-${target.arch}${variantSuffix}.node`);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error(`Failed to inspect ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function runCommand(command: string[], env?: Record<string, string>): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env: env ? { ...Bun.env, ...env } : Bun.env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function main(): Promise<void> {
	const target = hostTarget();
	const { copyOnly } = parseArguments();
	const sourcePath = path.join(repoRoot, target.outfile);

	if (!copyOnly) {
		const addonPath = nativeAddonPath(target);
		if (!(await fileExists(addonPath))) {
			// The x64 release embed step requires the baseline variant; the native
			// build otherwise picks the host-optimized (modern) variant on AVX2 CPUs.
			const env = target.arch === "x64" ? { TARGET_VARIANT: "baseline" } : undefined;
			await runCommand(["bun", "--cwd=packages/natives", "run", "build"], env);
		}
		await runCommand(["bun", "scripts/ci-release-build-binaries.ts", "--targets", target.id]);
	}

	let sourceStat: Stats;
	try {
		sourceStat = await fs.stat(sourcePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Release binary not found at ${target.outfile}. Run without --copy-only to build it first.`);
		}
		throw new Error(`Failed to inspect release binary at ${target.outfile}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!sourceStat.isFile()) {
		throw new Error(`Release binary not found at ${target.outfile}. Run without --copy-only to build it first.`);
	}

	const suffix = process.platform === "win32" ? ".exe" : "";
	const destDir = path.join(repoRoot, "crates", "gjc-desktop", "binaries");
	const destPath = path.join(destDir, `gjc-${target.rustTriple}${suffix}`);
	await fs.mkdir(destDir, { recursive: true });
	await fs.copyFile(sourcePath, destPath);
	if (process.platform !== "win32") {
		await fs.chmod(destPath, 0o755);
	}
	console.log(`Staged sidecar: ${path.relative(repoRoot, destPath)}`);
}

await main();
