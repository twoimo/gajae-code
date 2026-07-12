import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "../config/file-lock";
import { readVisibleSessionBackendId } from "./backend";
import {
	canonicalizeCustomPublicBase,
	pathsOverlap,
	privateGenerationRoot,
	publicGenerationRoot,
	type VisibleSessionPaths,
	validateVisibleSessionName,
	visibleSessionPaths,
} from "./paths";
import {
	type ActivateVisibleSessionOwnerInput,
	type CreateVisibleSessionInput,
	type CreateVisibleSessionResult,
	type ManagedPublicBase,
	type RecreateVisibleSessionInput,
	type RollbackVisibleSessionOwnerActivationInput,
	VISIBLE_SESSION_SCHEMA_VERSION,
	type VisibleSessionGeneration,
	type VisibleSessionName,
	type VisibleSessionPlatform,
	type VisibleSessionRegistryEntry,
	type VisibleSessionRegistryFile,
} from "./types";

export type VisibleSessionRegistryConflictCode = "duplicate_name" | "recreate_compare_and_swap";
const MAX_VISIBLE_SESSION_REGISTRY_BYTES = 8 * 1024 * 1024;
const MAX_VISIBLE_SESSION_MANAGED_PUBLIC_BASES = 64;
const MAX_VISIBLE_SESSION_ENTRIES = 1_024;
const MAX_VISIBLE_SESSION_GENERATIONS = 4_096;
const MAX_VISIBLE_SESSION_PATH_COMPARISON_WORK = MAX_VISIBLE_SESSION_REGISTRY_BYTES;

export class VisibleSessionRegistryConflictError extends Error {
	constructor(readonly code: VisibleSessionRegistryConflictCode) {
		super(code);
		this.name = "VisibleSessionRegistryConflictError";
	}
}
class VisibleSessionRegistryFileMissingError extends Error {
	constructor() {
		super("Visible session registry file is missing");
	}
}

