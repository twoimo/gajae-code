import * as buffer from "node:buffer";
import * as fs from "node:fs";
import { BlobCorruptError } from "../blob-store";
import { parseManifest } from "./manifest";
import type { SegmentStore } from "./segment-store";
import type {
	SessionEntryTopology,
	SessionManifest,
	SessionMetadata,
	SessionPager,
	SessionReader,
	SessionRecoveryResult,
	UntrustedManifestHeader,
	ValidatedRootHandle,
} from "./types";

const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const UTF8_VALIDATION_CHUNK_BYTES = 64 * 1024;

function extendCheckpointChain(chain: string, line: string | Uint8Array): string {
	return new Bun.SHA256().update(chain).update("\n").update(line).digest("hex");
}

/** Reader for immutable v2 payloads. Header inspection is explicitly non-authoritative. */
export class V2SessionReader<T = unknown> implements SessionReader<T> {
	#manifest: SessionManifest | undefined;
	#result: SessionRecoveryResult<T> | undefined;
	#validated: ValidatedRootHandle | undefined;
	#topology: SessionEntryTopology[] | undefined;
	// The streaming readers verify segments on the fly and never retain decoded
	// segment lines, so there is no per-segment cache to hold.

	static readonly #topologyFields = {
		id: /"id":("(?:[^"\\]|\\.)*")/,
		type: /"type":("(?:[^"\\]|\\.)*")/,
		parentId: /"parentId":("(?:[^"\\]|\\.)*")/,
	};
	static readonly #nullParentId = /"parentId":null/;

	constructor(
		readonly manifestPath: string,
		readonly segments: SegmentStore,
		readonly validateEntry?: (entry: T, index: number) => void,
	) {}

	untrustedHeader(): UntrustedManifestHeader {
		const manifest = this.#loadManifest();
		return {
			storageFormatVersion: manifest.storageFormatVersion,
			entrySchemaVersion: manifest.entrySchemaVersion,
			rootId: manifest.rootId,
			generation: manifest.generation,
			manifestId: manifest.checksum,
			entryCount: manifest.entryCount,
		};
	}

	metadata(): SessionMetadata {
		const metadata = this.validateRoot().metadata;
		return metadata;
	}

	validateRoot(): ValidatedRootHandle {
		if (this.#validated) return this.#validated;
		this.#validate();
		return this.#validated!;
	}

	openPager(): SessionPager<T> {
		this.validateRoot();
		return {
			topology: () => this.#topology!.values(),
			readRange: (firstEntry, lastEntry) => this.#readRange(firstEntry, lastEntry),
			release: () => this.releaseValidatedSegments(),
		};
	}

	releaseValidatedSegments(): void {
		// No retained segment state: streaming reads hold nothing to release.
		// Kept to satisfy the pager `release()` contract.
	}

	*entries(): IterableIterator<T> {
		yield* this.readAll().entries;
	}

	read(): SessionRecoveryResult<T> {
		return this.readAll();
	}
	readAll(): SessionRecoveryResult<T> {
		if (this.#result) return this.#result;
		const entries: T[] = [];
		this.#validate(entries);
		this.#result = { entries, metadata: this.#validated!.metadata };
		return this.#result;
	}

	#validate(entries?: T[]): void {
		const manifest = this.#loadManifest();
		const topology: SessionEntryTopology[] = [];
		let entryCount = 0;
		let chain = "";
		const validationBuffers = {
			readBuffer: Buffer.allocUnsafe(UTF8_VALIDATION_CHUNK_BYTES),
			lineBuffer: Buffer.allocUnsafe(MAX_JSONL_LINE_BYTES),
			verificationBuffer: Buffer.allocUnsafe(UTF8_VALIDATION_CHUNK_BYTES),
		};
		for (let ordinal = 0; ordinal < manifest.segments.length; ordinal++) {
			const descriptor = manifest.segments[ordinal];
			let segmentEntries = 0;
			this.#forEachVerifiedLine(
				descriptor.hash,
				line => {
					const entry = this.#parseRetainedLine(line.toString("utf8"), descriptor.hash);
					this.validateEntry?.(entry, entryCount);
					if (entries) entries.push(entry);
					topology.push(this.#topologyFromBuffer(line, entryCount));
					chain = extendCheckpointChain(chain, line);
					entryCount++;
					segmentEntries++;
				},
				validationBuffers,
			);
			if (
				segmentEntries !== descriptor.entryCount ||
				entryCount - segmentEntries !== descriptor.firstEntry ||
				entryCount - 1 !== descriptor.lastEntry
			)
				throw new Error(`Segment ${descriptor.hash} entry range mismatch`);
			const checkpoint = manifest.checkpoints.find(value => value.segmentOrdinal === ordinal);
			if (
				!checkpoint ||
				checkpoint.segmentHash !== descriptor.hash ||
				checkpoint.entryCount !== entryCount ||
				checkpoint.hash !== chain
			)
				throw new Error("Checkpoint commitment mismatch");
		}
		if (entryCount !== manifest.entryCount) throw new Error("Manifest entry coverage mismatch");
		this.#topology = topology;
		this.#validated = {
			manifest,
			metadata: {
				storageFormatVersion: manifest.storageFormatVersion,
				entrySchemaVersion: manifest.entrySchemaVersion,
				rootId: manifest.rootId,
				generation: manifest.generation,
				entryCount: manifest.entryCount,
			},
		};
	}

	#topologyFromBuffer(line: Buffer, index: number): SessionEntryTopology {
		const prefix = line.subarray(0, Math.min(line.byteLength, 4096));
		let decoded: string;
		try {
			decoded = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
		} catch {
			throw new Error("Session entry topology is invalid");
		}
		return this.#topologyFromLine(decoded, index, line.byteLength);
	}

	#topologyFromLine(line: string, index: number, byteLength = Buffer.byteLength(line)): SessionEntryTopology {
		const stringField = (name: "id" | "type" | "parentId"): string | undefined => {
			const match = V2SessionReader.#topologyFields[name].exec(line);
			if (!match) return undefined;
			try {
				return Buffer.from(JSON.parse(match[1]) as string).toString("utf8");
			} catch {
				throw new Error("Session entry topology is invalid");
			}
		};
		const id = stringField("id");
		const type = stringField("type");
		const parentId = stringField("parentId");
		if (!id || !type) return { index, id: `#${index}`, parentId: null, type: "unknown", byteLength };
		if (parentId === undefined && !V2SessionReader.#nullParentId.test(line) && type !== "session")
			throw new Error("Session entry topology is invalid");
		return { index, id, parentId: parentId ?? null, type, byteLength };
	}

	#forEachVerifiedLine(
		hash: string,
		visit: (line: Buffer) => void,
		buffers?: { readBuffer: Buffer; lineBuffer: Buffer; verificationBuffer?: Buffer },
	): void {
		this.segments.verifySync(hash, buffers?.verificationBuffer);
		const fd = fs.openSync(this.segments.pathFor(hash), "r");
		const readBuffer = buffers?.readBuffer ?? Buffer.allocUnsafe(UTF8_VALIDATION_CHUNK_BYTES);
		const lineBuffer = buffers?.lineBuffer ?? Buffer.allocUnsafe(MAX_JSONL_LINE_BYTES);
		let lineLength = 0;
		try {
			for (;;) {
				const count = fs.readSync(fd, readBuffer, 0, readBuffer.length, null);
				if (count === 0) break;
				const chunk = readBuffer.subarray(0, count);
				let start = 0;
				for (let end = chunk.indexOf(0x0a, start); end !== -1; end = chunk.indexOf(0x0a, start)) {
					const length = end - start;
					if (lineLength + length === 0 || lineLength + length > MAX_JSONL_LINE_BYTES)
						throw new Error(`Segment ${hash} contains invalid JSONL record`);
					chunk.copy(lineBuffer, lineLength, start, end);
					lineLength += length;
					this.#validateUtf8(lineBuffer.subarray(0, lineLength), hash);
					visit(lineBuffer.subarray(0, lineLength));
					lineLength = 0;
					start = end + 1;
				}
				if (start < count) {
					const length = count - start;
					if (lineLength + length > MAX_JSONL_LINE_BYTES)
						throw new Error(`Segment ${hash} contains invalid JSONL record`);
					chunk.copy(lineBuffer, lineLength, start, count);
					lineLength += length;
				}
			}
			if (lineLength !== 0) throw new Error(`Segment ${hash} is not newline terminated`);
		} finally {
			fs.closeSync(fd);
		}
	}

	#validateUtf8(data: Buffer, hash: string): void {
		if (!buffer.isUtf8(data)) throw new Error(`Segment ${hash} contains invalid UTF-8`);
	}
	#readRange(firstEntry: number, lastEntry: number): T[] {
		const manifest = this.#loadManifest();
		if (
			!Number.isSafeInteger(firstEntry) ||
			!Number.isSafeInteger(lastEntry) ||
			firstEntry < 0 ||
			lastEntry < firstEntry
		)
			throw new Error("Invalid session entry range");
		if (lastEntry >= manifest.entryCount) throw new Error("Session entry range exceeds manifest");
		const entries: T[] = [];
		for (const descriptor of manifest.segments) {
			if (descriptor.lastEntry < firstEntry || descriptor.firstEntry > lastEntry) continue;
			let index = descriptor.firstEntry;
			this.#forEachVerifiedLine(descriptor.hash, line => {
				if (index >= firstEntry && index <= lastEntry) {
					entries.push(this.#parseRetainedLine(line.toString("utf8"), descriptor.hash));
				}
				index++;
			});
		}
		return entries;
	}

	#loadManifest(): SessionManifest {
		if (!this.#manifest) this.#manifest = parseManifest(fs.readFileSync(this.manifestPath, "utf8"));
		return this.#manifest;
	}

	#parseLine(line: string, hash: string): T {
		try {
			return JSON.parse(line) as T;
		} catch {
			throw new Error(`Segment ${hash} contains malformed JSON`);
		}
	}

	#parseRetainedLine(line: string, hash: string): T {
		return this.#parseLine(Buffer.from(line).toString("utf8"), hash);
	}
}

