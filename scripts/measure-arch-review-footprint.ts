#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { releasePlatforms } from "./release-manifest";

const repoRoot = path.join(import.meta.dir, "..");
const npmBaselinePath = path.join(import.meta.dir, "footprint-npm-baseline.json");

interface FootprintNpmBaseline {
	npmPackageBytes: number;
	_comment: string;
}

async function readNpmBaseline(): Promise<number> {
	const baseline = await Bun.file(npmBaselinePath).json() as FootprintNpmBaseline;
	if (!Number.isFinite(baseline.npmPackageBytes) || baseline.npmPackageBytes <= 0) {
		throw new Error(`Invalid npmPackageBytes in ${npmBaselinePath}`);
	}
	return baseline.npmPackageBytes;
}

export const TARGET_IDS = releasePlatforms.map(target => target.id);
const RUNTIME_TARGETS = new Set(["darwin-arm64", "linux-x64"]);

export type Gate = { name: string; actual: number; limit: number; pass: boolean } | { name: string; status: "pending-input" | "pending-runtime" };

export function percentile95(values: number[]): number {
	if (values.length === 0) throw new Error("Cannot calculate p95 of an empty sample.");
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export function parseRss(stderr: string, platform: NodeJS.Platform): number {
	if (platform === "darwin") {
		const match = stderr.match(/(\d+)\s+maximum resident set size/);
		if (match) return Number(match[1]);
	} else {
		const match = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
		if (match) return Number(match[1]) * 1024;
	}
	throw new Error(`Could not parse maximum resident set size from /usr/bin/time output: ${stderr}`);
}

export function aggregateStatus(artifacts: Array<{ target: string; status: string }>): "pending" | "failed" | "passed" {
	if (artifacts.some(artifact => artifact.status === "failed")) return "failed";
	if (TARGET_IDS.some(target => !artifacts.some(artifact => artifact.target === target && artifact.status === "passed"))) return "pending";
	return "passed";
}

export function evaluateBudgets(input: {
	monolithAddonBytes: number;
	monolithCompressedBytes: number;
	coreAddonBytes: number;
	fullAddonBytes: number;
	fullCompressedBytes: number;
	npmPackageBytes: number;
	baselineNpmPackageBytes?: number;
	baselineBinaryBytes?: number;
	coreBinaryBytes?: number;
	baselineRssBytes?: number;
	coreRssBytes?: number;
	baselineWallP95Ms?: number;
	coreWallP95Ms?: number;
}): Gate[] {
	const gate = (name: string, actual: number, limit: number): Gate => ({ name, actual, limit, pass: actual <= limit });
	return [
		gate("core-addon", input.coreAddonBytes, input.monolithAddonBytes * 0.6),
		gate("full-addons", input.fullAddonBytes, input.monolithAddonBytes * 1.1),
		gate("full-addons-compressed", input.fullCompressedBytes, input.monolithCompressedBytes * 1.1),
		...(input.baselineNpmPackageBytes === undefined
			? [{ name: "npm-package", status: "pending-input" } as const]
			: [gate("npm-package", input.npmPackageBytes, input.baselineNpmPackageBytes * 1.1)]),
		...(input.baselineBinaryBytes === undefined || input.coreBinaryBytes === undefined
			? [{ name: "core-binary", status: "pending-input" } as const]
			: [gate("core-binary", input.coreBinaryBytes, input.baselineBinaryBytes * 0.8)]),
		...(input.baselineRssBytes === undefined || input.coreRssBytes === undefined
			? [{ name: "core-help-rss", status: "pending-runtime" } as const]
			: [gate("core-help-rss", input.coreRssBytes, input.baselineRssBytes * 0.85)]),
		...(input.baselineWallP95Ms === undefined || input.coreWallP95Ms === undefined
			? [{ name: "help-wall-p95", status: "pending-runtime" } as const]
			: [gate("help-wall-p95", input.coreWallP95Ms, input.baselineWallP95Ms * 1.05)]),
	];
}

export function footprintStatus(gates: Gate[]): "failed" | "pending" | "passed" {
	if (gates.some(gate => "pass" in gate && !gate.pass)) return "failed";
	if (gates.some(gate => "status" in gate && gate.status === "pending-input")) return "pending";
	return "passed";
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function fileBytes(file: string): Promise<number | undefined> {
	try { return (await fs.stat(file)).size; } catch { return undefined; }
}

async function directoryBytes(directory: string, includeFile: (file: string) => boolean = () => true): Promise<number> {
	let total = 0;
	for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
		const child = path.join(directory, entry.name);
		if (entry.isDirectory()) total += await directoryBytes(child, includeFile);
		else if (entry.isFile() && includeFile(child)) total += (await fs.stat(child)).size;
	}
	return total;
}

export async function npmPackageBytesForTarget(root: string, targetId: string): Promise<number> {
	const target = releasePlatforms.find(candidate => candidate.id === targetId);
	if (!target) throw new Error(`Target ${targetId} is not in the release manifest.`);
	const approvedNativeArtifacts = new Set(target.nativeArtifacts);
	const includeStableOrApprovedNative = (file: string) => !file.endsWith(".node") || approvedNativeArtifacts.has(path.basename(file));
	return (await directoryBytes(path.join(root, "packages/natives"), includeStableOrApprovedNative)) +
		(await directoryBytes(path.join(root, `packages/natives-${targetId}`), includeStableOrApprovedNative));
}

async function addonMetrics(file: string) {
	const bytes = await fs.readFile(file);
	return { path: path.relative(repoRoot, file), uncompressedBytes: bytes.byteLength, compressedBytes: gzipSync(bytes).byteLength };
}

async function runHelp(topology: "monolith" | "N1") {
	const configuredCommand = Bun.env.ARCH_REVIEW_HELP_COMMAND?.split(" ").filter(Boolean);
	const reportDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-native-report-"));
	const reportPath = path.join(reportDir, "loads.jsonl");
	const preloadPath = path.join(reportDir, "preload.mjs");
	await fs.writeFile(preloadPath, `await import(${JSON.stringify(path.join(repoRoot, "packages/natives/native/index.js"))});\n`);
	const command = configuredCommand ?? [process.execPath, "--preload", preloadPath, "packages/coding-agent/src/cli.ts", "--help"];
	const timeFlag = process.platform === "darwin" ? "-l" : "-v";
	const started = performance.now();
	try {
		const proc = Bun.spawn(["/usr/bin/time", timeFlag, ...command], {
			cwd: repoRoot,
			env: { ...process.env, GJC_NATIVE_TOPOLOGY: topology, GJC_NATIVE_LOADER_REPORT: reportPath },
			stdout: "ignore",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		if (exitCode !== 0) throw new Error(`Help command failed (${topology}, exit ${exitCode}): ${stderr}`);
		const loaded = (await fs.readFile(reportPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => path.basename(JSON.parse(line).path as string));
		const expected = topology === "monolith" ? "pi_natives." : "pi_natives_core.";
		if (loaded.length !== 1 || !loaded[0].startsWith(expected)) throw new Error(`Topology oracle failed for ${topology}: loaded ${loaded.join(", ") || "nothing"}`);
		return { rssBytes: parseRss(stderr, process.platform), wallMs: performance.now() - started, loadedAddons: loaded };
	} finally {
		await fs.rm(reportDir, { recursive: true, force: true });
	}
}

async function measureRuntime(topology: "monolith" | "N1") {
	for (let index = 0; index < 2; index++) await runHelp(topology);
	const samples = [];
	for (let index = 0; index < 5; index++) samples.push(await runHelp(topology));
	return { rssBytes: Math.max(...samples.map(sample => sample.rssBytes)), wallP95Ms: percentile95(samples.map(sample => sample.wallMs)), samples, warmups: 2, runs: 5 };
}

async function mergeArtifacts(check: boolean) {
	const explicit = process.argv.slice(process.argv.indexOf("--merge") + 1).filter(arg => !arg.startsWith("--"));
	const files = explicit.length ? explicit : (await fs.readdir(path.join(repoRoot, "artifacts")).catch(() => [])).filter(name => name.startsWith("arch-review-footprint-N1-") && name.endsWith(".json")).map(name => path.join(repoRoot, "artifacts", name));
	const artifacts = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(path.resolve(file), "utf8"))));
	const summary = { topology: "N1", status: aggregateStatus(artifacts), targets: TARGET_IDS.map(target => artifacts.find(item => item.target === target) ?? { target, status: "pending" }) };
	await fs.mkdir(path.join(repoRoot, "artifacts"), { recursive: true });
	await Bun.write(path.join(repoRoot, "artifacts/arch-review-footprint-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	console.log(JSON.stringify(summary, null, 2));
	if (check && summary.status !== "passed") process.exitCode = 1;
}

async function main() {
	const check = process.argv.includes("--check");
	if (process.argv.includes("--merge")) return mergeArtifacts(check);
	const targetId = option("--target") ?? `${process.platform}-${process.arch}`;
	const target = releasePlatforms.find(candidate => candidate.id === targetId);
	if (!target) throw new Error(`Target ${targetId} is not in the release manifest.`);
	const variant = option("--variant");
	const variantSuffix = targetId.endsWith("-x64") ? `-${variant || "baseline"}` : "";
	const nativeDir = path.join(repoRoot, "packages/natives/native");
	const [monolith, core, shell] = await Promise.all([
		addonMetrics(option("--monolith-addon") ?? path.join(nativeDir, `pi_natives.${targetId}${variantSuffix}.node`)),
		addonMetrics(option("--core-addon") ?? path.join(nativeDir, `pi_natives_core.${targetId}${variantSuffix}.node`)),
		addonMetrics(option("--shell-addon") ?? path.join(nativeDir, `pi_natives_shell.${targetId}${variantSuffix}.node`)),
	]);
	let baselineRuntime;
	let coreRuntime;
	if (targetId === `${process.platform}-${process.arch}` && RUNTIME_TARGETS.has(targetId)) {
		baselineRuntime = await measureRuntime("monolith");
		coreRuntime = await measureRuntime("N1");
	}
	const binaryBytes = await fileBytes(path.join(repoRoot, target.binaryPath));
	const coreBinaryPath = option("--core-binary");
	const coreBinaryBytes = coreBinaryPath ? await fileBytes(path.resolve(coreBinaryPath)) : undefined;
	const npmPackageBytes = await npmPackageBytesForTarget(repoRoot, targetId);
	const baselineNpm = option("--baseline-npm-package-bytes");
	const baselineNpmPackageBytes = baselineNpm ? Number(baselineNpm) : await readNpmBaseline();
	const fullCompressedBytes = core.compressedBytes + shell.compressedBytes;
	const gates = evaluateBudgets({
		monolithAddonBytes: monolith.uncompressedBytes, monolithCompressedBytes: monolith.compressedBytes,
		coreAddonBytes: core.uncompressedBytes, fullAddonBytes: core.uncompressedBytes + shell.uncompressedBytes,
		fullCompressedBytes, npmPackageBytes, baselineNpmPackageBytes,
		baselineBinaryBytes: binaryBytes, coreBinaryBytes,
		baselineRssBytes: baselineRuntime?.rssBytes, coreRssBytes: coreRuntime?.rssBytes,
		baselineWallP95Ms: baselineRuntime?.wallP95Ms, coreWallP95Ms: coreRuntime?.wallP95Ms,
	});
	const status = footprintStatus(gates);
	const artifact = {
		topology: "N1", target: targetId, measuredAt: new Date().toISOString(), status,
		addons: { monolith, core, shell, fullUncompressedBytes: core.uncompressedBytes + shell.uncompressedBytes, fullCompressedBytes },
		npmPackageBytes,
		compiledBinary: { baseline: binaryBytes === undefined ? { status: "missing" } : { path: target.binaryPath, bytes: binaryBytes }, core: coreBinaryBytes === undefined ? { status: "missing" } : { path: coreBinaryPath, bytes: coreBinaryBytes } },
		runtime: baselineRuntime && coreRuntime ? { baseline: baselineRuntime, core: coreRuntime } : { status: "pending-reference-runner" }, gates,
	};
	await fs.mkdir(path.join(repoRoot, "artifacts"), { recursive: true });
	const artifactPath = path.join(repoRoot, `artifacts/arch-review-footprint-N1-${targetId}.json`);
	await Bun.write(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
	console.log([`N1 ${targetId}: ${status}`, `core/monolith: ${core.uncompressedBytes}/${monolith.uncompressedBytes} bytes`, `full split compressed/uncompressed: ${fullCompressedBytes}/${artifact.addons.fullUncompressedBytes} bytes`, baselineRuntime && coreRuntime ? `help RSS baseline/core: ${baselineRuntime.rssBytes}/${coreRuntime.rssBytes} bytes` : "runtime: pending reference runner", ...gates.map(gate => "pass" in gate ? `${gate.name}: ${gate.pass ? "pass" : "fail"}` : `${gate.name}: ${gate.status}`)].join("\n"));
	if (check && status !== "passed") process.exitCode = 1;
}

if (import.meta.main) await main();
