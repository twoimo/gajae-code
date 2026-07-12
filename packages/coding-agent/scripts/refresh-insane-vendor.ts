#!/usr/bin/env bun
/** Deterministically reproduce the insane-search runtime from its checked archive. */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "fflate";

export interface InsaneVendorManifest {
	upstream: {
		repo: string;
		commit: string;
		archiveUrl: string;
		archiveSha256: string;
		provenance: { source: "github-codeload"; commitApiUrl: string; verifiedAt: string };
	};
	sourceArchive: { path: string; kind: "github-codeload"; root: string };
	includedFileMapping: Record<string, string>;
	patches: string[];
	patchHashes: Record<string, string>;
	files: Record<string, string>;
	metadataFiles: string[];
}

export interface VendorCheckResult {
	failures: string[];
	manifest?: InsaneVendorManifest;
}

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultVendorDir = path.join(packageDir, "vendor", "insane-search");

function digest(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function safePath(value: string): boolean {
	return value !== "" && !path.posix.isAbsolute(value) && !value.split("/").includes("..") && !value.includes("\\");
}

async function regularFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full).split(path.sep).join("/");
			if (entry.isSymbolicLink()) throw new Error(`symlink is not permitted: ${rel}`);
			if (entry.isDirectory()) await visit(full);
			else if (entry.isFile()) result.push(rel);
			else throw new Error(`non-regular file is not permitted: ${rel}`);
		}
	}
	await visit(root);
	return result.sort();
}

function readTarEntries(compressed: Uint8Array): Array<{ name: string; bytes: Uint8Array }> {
	const tar = gunzipSync(compressed);
	const entries: Array<{ name: string; bytes: Uint8Array }> = [];
	const decoder = new TextDecoder();
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
		const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
		const fullName = prefix ? `${prefix}/${name}` : name;
		const type = header[156] ?? 0;
		const sizeText = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
		const size = Number.parseInt(sizeText || "0", 8);
		if (!safePath(fullName) || !Number.isSafeInteger(size) || size < 0)
			throw new Error(`unsafe archive entry: ${fullName}`);
		const start = offset + 512;
		const end = start + size;
		if (end > tar.length) throw new Error(`truncated archive entry: ${fullName}`);
		if (type === 103) {
			if (fullName !== "pax_global_header") throw new Error(`unexpected extended archive header: ${fullName}`);
			offset = start + Math.ceil(size / 512) * 512;
			continue;
		}
		if (type === 53) {
			if (!fullName.endsWith("/")) throw new Error(`invalid archive directory entry: ${fullName}`);
			offset = start + Math.ceil(size / 512) * 512;
			continue;
		}
		if (type !== 0 && type !== 48) throw new Error(`archive entry is not a regular file: ${fullName}`);
		if (entries.some(entry => entry.name === fullName)) throw new Error(`duplicate archive entry: ${fullName}`);
		entries.push({ name: fullName, bytes: tar.slice(start, end) });
		offset = start + Math.ceil(size / 512) * 512;
	}
	return entries;
}

async function loadManifest(vendorDir: string): Promise<InsaneVendorManifest> {
	const parsed: unknown = JSON.parse(await Bun.file(path.join(vendorDir, "MANIFEST.json")).text());
	if (!parsed || typeof parsed !== "object") throw new Error("MANIFEST.json must be an object");
	const manifest = parsed as InsaneVendorManifest;
	if (!/^[0-9a-f]{40}$/.test(manifest.upstream?.commit ?? ""))
		throw new Error("MANIFEST upstream.commit must be a 40-character SHA");
	if (!/^[0-9a-f]{64}$/.test(manifest.upstream?.archiveSha256 ?? ""))
		throw new Error("MANIFEST upstream.archiveSha256 must be SHA-256");
	const commit = manifest.upstream.commit;
	if (
		manifest.upstream.repo !== "https://github.com/fivetaku/insane-search" ||
		manifest.upstream.archiveUrl !== `https://codeload.github.com/fivetaku/insane-search/tar.gz/${commit}` ||
		manifest.upstream.provenance?.source !== "github-codeload" ||
		manifest.upstream.provenance.commitApiUrl !==
			`https://api.github.com/repos/fivetaku/insane-search/commits/${commit}` ||
		!/^\d{4}-\d{2}-\d{2}$/.test(manifest.upstream.provenance.verifiedAt) ||
		manifest.sourceArchive?.kind !== "github-codeload"
	)
		throw new Error("MANIFEST upstream provenance must link the checked GitHub codeload archive to its commit");
	if (!Array.isArray(manifest.patches) || !manifest.files || !manifest.sourceArchive?.root)
		throw new Error("MANIFEST reproducibility fields are missing");
	return manifest;
}

