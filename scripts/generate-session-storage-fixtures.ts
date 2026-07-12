#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_SIZES = [10 * MEBIBYTE, 100 * MEBIBYTE];
const DEFAULT_SEED = 0x5e5510n;
const MAX_POST_COMPACTION_WINDOW_BYTES = 512 * 1024;

const SEGMENT_COUNT = 3;

export interface SessionStorageFixtureOptions {
	outputDir: string;
	journalBytes: number;
	seed?: bigint;
	name?: string;
}

export interface SessionStorageFixtureSummary {
	name: string;
	journalPath: string;
	journalBytes: number;
	journalSha256: string;
	blobsDir: string;
	segmentBytes: number;
	segmentSha256: string[];
	segmentPaths: string[];
	segmentTotalBytes: number;
	ratio: number;
}

class SeededRandom {
	#state: bigint;

	constructor(seed: bigint) {
		this.#state = BigInt.asUintN(64, seed || 1n);
	}

	nextByte(): number {
		this.#state ^= this.#state << 13n;
		this.#state ^= this.#state >> 7n;
		this.#state ^= this.#state << 17n;
		this.#state = BigInt.asUintN(64, this.#state);
		return Number(this.#state & 0xffn);
	}
}

function sha256(data: Uint8Array): string {
	return new Bun.SHA256().update(data).digest("hex");
}

function fixtureName(journalBytes: number): string {
	return `${journalBytes}-byte-session`;
}

function blobBytes(totalBytes: number, seed: bigint): Buffer[] {
	const random = new SeededRandom(seed);
	const buffers: Buffer[] = [];
	for (let index = 0; index < SEGMENT_COUNT; index++) {
		const start = Math.floor((totalBytes * index) / SEGMENT_COUNT);
		const end = Math.floor((totalBytes * (index + 1)) / SEGMENT_COUNT);
		const bytes = Buffer.allocUnsafe(end - start);
		for (let offset = 0; offset < bytes.byteLength; offset++) bytes[offset] = random.nextByte();
		buffers.push(bytes);
	}
	return buffers;
}

function sessionRecords(seed: bigint, refs: string[]): Record<string, unknown>[] {
	const prefix = `fixture-${seed.toString(16)}`;
	const timestamp = "2026-07-11T00:00:00.000Z";
	return [
		{
			type: "session",
			id: `${prefix}-session`,
			timestamp,
			cwd: "/tmp/session-storage-fixture",
			provider: "openai",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
			version: 3,
		},
		{
			type: "message",
			id: `${prefix}-user-1`,
			parentId: null,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: "Summarize the durable session storage design and retain the attachments." }],
				timestamp: Date.parse(timestamp),
			},
		},
		{
			type: "message",
			id: `${prefix}-assistant-1`,
			parentId: `${prefix}-user-1`,
			timestamp,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "The journal remains readable as v1 JSONL while immutable payloads are content addressed." },
					...refs.map(ref => ({ type: "text", text: `Attachment payload: ${ref}` })),
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.5",
				usage: { input: 128, output: 64, cacheRead: 0, cacheWrite: 0, totalTokens: 192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.parse(timestamp),
			},
		},
		{
			type: "label",
			id: `${prefix}-label-1`,
			parentId: `${prefix}-assistant-1`,
			timestamp,
			targetId: `${prefix}-assistant-1`,
			label: "session-storage-fixture",
		},
	];
}

function jsonLine(record: Record<string, unknown>): Buffer {
	return Buffer.from(`${JSON.stringify(record)}\n`);
}

function paddingRecord(seed: bigint, index: number, parentId: string, text: string): Record<string, unknown> {
	return {
		type: "message",
		id: `fixture-${seed.toString(16)}-assistant-padding-${index}`,
		parentId,
		timestamp: "2026-07-11T00:00:01.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.5",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.parse("2026-07-11T00:00:01.000Z"),
		},
	};
}

function compactionRecord(seed: bigint, index: number, parentId: string): Record<string, unknown> {
	return {
		type: "compaction",
		id: `fixture-${seed.toString(16)}-compaction-${index}`,
		parentId,
		timestamp: "2026-07-11T00:00:02.000Z",
		summary: "Periodic fixture compaction bounds the active display and provider context window.",
		firstKeptEntryId: parentId,
		tokensBefore: 16_384,
	};
}

function journalLines(journalBytes: number, seed: bigint, refs: string[]): Buffer[] {
	const lines = sessionRecords(seed, refs).map(jsonLine);
	let unfilledBytes = journalBytes - lines.reduce((total, line) => total + line.byteLength, 0);
	let parentId = `fixture-${seed.toString(16)}-label-1`;
	let paddingIndex = 0;
	let postCompactionWindowBytes = 0;
	const maxTextBytes = Math.min(512 * 1024, MAX_POST_COMPACTION_WINDOW_BYTES);
	while (unfilledBytes > 0) {
		if (postCompactionWindowBytes > 0) {
			const compaction = jsonLine(compactionRecord(seed, paddingIndex, parentId));
			const emptyPadding = jsonLine(paddingRecord(seed, paddingIndex + 1, `fixture-${seed.toString(16)}-compaction-${paddingIndex}`, ""));
			if (unfilledBytes >= compaction.byteLength + emptyPadding.byteLength) {
				lines.push(compaction);
				unfilledBytes -= compaction.byteLength;
				parentId = `fixture-${seed.toString(16)}-compaction-${paddingIndex}`;
				postCompactionWindowBytes = 0;
			}
		}
		const emptyPadding = jsonLine(paddingRecord(seed, paddingIndex, parentId, ""));
		if (unfilledBytes < emptyPadding.byteLength) {
			throw new Error(`Journal target ${journalBytes} is too small for the fixture envelope.`);
		}
		const textBytes = Math.min(maxTextBytes, unfilledBytes - emptyPadding.byteLength);
		const padding = jsonLine(paddingRecord(seed, paddingIndex, parentId, "x".repeat(textBytes)));
		lines.push(padding);
		unfilledBytes -= padding.byteLength;
		parentId = `fixture-${seed.toString(16)}-assistant-padding-${paddingIndex}`;
		paddingIndex++;
		postCompactionWindowBytes += padding.byteLength;
	}
	return lines;
}

