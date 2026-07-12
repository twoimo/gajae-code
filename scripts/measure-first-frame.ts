#!/usr/bin/env bun

import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const HELP_BASELINE_MS = 50;
export const INTERACTIVE_BASELINE_MS = 900;
export const BASELINE_TOLERANCE = 0.5;
export const MODELS_PARSE_MARKER = "startup:models-catalog-parsed";
export const WORKSPACE_SCAN_MARKER = "startup:workspace-scan-";
export const WORKSPACE_SCAN_COMPLETED_MARKER = "startup:workspace-scan-completed";
export const INTERACTIVE_FIRST_FRAME_MARKER = "startup:interactive-first-frame";

export interface StartupMeasurement {
	durationsMs: number[];
	medianMs: number;
	modelsCatalogParsed: boolean;
	workspaceScanEvaluated: boolean;
}

export interface InteractiveStartupMeasurement {
	durationsMs: number[];
	medianMs: number;
	firstFrameRendered: boolean;
	workspaceScanStarted: boolean;
	workspaceScanCompletedBeforeFirstFrame: boolean;
}

export interface InteractiveStartupSample {
	durationMs: number;
	trace: string;
}

export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) throw new Error("Cannot calculate a median without samples");
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function budgetFromBaseline(baselineMs: number): number {
	return baselineMs * (1 + BASELINE_TOLERANCE);
}

function repoRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function summarizeInteractiveSamples(
	samples: readonly InteractiveStartupSample[],
): InteractiveStartupMeasurement {
	for (const [index, sample] of samples.entries()) {
		const firstFrameIndex = sample.trace.indexOf(INTERACTIVE_FIRST_FRAME_MARKER);
		const scanStarted = sample.trace.includes("startup:workspace-scan-started");
		const scanCompletedIndex = sample.trace.indexOf(WORKSPACE_SCAN_COMPLETED_MARKER);
		if (firstFrameIndex < 0) throw new Error(`Interactive sample ${index + 1} did not reach the first-frame marker`);
		if (!scanStarted) throw new Error(`Interactive sample ${index + 1} did not start workspace scanning`);
		if (scanCompletedIndex >= 0 && scanCompletedIndex < firstFrameIndex) {
			throw new Error(`Interactive sample ${index + 1} completed workspace scanning before its first frame`);
		}
	}
	const durationsMs = samples.map(sample => sample.durationMs);
	return {
		durationsMs,
		medianMs: median(durationsMs),
		firstFrameRendered: true,
		workspaceScanStarted: true,
		workspaceScanCompletedBeforeFirstFrame: false,
	};
}

export function measureHelp(samples = 5): StartupMeasurement {
	const durationsMs: number[] = [];
	let trace = "";
	for (let index = 0; index < samples; index += 1) {
		const started = performance.now();
		const result = Bun.spawnSync([process.execPath, "packages/coding-agent/src/cli.ts", "--help"], {
			cwd: repoRoot(),
			env: { ...process.env, GJC_STARTUP_TRACE: "1" },
			stdout: "ignore",
			stderr: "pipe",
		});
		durationsMs.push(performance.now() - started);
		trace += result.stderr.toString();
		if (result.exitCode !== 0) throw new Error(`gjc --help exited with ${result.exitCode}: ${trace}`);
	}
	return {
		durationsMs,
		medianMs: median(durationsMs),
		modelsCatalogParsed: trace.includes(MODELS_PARSE_MARKER),
		workspaceScanEvaluated: trace.includes(WORKSPACE_SCAN_MARKER),
	};
}

export function measureInteractive(samples = 3): InteractiveStartupMeasurement {
	const measurements: InteractiveStartupSample[] = [];
	for (let index = 0; index < samples; index += 1) {
		const started = performance.now();
		const result = Bun.spawnSync(
			["script", "-q", "/dev/null", process.execPath, "packages/coding-agent/src/cli.ts"],
			{
				cwd: repoRoot(),
				env: {
					...process.env,
					GJC_STARTUP_TRACE: "1",
					GJC_TEST_DELAY_WORKSPACE_SCAN_MS: "1000",
					GJC_TEST_EXIT_AFTER_FIRST_FRAME: "1",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const durationMs = performance.now() - started;
		const trace = result.stdout.toString() + result.stderr.toString();
		if (result.exitCode !== 0) throw new Error(`interactive launch exited with ${result.exitCode}: ${trace}`);
		measurements.push({ durationMs, trace });
	}
	return summarizeInteractiveSamples(measurements);
}

if (import.meta.main) {
	const check = process.argv.includes("--check");
	const help = measureHelp();
	const interactive = measureInteractive();
	process.stdout.write(
		`${JSON.stringify(
			{
				tolerance: BASELINE_TOLERANCE,
				help: { baselineMs: HELP_BASELINE_MS, budgetMs: budgetFromBaseline(HELP_BASELINE_MS), ...help },
				interactive: {
					baselineMs: INTERACTIVE_BASELINE_MS,
					budgetMs: budgetFromBaseline(INTERACTIVE_BASELINE_MS),
					...interactive,
				},
			},
			null,
			2,
		)}\n`,
	);
	if (help.modelsCatalogParsed) throw new Error("No-model help path parsed the full models.json catalog");
	if (help.workspaceScanEvaluated) throw new Error("No-model help path evaluated workspace scanning");
	if (!interactive.firstFrameRendered) throw new Error("Interactive launch did not reach the first-frame marker");
	if (!interactive.workspaceScanStarted) throw new Error("Interactive fixture did not start workspace scanning");
	if (interactive.workspaceScanCompletedBeforeFirstFrame) {
		throw new Error("Interactive first frame waited for workspace scan completion");
	}
	if (check && help.medianMs > budgetFromBaseline(HELP_BASELINE_MS)) {
		throw new Error(`gjc --help median ${help.medianMs.toFixed(2)}ms exceeded budget`);
	}
	if (check && interactive.medianMs > budgetFromBaseline(INTERACTIVE_BASELINE_MS)) {
		throw new Error(`interactive median ${interactive.medianMs.toFixed(2)}ms exceeded budget`);
	}
}