async function applyPatches(sourceDir: string, vendorDir: string, manifest: InsaneVendorManifest): Promise<void> {
	for (const patchName of manifest.patches) {
		if (!safePath(patchName) || path.posix.dirname(patchName) !== ".")
			throw new Error(`unsafe patch filename: ${patchName}`);
		const patch = path.join(vendorDir, "patches", patchName);
		const bytes = await Bun.file(patch).arrayBuffer();
		if (digest(new Uint8Array(bytes)) !== manifest.patchHashes[patchName])
			throw new Error(`patch digest mismatch: ${patchName}`);
		const child = Bun.spawnSync({
			cmd: ["git", "apply", "--whitespace=nowarn", patch],
			cwd: sourceDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (child.exitCode !== 0) throw new Error(`patch failed: ${patchName}: ${child.stderr.toString().trim()}`);
	}
}

async function reproduce(vendorDir: string, manifest: InsaneVendorManifest): Promise<string> {
	const archive = path.join(vendorDir, manifest.sourceArchive.path);
	const archiveBytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
	if (digest(archiveBytes) !== manifest.upstream.archiveSha256)
		throw new Error("pinned source archive digest mismatch (archive is verified before extraction)");
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-insane-vendor-"));
	try {
		const root = `${manifest.sourceArchive.root}/`;
		for (const entry of readTarEntries(archiveBytes)) {
			if (!entry.name.startsWith(root)) throw new Error(`archive entry outside pinned root: ${entry.name}`);
			const source = entry.name.slice(root.length);
			let destination: string | undefined;
			if (source === "LICENSE") destination = "LICENSE";
			else if (source.startsWith("skills/insane-search/engine/"))
				destination = `engine/${source.slice("skills/insane-search/engine/".length)}`;
			if (!destination) continue;
			if (!safePath(destination)) throw new Error(`unsafe mapped archive path: ${destination}`);
			const output = path.join(temp, destination);
			await fs.mkdir(path.dirname(output), { recursive: true });
			await Bun.write(output, entry.bytes);
		}
		await applyPatches(temp, vendorDir, manifest);
		return temp;
	} catch (error) {
		await fs.rm(temp, { recursive: true, force: true });
		throw error;
	}
}

export async function checkInsaneVendor(vendorDir = defaultVendorDir): Promise<VendorCheckResult> {
	const failures: string[] = [];
	try {
		const manifest = await loadManifest(vendorDir);
		const checksum = (await Bun.file(path.join(vendorDir, "MANIFEST.sha256")).text()).trim().split(/\s+/)[0];
		if (checksum !== digest(new TextEncoder().encode(await Bun.file(path.join(vendorDir, "MANIFEST.json")).text())))
			failures.push("MANIFEST.json digest mismatch");
		const reproduced = await reproduce(vendorDir, manifest);
		try {
			const expected = new Set([
				...Object.keys(manifest.files),
				...manifest.metadataFiles,
				manifest.sourceArchive.path,
				...manifest.patches.map(name => `patches/${name}`),
			]);
			for (const file of await regularFiles(vendorDir))
				if (!expected.has(file)) failures.push(`unlisted vendor file: ${file}`);
			for (const [file, hash] of Object.entries(manifest.files)) {
				const actual = path.join(vendorDir, file);
				const generated = path.join(reproduced, file);
				if (!safePath(file) || !/^[0-9a-f]{64}$/.test(hash)) {
					failures.push(`invalid file integrity entry: ${file}`);
					continue;
				}
				if (!(await Bun.file(actual).exists())) {
					failures.push(`vendored byte digest mismatch: ${file}`);
					continue;
				}
				if (digest(new Uint8Array(await Bun.file(actual).arrayBuffer())) !== hash)
					failures.push(`vendored byte digest mismatch: ${file}`);
				else if (digest(new Uint8Array(await Bun.file(generated).arrayBuffer())) !== hash)
					failures.push(`reproduction mismatch: ${file}`);
			}
			return { failures, manifest };
		} finally {
			await fs.rm(reproduced, { recursive: true, force: true });
		}
	} catch (error) {
		failures.push((error as Error).message);
		return { failures };
	}
}

export async function refreshInsaneVendor(vendorDir = defaultVendorDir): Promise<void> {
	const manifest = await loadManifest(vendorDir);
	const reproduced = await reproduce(vendorDir, manifest);
	try {
		for (const file of Object.keys(manifest.files)) {
			const source = path.join(reproduced, file);
			const destination = path.join(vendorDir, file);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await Bun.write(destination, await Bun.file(source).arrayBuffer());
		}
	} finally {
		await fs.rm(reproduced, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 0 || (args.length === 1 && args[0] === "--refresh")) {
		await refreshInsaneVendor();
		const result = await checkInsaneVendor();
		if (result.failures.length > 0)
			throw new Error(`insane vendor refresh failed:\n${result.failures.map(item => `- ${item}`).join("\n")}`);
		console.log(`insane vendor refreshed (${result.manifest?.upstream.commit})`);
	} else if (args.length === 1 && args[0] === "--check") {
		const result = await checkInsaneVendor();
		if (result.failures.length > 0)
			throw new Error(`insane vendor check failed:\n${result.failures.map(item => `- ${item}`).join("\n")}`);
		console.log(`insane vendor refresh check passed (${result.manifest?.upstream.commit})`);
	} else throw new Error("usage: refresh-insane-vendor.ts [--check|--refresh]");
}
