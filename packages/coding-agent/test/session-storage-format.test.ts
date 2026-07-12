import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileSessionRecovery,
	FileSessionRootResolver,
	loadOrRebuildSessionSideIndex,
	MemoryRootRegistry,
	SegmentStore,
	STORAGE_FORMAT_VERSION,
	V1SessionReader,
	V2SessionReader,
	V2SessionWriter,
} from "../src/session/storage/index";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-storage-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const rootId = "root-session-a";

function writer(dir: string, segments = new SegmentStore(path.join(dir, "segments"))) {
	return { segments, writer: new V2SessionWriter(path.join(dir, "manifest.json"), segments) };
}

describe("session storage format", () => {
	it("reads v1 headers without conflating entry schema and storage format versions", () => {
		const dir = tempDir();
		const legacy = path.join(dir, "legacy.jsonl");
		fs.writeFileSync(legacy, `${JSON.stringify({ type: "session", version: 3, id: "s" })}\n`);
		const metadata = new V1SessionReader(legacy).metadata();
		expect(metadata).toEqual({ storageFormatVersion: 1, entrySchemaVersion: 3, entryCount: undefined });
		expect(STORAGE_FORMAT_VERSION).toBe(2);
	});

	it("writes role-neutral manifests with repeated immutable segment occurrences", () => {
		const dir = tempDir();
		const { segments, writer: sessionWriter } = writer(dir);
		const manifest = sessionWriter.write(
			[
				{ type: "session", version: 3 },
				{ type: "session", version: 3 },
			],
			{ entrySchemaVersion: 3, rootId, generation: 1, maxEntriesPerSegment: 1 },
		);
		expect(manifest.segments).toHaveLength(2);
		expect(manifest.segments[0].hash).toBe(manifest.segments[1].hash);
		expect(manifest.segments.map(segment => [segment.firstEntry, segment.lastEntry])).toEqual([
			[0, 0],
			[1, 1],
		]);
		expect(manifest.checkpoints.map(checkpoint => checkpoint.segmentOrdinal)).toEqual([0, 1]);
		expect(new V2SessionReader(path.join(dir, "manifest.json"), segments).readAll().entries).toEqual([
			{ type: "session", version: 3 },
			{ type: "session", version: 3 },
		]);
	});

	it("rejects a segment whose bytes do not match its manifest digest before exposing metadata", () => {
		const dir = tempDir();
		const { segments, writer: sessionWriter } = writer(dir);
		const manifest = sessionWriter.write([{ type: "session" }], { entrySchemaVersion: 3, rootId, generation: 1 });
		fs.writeFileSync(path.join(segments.dir, manifest.segments[0].hash), "x\n");
		expect(() => new V2SessionReader(path.join(dir, "manifest.json"), segments).metadata()).toThrow(
			"failed SHA-256 verification",
		);
	});

	it("rebuilds any structurally corrupt side index from authoritative roots", () => {
		const dir = tempDir();
		const { segments, writer: sessionWriter } = writer(dir);
		const manifestPath = path.join(dir, "manifest.json");
		sessionWriter.write([{ type: "session" }], { entrySchemaVersion: 3, rootId, generation: 4 });
		const roots = [{ root: "session-a", reader: new V2SessionReader(manifestPath, segments) }];
		const indexPath = path.join(dir, "sessions.index.json");
		fs.writeFileSync(
			indexPath,
			JSON.stringify({
				version: 1,
				entries: [{ root: "session-a", generation: "4", entryCount: 1, entrySchemaVersion: 3 }],
			}),
		);
		expect(loadOrRebuildSessionSideIndex(indexPath, roots)).toEqual({
			version: 1,
			entries: [{ root: "session-a", generation: 4, entryCount: 1, entrySchemaVersion: 3 }],
		});
	});

	it("fails closed when segment directory durability fails and never publishes its manifest", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"), {
			beforeDirectoryFsync: () => {
				throw new Error("directory fsync failed");
			},
		});
		const manifestPath = path.join(dir, "manifest.json");
		expect(() =>
			new V2SessionWriter(manifestPath, segments).write([{ type: "session" }], {
				entrySchemaVersion: 3,
				rootId,
				generation: 1,
			}),
		).toThrow("directory fsync failed");
		expect(fs.existsSync(manifestPath)).toBe(false);
	});

	it("selects the highest fully valid matching-root slot and falls back from a corrupt newer slot", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const slotA = path.join(dir, "slot-a.json");
		const slotB = path.join(dir, "slot-b.json");
		const first = new V2SessionWriter(slotA, segments).write([{ type: "session", id: "old" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 0,
		});
		const newer = new V2SessionWriter(slotB, segments).write([{ type: "session", id: "new" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 1,
			predecessorManifestChecksum: first.checksum,
		});
		const recovery = new FileSessionRecovery([slotA, slotB], segments);
		expect(recovery.recover(rootId)?.manifest.checksum).toBe(newer.checksum);
		fs.unlinkSync(path.join(segments.dir, newer.segments[0].hash));
		expect(recovery.recover(rootId)?.manifest.checksum).toBe(first.checksum);
	});

	it("rejects a valid higher slot belonging to another root", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const slotA = path.join(dir, "slot-a.json");
		const slotB = path.join(dir, "slot-b.json");
		const first = new V2SessionWriter(slotA, segments).write([{ type: "session", id: "a" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 0,
		});
		new V2SessionWriter(slotB, segments).write([{ type: "session", id: "other" }], {
			entrySchemaVersion: 3,
			rootId: "other-root",
			generation: 9,
		});
		expect(new FileSessionRecovery([slotA, slotB], segments).recover(rootId)?.manifest.checksum).toBe(first.checksum);
	});
	it("rejects a higher same-root generation with a mismatched predecessor commitment", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const slotA = path.join(dir, "slot-a.json");
		const slotB = path.join(dir, "slot-b.json");
		const first = new V2SessionWriter(slotA, segments).write([{ type: "session", id: "a" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 0,
		});
		new V2SessionWriter(slotB, segments).write([{ type: "session", id: "forged" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 1,
			predecessorManifestChecksum: "0".repeat(64),
		});
		expect(new FileSessionRecovery([slotA, slotB], segments).recover(rootId)?.manifest.checksum).toBe(first.checksum);
	});

	it("falls back to g1 when the checksum-valid g2 payload is corrupt after slot rollover", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const slotA = path.join(dir, "slot-a.json");
		const slotB = path.join(dir, "slot-b.json");
		const g0 = new V2SessionWriter(slotA, segments).write([{ type: "session", id: "g0" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 0,
		});
		const g1 = new V2SessionWriter(slotB, segments).write([{ type: "session", id: "g1" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 1,
			predecessorManifestChecksum: g0.checksum,
		});
		const g2 = new V2SessionWriter(slotA, segments).write([{ type: "session", id: "g2" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 2,
			predecessorManifestChecksum: g1.checksum,
		});
		fs.unlinkSync(path.join(segments.dir, g2.segments[0].hash));
		expect(new FileSessionRecovery([slotA, slotB], segments).recover(rootId)?.manifest.checksum).toBe(g1.checksum);
	});

	it("fails closed for equal-generation divergent checksum-valid slot manifests", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const slotA = path.join(dir, "slot-a.json");
		const slotB = path.join(dir, "slot-b.json");
		new V2SessionWriter(slotA, segments).write([{ type: "session", id: "a" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 0,
		});
		new V2SessionWriter(slotB, segments).write([{ type: "session", id: "b" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 0,
		});
		expect(() => new FileSessionRecovery([slotA, slotB], segments).recover(rootId)).toThrow("split brain");
	});

	it("re-fsyncs an identical segment on retry after directory durability fails", () => {
		const dir = tempDir();
		let directorySyncs = 0;
		const segments = new SegmentStore(path.join(dir, "segments"), {
			beforeDirectoryFsync: () => {
				directorySyncs++;
				throw new Error("directory fsync failed");
			},
		});
		expect(() => segments.putImmutableSync(Buffer.from("segment"))).toThrow("directory fsync failed");
		expect(() => segments.putImmutableSync(Buffer.from("segment"))).toThrow("directory fsync failed");
		expect(directorySyncs).toBe(2);
	});

	it("replaces the active root entry and returns a validated closeable lease", () => {
		const registry = new MemoryRootRegistry();
		const g0 = { kind: "active" as const, rootId, generation: 0, manifestId: "a".repeat(64) };
		const g1 = { ...g0, generation: 1, manifestId: "b".repeat(64) };
		registry.replace(g0);
		registry.replace(g1);
		expect(registry.snapshot()).toEqual([g1]);
		const dir = tempDir();
		const { segments, writer: sessionWriter } = writer(dir);
		const manifest = sessionWriter.write([{ type: "session" }], { entrySchemaVersion: 3, rootId, generation: 1 });
		const resolver = new FileSessionRootResolver(
			new Map([[manifest.checksum, path.join(dir, "manifest.json")]]),
			segments,
			registry,
		);
		const lease = resolver.lease({ ...g1, manifestId: manifest.checksum });
		expect([...lease.reader.entries()]).toEqual([{ type: "session" }]);
		expect(registry.snapshot()).toContainEqual({ ...g1, manifestId: manifest.checksum });
		lease.close();
		expect(registry.snapshot()).toEqual([g1]);
	});
});
