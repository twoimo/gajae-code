import { type SessionManifest, STORAGE_FORMAT_VERSION } from "./types";

export class ManifestValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestValidationError";
	}
}

function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
		.join(",")}}`;
}

export function sha256Hex(data: string | Buffer): string {
	return new Bun.SHA256().update(data).digest("hex");
}

export function manifestChecksum(manifest: Omit<SessionManifest, "checksum">): string {
	return sha256Hex(canonicalize(manifest));
}

export function createManifest(manifest: Omit<SessionManifest, "checksum">): SessionManifest {
	return { ...manifest, checksum: manifestChecksum(manifest) };
}

export function serializeManifest(manifest: SessionManifest): string {
	validateManifest(manifest);
	return `${canonicalize(manifest)}\n`;
}

export function parseManifest(text: string): SessionManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ManifestValidationError("Manifest is not valid JSON");
	}
	validateManifest(parsed);
	return parsed;
}

function validHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateManifest(value: unknown): asserts value is SessionManifest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ManifestValidationError("Manifest must be an object");
	const manifest = value as Partial<SessionManifest>;
	if (manifest.storageFormatVersion !== STORAGE_FORMAT_VERSION)
		throw new ManifestValidationError("Unsupported storage format version");
	if (
		typeof manifest.entrySchemaVersion !== "number" ||
		!Number.isInteger(manifest.entrySchemaVersion) ||
		manifest.entrySchemaVersion < 1
	)
		throw new ManifestValidationError("Invalid entry schema version");
	if (typeof manifest.rootId !== "string" || manifest.rootId.length === 0)
		throw new ManifestValidationError("Invalid root ID");
	if (typeof manifest.generation !== "number" || !Number.isSafeInteger(manifest.generation) || manifest.generation < 0)
		throw new ManifestValidationError("Invalid generation");
	if (manifest.predecessorManifestChecksum !== null && !validHash(manifest.predecessorManifestChecksum))
		throw new ManifestValidationError("Invalid predecessor manifest checksum");
	if (
		!Array.isArray(manifest.segments) ||
		typeof manifest.entryCount !== "number" ||
		!Number.isSafeInteger(manifest.entryCount) ||
		manifest.entryCount < 0
	)
		throw new ManifestValidationError("Invalid segment list or entry count");
	let nextEntry = 0;
	for (const segment of manifest.segments) {
		if (!segment || typeof segment !== "object" || !validHash(segment.hash))
			throw new ManifestValidationError("Invalid segment hash");
		if (
			!Number.isSafeInteger(segment.bytes) ||
			segment.bytes < 0 ||
			!Number.isSafeInteger(segment.entryCount) ||
			segment.entryCount < 1 ||
			segment.firstEntry !== nextEntry ||
			segment.lastEntry !== nextEntry + segment.entryCount - 1
		)
			throw new ManifestValidationError("Invalid segment entry range");
		nextEntry += segment.entryCount;
	}
	if (nextEntry !== manifest.entryCount) throw new ManifestValidationError("Segment ranges do not cover entry count");
	if (!Array.isArray(manifest.checkpoints)) throw new ManifestValidationError("Invalid checkpoints");
	let previousOrdinal = -1;
	for (const checkpoint of manifest.checkpoints) {
		if (
			!checkpoint ||
			typeof checkpoint !== "object" ||
			!Number.isSafeInteger(checkpoint.segmentOrdinal) ||
			checkpoint.segmentOrdinal <= previousOrdinal ||
			checkpoint.segmentOrdinal < 0 ||
			checkpoint.segmentOrdinal >= manifest.segments.length ||
			!validHash(checkpoint.segmentHash) ||
			!Number.isSafeInteger(checkpoint.entryCount) ||
			checkpoint.entryCount < 1 ||
			!validHash(checkpoint.hash)
		)
			throw new ManifestValidationError("Invalid checkpoint");
		const segment = manifest.segments[checkpoint.segmentOrdinal];
		if (checkpoint.segmentHash !== segment.hash || checkpoint.entryCount !== segment.lastEntry + 1)
			throw new ManifestValidationError("Checkpoint is not a segment boundary");
		previousOrdinal = checkpoint.segmentOrdinal;
	}
	if (typeof manifest.checksum !== "string" || !validHash(manifest.checksum))
		throw new ManifestValidationError("Invalid manifest checksum");
	const { checksum, ...unsigned } = manifest as SessionManifest;
	if (manifestChecksum(unsigned) !== checksum) throw new ManifestValidationError("Manifest checksum mismatch");
}
