#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "../packages/coding-agent/src/config/model-registry";
import { Settings } from "../packages/coding-agent/src/config/settings";
import { AgentSession } from "../packages/coding-agent/src/session/agent-session";
import { AuthStorage } from "../packages/coding-agent/src/session/auth-storage";

import { SessionManager } from "../packages/coding-agent/src/session/session-manager";
import { generateSessionStorageFixture } from "./generate-session-storage-fixtures";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_SIZES = [10 * MEBIBYTE, 100 * MEBIBYTE];
// The fixture contract requires exact 10% segments, so the 1 MiB smoke corpus adds four bytes.
const FAST_SIZES = [MEBIBYTE + 4, 10 * MEBIBYTE];
const SWITCH_RESUME_P95_MULTIPLIER = 1.25;

const WARMUPS = 3;
const SAMPLES = 40;


export type SessionMemoryGate = { name: string; actual: number; limit: number; pass: boolean };

export interface SessionMemoryMeasurement {
	elapsedMs: number;
	baselineRssBytes: number;
	rssBytes: number;
	metadataBytes: number;
	entryCount: number;
}


export function isProbativeMetadataMeasurement(metadataBytes: number): boolean {
	return metadataBytes > 0;
}


export function percentile(values: number[], percentileValue: number): number {
	if (values.length === 0) throw new Error("Cannot calculate a percentile from an empty sample.");
	if (percentileValue < 0 || percentileValue > 100) throw new Error("Percentile must be between 0 and 100.");
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)]!;
}

export function summarizeMeasurements(samples: SessionMemoryMeasurement[]) {
	if (samples.length === 0) throw new Error("Cannot summarize empty measurements.");
	const elapsed = samples.map(sample => sample.elapsedMs);
	const baselineRss = samples.map(sample => sample.baselineRssBytes);
	const rss = samples.map(sample => sample.rssBytes);
	const metadata = samples.map(sample => sample.metadataBytes);
	return {
		samples,
		elapsedMs: { p50: percentile(elapsed, 50), p95: percentile(elapsed, 95) },
		baselineRssBytes: { p50: percentile(baselineRss, 50), p95: percentile(baselineRss, 95) },
		rssBytes: { p50: percentile(rss, 50), p95: percentile(rss, 95) },
		metadataBytes: { p50: percentile(metadata, 50), p95: percentile(metadata, 95), max: Math.max(...metadata) },

	};
}

export function evaluateSessionMemoryGates(input: {
	baselineResumeRssBytes: number;
	v2ResumeRssBytes: number;
	baselineResumeP95Ms: number;
	v2ResumeP95Ms: number;
	baselineSwitchP95Ms: number;
	v2SwitchP95Ms: number;
	metadataRetainedBytes: number;
}): SessionMemoryGate[] {
	const gate = (name: string, actual: number, limit: number): SessionMemoryGate => ({ name, actual, limit, pass: actual <= limit });
	return [
		gate("resume-rss-delta", Math.max(0, input.v2ResumeRssBytes - input.baselineResumeRssBytes), input.baselineResumeRssBytes * 0.35),
		gate("resume-p95", input.v2ResumeP95Ms, input.baselineResumeP95Ms * 1.1),
		gate("switch-p95-v2-resume", input.v2SwitchP95Ms, input.v2ResumeP95Ms * SWITCH_RESUME_P95_MULTIPLIER),
		gate("switch-p95-baseline", input.v2SwitchP95Ms, input.baselineSwitchP95Ms * 0.45),
		gate("metadata-retained", input.metadataRetainedBytes, 32 * MEBIBYTE),
		{ name: "metadata-probative", actual: input.metadataRetainedBytes, limit: Number.POSITIVE_INFINITY, pass: isProbativeMetadataMeasurement(input.metadataRetainedBytes) },
	];

}

export function gateStatus(gates: SessionMemoryGate[]): "failed" | "passed" {
	return gates.every(gate => gate.pass) ? "passed" : "failed";
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function forceGc(): void {
	Bun.gc(true);
}

async function createAgentSession(manager: SessionManager, directory: string): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Bundled measurement model is unavailable.");
	const authStorage = await AuthStorage.create(path.join(directory, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "session-memory-measurement");
	const session = new AgentSession({
		agent: new Agent({ getApiKey: () => "session-memory-measurement", initialState: { model, systemPrompt: ["Session memory measurement"], tools: [] } }),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage, path.join(directory, "models.yml")),
	});
	session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	return { session, authStorage };
}

