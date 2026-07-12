#!/usr/bin/env bun
import { createHmac, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	validateVisibleSessionLifecycleReport,
	type VisibleSessionLifecycleReport,
} from "./visible-session-lifecycle-smoke";

export const VISIBLE_SESSION_WSL_RECEIPT_SCHEMA_VERSION = 1 as const;
export const VISIBLE_SESSION_WSL_HMAC_ENV = "GJC_WSL_RECEIPT_HMAC_KEY" as const;

const RECEIPT_KEYS = [
	"schemaVersion",
	"headSha",
	"binarySha256",
	"sourceResult",
	"compiledResult",
	"distro",
	"hostVersion",
	"distroVersion",
	"schemaVersionObserved",
	"tests",
	"skips",
	"failures",
	"survivors",
	"endpointLeaks",
	"createdAt",
] as const;

const RESULT_KEYS = [
	"mode",
	"passed",
	"headSha",
	"binarySha256",
	"hostVersion",
	"distroVersion",
	"schemaVersionObserved",
	"tests",
	"skips",
	"failures",
	"survivors",
	"endpointLeaks",
] as const;

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 90_000;


export type VisibleSessionWslLifecycleMode = "source" | "compiled";

/** A token-free summary of one independently executed WSL lifecycle mode. */
export interface VisibleSessionWslLifecycleResult {
	mode: VisibleSessionWslLifecycleMode;
	passed: true;
	headSha: string;
	binarySha256: string | null;
	hostVersion: string;
	distroVersion: string;
	schemaVersionObserved: number;
	tests: number;
	skips: number;
	failures: number;
	survivors: number;
	endpointLeaks: number;
}

/** The complete signed artifact schema. No runtime output or credentials belong here. */
export interface VisibleSessionWslReceipt {
	schemaVersion: typeof VISIBLE_SESSION_WSL_RECEIPT_SCHEMA_VERSION;
	headSha: string;
	binarySha256: string;
	sourceResult: VisibleSessionWslLifecycleResult;
	compiledResult: VisibleSessionWslLifecycleResult;
	distro: string;
	hostVersion: string;
	distroVersion: string;
	schemaVersionObserved: number;
	tests: number;
	skips: number;
	failures: number;
	survivors: number;
	endpointLeaks: number;
	createdAt: string;
}

export interface VisibleSessionWslReceiptProducerInput {
	distro: string;
	source: true;
	compiled: true;
	headSha: string;
	binarySha256: string;
	receiptPath: string;
	signaturePath: string;
}

export interface VisibleSessionWslCommandResult {
	exitCode: number;
	stdout: string;
}

/** The seam used by tests; production always invokes the supplied argv directly. */
export type VisibleSessionWslCommandRunner = (
	argv: readonly string[],
) => Promise<VisibleSessionWslCommandResult>;

export interface VisibleSessionWslReceiptProducerDependencies {
	runCommand?: VisibleSessionWslCommandRunner;
	readEnvironment?: (name: string) => string | undefined;
	readLifecycleReport?: (mode: VisibleSessionWslLifecycleMode, file: string) => Promise<unknown>;
	now?: () => Date;
}

type CanonicalJsonPrimitive = string | number | boolean | null;
type CanonicalJsonValue = CanonicalJsonPrimitive | CanonicalJsonValue[] | CanonicalJsonObject;
interface CanonicalJsonObject {
	[key: string]: CanonicalJsonValue;
}

function receiptError(): Error {
	return new Error("Visible-session WSL receipt is invalid");
}

function argumentError(): Error {
	return new Error("Visible-session WSL receipt arguments are invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isHeadSha(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isBinarySha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isDistro(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Buffer.byteLength(value, "utf8") <= 256 &&
		value.trim().length > 0 &&
		!/\p{Cc}/u.test(value)
	);
}

interface GjcVersion {
	major: number;
	minor: number;
}

