import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { publishReplaceFile } from "@gajae-code/natives";

import {
	createDurableRootFile,
	type DurableFsOutcome,
	DurableFsPublicationError,
	FileRootRegistry,
	FileSessionRecovery,
	PosixSessionPublisher,
	readRootReference,
	SegmentStore,
	type SessionPublisher,
	V2SessionWriter,
	type WindowsPublisherBackend,
	WindowsSessionPublisher,
} from "../src/session/storage/index";

const temporaryDirectories: string[] = [];
const rootId = "crash-test-root";
const windowsIt = process.platform === "win32" ? it : it.skip;

function temporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-session-storage-crash-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function outcome(code: DurableFsOutcome["code"], ok = code === "OK"): DurableFsOutcome {
	return { ok, code, osCode: ok ? 0 : 1175, operation: "ReplaceFileW" };
}

function replacingBackend(results: DurableFsOutcome[] = []): WindowsPublisherBackend {
	return {
		replaceFile(replacementPath, targetPath) {
			const result = results.shift() ?? outcome("OK");
			if (result.ok) fs.renameSync(replacementPath, targetPath);
			return result;
		},
	};
}

function writeInitialGeneration(directory: string) {
	const segments = new SegmentStore(path.join(directory, "segments"));
	const slotA = path.join(directory, "slot-a.json");
	const slotB = path.join(directory, "slot-b.json");
	const rootReference = path.join(directory, "active.root");
	const manifest = new V2SessionWriter(slotA, segments).write([{ type: "session", id: "g0" }], {
		entrySchemaVersion: 3,
		rootId,
		generation: 0,
	});
	fs.renameSync(`${slotA}.root`, rootReference);
	return { manifest, rootReference, segments, slotA, slotB };
}

function writeNextGeneration(
	segments: SegmentStore,
	slot: string,
	predecessorManifestChecksum: string,
	publisher: SessionPublisher = new PosixSessionPublisher(),
) {
	return new V2SessionWriter(slot, segments, publisher).write([{ type: "session", id: "g1" }], {
		entrySchemaVersion: 3,
		rootId,
		generation: 1,
		predecessorManifestChecksum,
	});
}

