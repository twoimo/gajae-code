import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface TelegramDaemonBuildMetadata {
	buildId: string;
	buildTarget: string;
}

type EmbeddedAddonManifest = {
	platformTag: string;
	version: string;
	files: Array<{ variant: "modern" | "baseline" | "default"; filename: string }>;
} | null;

const BUILD_TARGETS = new Map<string, string>([
	["darwin-arm64", "bun-darwin-arm64"],
	["darwin-x64", "bun-darwin-x64-baseline"],
	["linux-arm64", "bun-linux-arm64"],
	["linux-x64", "bun-linux-x64-baseline"],
	["win32-x64", "bun-windows-x64-modern"],
]);

const BUILD_ID_INPUT_DIRS = ["packages/coding-agent/src/sdk/bus"];
const BUILD_ID_INPUT_FILES = [
	"packages/coding-agent/scripts/compile-args.ts",
	"packages/coding-agent/src/cli/notify-cli.ts",
	"packages/natives/native/embedded-addon.js",
	"packages/natives/native/loader-state.js",
	"packages/stats/src/embedded-client.generated.txt",
];

function normalizeRelativePath(value: string): string {
	return value.split(path.sep).join("/");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

async function collectRelativeFiles(repoRoot: string, relativeDir: string): Promise<string[]> {
	const dir = path.join(repoRoot, relativeDir);
	const entries = await fs.readdir(dir, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	const results: string[] = [];
	for (const entry of entries) {
		const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
		if (entry.isDirectory()) {
			results.push(...(await collectRelativeFiles(repoRoot, relativePath)));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		results.push(relativePath);
	}
	return results;
}

function requiredMatch(text: string, pattern: RegExp, field: string): string {
	const match = text.match(pattern);
	if (!match?.[2]) throw new Error(`Malformed embedded-addon manifest: missing ${field}.`);
	return match[2];
}

async function readEmbeddedAddonManifest(repoRoot: string): Promise<EmbeddedAddonManifest> {
	const source = await Bun.file(path.join(repoRoot, "packages/natives/native/embedded-addon.js")).text();
	if (/export const embeddedAddon = null;/.test(source)) return null;
	const platformTag = requiredMatch(source, /platformTag:\s*(["'])(.*?)\1/, "platformTag");
	const version = requiredMatch(source, /version:\s*(["'])(.*?)\1/, "version");
	const fileMatches = Array.from(
		source.matchAll(
			/variant:\s*(["'])(modern|baseline|default)\1\s*,\s*filename:\s*(["'])([^"']+)\3/g,
		),
		match => ({
			variant: match[2] as "modern" | "baseline" | "default",
			filename: match[4]!,
		}),
	);
	if (fileMatches.length === 0) throw new Error("Malformed embedded-addon manifest: missing files.");
	return { platformTag, version, files: fileMatches };
}

async function hashRelativeFile(repoRoot: string, relativePath: string): Promise<{ path: string; sha256: string }> {
	const filePath = path.join(repoRoot, relativePath);
	const stat = await fs.stat(filePath);
	if (!stat.isFile()) throw new Error(`Telegram daemon build input is not a regular file: ${relativePath}`);
	const bytes = await Bun.file(filePath).arrayBuffer();
	return {
		path: relativePath,
		sha256: crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
	};
}

export function normalizeTelegramDaemonBuildTarget(
	platform: NodeJS.Platform | string = process.platform,
	arch: string = process.arch,
): string {
	const key = `${platform}-${arch}`;
	const target = BUILD_TARGETS.get(key);
	if (!target) throw new Error(`Unsupported Telegram daemon build target host: ${key}`);
	return target;
}

export function buildTelegramDaemonDefineFlags(metadata: TelegramDaemonBuildMetadata): string[] {
	return [
		`process.env.GJC_TELEGRAM_DAEMON_BUILD_ID=${JSON.stringify(metadata.buildId)}`,
		`process.env.GJC_TELEGRAM_DAEMON_BUILD_TARGET=${JSON.stringify(metadata.buildTarget)}`,
	];
}

export async function computeTelegramDaemonBuildMetadata(input: {
	repoRoot: string;
	target: string;
}): Promise<TelegramDaemonBuildMetadata> {
	const repoRoot = path.resolve(input.repoRoot);
	const relativePaths = new Set<string>(BUILD_ID_INPUT_FILES);
	for (const relativeDir of BUILD_ID_INPUT_DIRS)
		for (const relativePath of await collectRelativeFiles(repoRoot, relativeDir)) relativePaths.add(relativePath);
	const embeddedAddon = await readEmbeddedAddonManifest(repoRoot);
	if (embeddedAddon)
		for (const file of embeddedAddon.files)
			relativePaths.add(normalizeRelativePath(path.join("packages/natives/native", file.filename)));
	const files = await Promise.all(
		[...relativePaths].sort((left, right) => left.localeCompare(right)).map(relativePath => hashRelativeFile(repoRoot, relativePath)),
	);
	const descriptor = stableJson({ algorithm: "tdb1", target: input.target, files });
	return {
		buildId: crypto.createHash("sha256").update(descriptor).digest("hex"),
		buildTarget: input.target,
	};
}
