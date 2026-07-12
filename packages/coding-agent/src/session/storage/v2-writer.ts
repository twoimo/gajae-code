import * as fs from "node:fs";
import * as path from "node:path";
import { createManifest, serializeManifest, sha256Hex } from "./manifest";
import type { SegmentStore } from "./segment-store";
import {
	type SessionGenerationWriteOptions,
	type SessionGenerationWriter,
	type SessionManifest,
	type SessionPublication,
	type SessionPublicationResult,
	type SessionPublisher,
	STORAGE_FORMAT_VERSION,
} from "./types";

const MAX_SEGMENT_BYTES = 1024 * 1024;

export interface V2WriteOptions extends SessionGenerationWriteOptions {}

export type DurableFsOutcomeCode =
	| "OK"
	| "SHARING_VIOLATION"
	| "TARGET_MISSING"
	| "CROSS_DIRECTORY_UNSUPPORTED"
	| "REPLACE_FAILED_UNCHANGED"
	| "REPLACE_FAILED_TARGET_MAY_HAVE_CHANGED"
	| "REPLACE_FAILED_REPLACEMENT_RETAINED"
	| "PUBLISHED_DURABILITY_UNCERTAIN";

/** Stable result shape exposed by the native durable filesystem primitive. */
export interface DurableFsOutcome {
	ok: boolean;
	code: DurableFsOutcomeCode;
	osCode: number;
	operation: string;
}

/** Platform seam for ReplaceFileW/create-new publication. */
export interface WindowsPublisherBackend {
	replaceFile(replacementPath: string, targetPath: string): DurableFsOutcome;
	createFile?(replacementPath: string, targetPath: string): DurableFsOutcome;
}

export class DurableFsPublicationError extends Error {
	constructor(readonly outcome: DurableFsOutcome) {
		super(`${outcome.operation}: ${outcome.code}${outcome.osCode === 0 ? "" : ` (${outcome.osCode})`}`);
		this.name = "DurableFsPublicationError";
	}
}

export interface PosixPublisherFaults {
	beforeManifestTempFsync?(): void;
	beforeManifestRename?(): void;
	beforeParentDirectoryFsync?(): void;
	beforeRootReferenceActivation?(): void;
}

/** POSIX publication writes the manifest, durable role authority, eligibility record, then active pointer. */
export class PosixSessionPublisher implements SessionPublisher {
	constructor(readonly faults: PosixPublisherFaults = {}) {}

	publishGeneration(publication: SessionPublication): SessionPublicationResult {
		const manifestDurabilityUncertain = this.#publishManifest(
			publication.inactiveManifestPath,
			serializeManifest(publication.manifest),
		);
		if (manifestDurabilityUncertain) return { reference: { ...publication.reference }, durabilityUncertain: true };
		publication.beforeRootReferenceActivation?.(publication.reference);
		const eligibilityDurabilityUncertain = this.#publishRootReference(
			publication.eligibilityPath,
			`${JSON.stringify(publication.reference)}\n`,
		);
		if (eligibilityDurabilityUncertain) return { reference: { ...publication.reference }, durabilityUncertain: true };
		this.faults.beforeRootReferenceActivation?.();
		const rootDurabilityUncertain = this.#publishRootReference(
			publication.rootReferencePath,
			`${JSON.stringify(publication.reference)}\n`,
		);
		return { reference: { ...publication.reference }, durabilityUncertain: rootDurabilityUncertain };
	}

	#publishManifest(target: string, contents: string): boolean {
		return this.#publish(target, contents, {
			beforeTempFsync: this.faults.beforeManifestTempFsync,
			beforeRename: this.faults.beforeManifestRename,
			beforeParentDirectoryFsync: this.faults.beforeParentDirectoryFsync,
		});
	}

	#publishRootReference(target: string, contents: string): boolean {
		return this.#publish(target, contents, {});
	}

	/** Returns true only after rename succeeded but the directory fsync did not. */
	#publish(
		target: string,
		contents: string,
		faults: {
			beforeTempFsync?: () => void;
			beforeRename?: () => void;
			beforeParentDirectoryFsync?: () => void;
		},
	): boolean {
		const dir = path.dirname(target);
		fs.mkdirSync(dir, { recursive: true });
		const temporary = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
		let fd: number | undefined;
		let renamed = false;
		try {
			fd = fs.openSync(temporary, "wx");
			fs.writeFileSync(fd, contents);
			faults.beforeTempFsync?.();
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = undefined;
			const targetExisted = fs.existsSync(target);
			faults.beforeRename?.();
			if (targetExisted) fs.renameSync(temporary, target);
			else {
				fs.linkSync(temporary, target);
				fs.unlinkSync(temporary);
			}
			renamed = true;
			const directory = fs.openSync(dir, "r");
			try {
				faults.beforeParentDirectoryFsync?.();
				fs.fsyncSync(directory);
			} catch (error) {
				if (renamed) return true;
				throw error;
			} finally {
				fs.closeSync(directory);
			}
			return false;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
			try {
				fs.unlinkSync(temporary);
			} catch {
				/* published or absent */
			}
		}
	}
}

/** Windows publication delegates identity replacement to the structured native outcome contract. */
export class WindowsSessionPublisher implements SessionPublisher {
	constructor(readonly backend: WindowsPublisherBackend) {}

