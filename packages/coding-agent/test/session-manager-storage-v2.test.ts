import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pinV2SessionExport, SessionManager } from "../src/session/session-manager";
import {
	FileRootRegistry,
	FileSessionRootResolver,
	SegmentStore,
	SessionStorageGc,
	V2SessionWriter,
} from "../src/session/storage/index";

const dirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-manager-v2-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function legacy(file: string, id = "legacy-root"): void {
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp" })}\n`,
	);
}

describe("SessionManager storage v2", () => {
	it("opens legacy v1 without rewrite", async () => {
		const dir = tempDir();
		const file = path.join(dir, "legacy.jsonl");
		legacy(file);
		const before = fs.readFileSync(file, "utf8");
		const manager = await SessionManager.open(file, dir);
		try {
			expect(fs.readFileSync(file, "utf8")).toBe(before);
			expect(fs.existsSync(`${file}.v2/manifest.json.root`)).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("first mutation publishes valid v2 + rollback root", async () => {
		const dir = tempDir();
		const file = path.join(dir, "legacy.jsonl");
		legacy(file);
		const manager = await SessionManager.open(file, dir);
		try {
			await manager.ensureOnDisk();
			expect(fs.existsSync(`${file}.v2/manifest.json.root`)).toBe(true);
			expect(fs.existsSync(`${file}.v2/legacy-v1-source`)).toBe(true);
			expect(fs.readFileSync(file, "utf8")).toContain('"legacy-root"');
		} finally {
			await manager.close();
		}
	});

	it("alternates production manifest slots while retaining the rollback root", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		try {
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected session file");
			manager.appendMessage({ role: "user", content: "second generation", timestamp: 1 });
			await manager.flush();
			expect(fs.existsSync(`${file}.v2/manifest-a.json`)).toBe(true);
			expect(fs.existsSync(`${file}.v2/manifest-b.json`)).toBe(true);
			expect(fs.existsSync(`${file}.v2/manifest.rollback.root`)).toBe(true);
			expect(fs.existsSync(`${file}.v2/roots.json`)).toBe(true);
		} finally {
			await manager.close();
		}
	});

	it("resume reads v2 via port without full-journal materialization", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected session file");
		await manager.close();
		const originalReadFile = fs.readFileSync;
		let readLegacySource = false;
		const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
			target: fs.PathOrFileDescriptor,
			...rest: unknown[]
		) => {
			if (target === file) readLegacySource = true;
			return originalReadFile(target, ...(rest as []));
		}) as typeof fs.readFileSync);
		try {
			const resumed = await SessionManager.open(file, dir);
			await resumed.close();
		} finally {
			readSpy.mockRestore();
		}
		expect(readLegacySource).toBe(false);
	});

	it("listing uses/rebuilds side index", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		await manager.ensureOnDisk();
		await manager.close();
		const index = path.join(dir, "sessions.v2.index.json");
		expect(await SessionManager.list("/tmp", dir)).toHaveLength(1);
		expect(fs.existsSync(index)).toBe(true);
		fs.unlinkSync(index);
		expect(await SessionManager.list("/tmp", dir)).toHaveLength(1);
		expect(fs.existsSync(index)).toBe(true);
	});

	it("failed rebuild never hides a session", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		await manager.ensureOnDisk();
		await manager.close();
		fs.mkdirSync(path.join(dir, "sessions.v2.index.json"));
		expect(await SessionManager.list("/tmp", dir)).toHaveLength(1);
	});

	it("durabilityUncertain publication triggers re-validation", () => {
		const dir = tempDir();
		const segments = new SegmentStore(path.join(dir, "segments"));
		const writer = new V2SessionWriter(path.join(dir, "manifest.json"), segments, {
			publishGeneration: publication => ({ reference: publication.reference, durabilityUncertain: true }),
		});
		writer.write([{ type: "session", id: "root", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp" }], {
			entrySchemaVersion: 3,
			rootId: "root",
			generation: 0,
		});
		expect(writer.lastPublicationResult?.durabilityUncertain).toBe(true);
	});

	it("rootId cross-check rejects mismatched header", async () => {
		const dir = tempDir();
		const file = path.join(dir, "session.jsonl");
		const manifest = path.join(`${file}.v2`, "manifest.json");
		fs.mkdirSync(path.dirname(manifest), { recursive: true });
		new V2SessionWriter(manifest, new SegmentStore(path.join(`${file}.v2`, "segments"))).write(
			[{ type: "session", id: "header-id", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp" }],
			{ entrySchemaVersion: 3, rootId: "different-root", generation: 0 },
		);
		await expect(SessionManager.open(file, dir)).rejects.toThrow("rootId does not match");
	});
	it("falls back to retained rollback slot when the advisory active payload is corrupt", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected session file");
		manager.appendMessage({ role: "user", content: "new generation", timestamp: 1 });
		await manager.flush();
		await manager.close();
		const active = JSON.parse(fs.readFileSync(`${file}.v2/manifest.json.root`, "utf8"));
		const slot = ["manifest-a.json", "manifest-b.json"]
			.map(name => path.join(`${file}.v2`, name))
			.find(candidate => JSON.parse(fs.readFileSync(candidate, "utf8")).checksum === active.manifestId);
		if (!slot) throw new Error("Expected active manifest slot");
		const manifest = JSON.parse(fs.readFileSync(slot, "utf8"));
		fs.unlinkSync(path.join(`${file}.v2/segments`, manifest.segments[0].hash));
		const resumed = await SessionManager.open(file, dir);
		try {
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			await resumed.close();
		}
	});

	it("recovers from a corrupt advisory active pointer using retained slots", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected session file");
		await manager.close();
		fs.writeFileSync(`${file}.v2/manifest.json.root`, "not json");
		const resumed = await SessionManager.open(file, dir);
		await resumed.close();
	});
	it("rejects a malformed historical record while preparing the v2 lease", async () => {
		const dir = tempDir();
		const file = path.join(dir, "session.jsonl");
		const manifestPath = path.join(`${file}.v2`, "manifest.json");
		fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
		const manifest = new V2SessionWriter(manifestPath, new SegmentStore(path.join(`${file}.v2`, "segments"))).write(
			[
				{ type: "session", version: 3, id: "root", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp" },
				{ type: "message", id: "historical", parentId: "root" },
			],
			{ entrySchemaVersion: 3, rootId: "root", generation: 0 },
		);
		fs.writeFileSync(
			`${manifestPath}.root`,
			JSON.stringify({ kind: "active", rootId: "root", generation: 0, manifestId: manifest.checksum }),
		);
		await expect(SessionManager.open(file, dir)).rejects.toThrow("Invalid session entry");
	});

	it("continueRecent transfers one paged lease without materializing historical entries", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		manager.appendMessage({ role: "user", content: "historical", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "current", timestamp: 2 });
		await manager.ensureOnDisk();
		await manager.close();
		const resumed = await SessionManager.continueRecent("/tmp", dir);
		try {
			expect(resumed.getObservabilityStatsForTests().getEntriesMaterializerCallCount).toBe(0);
		} finally {
			await resumed.close();
		}
	});

	it("keeps a second export token reachable after the first closes when no active or rollback root remains", async () => {
		const dir = tempDir();
		const manager = SessionManager.create("/tmp", dir);
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "second generation", timestamp: 1 });
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected session file");
		await manager.close();
		const first = pinV2SessionExport(file);
		const second = pinV2SessionExport(file);
		try {
			first.close();
			const rootDir = `${file}.v2`;
			const reference = JSON.parse(fs.readFileSync(`${rootDir}/manifest.json.root`, "utf8")) as {
				rootId: string;
				manifestId: string;
			};
			const registry = new FileRootRegistry(path.join(rootDir, "roots.json"));
			registry.unregister("active", reference.rootId);
			registry.unregister("rollback", reference.rootId);
			fs.unlinkSync(path.join(rootDir, "manifest.rollback.root"));
			const manifestPath = ["manifest-a.json", "manifest-b.json"]
				.map(name => path.join(rootDir, name))
				.find(
					candidate =>
						fs.existsSync(candidate) &&
						JSON.parse(fs.readFileSync(candidate, "utf8")).checksum === reference.manifestId,
				);
			if (!manifestPath) throw new Error("Expected active manifest slot");
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { segments: Array<{ hash: string }> };
			const segments = new SegmentStore(path.join(rootDir, "segments"));
			const gc = new SessionStorageGc({
				registry,
				resolver: new FileSessionRootResolver(new Map([[reference.manifestId, manifestPath]]), segments, registry),
				segments,
				statePath: path.join(rootDir, "gc-test-state.json"),
				quarantineDir: path.join(rootDir, "gc-test-quarantine"),
				rootReferencePaths: new Map(),
			});
			gc.run();
			expect(segments.hasSync(manifest.segments[0].hash)).toBe(true);
		} finally {
			second.close();
		}
	});
});
