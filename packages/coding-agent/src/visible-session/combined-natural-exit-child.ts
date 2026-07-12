import * as crypto from "node:crypto";
import type * as events from "node:events";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { controlEndpointFor } from "./control-server";

const OUTPUT_BYTE_LIMIT = 1_048_576;
const CONTROL_DIR_PREFIX = "gjc-visible-control-";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

const SUITE_BASENAMES = [
	"control-protocol.test.ts",
	"control-transport.test.ts",
	"command-service.test.ts",
	"attach.test.ts",
] as const;

export type EndpointProbeStatus = "absent" | "refused" | "connected" | "error";
export type ListenerMap = Record<string, number>;

export interface StreamSummary {
	byteCount: number;
	hash: string;
	truncated: boolean;
}

export interface ChildReceipt {
	schemaVersion: 1;
	childPid: number;
	suites: readonly string[];
	suiteCommand: string;
	startedAt: number;
	endedAt: number;
	elapsedMs: number;
	childExitCode: number;
	childSignal: string | null;
	timedOut: boolean;
	failures: number;
	stdout: StreamSummary;
	stderr: StreamSummary;
	listenerDeltas: {
		stdin: ListenerMap;
		stdout: ListenerMap;
	};
	terminal: {
		baselineHash: string;
		afterHash: string;
	};
	endpoints: Array<{
		pathHash: string;
		status: EndpointProbeStatus;
	}>;
	error?: string;
}

interface RunTestResult {
	exitCode: number;
	signal: string | null;
	timedOut: boolean;
	stdout: StreamSummary;
	stderr: StreamSummary;
}

function parseArg(prefix: string, args: readonly string[]): string | undefined {
	for (const arg of args) {
		if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
	}
	return undefined;
}

function parseTimeout(value: string | undefined): number {
	if (!value) return DEFAULT_COMMAND_TIMEOUT_MS;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_COMMAND_TIMEOUT_MS;
}

function hashText(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function eventName(event: string | symbol): string {
	return typeof event === "string" ? event : event.toString();
}

function snapshotListeners(stream: events.EventEmitter | null | undefined): ListenerMap {
	if (!stream) return {};
	const listeners: ListenerMap = {};
	for (const name of stream.eventNames()) {
		const count = stream.listenerCount(name);
		if (count > 0) listeners[eventName(name)] = count;
	}
	return listeners;
}

function diffListenerMaps(before: ListenerMap, after: ListenerMap): ListenerMap {
	const delta: ListenerMap = {};
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const change = (after[key] ?? 0) - (before[key] ?? 0);
		if (change > 0) delta[key] = change;
	}
	return delta;
}

async function collectStream(stream: ReadableStream<Uint8Array> | null, byteLimit: number): Promise<StreamSummary> {
	if (!stream) return { byteCount: 0, hash: "", truncated: false };

	const reader = stream.getReader();
	const hasher = crypto.createHash("sha256");
	let byteCount = 0;
	let truncated = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			byteCount += value.byteLength;
			hasher.update(value);
			if (byteCount > byteLimit) truncated = true;
		}
	} finally {
		reader.releaseLock();
	}

	return {
		byteCount,
		hash: hasher.digest("hex"),
		truncated,
	};
}

function terminalStateHash(): string {
	const stdin = process.stdin as NodeJS.ReadStream & { columns?: number; rows?: number };
	const state = {
		stdin: {
			isTTY: stdin.isTTY === true,
			columns: stdin.columns ?? null,
			rows: stdin.rows ?? null,
		},
		stdout: {
			isTTY: process.stdout?.isTTY === true,
			columns: process.stdout?.columns ?? null,
			rows: process.stdout?.rows ?? null,
		},
		stderr: {
			isTTY: process.stderr?.isTTY === true,
			columns: process.stderr?.columns ?? null,
			rows: process.stderr?.rows ?? null,
		},
	};
	return hashText(JSON.stringify(state));
}

