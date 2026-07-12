import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateSessionStorageFixture, verifySessionStorageFixture } from "./generate-session-storage-fixtures";

const ONE_MEBIBYTE_WITH_EXACT_RATIO = 1024 * 1024 + 4;
const fixtureDirectories: string[] = [];

async function temporaryFixtureDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-storage-fixture-test-"));
	fixtureDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(fixtureDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("session storage fixture generator", () => {
	it("generates an exact-size v1-compatible journal with an exact 10% external segment ratio", async () => {
		const outputDir = await temporaryFixtureDirectory();
		const summary = await generateSessionStorageFixture({
			outputDir,
			journalBytes: ONE_MEBIBYTE_WITH_EXACT_RATIO,
			seed: 42n,
		});

		await verifySessionStorageFixture(summary);
		expect(summary.journalBytes).toBe(ONE_MEBIBYTE_WITH_EXACT_RATIO);
		expect(summary.segmentTotalBytes).toBe(ONE_MEBIBYTE_WITH_EXACT_RATIO / 10);
		expect(summary.ratio).toBe(0.1);
		expect(summary.segmentPaths).toHaveLength(3);
		expect(summary.segmentSha256).toHaveLength(3);
		expect((await fs.stat(summary.journalPath)).size).toBe(ONE_MEBIBYTE_WITH_EXACT_RATIO);
		expect((await Bun.file(summary.journalPath).text()).endsWith("\n")).toBe(true);
	});

	it("adds periodic compaction boundaries so a large fixture has a bounded active path", async () => {
		const outputDir = await temporaryFixtureDirectory();
		const summary = await generateSessionStorageFixture({ outputDir, journalBytes: 10 * 1024 * 1024, seed: 42n });
		const entries = (await Bun.file(summary.journalPath).text())
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as { type: string; id: string; parentId?: string | null; firstKeptEntryId?: string });
		const compactions = entries.filter(entry => entry.type === "compaction");
		expect(compactions.length).toBeGreaterThan(0);
		const latestCompaction = compactions.at(-1)!;
		expect(latestCompaction.firstKeptEntryId).toBe(latestCompaction.parentId);
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		let activePathEntries = 0;
		for (let entry = entries.at(-1); entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
			activePathEntries++;
			if (entry.id === latestCompaction.firstKeptEntryId) break;
		}
		expect(activePathEntries).toBeLessThanOrEqual(10);
	});

	it("is byte-for-byte deterministic for a seed", async () => {
		const [firstOutputDir, secondOutputDir] = await Promise.all([temporaryFixtureDirectory(), temporaryFixtureDirectory()]);
		const options = { journalBytes: ONE_MEBIBYTE_WITH_EXACT_RATIO, seed: 0x1234n };
		const [first, second] = await Promise.all([
			generateSessionStorageFixture({ outputDir: firstOutputDir, ...options }),
			generateSessionStorageFixture({ outputDir: secondOutputDir, ...options }),
		]);

		expect(second.journalSha256).toBe(first.journalSha256);
		expect(second.segmentSha256).toEqual(first.segmentSha256);
		expect(await Bun.file(second.journalPath).arrayBuffer()).toEqual(await Bun.file(first.journalPath).arrayBuffer());
	});

	it.skipIf(Bun.env.SESSION_STORAGE_FIXTURE_SMOKE !== "1")(
		"smoke generates the required 10 MiB and 100 MiB fixtures",
		async () => {
			const outputDir = await temporaryFixtureDirectory();
			for (const journalBytes of [10 * 1024 * 1024, 100 * 1024 * 1024]) {
				const summary = await generateSessionStorageFixture({ outputDir, journalBytes, seed: 42n });
				await verifySessionStorageFixture(summary);
			}
		},
		120_000,
	);
});
