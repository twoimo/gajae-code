export * from "./gc";
export * from "./manifest";
export * from "./root-recovery";
export * from "./segment-store";
export * from "./types";
export * from "./v1-reader";
export * from "./v2-reader";
export * from "./v2-writer";

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionSideIndex } from "./types";
import type { V2SessionReader } from "./v2-reader";

export class SessionIndexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionIndexError";
	}
}

/** Side indexes are disposable projections; this validates roots before projecting them. */
export function rebuildSessionSideIndex(roots: Iterable<{ root: string; reader: V2SessionReader }>): SessionSideIndex {
	const entries: SessionSideIndex["entries"] = [];
	for (const { root, reader } of roots) {
		for (const _entry of reader.entries()) {
			// Exhaust the iterator: a manifest without validated payloads is not authoritative.
		}
		const metadata = reader.metadata();
		if (
			metadata.generation === undefined ||
			metadata.entrySchemaVersion === undefined ||
			metadata.entryCount === undefined
		)
			throw new SessionIndexError("Root did not provide v2 metadata");
		entries.push({
			root,
			generation: metadata.generation,
			entryCount: metadata.entryCount,
			entrySchemaVersion: metadata.entrySchemaVersion,
		});
	}
	entries.sort((a, b) => a.root.localeCompare(b.root) || b.generation - a.generation);
	return { version: 1, entries };
}

export function readSessionSideIndex(indexPath: string): SessionSideIndex | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as SessionSideIndex;
		if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
		for (const entry of parsed.entries) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
			const candidate = entry as Partial<SessionSideIndex["entries"][number]>;
			if (
				typeof candidate.root !== "string" ||
				candidate.root.length === 0 ||
				typeof candidate.generation !== "number" ||
				!Number.isSafeInteger(candidate.generation) ||
				candidate.generation < 0 ||
				typeof candidate.entryCount !== "number" ||
				!Number.isSafeInteger(candidate.entryCount) ||
				candidate.entryCount < 0 ||
				typeof candidate.entrySchemaVersion !== "number" ||
				!Number.isInteger(candidate.entrySchemaVersion) ||
				candidate.entrySchemaVersion < 1
			)
				return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export function writeSessionSideIndex(indexPath: string, index: SessionSideIndex): void {
	fs.mkdirSync(path.dirname(indexPath), { recursive: true });
	const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tempPath, `${JSON.stringify(index)}\n`, "utf8");
	fs.renameSync(tempPath, indexPath);
}

export function loadOrRebuildSessionSideIndex(
	indexPath: string,
	roots: Iterable<{ root: string; reader: V2SessionReader }>,
): SessionSideIndex {
	return readSessionSideIndex(indexPath) ?? rebuildSessionSideIndex(roots);
}