/** Recovery stops before the first missing or corrupt complete segment. */
export function recoverV2Prefix<T = unknown>(manifestPath: string, segments: SegmentStore): SessionRecoveryResult<T> {
	const reader = new V2SessionReader<T>(manifestPath, segments);
	const header = reader.untrustedHeader();
	const parsed = parseManifest(fs.readFileSync(manifestPath, "utf8"));
	const entries: T[] = [];
	let chain = "";
	let checkpoint: SessionRecoveryResult<T>["recoveredAtCheckpoint"];
	for (let ordinal = 0; ordinal < parsed.segments.length; ordinal++) {
		const descriptor = parsed.segments[ordinal];
		try {
			segments.verifySync(descriptor.hash);
			const data = segments.readCheckedSync(descriptor.hash);
			const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
			const linesForSegment = decoded.split("\n");
			if (linesForSegment.pop() !== "" || linesForSegment.length !== descriptor.entryCount)
				throw new Error("Segment structure mismatch");
			const parsedEntries = linesForSegment.map(line => JSON.parse(line) as T);
			for (const line of linesForSegment) chain = extendCheckpointChain(chain, line);
			const boundary = parsed.checkpoints.find(value => value.segmentOrdinal === ordinal);
			if (
				!boundary ||
				boundary.segmentHash !== descriptor.hash ||
				boundary.entryCount !== entries.length + parsedEntries.length ||
				boundary.hash !== chain
			)
				throw new Error("Checkpoint commitment mismatch");
			entries.push(...parsedEntries);
			checkpoint = { entryCount: boundary.entryCount, hash: boundary.hash };
		} catch {
			break;
		}
	}
	if (!checkpoint) throw new BlobCorruptError(parsed.segments[0]?.hash ?? "", segments.dir);
	return {
		entries,
		metadata: {
			storageFormatVersion: header.storageFormatVersion,
			entrySchemaVersion: header.entrySchemaVersion,
			rootId: header.rootId,
			generation: header.generation,
			entryCount: entries.length,
		},
		recoveredAtCheckpoint: checkpoint,
	};
}
