#!/usr/bin/env bun

import * as path from "node:path";

interface RootPackage {
	workspaces?: { catalog?: Record<string, string> };
}

export async function verifyReleaseCandidateVersion(
	releaseVersion: string,
	repoRoot = path.join(import.meta.dir, ".."),
): Promise<string[]> {
	const rootPackage = await Bun.file(path.join(repoRoot, "package.json")).json() as RootPackage;
	const canonicalVersion = rootPackage.workspaces?.catalog?.["@gajae-code/coding-agent"];
	if (!canonicalVersion) return ["package.json is missing the canonical @gajae-code/coding-agent catalog version"];
	if (releaseVersion !== canonicalVersion) {
		return [`Release version ${releaseVersion} does not match candidate canonical version ${canonicalVersion}`];
	}
	return [];
}

if (import.meta.main) {
	const versionIndex = process.argv.indexOf("--version");
	const releaseVersion = versionIndex >= 0 ? process.argv[versionIndex + 1] : "";
	if (!releaseVersion) throw new Error("Usage: verify-release-candidate-version.ts --version <version>");
	const errors = await verifyReleaseCandidateVersion(releaseVersion);
	if (errors.length > 0) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	console.log(`Release candidate version ${releaseVersion} matches the canonical package version.`);
}
