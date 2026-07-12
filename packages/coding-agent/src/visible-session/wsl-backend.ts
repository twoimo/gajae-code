import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils";
import type {
	VisibleSessionBackendCancelResult,
	VisibleSessionBackendContext,
	VisibleSessionBackendPort,
	VisibleSessionBackendProbe,
	VisibleSessionBackendSessionCommandInput,
	VisibleSessionBackendTerminal,
	VisibleSessionBackendUnavailable,
} from "./backend";
import {
	VISIBLE_SESSION_SCHEMA_VERSION,
	type VisibleSessionTmuxOwnership,
	type VisibleSessionWslTmuxOwnership,
} from "./types";

const WSL_BACKEND_ID = "wsl-tmux" as const;
const WSL_COMMAND = "wsl.exe";
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
const WSL_COMMAND_TIMEOUT_MS = 10_000;
const TMUX_TARGET_TAGS = [
	"@gjc-profile",
	"@gjc-backend",
	"@gjc-schema-version",
	"@gjc-session-id",
	"@gjc-session-state-file",
	"@gjc-owner-generation",
	"@gjc-owner-server-key",
] as const;

type WslUnavailableReason =
	| "wsl_ownership_invalid"
	| "wsl_unavailable"
	| "wsl_distro_missing"
	| "wsl_path_mismatch"
	| "wsl_version_mismatch"
	| "wsl_schema_mismatch"
	| "wsl_tmux_unavailable"
	| "wsl_tags_invalid"
	| "cancel_unsupported"
	| "wsl_terminal_receipt_invalid"
	| "wsl_terminal_conflict";

type TerminalReceipt =
	| { kind: "absent" }
	| { kind: "final"; exitCode: number }
	| { kind: "vanished" }
	| { kind: "invalid" }
	| { kind: "conflict" };

type JsonRead = { kind: "absent" } | { kind: "value"; value: unknown } | { kind: "invalid" };
type OwnershipProof = "valid" | "unavailable" | "tmux_unavailable" | "tags_invalid";
type WslOwnership = VisibleSessionTmuxOwnership & VisibleSessionWslTmuxOwnership;
type PrepareResult = { kind: "ready"; ownership: WslOwnership } | VisibleSessionBackendUnavailable;

export interface VisibleSessionWslRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** Injectable direct-argv WSL invocation boundary. */
export type VisibleSessionWslRun = (argv: readonly string[]) => Promise<VisibleSessionWslRunResult>;

export interface VisibleSessionWslBackendDependencies {
	hostVersion?: string;
	readFile?: (file: string) => Promise<string>;
	run?: VisibleSessionWslRun;
}

function unavailable(reason: WslUnavailableReason): VisibleSessionBackendUnavailable {
	return { kind: "unavailable", backend: WSL_BACKEND_ID, reason };
}

