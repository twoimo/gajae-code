#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";

const FIXTURE_SIZE = 1_000_000;
const TOP_K = 100;
const FIXTURE_SEED = 0x6a09e667;
const MEASUREMENT_RUNS = 3;
const WARMUP_RUNS = 1;
const DEFAULT_OUTPUT = "scripts/glob-top-k-baseline.json";
const MAX_RATIO = 0.5;

export type GlobFixtureEntry = { path: string; mtime: number };
export type GlobTopKMeasurement = { wallMs: number; peakRssBytes: number; paths: string[]; pid: number };
export type GlobTopKReport = {
	schemaVersion: 2;
	measuredAt: string;
	fixture: { size: number; limit: number; seed: number; checksum: string };
	parity: boolean;
	baseline: GlobTopKMeasurement;
	candidate: GlobTopKMeasurement;
	samplePolicy: {
		warmupRuns: number;
		measuredRuns: number;
		cacheWarmup: "one algorithm-local selection per child; excluded from wall samples and included in child high-water RSS";
		isolation: "one Bun child process per algorithm";
		peakRss: "getrusage ru_maxrss high-water";
	};
	host: { platform: string; arch: string; release: string; hostname: string; cpuModel: string; bun: string };
	ratios: { medianWall: number; peakRss: number };
	gates: { medianWall: boolean; peakRss: boolean };
};

/** A checked, platform-independent xorshift fixture generator. */
export function* generateGlobEntries(size = FIXTURE_SIZE, seed = FIXTURE_SEED): Generator<GlobFixtureEntry> {
	let state = seed >>> 0;
	for (let index = 0; index < size; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		const directory = (state % 4096).toString(36).padStart(3, "0");
		const name = (state >>> 12).toString(36).padStart(6, "0");
		yield {
			path: `dir-${directory}/${index % 997 === 0 ? "ü-" : ""}${name}-${index.toString().padStart(7, "0")}.ts`,
			mtime: state % 10_000,
		};
	}
}

export function generateGlobFixture(size = FIXTURE_SIZE, seed = FIXTURE_SEED): GlobFixtureEntry[] {
	return [...generateGlobEntries(size, seed)];
}

/** Newest first, with a deterministic normalized-path tie break. */
export function compareGlobEntries(left: GlobFixtureEntry, right: GlobFixtureEntry): number {
	const leftPath = left.path.replaceAll("\\", "/");
	const rightPath = right.path.replaceAll("\\", "/");
	return right.mtime - left.mtime || (leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0);
}

export function fullSortOracle(entries: Iterable<GlobFixtureEntry>, limit: number): GlobFixtureEntry[] {
	return [...entries].sort(compareGlobEntries).slice(0, limit);
}

