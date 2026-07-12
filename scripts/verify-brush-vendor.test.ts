import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const copies: string[] = [];

async function vendorCopy(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-brush-vendor-test-"));
	copies.push(directory);
	await fs.cp(path.join(root, "crates"), path.join(directory, "crates"), { recursive: true });
	return directory;
}

function checkVendor(directory: string) {
	return Bun.spawnSync(["bun", "scripts/refresh-brush-vendor.ts", "--check", "--root", directory], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function assertRejected(directory: string, expected: string): void {
	const result = checkVendor(directory);
	const output = `${result.stdout.toString()}${result.stderr.toString()}`;
	expect(result.exitCode, output).not.toBe(0);
	expect(output).toContain(expected);
}

async function flipByte(file: string): Promise<void> {
	const bytes = await fs.readFile(file);
	bytes[0] = bytes[0]! ^ 1;
	await Bun.write(file, bytes);
}

afterEach(async () => {
	await Promise.all(copies.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("Brush vendor reproducibility", () => {
	test("checked archives, ordered patches, and vendored trees reproduce exactly", () => {
		const result = checkVendor(root);
		expect(result.exitCode, result.stderr.toString()).toBe(0);
	});

	test("rejects one-byte changes to every pinned vendor input and checked tree class", async () => {
		const cases: Array<[string, (directory: string) => Promise<void>, string]> = [
			[
				"archive",
				directory => flipByte(path.join(directory, "crates", "brush-core-0.5.0.crate")),
				"pinned archive digest mismatch",
			],
			[
				"manifest",
				async directory => {
					const manifest = await Bun.file(path.join(directory, "crates", "brush-vendor.json")).text();
					await Bun.write(path.join(directory, "crates", "brush-vendor.json"), manifest.replace('"schemaVersion": 1', '"schemaVersion": 2'));
				},
				"invalid Brush vendor manifest provenance",
			],
			[
				"first patch",
				directory => flipByte(path.join(directory, "crates", "brush-patches", "0001-vendored-normalization.patch")),
				"pinned patch digest mismatch: 0001-vendored-normalization.patch",
			],
			[
				"second patch",
				directory => flipByte(path.join(directory, "crates", "brush-patches", "0002-child-session-action.patch")),
				"pinned patch digest mismatch: 0002-child-session-action.patch",
			],
			[
				"source tree file",
				directory => flipByte(path.join(directory, "crates", "brush-core-vendored", "src", "commands.rs")),
				"checked vendor trees differs at brush-core-vendored/src/commands.rs",
			],
			[
				"lockfile",
				directory => flipByte(path.join(directory, "crates", "brush-core-vendored", "Cargo.lock")),
				"checked vendor trees differs at brush-core-vendored/Cargo.lock",
			],
			[
				"unlisted extra file",
				directory => Bun.write(path.join(directory, "crates", "brush-core-vendored", "unexpected.txt"), "x").then(() => undefined),
				"checked vendor trees has missing or unlisted files",
			],
		];
		for (const [_name, mutate, expected] of cases) {
			const directory = await vendorCopy();
			await mutate(directory);
			assertRejected(directory, expected);
		}
	});
});