export async function generateSessionStorageFixture(options: SessionStorageFixtureOptions): Promise<SessionStorageFixtureSummary> {
	if (!Number.isSafeInteger(options.journalBytes) || options.journalBytes <= 0 || options.journalBytes % 10 !== 0) {
		throw new Error("journalBytes must be a positive safe integer divisible by 10 so the 10% segment ratio is exact.");
	}
	const seed = options.seed ?? DEFAULT_SEED;
	const name = options.name ?? fixtureName(options.journalBytes);
	const journalPath = path.join(options.outputDir, `${name}.jsonl`);
	const blobsDir = path.join(options.outputDir, "blobs", name);
	const segmentTotalBytes = options.journalBytes / 10;
	const segments = blobBytes(segmentTotalBytes, seed ^ BigInt(options.journalBytes));
	const segmentSha256 = segments.map(sha256);
	const refs = segmentSha256.map(hash => `blob:sha256:${hash}`);
	const lines = journalLines(options.journalBytes, seed, refs);

	await fs.mkdir(blobsDir, { recursive: true });
	await fs.writeFile(journalPath, Buffer.concat(lines));
	const segmentPaths = await Promise.all(segments.map(async (segment, index) => {
		const segmentPath = path.join(blobsDir, segmentSha256[index]!);
		await fs.writeFile(segmentPath, segment);
		return segmentPath;
	}));
	const journal = await Bun.file(journalPath).arrayBuffer();
	return {
		name,
		journalPath,
		journalBytes: options.journalBytes,
		journalSha256: sha256(new Uint8Array(journal)),
		blobsDir,
		segmentBytes: segmentTotalBytes,
		segmentSha256,
		segmentPaths,
		segmentTotalBytes,
		ratio: segmentTotalBytes / options.journalBytes,
	};
}

export async function verifySessionStorageFixture(summary: SessionStorageFixtureSummary): Promise<void> {
	const journal = Buffer.from(await Bun.file(summary.journalPath).arrayBuffer());
	if (journal.byteLength !== summary.journalBytes) throw new Error(`Journal byte count mismatch for ${summary.journalPath}.`);
	if (!journal.subarray(-1).equals(Buffer.from("\n"))) throw new Error(`Journal is missing its final newline: ${summary.journalPath}.`);
	if (sha256(journal) !== summary.journalSha256) throw new Error(`Journal SHA-256 mismatch for ${summary.journalPath}.`);
	const lines = journal.toString("utf8").trimEnd().split("\n");
	const entries = lines.map((line, index) => {
		try {
			return JSON.parse(line) as Record<string, unknown>;
		} catch {
			throw new Error(`Invalid JSONL record ${index + 1} in ${summary.journalPath}.`);
		}
	});
	if (entries[0]?.type !== "session" || entries[0]?.version !== 3) throw new Error(`Journal header is not v1-compatible: ${summary.journalPath}.`);
	const journalText = journal.toString("utf8");
	let segmentTotalBytes = 0;
	for (let index = 0; index < summary.segmentPaths.length; index++) {
		const segment = Buffer.from(await Bun.file(summary.segmentPaths[index]!).arrayBuffer());
		const hash = summary.segmentSha256[index]!;
		if (sha256(segment) !== hash) throw new Error(`Segment SHA-256 mismatch for ${summary.segmentPaths[index]}.`);
		if (!journalText.includes(`blob:sha256:${hash}`)) throw new Error(`Journal does not reference segment ${hash}.`);
		segmentTotalBytes += segment.byteLength;
	}
	if (segmentTotalBytes !== summary.segmentTotalBytes || segmentTotalBytes * 10 !== journal.byteLength) {
		throw new Error(`Segment ratio mismatch for ${summary.journalPath}.`);
	}
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function parseSizes(value: string | undefined): number[] {
	if (!value) return DEFAULT_SIZES;
	const sizes = value.split(",").map(size => Number(size));
	if (sizes.some(size => !Number.isSafeInteger(size) || size <= 0)) throw new Error(`Invalid --sizes value: ${value}`);
	return sizes;
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const outputDir = path.resolve(argument("--out") ?? path.join(process.env.TMPDIR ?? os.tmpdir(), "gjc-session-storage-fixtures"));
	const seedArgument = argument("--seed");
	const seed = seedArgument === undefined ? DEFAULT_SEED : BigInt(seedArgument);
	const summaries: SessionStorageFixtureSummary[] = [];
	for (const journalBytes of parseSizes(argument("--sizes"))) {
		const summary = await generateSessionStorageFixture({ outputDir, journalBytes, seed });
		if (check) await verifySessionStorageFixture(summary);
		summaries.push(summary);
	}
	console.log(JSON.stringify({ outputDir, fixtures: summaries }, null, 2));
}

if (import.meta.main) await main();