function parseGjcVersion(value: unknown): GjcVersion | null {
	if (typeof value !== "string") return null;
	const match = /^gjc\/(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(value);
	if (!match) return null;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

function isVersion(value: unknown): value is string {
	return parseGjcVersion(value) !== null;
}

function versionsShareMajorMinor(left: string, right: string): boolean {
	const parsedLeft = parseGjcVersion(left);
	const parsedRight = parseGjcVersion(right);
	return parsedLeft !== null && parsedRight !== null && parsedLeft.major === parsedRight.major && parsedLeft.minor === parsedRight.minor;
}
/** Normalizes the sole bounded `gjc/X.Y.Z` line emitted by the CLI version fast path. */
export function normalizeVisibleSessionWslGjcVersion(output: unknown): string {
	if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 64)
		throw new Error("GJC version output is invalid");
	const match = /^(gjc\/(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5}))(?:\r?\n)?$/.exec(output);
	if (!match || parseGjcVersion(match[1]) === null) throw new Error("GJC version output is invalid");
	return match[1];
}

function isSchemaVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCreatedAt(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isMode(value: unknown): value is VisibleSessionWslLifecycleMode {
	return value === "source" || value === "compiled";
}

function validateLifecycleResult(value: unknown): VisibleSessionWslLifecycleResult {
	if (!isRecord(value) || !hasExactKeys(value, RESULT_KEYS)) throw receiptError();
	if (
		!isMode(value.mode) ||
		value.passed !== true ||
		!isHeadSha(value.headSha) ||
		!(value.binarySha256 === null || isBinarySha256(value.binarySha256)) ||
		!isVersion(value.hostVersion) ||
		!isVersion(value.distroVersion) ||
		!isSchemaVersion(value.schemaVersionObserved) ||
		!isCount(value.tests) ||
		!isCount(value.skips) ||
		!isCount(value.failures) ||
		!isCount(value.survivors) ||
		!isCount(value.endpointLeaks)
	)
		throw receiptError();
	if (
		value.tests === 0 ||
		value.skips !== 0 ||
		value.failures !== 0 ||
		value.survivors !== 0 ||
		value.endpointLeaks !== 0
	)
		throw receiptError();
	return {
		mode: value.mode,
		passed: true,
		headSha: value.headSha,
		binarySha256: value.binarySha256,
		hostVersion: value.hostVersion,
		distroVersion: value.distroVersion,
		schemaVersionObserved: value.schemaVersionObserved,
		tests: value.tests,
		skips: value.skips,
		failures: value.failures,
		survivors: value.survivors,
		endpointLeaks: value.endpointLeaks,
	};
}

/** Rejects extra fields, incomplete modes, unbound provenance, and non-zero cleanup counters. */
export function validateVisibleSessionWslReceipt(value: unknown): VisibleSessionWslReceipt {
	if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) throw receiptError();
	if (
		value.schemaVersion !== VISIBLE_SESSION_WSL_RECEIPT_SCHEMA_VERSION ||
		!isHeadSha(value.headSha) ||
		!isBinarySha256(value.binarySha256) ||
		!isDistro(value.distro) ||
		!isVersion(value.hostVersion) ||
		!isVersion(value.distroVersion) ||
		!isSchemaVersion(value.schemaVersionObserved) ||
		!isCount(value.tests) ||
		!isCount(value.skips) ||
		!isCount(value.failures) ||
		!isCount(value.survivors) ||
		!isCount(value.endpointLeaks) ||
		!isCreatedAt(value.createdAt)
	)
		throw receiptError();
	if (!versionsShareMajorMinor(value.hostVersion, value.distroVersion)) throw receiptError();
	const sourceResult = validateLifecycleResult(value.sourceResult);
	const compiledResult = validateLifecycleResult(value.compiledResult);
	if (
		sourceResult.mode !== "source" ||
		compiledResult.mode !== "compiled" ||
		sourceResult.headSha !== value.headSha ||
		compiledResult.headSha !== value.headSha ||
		sourceResult.binarySha256 !== null ||
		compiledResult.binarySha256 !== value.binarySha256 ||
		sourceResult.hostVersion !== value.hostVersion ||
		compiledResult.hostVersion !== value.hostVersion ||
		sourceResult.distroVersion !== value.distroVersion ||
		compiledResult.distroVersion !== value.distroVersion ||
		sourceResult.schemaVersionObserved !== value.schemaVersionObserved ||
		compiledResult.schemaVersionObserved !== value.schemaVersionObserved ||
		value.tests !== sourceResult.tests + compiledResult.tests ||
		value.tests === 0 ||
		value.skips !== sourceResult.skips + compiledResult.skips ||
		value.failures !== sourceResult.failures + compiledResult.failures ||
		value.survivors !== sourceResult.survivors + compiledResult.survivors ||
		value.endpointLeaks !== sourceResult.endpointLeaks + compiledResult.endpointLeaks ||
		value.skips !== 0 ||
		value.failures !== 0 ||
		value.survivors !== 0 ||
		value.endpointLeaks !== 0
	)
		throw receiptError();
	return {
		schemaVersion: VISIBLE_SESSION_WSL_RECEIPT_SCHEMA_VERSION,
		headSha: value.headSha,
		binarySha256: value.binarySha256,
		sourceResult,
		compiledResult,
		distro: value.distro,
		hostVersion: value.hostVersion,
		distroVersion: value.distroVersion,
		schemaVersionObserved: value.schemaVersionObserved,
		tests: value.tests,
		skips: value.skips,
		failures: value.failures,
		survivors: value.survivors,
		endpointLeaks: value.endpointLeaks,
		createdAt: value.createdAt,
	};
}