	publishGeneration(publication: SessionPublication): SessionPublicationResult {
		const manifestDurabilityUncertain = this.#publish(
			publication.inactiveManifestPath,
			serializeManifest(publication.manifest),
		);
		if (manifestDurabilityUncertain) return { reference: { ...publication.reference }, durabilityUncertain: true };
		publication.beforeRootReferenceActivation?.(publication.reference);
		const eligibilityDurabilityUncertain = this.#publish(
			publication.eligibilityPath,
			`${JSON.stringify(publication.reference)}\n`,
		);
		if (eligibilityDurabilityUncertain) return { reference: { ...publication.reference }, durabilityUncertain: true };
		const rootDurabilityUncertain = this.#publish(
			publication.rootReferencePath,
			`${JSON.stringify(publication.reference)}\n`,
		);
		return { reference: { ...publication.reference }, durabilityUncertain: rootDurabilityUncertain };
	}

	#publish(target: string, contents: string): boolean {
		const dir = path.dirname(target);
		fs.mkdirSync(dir, { recursive: true });
		const replacement = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
		let fd: number | undefined;
		try {
			fd = fs.openSync(replacement, "wx");
			fs.writeFileSync(fd, contents);
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fd = undefined;
			const outcome = fs.existsSync(target)
				? this.backend.replaceFile(replacement, target)
				: (this.backend.createFile ?? this.backend.replaceFile)(replacement, target);

			if (outcome.code === "PUBLISHED_DURABILITY_UNCERTAIN") return true;
			if (!outcome.ok) throw new DurableFsPublicationError(outcome);
			return false;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
			try {
				fs.unlinkSync(replacement);
			} catch {
				/* the backend installed it or it was already removed */
			}
		}
	}
}

/** Writes role-neutral v2 manifests after every referenced segment is durably installed. */
/** Writes role-neutral v2 manifests after every referenced segment is durably installed. */
export class V2SessionWriter<T = unknown> implements SessionGenerationWriter<T> {
	#lastPublicationResult: SessionPublicationResult | undefined;
	constructor(
		readonly manifestPath: string,
		readonly segments: SegmentStore,
		readonly publisher: SessionPublisher = new PosixSessionPublisher(),
		readonly rootReferencePath = `${manifestPath}.root`,
		readonly beforeRootReferenceActivation?: (reference: SessionPublication["reference"]) => void,
	) {}

	/** Publication result for the current write; unavailable before a successful write. */
	get lastPublicationResult(): SessionPublicationResult | undefined {
		return (
			this.#lastPublicationResult && {
				reference: { ...this.#lastPublicationResult.reference },
				durabilityUncertain: this.#lastPublicationResult.durabilityUncertain,
			}
		);
	}

	write(entries: Iterable<T>, options: V2WriteOptions): SessionManifest {
		this.#lastPublicationResult = undefined;
		if (!Number.isInteger(options.entrySchemaVersion) || options.entrySchemaVersion < 1)
			throw new Error("Invalid entry schema version");
		if (typeof options.rootId !== "string" || options.rootId.length === 0) throw new Error("Invalid root ID");
		if (!Number.isSafeInteger(options.generation) || options.generation < 0) throw new Error("Invalid generation");
		const maxEntries = options.maxEntriesPerSegment ?? 256;
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Invalid segment size");
		const descriptors: SessionManifest["segments"] = [];
		const checkpoints: SessionManifest["checkpoints"] = [];
		let pending: string[] = [];
		let pendingBytes = 0;
		let entryCount = 0;
		let chain = "";
		const install = () => {
			if (pending.length === 0) return;
			const installed = this.segments.putImmutableSync(Buffer.from(`${pending.join("\n")}\n`, "utf8"));
			const descriptor = {
				hash: installed.hash,
				bytes: installed.bytes,
				entryCount: pending.length,
				firstEntry: entryCount - pending.length,
				lastEntry: entryCount - 1,
			};
			descriptors.push(descriptor);
			checkpoints.push({
				segmentOrdinal: descriptors.length - 1,
				segmentHash: descriptor.hash,
				entryCount,
				hash: chain,
			});
			pending = [];
			pendingBytes = 0;
		};
		for (const entry of entries) {
			const line = JSON.stringify(entry);
			if (line === undefined) throw new Error("Session entry is not JSON serializable");
			const lineBytes = Buffer.byteLength(line) + 1;
			if (pending.length > 0 && (pending.length === maxEntries || pendingBytes + lineBytes > MAX_SEGMENT_BYTES)) {
				install();
			}
			pending.push(line);
			pendingBytes += lineBytes;
			entryCount++;
			chain = sha256Hex(`${chain}\n${line}`);
			if (pending.length === maxEntries || pendingBytes >= MAX_SEGMENT_BYTES) install();
		}
		install();
		const manifest = createManifest({
			storageFormatVersion: STORAGE_FORMAT_VERSION,
			entrySchemaVersion: options.entrySchemaVersion,
			rootId: options.rootId,
			generation: options.generation,
			predecessorManifestChecksum: options.predecessorManifestChecksum ?? null,
			segments: descriptors,
			entryCount,
			checkpoints,
		});
		this.#lastPublicationResult = this.publisher.publishGeneration({
			inactiveManifestPath: this.manifestPath,
			eligibilityPath: `${this.manifestPath}.commit`,
			rootReferencePath: this.rootReferencePath,
			manifest,
			reference: {
				kind: "active",
				rootId: manifest.rootId,
				generation: manifest.generation,
				manifestId: manifest.checksum,
			},
			beforeRootReferenceActivation: this.beforeRootReferenceActivation,
		});
		return manifest;
	}
}
