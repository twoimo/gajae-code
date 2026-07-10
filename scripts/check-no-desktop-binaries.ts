#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const desktopDir = "crates/gjc-desktop";
const binariesDir = `${desktopDir}/binaries`;
const maxTrackedFileSize = 50 * 1024 * 1024;

async function trackedFiles(directory: string): Promise<string[]> {
	const proc = Bun.spawn(["git", "ls-files", directory], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to list tracked files under ${directory}: ${stderr.trim() || `git exited with code ${exitCode}`}`);
	}
	return stdout.split("\n").filter(Boolean);
}

async function main(): Promise<void> {
	const trackedBinaries = await trackedFiles(binariesDir);
	if (trackedBinaries.length > 0) {
		throw new Error(
			`Tracked desktop sidecar binaries are forbidden. Remove these files from Git:\n${trackedBinaries.map(file => `  - ${file}`).join("\n")}`,
		);
	}

	const oversizedFiles: string[] = [];
	for (const file of await trackedFiles(desktopDir)) {
		const filePath = path.join(repoRoot, file);
		let stat: Stats;
		try {
			stat = await fs.stat(filePath);
		} catch (err) {
			throw new Error(`Failed to inspect tracked desktop file ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (stat.isFile() && stat.size > maxTrackedFileSize) {
			oversizedFiles.push(`${file} (${stat.size} bytes)`);
		}
	}
	if (oversizedFiles.length > 0) {
		throw new Error(
			`Tracked files under ${desktopDir} must not exceed 50MB. Remove these files from Git:\n${oversizedFiles.map(file => `  - ${file}`).join("\n")}`,
		);
	}
}

await main();
