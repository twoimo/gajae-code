#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	launchVisibleSession,
	type VisibleSessionExecutableSpec,
	type VisibleSessionLaunchReceipt,
} from "../packages/coding-agent/src/visible-session/launch";
import { VisibleSessionRegistry } from "../packages/coding-agent/src/visible-session/registry";
import type { GjcRuntimeSpawnInfo } from "../packages/coding-agent/src/daemon/runtime";
import type { VisibleSessionGeneration, VisibleSessionRegistryFile } from "../packages/coding-agent/src/visible-session/types";

export const VISIBLE_SESSION_LIFECYCLE_REPORT_SCHEMA_VERSION = 1 as const;
const SCENARIOS = ["source", "compiled", "hard-kill"] as const;
const FAILURE_CODES = [
	"compiled_binary_unavailable",
	"source_head_unavailable",
	"lifecycle_launch_failed",
	"hard_kill_failed",
	"lifecycle_deadline_exceeded",
	"terminal_record_invalid",
	"terminal_record_count_invalid",
	"unexpected_terminal_kind",
	"private_token_survived",
	"private_manifest_survived",
	"control_endpoint_survived",
	"role_process_survived",
	"runtime_binding_invalid",
	"internal_failure",
] as const;
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ROLE_READY_TIMEOUT_MS = 8_000;
const WALL_TIMEOUT_MS = 24_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 100;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024;

type FailureCode = (typeof FAILURE_CODES)[number];
export type VisibleSessionLifecycleScenario = (typeof SCENARIOS)[number];
type TerminalKind = "final" | "vanished" | null;

export interface VisibleSessionLifecycleSmokeInput {
	scenario: VisibleSessionLifecycleScenario;
	reportPath: string;
}

/** The public, token-free receipt written by this private smoke producer. */
export interface VisibleSessionLifecycleReport {
	schemaVersion: typeof VISIBLE_SESSION_LIFECYCLE_REPORT_SCHEMA_VERSION;
	scenario: VisibleSessionLifecycleScenario;
	sourceHead: string | null;
	binarySha256: string | null;
	ownerPid: number | null;
	monitorPid: number | null;
	terminalKind: TerminalKind;
	finalCount: number;
	vanishedCount: number;
	tokenPresentAfter: boolean;
	manifestPresentAfter: boolean;
	endpointReachableAfter: boolean;
	survivingPids: number[];
	durationMs: number;
	failures: FailureCode[];
}

export interface VisibleSessionLifecycleSmokeEvidence
	extends Omit<VisibleSessionLifecycleReport, "schemaVersion" | "scenario" | "durationMs"> {}

export interface VisibleSessionLifecycleSmokeDependencies {
	now?: () => number;
	execute?: (
		scenario: VisibleSessionLifecycleScenario,
		deadline: number,
	) => Promise<VisibleSessionLifecycleSmokeEvidence>;
}

function isScenario(value: string): value is VisibleSessionLifecycleScenario {
	return SCENARIOS.includes(value as VisibleSessionLifecycleScenario);
}

function isExplicitPath(value: string): boolean {
	return path.isAbsolute(value) || /^(?:\.\.?[\\/])/.test(value);
}

/** Accepts only one scenario and one intentionally explicit report destination. */
export function parseVisibleSessionLifecycleSmokeArgv(argv: readonly string[]): VisibleSessionLifecycleSmokeInput {
	if (argv.length !== 4) throw new Error("Expected exactly --scenario <source|compiled|hard-kill> --report <path>");
	let scenario: VisibleSessionLifecycleScenario | undefined;
	let reportPath: string | undefined;
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (typeof flag !== "string" || typeof value !== "string") throw new Error("Visible session lifecycle smoke arguments are malformed");
		if (flag === "--scenario" && scenario === undefined && isScenario(value)) scenario = value;
		else if (flag === "--report" && reportPath === undefined && isExplicitPath(value)) reportPath = path.resolve(value);
		else throw new Error("Visible session lifecycle smoke arguments are malformed");
	}
	if (!scenario || !reportPath) throw new Error("Visible session lifecycle smoke arguments are malformed");
	return { scenario, reportPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
}

function isPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFailureCode(value: unknown): value is FailureCode {
	return typeof value === "string" && (FAILURE_CODES as readonly string[]).includes(value);
}

