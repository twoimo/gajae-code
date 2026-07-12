import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VisibleSessionName, VisibleSessionPlatform } from "./types";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const WINDOWS_RESERVED_NAMES = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	"com1",
	"com2",
	"com3",
	"com4",
	"com5",
	"com6",
	"com7",
	"com8",
	"com9",
	"lpt1",
	"lpt2",
	"lpt3",
	"lpt4",
	"lpt5",
	"lpt6",
	"lpt7",
	"lpt8",
	"lpt9",
]);

/** Validates an externally visible NAME before it is used in a filesystem path. */
export function validateVisibleSessionName(
	name: string,
	platform: VisibleSessionPlatform = process.platform === "win32" ? "win32" : "posix",
): VisibleSessionName {
	if (
		!NAME_PATTERN.test(name) ||
		name === "." ||
		name === ".." ||
		(platform === "win32" && (name.endsWith(".") || WINDOWS_RESERVED_NAMES.has(name.split(".")[0].toLowerCase())))
	) {
		throw new Error("Visible session NAME must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
	}
	return { displayName: name, key: platform === "win32" ? name.toLowerCase() : name };
}

export interface VisibleSessionPaths {
	agentDir: string;
	root: string;
	registryFile: string;
	privateRoot: string;
	defaultPublicBase: string;
}

export function visibleSessionPaths(agentDir: string): VisibleSessionPaths {
	const canonicalAgentDir = path.resolve(agentDir);
	const root = path.join(canonicalAgentDir, "visible-sessions");
	return {
		agentDir: canonicalAgentDir,
		root,
		registryFile: path.join(root, "registry.json"),
		privateRoot: path.join(root, "private"),
		defaultPublicBase: path.join(root, "public"),
	};
}

export function isSameOrDescendant(candidate: string, ancestor: string): boolean {
	const relative = path.relative(ancestor, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function pathsOverlap(first: string, second: string): boolean {
	return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

/**
 * Resolves a custom public base without accepting symlink/reparse traversal.
 * The base itself may not exist, but its direct parent must exist and be writable.
 */
export async function canonicalizeCustomPublicBase(base: string, protectedPaths: readonly string[]): Promise<string> {
	if (!path.isAbsolute(base)) throw new Error("Visible session public base must be absolute");
	const normalized = path.resolve(base);
	if (normalized === path.parse(normalized).root)
		throw new Error("Visible session public base cannot be a filesystem root");
	const parent = path.dirname(normalized);
	let canonicalParent: string;
	try {
		canonicalParent = await fs.realpath(parent);
		await fs.access(canonicalParent, fs.constants.W_OK);
	} catch {
		throw new Error("Visible session public base parent must exist and be user-writable");
	}
	const canonical = path.join(canonicalParent, path.basename(normalized));
	if (canonical !== normalized)
		throw new Error("Visible session public base cannot traverse a symlink or reparse point");
	try {
		const stats = await fs.lstat(normalized);
		if (stats.isSymbolicLink() || !stats.isDirectory())
			throw new Error("Visible session public base must be a real directory");
		const canonicalExistingBase = await fs.realpath(normalized);
		if (canonicalExistingBase !== canonical)
			throw new Error("Visible session public base cannot traverse a symlink or reparse point");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const protectedPath of protectedPaths) {
		if (pathsOverlap(canonical, protectedPath))
			throw new Error("Visible session public base overlaps a protected path");
	}
	return canonical;
}

export function publicGenerationRoot(base: string, key: string, generationId: string): string {
	return path.join(base, key, generationId);
}

export function privateGenerationRoot(privateRoot: string, key: string, generationId: string): string {
	return path.join(privateRoot, key, generationId);
}
