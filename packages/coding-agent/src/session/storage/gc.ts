import * as fs from "node:fs";
import * as path from "node:path";
import type { SegmentStore } from "./segment-store";
import type { RootReference, RootRegistry, SessionRootResolver } from "./types";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BLOB_REFERENCE_PATTERN = /^blob:sha256:([a-f0-9]{64})$/;

export interface SessionStorageGcOptions {
	registry: RootRegistry;
	resolver: SessionRootResolver;
	segments: SegmentStore;
	/** Durable, non-authoritative age bookkeeping. A missing or invalid state starts ages over. */
	statePath: string;
	/** Invalid root-reference files are moved here rather than being accepted or deleted. */
	quarantineDir: string;
	/** Maps every snapshot root reference to the durable root-reference file that named it. */
	rootReferencePaths: ReadonlyMap<string, string>;
}

export interface SessionStorageGcResult {
	generation: number;
	markedSegments: readonly string[];
	markedBlobs: readonly string[];
	deletedSegments: readonly string[];
	retainedUnreferencedSegments: readonly string[];
	quarantinedRoots: readonly RootReference[];
}

interface GcState {
	version: 1;
	generation: number;
	unreferencedSegmentAges: Record<string, number>;
}

/**
 * Conservative generational collector for immutable v2 session segments.
 *
 * Segment reachability comes exclusively from validated root snapshots. Side indexes
 * are deliberately absent from this API because they are not authoritative. Blob
 * references found inside retained logical entries are reported as marks for the
 * global blob store, which this collector never deletes.
 */
export class SessionStorageGc {
	constructor(readonly options: SessionStorageGcOptions) {}

	run(): SessionStorageGcResult {
		const state = this.#readState();
		const markedSegments = new Set<string>();
		const markedBlobs = new Set<string>();
		const quarantinedRoots: RootReference[] = [];

		for (const root of this.options.registry.snapshot()) {
			try {
				const lease = this.options.resolver.lease(root);
				try {
					for (const segment of lease.manifest.segments) markedSegments.add(segment.hash);
					for (const entry of lease.reader.entries()) this.#markLogicalBlobReferences(entry, markedBlobs);
				} finally {
					lease.close();
				}
			} catch {
				quarantinedRoots.push({ ...root });
				this.#quarantineRoot(root);
			}
		}

		const ages: Record<string, number> = {};
		const deletedSegments: string[] = [];
		const retainedUnreferencedSegments: string[] = [];
		for (const hash of this.#segmentHashes()) {
			if (markedSegments.has(hash)) continue;
			const age = (state.unreferencedSegmentAges[hash] ?? 0) + 1;
			if (age >= 2) {
				fs.unlinkSync(this.options.segments.pathFor(hash));
				deletedSegments.push(hash);
			} else {
				ages[hash] = age;
				retainedUnreferencedSegments.push(hash);
			}
		}
		this.#writeState({ version: 1, generation: state.generation + 1, unreferencedSegmentAges: ages });

		return {
			generation: state.generation + 1,
			markedSegments: [...markedSegments].sort(),
			markedBlobs: [...markedBlobs].sort(),
			deletedSegments: deletedSegments.sort(),
			retainedUnreferencedSegments: retainedUnreferencedSegments.sort(),
			quarantinedRoots,
		};
	}

	#markLogicalBlobReferences(value: unknown, markedBlobs: Set<string>): void {
		const pending: unknown[] = [value];
		while (pending.length > 0) {
			const current = pending.pop();
			if (typeof current === "string") {
				const match = BLOB_REFERENCE_PATTERN.exec(current);
				if (match) markedBlobs.add(match[1]);
				continue;
			}
			if (!current || typeof current !== "object") continue;
			if (Array.isArray(current)) {
				pending.push(...current);
				continue;
			}
			const record = current as Record<string, unknown>;
			if (record.kind === "cold_spill" && typeof record.sha256 === "string" && HASH_PATTERN.test(record.sha256))
				markedBlobs.add(record.sha256);
			pending.push(...Object.values(record));
		}
	}

	#segmentHashes(): string[] {
		try {
			return fs
				.readdirSync(this.options.segments.dir, { withFileTypes: true })
				.filter(entry => entry.isFile() && HASH_PATTERN.test(entry.name))
				.map(entry => entry.name);
		} catch (error) {
			if (this.#isCode(error, "ENOENT")) return [];
			throw error;
		}
	}

	#quarantineRoot(root: RootReference): void {
		const rootPath = this.options.rootReferencePaths.get(this.#rootKey(root));
		if (!rootPath)
			throw new Error(`No durable root-reference path is registered for invalid root ${this.#rootKey(root)}`);
		if (!fs.existsSync(rootPath)) return;
		fs.mkdirSync(this.options.quarantineDir, { recursive: true });
		const destination = path.join(
			this.options.quarantineDir,
			`${path.basename(rootPath)}.${root.kind}.${encodeURIComponent(root.rootId)}.${root.generation}.${root.manifestId}.invalid`,
		);
		fs.renameSync(rootPath, destination);
	}

	#readState(): GcState {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(this.options.statePath, "utf8"));
		} catch (error) {
			if (this.#isCode(error, "ENOENT") || error instanceof SyntaxError)
				return { version: 1, generation: 0, unreferencedSegmentAges: {} };
			throw error;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return { version: 1, generation: 0, unreferencedSegmentAges: {} };
		const state = parsed as Partial<GcState>;
		if (
			state.version !== 1 ||
			typeof state.generation !== "number" ||
			!Number.isSafeInteger(state.generation) ||
			state.generation < 0 ||
			!state.unreferencedSegmentAges ||
			typeof state.unreferencedSegmentAges !== "object" ||
			Array.isArray(state.unreferencedSegmentAges)
		)
			return { version: 1, generation: 0, unreferencedSegmentAges: {} };
		const ages: Record<string, number> = {};
		for (const [hash, age] of Object.entries(state.unreferencedSegmentAges))
			if (HASH_PATTERN.test(hash) && typeof age === "number" && Number.isSafeInteger(age) && age > 0)
				ages[hash] = age;
		return { version: 1, generation: state.generation, unreferencedSegmentAges: ages };
	}

	#writeState(state: GcState): void {
		fs.mkdirSync(path.dirname(this.options.statePath), { recursive: true });
		const temporary = `${this.options.statePath}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
		fs.renameSync(temporary, this.options.statePath);
	}

	#rootKey(root: RootReference): string {
		return `${root.kind}:${root.rootId}:${root.generation}:${root.manifestId}`;
	}

	#isCode(error: unknown, code: string): boolean {
		return typeof error === "object" && error !== null && "code" in error && error.code === code;
	}
}

export function rootReferenceGcKey(root: RootReference): string {
	return `${root.kind}:${root.rootId}:${root.generation}:${root.manifestId}`;
}
