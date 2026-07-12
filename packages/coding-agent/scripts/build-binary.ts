#!/usr/bin/env bun

import * as path from "node:path";
import { buildCoreDevCompileArgs, buildDevCompileArgs } from "./compile-args";

const packageDir = path.join(import.meta.dir, "..");
const outputPath = path.join(packageDir, "dist", "gjc");
const coreOutputPath = path.join(packageDir, "dist", "gjc-core");
const nativeDir = path.join(packageDir, "..", "natives", "native");

function shouldAdhocSignDarwinBinary(): boolean {
	return process.platform === "darwin";
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}
async function stageWorkspaceNativeAddons(): Promise<void> {
	await Array.fromAsync(new Bun.Glob("pi_natives.*.node").scan({ cwd: nativeDir }), async filename => {
		await Bun.write(path.join(packageDir, "dist", filename), Bun.file(path.join(nativeDir, filename)));
	});
}

async function buildSku(topology: "monolith" | "core", output: string): Promise<void> {
	const embedEnv = topology === "core" ? { ...Bun.env, EMBED_TOPOLOGY: "core" } : Bun.env;
	await runCommand(["bun", "--cwd=../natives", "run", "embed:native"], embedEnv);
	try {
		const buildEnv = shouldAdhocSignDarwinBinary() ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : Bun.env;
		await runCommand(topology === "core" ? buildCoreDevCompileArgs() : buildDevCompileArgs(), buildEnv);
		if (topology === "monolith") await stageWorkspaceNativeAddons();
		// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
		if (shouldAdhocSignDarwinBinary()) {
			await runCommand(["codesign", "--force", "--sign", "-", output]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../natives", "run", "embed:native", "--reset"]);
	}
}

async function main(): Promise<void> {
	await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--generate"]);
	try {
		await buildSku("monolith", outputPath);
		await buildSku("core", coreOutputPath);
	} finally {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--reset"]);
	}
}

await main();