describe("session storage crash publication", () => {
	it("posix publication fsyncs payload then manifest then rename then parent directory", () => {
		const directory = temporaryDirectory();
		const events: string[] = [];
		const segments = new SegmentStore(path.join(directory, "segments"), {
			beforeFileFsync: () => events.push("segment install fsync"),
		});
		const publisher = new PosixSessionPublisher({
			beforeManifestTempFsync: () => events.push("manifest temp fsync"),
			beforeManifestRename: () => events.push("manifest rename"),
			beforeParentDirectoryFsync: () => events.push("parent directory fsync"),
			beforeRootReferenceActivation: () => events.push("root-reference activation"),
		});
		new V2SessionWriter(path.join(directory, "slot-a.json"), segments, publisher).write([{ type: "session" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 0,
		});
		expect(events).toEqual([
			"segment install fsync",
			"manifest temp fsync",
			"manifest rename",
			"parent directory fsync",
			"root-reference activation",
		]);
	});
	it("posix absent manifest target uses create-new publication and cannot overwrite a racing publisher", () => {
		const directory = temporaryDirectory();
		const slot = path.join(directory, "slot-a.json");
		const segments = new SegmentStore(path.join(directory, "segments"));
		const publisher = new PosixSessionPublisher({
			beforeManifestRename: () => fs.writeFileSync(slot, "racing publisher\n"),
		});
		expect(() =>
			new V2SessionWriter(slot, segments, publisher).write([{ type: "session", id: "g0" }], {
				entrySchemaVersion: 3,
				rootId,
				generation: 0,
			}),
		).toThrow();
		expect(fs.readFileSync(slot, "utf8")).toBe("racing publisher\n");
	});
	it("posix recovery returns the prior generation after every injected pre-publication crash", () => {
		for (const [name, publisherFault, segmentFault] of [
			["segment install fsync", undefined, "beforeFileFsync"],
			["manifest temp fsync", "beforeManifestTempFsync", undefined],
			["manifest rename", "beforeManifestRename", undefined],
		] as const) {
			const directory = temporaryDirectory();
			const initial = writeInitialGeneration(directory);
			const crashingSegments = segmentFault
				? new SegmentStore(path.join(directory, "segments"), {
						[segmentFault]: () => {
							throw new Error(name);
						},
					})
				: initial.segments;
			const publisher = new PosixSessionPublisher(
				publisherFault
					? {
							[publisherFault]: () => {
								throw new Error(name);
							},
						}
					: {},
			);
			expect(() =>
				writeNextGeneration(crashingSegments, initial.slotB, initial.manifest.checksum, publisher),
			).toThrow(name);
			expect(
				new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest
					.checksum,
			).toBe(initial.manifest.checksum);
		}
	});

	it("publication callback failure leaves the new slot ineligible and reopens the prior generation", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const writer = new V2SessionWriter(
			initial.slotB,
			initial.segments,
			new PosixSessionPublisher(),
			initial.rootReference,
			() => {
				throw new Error("role transaction failed");
			},
		);
		expect(() =>
			writer.write([{ type: "session", id: "g1" }], {
				entrySchemaVersion: 3,
				rootId,
				generation: 1,
				predecessorManifestChecksum: initial.manifest.checksum,
			}),
		).toThrow("role transaction failed");
		expect(fs.existsSync(`${initial.slotB}.commit`)).toBe(false);
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(initial.manifest.checksum);
	});

	it("post-rename parent fsync failure reports durability uncertainty and leaves the prior eligible slot recoverable", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const publisher = new PosixSessionPublisher({
			beforeParentDirectoryFsync: () => {
				throw new Error("parent fsync failed");
			},
		});
		const manifest = writeNextGeneration(initial.segments, initial.slotB, initial.manifest.checksum, publisher);
		const result = publisher.publishGeneration({
			inactiveManifestPath: initial.slotB,
			eligibilityPath: `${initial.slotB}.commit`,
			rootReferencePath: initial.rootReference,
			manifest,
			reference: { kind: "active", rootId, generation: 1, manifestId: manifest.checksum },
		});
		expect(result.durabilityUncertain).toBe(true);
		expect(readRootReference(initial.rootReference).manifestId).toBe(initial.manifest.checksum);
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(initial.manifest.checksum);
	});
	it("durable rollback and registry survive a simulated partial authority write", () => {
		const directory = temporaryDirectory();
		const registryPath = path.join(directory, "roots.json");
		const rollback = { kind: "rollback" as const, rootId, generation: 0, manifestId: "a".repeat(64) };
		new FileRootRegistry(registryPath).replace(rollback);
		fs.writeFileSync(`${registryPath}.${process.pid}.partial.tmp`, "[{partial");
		const reopened = new FileRootRegistry(registryPath);
		expect([...reopened.entries()]).toEqual([rollback]);
	});
	it("windows durability uncertainty propagates to recovery without activating a partial root", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const backend: WindowsPublisherBackend = {
			replaceFile(replacementPath, targetPath) {
				fs.renameSync(replacementPath, targetPath);
				return outcome("PUBLISHED_DURABILITY_UNCERTAIN");
			},
		};
		const writer = new V2SessionWriter(initial.slotB, initial.segments, new WindowsSessionPublisher(backend));
		writer.write([{ type: "session", id: "g1" }], {
			entrySchemaVersion: 3,
			rootId,
			generation: 1,
			predecessorManifestChecksum: initial.manifest.checksum,
		});
		expect(writer.lastPublicationResult?.durabilityUncertain).toBe(true);
		expect(readRootReference(initial.rootReference).manifestId).toBe(initial.manifest.checksum);
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(initial.manifest.checksum);
	});

	it("windows recovery selects the highest fully valid manifest slot", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const manifest = writeNextGeneration(
			initial.segments,
			initial.slotB,
			initial.manifest.checksum,
			new WindowsSessionPublisher(replacingBackend()),
		);
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(manifest.checksum);
	});

	it("windows ignores a newer slot with a bad checksum or missing segment", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const manifest = writeNextGeneration(initial.segments, initial.slotB, initial.manifest.checksum);
		fs.unlinkSync(path.join(initial.segments.dir, manifest.segments[0].hash));
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(initial.manifest.checksum);
		fs.writeFileSync(initial.slotB, "{bad checksum");
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(initial.manifest.checksum);
	});

	for (const code of [
		"REPLACE_FAILED_UNCHANGED",
		"REPLACE_FAILED_TARGET_MAY_HAVE_CHANGED",
		"REPLACE_FAILED_REPLACEMENT_RETAINED",
	] as const) {
		it(`windows ReplaceFileW ${code} failure preserves the previous valid generation`, () => {
			const directory = temporaryDirectory();
			const initial = writeInitialGeneration(directory);
			expect(() =>
				writeNextGeneration(
					initial.segments,
					initial.slotB,
					initial.manifest.checksum,
					new WindowsSessionPublisher(replacingBackend([outcome(code)])),
				),
			).toThrow(DurableFsPublicationError);
			expect(
				new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest
					.checksum,
			).toBe(initial.manifest.checksum);
		});
	}

	it("windows sharing violation and delayed close do not publish a partial generation", () => {
		for (const code of ["SHARING_VIOLATION", "REPLACE_FAILED_REPLACEMENT_RETAINED"] as const) {
			const directory = temporaryDirectory();
			const initial = writeInitialGeneration(directory);
			expect(() =>
				writeNextGeneration(
					initial.segments,
					initial.slotB,
					initial.manifest.checksum,
					new WindowsSessionPublisher(replacingBackend([outcome(code)])),
				),
			).toThrow(DurableFsPublicationError);
			expect(fs.existsSync(initial.slotB)).toBe(false);
			expect(
				new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest
					.checksum,
			).toBe(initial.manifest.checksum);
		}
	});

	it("windows stale pointer cannot outrank a higher fully valid generation", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const manifest = writeNextGeneration(initial.segments, initial.slotB, initial.manifest.checksum);
		expect(readRootReference(initial.rootReference).manifestId).toBe(initial.manifest.checksum);
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(manifest.checksum);
	});

	it("publication error reports the platform error code without deleting rollback state", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		try {
			writeNextGeneration(
				initial.segments,
				initial.slotB,
				initial.manifest.checksum,
				new WindowsSessionPublisher(replacingBackend([outcome("SHARING_VIOLATION")])),
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DurableFsPublicationError);
			expect((error as DurableFsPublicationError).outcome.code).toBe("SHARING_VIOLATION");
		}
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(initial.manifest.checksum);
	});

	windowsIt("native ReplaceFileW 1177 partial state recovers the prior committed generation", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const backup = `${initial.slotB}.backup`;
		fs.writeFileSync(initial.slotB, "previous incomplete generation");
		const backend: WindowsPublisherBackend = {
			replaceFile(replacementPath, targetPath) {
				return publishReplaceFile(replacementPath, targetPath, backup);
			},
		};
		process.env.PI_NATIVES_DURABLE_FS_TEST_FAULT = "1177";
		try {
			expect(() =>
				writeNextGeneration(
					initial.segments,
					initial.slotB,
					initial.manifest.checksum,
					new WindowsSessionPublisher(backend),
				),
			).toThrow(DurableFsPublicationError);
		} finally {
			delete process.env.PI_NATIVES_DURABLE_FS_TEST_FAULT;
		}
		expect(fs.readFileSync(backup, "utf8")).toBe("previous incomplete generation");
		// 1177 installs the new manifest bytes at slotB but the publication threw
		// before the role callback and `.commit` record ran, so slotB is not a
		// committed generation. Recovery must ignore it and select generation 0.
		expect(fs.existsSync(`${initial.slotB}.commit`)).toBe(false);
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.generation,
		).toBe(0);
	});

	windowsIt("a stale advisory root pointer cannot outrank the newer valid Windows slot", () => {
		const directory = temporaryDirectory();
		const initial = writeInitialGeneration(directory);
		const manifest = writeNextGeneration(
			initial.segments,
			initial.slotB,
			initial.manifest.checksum,
			new WindowsSessionPublisher(replacingBackend()),
		);
		expect(readRootReference(initial.rootReference).manifestId).toBe(initial.manifest.checksum);
		expect(
			new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest.checksum,
		).toBe(manifest.checksum);
	});

	windowsIt(
		"a native durability-uncertain outcome leaves root activation advisory and recovers the valid slot",
		() => {
			const directory = temporaryDirectory();
			const initial = writeInitialGeneration(directory);
			const backend: WindowsPublisherBackend = {
				replaceFile(replacementPath, targetPath) {
					fs.renameSync(replacementPath, targetPath);
					return outcome("PUBLISHED_DURABILITY_UNCERTAIN");
				},
			};
			const writer = new V2SessionWriter(initial.slotB, initial.segments, new WindowsSessionPublisher(backend));
			const manifest = writer.write([{ type: "session", id: "g1" }], {
				entrySchemaVersion: 3,
				rootId,
				generation: 1,
				predecessorManifestChecksum: initial.manifest.checksum,
			});
			expect(writer.lastPublicationResult?.durabilityUncertain).toBe(true);
			expect(readRootReference(initial.rootReference).manifestId).toBe(initial.manifest.checksum);
			expect(
				new FileSessionRecovery([initial.slotA, initial.slotB], initial.segments).recover(rootId)?.manifest
					.checksum,
			).toBe(manifest.checksum);
		},
	);
	it("create-only durable root publication rejects an existing target instead of overwriting it", () => {
		const directory = temporaryDirectory();
		const target = path.join(directory, "roots.json.pins", "token-1.json");
		createDurableRootFile(target, "first owner\n");
		expect(fs.readFileSync(target, "utf8")).toBe("first owner\n");
		// A racing/colliding create must fail closed, never clobber the live owner.
		expect(() => createDurableRootFile(target, "second owner\n")).toThrow();
		expect(fs.readFileSync(target, "utf8")).toBe("first owner\n");
	});
});