function terminal(status: VisibleSessionBackendTerminal["status"]): VisibleSessionBackendTerminal {
	return { kind: "terminal", backend: WSL_BACKEND_ID, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0") && !/[\r\n]/.test(value);
}

function isCanonicalHostPath(value: unknown): value is string {
	return (
		isSafeText(value) &&
		!value.startsWith("\\\\") &&
		!value.startsWith("//") &&
		path.win32.isAbsolute(value) &&
		path.win32.resolve(value) === value
	);
}

function isCanonicalLinuxPath(value: unknown): value is string {
	return isSafeText(value) && path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
}

function outputValue(value: string): string {
	if (!value.endsWith("\n")) return value;
	const withoutLineFeed = value.slice(0, -1);
	return withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseFinalReceipt(value: unknown, sessionName: string): number | null {
	if (
		!isRecord(value) ||
		value.session !== sessionName ||
		typeof value.exit_code !== "number" ||
		!Number.isSafeInteger(value.exit_code)
	)
		return null;
	return value.exit_code;
}

function isValidVanishedReceipt(value: unknown, sessionName: string): boolean {
	return isRecord(value) && value.session === sessionName;
}

function hasCompatibleMajorMinor(first: string, second: string): boolean {
	const firstMatch = /^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(first);
	const secondMatch = /^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(second);
	return (
		firstMatch !== null &&
		secondMatch !== null &&
		firstMatch[1] === secondMatch[1] &&
		firstMatch[2] === secondMatch[2]
	);
}
function readGjcVersion(stdout: string): string | null {
	const match = /^gjc\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(outputValue(stdout));
	return match?.[1] ?? null;
}

function ownershipFor(context: VisibleSessionBackendContext): WslOwnership | null {
	if (context.entry.backend !== WSL_BACKEND_ID) return null;
	const wsl = context.generation.wslTmux;
	const tmux = context.generation.tmux;
	if (!wsl || !tmux) return null;
	if (
		!isSafeText(wsl.distro) ||
		!isSafeText(tmux.socketKey) ||
		!isSafeText(tmux.sessionName) ||
		!isSafeText(tmux.ownerGeneration) ||
		!isSafeText(wsl.hostVersion) ||
		!isSafeText(wsl.distroVersion) ||
		tmux.ownerGeneration !== context.generation.generationId ||
		!isCanonicalHostPath(context.generation.privateRoot) ||
		!isCanonicalHostPath(tmux.stateFilePath) ||
		!isCanonicalLinuxPath(wsl.linuxStateFilePath) ||
		tmux.stateFilePath !== path.win32.join(context.generation.privateRoot, "runtime-state.json")
	)
		return null;
	return { ...tmux, ...wsl };
}

function wslArgv(distro: string, command: readonly string[]): readonly string[] {
	return [WSL_COMMAND, "-d", distro, "--exec", ...command];
}

function isWithinOutputCap(value: string): boolean {
	return new TextEncoder().encode(value).byteLength <= MAX_CAPTURED_OUTPUT_BYTES;
}

async function captureOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_CAPTURED_OUTPUT_BYTES) {
				await reader.cancel();
				throw new Error("captured WSL output exceeds the limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function defaultRun(argv: readonly string[]): Promise<VisibleSessionWslRunResult> {
	const child = Bun.spawn([...argv], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: WSL_COMMAND_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const stdout = captureOutput(child.stdout);
	const stderr = captureOutput(child.stderr);
	try {
		const [exitCode, capturedStdout, capturedStderr] = await Promise.all([child.exited, stdout, stderr]);
		return { exitCode, stdout: capturedStdout, stderr: capturedStderr };
	} catch {
		child.kill("SIGKILL");
		await Promise.allSettled([child.exited, stdout, stderr]);
		throw new Error("WSL direct-argv invocation failed");
	}
}

async function defaultReadFile(file: string): Promise<string> {
	return fs.readFile(file, "utf8");
}

/** Read-only adapter for a generation-owned tmux server inside one named WSL distribution. */
export class VisibleSessionWslBackend implements VisibleSessionBackendPort {
	readonly id = WSL_BACKEND_ID;
	readonly capabilities = { localControl: false, interactiveAttach: true, routerWatch: true };
	readonly #hostVersion: string;
	readonly #readFile: (file: string) => Promise<string>;
	readonly #runWsl: VisibleSessionWslRun;

	constructor(dependencies: VisibleSessionWslBackendDependencies = {}) {
		this.#hostVersion = dependencies.hostVersion ?? VERSION;
		this.#readFile = dependencies.readFile ?? defaultReadFile;
		this.#runWsl = dependencies.run ?? defaultRun;
	}

	async sessionCommand(
		input: VisibleSessionBackendSessionCommandInput,
	): Promise<readonly string[] | VisibleSessionBackendUnavailable> {
		const prepared = await this.#prepare(input.context);
		if (prepared.kind === "unavailable") return prepared;
		const proof = await this.#proveOwnership(prepared.ownership);
		if (proof !== "valid") return unavailable(this.#proofReason(proof));
		return wslArgv(prepared.ownership.distro, [
			"tmux",
			"-L",
			prepared.ownership.socketKey,
			"attach-session",
			...(input.readOnly ? ["-r"] : []),
			"-t",
			targetFor(prepared.ownership),
		]);
	}

	async probe(context: VisibleSessionBackendContext): Promise<VisibleSessionBackendProbe> {
		const local = this.#localOwnership(context);
		if (local.kind === "unavailable") return local;
		const receipt = await this.#readTerminalReceipt(local.ownership);
		if (receipt.kind === "invalid") return unavailable("wsl_terminal_receipt_invalid");
		if (receipt.kind === "conflict") return unavailable("wsl_terminal_conflict");
		if (receipt.kind === "final") return terminal(receipt.exitCode === 0 ? "completed" : "failed");
		if (receipt.kind === "vanished") return terminal("vanished");
		const prepared = await this.#prepareWsl(local.ownership);
		if (prepared.kind === "unavailable") return prepared;
		const proof = await this.#proveOwnership(prepared.ownership);
		if (proof !== "valid") return unavailable(this.#proofReason(proof));
		return { kind: "running", backend: WSL_BACKEND_ID };
	}

	async cancel(_context: VisibleSessionBackendContext): Promise<VisibleSessionBackendCancelResult> {
		return unavailable("cancel_unsupported");
	}

	async #prepare(context: VisibleSessionBackendContext): Promise<PrepareResult> {
		const local = this.#localOwnership(context);
		if (local.kind === "unavailable") return local;
		return this.#prepareWsl(local.ownership);
	}

	#localOwnership(context: VisibleSessionBackendContext): PrepareResult {
		const ownership = ownershipFor(context);
		if (!ownership) return unavailable("wsl_ownership_invalid");
		if (ownership.schemaVersion !== VISIBLE_SESSION_SCHEMA_VERSION) return unavailable("wsl_schema_mismatch");
		if (
			!hasCompatibleMajorMinor(this.#hostVersion, ownership.hostVersion) ||
			!hasCompatibleMajorMinor(ownership.hostVersion, ownership.distroVersion)
		)
			return unavailable("wsl_version_mismatch");
		return { kind: "ready", ownership };
	}

	async #prepareWsl(ownership: WslOwnership): Promise<PrepareResult> {
		const availability = await this.#run(wslArgv(ownership.distro, ["true"]));
		if (!availability) return unavailable("wsl_unavailable");
		if (availability.exitCode !== 0) return unavailable("wsl_distro_missing");
		const version = await this.#run(wslArgv(ownership.distro, ["gjc", "--version"]));
		const runtimeVersion = version ? readGjcVersion(version.stdout) : null;
		if (
			!version ||
			version.exitCode !== 0 ||
			!runtimeVersion ||
			!hasCompatibleMajorMinor(this.#hostVersion, runtimeVersion) ||
			!hasCompatibleMajorMinor(runtimeVersion, ownership.distroVersion)
		)
			return unavailable("wsl_version_mismatch");
		const translatedPath = await this.#run(
			wslArgv(ownership.distro, ["wslpath", "-a", "-u", ownership.stateFilePath]),
		);
		if (!translatedPath) return unavailable("wsl_unavailable");
		if (translatedPath.exitCode !== 0 || outputValue(translatedPath.stdout) !== ownership.linuxStateFilePath)
			return unavailable("wsl_path_mismatch");
		return { kind: "ready", ownership };
	}

	async #proveOwnership(ownership: WslOwnership): Promise<OwnershipProof> {
		const target = targetFor(ownership);
		const session = await this.#run(
			wslArgv(ownership.distro, ["tmux", "-L", ownership.socketKey, "has-session", "-t", target]),
		);
		if (!session) return "unavailable";
		if (session.exitCode !== 0) return "tmux_unavailable";
		const expectedTags: Readonly<Record<(typeof TMUX_TARGET_TAGS)[number], string>> = {
			"@gjc-profile": "1",
			"@gjc-backend": WSL_BACKEND_ID,
			"@gjc-schema-version": String(ownership.schemaVersion),
			"@gjc-session-id": ownership.sessionName,
			"@gjc-session-state-file": ownership.linuxStateFilePath,
			"@gjc-owner-generation": ownership.ownerGeneration,
			"@gjc-owner-server-key": ownership.socketKey,
		};
		for (const tag of TMUX_TARGET_TAGS) {
			const result = await this.#run(
				wslArgv(ownership.distro, ["tmux", "-L", ownership.socketKey, "show-options", "-t", target, "-v", tag]),
			);
			if (!result) return "unavailable";
			if (result.exitCode !== 0 || outputValue(result.stdout) !== expectedTags[tag]) return "tags_invalid";
		}
		return "valid";
	}

	#proofReason(proof: Exclude<OwnershipProof, "valid">): WslUnavailableReason {
		if (proof === "unavailable") return "wsl_unavailable";
		if (proof === "tmux_unavailable") return "wsl_tmux_unavailable";
		return "wsl_tags_invalid";
	}

	async #run(argv: readonly string[]): Promise<VisibleSessionWslRunResult | null> {
		try {
			const result = await this.#runWsl(argv);
			if (!isWithinOutputCap(result.stdout) || !isWithinOutputCap(result.stderr)) return null;
			return result;
		} catch {
			return null;
		}
	}

	async #readJson(file: string): Promise<JsonRead> {
		try {
			return { kind: "value", value: JSON.parse(await this.#readFile(file)) };
		} catch (error) {
			return isMissingFile(error) ? { kind: "absent" } : { kind: "invalid" };
		}
	}

	async #readTerminalReceipt(ownership: WslOwnership): Promise<TerminalReceipt> {
		const root = path.win32.dirname(ownership.stateFilePath);
		const [finalReceipt, vanishedReceipt] = await Promise.all([
			this.#readJson(path.win32.join(root, "final.json")),
			this.#readJson(path.win32.join(root, "vanished.json")),
		]);
		if (finalReceipt.kind === "invalid" || vanishedReceipt.kind === "invalid") return { kind: "invalid" };
		const finalExitCode =
			finalReceipt.kind === "value" ? parseFinalReceipt(finalReceipt.value, ownership.sessionName) : undefined;
		if (finalReceipt.kind === "value" && finalExitCode === null) return { kind: "invalid" };
		const vanishedValid =
			vanishedReceipt.kind === "value"
				? isValidVanishedReceipt(vanishedReceipt.value, ownership.sessionName)
				: undefined;
		if (vanishedReceipt.kind === "value" && !vanishedValid) return { kind: "invalid" };
		if (typeof finalExitCode === "number" && vanishedValid) return { kind: "conflict" };
		if (typeof finalExitCode === "number") return { kind: "final", exitCode: finalExitCode };
		if (vanishedValid) return { kind: "vanished" };
		return { kind: "absent" };
	}
}

function targetFor(ownership: WslOwnership): string {
	return `=${ownership.sessionName}:`;
}
