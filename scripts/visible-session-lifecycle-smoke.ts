#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as events from "node:events";
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
import type {
	VisibleSessionAttachDependencies,
	VisibleSessionAttachResult,
} from "../packages/coding-agent/src/visible-session/attach";
import { VisibleSessionCommandService } from "../packages/coding-agent/src/visible-session/command-service";
import type { GjcRuntimeSpawnInfo } from "../packages/coding-agent/src/daemon/runtime";
import type { VisibleSessionGeneration, VisibleSessionRegistryFile } from "../packages/coding-agent/src/visible-session/types";

export const VISIBLE_SESSION_LIFECYCLE_REPORT_SCHEMA_VERSION = 2 as const;
const SCENARIOS = ["source", "compiled", "hard-kill", "attach"] as const;
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
	"attach_failed",
] as const;
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ROLE_READY_TIMEOUT_MS = 8_000;
const WALL_TIMEOUT_MS = 24_000;
const CLEANUP_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 100;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024;
const MAX_ATTACH_OUTPUT_BYTES = 4 * 1024;
const ATTACH_OUTPUT = Buffer.from("\u001b[?25lvisible-session-attach-smoke\u001b[?25h");
const ATTACH_OUTPUT_SHA256 = createHash("sha256").update(ATTACH_OUTPUT).digest("hex");

type FailureCode = (typeof FAILURE_CODES)[number];
export type VisibleSessionLifecycleScenario = (typeof SCENARIOS)[number];
type TerminalKind = "final" | "vanished" | null;
const ATTACH_RECEIPT_KEYS = [
	"reason",
	"bytesReplayed",
	"bytesFollowed",
	"initialReplayTruncated",
	"liveTruncationCount",
	"outputBytes",
	"outputSha256",
] as const;
type AttachReason = "detached" | "session-ended" | "control-disconnected" | "aborted" | "output-error";

export interface VisibleSessionLifecycleAttachReceipt {
	reason: AttachReason;
	bytesReplayed: number;
	bytesFollowed: number;
	initialReplayTruncated: boolean;
	liveTruncationCount: number;
	outputBytes: number;
	outputSha256: string;
}

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
	sourceAttach: VisibleSessionLifecycleAttachReceipt | null;
	compiledAttach: VisibleSessionLifecycleAttachReceipt | null;
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
	if (argv.length !== 4) throw new Error("Expected exactly --scenario <source|compiled|hard-kill|attach> --report <path>");
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
function isAttachReceipt(value: unknown): value is VisibleSessionLifecycleAttachReceipt {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== ATTACH_RECEIPT_KEYS.length ||
		!ATTACH_RECEIPT_KEYS.every(key => Object.hasOwn(value, key))
	)
		return false;
	return (
		isAttachReason(value.reason) &&
		[value.bytesReplayed, value.bytesFollowed, value.liveTruncationCount, value.outputBytes].every(
			entry => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0,
		) &&
		typeof value.initialReplayTruncated === "boolean" &&
		typeof value.outputSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.outputSha256)
	);
}

function isAttachReason(value: unknown): value is AttachReason {
	return (
		value === "detached" ||
		value === "session-ended" ||
		value === "control-disconnected" ||
		value === "aborted" ||
		value === "output-error"
	);
}

function isSuccessfulAttachReceipt(receipt: VisibleSessionLifecycleAttachReceipt | null): boolean {
	return (
		receipt !== null &&
		receipt.reason === "session-ended" &&
		!receipt.initialReplayTruncated &&
		receipt.liveTruncationCount === 0 &&
		receipt.bytesReplayed + receipt.bytesFollowed === ATTACH_OUTPUT.length &&
		receipt.outputBytes === ATTACH_OUTPUT.length &&
		receipt.outputSha256 === ATTACH_OUTPUT_SHA256
	);
}

