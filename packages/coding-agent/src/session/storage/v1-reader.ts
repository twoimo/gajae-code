import * as fs from "node:fs";
import { sha256Hex } from "./manifest";
import type { SessionCheckpoint, SessionMetadata, SessionReader, SessionRecoveryResult } from "./types";

const MAX_JSONL_LINE_BYTES = 1024 * 1024;

export class V1RecoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "V1RecoveryError";
	}
}

interface CheckpointRecord {
	type: "checkpoint";
	entryCount: number;
	hash: string;
}
function isCheckpoint(value: unknown): value is CheckpointRecord {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "checkpoint" &&
		Number.isSafeInteger((value as { entryCount?: unknown }).entryCount) &&
		typeof (value as { hash?: unknown }).hash === "string"
	);
}
function isHeader(value: unknown): value is { type: "session"; version?: number } {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "session" &&
		(!("version" in value) || typeof (value as { version?: unknown }).version === "number")
	);
}
function chainHash(previous: string, line: string): string {
	return sha256Hex(`${previous}\n${line}`);
}

/** Strict, byte-bounded legacy JSONL reader. Only a malformed final partial record is quarantined. */
export class V1SessionReader<T = unknown> implements SessionReader<T> {
	#result: SessionRecoveryResult<T> | undefined;

	constructor(readonly filePath: string) {}

	metadata(): SessionMetadata {
		const iterator = this.#lines();
		const first = iterator.next();
		if (first.done || first.value.final) throw new V1RecoveryError("Session is missing a complete header");
		const header = this.#parse(first.value.line, "Malformed first JSONL record");
		if (!isHeader(header)) throw new V1RecoveryError("First JSONL record must be a session header");
		return { storageFormatVersion: 1, entrySchemaVersion: header.version, entryCount: this.#result?.entries.length };
	}

	*entries(): IterableIterator<T> {
		const scan = this.#scan();
		let yielded = 0;
		for (const record of this.#lines()) {
			if (record.final || record.line.length === 0) break;
			const parsed = this.#parse(record.line, "Malformed complete JSONL record");
			if (isCheckpoint(parsed)) continue;
			yield parsed as T;
			yielded++;
			if (yielded === scan.retainedCount) return;
		}
	}

	read(): SessionRecoveryResult<T> {
		return this.readAll();
	}

	readAll(): SessionRecoveryResult<T> {
		if (this.#result) return this.#result;
		const scan = this.#scan();
		this.#result = {
			entries: [...this.entries()],
			metadata: scan.metadata,
			...(scan.quarantinedTail === undefined ? {} : { quarantinedTail: scan.quarantinedTail }),
			...(scan.checkpoint === undefined ? {} : { recoveredAtCheckpoint: scan.checkpoint }),
		};
		return this.#result;
	}

	#scan(): {
		retainedCount: number;
		metadata: SessionMetadata;
		checkpoint?: Pick<SessionCheckpoint, "entryCount" | "hash">;
		quarantinedTail?: string;
	} {
		let entryCount = 0;
		let hash = "";
		let checkpoint: Pick<SessionCheckpoint, "entryCount" | "hash"> | undefined;
		let header: { type: "session"; version?: number } | undefined;
		const recover = (message: string, quarantinedTail?: string) => {
			if (!checkpoint && quarantinedTail === undefined) throw new V1RecoveryError(message);
			const retainedCount = checkpoint?.entryCount ?? entryCount;
			if (!header || retainedCount === 0) throw new V1RecoveryError(message);
			return {
				retainedCount,
				metadata: {
					storageFormatVersion: 1,
					entrySchemaVersion: header.version,
					entryCount: retainedCount,
				},
				...(checkpoint === undefined ? {} : { checkpoint }),
				...(quarantinedTail === undefined ? {} : { quarantinedTail }),
			};
		};
		for (const record of this.#lines()) {
			if (record.line.length === 0)
				return record.final
					? recover("Empty final JSONL record", record.line)
					: recover("Empty complete JSONL record");
			let parsed: unknown;
			try {
				parsed = JSON.parse(record.line);
			} catch {
				return record.final
					? recover("Malformed final JSONL record", record.line)
					: recover("Malformed complete JSONL record");
			}
			if (entryCount === 0) {
				if (!isHeader(parsed)) throw new V1RecoveryError("First JSONL record must be a session header");
				header = parsed;
			}
			if (isCheckpoint(parsed)) {
				if (parsed.entryCount !== entryCount || parsed.entryCount === 0 || parsed.hash !== hash)
					return recover("Invalid checkpoint commitment");
				checkpoint = { entryCount: parsed.entryCount, hash: parsed.hash };
				continue;
			}
			entryCount++;
			hash = chainHash(hash, record.line);
		}
		if (!header) throw new V1RecoveryError("Session is missing a session header");
		return {
			retainedCount: entryCount,
			metadata: { storageFormatVersion: 1, entrySchemaVersion: header.version, entryCount },
		};
	}

	*#lines(): IterableIterator<{ line: string; final: boolean }> {
		const fd = fs.openSync(this.filePath, "r");
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let pending = "";
		try {
			const chunk = Buffer.allocUnsafe(64 * 1024);
			for (;;) {
				const count = fs.readSync(fd, chunk, 0, chunk.length, null);
				if (count === 0) break;
				try {
					pending += decoder.decode(chunk.subarray(0, count), { stream: true });
				} catch {
					throw new V1RecoveryError("Invalid UTF-8 JSONL data");
				}
				for (;;) {
					const newline = pending.indexOf("\n");
					if (newline < 0) break;
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES)
						throw new V1RecoveryError("JSONL record exceeds byte limit");
					yield { line, final: false };
				}
				if (Buffer.byteLength(pending) > MAX_JSONL_LINE_BYTES)
					throw new V1RecoveryError("JSONL record exceeds byte limit");
			}
			try {
				pending += decoder.decode();
			} catch {
				throw new V1RecoveryError("Invalid UTF-8 JSONL data");
			}
			if (pending.length > 0) yield { line: pending, final: true };
		} finally {
			fs.closeSync(fd);
		}
	}

	#parse(line: string, message: string): unknown {
		try {
			return JSON.parse(line);
		} catch {
			throw new V1RecoveryError(message);
		}
	}
	#metadata(entries: T[]): SessionMetadata {
		const header = entries[0] as { version?: unknown };
		return {
			storageFormatVersion: 1,
			entrySchemaVersion: typeof header.version === "number" ? header.version : undefined,
			entryCount: entries.length,
		};
	}
}

export function readV1Session<T = unknown>(filePath: string): SessionRecoveryResult<T> {
	return new V1SessionReader<T>(filePath).readAll();
}