async function childMeasurement(
	operation: "resume" | "switch",
	primaryPath: string,
	secondaryPath?: string,
	warmPath?: string,
	warmSecondaryPath?: string,
): Promise<SessionMemoryMeasurement> {
	if (warmPath) {
		const warmManager = await SessionManager.open(warmPath);
		let warmSession: AgentSession | undefined;
		let warmAuthStorage: AuthStorage | undefined;
		try {
			if (operation === "switch") {
				if (!warmSecondaryPath) throw new Error("Switch warmup requires a secondary session.");
				({ session: warmSession, authStorage: warmAuthStorage } = await createAgentSession(warmManager, path.dirname(warmPath)));
				await warmSession.switchSession(warmSecondaryPath);
			} else {
				({ session: warmSession, authStorage: warmAuthStorage } = await createAgentSession(warmManager, path.dirname(warmPath)));
			}
		} finally {
			if (warmSession) await warmSession.dispose();
			else await warmManager.close();
			warmAuthStorage?.close();
		}
	}
	forceGc();
	const baselineRssBytes = process.memoryUsage().rss;
	let manager: SessionManager;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	if (operation === "switch") {
		if (!secondaryPath) throw new Error("Switch measurement requires a secondary session.");
		manager = await SessionManager.open(primaryPath);
		({ session, authStorage } = await createAgentSession(manager, path.dirname(primaryPath)));
	}
	const started = performance.now();
	if (operation === "switch") {
		await session!.switchSession(secondaryPath!);
	} else {
		manager = await SessionManager.open(primaryPath);
		({ session, authStorage } = await createAgentSession(manager, path.dirname(primaryPath)));
	}
	const entryCount = manager.getEntryCount();
	const elapsedMs = performance.now() - started;
	forceGc();
	const rssBytes = process.memoryUsage().rss;
	if (session) await session.dispose();
	else await manager.close();
	authStorage?.close();
	return {
		elapsedMs,
		baselineRssBytes,
		rssBytes,
		metadataBytes: Math.max(0, rssBytes - baselineRssBytes),
		entryCount,
	};
}