function canonicalResult(result: VisibleSessionWslLifecycleResult): CanonicalJsonObject {
	return {
		mode: result.mode,
		passed: result.passed,
		headSha: result.headSha,
		binarySha256: result.binarySha256,
		hostVersion: result.hostVersion,
		distroVersion: result.distroVersion,
		schemaVersionObserved: result.schemaVersionObserved,
		tests: result.tests,
		skips: result.skips,
		failures: result.failures,
		survivors: result.survivors,
		endpointLeaks: result.endpointLeaks,
	};
}

function canonicalReceipt(receipt: VisibleSessionWslReceipt): CanonicalJsonObject {
	return {
		schemaVersion: receipt.schemaVersion,
		headSha: receipt.headSha,
		binarySha256: receipt.binarySha256,
		sourceResult: canonicalResult(receipt.sourceResult),
		compiledResult: canonicalResult(receipt.compiledResult),
		distro: receipt.distro,
		hostVersion: receipt.hostVersion,
		distroVersion: receipt.distroVersion,
		schemaVersionObserved: receipt.schemaVersionObserved,
		tests: receipt.tests,
		skips: receipt.skips,
		failures: receipt.failures,
		survivors: receipt.survivors,
		endpointLeaks: receipt.endpointLeaks,
		createdAt: receipt.createdAt,
	};
}

function sortCanonicalJson(value: CanonicalJsonValue): CanonicalJsonValue {
	if (Array.isArray(value)) return value.map(sortCanonicalJson);
	if (value !== null && typeof value === "object") {
		const sorted: CanonicalJsonObject = {};
		for (const key of Object.keys(value).sort()) sorted[key] = sortCanonicalJson(value[key]);
		return sorted;
	}
	return value;
}

/** UTF-8 canonical JSON with recursive lexicographic keys and no trailing newline. */
export function canonicalizeVisibleSessionWslReceipt(value: VisibleSessionWslReceipt): string {
	const receipt = validateVisibleSessionWslReceipt(value);
	return JSON.stringify(sortCanonicalJson(canonicalReceipt(receipt)));
}

function isSafeAbsolutePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\u0000\r\n]/.test(value)) return false;
	if (!path.isAbsolute(value)) return false;
	return !value.split(/[\\/]+/).some(part => part === "." || part === "..");
}

