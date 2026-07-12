#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SmokeCase } from "./check-dynamic-import-policy";
import { probeDynamicImportManifest } from "./dynamic-import-load-probe";

export const DYNAMIC_IMPORT_RUNTIME_CASES: readonly SmokeCase[] = [
	"help",
	"session",
	"web-search",
	"browser-worker",
	"manifest",
];
export type DynamicImportRuntimeMode = "source" | "compiled";

export interface DynamicImportRuntimeOptions {
	mode?: DynamicImportRuntimeMode;
	binary?: string;
	repoRoot?: string;
	agentDir?: string;
}

interface CommandResult {
	exitCode: number;
	output: string;
}

interface RuntimeLauncher {
	command(args: string[]): string[];
	mode: DynamicImportRuntimeMode;
}

export function parseDynamicImportRuntimeArgs(argv: string[]): {
	mode: DynamicImportRuntimeMode;
	binary?: string;
	cases: SmokeCase[];
} {
	let mode: DynamicImportRuntimeMode = "source";
	let binary: string | undefined;
	let cases = [...DYNAMIC_IMPORT_RUNTIME_CASES];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--mode") {
			const value = argv[++index];
			if (value !== "source" && value !== "compiled") throw new Error(`Invalid --mode: ${value ?? "<missing>"}`);
			mode = value;
		} else if (arg === "--binary") {
			binary = argv[++index];
			if (!binary) throw new Error("--binary requires a path");
		} else if (arg === "--cases") {
			const value = argv[++index];
			if (!value) throw new Error("--cases requires a comma-separated list");
			const requested = value.split(",").filter(Boolean);
			const invalid = requested.filter(name => !DYNAMIC_IMPORT_RUNTIME_CASES.includes(name as SmokeCase));
			if (invalid.length > 0) throw new Error(`Invalid --cases: ${invalid.join(", ")}`);
			cases = requested as SmokeCase[];
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { mode, binary, cases };
}

function createLauncher(options: DynamicImportRuntimeOptions, repoRoot: string): RuntimeLauncher {
	const mode = options.mode ?? "source";
	if (mode === "source") {
		return { mode, command: args => [process.execPath, "packages/coding-agent/src/cli.ts", ...args] };
	}
	const configuredBinary = options.binary ?? Bun.env.GJC_DYNAMIC_IMPORT_BINARY;
	if (!configuredBinary) {
		throw new Error("Compiled dynamic-import runtime verification requires --binary or GJC_DYNAMIC_IMPORT_BINARY");
	}
	const binary = path.resolve(repoRoot, configuredBinary);
	return { mode, command: args => [binary, ...args] };
}

async function runCommand(command: string[], repoRoot: string, agentDir: string): Promise<CommandResult> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env: {
			...Bun.env,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_DISABLE_AUTO_UPDATE: "1",
			GJC_WEB_SEARCH_TIMEOUT_MS: "1",
			NO_COLOR: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, output: `${stdout}\n${stderr}` };
}

async function verifyCommandCase(
	name: SmokeCase,
	args: string[],
	expected: RegExp,
	launcher: RuntimeLauncher,
	repoRoot: string,
	agentDir: string,
	acceptedExitCodes: readonly number[] = [0],
): Promise<void> {
	const result = await runCommand(launcher.command(args), repoRoot, agentDir);
	if (!acceptedExitCodes.includes(result.exitCode)) {
		throw new Error(`${name} ${launcher.mode} smoke failed with ${result.exitCode}:\n${result.output}`);
	}
	if (!expected.test(result.output)) throw new Error(`${name} smoke did not render expected output:\n${result.output}`);
}
export function assertBrowserWorkerReachedConnect(message: unknown): void {
	const result = message as { type?: string; stage?: string; error?: { message?: string } };
	if (result.type !== "init-failed" || result.stage !== "connect" || !result.error?.message) {
		throw new Error(`browser-worker smoke expected connect-stage init-failed, received ${JSON.stringify(message)}`);
	}
}


