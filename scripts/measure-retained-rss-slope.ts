#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../packages/coding-agent/src/session/session-manager";
import { generateSessionStorageFixture } from "./generate-session-storage-fixtures";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const MAX_SLOPE_MIB_PER_HOUR = 2;

export interface RssSample {
	timestampMs: number;
	rssBytes: number;
}

export type RetainedRssGate = { name: "retained-rss-slope"; actual: number; limit: number; pass: boolean };

/** Median pairwise slope, robust against isolated RSS spikes. */
export function theilSenSlopeBytesPerHour(samples: RssSample[]): number {
	if (samples.length < 2) throw new Error("At least two RSS samples are required for a slope.");
	const slopes: number[] = [];
	for (let left = 0; left < samples.length - 1; left++) {
		for (let right = left + 1; right < samples.length; right++) {
			const elapsedMs = samples[right]!.timestampMs - samples[left]!.timestampMs;
			if (elapsedMs <= 0) throw new Error("RSS sample timestamps must be strictly increasing.");
			slopes.push(((samples[right]!.rssBytes - samples[left]!.rssBytes) / elapsedMs) * 60 * 60 * 1000);
		}
	}
	return percentile(slopes, 50);
}

export function evaluateRetainedRssGate(slopeBytesPerHour: number): RetainedRssGate {
	if (!Number.isFinite(slopeBytesPerHour)) throw new Error("RSS slope must be finite.");
	return { name: "retained-rss-slope", actual: slopeBytesPerHour, limit: MAX_SLOPE_MIB_PER_HOUR * MEBIBYTE, pass: slopeBytesPerHour <= MAX_SLOPE_MIB_PER_HOUR * MEBIBYTE };
}

export function retainedRssStatus(gate: RetainedRssGate): "failed" | "passed" {
	return gate.pass ? "passed" : "failed";
}

function percentile(values: number[], percentileValue: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)]!;
}

export function parseDuration(value: string): number {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
	if (!match) throw new Error(`Invalid duration: ${value}`);
	const unit = match[2] ?? "ms";
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	const duration = Number(match[1]) * multiplier;
	if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid duration: ${value}`);
	return duration;
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const durationMs = parseDuration(argument("--duration") ?? String(DEFAULT_DURATION_MS));
	const intervalMs = parseDuration(argument("--interval") ?? String(DEFAULT_INTERVAL_MS));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-retained-rss-"));
	try {
		const fixture = await generateSessionStorageFixture({ outputDir: root, journalBytes: MEBIBYTE + 4, name: "steady-session" });
		const samples: RssSample[] = [];
		const started = performance.now();
		do {
			const manager = await SessionManager.open(fixture.journalPath);
			const entries = manager.getEntries();
			if (entries.length === 0) throw new Error("Steady session workload did not load entries.");
			samples.push({ timestampMs: performance.now() - started, rssBytes: process.memoryUsage().rss });
			const remaining = durationMs - (performance.now() - started);
			if (remaining > 0) await Bun.sleep(Math.min(intervalMs, remaining));
		} while (performance.now() - started < durationMs || samples.length < 2);
		const slopeBytesPerHour = theilSenSlopeBytesPerHour(samples);
		const gate = evaluateRetainedRssGate(slopeBytesPerHour);
		const artifact = { schemaVersion: 1, measuredAt: new Date().toISOString(), status: retainedRssStatus(gate), durationMs, intervalMs, platform: process.platform, arch: process.arch, bunVersion: Bun.version, samples, slopeBytesPerHour, slopeMiBPerHour: slopeBytesPerHour / MEBIBYTE, gate };
		await fs.mkdir(path.join(import.meta.dir, "..", "artifacts"), { recursive: true });
		const artifactPath = path.join(import.meta.dir, "..", "artifacts", `retained-rss-slope-${process.platform}-${process.arch}.json`);
		await Bun.write(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
		console.log(JSON.stringify({ status: artifact.status, artifactPath, slopeMiBPerHour: artifact.slopeMiBPerHour, gate }, null, 2));
		if (check && artifact.status !== "passed") process.exitCode = 1;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) await main();