/** Rejects unknown fields and any value that could expose a secret in the receipt. */
export function validateVisibleSessionLifecycleReport(value: unknown): VisibleSessionLifecycleReport {
	const keys = [
		"schemaVersion",
		"scenario",
		"sourceHead",
		"binarySha256",
		"ownerPid",
		"monitorPid",
		"terminalKind",
		"finalCount",
		"vanishedCount",
		"tokenPresentAfter",
		"manifestPresentAfter",
		"endpointReachableAfter",
		"survivingPids",
		"durationMs",
		"failures",
	];
	if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)))
		throw new Error("Visible session lifecycle report schema is invalid");
	if (
		value.schemaVersion !== VISIBLE_SESSION_LIFECYCLE_REPORT_SCHEMA_VERSION ||
		typeof value.scenario !== "string" ||
		!isScenario(value.scenario) ||
		!(value.sourceHead === null || isDigest(value.sourceHead)) ||
		!(value.binarySha256 === null || (typeof value.binarySha256 === "string" && /^[a-f0-9]{64}$/.test(value.binarySha256))) ||
		!(value.ownerPid === null || isPid(value.ownerPid)) ||
		!(value.monitorPid === null || isPid(value.monitorPid)) ||
		!(value.terminalKind === null || value.terminalKind === "final" || value.terminalKind === "vanished") ||
		![value.finalCount, value.vanishedCount, value.durationMs].every(
			entry => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0,
		) ||
		typeof value.tokenPresentAfter !== "boolean" ||
		typeof value.manifestPresentAfter !== "boolean" ||
		typeof value.endpointReachableAfter !== "boolean" ||
		!Array.isArray(value.survivingPids) ||
		!value.survivingPids.every(isPid) ||
		!Array.isArray(value.failures) ||
		!value.failures.every(isFailureCode) ||
		new Set(value.failures).size !== value.failures.length
	)
		throw new Error("Visible session lifecycle report schema is invalid");
	const report = value as VisibleSessionLifecycleReport;
	if (report.failures.length === 0) {
		const sourceBound =
			report.sourceHead !== null && (report.scenario === "compiled" ? report.binarySha256 !== null : report.binarySha256 === null);
		const terminalCount = report.finalCount + report.vanishedCount;
		if (
			!sourceBound ||
			report.ownerPid === null ||
			report.monitorPid === null ||
			terminalCount !== 1 ||
			report.terminalKind === null ||
			(report.terminalKind === "final" ? report.finalCount !== 1 : report.vanishedCount !== 1) ||
			report.tokenPresentAfter ||
			report.manifestPresentAfter ||
			report.endpointReachableAfter ||
			report.survivingPids.length !== 0
		)
			throw new Error("Visible session lifecycle success receipt is incomplete");
	}
	return report;
}

/** Stable field order makes the output suitable for tooling without a public CLI command. */
export function canonicalVisibleSessionLifecycleReport(report: VisibleSessionLifecycleReport): string {
	const checked = validateVisibleSessionLifecycleReport(report);
	return `${JSON.stringify({
		schemaVersion: checked.schemaVersion,
		scenario: checked.scenario,
		sourceHead: checked.sourceHead,
		binarySha256: checked.binarySha256,
		ownerPid: checked.ownerPid,
		monitorPid: checked.monitorPid,
		terminalKind: checked.terminalKind,
		finalCount: checked.finalCount,
		vanishedCount: checked.vanishedCount,
		tokenPresentAfter: checked.tokenPresentAfter,
		manifestPresentAfter: checked.manifestPresentAfter,
		endpointReachableAfter: checked.endpointReachableAfter,
		survivingPids: checked.survivingPids,
		durationMs: checked.durationMs,
		failures: checked.failures,
	})}\n`;
}

export async function writeVisibleSessionLifecycleReport(file: string, report: VisibleSessionLifecycleReport): Promise<void> {
	await fs.writeFile(file, canonicalVisibleSessionLifecycleReport(report), { encoding: "utf8", flag: "w" });
}

function emptyEvidence(): VisibleSessionLifecycleSmokeEvidence {
	return {
		sourceHead: null,
		binarySha256: null,
		ownerPid: null,
		monitorPid: null,
		terminalKind: null,
		finalCount: 0,
		vanishedCount: 0,
		tokenPresentAfter: false,
		manifestPresentAfter: false,
		endpointReachableAfter: false,
		survivingPids: [],
		failures: [],
	};
}

