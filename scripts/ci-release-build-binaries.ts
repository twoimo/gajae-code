#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildCoreReleaseCompileArgs, buildReleaseCompileArgs } from "../packages/coding-agent/scripts/compile-args";
import { releasePlatforms } from "./release-manifest";

interface BinaryTarget {
	id: string;
	platform: NodeJS.Platform;
	arch: string;
	target: string;
	outfile: string;
	coreOutfile: string;
}

const repoRoot = path.join(import.meta.dir, "..");
const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");

const isDryRun = process.argv.includes("--dry-run");
const targets: BinaryTarget[] = releasePlatforms.map(target => ({
	id: target.id,
	platform: target.platform,
	arch: target.arch,
	target: target.bunTarget,
	outfile: target.binaryPath,
	coreOutfile: target.coreBinaryPath,
}));

function parseRequestedTargets(): Set<string> | null {
	const flagIndex = process.argv.findIndex(arg => arg === "--targets");
	const flagValue =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: process.argv.find(arg => arg.startsWith("--targets="))?.split("=", 2)[1] ?? Bun.env.RELEASE_TARGETS;

	if (!flagValue) {
		return null;
	}

	return new Set(
		flagValue
			.split(",")
			.map(value => value.trim())
			.filter(Boolean),
	);
}

function hostDefaultTargets(): BinaryTarget[] {
	// A bare invocation (no --targets / RELEASE_TARGETS) is a single-host
	// dogfood build, not a full release. Only the host's platform/arch can be
	// built here because `embed:native` requires a matching prebuilt addon, and
	// cross-arch addons are produced per-runner in CI. Default to the host
	// target instead of every release target so we never demand native addons
	// for architectures this machine cannot produce.
	return targets.filter(target => target.platform === process.platform && target.arch === process.arch);
}

function shouldAdhocSignDarwinBinary(target: BinaryTarget): boolean {
	return target.platform === "darwin" && process.platform === "darwin";
}

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function embedNative(target: BinaryTarget, topology: "monolith" | "core"): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun --cwd=packages/natives run embed:native [${target.platform}/${target.arch}/${topology}]`);
		return;
	}

	const embedEnv = {
		...Bun.env,
		TARGET_PLATFORM: target.platform,
		TARGET_ARCH: target.arch,
		...(target.arch === "x64" ? { EMBED_VARIANTS: "baseline" } : {}),
		...(topology === "core" ? { EMBED_TOPOLOGY: "core" } : {}),
	};

	await runCommand(["bun", "--cwd=packages/natives", "run", "embed:native"], repoRoot, embedEnv);
}

async function buildBinary(target: BinaryTarget, topology: "monolith" | "core"): Promise<void> {
	const outfile = topology === "core" ? target.coreOutfile : target.outfile;
	console.log(`Building ${outfile}...`);
	await embedNative(target, topology);
	const compileArgs = topology === "core"
		? buildCoreReleaseCompileArgs(target.target, outfile)
		: buildReleaseCompileArgs(target.target, outfile);
	if (isDryRun) {
		console.log(`DRY RUN ${compileArgs.join(" ")}`);
		return;
	}

	const buildEnv = shouldAdhocSignDarwinBinary(target)
		? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" }
		: Bun.env;
	await runCommand(compileArgs, repoRoot, buildEnv);

	// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
	if (shouldAdhocSignDarwinBinary(target)) {
		await runCommand(["codesign", "--force", "--sign", "-", path.join(repoRoot, outfile)], repoRoot);
	}
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --generate");
		return;
	}
	await runCommand(["bun", "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--generate"], repoRoot);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun --cwd=packages/natives run embed:native --reset");
		console.log("DRY RUN bun --cwd=packages/stats scripts/generate-client-bundle.ts --reset");
		return;
	}
	await runCommand(["bun", "--cwd=packages/natives", "run", "embed:native", "--reset"], repoRoot);
	await runCommand(["bun", "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--reset"], repoRoot);
}

async function main(): Promise<void> {
	const requestedTargets = parseRequestedTargets();
	const selectedTargets = requestedTargets
		? targets.filter(target => requestedTargets.has(target.id))
		: hostDefaultTargets();

	if (requestedTargets) {
		const unknownTargets = [...requestedTargets].filter(
			requestedTarget => !targets.some(target => target.id === requestedTarget),
		);
		if (unknownTargets.length > 0) {
			throw new Error(`Unknown release target(s): ${unknownTargets.join(", ")}`);
		}
	}

	if (selectedTargets.length === 0) {
		if (requestedTargets) {
			throw new Error("No release targets selected.");
		}
		throw new Error(
			`No release target matches this host (${process.platform}-${process.arch}). ` +
				`Pass --targets <id> or set RELEASE_TARGETS to build a specific target.`,
		);
	}

	await fs.mkdir(binariesDir, { recursive: true });
	await generateBundle();
	try {
		for (const target of selectedTargets) {
			await buildBinary(target, "monolith");
			await buildBinary(target, "core");
		}
	} finally {
		await resetArtifacts();
	}
}

await main();