function normalizeSafeAbsolutePath(value: unknown): string {
	if (!isSafeAbsolutePath(value)) throw argumentError();
	return path.resolve(value);
}

function areSamePath(left: string, right: string): boolean {
	const normalizedLeft = process.platform === "win32" ? left.toLowerCase() : left;
	const normalizedRight = process.platform === "win32" ? right.toLowerCase() : right;
	return normalizedLeft === normalizedRight;
}

/** The producer accepts one intentionally ordered, flag-only invocation. */
export function parseVisibleSessionWslReceiptProducerArgv(
	argv: readonly string[],
): VisibleSessionWslReceiptProducerInput {
	if (
		argv.length !== 12 ||
		argv[0] !== "--distro" ||
		argv[2] !== "--source" ||
		argv[3] !== "--compiled" ||
		argv[4] !== "--head" ||
		argv[6] !== "--binary-sha256" ||
		argv[8] !== "--out" ||
		argv[10] !== "--signature" ||
		!isDistro(argv[1]) ||
		!isHeadSha(argv[5]) ||
		!isBinarySha256(argv[7])
	)
		throw argumentError();
	const receiptPath = normalizeSafeAbsolutePath(argv[9]);
	const signaturePath = normalizeSafeAbsolutePath(argv[11]);
	if (areSamePath(receiptPath, signaturePath)) throw argumentError();
	return {
		distro: argv[1],
		source: true,
		compiled: true,
		headSha: argv[5],
		binarySha256: argv[7],
		receiptPath,
		signaturePath,
	};
}

function requireHmacKey(readEnvironment: (name: string) => string | undefined): Buffer {
	const key = readEnvironment(VISIBLE_SESSION_WSL_HMAC_ENV);
	if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32)
		throw new Error("Visible-session WSL receipt signing key is unavailable");
	return Buffer.from(key, "utf8");
}

function hmacSignature(receiptBytes: Uint8Array, key: Uint8Array): string {
	return createHmac("sha256", key).update(receiptBytes).digest("hex");
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, maximumBytes: number): Promise<string> {
	if (stream === null) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.length;
			if (length > maximumBytes) throw new Error("WSL command output exceeded the allowed size");
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function defaultRunCommand(argv: readonly string[]): Promise<VisibleSessionWslCommandResult> {
	const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const completed = Promise.all([child.exited, readBounded(child.stdout, MAX_COMMAND_OUTPUT_BYTES)]);
	const result = await Promise.race([
		completed.then(([exitCode, stdout]) => ({ exitCode, stdout })),
		Bun.sleep(COMMAND_TIMEOUT_MS).then(() => null),
	]);
	if (result !== null) return result;
	try {
		child.kill();
	} catch {}
	await completed.catch(() => undefined);
	throw new Error("WSL command timed out");
}

async function runWslCommand(
	distro: string,
	command: readonly string[],
	runCommand: VisibleSessionWslCommandRunner,
): Promise<string> {
	const result = await runCommand(["wsl.exe", "-d", distro, "--exec", ...command]);
	if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0 || typeof result.stdout !== "string")
		throw new Error("WSL lifecycle command failed");
	return result.stdout;
}

function safeLinuxPath(value: string): string {
	const candidate = value.trim();
	if (
		candidate.length === 0 ||
		candidate.length > 4_096 ||
		/[\u0000\r\n]/.test(candidate) ||
		!candidate.startsWith("/") ||
		candidate.split("/").some(part => part === "." || part === "..")
	)
		throw new Error("WSL path translation failed");
	return candidate;
}

async function translateHostPath(
	distro: string,
	hostPath: string,
	runCommand: VisibleSessionWslCommandRunner,
): Promise<string> {
	return safeLinuxPath(await runWslCommand(distro, ["wslpath", "--absolute", hostPath], runCommand));
}