function safeFailures(values: readonly unknown[]): FailureCode[] {
	const allowed = new Set<string>(FAILURE_CODES);
	const failures: FailureCode[] = [];
	for (const value of values) {
		const code: FailureCode = typeof value === "string" && allowed.has(value) ? (value as FailureCode) : "internal_failure";
		if (!failures.includes(code)) failures.push(code);
	}
	return failures;
}

function invariantFailures(scenario: VisibleSessionLifecycleScenario, evidence: VisibleSessionLifecycleSmokeEvidence): FailureCode[] {
	const failures: FailureCode[] = [];
	if (evidence.sourceHead === null || (scenario === "compiled" && evidence.binarySha256 === null))
		failures.push("runtime_binding_invalid");
	if (evidence.finalCount + evidence.vanishedCount !== 1 || evidence.terminalKind === null)
		failures.push("terminal_record_count_invalid");
	else if ((scenario === "hard-kill" && evidence.terminalKind !== "vanished") || (scenario !== "hard-kill" && evidence.terminalKind !== "final"))
		failures.push("unexpected_terminal_kind");
	if (evidence.tokenPresentAfter) failures.push("private_token_survived");
	if (evidence.manifestPresentAfter) failures.push("private_manifest_survived");
	if (evidence.endpointReachableAfter) failures.push("control_endpoint_survived");
	if (evidence.survivingPids.length > 0) failures.push("role_process_survived");
	return failures;
}

/** Runs one bounded scenario. Tests supply execute to exercise this contract without spawning roles. */
export async function runVisibleSessionLifecycleSmoke(
	input: Pick<VisibleSessionLifecycleSmokeInput, "scenario">,
	dependencies: VisibleSessionLifecycleSmokeDependencies = {},
): Promise<VisibleSessionLifecycleReport> {
	const now = dependencies.now ?? Date.now;
	const startedAt = now();
	let evidence = emptyEvidence();
	try {
		evidence = await (dependencies.execute ?? executeVisibleSessionLifecycleScenario)(input.scenario, startedAt + WALL_TIMEOUT_MS);
	} catch {
		evidence.failures.push("internal_failure");
	}
	const failures = safeFailures([...evidence.failures, ...invariantFailures(input.scenario, evidence)]);
	return validateVisibleSessionLifecycleReport({
		schemaVersion: VISIBLE_SESSION_LIFECYCLE_REPORT_SCHEMA_VERSION,
		scenario: input.scenario,
		...evidence,
		durationMs: Math.max(0, now() - startedAt),
		failures,
	});
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.lstat(file);
		return true;
	} catch {
		return false;
	}
}

async function readTerminal(file: string, generationId: string): Promise<{ exists: boolean; valid: boolean }> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile() || stat.size > 128 * 1024) return { exists: true, valid: false };
		const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		return {
			exists: true,
			valid: isRecord(value) && value.schemaVersion === 2 && value.generation === generationId && value.generationId === generationId,
		};
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { exists: false, valid: true } : { exists: true, valid: false };
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function endpointReachable(endpoint: string): Promise<boolean> {
	const settled = Promise.withResolvers<boolean>();
	const socket = net.createConnection(endpoint);
	socket.once("connect", () => settled.resolve(true));
	socket.once("error", () => settled.resolve(false));
	try {
		return await Promise.race([settled.promise, Bun.sleep(250).then(() => false)]);
	} finally {
		socket.destroy();
	}
}

interface ObservedCleanup {
	terminalKind: TerminalKind;
	finalCount: number;
	vanishedCount: number;
	tokenPresentAfter: boolean;
	manifestPresentAfter: boolean;
	endpointReachableAfter: boolean;
	survivingPids: number[];
	terminalValid: boolean;
}