export interface VisibleSessionRegistryOptions {
	agentDir: string;
	platform?: VisibleSessionPlatform;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
	return isRecord(value) && hasKeys(value, keys) ? value : null;
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
interface FilesystemIdentity {
	dev: bigint;
	ino: bigint;
}
interface DirectorySnapshot {
	path: string;
	identity: FilesystemIdentity;
}

function canonicalPath(value: unknown): value is string {
	return text(value) && path.isAbsolute(value) && path.resolve(value) === value;
}

function sameFilesystemIdentity(first: FilesystemIdentity, second: FilesystemIdentity): boolean {
	return first.dev === second.dev && first.ino === second.ino;
}
function filesystemIdentity(value: { dev: unknown; ino: unknown }, message: string): FilesystemIdentity {
	if (typeof value.dev !== "bigint" || typeof value.ino !== "bigint") throw new Error(message);
	return { dev: value.dev, ino: value.ino };
}

function createPathOverlapValidator(): (first: string, second: string) => boolean {
	let work = 0;
	return (first, second) => {
		const cost = 2 * (first.length + second.length);
		if (cost > MAX_VISIBLE_SESSION_PATH_COMPARISON_WORK - work)
			throw new Error("Visible session registry exceeds path comparison work limit");
		work += cost;
		return pathsOverlap(first, second);
	};
}
function timestamp(value: unknown): value is string {
	return text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validProcess(value: unknown): boolean {
	const process = record(value, ["pid", "startedAt", "hostname"]);
	return (
		process !== null &&
		integer(process.pid) &&
		process.pid > 0 &&
		timestamp(process.startedAt) &&
		text(process.hostname)
	);
}
function validGeneration(
	value: unknown,
	bases: Map<string, string>,
	nameKey: string,
	privateRoot: string,
): value is VisibleSessionGeneration {
	if (!isRecord(value)) return false;
	const status = value.status;
	const keys =
		status === "active"
			? [
					"generationId",
					"counter",
					"status",
					"startIdentity",
					"leaseId",
					"publicBaseId",
					"publicRoot",
					"privateRoot",
					"manifestFilePath",
					"createdAt",
					"process",
					"tokenFilePath",
					"tokenSha256",
				]
			: [
					"generationId",
					"counter",
					"status",
					"startIdentity",
					"leaseId",
					"publicBaseId",
					"publicRoot",
					"privateRoot",
					"manifestFilePath",
					"createdAt",
					"tokenFilePath",
					"tokenSha256",
				];
	if (!hasKeys(value, keys) || !integer(value.counter) || value.counter === 0 || !text(value.generationId))
		return false;
	const generationId = `${value.counter}-${value.generationId.slice(String(value.counter).length + 1)}`;
	const base = typeof value.publicBaseId === "string" ? bases.get(value.publicBaseId) : undefined;
	return (
		value.generationId === generationId &&
		/^[1-9][0-9]*-[a-f0-9]{24}$/.test(value.generationId) &&
		(status === "prepared" || status === "active") &&
		typeof value.startIdentity === "string" &&
		/^[a-f0-9]{64}$/.test(value.startIdentity) &&
		typeof value.leaseId === "string" &&
		/^[a-f0-9]{32}$/.test(value.leaseId) &&
		base !== undefined &&
		canonicalPath(value.publicRoot) &&
		value.publicRoot === publicGenerationRoot(base, nameKey, value.generationId) &&
		canonicalPath(value.privateRoot) &&
		value.privateRoot === privateGenerationRoot(privateRoot, nameKey, value.generationId) &&
		canonicalPath(value.manifestFilePath) &&
		value.manifestFilePath === path.join(value.privateRoot, "manifest.json") &&
		timestamp(value.createdAt) &&
		(status === "prepared" || validProcess(value.process)) &&
		canonicalPath(value.tokenFilePath) &&
		value.tokenFilePath === path.join(value.privateRoot, "control-token") &&
		typeof value.tokenSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.tokenSha256)
	);
}
function decodeRegistry(
	value: unknown,
	paths: VisibleSessionPaths,
	platform: VisibleSessionPlatform,
): VisibleSessionRegistryFile {
	const file = record(value, ["schemaVersion", "revision", "nextGenerationCounter", "managedPublicBases", "entries"]);
	const revision = file?.revision;
	const nextGenerationCounter = file?.nextGenerationCounter;
	if (
		!file ||
		file.schemaVersion !== VISIBLE_SESSION_SCHEMA_VERSION ||
		!integer(revision) ||
		!integer(nextGenerationCounter) ||
		!Array.isArray(file.managedPublicBases) ||
		!Array.isArray(file.entries)
	)
		throw new Error("Visible session registry has an unsupported or corrupt schema");
	if (
		file.managedPublicBases.length > MAX_VISIBLE_SESSION_MANAGED_PUBLIC_BASES ||
		file.entries.length > MAX_VISIBLE_SESSION_ENTRIES
	)
		throw new Error("Visible session registry exceeds collection limits");
	let generationCount = 0;
	for (const entry of file.entries) {
		if (!isRecord(entry) || !Array.isArray(entry.history)) continue;
		generationCount += entry.history.length + 1;
		if (generationCount > MAX_VISIBLE_SESSION_GENERATIONS)
			throw new Error("Visible session registry exceeds collection limits");
	}
	const pathsOverlapWithinBudget = createPathOverlapValidator();
	const bases: ManagedPublicBase[] = [];
	const baseIds = new Set<string>();
	for (const value of file.managedPublicBases) {
		const base = record(value, ["id", "path", "claimedAt"]);
		if (!base || !text(base.id) || !canonicalPath(base.path) || !timestamp(base.claimedAt))
			throw new Error("Visible session registry has corrupt managed bases");
		const basePath = base.path;
		if (
			baseIds.has(base.id) ||
			(base.id === "default" ? basePath !== paths.defaultPublicBase : basePath === paths.defaultPublicBase) ||
			bases.some(candidate => pathsOverlapWithinBudget(candidate.path, basePath)) ||
			pathsOverlapWithinBudget(basePath, paths.registryFile) ||
			pathsOverlapWithinBudget(basePath, paths.privateRoot)
		)
			throw new Error("Visible session registry has corrupt managed bases");
		baseIds.add(base.id);
		bases.push({ id: base.id, path: basePath, claimedAt: base.claimedAt });
	}
	if (bases.length === 0 || bases[0]?.id !== "default" || bases[0].path !== paths.defaultPublicBase)
		throw new Error("Visible session registry has corrupt managed bases");
	const baseMap = new Map(bases.map(base => [base.id, base.path]));
	const entries: VisibleSessionRegistryEntry[] = [];
	const names = new Set<string>();
	const generations = new Set<string>();
	const counters = new Set<number>();
	const roots = new Set<string>();
	let greatestCounter = 0;
	for (const value of file.entries) {
		const entry = record(value, ["name", "repository", "worktree", "backend", "active", "history"]);
		const backend = entry ? readVisibleSessionBackendId(entry.backend) : undefined;
		const name = entry && record(entry.name, ["displayName", "key"]);
		let decodedName: VisibleSessionName | undefined;
		try {
			decodedName =
				name && text(name.displayName) ? validateVisibleSessionName(name.displayName, platform) : undefined;
		} catch {
			decodedName = undefined;
		}
		if (
			!entry ||
			!name ||
			!decodedName ||
			name.key !== decodedName.key ||
			!canonicalPath(entry.repository) ||
			!canonicalPath(entry.worktree) ||
			!backend ||
			backend.kind === "invalid" ||
			!Array.isArray(entry.history) ||
			!validGeneration(entry.active, baseMap, name.key, paths.privateRoot) ||
			names.has(name.key)
		)
			throw new Error("Visible session registry has corrupt entries");
		const repository = entry.repository;
		const worktree = entry.worktree;
		if (
			bases.some(
				base => pathsOverlapWithinBudget(base.path, repository) || pathsOverlapWithinBudget(base.path, worktree),
			)
		)
			throw new Error("Visible session registry has corrupt entries");
		const history: VisibleSessionGeneration[] = [];
		let previousCounter = 0;
		for (const generation of entry.history) {
			if (
				!validGeneration(generation, baseMap, name.key, paths.privateRoot) ||
				pathsOverlapWithinBudget(generation.publicRoot, generation.privateRoot) ||
				generations.has(generation.generationId) ||
				counters.has(generation.counter) ||
				roots.has(generation.publicRoot) ||
				roots.has(generation.privateRoot) ||
				generation.counter <= previousCounter
			)
				throw new Error("Visible session registry has corrupt generation history");
			generations.add(generation.generationId);
			counters.add(generation.counter);
			roots.add(generation.publicRoot);
			roots.add(generation.privateRoot);
			previousCounter = generation.counter;
			greatestCounter = Math.max(greatestCounter, generation.counter);
			history.push(generation);
		}
		if (
			pathsOverlapWithinBudget(entry.active.publicRoot, entry.active.privateRoot) ||
			generations.has(entry.active.generationId) ||
			counters.has(entry.active.counter) ||
			roots.has(entry.active.publicRoot) ||
			roots.has(entry.active.privateRoot) ||
			entry.active.counter <= previousCounter
		)
			throw new Error("Visible session registry has corrupt generation history");
		generations.add(entry.active.generationId);
		counters.add(entry.active.counter);
		roots.add(entry.active.publicRoot);
		roots.add(entry.active.privateRoot);
		greatestCounter = Math.max(greatestCounter, entry.active.counter);
		names.add(decodedName.key);
		entries.push({
			name: decodedName,
			repository,
			worktree,
			backend: backend.kind === "supported" ? backend.backend : backend,
			active: entry.active,
			history,
		});
	}
	if (nextGenerationCounter < greatestCounter)
		throw new Error("Visible session registry has corrupt generation history");
	return {
		schemaVersion: VISIBLE_SESSION_SCHEMA_VERSION,
		revision,
		nextGenerationCounter,
		managedPublicBases: bases,
		entries,
	};
}
function emptyRegistry(defaultPublicBase: string): VisibleSessionRegistryFile {
	return {
		schemaVersion: VISIBLE_SESSION_SCHEMA_VERSION,
		revision: 0,
		nextGenerationCounter: 0,
		managedPublicBases: [{ id: "default", path: defaultPublicBase, claimedAt: new Date().toISOString() }],
		entries: [],
	};
}
async function removeEmpty(directory: string): Promise<void> {
	try {
		await fs.rmdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export class VisibleSessionRegistry {
	readonly #agentDir: string;
	readonly #platform: VisibleSessionPlatform;
	constructor(options: VisibleSessionRegistryOptions) {
		this.#agentDir = options.agentDir;
		this.#platform = options.platform ?? (process.platform === "win32" ? "win32" : "posix");
	}
	async initialize(): Promise<void> {
		const agentDir = await fs.realpath(this.#agentDir);
		const paths = visibleSessionPaths(agentDir);
		await this.#mkdir(paths.root, [], false);
		await this.#mkdir(paths.privateRoot, [], true);
		await this.#mkdir(paths.defaultPublicBase, [], false);
		await withFileLock(paths.registryFile, async () => {
			try {
				await this.#read(paths);
			} catch (error) {
				if (!(error instanceof VisibleSessionRegistryFileMissingError)) throw error;
				await this.#write(paths.registryFile, emptyRegistry(paths.defaultPublicBase));
			}
		});
	}
	async read(): Promise<VisibleSessionRegistryFile> {
		const paths = visibleSessionPaths(await fs.realpath(this.#agentDir));
		return this.#read(paths);
	}
	async create(input: CreateVisibleSessionInput): Promise<CreateVisibleSessionResult> {
		return this.#mutate(input, false);
	}
	async recreate(input: RecreateVisibleSessionInput): Promise<CreateVisibleSessionResult> {
		return this.#mutate(input, true);
	}
	async activateOwner(input: ActivateVisibleSessionOwnerInput): Promise<CreateVisibleSessionResult> {
		const request = {
			expectedRevision: input.expectedRevision,
			generationId: input.generationId,
			startIdentity: input.startIdentity,
			process: { ...input.process },
		};
		if (!validProcess(request.process)) throw new Error("Visible session owner identity is invalid");
		const paths = visibleSessionPaths(await fs.realpath(this.#agentDir));
		return withFileLock(paths.registryFile, async () => {
			const registry = await this.#read(paths);
			this.#requireWritableRegistry(registry);
			if (request.expectedRevision !== registry.revision)
				throw new Error("Visible session activation compare-and-swap mismatch");
			const entry = registry.entries.find(candidate => candidate.active.generationId === request.generationId);
			if (entry?.active.status !== "prepared" || entry.active.startIdentity !== request.startIdentity)
				throw new Error("Visible session activation compare-and-swap mismatch");
			if (registry.revision === Number.MAX_SAFE_INTEGER)
				throw new Error("Visible session registry revision is exhausted");
			entry.active = { ...entry.active, status: "active", process: request.process };
			registry.revision++;
			await this.#write(paths.registryFile, registry);
			return { revision: registry.revision, entry, generation: entry.active };
		});
	}
	async rollbackOwnerActivation(
		input: RollbackVisibleSessionOwnerActivationInput,
	): Promise<CreateVisibleSessionResult> {
		const request = {
			expectedRevision: input.expectedRevision,
			generationId: input.generationId,
			startIdentity: input.startIdentity,
			process: { ...input.process },
		};
		if (!validProcess(request.process)) throw new Error("Visible session owner identity is invalid");
		const paths = visibleSessionPaths(await fs.realpath(this.#agentDir));
		return withFileLock(paths.registryFile, async () => {
			const registry = await this.#read(paths);
			this.#requireWritableRegistry(registry);
			if (request.expectedRevision !== registry.revision)
				throw new Error("Visible session activation compare-and-swap mismatch");
			const entry = registry.entries.find(candidate => candidate.active.generationId === request.generationId);
			const process = entry?.active.process;
			if (
				entry?.active.status !== "active" ||
				entry.active.startIdentity !== request.startIdentity ||
				!process ||
				process.pid !== request.process.pid ||
				process.startedAt !== request.process.startedAt ||
				process.hostname !== request.process.hostname
			)
				throw new Error("Visible session activation compare-and-swap mismatch");
			if (registry.revision === Number.MAX_SAFE_INTEGER)
				throw new Error("Visible session registry revision is exhausted");
			const generation = { ...entry.active };
			delete generation.process;
			entry.active = { ...generation, status: "prepared" };
			registry.revision++;
			await this.#write(paths.registryFile, registry);
			return { revision: registry.revision, entry, generation: entry.active };
		});
	}
	async #mutate(
		input: CreateVisibleSessionInput | RecreateVisibleSessionInput,
		recreate: boolean,
	): Promise<CreateVisibleSessionResult> {
		const request = {
			name: input.name,
			repository: input.repository,
			worktree: input.worktree,
			backend: input.backend,
			publicBase: input.publicBase,
			expectedRevision: recreate && "expectedRevision" in input ? input.expectedRevision : undefined,
			expectedActiveGeneration:
				recreate && "expectedActiveGeneration" in input ? input.expectedActiveGeneration : undefined,
		};
		const backend = readVisibleSessionBackendId(request.backend);
		if (backend.kind !== "supported" || backend.source !== "canonical")
			throw new Error("Visible session backend is not a supported canonical writer backend");
		const name = validateVisibleSessionName(request.name, this.#platform);
		const agentDir = await fs.realpath(this.#agentDir);
		const paths = visibleSessionPaths(agentDir);
		const repository = await this.#snapshotDirectoryIdentity(
			request.repository,
			"Visible session repository path is invalid",
		);
		const worktree = await this.#snapshotDirectoryIdentity(
			request.worktree,
			"Visible session worktree path is invalid",
		);
		await this.initialize();
		return withFileLock(paths.registryFile, async () => {
			const registry = await this.#read(paths);
			this.#requireWritableRegistry(registry);
			const existing = registry.entries.find(entry => entry.name.key === name.key);
			let activeRepository: DirectorySnapshot | undefined;
			let activeWorktree: DirectorySnapshot | undefined;
			if (!recreate) {
				if (existing) throw new VisibleSessionRegistryConflictError("duplicate_name");
			} else {
				if (
					!existing ||
					request.expectedRevision === undefined ||
					request.expectedRevision !== registry.revision ||
					request.expectedActiveGeneration !== existing.active.generationId
				)
					throw new VisibleSessionRegistryConflictError("recreate_compare_and_swap");
				if (
					existing.repository !== repository.path ||
					existing.worktree !== worktree.path ||
					existing.backend !== backend.backend
				)
					throw new Error("Visible session recreate identity mismatch");
				activeRepository = await this.#snapshotDirectoryIdentity(
					existing.repository,
					"Visible session active repository path is invalid",
				);
				activeWorktree = await this.#snapshotDirectoryIdentity(
					existing.worktree,
					"Visible session active worktree path is invalid",
				);
				if (
					!sameFilesystemIdentity(activeRepository.identity, repository.identity) ||
					!sameFilesystemIdentity(activeWorktree.identity, worktree.identity)
				)
					throw new Error("Visible session recreate identity mismatch");
			}
			await this.#requireStableDirectory(
				repository,
				"Visible session repository path changed between validation and commit",
			);
			await this.#requireStableDirectory(
				worktree,
				"Visible session worktree path changed between validation and commit",
			);
			if (
				registry.revision === Number.MAX_SAFE_INTEGER ||
				registry.nextGenerationCounter === Number.MAX_SAFE_INTEGER
			)
				throw new Error("Visible session registry revision or generation counter is exhausted");
			if (
				(!existing && registry.entries.length >= MAX_VISIBLE_SESSION_ENTRIES) ||
				registry.entries.reduce((count, entry) => count + entry.history.length + 1, 0) >=
					MAX_VISIBLE_SESSION_GENERATIONS
			)
				throw new Error("Visible session registry exceeds collection limits");
			const base = await this.#resolveBase(
				request.publicBase,
				existing,
				registry,
				paths,
				repository.path,
				worktree.path,
			);
			const counter = registry.nextGenerationCounter + 1;
			const generationId = `${counter}-${randomBytes(12).toString("hex")}`;
			const publicRoot = publicGenerationRoot(base.path, name.key, generationId);
			const privateRoot = privateGenerationRoot(paths.privateRoot, name.key, generationId);
			const made: string[] = [];
			try {
				await this.#mkdir(base.path, made, false);
				await this.#mkdir(path.dirname(publicRoot), made, false);
				await this.#mkdir(path.dirname(privateRoot), made, true);
				await this.#mkdir(publicRoot, made, false);
				await this.#mkdir(privateRoot, made, true);
				const tokenFilePath = path.join(privateRoot, "control-token");
				const token = randomBytes(32);
				const tokenSha256 = createHash("sha256").update(token).digest("hex");
				await fs.writeFile(tokenFilePath, token, { mode: 0o600, flag: "wx" });
				const generation: VisibleSessionGeneration = {
					generationId,
					counter,
					status: "prepared",
					startIdentity: randomBytes(32).toString("hex"),
					leaseId: randomBytes(16).toString("hex"),
					publicBaseId: base.id,
					publicRoot,
					privateRoot,
					manifestFilePath: path.join(privateRoot, "manifest.json"),
					createdAt: new Date().toISOString(),
					tokenFilePath,
					tokenSha256,
				};
				const verified = createHash("sha256")
					.update(await fs.readFile(tokenFilePath))
					.digest("hex");
				if (verified !== tokenSha256) throw new Error("Visible session token verification failed");
				await this.#requireStableDirectory(repository, "Visible session repository path changed during commit");
				await this.#requireStableDirectory(worktree, "Visible session worktree path changed during commit");
				if (activeRepository)
					await this.#requireStableDirectory(
						activeRepository,
						"Visible session active repository path changed during commit",
					);
				if (activeWorktree)
					await this.#requireStableDirectory(
						activeWorktree,
						"Visible session active worktree path changed during commit",
					);
				let entry: VisibleSessionRegistryEntry;
				if (existing) {
					existing.history.push(existing.active);
					existing.active = generation;
					entry = existing;
				} else {
					entry = {
						name,
						repository: repository.path,
						worktree: worktree.path,
						backend: backend.backend,
						active: generation,
						history: [],
					};
					registry.entries.push(entry);
				}
				if (!registry.managedPublicBases.some(item => item.id === base.id)) registry.managedPublicBases.push(base);
				registry.nextGenerationCounter = counter;
				registry.revision++;
				await this.#write(paths.registryFile, registry);
				return { revision: registry.revision, entry, generation };
			} catch (error) {
				const cleanupErrors: unknown[] = [];
				if (made.includes(privateRoot)) {
					try {
						await fs.rm(privateRoot, { recursive: true, force: true });
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				for (const directory of made.reverse()) {
					if (directory === privateRoot) continue;
					try {
						await removeEmpty(directory);
					} catch (cleanupError) {
						cleanupErrors.push(cleanupError);
					}
				}
				if (cleanupErrors.length > 0)
					throw new AggregateError(
						[error, ...cleanupErrors],
						"Visible session allocation failed and cleanup failed",
					);
				throw error;
			}
		});
	}
	async #resolveBase(
		requested: string | undefined,
		existing: VisibleSessionRegistryEntry | undefined,
		registry: VisibleSessionRegistryFile,
		paths: VisibleSessionPaths,
		repository: string,
		worktree: string,
	): Promise<ManagedPublicBase> {
		const protectedPaths = [
			paths.registryFile,
			paths.privateRoot,
			repository,
			worktree,
			...registry.entries.flatMap(entry => [
				entry.repository,
				entry.worktree,
				...[...entry.history, entry.active].map(generation => generation.privateRoot),
			]),
		];
		let requestedBase = requested ?? paths.defaultPublicBase;
		if (!requested && existing) {
			const activeBase = registry.managedPublicBases.find(item => item.id === existing.active.publicBaseId);
			if (!activeBase) throw new Error("Visible session active base is missing");
			requestedBase = activeBase.path;
		}
		const basePath = await canonicalizeCustomPublicBase(requestedBase, protectedPaths);
		const exact = registry.managedPublicBases.find(item => item.path === basePath);
		if (exact) return exact;
		if (registry.managedPublicBases.some(item => pathsOverlap(item.path, basePath)))
			throw new Error("Visible session public base overlaps a protected or managed path");
		if (registry.managedPublicBases.length >= MAX_VISIBLE_SESSION_MANAGED_PUBLIC_BASES)
			throw new Error("Visible session registry exceeds collection limits");
		return { id: `base-${randomBytes(12).toString("hex")}`, path: basePath, claimedAt: new Date().toISOString() };
	}
	async #mkdir(directory: string, made: string[], privateDirectory: boolean): Promise<void> {
		try {
			await fs.mkdir(directory, { recursive: false, mode: privateDirectory ? 0o700 : undefined });
			made.push(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await this.#safeDirectoryIdentity(directory, "Visible session allocation encountered unsafe directory");
	}
	#requireWritableRegistry(registry: VisibleSessionRegistryFile): void {
		if (registry.entries.some(entry => typeof entry.backend !== "string"))
			throw new Error("Visible session registry contains an unsupported backend record");
	}
	async #read(paths: VisibleSessionPaths): Promise<VisibleSessionRegistryFile> {
		const bytes = await this.#readBounded(paths.registryFile);
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new Error("Visible session registry contains invalid JSON");
		}
		const registry = decodeRegistry(parsed, paths, this.#platform);
		await this.#validatePersistedPaths(paths, registry);
		return registry;
	}
	async #safeDirectoryIdentity(directory: string, message: string): Promise<FilesystemIdentity> {
		const info = await fs.lstat(directory, { bigint: true });
		if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
			throw new Error(message);
		return filesystemIdentity(info, message);
	}
	async #snapshotDirectoryIdentity(directory: string, message: string): Promise<DirectorySnapshot> {
		const resolved = await fs.realpath(directory);
		const identity = await this.#safeDirectoryIdentity(resolved, message);
		return { path: resolved, identity };
	}
	async #requireStableDirectory(candidate: DirectorySnapshot, message: string): Promise<void> {
		const current = await this.#safeDirectoryIdentity(candidate.path, message);
		if (!sameFilesystemIdentity(current, candidate.identity)) throw new Error(message);
	}
	async #validatePersistedPaths(paths: VisibleSessionPaths, registry: VisibleSessionRegistryFile): Promise<void> {
		const message = "Visible session registry has unsafe managed or protected paths";
		const identities = new Map<string, FilesystemIdentity>();
		const directoryIdentity = async (directory: string): Promise<FilesystemIdentity> => {
			const existing = identities.get(directory);
			if (existing) return existing;
			const identity = await this.#safeDirectoryIdentity(directory, message);
			identities.set(directory, identity);
			return identity;
		};
		const protectedDirectories = [
			paths.root,
			paths.privateRoot,
			...registry.entries.flatMap(entry => [
				entry.repository,
				entry.worktree,
				...[...entry.history, entry.active].map(generation => generation.privateRoot),
			]),
		];
		const protectedIdentities = new Set<string>();
		for (const directory of protectedDirectories) {
			const identity = await directoryIdentity(directory);
			protectedIdentities.add(`${identity.dev}:${identity.ino}`);
		}
		const managedDirectories = [
			...registry.managedPublicBases.map(base => base.path),
			...registry.entries.flatMap(entry =>
				[...entry.history, entry.active].map(generation => generation.publicRoot),
			),
		];
		const managedIdentities = new Set<string>();
		for (const directory of managedDirectories) {
			const identity = await directoryIdentity(directory);
			const key = `${identity.dev}:${identity.ino}`;
			if (protectedIdentities.has(key) || managedIdentities.has(key)) throw new Error(message);
			managedIdentities.add(key);
		}
	}
	async #registryFileIdentity(file: string): Promise<FilesystemIdentity> {
		const info = await fs.lstat(file, { bigint: true });
		if (!info.isFile() || info.isSymbolicLink() || (await fs.realpath(file)) !== file)
			throw new Error("Visible session registry file is invalid");
		return filesystemIdentity(info, "Visible session registry file is invalid");
	}
	async #readBounded(file: string): Promise<Buffer> {
		let initialIdentity: FilesystemIdentity;
		try {
			const initialInfo = await fs.lstat(file, { bigint: true });
			if (!initialInfo.isFile() || initialInfo.isSymbolicLink() || (await fs.realpath(file)) !== file)
				throw new Error("Visible session registry file is invalid");
			initialIdentity = filesystemIdentity(initialInfo, "Visible session registry file is invalid");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new VisibleSessionRegistryFileMissingError();
			throw error;
		}
		const handle = await fs.open(file, "r");
		let bytes: Buffer | undefined;
		let primaryError: unknown;
		try {
			const info = await handle.stat({ bigint: true });
			const infoIdentity = filesystemIdentity(info, "Visible session registry file is invalid");
			const size = info.size;
			if (
				!info.isFile() ||
				typeof size !== "bigint" ||
				!sameFilesystemIdentity(initialIdentity, infoIdentity) ||
				size > BigInt(MAX_VISIBLE_SESSION_REGISTRY_BYTES)
			)
				throw new Error("Visible session registry file is invalid");
			bytes = Buffer.alloc(Number(size));
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
				if (bytesRead === 0) throw new Error("Visible session registry file changed during read");
				offset += bytesRead;
			}
			const probe = Buffer.alloc(1);
			if ((await handle.read(probe, 0, 1, bytes.length)).bytesRead !== 0)
				throw new Error("Visible session registry file changed during read");
			const finalIdentity = await this.#registryFileIdentity(file);
			if (!sameFilesystemIdentity(infoIdentity, finalIdentity))
				throw new Error("Visible session registry file changed during read");
		} catch (error) {
			primaryError = error;
		}
		let closeError: unknown;
		try {
			await handle.close();
		} catch (error) {
			closeError = error;
		}
		if (primaryError && closeError)
			throw new AggregateError(
				[primaryError, closeError],
				"Visible session registry read failed and file close failed",
			);
		if (primaryError) throw primaryError;
		if (closeError) throw closeError;
		if (!bytes) throw new Error("Visible session registry read produced no bytes");
		return bytes;
	}
	async #write(file: string, registry: VisibleSessionRegistryFile): Promise<void> {
		const serialized = Buffer.from(`${JSON.stringify(registry, null, "\t")}\n`, "utf8");
		if (serialized.byteLength > MAX_VISIBLE_SESSION_REGISTRY_BYTES)
			throw new Error("Visible session registry exceeds the maximum size");
		const temporary = path.join(path.dirname(file), `.registry-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
		let temporaryCreated = false;
		let primaryError: unknown;
		try {
			const handle = await fs.open(temporary, "wx", 0o600);
			temporaryCreated = true;
			let writeError: unknown;
			try {
				await handle.writeFile(serialized);
			} catch (error) {
				writeError = error;
			}
			let closeError: unknown;
			try {
				await handle.close();
			} catch (error) {
				closeError = error;
			}
			if (writeError && closeError)
				throw new AggregateError(
					[writeError, closeError],
					"Visible session registry write failed and temporary close failed",
				);
			if (writeError) throw writeError;
			if (closeError) throw closeError;
			await fs.rename(temporary, file);
		} catch (error) {
			primaryError = error;
		}
		if (!primaryError) return;
		if (!temporaryCreated) throw primaryError;
		try {
			await fs.rm(temporary, { force: true });
		} catch (cleanupError) {
			throw new AggregateError(
				[primaryError, cleanupError],
				"Visible session registry write failed and temporary cleanup failed",
			);
		}
		throw primaryError;
	}
}
