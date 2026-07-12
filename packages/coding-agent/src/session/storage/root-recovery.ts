import * as fs from "node:fs";
import * as path from "node:path";
import { publishCreateFile, publishReplaceFile } from "@gajae-code/natives";

import { parseManifest } from "./manifest";
import type { SegmentStore } from "./segment-store";
import type {
	RootReference,
	RootRegistry,
	SessionManifest,
	SessionReader,
	SessionRecovery,
	SessionRootId,
	SessionRootResolver,
	ValidatedRootHandle,
	ValidatedRootLease,
} from "./types";
import { recoverV2Prefix, V2SessionReader } from "./v2-reader";

/** Resolves a reference only after its manifest and every payload descriptor validate. */
export class FileSessionRootResolver<T = unknown> implements SessionRootResolver<T> {
	constructor(
		readonly manifestPaths: ReadonlyMap<string, string>,
		readonly segments: SegmentStore,
		readonly registry?: RootRegistry,
		readonly validateEntry?: (entry: T, index: number) => void,
	) {}

	resolve(reference: RootReference): ValidatedRootHandle {
		const reader = this.reader(reference);
		const handle = (reader as V2SessionReader<T>).validateRoot();
		if (
			handle.manifest.rootId !== reference.rootId ||
			handle.manifest.generation !== reference.generation ||
			handle.manifest.checksum !== reference.manifestId
		)
			throw new Error("Root reference does not match manifest");
		return handle;
	}

	lease(reference: RootReference): ValidatedRootLease<T> {
		const reader = this.reader(reference);
		const handle = (reader as V2SessionReader<T>).validateRoot();
		if (
			handle.manifest.rootId !== reference.rootId ||
			handle.manifest.generation !== reference.generation ||
			handle.manifest.checksum !== reference.manifestId
		)
			throw new Error("Root reference does not match manifest");
		const pin = this.registry?.pin(reference);
		let closed = false;
		return {
			...handle,
			reader,
			openPager: () => (reader as V2SessionReader<T>).openPager(),
			close: () => {
				if (closed) return;
				closed = true;
				pin?.close();
			},
		};
	}

	reader(reference: RootReference): SessionReader<T> {
		const manifestPath = this.manifestPaths.get(reference.manifestId);
		if (!manifestPath) throw new Error(`Manifest ${reference.manifestId} is not registered`);
		return new V2SessionReader<T>(manifestPath, this.segments, this.validateEntry);
	}
}

/** Dual-slot recovery accepts only the highest generation with a verified payload and local lineage. */
export class FileSessionRecovery implements SessionRecovery {
	constructor(
		readonly slotPaths: readonly string[],
		readonly segments: SegmentStore,
	) {}

	recover(rootId: SessionRootId): ValidatedRootHandle | null {
		const manifests: Array<{ path: string; manifest: SessionManifest }> = [];
		for (const slot of this.slotPaths) {
			try {
				const manifest = parseManifest(fs.readFileSync(slot, "utf8"));
				const eligibility = readRootReference(`${slot}.commit`);
				if (
					manifest.rootId === rootId &&
					eligibility.kind === "active" &&
					eligibility.rootId === manifest.rootId &&
					eligibility.generation === manifest.generation &&
					eligibility.manifestId === manifest.checksum
				)
					manifests.push({ path: slot, manifest });
			} catch {
				// A manifest without its completed role transaction is not recoverable.
			}
		}
		for (let index = 0; index < manifests.length; index++)
			for (let other = index + 1; other < manifests.length; other++)
				if (
					manifests[index].manifest.generation === manifests[other].manifest.generation &&
					manifests[index].manifest.checksum !== manifests[other].manifest.checksum
				)
					throw new Error("Root recovery split brain: divergent manifests share a generation");

		const candidates: Array<{ manifest: SessionManifest; handle: ValidatedRootHandle }> = [];
		for (const slot of manifests) {
			try {
				const reader = new V2SessionReader(slot.path, this.segments);
				candidates.push({ manifest: slot.manifest, handle: reader.validateRoot() });
			} catch {
				// A corrupt payload does not erase its checksum-valid lineage evidence.
			}
		}
		candidates.sort((left, right) => right.manifest.generation - left.manifest.generation);
		for (const candidate of candidates) {
			const manifest = candidate.manifest;
			const predecessor = manifests.find(
				other =>
					other.manifest.generation === manifest.generation - 1 &&
					other.manifest.checksum === manifest.predecessorManifestChecksum,
			);
			const successor = manifests.find(
				other =>
					other.manifest.generation === manifest.generation + 1 &&
					other.manifest.predecessorManifestChecksum === manifest.checksum,
			);
			if (
				(manifest.generation === 0 && manifest.predecessorManifestChecksum === null) ||
				predecessor !== undefined ||
				successor !== undefined
			)
				return candidate.handle;
		}
		return null;
	}