async function observeCleanup(generation: VisibleSessionGeneration, receipt: VisibleSessionLaunchReceipt): Promise<ObservedCleanup> {
	const final = await readTerminal(path.join(generation.publicRoot, "final.json"), generation.generationId);
	const vanished = await readTerminal(path.join(generation.publicRoot, "vanished.json"), generation.generationId);
	const finalCount = final.exists ? 1 : 0;
	const vanishedCount = vanished.exists ? 1 : 0;
	return {
		terminalKind: finalCount === 1 && vanishedCount === 0 ? "final" : finalCount === 0 && vanishedCount === 1 ? "vanished" : null,
		finalCount,
		vanishedCount,
		tokenPresentAfter: await exists(generation.tokenFilePath),
		manifestPresentAfter: await exists(generation.manifestFilePath),
		endpointReachableAfter: await endpointReachable(controlEndpoint(generation)),
		survivingPids: [receipt.ownerPid, receipt.monitorPid].filter(pidAlive),
		terminalValid: final.valid && vanished.valid,
	};
}

function controlEndpoint(generation: VisibleSessionGeneration): string {
	if (process.platform === "win32") {
		const digest = createHash("sha256").update(`${generation.privateRoot}\u0000${generation.generationId}`, "utf8").digest("hex");
		return `\\\\.\\pipe\\gjc-visible-control-v1-${digest.slice(0, 40)}`;
	}
	return path.join(generation.privateRoot, "control-v1.sock");
}

function cleanupSatisfied(observation: ObservedCleanup): boolean {
	return (
		observation.terminalKind !== null &&
		observation.terminalValid &&
		!observation.tokenPresentAfter &&
		!observation.manifestPresentAfter &&
		!observation.endpointReachableAfter &&
		observation.survivingPids.length === 0
	);
}

async function waitForCleanup(
	generation: VisibleSessionGeneration,
	receipt: VisibleSessionLaunchReceipt,
	deadline: number,
): Promise<ObservedCleanup> {
	let observation = await observeCleanup(generation, receipt);
	while (!cleanupSatisfied(observation) && Date.now() < deadline) {
		await Bun.sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
		observation = await observeCleanup(generation, receipt);
	}
	return observation;
}

async function hashFile(file: string, deadline: number): Promise<string> {
	const stat = await fs.stat(file);
	if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BINARY_BYTES) throw new Error("binary unavailable");
	const hash = createHash("sha256");
	const handle = await fs.open(file, "r");
	try {
		const chunk = Buffer.allocUnsafe(64 * 1024);
		for (let position = 0; position < stat.size; ) {
			if (Date.now() >= deadline) throw new Error("binary hash deadline exceeded");
			const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
			if (bytesRead === 0) throw new Error("binary changed while hashing");
			hash.update(chunk.subarray(0, bytesRead));
			position += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await handle.close();
	}
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > MAX_COMMAND_OUTPUT_BYTES) throw new Error("command output exceeded limit");
			chunks.push(next.value);
		}
		return new TextDecoder().decode(Buffer.concat(chunks));
	} finally {
		reader.releaseLock();
	}
}

