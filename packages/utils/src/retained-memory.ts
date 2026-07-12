export const RETAINED_MEMORY_MAX_POOLS = 32;
export const RETAINED_MEMORY_MAX_REGISTRATIONS = 64;
export const RETAINED_MEMORY_MAX_BUCKETS_PER_POOL = 8;

export interface RetainedMemoryBuckets {
	readonly [name: string]: number;
}

export interface RetainedMemoryRegistrationOptions {
	id: string;
	sampleBytes: () => number;
	onEvict?: (reason: string) => void | Promise<void>;
}

export interface RetainedMemoryPoolOptions extends RetainedMemoryRegistrationOptions {
	bucketNames?: readonly string[];
	sampleBuckets?: () => RetainedMemoryBuckets;
}

export interface RetainedMemoryRegistration {
	readonly id: string;
	dispose(): void;
}

/** Minimal registration authority for owners of recomputable retained-memory pools. */
export interface RetainedMemoryRegistryFacade {
	registerPool(options: RetainedMemoryPoolOptions): RetainedMemoryRegistration;
}

export interface RetainedMemorySnapshotEntry {
	id: string;
	bytes: number;
}

export interface RetainedMemoryPoolSnapshot extends RetainedMemorySnapshotEntry {
	buckets: RetainedMemoryBuckets;
}

export interface RetainedMemoryProcessGauges {
	rssBytes: number;
	heapUsedBytes: number;
	externalBytes: number;
	nativeBytes: number;
}

export interface RetainedMemorySnapshot {
	sampledAt: number;
	gauges: RetainedMemoryProcessGauges;
	registrations: RetainedMemorySnapshotEntry[];
	pools: RetainedMemoryPoolSnapshot[];
	totalRetainedBytes: number;
}

export interface RetainedMemoryRegistryOptions {
	now?: () => number;
	memoryUsage?: () => NodeJS.MemoryUsage;
}

interface StoredRegistration extends RetainedMemoryRegistrationOptions {}

interface StoredPool extends RetainedMemoryPoolOptions {
	bucketNames: readonly string[];
}

function checkedId(id: string): string {
	const normalized = id.trim();
	if (!normalized) throw new Error("Retained-memory IDs must not be empty");
	return normalized;
}

function checkedBytes(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must return a finite non-negative byte count`);
	return value;
}

export class RetainedMemoryRegistry {
	readonly #registrations = new Map<string, StoredRegistration>();
	readonly #pools = new Map<string, StoredPool>();
	readonly #now: () => number;
	readonly #memoryUsage: () => NodeJS.MemoryUsage;

	constructor(options: RetainedMemoryRegistryOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#memoryUsage = options.memoryUsage ?? process.memoryUsage;
	}

	register(options: RetainedMemoryRegistrationOptions): RetainedMemoryRegistration {
		const id = checkedId(options.id);
		if (this.#registrations.has(id) || this.#pools.has(id))
			throw new Error(`Retained-memory ID already registered: ${id}`);
		if (this.#registrations.size + this.#pools.size >= RETAINED_MEMORY_MAX_REGISTRATIONS) {
			throw new Error(`Retained-memory registration limit exceeded (${RETAINED_MEMORY_MAX_REGISTRATIONS})`);
		}
		this.#registrations.set(id, { ...options, id });
		return this.#disposable(id, this.#registrations);
	}

	registerPool(options: RetainedMemoryPoolOptions): RetainedMemoryRegistration {
		const id = checkedId(options.id);
		if (this.#registrations.has(id) || this.#pools.has(id))
			throw new Error(`Retained-memory ID already registered: ${id}`);
		if (this.#pools.size >= RETAINED_MEMORY_MAX_POOLS) {
			throw new Error(`Retained-memory pool limit exceeded (${RETAINED_MEMORY_MAX_POOLS})`);
		}
		if (this.#registrations.size + this.#pools.size >= RETAINED_MEMORY_MAX_REGISTRATIONS) {
			throw new Error(`Retained-memory registration limit exceeded (${RETAINED_MEMORY_MAX_REGISTRATIONS})`);
		}
		const bucketNames = [...(options.bucketNames ?? [])];
		if (bucketNames.length > RETAINED_MEMORY_MAX_BUCKETS_PER_POOL) {
			throw new Error(`Retained-memory bucket limit exceeded (${RETAINED_MEMORY_MAX_BUCKETS_PER_POOL})`);
		}
		if (new Set(bucketNames).size !== bucketNames.length || bucketNames.some(name => !name.trim())) {
			throw new Error("Retained-memory pool bucket names must be non-empty and unique");
		}
		this.#pools.set(id, { ...options, id, bucketNames });
		return this.#disposable(id, this.#pools);
	}

	sample(): RetainedMemorySnapshot {
		const usage = this.#memoryUsage();
		const registrations: RetainedMemorySnapshotEntry[] = [];
		const pools: RetainedMemoryPoolSnapshot[] = [];
		let totalRetainedBytes = 0;
		for (const registration of this.#registrations.values()) {
			const bytes = checkedBytes(registration.sampleBytes(), `Registration ${registration.id}`);
			registrations.push({ id: registration.id, bytes });
			totalRetainedBytes += bytes;
		}
		for (const pool of this.#pools.values()) {
			const bytes = checkedBytes(pool.sampleBytes(), `Pool ${pool.id}`);
			const sampledBuckets = pool.sampleBuckets?.() ?? {};
			const buckets: Record<string, number> = {};
			for (const name of pool.bucketNames)
				buckets[name] = checkedBytes(sampledBuckets[name] ?? 0, `Pool ${pool.id} bucket ${name}`);
			pools.push({ id: pool.id, bytes, buckets });
			totalRetainedBytes += bytes;
		}
		return {
			sampledAt: this.#now(),
			gauges: {
				rssBytes: usage.rss,
				heapUsedBytes: usage.heapUsed,
				externalBytes: usage.external,
				nativeBytes: usage.arrayBuffers,
			},
			registrations,
			pools,
			totalRetainedBytes,
		};
	}

	async evict(id: string, reason: string): Promise<boolean> {
		const registration = this.#registrations.get(id) ?? this.#pools.get(id);
		if (!registration) return false;
		await registration.onEvict?.(reason);
		return true;
	}

	async evictAll(reason: string): Promise<void> {
		for (const registration of [...this.#registrations.values(), ...this.#pools.values()]) {
			await registration.onEvict?.(reason);
		}
	}

	#disposable(
		id: string,
		collection: Map<string, StoredRegistration> | Map<string, StoredPool>,
	): RetainedMemoryRegistration {
		let disposed = false;
		return {
			id,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				collection.delete(id);
			},
		};
	}
}

export function createRetainedMemoryRegistry(options?: RetainedMemoryRegistryOptions): RetainedMemoryRegistry {
	return new RetainedMemoryRegistry(options);
}
