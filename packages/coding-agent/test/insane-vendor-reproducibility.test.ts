import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkInsaneVendor, defaultVendorDir } from "../scripts/refresh-insane-vendor";

const copies: string[] = [];

async function vendorCopy(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-insane-vendor-test-"));
	copies.push(directory);
	await fs.cp(defaultVendorDir, directory, { recursive: true });
	return directory;
}

afterEach(async () => {
	await Promise.all(copies.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("insane-search vendor reproducibility", () => {
	it("replays the checked local archive and ordered patch series", async () => {
		const result = await checkInsaneVendor(await vendorCopy());
		expect(result.failures).toEqual([]);
	});

	it("rejects one-byte engine/manifest/archive changes, missing or extra files, and patch tampering", async () => {
		const cases: Array<[string, (directory: string) => Promise<unknown>, string]> = [
			[
				"engine",
				directory => Bun.write(path.join(directory, "engine", "__main__.py"), "x"),
				"vendored byte digest mismatch",
			],
			[
				"manifest",
				async directory => {
					const manifest = await Bun.file(path.join(directory, "MANIFEST.json")).text();
					await Bun.write(
						path.join(directory, "MANIFEST.json"),
						manifest.replace('"schemaVersion": 1', '"schemaVersion": 2'),
					);
				},
				"MANIFEST.json digest mismatch",
			],
			[
				"archive",
				directory =>
					Bun.write(
						path.join(directory, "source", "insane-search-49306346b59aa89b5e96d98e1104da0890deed72.tar.gz"),
						"x",
					),
				"pinned source archive digest mismatch",
			],
			["extra", directory => Bun.write(path.join(directory, "unexpected.py"), "x"), "unlisted vendor file"],
			[
				"missing",
				directory => fs.rm(path.join(directory, "engine", "__main__.py")),
				"vendored byte digest mismatch",
			],
			[
				"patch",
				directory => Bun.write(path.join(directory, "patches", "0001-content-safety-metadata.patch"), "x"),
				"patch digest mismatch",
			],
		];
		for (const [_name, mutate, message] of cases) {
			const directory = await vendorCopy();
			await mutate(directory);
			expect((await checkInsaneVendor(directory)).failures.join("\n")).toContain(message);
		}
	});
});