async function verifyBrowserWorker(repoRoot: string): Promise<void> {
	if (process.env.GJC_BUILD_SKU === "core") {
		const { assertInlineTabWorkerEnabled } = await import(
			"../packages/coding-agent/src/tools/browser/tab-supervisor"
		);
		try {
			assertInlineTabWorkerEnabled(new Error("worker entry is absent from the compiled bundle"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/CORE SKU.*FULL SKU.*GAJAE_CODE_BROWSER_INLINE_WORKER=1/s.test(message)) return;
			throw new Error(`CORE browser-worker smoke received a non-actionable error: ${message}`);
		}
		throw new Error("CORE browser-worker smoke unexpectedly enabled inline fallback");
	}
	const entry = path.join(repoRoot, "packages/coding-agent/src/tools/browser/tab-worker-entry.ts");
	const safeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-browser-worker-smoke-"));
	const worker = new Worker(entry, { type: "module" });
	try {
		const response = Promise.withResolvers<unknown>();
		worker.onmessage = event => response.resolve(event.data);
		worker.onerror = event => response.reject(new Error(event.message));
		worker.postMessage({
			type: "init",
			payload: {
				mode: "headless",
				browserWSEndpoint: "ws://127.0.0.1:1/dynamic-import-smoke",
				safeDir,
				timeoutMs: 1,
			},
		});
		const message = await Promise.race([
			response.promise,
			Bun.sleep(10_000).then(() => {
				throw new Error("browser-worker smoke timed out waiting for init response");
			}),
		]);
		assertBrowserWorkerReachedConnect(message);
	} finally {
		await worker.terminate();
		await fs.rm(safeDir, { recursive: true, force: true });
	}
}

export async function runDynamicImportRuntimeCase(
	name: SmokeCase,
	options: DynamicImportRuntimeOptions = {},
): Promise<void> {
	const repoRoot = options.repoRoot ?? path.resolve(import.meta.dir, "..");
	const launcher = createLauncher(options, repoRoot);
	const ownedAgentDir = options.agentDir ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lazy-import-smoke-"));
	const agentDir = options.agentDir ?? ownedAgentDir!;
	try {
		switch (name) {
			case "help":
				await verifyCommandCase(name, ["config", "--help"], /Manage configuration|Usage:/i, launcher, repoRoot, agentDir);
				break;
			case "session":
				await verifyCommandCase(name, ["session", "list"], /\S/, launcher, repoRoot, agentDir);
				break;
			case "web-search":
				await verifyCommandCase(
					name,
					["web-search", "--provider", "duckduckgo", "dynamic import runtime smoke"],
					/DuckDuckGo|duckduckgo|search|timed out|failed/i,
					launcher,
					repoRoot,
					agentDir,
					[0, 1],
				);
				break;
			case "browser-worker":
				if (process.env.GJC_BUILD_SKU === "core") {
					await verifyBrowserWorker(repoRoot);
				} else if (launcher.mode === "compiled") {
					await verifyCommandCase(
						name,
						["__probe-browser-worker"],
						/browser-worker-probe: ok/,
						launcher,
						repoRoot,
						agentDir,
					);
				} else {
					await verifyBrowserWorker(repoRoot);
				}
				break;
			case "manifest":
				await probeDynamicImportManifest(repoRoot);
				break;
		}
	} finally {
		if (ownedAgentDir) await fs.rm(ownedAgentDir, { recursive: true, force: true });
	}
}

export async function verifyDynamicImportRuntime(
	cases: readonly SmokeCase[] = DYNAMIC_IMPORT_RUNTIME_CASES,
	options: DynamicImportRuntimeOptions = {},
): Promise<void> {
	for (const name of cases) await runDynamicImportRuntimeCase(name, options);
}

if (import.meta.main) {
	const parsed = parseDynamicImportRuntimeArgs(process.argv.slice(2));
	await verifyDynamicImportRuntime(parsed.cases, { mode: parsed.mode, binary: parsed.binary });
	process.stdout.write(`PASS dynamic-import runtime ${parsed.mode} (${parsed.cases.join(", ")})\n`);
}
