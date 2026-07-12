import { describe, expect, it, vi } from "bun:test";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalizeCustomPublicBase,
	isSameOrDescendant,
	pathsOverlap,
	validateVisibleSessionName,
	visibleSessionPaths,
} from "./paths";

async function withTempDir<T>(fn: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(join(tmpdir(), "gjc-visible-paths-"));
	try {
		return await fn(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}
function directoryStats(symbolicLink: boolean): Stats {
	return {
		isDirectory: () => true,
		isSymbolicLink: () => symbolicLink,
	} as unknown as Stats;
}

describe("visible session paths", () => {
	it("validates the complete NAME character and platform key contract", () => {
		expect(validateVisibleSessionName("Alpha.1_-", "posix")).toEqual({ displayName: "Alpha.1_-", key: "Alpha.1_-" });
		expect(validateVisibleSessionName("Alpha.1_-", "win32")).toEqual({ displayName: "Alpha.1_-", key: "alpha.1_-" });
		for (const invalid of [
			"",
			".",
			"..",
			"-name",
			"_name",
			".name",
			"has space",
			"slash/name",
			"back\\name",
			"é",
			"a".repeat(65),
		]) {
			expect(() => validateVisibleSessionName(invalid)).toThrow();
		}
		for (const reserved of ["CON", "nul.txt"]) {
			expect(() => validateVisibleSessionName(reserved, "win32")).toThrow();
		}
		expect(() => validateVisibleSessionName("trailing.", "win32")).toThrow();
	});

	it("keeps visible-session package paths private", async () => {
		const manifest: { exports: Record<string, unknown> } = await Bun.file(
			new URL("../../package.json", import.meta.url),
		).json();
		const exportKeys = Object.keys(manifest.exports);
		const rootGuardIndex = exportKeys.indexOf("./visible-session");
		const descendantsGuardIndex = exportKeys.indexOf("./visible-session/*");
		const wildcardIndex = exportKeys.indexOf("./*");
		expect(manifest.exports["./visible-session"]).toBeNull();
		expect(manifest.exports["./visible-session/*"]).toBeNull();
		expect(rootGuardIndex).toBeGreaterThanOrEqual(0);
		expect(descendantsGuardIndex).toBeGreaterThanOrEqual(0);
		expect(wildcardIndex).toBeGreaterThanOrEqual(0);
		expect(rootGuardIndex).toBeLessThan(wildcardIndex);
		expect(descendantsGuardIndex).toBeLessThan(wildcardIndex);
	});

	it("rejects protected custom public bases in both containment directions", async () => {
		await withTempDir(async directory => {
			const parent = join(directory, "parent");
			const protectedPath = join(parent, "protected");
			const descendant = join(protectedPath, "child");
			const sibling = join(parent, "protected-sibling");
			await fs.mkdir(protectedPath, { recursive: true });
			const cases = [
				{ base: protectedPath, overlaps: true },
				{ base: descendant, overlaps: true },
				{ base: parent, overlaps: true },
				{ base: sibling, overlaps: false },
			];
			for (const { base, overlaps } of cases) {
				expect(isSameOrDescendant(base, protectedPath) || isSameOrDescendant(protectedPath, base)).toBe(overlaps);
				expect(pathsOverlap(base, protectedPath)).toBe(overlaps);
				if (overlaps) await expect(canonicalizeCustomPublicBase(base, [protectedPath])).rejects.toThrow("overlaps");
				else await expect(canonicalizeCustomPublicBase(base, [protectedPath])).resolves.toBe(base);
			}
			await expect(canonicalizeCustomPublicBase("relative", [])).rejects.toThrow();
			const paths = visibleSessionPaths(directory);
			expect(paths.privateRoot).toBe(join(directory, "visible-sessions", "private"));
		});
	});
	it("rejects reparse ancestors and bases from deterministic lstat and realpath evidence", async () => {
		const parent = join(tmpdir(), "gjc-visible-paths-parent");
		const base = join(parent, "base");
		const scenarios = [
			{
				name: "lstat reports a link",
				canonicalParent: parent,
				canonicalBase: base,
				stats: directoryStats(true),
			},
			{
				name: "realpath exposes a reparse point lstat reports as a directory",
				canonicalParent: parent,
				canonicalBase: join(parent, "resolved-base"),
				stats: directoryStats(false),
			},
		];
		for (const scenario of scenarios) {
			const access = vi.spyOn(fs, "access").mockImplementation((async () => undefined) as typeof fs.access);
			const realpath = vi.spyOn(fs, "realpath").mockImplementation((async target => {
				if (target === parent) return scenario.canonicalParent;
				if (target === base) return scenario.canonicalBase;
				throw new Error(`unexpected realpath target: ${target}`);
			}) as typeof fs.realpath);
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async target => {
				expect(target).toBe(base);
				return scenario.stats;
			}) as typeof fs.lstat);
			try {
				await expect(canonicalizeCustomPublicBase(base, [])).rejects.toThrow(
					/symlink or reparse point|real directory/,
				);
				expect(realpath).toHaveBeenCalledWith(parent);
				expect(lstat).toHaveBeenCalledWith(base);
				if (!scenario.stats.isSymbolicLink()) expect(realpath).toHaveBeenCalledWith(base);
			} finally {
				lstat.mockRestore();
				realpath.mockRestore();
				access.mockRestore();
			}
		}
	});
	it("rejects a reparse ancestor when parent realpath differs", async () => {
		const parent = join(tmpdir(), "gjc-visible-paths-parent");
		const base = join(parent, "base");
		const canonicalParent = join(tmpdir(), "gjc-visible-paths-resolved-parent");
		const access = vi.spyOn(fs, "access").mockImplementation((async () => undefined) as typeof fs.access);
		const realpath = vi.spyOn(fs, "realpath").mockImplementation((async target => {
			if (target === parent) return canonicalParent;
			throw new Error(`unexpected realpath target: ${target}`);
		}) as typeof fs.realpath);
		const lstat = vi.spyOn(fs, "lstat");
		try {
			await expect(canonicalizeCustomPublicBase(base, [])).rejects.toThrow("symlink or reparse point");
			expect(realpath).toHaveBeenCalledWith(parent);
			expect(lstat).not.toHaveBeenCalled();
		} finally {
			lstat.mockRestore();
			realpath.mockRestore();
			access.mockRestore();
		}
	});
	it.skipIf(process.platform === "win32")(
		"integration (POSIX only): rejects a custom base beneath a directory symlink",
		async () => {
			await withTempDir(async directory => {
				const parent = join(directory, "parent");
				const target = join(directory, "target");
				await Promise.all([fs.mkdir(parent), fs.mkdir(target)]);
				const alias = join(parent, "alias");
				await fs.symlink(target, alias, "dir");
				await expect(canonicalizeCustomPublicBase(join(alias, "base"), [])).rejects.toThrow("symlink");
			});
		},
	);
});
