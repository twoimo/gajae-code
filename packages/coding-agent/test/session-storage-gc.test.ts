import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FileSessionRootResolver,
	MemoryRootRegistry,
	rootReferenceGcKey,
	SegmentStore,
	SessionStorageGc,
	V2SessionWriter,
} from "../src/session/storage/index";
import type { RootReference } from "../src/session/storage/types";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-storage-gc-"));
	tempDirs.push(dir);
	return dir;
}

function writeRoot(
	dir: string,
	segments: SegmentStore,
	kind: RootReference["kind"],
	rootId: string,
	generation: number,
	entries: unknown[],
): { reference: RootReference; manifestPath: string; hashes: string[] } {
	const manifestPath = path.join(dir, `${kind}-${rootId}-${generation}.json`);
	const manifest = new V2SessionWriter(manifestPath, segments).write(entries, {
		entrySchemaVersion: 3,
		rootId,
		generation,
	});
	return {
		reference: { kind, rootId, generation, manifestId: manifest.checksum },
		manifestPath,
		hashes: manifest.segments.map(segment => segment.hash),
	};
}

function collector(
	dir: string,
	registry: MemoryRootRegistry,
	segments: SegmentStore,
	manifestPaths: ReadonlyMap<string, string>,
	rootReferencePaths?: ReadonlyMap<string, string>,
): SessionStorageGc {
	return new SessionStorageGc({
		registry,
		resolver: new FileSessionRootResolver(manifestPaths, segments, registry),
		segments,
		statePath: path.join(dir, "gc-state.json"),
		quarantineDir: path.join(dir, "quarantine"),
		rootReferencePaths: rootReferencePaths ?? new Map(),
	});
}

describe("session storage GC", () => {
	it("GC marks segments reachable from every valid active rollback and export root", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const registry = new MemoryRootRegistry();
		const active = writeRoot(dir, segments, "active", "session", 2, [
			{ type: "session", image: "blob:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
		]);
		const rollback = writeRoot(dir, segments, "rollback", "session", 1, [
			{
				type: "session",
				spill: {
					kind: "cold_spill",
					sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				},
			},
		]);
		const exported = writeRoot(dir, segments, "export", "export-copy", 1, [{ type: "session" }]);
		for (const root of [active, rollback, exported]) registry.replace(root.reference);
		const manifests = new Map(
			[active, rollback, exported].map(root => [root.reference.manifestId, root.manifestPath]),
		);

		const result = collector(dir, registry, segments, manifests).run();

		expect(result.markedSegments).toEqual([...active.hashes, ...rollback.hashes, ...exported.hashes].sort());
		expect(result.markedBlobs).toEqual([
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		]);
		expect(result.deletedSegments).toEqual([]);
	});

	it("GC preserves a segment after one unreferenced generation", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const registry = new MemoryRootRegistry();
		const orphan = segments.putImmutableSync(Buffer.from('{"orphan":true}\n')).hash;

		const result = collector(dir, registry, segments, new Map()).run();

		expect(result.retainedUnreferencedSegments).toEqual([orphan]);
		expect(segments.hasSync(orphan)).toBe(true);
	});

	it("GC deletes a segment only after two complete unreferenced generations", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const registry = new MemoryRootRegistry();
		const orphan = segments.putImmutableSync(Buffer.from('{"orphan":true}\n')).hash;
		const gc = collector(dir, registry, segments, new Map());

		expect(gc.run().deletedSegments).toEqual([]);
		expect(gc.run().deletedSegments).toEqual([orphan]);
		expect(segments.hasSync(orphan)).toBe(false);
	});

	it("GC ignores non-authoritative side indexes when computing reachability", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const registry = new MemoryRootRegistry();
		const orphan = segments.putImmutableSync(Buffer.from('{"orphan":true}\n')).hash;
		fs.writeFileSync(
			path.join(dir, "sessions.index.json"),
			JSON.stringify({
				version: 1,
				entries: [{ root: "invented", generation: 99, entryCount: 1, entrySchemaVersion: 3 }],
			}),
		);
		const gc = collector(dir, registry, segments, new Map());

		gc.run();
		expect(gc.run().deletedSegments).toEqual([orphan]);
	});

	it("GC quarantines invalid roots and never marks through an unverified manifest", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const registry = new MemoryRootRegistry();
		const reference: RootReference = {
			kind: "active",
			rootId: "broken",
			generation: 3,
			manifestId: "c".repeat(64),
		};
		const rootReferencePath = path.join(dir, "broken.root.json");
		fs.writeFileSync(rootReferencePath, JSON.stringify(reference));
		const manifestPath = path.join(dir, "broken-manifest.json");
		fs.writeFileSync(manifestPath, "not a manifest");
		registry.replace(reference);
		const roots = new Map([[rootReferenceGcKey(reference), rootReferencePath]]);

		const result = collector(dir, registry, segments, new Map([[reference.manifestId, manifestPath]]), roots).run();

		expect(result.quarantinedRoots).toEqual([reference]);
		expect(result.markedSegments).toEqual([]);
		expect(fs.existsSync(rootReferencePath)).toBe(false);
		expect(
			fs.existsSync(
				path.join(dir, "quarantine", `broken.root.json.active.broken.3.${reference.manifestId}.invalid`),
			),
		).toBe(true);
	});

	it("a live lease prevents deletion until close", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const registry = new MemoryRootRegistry();
		const oldRoot = writeRoot(dir, segments, "active", "session", 0, [{ type: "session", id: "old" }]);
		const newRoot = writeRoot(dir, segments, "active", "session", 1, [{ type: "session", id: "new" }]);
		const manifests = new Map([
			[oldRoot.reference.manifestId, oldRoot.manifestPath],
			[newRoot.reference.manifestId, newRoot.manifestPath],
		]);
		registry.replace(oldRoot.reference);
		const resolver = new FileSessionRootResolver(manifests, segments, registry);
		const lease = resolver.lease(oldRoot.reference);
		registry.replace(newRoot.reference);
		const gc = new SessionStorageGc({
			registry,
			resolver,
			segments,
			statePath: path.join(dir, "gc-state.json"),
			quarantineDir: path.join(dir, "quarantine"),
			rootReferencePaths: new Map(),
		});

		expect(gc.run().markedSegments).toContain(oldRoot.hashes[0]);
		expect(segments.hasSync(oldRoot.hashes[0])).toBe(true);
		lease.close();
		expect(gc.run().deletedSegments).toEqual([]);
		expect(gc.run().deletedSegments).toContain(oldRoot.hashes[0]);
	});
});
