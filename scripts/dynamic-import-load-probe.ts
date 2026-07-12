#!/usr/bin/env bun
import * as path from "node:path";
import {
	readDynamicImportManifest,
	type DynamicImportException,
	type DynamicImportProbe,
} from "./check-dynamic-import-policy";

export interface DynamicImportProbeResult {
	probe: DynamicImportProbe;
	importer: string;
	target: string;
}

function resolveTarget(entry: DynamicImportException, repoRoot: string): string {
	const importer = path.resolve(repoRoot, entry.importer);
	if (entry.target.startsWith("expression:")) return importer;
	return Bun.resolveSync(entry.target, path.dirname(importer));
}

export async function probeDynamicImportEntry(
	entry: DynamicImportException,
	repoRoot = path.resolve(import.meta.dir, ".."),
): Promise<DynamicImportProbeResult> {
	if (entry.probe === "handshake") {
		return { probe: entry.probe, importer: entry.importer, target: entry.target };
	}
	const resolved = resolveTarget(entry, repoRoot);
	if (entry.probe === "load") await import(resolved);
	return { probe: entry.probe, importer: entry.importer, target: entry.target };
}

export async function probeDynamicImportManifest(
	repoRoot = path.resolve(import.meta.dir, ".."),
	manifestPath = path.join(repoRoot, "scripts/dynamic-import-exceptions.json"),
): Promise<DynamicImportProbeResult[]> {
	const manifest = await readDynamicImportManifest(manifestPath);
	const results: DynamicImportProbeResult[] = [];
	for (const entry of manifest) {
		try {
			results.push(await probeDynamicImportEntry(entry, repoRoot));
		} catch (error) {
			throw new Error(`Dynamic-import ${entry.probe} probe failed: ${entry.importer} -> ${entry.target}`, {
				cause: error,
			});
		}
	}
	return results;
}

if (import.meta.main) {
	const results = await probeDynamicImportManifest();
	const counts = Object.groupBy(results, result => result.probe);
	process.stdout.write(
		`PASS dynamic-import target probes (${results.length}: load=${counts.load?.length ?? 0}, resolve-only=${counts["resolve-only"]?.length ?? 0}, handshake=${counts.handshake?.length ?? 0})\n`,
	);
}