	recoverPrefix<T = unknown>(manifestPath: string) {
		return recoverV2Prefix<T>(manifestPath, this.segments);
	}
}

function rootRegistrationKey(reference: Pick<RootReference, "kind" | "rootId" | "token">): string {
	return `${reference.kind}:${reference.rootId}:${reference.token ?? ""}`;
}

/** In-memory registry seam; durable registry publication is supplied by SessionPublisher. */
export class MemoryRootRegistry implements RootRegistry {
	#references = new Map<string, RootReference>();
	#pins = new Map<string, { reference: RootReference; count: number }>();

	replace(reference: RootReference): void {
		this.#references.set(rootRegistrationKey(reference), { ...reference });
	}

	unregister(kind: RootReference["kind"], rootId: SessionRootId, token?: string): void {
		this.#references.delete(rootRegistrationKey({ kind, rootId, token }));
	}

	pin(reference: RootReference): { close(): void } {
		const key = `${rootRegistrationKey(reference)}:${reference.manifestId}`;
		const current = this.#pins.get(key);
		if (current) current.count++;
		else this.#pins.set(key, { reference: { ...reference }, count: 1 });
		let closed = false;
		return {
			close: () => {
				if (closed) return;
				closed = true;
				const pinned = this.#pins.get(key);
				if (!pinned) return;
				if (--pinned.count === 0) this.#pins.delete(key);
			},
		};
	}

