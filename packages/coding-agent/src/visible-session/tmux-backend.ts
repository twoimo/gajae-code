import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	VisibleSessionBackendCancelResult,
	VisibleSessionBackendContext,
	VisibleSessionBackendPort,
	VisibleSessionBackendProbe,
	VisibleSessionBackendSessionCommandInput,
	VisibleSessionBackendTerminal,
	VisibleSessionBackendUnavailable,
} from "./backend";
import type { VisibleSessionTmuxOwnership } from "./types";

const TMUX_BACKEND_ID = "tmux" as const;
const TMUX_TARGET_TAGS = [
	"@gjc-profile",
	"@gjc-session-id",
	"@gjc-session-state-file",
	"@gjc-owner-generation",
	"@gjc-owner-server-key",
] as const;

export interface VisibleSessionTmuxSpawnResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** Injectable direct-argv tmux invocation boundary. */
export type VisibleSessionTmuxSpawn = (argv: readonly string[]) => Promise<VisibleSessionTmuxSpawnResult>;

export interface VisibleSessionTmuxBackendDependencies {
	tmuxCommand?: string;
	spawn?: VisibleSessionTmuxSpawn;
	readFile?: (file: string) => Promise<string>;
}

type TerminalReceipt =
	| { kind: "absent" }
	| { kind: "final"; exitCode: number }
	| { kind: "vanished" }
	| { kind: "invalid" }
	| { kind: "conflict" };

type JsonRead = { kind: "absent" } | { kind: "value"; value: unknown } | { kind: "invalid" };
type OwnershipProof = "valid" | "session_unavailable" | "tags_invalid";

function unavailable(reason: string): VisibleSessionBackendUnavailable {
	return { kind: "unavailable", backend: TMUX_BACKEND_ID, reason };
}

function terminal(status: VisibleSessionBackendTerminal["status"]): VisibleSessionBackendTerminal {
	return { kind: "terminal", backend: TMUX_BACKEND_ID, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
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

function ownershipFor(context: VisibleSessionBackendContext): VisibleSessionTmuxOwnership | null {
	const ownership = context.generation.tmux;
	if (!ownership) return null;
	if (
		!isNonEmptyText(ownership.socketKey) ||
		!isNonEmptyText(ownership.sessionName) ||
		!isNonEmptyText(ownership.stateFilePath) ||
		!isNonEmptyText(ownership.ownerGeneration) ||
		ownership.ownerGeneration !== context.generation.generationId ||
		!path.isAbsolute(context.generation.privateRoot) ||
		path.resolve(context.generation.privateRoot) !== context.generation.privateRoot ||
		!path.isAbsolute(ownership.stateFilePath) ||
		path.resolve(ownership.stateFilePath) !== ownership.stateFilePath ||
		ownership.stateFilePath !== path.join(context.generation.privateRoot, "runtime-state.json")
	)
		return null;
	return ownership;
}

function targetFor(ownership: VisibleSessionTmuxOwnership): string {
	return `=${ownership.sessionName}:`;
}

function defaultSpawn(argv: readonly string[]): Promise<VisibleSessionTmuxSpawnResult> {
	const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
		([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }),
	);
}

async function defaultReadFile(file: string): Promise<string> {
	return fs.readFile(file, "utf8");
}

/** Read-only adapter for a tagged, generation-owned tmux session. */
export class VisibleSessionTmuxBackend implements VisibleSessionBackendPort {
	readonly id = TMUX_BACKEND_ID;
	readonly capabilities = { localControl: false, interactiveAttach: true, routerWatch: true };
	readonly #tmuxCommand: string;
	readonly #spawn: VisibleSessionTmuxSpawn;
	readonly #readFile: (file: string) => Promise<string>;

	constructor(dependencies: VisibleSessionTmuxBackendDependencies = {}) {
		this.#tmuxCommand = dependencies.tmuxCommand ?? "tmux";
		this.#spawn = dependencies.spawn ?? defaultSpawn;
		this.#readFile = dependencies.readFile ?? defaultReadFile;
	}

	async sessionCommand(
		input: VisibleSessionBackendSessionCommandInput,
	): Promise<readonly string[] | VisibleSessionBackendUnavailable> {
		const ownership = ownershipFor(input.context);
		if (!ownership) return unavailable("tmux_ownership_invalid");
		const proof = await this.#proveOwnership(ownership);
		if (proof !== "valid")
			return unavailable(proof === "session_unavailable" ? "tmux_session_unavailable" : "tmux_tags_invalid");
		return [
			this.#tmuxCommand,
			"-L",
			ownership.socketKey,
			"attach-session",
			...(input.readOnly ? ["-r"] : []),
			"-t",
			targetFor(ownership),
		];
	}

	async probe(context: VisibleSessionBackendContext): Promise<VisibleSessionBackendProbe> {
		const ownership = ownershipFor(context);
		if (!ownership) return unavailable("tmux_ownership_invalid");
		const receipt = await this.#readTerminalReceipt(ownership);
		if (receipt.kind === "invalid") return unavailable("tmux_terminal_receipt_invalid");
		if (receipt.kind === "conflict") return unavailable("tmux_terminal_conflict");
		if (receipt.kind === "final") return terminal(receipt.exitCode === 0 ? "completed" : "failed");
		if (receipt.kind === "vanished") return terminal("vanished");
		const proof = await this.#proveOwnership(ownership);
		if (proof !== "valid")
			return unavailable(proof === "session_unavailable" ? "tmux_session_unavailable" : "tmux_tags_invalid");
		return { kind: "running", backend: TMUX_BACKEND_ID };
	}

	async cancel(_context: VisibleSessionBackendContext): Promise<VisibleSessionBackendCancelResult> {
		return unavailable("cancel_unsupported");
	}

	async #proveOwnership(ownership: VisibleSessionTmuxOwnership): Promise<OwnershipProof> {
		const target = targetFor(ownership);
		if (!(await this.#succeeds([this.#tmuxCommand, "-L", ownership.socketKey, "has-session", "-t", target])))
			return "session_unavailable";
		const expectedTags: Readonly<Record<(typeof TMUX_TARGET_TAGS)[number], string>> = {
			"@gjc-profile": "1",
			"@gjc-session-id": ownership.sessionName,
			"@gjc-session-state-file": ownership.stateFilePath,
			"@gjc-owner-generation": ownership.ownerGeneration,
			"@gjc-owner-server-key": ownership.socketKey,
		};
		for (const tag of TMUX_TARGET_TAGS) {
			const result = await this.#run([
				this.#tmuxCommand,
				"-L",
				ownership.socketKey,
				"show-options",
				"-t",
				target,
				"-v",
				tag,
			]);
			if (!result || result.exitCode !== 0 || outputValue(result.stdout) !== expectedTags[tag])
				return "tags_invalid";
		}
		return "valid";
	}

	async #succeeds(argv: readonly string[]): Promise<boolean> {
		const result = await this.#run(argv);
		return result?.exitCode === 0;
	}

	async #run(argv: readonly string[]): Promise<VisibleSessionTmuxSpawnResult | null> {
		try {
			return await this.#spawn(argv);
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

	async #readTerminalReceipt(ownership: VisibleSessionTmuxOwnership): Promise<TerminalReceipt> {
		const root = path.dirname(ownership.stateFilePath);
		const [finalReceipt, vanishedReceipt] = await Promise.all([
			this.#readJson(path.join(root, "final.json")),
			this.#readJson(path.join(root, "vanished.json")),
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
