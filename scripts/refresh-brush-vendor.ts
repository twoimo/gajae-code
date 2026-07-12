#!/usr/bin/env bun
/** Rebuilds the checked Brush crates from immutable crate archives and patches. */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

type Archive = { file: string; sha256: string; cratePath: string; target: string };
type Manifest = {
	schemaVersion: 1;
	upstream: { repository: string; commit: string; importMethod: string };
	archives: Archive[];
	excludedFiles: string[];
	toolVersions: Record<string, string>;
	patches: string[];
	patchHashes: Record<string, string>;
	files: Record<string, string>;
};

const defaultRoot = path.resolve(import.meta.dir, "..");

function sha256(bytes: Uint8Array): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function run(command: string, args: string[], cwd?: string): void {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}
async function files(dir: string, prefix = ""): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const output: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const relative = `${prefix}${entry.name}`;
		if (entry.isDirectory()) output.push(...await files(path.join(dir, entry.name), `${relative}/`));
		else if (entry.isFile()) output.push(relative);
		else throw new Error(`vendor tree contains unsupported entry: ${relative}`);
	}
	return output;
}
async function digestTree(dir: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const file of await files(dir)) result[file] = sha256(await fs.readFile(path.join(dir, file)));
	return result;
}
function compare(expected: Record<string, string>, actual: Record<string, string>, label: string): void {
	const expectedPaths = Object.keys(expected).sort();
	const actualPaths = Object.keys(actual).sort();
	if (expectedPaths.join("\n") !== actualPaths.join("\n")) throw new Error(`${label} has missing or unlisted files`);
	for (const file of expectedPaths) if (expected[file] !== actual[file]) throw new Error(`${label} differs at ${file}`);
}

export async function refreshBrushVendor(root = defaultRoot, isCheck = false): Promise<void> {
	const manifestPath = path.join(root, "crates", "brush-vendor.json");
	const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Manifest;
	if (manifest.schemaVersion !== 1 || manifest.upstream.repository !== "https://github.com/reubeno/brush" || !/^[0-9a-f]{40}$/.test(manifest.upstream.commit)) throw new Error("invalid Brush vendor manifest provenance");
	if (!manifest.upstream.importMethod.includes("immutable crates.io archives")) throw new Error("invalid Brush vendor import method");
	if (!Array.isArray(manifest.archives) || !Array.isArray(manifest.patches) || manifest.patches.length === 0 || !manifest.patchHashes) throw new Error("invalid Brush vendor manifest shape");
	const stage = await fs.mkdtemp(path.join(os.tmpdir(), "brush-vendor-"));
	try {
		await fs.mkdir(path.join(stage, "crates"));
		for (const archive of manifest.archives) {
			const archivePath = path.join(root, "crates", archive.file);
			const bytes = await fs.readFile(archivePath);
			if (sha256(bytes) !== archive.sha256) throw new Error(`pinned archive digest mismatch: ${archive.file}`);
			run("tar", ["-xzf", archivePath, "-C", stage]);
			const source = path.join(stage, archive.cratePath);
			const target = path.join(stage, archive.target);
			await fs.rename(source, target);
			for (const excluded of manifest.excludedFiles) await fs.rm(path.join(target, excluded), { force: true });
		}
		for (const patch of manifest.patches) {
			if (!/^\d{4}-[a-z0-9-]+\.patch$/.test(patch)) throw new Error(`invalid patch name: ${patch}`);
			const expectedHash = manifest.patchHashes[patch];
			if (!/^[0-9a-f]{64}$/.test(expectedHash ?? "")) throw new Error(`missing pinned patch digest: ${patch}`);
			const patchPath = path.join(root, "crates", "brush-patches", patch);
			const patchBytes = await fs.readFile(patchPath);
			if (sha256(patchBytes) !== expectedHash) throw new Error(`pinned patch digest mismatch: ${patch}`);
			const result = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-d", stage], { input: patchBytes, encoding: "utf8" });
			if (result.status !== 0) throw new Error(`patch ${patch} did not apply: ${result.stderr || result.stdout}`);
		}
		const reproduced = await digestTree(path.join(stage, "crates"));
		if (isCheck) {
			compare(manifest.files, reproduced, "reproduced vendor tree");
			const core = await digestTree(path.join(root, "crates", "brush-core-vendored"));
			const builtins = await digestTree(path.join(root, "crates", "brush-builtins-vendored"));
			const checked = {
				...Object.fromEntries(Object.entries(core).map(([file, hash]) => [`brush-core-vendored/${file}`, hash])),
				...Object.fromEntries(Object.entries(builtins).map(([file, hash]) => [`brush-builtins-vendored/${file}`, hash])),
			};
			compare(manifest.files, checked, "checked vendor trees");
			console.log("Brush vendor check passed.");
		} else {
			await fs.rm(path.join(root, "crates", "brush-core-vendored"), { recursive: true });
			await fs.rm(path.join(root, "crates", "brush-builtins-vendored"), { recursive: true });
			await fs.cp(path.join(stage, "crates", "brush-core-vendored"), path.join(root, "crates", "brush-core-vendored"), { recursive: true });
			await fs.cp(path.join(stage, "crates", "brush-builtins-vendored"), path.join(root, "crates", "brush-builtins-vendored"), { recursive: true });
			console.log("Brush vendor trees refreshed; run --check before committing.");
		}
	} finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf("--root");
	const root = rootIndex === -1 ? defaultRoot : path.resolve(args[rootIndex + 1] ?? "");
	const remaining = rootIndex === -1 ? args : args.filter((_, index) => index !== rootIndex && index !== rootIndex + 1);
	if (rootIndex !== -1 && !args[rootIndex + 1]) throw new Error("Usage: bun scripts/refresh-brush-vendor.ts [--check|--refresh] [--root <directory>]");
	if (remaining.length > 1 || (remaining[0] !== undefined && remaining[0] !== "--check" && remaining[0] !== "--refresh")) throw new Error("Usage: bun scripts/refresh-brush-vendor.ts [--check|--refresh] [--root <directory>]");
	await refreshBrushVendor(root, remaining[0] === "--check");
}