async function queryGjcVersion(
	argv: readonly string[],
	runCommand: VisibleSessionWslCommandRunner,
): Promise<string> {
	const result = await runCommand(argv);
	if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0 || typeof result.stdout !== "string")
		throw new Error("GJC version command failed");
	return normalizeVisibleSessionWslGjcVersion(result.stdout);
}

async function readDefaultLifecycleReport(_mode: VisibleSessionWslLifecycleMode, file: string): Promise<unknown> {
	const bytes = await readSafeFile(file, MAX_RECEIPT_BYTES);
	try {
		return JSON.parse(bytes.toString("utf8")) as unknown;
	} catch {
		throw new Error("WSL lifecycle report is invalid");
	}
}

async function readSafeFile(file: string, maximumBytes: number): Promise<Buffer> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size < 0 || stat.size > maximumBytes) throw receiptError();
		return await fs.readFile(file);
	} catch {
		throw receiptError();
	}
}

function lifecycleResultFromReport(
	mode: VisibleSessionWslLifecycleMode,
	value: unknown,
	headSha: string,
	binarySha256: string,
	hostVersion: string,
	distroVersion: string,
): VisibleSessionWslLifecycleResult {
	let report: VisibleSessionLifecycleReport;
	try {
		report = validateVisibleSessionLifecycleReport(value);
	} catch {
		throw new Error("WSL lifecycle report is invalid");
	}
	if (
		report.scenario !== mode ||
		report.sourceHead !== headSha ||
		report.failures.length !== 0 ||
		report.terminalKind !== "final" ||
		report.finalCount === 0 ||
		report.vanishedCount !== 0 ||
		report.tokenPresentAfter ||
		report.manifestPresentAfter ||
		report.endpointReachableAfter ||
		report.survivingPids.length !== 0 ||
		(mode === "source" ? report.binarySha256 !== null : report.binarySha256 !== binarySha256)
	)
		throw new Error("WSL lifecycle report did not prove a successful mode");
	return {
		mode,
		passed: true,
		headSha,
		binarySha256: mode === "source" ? null : binarySha256,
		hostVersion,
		distroVersion,
		schemaVersionObserved: report.schemaVersion,
		tests: report.finalCount,
		skips: 0,
		failures: 0,
		survivors: 0,
		endpointLeaks: 0,
	};
}

async function ensureOutputDirectory(file: string): Promise<void> {
	try {
		const directory = await fs.lstat(path.dirname(file));
		if (!directory.isDirectory()) throw argumentError();
	} catch {
		throw argumentError();
	}
}

async function writeAtomically(file: string, contents: Uint8Array): Promise<void> {
	await ensureOutputDirectory(file);
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		try {
			await fs.chmod(temporary, 0o600);
		} catch {}
		await fs.rename(temporary, file);
		try {
			await fs.chmod(file, 0o600);
		} catch {}
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}

/**
 * Executes source and compiled visible-session lifecycle reports through WSL direct argv,
 * derives a sanitized receipt, and writes the two signed artifacts atomically.
 */