async function collectEndpointRoots(tmpRoot: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(tmpRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const roots = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(CONTROL_DIR_PREFIX)) continue;
		const root = path.join(tmpRoot, entry.name);
		roots.add(root);

		try {
			for (const nested of await fs.readdir(root, { withFileTypes: true })) {
				if (nested.isDirectory()) roots.add(path.join(root, nested.name));
			}
		} catch {
			// ignore
		}
	}

	return [...roots].sort();
}

async function probeEndpoint(endpoint: string): Promise<EndpointProbeStatus> {
	return await new Promise<EndpointProbeStatus>(resolve => {
		let settled = false;
		const settle = (status: EndpointProbeStatus): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			socket.removeAllListeners();
			socket.destroy();
			resolve(status);
		};
		const timeoutId = setTimeout(() => settle("error"), 250);
		const socket = net.createConnection({ path: endpoint });
		socket.once("connect", () => settle("connected"));
		socket.once("error", error => {
			const code =
				error != null && typeof error === "object" && "code" in error
					? ((error as NodeJS.ErrnoException).code ?? "unknown")
					: "unknown";
			if (code === "ENOENT") settle("absent");
			else if (code === "ECONNREFUSED") settle("refused");
			else settle("error");
		});
	});
}

async function collectEndpoints(tmpRoot: string): Promise<Array<{ pathHash: string; status: EndpointProbeStatus }>> {
	const candidateRoots = await collectEndpointRoots(tmpRoot);
	const candidateEndpoints = new Set<string>();
	for (const root of candidateRoots) {
		if (process.platform === "win32") {
			candidateEndpoints.add(
				controlEndpointFor({
					privateGenerationRoot: root,
					generation: "generation-1",
					platform: "win32",
				}),
			);
		} else {
			candidateEndpoints.add(path.join(root, "control-v1.sock"));
		}
	}

	const endpoints = await Promise.all(
		[...candidateEndpoints].map(async endpoint => ({
			pathHash: hashText(endpoint),
			status: await probeEndpoint(endpoint),
		})),
	);
	return endpoints.sort((a, b) => a.pathHash.localeCompare(b.pathHash));
}

function toIntegerTimeout(value: number): number {
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_COMMAND_TIMEOUT_MS;
}

