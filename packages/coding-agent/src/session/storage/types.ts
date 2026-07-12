export const STORAGE_FORMAT_VERSION = 2;

export type SessionRootKind = "active" | "rollback" | "export";
export type SessionRootId = string;
export type ManifestId = string;

/** One ordered occurrence of an immutable payload object. Hashes may repeat. */
export interface SegmentDescriptor {
	hash: string;
	bytes: number;
	entryCount: number;
	firstEntry: number;
	lastEntry: number;
}

/** A commitment to a prefix ending at a complete, independently verifiable segment. */
export interface SessionCheckpoint {
	segmentOrdinal: number;
	segmentHash: string;
	entryCount: number;
	hash: string;
}

/** Immutable, role-neutral description of one root generation. */
export interface SessionManifest {
	storageFormatVersion: typeof STORAGE_FORMAT_VERSION;
	entrySchemaVersion: number;
	rootId: SessionRootId;
	generation: number;
	predecessorManifestChecksum: ManifestId | null;
	segments: SegmentDescriptor[];
	entryCount: number;
	checkpoints: SessionCheckpoint[];
	checksum: ManifestId;
}

/** Mutable publication state. A manifest may have more than one reference. */
export interface RootReference {
	kind: SessionRootKind;
	rootId: SessionRootId;
	generation: number;
	manifestId: ManifestId;
	/** Unique durable registration for concurrently live export roots. */
	token?: string;
}

export interface SessionMetadata {
	storageFormatVersion: number;
	entrySchemaVersion?: number;
	rootId?: SessionRootId;
	generation?: number;
	entryCount?: number;
}

export interface SessionRecoveryResult<T = unknown> {
	entries: T[];
	metadata: SessionMetadata;
	quarantinedTail?: string;
	recoveredAtCheckpoint?: Pick<SessionCheckpoint, "entryCount" | "hash">;
}

/** Parsed manifest data is not authoritative until it has a ValidatedRootHandle. */
export interface UntrustedManifestHeader {
	storageFormatVersion: typeof STORAGE_FORMAT_VERSION;
	entrySchemaVersion: number;
	rootId: SessionRootId;
	generation: number;
	manifestId: ManifestId;
	entryCount: number;
}

export interface ValidatedRootHandle {
	manifest: SessionManifest;
	metadata: Required<
		Pick<SessionMetadata, "storageFormatVersion" | "entrySchemaVersion" | "rootId" | "generation" | "entryCount">
	>;
}

export interface SessionEntryTopology {
	index: number;
	id: string;
	parentId: string | null;
	type: string;
	byteLength: number;
}

/** Validated, bounded access to an immutable session journal. */
export interface SessionPager<T = unknown> {
	topology(): Iterable<SessionEntryTopology>;
	readRange(firstEntry: number, lastEntry: number): T[];
	/** Releases transient segment buffers retained after validation. */
	release?(): void;
}

/** Owns a validated reader and pins its manifest/segments until close(). */
export interface ValidatedRootLease<T = unknown> extends ValidatedRootHandle {
	reader: SessionReader<T>;
	openPager(): SessionPager<T>;
	close(): void;
}

export interface SessionReader<T = unknown> {
	metadata(): SessionMetadata;
	entries(): IterableIterator<T>;
	readAll(): SessionRecoveryResult<T>;
	/** @deprecated Use readAll() only where a materialized compatibility result is required. */
	read(): SessionRecoveryResult<T>;
}

export interface SessionRootResolver<T = unknown> {
	resolve(root: RootReference): ValidatedRootHandle;
	lease(root: RootReference): ValidatedRootLease<T>;
	reader(root: RootReference): SessionReader<T>;
}

export interface SessionGenerationWriter<T = unknown> {
	write(entries: Iterable<T>, options: SessionGenerationWriteOptions): SessionManifest;
}

export interface SessionGenerationWriteOptions {
	entrySchemaVersion: number;
	rootId: SessionRootId;
	generation: number;
	predecessorManifestChecksum?: ManifestId | null;
	maxEntriesPerSegment?: number;
}

export interface SessionPublication {
	inactiveManifestPath: string;
	/** Written last after all role authority records are durable; recovery requires it. */
	eligibilityPath: string;
	rootReferencePath: string;
	manifest: SessionManifest;
	reference: RootReference;
	/** Persist non-active authority records before making this generation recoverable. */
	beforeRootReferenceActivation?(reference: RootReference): void;
}

export interface SessionPublicationResult {
	reference: RootReference;
	durabilityUncertain: boolean;
}

export interface SessionPublisher {
	/** Publish the inactive manifest slot, then atomically activate its root role. */
	publishGeneration(publication: SessionPublication): SessionPublicationResult;
}

export interface SessionRecovery {
	recover(rootId: SessionRootId): ValidatedRootHandle | null;
	recoverPrefix<T = unknown>(manifestPath: string): SessionRecoveryResult<T>;
}

export interface RootRegistry {
	replace(reference: RootReference): void;
	unregister(kind: SessionRootKind, rootId: SessionRootId, token?: string): void;
	/** Retain a root in GC snapshots until the returned release function is called. */
	pin(reference: RootReference): { close(): void };
	/** A stable copy suitable for one GC reachability pass. */
	snapshot(): readonly RootReference[];
	entries(): Iterable<RootReference>;
}

export interface SessionSideIndexEntry {
	root: string;
	generation: number;
	entryCount: number;
	entrySchemaVersion: number;
}

export interface SessionSideIndex {
	version: 1;
	entries: SessionSideIndexEntry[];
}