/** Bounded max-heap: its root is the least desirable retained result. */
export function boundedTopK(entries: Iterable<GlobFixtureEntry>, limit: number): GlobFixtureEntry[] {
	if (limit === 0) return [];
	const heap: GlobFixtureEntry[] = [];
	const worse = (left: GlobFixtureEntry, right: GlobFixtureEntry) => compareGlobEntries(left, right) > 0;
	const push = (entry: GlobFixtureEntry) => {
		heap.push(entry);
		for (let index = heap.length - 1; index > 0;) {
			const parent = (index - 1) >> 1;
			if (!worse(heap[index]!, heap[parent]!)) break;
			[heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
			index = parent;
		}
	};
	const replaceRoot = (entry: GlobFixtureEntry) => {
		heap[0] = entry;
		for (let index = 0;;) {
			const left = index * 2 + 1;
			const right = left + 1;
			let worstIndex = index;
			if (left < heap.length && worse(heap[left]!, heap[worstIndex]!)) worstIndex = left;
			if (right < heap.length && worse(heap[right]!, heap[worstIndex]!)) worstIndex = right;
			if (worstIndex === index) break;
			[heap[index], heap[worstIndex]] = [heap[worstIndex]!, heap[index]!];
			index = worstIndex;
		}
	};
	for (const entry of entries) {
		if (heap.length < limit) push(entry);
		else if (compareGlobEntries(entry, heap[0]!) < 0) replaceRoot(entry);
	}
	return heap.sort(compareGlobEntries);
}

export function fixtureChecksum(entries: Iterable<GlobFixtureEntry>): string {
	const hash = new Bun.SHA256();
	for (const entry of entries) hash.update(`${entry.path}\0${entry.mtime}\n`);
	return hash.digest("hex");
}

function peakRssBytes(): number {
	const maxRss = process.resourceUsage().maxRSS;
	// POSIX getrusage reports KiB on Linux and bytes on Darwin.
	return process.platform === "linux" ? maxRss * 1024 : maxRss;
}

function measureMedian(
	select: (entries: Iterable<GlobFixtureEntry>, limit: number) => GlobFixtureEntry[],
	makeEntries: () => Iterable<GlobFixtureEntry>,
	limit: number,
): GlobTopKMeasurement {
	for (let index = 0; index < WARMUP_RUNS; index++) select(makeEntries(), limit);
	const samples: GlobTopKMeasurement[] = [];
	for (let index = 0; index < MEASUREMENT_RUNS; index++) {
		const started = performance.now();
		const paths = select(makeEntries(), limit).map(entry => entry.path);
		samples.push({ wallMs: performance.now() - started, peakRssBytes: peakRssBytes(), paths, pid: process.pid });
	}
	samples.sort((left, right) => left.wallMs - right.wallMs);
	const median = samples[Math.floor(samples.length / 2)]!;
	return { ...median, peakRssBytes: Math.max(...samples.map(sample => sample.peakRssBytes)) };
}

async function measureInChild(
	algorithm: "baseline" | "candidate",
	size: number,
	limit: number,
	seed: number,
): Promise<GlobTopKMeasurement> {
	const child = Bun.spawn([process.execPath, import.meta.path, "--child", algorithm, String(size), String(limit), String(seed)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`${algorithm} measurement child failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout) as GlobTopKMeasurement;
}

function hostMetadata(): GlobTopKReport["host"] {
	return {
		platform: process.platform,
		arch: process.arch,
		release: os.release(),
		hostname: os.hostname(),
		cpuModel: os.cpus()[0]?.model ?? "unknown",
		bun: Bun.version,
	};
}

export async function measureGlobTopK(size = FIXTURE_SIZE, limit = TOP_K, seed = FIXTURE_SEED): Promise<GlobTopKReport> {
	const baseline = await measureInChild("baseline", size, limit, seed);
	const candidate = await measureInChild("candidate", size, limit, seed);
	const medianWall = candidate.wallMs / baseline.wallMs;
	const peakRss = candidate.peakRssBytes / baseline.peakRssBytes;
	return {
		schemaVersion: 2,
		measuredAt: new Date().toISOString(),
		fixture: { size, limit, seed, checksum: fixtureChecksum(generateGlobEntries(size, seed)) },
		parity: JSON.stringify(baseline.paths) === JSON.stringify(candidate.paths),
		samplePolicy: {
			warmupRuns: WARMUP_RUNS,
			measuredRuns: MEASUREMENT_RUNS,
			cacheWarmup: "one algorithm-local selection per child; excluded from wall samples and included in child high-water RSS",
			isolation: "one Bun child process per algorithm",
			peakRss: "getrusage ru_maxrss high-water",
		},
		host: hostMetadata(),
		ratios: { medianWall, peakRss },
		gates: { medianWall: medianWall <= MAX_RATIO, peakRss: peakRss <= MAX_RATIO },
		baseline,
		candidate,
	};
}

function childMeasurement(): void {
	const [, , flag, algorithm, size, limit, seed] = process.argv;
	if (flag !== "--child" || (algorithm !== "baseline" && algorithm !== "candidate")) return;
	const select = algorithm === "baseline" ? fullSortOracle : boundedTopK;
	const measurement = measureMedian(select, () => generateGlobEntries(Number(size), Number(seed)), Number(limit));
	process.stdout.write(JSON.stringify(measurement));
	process.exit(0);
}

if (import.meta.main) {
	childMeasurement();
	if (process.argv[2] !== "--child") {
		const outputIndex = process.argv.indexOf("--output");
		const output = outputIndex === -1 ? DEFAULT_OUTPUT : process.argv[outputIndex + 1];
		if (!output) throw new Error("--output requires a path.");
		const report = await measureGlobTopK();
		const json = `${JSON.stringify(report, null, 2)}\n`;
		await fs.writeFile(output, json);
		if (!report.parity) throw new Error("Glob top-K candidate differs from the full-sort oracle.");
		if (!report.gates.medianWall || !report.gates.peakRss) {
			throw new Error(`Glob top-K performance gate failed: median wall=${report.ratios.medianWall.toFixed(3)}, peak RSS=${report.ratios.peakRss.toFixed(3)} (both must be <= ${MAX_RATIO}).`);
		}
		process.stdout.write(json);
	}
}