async function runSuites(
	targets: readonly string[],
	workingDirectory: string,
	commandEnv: NodeJS.ProcessEnv,
	commandTimeoutMs: number,
): Promise<RunTestResult> {
	const timeoutMs = Math.max(1_000, toIntegerTimeout(commandTimeoutMs));
	const command = [process.execPath, "test", ...targets, "--timeout", String(timeoutMs), "--no-color"];

	const child = Bun.spawn(command, {
		cwd: workingDirectory,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: commandEnv,
	});

	const timeout = Promise.withResolvers<void>();
	const timer = setTimeout(() => timeout.resolve(), timeoutMs);
	const stdoutPromise = collectStream(child.stdout, OUTPUT_BYTE_LIMIT);
	const stderrPromise = collectStream(child.stderr, OUTPUT_BYTE_LIMIT);

	let timedOut = false;
	let exitCode = 1;

	try {
		const result = await Promise.race<{ timedOut: false; exitCode: number } | { timedOut: true; exitCode: number }>([
			child.exited.then(code => ({ timedOut: false as const, exitCode: code ?? 1 })),
			timeout.promise.then(() => ({ timedOut: true as const, exitCode: 1 })),
		]);
		timedOut = result.timedOut;
		exitCode = result.exitCode;
		if (timedOut) {
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
	} finally {
		clearTimeout(timer);
	}

	await child.exited.catch(() => undefined);

	if (timedOut) exitCode = 1;
	const childSignal = (child as { signalCode?: string | null }).signalCode ?? null;
	const signal = timedOut ? (childSignal ?? "SIGKILL") : childSignal;
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

	return {
		exitCode,
		signal,
		timedOut,
		stdout,
		stderr,
	};
}

function buildCommandLine(targets: readonly string[], commandTimeoutMs: number): string {
	return `bun test ${targets.join(" ")} --timeout ${Math.max(1_000, toIntegerTimeout(commandTimeoutMs))} --no-color`;
}

async function buildReceipt(options: {
	receiptPath: string;
	tmpRoot: string;
	repoRoot: string;
	commandTimeoutMs: number;
}): Promise<ChildReceipt> {
	const suites = SUITE_BASENAMES;
	const targetPaths = suites.map(name => path.join(import.meta.dir, name));
	const startedAt = Date.now();

	const commandEnv: NodeJS.ProcessEnv = {
		...process.env,
		TMPDIR: options.tmpRoot,
		TMP: options.tmpRoot,
		TEMP: options.tmpRoot,
	};

	const baselineListeners = {
		stdin: snapshotListeners(process.stdin),
		stdout: snapshotListeners(process.stdout),
	};
	const baselineTerminalHash = terminalStateHash();
	const receipt: ChildReceipt = {
		schemaVersion: 1,
		childPid: process.pid,
		suites,
		suiteCommand: buildCommandLine(suites, options.commandTimeoutMs),
		startedAt,
		endedAt: startedAt,
		elapsedMs: 0,
		childExitCode: 1,
		childSignal: null,
		timedOut: false,
		failures: 1,
		stdout: { byteCount: 0, hash: "", truncated: false },
		stderr: { byteCount: 0, hash: "", truncated: false },
		listenerDeltas: {
			stdin: {},
			stdout: {},
		},
		terminal: {
			baselineHash: baselineTerminalHash,
			afterHash: baselineTerminalHash,
		},
		endpoints: [],
	};

	try {
		const runResult = await runSuites(targetPaths, options.repoRoot, commandEnv, options.commandTimeoutMs);
		receipt.childExitCode = runResult.exitCode;
		receipt.childSignal = runResult.signal;
		receipt.timedOut = runResult.timedOut;
		receipt.failures = runResult.timedOut || runResult.exitCode !== 0 ? 1 : 0;
		receipt.stdout = runResult.stdout;
		receipt.stderr = runResult.stderr;
		receipt.listenerDeltas = {
			stdin: diffListenerMaps(baselineListeners.stdin, snapshotListeners(process.stdin)),
			stdout: diffListenerMaps(baselineListeners.stdout, snapshotListeners(process.stdout)),
		};
		receipt.terminal.afterHash = terminalStateHash();
	} catch (error) {
		receipt.error = error instanceof Error ? error.message : String(error);
		receipt.childExitCode = 1;
		receipt.failures = 1;
	}

	try {
		receipt.endpoints = await collectEndpoints(options.tmpRoot);
	} catch (error) {
		if (!receipt.error) receipt.error = error instanceof Error ? error.message : String(error);
	}

	receipt.endedAt = Date.now();
	receipt.elapsedMs = receipt.endedAt - startedAt;
	await fs.writeFile(options.receiptPath, JSON.stringify(receipt), "utf8");
	return receipt;
}

if (import.meta.main && Bun.argv.includes("--child")) {
	const receiptPath = parseArg("--receipt", Bun.argv);
	if (!receiptPath) throw new Error("Missing required --receipt argument");

	const tmpRoot = parseArg("--tmp-root", Bun.argv) ?? process.env.GJC_NATURAL_EXIT_TMP_ROOT ?? os.tmpdir();
	const repoRoot = parseArg("--repo-root", Bun.argv) ?? path.resolve(import.meta.dir, "../../../..");
	const commandTimeoutMs = parseTimeout(parseArg("--timeout-ms", Bun.argv));

	const receipt = await buildReceipt({
		receiptPath,
		tmpRoot,
		repoRoot,
		commandTimeoutMs,
	});

	if (receipt.childExitCode === 0 && !receipt.timedOut && receipt.childSignal === null && receipt.failures === 0) {
		process.exit(0);
	}
	process.exit(receipt.childExitCode);
}