/** Rejects unknown fields and any value that could expose a secret in the receipt. */
export function validateVisibleSessionLifecycleReport(value: unknown): VisibleSessionLifecycleReport {
	const keys = [
		"schemaVersion",
		"scenario",
		"sourceHead",
		"binarySha256",
		"sourceAttach",
		"compiledAttach",
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
		!(value.sourceAttach === null || isAttachReceipt(value.sourceAttach)) ||
		!(value.compiledAttach === null || isAttachReceipt(value.compiledAttach)) ||
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
	const report = value as unknown as VisibleSessionLifecycleReport;
	if (report.failures.length === 0) {
		const requiresBinary = report.scenario === "compiled" || report.scenario === "attach";
		const sourceBound = report.sourceHead !== null && (requiresBinary ? report.binarySha256 !== null : report.binarySha256 === null);
		const terminalCount = report.finalCount + report.vanishedCount;
		const expectedTerminalCount = report.scenario === "attach" ? 2 : 1;
		const attachComplete =
			report.scenario === "attach"
				? isSuccessfulAttachReceipt(report.sourceAttach) && isSuccessfulAttachReceipt(report.compiledAttach)
				: report.sourceAttach === null && report.compiledAttach === null;
		if (
			!sourceBound ||
			!attachComplete ||
			report.ownerPid === null ||
			report.monitorPid === null ||
			terminalCount !== expectedTerminalCount ||
			report.terminalKind === null ||
			(report.terminalKind === "final"
				? report.finalCount !== expectedTerminalCount
				: report.vanishedCount !== expectedTerminalCount) ||
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
		sourceAttach: checked.sourceAttach,
		compiledAttach: checked.compiledAttach,
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
		sourceAttach: null,
		compiledAttach: null,
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
	if (evidence.sourceHead === null || ((scenario === "compiled" || scenario === "attach") && evidence.binarySha256 === null))
		failures.push("runtime_binding_invalid");
	const expectedTerminalCount = scenario === "attach" ? 2 : 1;
	if (evidence.finalCount + evidence.vanishedCount !== expectedTerminalCount || evidence.terminalKind === null)
		failures.push("terminal_record_count_invalid");
	else if (
		(scenario === "hard-kill" && evidence.terminalKind !== "vanished") ||
		(scenario !== "hard-kill" && evidence.terminalKind !== "final")
	)
		failures.push("unexpected_terminal_kind");
	if (
		(scenario === "attach" && (!isSuccessfulAttachReceipt(evidence.sourceAttach) || !isSuccessfulAttachReceipt(evidence.compiledAttach))) ||
		(scenario !== "attach" && (evidence.sourceAttach !== null || evidence.compiledAttach !== null))
	)
		failures.push("attach_failed");
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

interface LifecycleRuntime {
	runtime: GjcRuntimeSpawnInfo;
	sourceHead: string;
	binarySha256: string | null;
}

async function runtimeFor(
	scenario: Exclude<VisibleSessionLifecycleScenario, "attach">,
	deadline: number,
): Promise<LifecycleRuntime> {
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
function attachPayloadFor(): VisibleSessionExecutableSpec {
	const body = `process.stdout.write(${JSON.stringify(ATTACH_OUTPUT.toString("utf8"))}); await Bun.sleep(2000);`;
	return { executable: process.execPath, args: ["-e", body], cwd: REPO_ROOT, env: {} };
}

function attachCapture(): { dependencies: VisibleSessionAttachDependencies; output(): Buffer } {
	const chunks: Uint8Array[] = [];
	let outputBytes = 0;
	const stdout = Object.assign(new events.EventEmitter(), {
		columns: 80,
		rows: 24,
		write(bytes: Uint8Array): boolean {
			if (bytes.length > MAX_ATTACH_OUTPUT_BYTES - outputBytes) throw new Error("attach output exceeded limit");
			outputBytes += bytes.length;
			chunks.push(Uint8Array.from(bytes));
			return true;
		},
	});
	const stdin = Object.assign(new events.EventEmitter(), {
		isTTY: true,
		columns: 80,
		rows: 24,
		pause(): void {},
		resume(): void {},
	});
	return {
		dependencies: {
			stdin,
			stdout,
			terminal: stdout,
			createRawTerminalLease: () => ({ close(): void {} }),
		},
		output: () => Buffer.concat(chunks),
	};
}

interface AttachVariant {
	attach: VisibleSessionLifecycleAttachReceipt;
	launch: VisibleSessionLaunchReceipt;
	observation: ObservedCleanup;
}

async function executeAttachVariant(
	registry: VisibleSessionRegistry,
	publicBase: string,
	name: string,
	bound: LifecycleRuntime,
	deadline: number,
	owned: VisibleSessionLaunchReceipt[],
): Promise<AttachVariant> {
	const launch = await launchVisibleSession(
		{
			registry,
			input: { name, repository: REPO_ROOT, worktree: REPO_ROOT, backend: "conpty", publicBase },
			executable: attachPayloadFor(),
			ownerReadyTimeoutMs: ROLE_READY_TIMEOUT_MS,
		},
		{ runtime: bound.runtime },
	);
	owned.push(launch);
	const capture = attachCapture();
	const abort = new AbortController();
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("attach deadline exceeded");
	const timer = setTimeout(() => abort.abort(), remaining);
	let result: VisibleSessionAttachResult;
	try {
		result = await new VisibleSessionCommandService({ registry }).attach({
			name,
			readOnly: true,
			replayBytes: MAX_ATTACH_OUTPUT_BYTES,
			pollBytes: MAX_ATTACH_OUTPUT_BYTES,
			pollIntervalMs: 25,
			columns: 80,
			rows: 24,
			signal: abort.signal,
			dependencies: capture.dependencies,
		});
	} finally {
		clearTimeout(timer);
	}
	const output = capture.output();
	const attach: VisibleSessionLifecycleAttachReceipt = {
		...result,
		outputBytes: output.length,
		outputSha256: createHash("sha256").update(output).digest("hex"),
	};
	if (!isSuccessfulAttachReceipt(attach) || !output.equals(ATTACH_OUTPUT)) throw new Error("attach receipt is invalid");
	const generation = activeGeneration(await registry.read(), launch.generationId);
	return { attach, launch, observation: await waitForCleanup(generation, launch, deadline) };
}

function applyAttachObservation(evidence: VisibleSessionLifecycleSmokeEvidence, observation: ObservedCleanup): void {
	evidence.finalCount += observation.finalCount;
	evidence.vanishedCount += observation.vanishedCount;
	evidence.terminalKind =
		evidence.finalCount > 0 && evidence.vanishedCount === 0
			? "final"
			: evidence.finalCount === 0 && evidence.vanishedCount > 0
				? "vanished"
				: null;
	evidence.tokenPresentAfter ||= observation.tokenPresentAfter;
	evidence.manifestPresentAfter ||= observation.manifestPresentAfter;
	evidence.endpointReachableAfter ||= observation.endpointReachableAfter;
	evidence.survivingPids = [...new Set([...evidence.survivingPids, ...observation.survivingPids])];
	if (!observation.terminalValid) evidence.failures.push("terminal_record_invalid");
	if (!cleanupSatisfied(observation)) evidence.failures.push("lifecycle_deadline_exceeded");
}

async function executeVisibleSessionAttachScenario(deadline: number): Promise<VisibleSessionLifecycleSmokeEvidence> {
	const evidence = emptyEvidence();
	let agentDir: string | null = null;
	let publicBase: string | null = null;
	const owned: VisibleSessionLaunchReceipt[] = [];
	try {
		let source: LifecycleRuntime;
		let compiled: LifecycleRuntime;
		try {
			source = await runtimeFor("source", deadline);
		} catch {
			evidence.failures.push("source_head_unavailable");
			return evidence;
		}
		try {
			compiled = await runtimeFor("compiled", deadline);
		} catch {
			evidence.failures.push("compiled_binary_unavailable");
			return evidence;
		}
		evidence.sourceHead = source.sourceHead;
		evidence.binarySha256 = compiled.binarySha256;
		if (source.sourceHead !== compiled.sourceHead) {
			evidence.failures.push("runtime_binding_invalid");
			return evidence;
		}
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-lifecycle-agent-"));
		publicBase = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-lifecycle-public-"));
		const registry = new VisibleSessionRegistry({ agentDir });
		for (const [mode, bound] of [
			["source", source],
			["compiled", compiled],
		] as const) {
			try {
				const attached = await executeAttachVariant(
					registry,
					publicBase,
					`smoke-attach-${mode}-${process.pid}-${Date.now()}`,
					bound,
					deadline,
					owned,
				);
				evidence.ownerPid = attached.launch.ownerPid;
				evidence.monitorPid = attached.launch.monitorPid;
				if (mode === "source") evidence.sourceAttach = attached.attach;
				else evidence.compiledAttach = attached.attach;
				applyAttachObservation(evidence, attached.observation);
			} catch {
				evidence.failures.push("attach_failed");
			}
		}
	} catch {
		evidence.failures.push("attach_failed");
	} finally {
		await terminateOwned(owned.flatMap(receipt => [receipt.ownerPid, receipt.monitorPid]));
		await Promise.all([
			agentDir ? fs.rm(agentDir, { recursive: true, force: true }) : Promise.resolve(),
			publicBase ? fs.rm(publicBase, { recursive: true, force: true }) : Promise.resolve(),
		]);
	}
	return evidence;
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
	if (scenario === "attach") return executeVisibleSessionAttachScenario(deadline);
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