export async function runChild(
	operation: "resume" | "switch",
	primaryPath: string,
	secondaryPath?: string,
	warmPath?: string,
	warmSecondaryPath?: string,
): Promise<SessionMemoryMeasurement> {
	const proc = Bun.spawn([
		process.execPath,
		import.meta.path,
		"--child",
		"--operation",
		operation,
		"--primary",
		primaryPath,
		...(secondaryPath ? ["--secondary", secondaryPath] : []),
		...(warmPath ? ["--warm", warmPath] : []),
		...(warmSecondaryPath ? ["--warm-secondary", warmSecondaryPath] : []),
	], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	if (exitCode !== 0) throw new Error(`Session measurement child failed (${exitCode}): ${stderr}`);
	try {
		return JSON.parse(stdout) as SessionMemoryMeasurement;
	} catch {
		throw new Error(`Session measurement child returned invalid JSON: ${stdout}`);
	}
}

async function createV2Fixture(sessionPath: string): Promise<void> {
	const manager = await SessionManager.open(sessionPath);
	try {
		const latestCompaction = manager
			.getEntries()
			.filter(entry => entry.type === "compaction")
			.at(-1);
		if (!latestCompaction || latestCompaction.type !== "compaction") {
			throw new Error("Session memory fixture requires a compaction boundary.");
		}
		manager.evictCompactedContent(latestCompaction.firstKeptEntryId, latestCompaction.id);
		await manager.setSessionName("session-memory-v2");
		await manager.rewriteEntries();
	} finally {
		await manager.close();
	}
}

async function measureInterleaved(
	operations: ReadonlyArray<{
		operation: "resume" | "switch";
		primaryPath: string;
		secondaryPath?: string;
		warmPath: string;
		warmSecondaryPath: string;
	}>,
) {
	const samples = operations.map((): SessionMemoryMeasurement[] => []);
	for (let index = 0; index < WARMUPS; index++)
		for (let offset = 0; offset < operations.length; offset++) {
			const measurement = operations[(index + offset) % operations.length]!;
			await runChild(measurement.operation, measurement.primaryPath, measurement.secondaryPath, measurement.warmPath, measurement.warmSecondaryPath);
		}
	for (let index = 0; index < SAMPLES; index++)
		for (let offset = 0; offset < operations.length; offset++) {
			const operationIndex = (index + offset) % operations.length;
			const measurement = operations[operationIndex]!;
			samples[operationIndex].push(await runChild(measurement.operation, measurement.primaryPath, measurement.secondaryPath, measurement.warmPath, measurement.warmSecondaryPath));
		}
	return samples.map(measurements => ({ warmups: WARMUPS, runs: SAMPLES, ...summarizeMeasurements(measurements) }));
}


async function measureCorpus(root: string, journalBytes: number) {
	const legacy = await generateSessionStorageFixture({ outputDir: path.join(root, "legacy"), journalBytes, name: "session" });
	const legacySecondary = await generateSessionStorageFixture({ outputDir: path.join(root, "legacy-secondary"), journalBytes, name: "session", seed: 0x9e3779b9n });
	const v2 = await generateSessionStorageFixture({ outputDir: path.join(root, "v2"), journalBytes, name: "session" });
	const v2Secondary = await generateSessionStorageFixture({ outputDir: path.join(root, "v2-secondary"), journalBytes, name: "session", seed: 0x9e3779b9n });
	await createV2Fixture(v2.journalPath);
	// Warm the fixed v2 implementation cost outside the timed/retained interval for every
	// child. This keeps the corpus measurement probative instead of charging JSC's lazy
	// compilation of the v2 reader to the first target session it happens to open.
	const warm = await generateSessionStorageFixture({ outputDir: path.join(root, "warm"), journalBytes, name: "session" });
	const warmSecondary = await generateSessionStorageFixture({ outputDir: path.join(root, "warm-secondary"), journalBytes, name: "session", seed: 0x9e3779b9n });
	await createV2Fixture(warm.journalPath);
	await createV2Fixture(warmSecondary.journalPath);
	await createV2Fixture(v2Secondary.journalPath);
	const [legacyResume, v2Resume, legacySwitch, v2Switch] = await measureInterleaved([
		{ operation: "resume", primaryPath: legacy.journalPath, warmPath: warm.journalPath, warmSecondaryPath: warmSecondary.journalPath },
		{ operation: "resume", primaryPath: v2.journalPath, warmPath: warm.journalPath, warmSecondaryPath: warmSecondary.journalPath },
		{ operation: "switch", primaryPath: legacy.journalPath, secondaryPath: legacySecondary.journalPath, warmPath: warm.journalPath, warmSecondaryPath: warmSecondary.journalPath },
		{ operation: "switch", primaryPath: v2.journalPath, secondaryPath: v2Secondary.journalPath, warmPath: warm.journalPath, warmSecondaryPath: warmSecondary.journalPath },
	]);
	return { journalBytes, legacyResume, v2Resume, legacySwitch, v2Switch };
}

async function main(): Promise<void> {
	if (process.argv.includes("--child")) {
		const operation = argument("--operation");
		const primary = argument("--primary");
		if ((operation !== "resume" && operation !== "switch") || !primary) throw new Error("Invalid child invocation.");
		process.stdout.write(`${JSON.stringify(await childMeasurement(operation, primary, argument("--secondary"), argument("--warm"), argument("--warm-secondary")))}\n`);
		return;
	}
	const check = process.argv.includes("--check");
	const fast = process.argv.includes("--fast");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-memory-"));
	try {
		const corpora = [];
		for (const journalBytes of fast ? FAST_SIZES : DEFAULT_SIZES) corpora.push(await measureCorpus(path.join(root, String(journalBytes)), journalBytes));
		const largest = corpora.at(-1)!;
		const gates = evaluateSessionMemoryGates({
			baselineResumeRssBytes: largest.legacyResume.rssBytes.p50,
			v2ResumeRssBytes: largest.v2Resume.rssBytes.p50,
			baselineResumeP95Ms: largest.legacyResume.elapsedMs.p95,
			v2ResumeP95Ms: largest.v2Resume.elapsedMs.p95,
			baselineSwitchP95Ms: largest.legacySwitch.elapsedMs.p95,
			v2SwitchP95Ms: largest.v2Switch.elapsedMs.p95,
			metadataRetainedBytes: largest.v2Resume.metadataBytes.max,
		});
		const artifact = { schemaVersion: 1, measuredAt: new Date().toISOString(), status: gateStatus(gates), fast, platform: process.platform, arch: process.arch, bunVersion: Bun.version, corpora, gates };
		await fs.mkdir(path.join(import.meta.dir, "..", "artifacts"), { recursive: true });
		const artifactPath = path.join(import.meta.dir, "..", "artifacts", `session-memory-${process.platform}-${process.arch}.json`);
		await Bun.write(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
		console.log(JSON.stringify({ status: artifact.status, artifactPath, gates }, null, 2));
		if (check && artifact.status !== "passed") process.exitCode = 1;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) await main();
