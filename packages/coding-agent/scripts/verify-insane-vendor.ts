#!/usr/bin/env bun
/** Verify the checked insane-search archive, deterministic patch replay, and package payload. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkInsaneVendor, defaultVendorDir } from "./refresh-insane-vendor";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];
const fail = (message: string): void => {
	failures.push(message);
};

const checked = await checkInsaneVendor(defaultVendorDir);
failures.push(...checked.failures);

async function walk(root: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(root, full).split(path.sep).join("/");
			if (entry.isSymbolicLink()) fail(`symlink is forbidden: ${rel}`);
			else if (entry.isDirectory()) await visit(full);
			else if (entry.isFile()) files.push(rel);
			else fail(`non-regular vendor entry: ${rel}`);
		}
	}
	await visit(root);
	return files;
}

try {
	const files = await walk(defaultVendorDir);
	const forbiddenNames = new Set(["setup.sh", "gptaku-update-check.cjs"]);
	const forbiddenSubpaths = [".claude-plugin/", "/references/", "/tests/coverage_battery"];
	const forbiddenPatterns: Array<[RegExp, string]> = [
		[/user\/starred/, "github star-baiting (user/starred)"],
		[/gh\s+api\s+-X\s+PUT/, "gh api star write"],
		[/SessionStart/, "settings.json SessionStart hook injection"],
		[/\.claude\/projects/, "past-session transcript scanner"],
	];
	for (const file of files) {
		if (forbiddenNames.has(path.posix.basename(file))) fail(`forbidden file present: ${file}`);
		if (forbiddenSubpaths.some(part => `/${file}`.includes(part))) fail(`forbidden path present: ${file}`);
		if (file === "MANIFEST.json") continue;
		const content = await Bun.file(path.join(defaultVendorDir, file))
			.text()
			.catch(() => "");
		for (const [pattern, label] of forbiddenPatterns)
			if (pattern.test(content)) fail(`forbidden pattern (${label}) found in ${file}`);
	}
} catch (error) {
	fail(`vendor tree scan failed: ${(error as Error).message}`);
}

for (const required of [
	"engine/__main__.py",
	"engine/__init__.py",
	"engine/fetch_chain.py",
	"engine/templates/package.json",
	"engine/templates/playwright_real_chrome.js",
	"engine/waf_profiles.yaml",
	"LICENSE",
	"MANIFEST.json",
]) {
	if (!(await Bun.file(path.join(defaultVendorDir, required)).exists()))
		fail(`required vendored file missing: ${required}`);
}

try {
	const packed = JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: packageDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}),
	) as Array<{ files?: Array<{ path: string }> }>;
	const files = new Set((packed[0]?.files ?? []).map(file => file.path.replace(/\\/g, "/")));
	for (const required of [
		"vendor/insane-search/engine/__main__.py",
		"vendor/insane-search/engine/templates/playwright_real_chrome.js",
		"vendor/insane-search/LICENSE",
		"vendor/insane-search/MANIFEST.json",
	])
		if (!files.has(required)) fail(`package pack does not include ${required}`);
} catch (error) {
	fail(`npm pack --dry-run failed: ${(error as Error).message}`);
}

if (failures.length > 0)
	throw new Error(`insane-vendor verification FAILED:\n${failures.map(failure => `- ${failure}`).join("\n")}`);
console.log(`insane-vendor verification passed (pinned ${checked.manifest?.upstream.commit}).`);
