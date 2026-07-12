#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { releasePlatforms } from "./release-manifest";

const repoRoot = path.join(import.meta.dir, "..");
export const TARGET_IDS = releasePlatforms.map(target => target.id);
export const FINAL_DIST_PROFILE = "dist";
export const FINAL_DIST_STRIP_POLICY = "debuginfo";
const CANDIDATE_PROFILE = "dist-symbols";

export interface SymbolMeasurement {
	target: string;
	profile: string;
	sourceSha: string;
	unstrippedBytes: number;
	strippedBytes: number;
	reductionPercent: number;
	exports: string[];
	unwind: "passed" | "failed" | "deferred";
	debugSidecarBacktrace: "passed" | "failed" | "deferred";
	crashId: string;
	toolVersions: Record<string, string>;
	status: "passed" | "failed" | "deferred";
	reason?: string;
}

export interface CandidateAssessment {
	profile: "dist-symbols";
	status: "rejected" | "pending";
	reason: string;
}

export function reductionPercent(unstrippedBytes: number, strippedBytes: number): number {
	if (unstrippedBytes <= 0 || strippedBytes < 0) throw new Error("Native artifact byte counts must be non-negative with an unstripped artifact.");
	return Number((((unstrippedBytes - strippedBytes) / unstrippedBytes) * 100).toFixed(4));
}

export function compareExports(baseline: readonly string[], candidate: readonly string[]): string[] {
	const before = new Set(baseline);
	const after = new Set(candidate);
	return [...before].filter(name => !after.has(name)).map(name => `missing export: ${name}`)
		.concat([...after].filter(name => !before.has(name)).map(name => `unexpected export: ${name}`)).sort();
}

export function validateSymbolCompatibility(baseline: SymbolMeasurement, candidate: SymbolMeasurement): string[] {
	const differences: string[] = [];
	if (baseline.sourceSha !== candidate.sourceSha) differences.push("source SHA mismatch");
	if (baseline.target !== candidate.target) differences.push("target mismatch");
	if (baseline.profile !== FINAL_DIST_PROFILE) differences.push(`baseline profile mismatch: expected ${FINAL_DIST_PROFILE}, got ${baseline.profile}`);
	if (candidate.profile !== CANDIDATE_PROFILE) differences.push(`candidate profile mismatch: expected ${CANDIDATE_PROFILE}, got ${candidate.profile}`);
	if (baseline.crashId !== candidate.crashId) differences.push("crash/build-ID mismatch");
	return differences.concat(compareExports(baseline.exports, candidate.exports));
}

function noChangeCandidateAssessment(): CandidateAssessment[] {
	return [{
		profile: CANDIDATE_PROFILE,
		status: "rejected",
		reason: "all-target gate unmet: 4 targets CI-deferred",
	}];
}

export function aggregateSymbolMeasurements(measurements: readonly SymbolMeasurement[]): "passed" | "failed" | "deferred" {
	if (measurements.some(measurement => measurement.status === "failed")) return "failed";
	if (TARGET_IDS.some(target => !measurements.some(measurement => measurement.target === target && measurement.status === "passed"))) return "deferred";
	return "passed";
}

async function commandVersion(command: string, args = ["--version"]): Promise<string> {
	const executable = Bun.which(command);
	if (!executable) return "unavailable";
	const proc = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" });
	const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`.trim();
	await proc.exited;
	return output.split("\n")[0] || "available";
}

async function exportedSymbols(addon: string): Promise<string[]> {
	const nm = Bun.which("nm");
	if (!nm) throw new Error("Missing nm; cannot inspect N-API exports fail-closed.");
	const args = process.platform === "darwin" ? ["-gjU", addon] : ["-D", "--defined-only", addon];
	const proc = Bun.spawn([nm, ...args], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
	if (exitCode !== 0) throw new Error(`nm failed while inspecting ${addon}.`);
	return output.split(/\r?\n/).map(line => (line.trim().split(/\s+/).at(-1) ?? "").replace(/^_/, "")).filter(name => name.startsWith("napi_") || name === "napi_register_module_v1").sort();
}

class ProbeFailure extends Error {}

async function writeReport(artifactPath: string, report: SymbolMeasurement & { candidates: CandidateAssessment[] }): Promise<void> {
	await fs.mkdir(path.dirname(artifactPath), { recursive: true });
	await Bun.write(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report));
}

async function sourceSha(): Promise<string> {
	const git = Bun.which("git");
	if (!git) throw new Error("Missing git; cannot attest native symbol evidence provenance.");
	const proc = Bun.spawn([git, "rev-parse", "HEAD"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [exitCode, output, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const sha = output.trim();
	if (exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`Unable to resolve a commit SHA for native symbol evidence: ${stderr.trim() || sha || `git exited ${exitCode}`}`);
	return sha;
}

async function buildId(addon: string): Promise<string> {
	const command = process.platform === "darwin" ? "dwarfdump" : process.platform === "linux" ? "readelf" : "dumpbin";
	const executable = Bun.which(command);
	if (!executable) throw new Error(`Missing ${command}; cannot validate the stripped artifact's debug-sidecar lookup key.`);
	const args = process.platform === "darwin" ? ["--uuid", addon] : process.platform === "linux" ? ["-n", addon] : ["/headers", addon];
	const proc = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
	if (exitCode !== 0) throw new Error(`${command} failed while reading build ID from ${addon}.`);
	const match = process.platform === "darwin"
		? output.match(/UUID: ([0-9A-F-]+)/i)
		: process.platform === "linux"
			? output.match(/Build ID: ([0-9a-f]+)/i)
			: output.match(/(?:Debug Directories|GUID).*?([0-9A-F]{8}-[0-9A-F-]{27,})/is);
	if (!match) throw new Error(`No build ID found in ${addon}; cannot link stripped artifact to its debug sidecar.`);
	return match[1].toLowerCase();
}