	snapshot(): readonly RootReference[] {
		const roots = new Map<string, RootReference>();
		for (const reference of this.#references.values()) roots.set(reference.manifestId, { ...reference });
		for (const { reference } of this.#pins.values()) roots.set(reference.manifestId, { ...reference });
		return [...roots.values()];
	}

	*entries(): IterableIterator<RootReference> {
		yield* this.snapshot();
	}
}

/** File-backed root registry. Each replacement is fsynced, atomically published, and directory-fsynced before it is visible to GC. */
export class FileRootRegistry implements RootRegistry {
	#references = new Map<string, RootReference>();
	#pins = new Map<string, { reference: RootReference; count: number }>();

	constructor(readonly registryPath: string) {
		this.#load();
	}

	replace(reference: RootReference): void {
		this.#references.set(rootRegistrationKey(reference), { ...reference });
		this.#persist();
	}

	unregister(kind: RootReference["kind"], rootId: SessionRootId, token?: string): void {
		this.#references.delete(rootRegistrationKey({ kind, rootId, token }));
		this.#persist();
	}

	pin(reference: RootReference): { close(): void } {
		const key = `${rootRegistrationKey(reference)}:${reference.manifestId}`;
		const existing = this.#pins.get(key);
		if (existing) existing.count++;
		else this.#pins.set(key, { reference: { ...reference }, count: 1 });
		let closed = false;
		return {
			close: () => {
				if (closed) return;
				closed = true;
				const pinned = this.#pins.get(key);
				if (pinned && --pinned.count === 0) this.#pins.delete(key);
			},
		};
	}

	snapshot(): readonly RootReference[] {
		const roots = new Map<string, RootReference>();
		for (const reference of this.#references.values()) roots.set(rootRegistrationKey(reference), { ...reference });
		for (const reference of this.#readExportPins()) roots.set(rootRegistrationKey(reference), reference);
		for (const { reference } of this.#pins.values()) roots.set(rootRegistrationKey(reference), { ...reference });
		return [...roots.values()];
	}

	*entries(): IterableIterator<RootReference> {
		yield* this.snapshot();
	}

	#load(): void {
		try {
			const values: unknown = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
			if (!Array.isArray(values)) return;
			for (const value of values) {
				try {
					const reference = validateRootReference(value);
					this.#references.set(rootRegistrationKey(reference), reference);
				} catch {
					/* corrupt registry records are not authority */
				}
			}
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
	}

	#persist(): void {
		publishDurableRootFile(this.registryPath, `${JSON.stringify([...this.#references.values()])}\n`);
	}

	#readExportPins(): RootReference[] {
		const pinsDir = exportPinDirectory(this.registryPath);
		try {
			return fs.readdirSync(pinsDir, { withFileTypes: true }).flatMap(entry => {
				if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
				try {
					const reference = readRootReference(path.join(pinsDir, entry.name));
					return reference.kind === "export" && reference.token ? [reference] : [];
				} catch {
					return [];
				}
			});
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
	}
}

/** Publish a root authority record only after the replacement payload is durable. */
export function publishDurableRootFile(target: string, contents: string): void {
	publishDurableRootFileImpl(target, contents, "replace-or-create");
}

/**
 * Acquire durable ownership of a NEW authority file. Unlike
 * {@link publishDurableRootFile}, this never replaces an existing target: a
 * pre-existing file (token collision or racing create) fails instead of being
 * overwritten, so independent owners cannot clobber each other.
 */
export function createDurableRootFile(target: string, contents: string): void {
	publishDurableRootFileImpl(target, contents, "create-only");
}

function publishDurableRootFileImpl(target: string, contents: string, mode: "replace-or-create" | "create-only"): void {
	const dir = path.dirname(target);
	fs.mkdirSync(dir, { recursive: true });
	const temporary = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx");
		fs.writeFileSync(fd, contents);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		const outcome =
			mode === "replace-or-create" && fs.existsSync(target)
				? publishReplaceFile(temporary, target)
				: publishCreateFile(temporary, target);
		if (outcome.code === "PUBLISHED_DURABILITY_UNCERTAIN" || !outcome.ok)
			throw new Error(`${outcome.operation}: ${outcome.code}`);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try {
			fs.unlinkSync(temporary);
		} catch {
			/* installed or already absent */
		}
	}
}

function exportPinDirectory(registryPath: string): string {
	return `${registryPath}.pins`;
}

function exportPinPath(registryPath: string, token: string): string {
	return path.join(exportPinDirectory(registryPath), `${encodeURIComponent(token)}.json`);
}

/** Creates independent, durable export authority so concurrent pins cannot clobber each other. */
export function createDurableExportPin(registryPath: string, reference: RootReference): void {
	if (reference.kind !== "export" || !reference.token) throw new Error("Export pin requires a token");
	createDurableRootFile(exportPinPath(registryPath, reference.token), `${JSON.stringify(reference)}\n`);
}

/** Removes one export authority record and durably persists its parent directory mutation. */
export function removeDurableExportPin(registryPath: string, token: string): void {
	const pinPath = exportPinPath(registryPath, token);
	try {
		fs.unlinkSync(pinPath);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}
	const directory = fs.openSync(path.dirname(pinPath), "r");
	try {
		fs.fsyncSync(directory);
	} finally {
		fs.closeSync(directory);
	}
}

function validateRootReference(value: unknown): RootReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid root reference");
	const reference = value as Partial<RootReference>;
	if (
		(reference.kind !== "active" && reference.kind !== "rollback" && reference.kind !== "export") ||
		typeof reference.rootId !== "string" ||
		reference.rootId.length === 0 ||
		!Number.isSafeInteger(reference.generation) ||
		reference.generation! < 0 ||
		typeof reference.manifestId !== "string" ||
		!/^[a-f0-9]{64}$/.test(reference.manifestId) ||
		(reference.token !== undefined && (typeof reference.token !== "string" || reference.token.length === 0))
	)
		throw new Error("Invalid root reference");
	return reference as RootReference;
}

export function readRootReference(referencePath: string): RootReference {
	const value: unknown = JSON.parse(fs.readFileSync(referencePath, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid root reference");
	const reference = value as Partial<RootReference>;
	if (
		(reference.kind !== "active" && reference.kind !== "rollback" && reference.kind !== "export") ||
		typeof reference.rootId !== "string" ||
		reference.rootId.length === 0 ||
		typeof reference.generation !== "number" ||
		!Number.isSafeInteger(reference.generation) ||
		reference.generation < 0 ||
		typeof reference.manifestId !== "string" ||
		!/^[a-f0-9]{64}$/.test(reference.manifestId) ||
		(reference.token !== undefined && (typeof reference.token !== "string" || reference.token.length === 0))
	)
		throw new Error("Invalid root reference");
	return reference as RootReference;
}

export function readManifestHeader(manifestPath: string) {
	return parseManifest(fs.readFileSync(manifestPath, "utf8"));
}