async function sourceHead(deadline: number): Promise<string> {
	const child = Bun.spawn(["git", "-C", REPO_ROOT, "rev-parse", "--verify", "HEAD"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const completed = Promise.all([child.exited, readBounded(child.stdout)]);
	try {
		const result = await Promise.race([
			completed.then(([exitCode, output]) => ({ complete: true as const, exitCode, output })),
			Bun.sleep(Math.max(1, Math.min(3_000, deadline - Date.now()))).then(() => ({ complete: false as const })),
		]);
		if (!result.complete || result.exitCode !== 0 || !isDigest(result.output.trim()))
			throw new Error("source head unavailable");
		return result.output.trim();
	} catch {
		try {
			child.kill();
		} catch {}
		await completed.catch(() => undefined);
		throw new Error("source head unavailable");
	}
}

async function runtimeFor(
	scenario: VisibleSessionLifecycleScenario,
	deadline: number,
): Promise<{ runtime: GjcRuntimeSpawnInfo; sourceHead: string; binarySha256: string | null }> {
	const head = await sourceHead(deadline);
	if (scenario !== "compiled") {
		return {
			runtime: {
				execPath: process.execPath,
				mode: "source",
				argsPrefix: [path.join(REPO_ROOT, "packages", "coding-agent", "src", "main.ts")],
				reloadPicksUpSourceEdits: true,
			},
			sourceHead: head,
			binarySha256: null,
		};
	}
	const binary = process.env.GJC_VISIBLE_SESSION_COMPILED_BINARY;
	if (!binary || !path.isAbsolute(binary)) throw new Error("compiled binary unavailable");
	return {
		runtime: { execPath: binary, mode: "compiled", argsPrefix: [], reloadPicksUpSourceEdits: false },
		sourceHead: head,
		binarySha256: await hashFile(binary, deadline),
	};
}

function payloadFor(): VisibleSessionExecutableSpec {
	const body =
		'process.stdout.write("Working lifecycle smoke\\n"); const parent = process.ppid; const guard = setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 25); await Bun.sleep(10000); clearInterval(guard);';
	return { executable: process.execPath, args: ["-e", body], cwd: REPO_ROOT, env: {} };
}

function activeGeneration(registry: VisibleSessionRegistryFile, generationId: string): VisibleSessionGeneration {
	for (const entry of registry.entries) if (entry.active.generationId === generationId) return entry.active;
	throw new Error("launched generation is missing");
}

async function terminateOwned(pids: readonly (number | null)[]): Promise<void> {
	for (const pid of pids) {
		if (pid === null || !pidAlive(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
	while (pids.some((pid): pid is number => pid !== null && pidAlive(pid)) && Date.now() < deadline)
		await Bun.sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
}

async function executeVisibleSessionLifecycleScenario(
	scenario: VisibleSessionLifecycleScenario,
	deadline: number,
): Promise<VisibleSessionLifecycleSmokeEvidence> {
	const evidence = emptyEvidence();
	let agentDir: string | null = null;
	let publicBase: string | null = null;
	let receipt: VisibleSessionLaunchReceipt | null = null;
	try {
		let bound;
		try {
			bound = await runtimeFor(scenario, deadline);
		} catch {
			evidence.failures.push(scenario === "compiled" ? "compiled_binary_unavailable" : "source_head_unavailable");
			return evidence;
		}
		evidence.sourceHead = bound.sourceHead;
		evidence.binarySha256 = bound.binarySha256;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-lifecycle-agent-"));
		publicBase = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-lifecycle-public-"));
		const registry = new VisibleSessionRegistry({ agentDir });
		receipt = await launchVisibleSession(
			{
				registry,
				input: { name: `smoke-${process.pid}-${Date.now()}`, repository: REPO_ROOT, worktree: REPO_ROOT, backend: "conpty", publicBase },
				executable: payloadFor(),
				ownerReadyTimeoutMs: ROLE_READY_TIMEOUT_MS,
			},
			{ runtime: bound.runtime },
		);
		evidence.ownerPid = receipt.ownerPid;
		evidence.monitorPid = receipt.monitorPid;
		if (scenario === "hard-kill") {
			try {
				process.kill(receipt.ownerPid, "SIGKILL");
			} catch {
				evidence.failures.push("hard_kill_failed");
			}
		}
		const generation = activeGeneration(await registry.read(), receipt.generationId);
		const observation = await waitForCleanup(generation, receipt, deadline);
		evidence.terminalKind = observation.terminalKind;
		evidence.finalCount = observation.finalCount;
		evidence.vanishedCount = observation.vanishedCount;
		evidence.tokenPresentAfter = observation.tokenPresentAfter;
		evidence.manifestPresentAfter = observation.manifestPresentAfter;
		evidence.endpointReachableAfter = observation.endpointReachableAfter;
		evidence.survivingPids = observation.survivingPids;
		if (!observation.terminalValid) evidence.failures.push("terminal_record_invalid");
		if (!cleanupSatisfied(observation)) evidence.failures.push("lifecycle_deadline_exceeded");
	} catch {
		evidence.failures.push("lifecycle_launch_failed");
	} finally {
		await terminateOwned([receipt?.ownerPid ?? null, receipt?.monitorPid ?? null]);
		await Promise.all([
			agentDir ? fs.rm(agentDir, { recursive: true, force: true }) : Promise.resolve(),
			publicBase ? fs.rm(publicBase, { recursive: true, force: true }) : Promise.resolve(),
		]);
	}
	return evidence;
}

if (import.meta.main) {
	const input = parseVisibleSessionLifecycleSmokeArgv(process.argv.slice(2));
	const report = await runVisibleSessionLifecycleSmoke(input);
	await writeVisibleSessionLifecycleReport(input.reportPath, report);
	if (report.failures.length > 0) process.exitCode = 1;
}