async function runProbe(addon: string, expression: string): Promise<boolean> {
	const script = `const addon = require(process.argv[1]); const value = ${expression}; process.stdout.write(JSON.stringify(value));`;
	const proc = Bun.spawn([process.execPath, "-e", script, path.resolve(addon)], {
		cwd: repoRoot,
		env: { ...process.env, RUST_BACKTRACE: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, output, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const value = output.trim();
	if (exitCode !== 0 || (value !== "true" && value !== "false")) {
		throw new ProbeFailure(`Native probe failed for ${path.basename(addon)}: ${stderr.trim() || `exit ${exitCode}; output ${JSON.stringify(value)}`}`);
	}
	if (value === "false") {
		throw new ProbeFailure(`Native probe returned false for ${path.basename(addon)}: required invariant did not hold.`);
	}
	return true;
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
	const target = option("--target") ?? `${process.platform}-${process.arch}`;
	if (!TARGET_IDS.includes(target)) throw new Error(`Unsupported release target: ${target}`);
	const hostTarget = `${process.platform}-${process.arch}`;
	const baselineAddon = option("--baseline-addon");
	const candidateAddon = option("--candidate-addon") ?? option("--addon");
	if (!baselineAddon || !candidateAddon) throw new Error("Both --baseline-addon (dist debug sidecar) and --candidate-addon (dist-symbols artifact) are required; self-comparison is forbidden.");
	const profile = option("--profile");
	if (profile !== CANDIDATE_PROFILE) throw new Error(`Native symbol candidate profile must be ${CANDIDATE_PROFILE}.`);
	const artifactPath = option("--output") ?? path.join(repoRoot, "artifacts", `native-symbols-${target}.json`);
	const source = await sourceSha();
	const tools = { bun: Bun.version, rustc: await commandVersion("rustc"), cargo: await commandVersion("cargo"), nm: await commandVersion("nm", ["--version"]) };
	if (target !== hostTarget) {
		const report: SymbolMeasurement & { candidates: CandidateAssessment[] } = { target, profile, sourceSha: source, unstrippedBytes: 0, strippedBytes: 0, reductionPercent: 0, exports: [], unwind: "deferred", debugSidecarBacktrace: "deferred", crashId: "deferred", toolVersions: tools, status: "deferred", reason: `CI evidence required: host ${hostTarget} cannot execute ${target}.`, candidates: noChangeCandidateAssessment() };
		await writeReport(artifactPath, report);
		return;
	}
	const [unstrippedBytes, strippedBytes, baselineExports, exports, baselineBuildId, candidateBuildId] = await Promise.all([
		fs.stat(baselineAddon).then(stat => stat.size), fs.stat(candidateAddon).then(stat => stat.size), exportedSymbols(baselineAddon), exportedSymbols(candidateAddon), buildId(baselineAddon), buildId(candidateAddon),
	]);
	const baseline: SymbolMeasurement = { target, profile: FINAL_DIST_PROFILE, sourceSha: source, unstrippedBytes, strippedBytes: unstrippedBytes, reductionPercent: 0, exports: baselineExports, unwind: "passed", debugSidecarBacktrace: "passed", crashId: baselineBuildId, toolVersions: tools, status: "passed" };
	const report: SymbolMeasurement & { candidates: CandidateAssessment[] } = { target, profile, sourceSha: source, unstrippedBytes, strippedBytes, reductionPercent: reductionPercent(unstrippedBytes, strippedBytes), exports, unwind: "failed", debugSidecarBacktrace: "failed", crashId: candidateBuildId, toolVersions: tools, status: "failed", candidates: noChangeCandidateAssessment() };
	try {
		report.unwind = await runProbe(candidateAddon, "addon.nativePanicUnwindProbe() === true") ? "passed" : "failed";
		report.debugSidecarBacktrace = await runProbe(baselineAddon, "typeof addon.nativeDebugSidecarBacktraceProbe() === 'string' && addon.nativeDebugSidecarBacktraceProbe().includes('native_debug_sidecar_backtrace_probe')") ? "passed" : "failed";
	} catch (error) {
		report.reason = error instanceof Error ? error.message : String(error);
		await writeReport(artifactPath, report);
		throw error;
	}
	const differences = validateSymbolCompatibility(baseline, report);
	const malformedExportEvidence = baselineExports.length === 0 || exports.length === 0;
	if (report.unwind !== "passed") differences.push("native unwind probe returned false");
	if (report.debugSidecarBacktrace !== "passed") differences.push("debug-sidecar symbolized-backtrace probe returned false");
	if (malformedExportEvidence) differences.push("No N-API export symbols found.");
	if (differences.length > 0) {
		report.status = "failed";
		report.reason = differences.join(", ");
	}
	await writeReport(artifactPath, report);
	if (report.unwind !== "passed" || report.debugSidecarBacktrace !== "passed" || malformedExportEvidence) process.exitCode = 1;
}

if (import.meta.main) await main();
