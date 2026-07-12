import * as fs from "node:fs";
import * as path from "node:path";
import { BlobCorruptError } from "../blob-store";
import { sha256Hex } from "./manifest";

export interface SegmentStoreFaults {
	beforeInstall?(): void;
	beforeFileFsync?(): void;
	beforeDirectoryFsync?(): void;
}

/**
 * Fail-closed durable storage for authoritative session payloads. This deliberately
 * does not reuse BlobStore: BlobStore's flushing contract is best effort.
 */
export class SegmentStore {
	constructor(
		readonly dir: string,
		readonly faults: SegmentStoreFaults = {},
	) {}

	putImmutableSync(bytes: Buffer): { hash: string; bytes: number; path: string } {
		const hash = sha256Hex(bytes);
		const target = path.join(this.dir, hash);
		fs.mkdirSync(this.dir, { recursive: true });
		if (fs.existsSync(target)) {
			this.#verifyFile(hash, target);
			this.#syncExistingTarget(target);
			return { hash, bytes: bytes.byteLength, path: target };
		}
		const temporary = path.join(
			this.dir,
			`.${hash}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
		);
		try {
			const fd = fs.openSync(temporary, "wx");
			try {
				fs.writeFileSync(fd, bytes);
				this.faults.beforeFileFsync?.();
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			this.faults.beforeInstall?.();
			try {
				fs.linkSync(temporary, target);
			} catch (error) {
				if (!this.#isCode(error, "EEXIST")) throw error;
				this.#verifyFile(hash, target);
				this.#syncExistingTarget(target);
				return { hash, bytes: bytes.byteLength, path: target };
			}
			this.#verifyFile(hash, target);
			this.faults.beforeDirectoryFsync?.();
			this.#fsyncDirectory();
			return { hash, bytes: bytes.byteLength, path: target };
		} finally {
			try {
				fs.unlinkSync(temporary);
			} catch (error) {
				// Cleanup only: never let a missing temp override try/catch control flow.
				if (!this.#isCode(error, "ENOENT")) {
					// biome-ignore lint/correctness/noUnsafeFinally: intentional — a non-ENOENT cleanup failure must surface.
					throw error;
				}
			}
		}
	}

	readCheckedSync(hash: string): Buffer {
		const target = path.join(this.dir, hash);
		if (!fs.existsSync(target)) throw new BlobCorruptError(hash, target);
		return this.#verifyFile(hash, target);
	}

	verifySync(hash: string, readBuffer: Buffer = Buffer.allocUnsafe(64 * 1024)): void {
		const target = path.join(this.dir, hash);
		let fd: number | undefined;
		try {
			fd = fs.openSync(target, "r");
			const digest = new Bun.SHA256();
			const chunk = readBuffer;
			for (;;) {
				const count = fs.readSync(fd, chunk, 0, chunk.length, null);
				if (count === 0) break;
				digest.update(chunk.subarray(0, count));
			}

			if (digest.digest("hex") !== hash) throw new BlobCorruptError(hash, target);
		} catch (error) {
			if (this.#isCode(error, "ENOENT")) throw new BlobCorruptError(hash, target);
			throw error;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	#syncExistingTarget(target: string): void {
		let fd: number | undefined;
		try {
			fd = fs.openSync(target, "r");
			this.faults.beforeFileFsync?.();
			fs.fsyncSync(fd);
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		this.faults.beforeDirectoryFsync?.();
		this.#fsyncDirectory();
	}
	pathFor(hash: string): string {
		return path.join(this.dir, hash);
	}
	hasSync(hash: string): boolean {
		return fs.existsSync(path.join(this.dir, hash));
	}
	static hash(bytes: Buffer): string {
		return sha256Hex(bytes);
	}

	#verifyFile(hash: string, target: string): Buffer {
		const data = fs.readFileSync(target);
		if (sha256Hex(data) !== hash) throw new BlobCorruptError(hash, target);
		return data;
	}

	#fsyncDirectory(): void {
		const fd = fs.openSync(this.dir, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}

	#isCode(error: unknown, code: string): boolean {
		return typeof error === "object" && error !== null && "code" in error && error.code === code;
	}
}