export async function produceVisibleSessionWslReceipt(
	input: VisibleSessionWslReceiptProducerInput,
	dependencies: VisibleSessionWslReceiptProducerDependencies = {},
): Promise<VisibleSessionWslReceipt> {
	if (
		!isDistro(input.distro) ||
		input.source !== true ||
		input.compiled !== true ||
		!isHeadSha(input.headSha) ||
		!isBinarySha256(input.binarySha256)
	)
		throw argumentError();
	const receiptPath = normalizeSafeAbsolutePath(input.receiptPath);
	const signaturePath = normalizeSafeAbsolutePath(input.signaturePath);
	if (areSamePath(receiptPath, signaturePath)) throw argumentError();
	const runCommand = dependencies.runCommand ?? defaultRunCommand;
	const readEnvironment = dependencies.readEnvironment ?? (name => process.env[name]);
	const readLifecycleReport = dependencies.readLifecycleReport ?? readDefaultLifecycleReport;
	const now = dependencies.now ?? (() => new Date());
	const signingKey = requireHmacKey(readEnvironment);
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-session-wsl-"));
	try {
		const repositoryPath = path.resolve(import.meta.dir, "..");
		const sourceCli = path.join(repositoryPath, "packages", "coding-agent", "src", "cli.ts");
		const hostVersion = await queryGjcVersion([process.execPath, sourceCli, "--version"], runCommand);
		const linuxRepositoryPath = await translateHostPath(input.distro, repositoryPath, runCommand);
		const linuxTemporaryPath = await translateHostPath(input.distro, temporaryDirectory, runCommand);
		const smokeScript = path.posix.join(linuxRepositoryPath, "scripts", "visible-session-lifecycle-smoke.ts");
		const compiledBinary = path.posix.join(linuxRepositoryPath, "packages", "coding-agent", "dist", "gjc.exe");
		const distroVersion = normalizeVisibleSessionWslGjcVersion(
			await runWslCommand(input.distro, [compiledBinary, "--version"], runCommand),
		);
		if (!versionsShareMajorMinor(hostVersion, distroVersion))
			throw new Error("Host and selected WSL GJC versions do not share a major/minor version");
		const sourceReportPath = path.join(temporaryDirectory, "source.json");
		const compiledReportPath = path.join(temporaryDirectory, "compiled.json");
		const linuxSourceReportPath = path.posix.join(linuxTemporaryPath, "source.json");
		const linuxCompiledReportPath = path.posix.join(linuxTemporaryPath, "compiled.json");

		await runWslCommand(
			input.distro,
			["bun", smokeScript, "--scenario", "source", "--report", linuxSourceReportPath],
			runCommand,
		);
		const sourceResult = lifecycleResultFromReport(
			"source",
			await readLifecycleReport("source", sourceReportPath),
			input.headSha,
			input.binarySha256,
			hostVersion,
			distroVersion,
		);

		await runWslCommand(
			input.distro,
			[
				"env",
				`GJC_VISIBLE_SESSION_COMPILED_BINARY=${compiledBinary}`,
				"bun",
				smokeScript,
				"--scenario",
				"compiled",
				"--report",
				linuxCompiledReportPath,
			],
			runCommand,
		);
		const compiledResult = lifecycleResultFromReport(
			"compiled",
			await readLifecycleReport("compiled", compiledReportPath),
			input.headSha,
			input.binarySha256,
			hostVersion,
			distroVersion,
		);
		if (sourceResult.schemaVersionObserved !== compiledResult.schemaVersionObserved)
			throw new Error("WSL lifecycle schema versions do not match");
		const receipt = validateVisibleSessionWslReceipt({
			schemaVersion: VISIBLE_SESSION_WSL_RECEIPT_SCHEMA_VERSION,
			headSha: input.headSha,
			binarySha256: input.binarySha256,
			sourceResult,
			compiledResult,
			distro: input.distro,
			hostVersion,
			distroVersion,
			schemaVersionObserved: sourceResult.schemaVersionObserved,
			tests: sourceResult.tests + compiledResult.tests,
			skips: sourceResult.skips + compiledResult.skips,
			failures: sourceResult.failures + compiledResult.failures,
			survivors: sourceResult.survivors + compiledResult.survivors,
			endpointLeaks: sourceResult.endpointLeaks + compiledResult.endpointLeaks,
			createdAt: now().toISOString(),
		});
		const receiptBytes = Buffer.from(canonicalizeVisibleSessionWslReceipt(receipt), "utf8");
		const signature = Buffer.from(hmacSignature(receiptBytes, signingKey), "utf8");
		await writeAtomically(receiptPath, receiptBytes);
		await writeAtomically(signaturePath, signature);
		return receipt;
	} finally {
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		const input = parseVisibleSessionWslReceiptProducerArgv(process.argv.slice(2));
		await produceVisibleSessionWslReceipt(input);
	} catch {
		process.exitCode = 1;
	}
}
