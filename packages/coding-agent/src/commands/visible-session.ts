import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "@gajae-code/utils/cli";
import { filterProcessEnv } from "@gajae-code/utils/env";
import { Settings } from "../config/settings";
import { resolveGjcRuntimeSpawnInfo } from "../daemon/runtime";
import type { VisibleSessionBackendId, VisibleSessionBackendPort } from "../visible-session/backend";
import {
	VisibleSessionCommandError,
	VisibleSessionCommandService,
	type VisibleSessionPromptSource,
	type VisibleSessionStatusReceipt,
} from "../visible-session/command-service";
import { canonicalControlPromptForms } from "../visible-session/control-protocol";
import type { VisibleSessionExecutableSpec, VisibleSessionLaunchReceipt } from "../visible-session/launch";
import {
	canonicalizeCustomPublicBase,
	validateVisibleSessionName,
	visibleSessionPaths,
} from "../visible-session/paths";
import { VisibleSessionRegistry } from "../visible-session/registry";
import { VisibleSessionTmuxBackend } from "../visible-session/tmux-backend";
import type { VisibleSessionRegistryEntry, VisibleSessionRegistryFile } from "../visible-session/types";

const DEFAULT_STALE_MINUTES = 60;
const MIN_STALE_MINUTES = 1;
const MAX_STALE_MINUTES = 10_080;
const MAX_ROUTER_TEXT_BYTES = 1_024;
const MAX_ROUTER_KEYWORDS = 64;
const MAX_ROUTER_KEYWORD_BYTES = 4_096;
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 1_000;
const TAIL_BYTES = 16 * 1024;

const PUBLIC_MESSAGES: Record<VisibleSessionPublicErrorCode, string> = {
	invalid_name: "Invalid session name.",
	invalid_input: "Invalid command input.",
	invalid_router_option: "Invalid router option.",
	not_found: "Visible session not found.",
	generation_conflict: "Visible session generation conflict.",
	session_nonterminal: "Visible session is not terminal.",
	backend_unavailable: "Selected backend is unavailable.",
	router_watch_unsupported: "Router watch is unsupported for the selected backend.",
	router_option_conflict: "Router options conflict.",
	router_not_found: "Router executable not found.",
	launch_failed: "Visible session launch failed.",
	control_failed: "Visible session control failed.",
	state_corrupt: "Visible session state is corrupt.",
	liveness_uncertain: "Visible session liveness is uncertain.",
	terminal_restore_failed: "Terminal restoration failed.",
};

const PUBLIC_COMMANDS = ["create", "prompt", "tail", "status", "attach", "monitor", "cancel", "recreate"] as const;
const CREATION_FLAGS = new Set([
	"--backend",
	"--state-dir",
	"--router",
	"--skip-router",
	"--stale-minutes",
	"--keywords",
	"--channel",
	"--mention",
]);
const ROUTER_FLAGS = new Set(["--router", "--skip-router", "--stale-minutes", "--keywords", "--channel", "--mention"]);
const VALUE_FLAGS = new Set([
	"--backend",
	"--state-dir",
	"--router",
	"--stale-minutes",
	"--keywords",
	"--channel",
	"--mention",
]);

type VisibleSessionStoredBackend = "conpty" | "tmux";
type VisibleSessionSuccessCommand = Exclude<VisibleSessionPublicCommand, "attach">;
type VisibleSessionFailureCommand = VisibleSessionPublicCommand;

export type VisibleSessionPublicCommand = (typeof PUBLIC_COMMANDS)[number];
export type VisibleSessionPublicBackend = "auto" | "conpty" | "tmux";
export type VisibleSessionPublicErrorCode =
	| "invalid_name"
	| "invalid_input"
	| "invalid_router_option"
	| "not_found"
	| "generation_conflict"
	| "session_nonterminal"
	| "backend_unavailable"
	| "router_watch_unsupported"
	| "router_option_conflict"
	| "router_not_found"
	| "launch_failed"
	| "control_failed"
	| "state_corrupt"
	| "liveness_uncertain"
	| "terminal_restore_failed";

export interface VisibleSessionRouterOptions {
	router?: string;
	skipRouter: boolean;
	staleMinutes: number;
	keywords: readonly string[];
	channel?: string;
	mention?: string;
}

export interface VisibleSessionCommandEnvironment {
	GJC_SESSION_BACKEND?: string;
	GJC_SESSION_ROUTER?: string;
	GJC_SESSION_SKIP_ROUTER?: string;
	GJC_SESSION_STALE_MINUTES?: string;
	GJC_SESSION_KEYWORDS?: string;
	GJC_SESSION_CHANNEL?: string;
	GJC_SESSION_MENTION?: string;
}

export interface VisibleSessionCommandIo {
	stdout(bytes: string | Uint8Array): void;
	stderr(text: string): void;
	stdinIsTTY(): boolean;
	stdoutIsTTY(): boolean;
}

export interface VisibleSessionCommandDependencies {
	env: VisibleSessionCommandEnvironment;
	platform: NodeJS.Platform;
	settings: Pick<Settings, "get" | "getAgentDir">;
	service: VisibleSessionCommandService;
	registry: VisibleSessionRegistry;
	io: VisibleSessionCommandIo;
	spawnAttached(argv: readonly string[]): Promise<number>;
	resolveWorktree(path: string): Promise<{ repository: string; worktree: string }>;
	executableFor(worktree: string): VisibleSessionExecutableSpec;
	canonicalizeStateDir?(candidate: string, protectedPaths: readonly string[]): Promise<string>;
}

export interface VisibleSessionRunResult {
	exitCode: 0 | 1 | 2;
}

interface VisibleSessionSuccess<R> {
	schemaVersion: 1;
	ok: true;
	command: VisibleSessionSuccessCommand;
	name: string;
	generationId: string | null;
	backend: "conpty" | "tmux" | null;
	result: R;
}

interface VisibleSessionFailure {
	schemaVersion: 1;
	ok: false;
	command: VisibleSessionFailureCommand;
	code: VisibleSessionPublicErrorCode;
	message: string;
	retryable: false;
}

interface ParsedInvocation {
	command: VisibleSessionPublicCommand;
	positionals: readonly string[];
	json: boolean;
	readOnly: boolean;
	backend?: string;
	stateDir?: string;
	router?: string;
	skipRouter: boolean;
	staleMinutes?: string;
	keywords?: string;
	channel?: string;
	mention?: string;
	routerFlagPresent: boolean;
}

interface ResolvedRouterOptions {
	options: VisibleSessionRouterOptions;
	intent: boolean;
}

interface RegistryEntryReceipt {
	entry: VisibleSessionRegistryEntry;
	revision: number;
	backend: VisibleSessionStoredBackend;
}

interface RuntimeContext {
	env: VisibleSessionCommandEnvironment;
	platform: NodeJS.Platform;
	settings: Pick<Settings, "get" | "getAgentDir">;
	io: VisibleSessionCommandIo;
	dependencies(): Promise<VisibleSessionCommandDependencies>;
}

class VisibleSessionPublicCommandError extends Error {
	constructor(readonly code: VisibleSessionPublicErrorCode) {
		super(code);
		this.name = "VisibleSessionPublicCommandError";
	}
}

function publicCommand(value: string | undefined): VisibleSessionPublicCommand | undefined {
	return PUBLIC_COMMANDS.find(command => command === value);
}

function fail(code: VisibleSessionPublicErrorCode): never {
	throw new VisibleSessionPublicCommandError(code);
}

function defaultIo(): VisibleSessionCommandIo {
	return {
		stdout: bytes => {
			process.stdout.write(bytes);
		},
		stderr: text => {
			process.stderr.write(text);
		},
		stdinIsTTY: () => process.stdin.isTTY === true,
		stdoutIsTTY: () => process.stdout.isTTY === true,
	};
}

function defaultExecutableFor(worktree: string): VisibleSessionExecutableSpec {
	const runtime = resolveGjcRuntimeSpawnInfo();
	return {
		executable: runtime.execPath,
		args: [...runtime.argsPrefix],
		cwd: worktree,
		env: filterProcessEnv(process.env),
	};
}

async function defaultSpawnAttached(argv: readonly string[]): Promise<number> {
	const child = Bun.spawn([...argv], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return child.exited;
}

function parseGitPath(output: string): string | undefined {
	const suffix = output.endsWith("\r\n") ? 2 : output.endsWith("\n") ? 1 : 0;
	if (suffix === 0) return undefined;
	const value = output.slice(0, -suffix);
	if (value.length === 0 || value.includes("\0") || value.includes("\n") || value.includes("\r")) return undefined;
	return value;
}

async function runGit(argv: readonly string[], cwd: string): Promise<string> {
	const child = Bun.spawn([...argv], {
		cwd,
		env: filterProcessEnv(process.env),
		stdout: "pipe",
		stderr: "ignore",
	});
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	if (exitCode !== 0) throw new Error("git command failed");
	return stdout;
}

async function defaultResolveWorktree(candidate: string): Promise<{ repository: string; worktree: string }> {
	const worktree = await fs.realpath(candidate);
	const topLevel = parseGitPath(await runGit(["git", "-C", worktree, "rev-parse", "--show-toplevel"], worktree));
	const commonDirectory = parseGitPath(
		await runGit(["git", "-C", worktree, "rev-parse", "--git-common-dir"], worktree),
	);
	if (!topLevel || !commonDirectory) throw new Error("invalid worktree");
	const resolvedTopLevel = await fs.realpath(path.resolve(worktree, topLevel));
	if (resolvedTopLevel !== worktree) throw new Error("worktree is not repository root");
	const commonRoot = await fs.realpath(path.resolve(worktree, commonDirectory));
	return {
		repository: path.basename(commonRoot) === ".git" ? path.dirname(commonRoot) : commonRoot,
		worktree,
	};
}

async function createRuntimeContext(partial: Partial<VisibleSessionCommandDependencies>): Promise<RuntimeContext> {
	const settings = partial.settings ?? (await Settings.init());
	const env: VisibleSessionCommandEnvironment = partial.env ?? {
		GJC_SESSION_BACKEND: process.env.GJC_SESSION_BACKEND,
		GJC_SESSION_ROUTER: process.env.GJC_SESSION_ROUTER,
		GJC_SESSION_SKIP_ROUTER: process.env.GJC_SESSION_SKIP_ROUTER,
		GJC_SESSION_STALE_MINUTES: process.env.GJC_SESSION_STALE_MINUTES,
		GJC_SESSION_KEYWORDS: process.env.GJC_SESSION_KEYWORDS,
		GJC_SESSION_CHANNEL: process.env.GJC_SESSION_CHANNEL,
		GJC_SESSION_MENTION: process.env.GJC_SESSION_MENTION,
	};
	const platform = partial.platform ?? process.platform;
	const io = partial.io ?? defaultIo();
	let complete: VisibleSessionCommandDependencies | undefined;
	return {
		env,
		platform,
		settings,
		io,
		dependencies: async () => {
			if (complete) return complete;
			const registry =
				partial.registry ??
				new VisibleSessionRegistry({
					agentDir: settings.getAgentDir(),
					platform: platform === "win32" ? "win32" : "posix",
				});
			const tmuxBackend = new VisibleSessionTmuxBackend();
			const backendPorts = new Map<VisibleSessionBackendId, VisibleSessionBackendPort>([["tmux", tmuxBackend]]);
			const service =
				partial.service ??
				new VisibleSessionCommandService({
					registry,
					backendPorts,
				});
			const dependencies: VisibleSessionCommandDependencies = {
				env,
				platform,
				settings,
				service,
				registry,
				io,
				spawnAttached: partial.spawnAttached ?? defaultSpawnAttached,
				resolveWorktree: partial.resolveWorktree ?? defaultResolveWorktree,
				executableFor: partial.executableFor ?? defaultExecutableFor,
				canonicalizeStateDir: partial.canonicalizeStateDir,
			};
			complete = dependencies;
			return dependencies;
		},
	};
}

function parseInvocation(argv: readonly string[]): ParsedInvocation {
	const command = publicCommand(argv[0]);
	if (!command) fail("invalid_input");
	const positionals: string[] = [];
	const seen = new Set<string>();
	const valueByFlag = new Map<string, string>();
	let json = false;
	let readOnly = false;
	let skipRouter = false;
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const equals = token.indexOf("=");
		const flag = equals === -1 ? token : token.slice(0, equals);
		const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
		if (seen.has(flag)) fail("invalid_input");
		seen.add(flag);
		if (flag === "--json") {
			if (inlineValue !== undefined || command === "attach") fail("invalid_input");
			json = true;
			continue;
		}
		if (flag === "--read-only") {
			if (inlineValue !== undefined || command !== "attach") fail("invalid_input");
			readOnly = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) fail("invalid_input");
		if ((flag === "--backend" || CREATION_FLAGS.has(flag)) && command !== "create" && command !== "recreate")
			fail("invalid_input");
		const value =
			inlineValue ??
			(() => {
				const next = argv[index + 1];
				if (next === undefined || next.startsWith("--")) fail("invalid_input");
				index += 1;
				return next;
			})();
		valueByFlag.set(flag, value);
	}
	for (const positional of positionals) {
		if (positional.startsWith("--")) fail("invalid_input");
	}
	const expectedPositionals =
		command === "create" ? [2] : command === "prompt" ? [2] : command === "tail" ? [1, 2] : [1];
	if (!expectedPositionals.includes(positionals.length)) fail("invalid_input");
	for (const flag of valueByFlag.keys()) {
		if (ROUTER_FLAGS.has(flag) || flag === "--backend" || flag === "--state-dir") {
			if (command !== "create" && command !== "recreate") fail("invalid_input");
		}
	}
	if (seen.has("--skip-router")) {
		if (command !== "create" && command !== "recreate") fail("invalid_input");
		skipRouter = true;
	}
	return {
		command,
		positionals,
		json,
		readOnly,
		backend: valueByFlag.get("--backend"),
		stateDir: valueByFlag.get("--state-dir"),
		router: valueByFlag.get("--router"),
		skipRouter,
		staleMinutes: valueByFlag.get("--stale-minutes"),
		keywords: valueByFlag.get("--keywords"),
		channel: valueByFlag.get("--channel"),
		mention: valueByFlag.get("--mention"),
		routerFlagPresent: [...seen].some(flag => ROUTER_FLAGS.has(flag)),
	};
}

function resolveBackend(invocation: ParsedInvocation, context: RuntimeContext): "conpty" | "tmux" {
	const configured = context.settings.get("session.backend");
	const candidate =
		invocation.backend !== undefined
			? invocation.backend
			: context.env.GJC_SESSION_BACKEND !== undefined && context.env.GJC_SESSION_BACKEND !== ""
				? context.env.GJC_SESSION_BACKEND
				: typeof configured === "string"
					? configured
					: "auto";
	if (candidate !== "auto" && candidate !== "conpty" && candidate !== "tmux") fail("invalid_input");
	return candidate === "auto" ? (context.platform === "win32" ? "conpty" : "tmux") : candidate;
}

function textOption(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (
		trimmed.length === 0 ||
		trimmed.includes("\0") ||
		trimmed.includes("\r") ||
		trimmed.includes("\n") ||
		Buffer.byteLength(trimmed, "utf8") > MAX_ROUTER_TEXT_BYTES
	)
		fail("invalid_router_option");
	return trimmed;
}

function staleMinutes(value: string | undefined): number {
	if (value === undefined) return DEFAULT_STALE_MINUTES;
	if (!/^[0-9]+$/.test(value)) fail("invalid_router_option");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < MIN_STALE_MINUTES || parsed > MAX_STALE_MINUTES)
		fail("invalid_router_option");
	return parsed;
}

function routerKeywords(value: string | undefined): readonly string[] {
	if (value === undefined) return [];
	const keywords = value.split(",").map(keyword => keyword.trim());
	if (keywords.some(keyword => keyword.length === 0) || keywords.length > MAX_ROUTER_KEYWORDS)
		fail("invalid_router_option");
	const byteLength = keywords.reduce((total, keyword) => total + Buffer.byteLength(keyword, "utf8"), 0);
	if (byteLength > MAX_ROUTER_KEYWORD_BYTES) fail("invalid_router_option");
	return keywords;
}

function skipRouterValue(value: string | undefined): boolean {
	if (value === undefined) return false;
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
			return true;
		case "0":
		case "false":
		case "no":
			return false;
		default:
			fail("invalid_router_option");
	}
}

function nonEmptyEnvironment(value: string | undefined): string | undefined {
	return value === "" ? undefined : value;
}

function resolveRouterOptions(invocation: ParsedInvocation, context: RuntimeContext): ResolvedRouterOptions {
	const cli = invocation.routerFlagPresent;
	const source = cli
		? {
				router: invocation.router,
				skipRouter: invocation.skipRouter ? "true" : undefined,
				staleMinutes: invocation.staleMinutes,
				keywords: invocation.keywords,
				channel: invocation.channel,
				mention: invocation.mention,
			}
		: {
				router: nonEmptyEnvironment(context.env.GJC_SESSION_ROUTER),
				skipRouter: nonEmptyEnvironment(context.env.GJC_SESSION_SKIP_ROUTER),
				staleMinutes: nonEmptyEnvironment(context.env.GJC_SESSION_STALE_MINUTES),
				keywords: nonEmptyEnvironment(context.env.GJC_SESSION_KEYWORDS),
				channel: nonEmptyEnvironment(context.env.GJC_SESSION_CHANNEL),
				mention: nonEmptyEnvironment(context.env.GJC_SESSION_MENTION),
			};
	const anySourceValue = Object.values(source).some(value => value !== undefined);
	const skipRouter = skipRouterValue(source.skipRouter);
	const otherRouterValue =
		source.router !== undefined ||
		source.staleMinutes !== undefined ||
		source.keywords !== undefined ||
		source.channel !== undefined ||
		source.mention !== undefined;
	if (skipRouter && otherRouterValue) fail("router_option_conflict");
	const options: VisibleSessionRouterOptions = {
		router: textOption(source.router),
		skipRouter,
		staleMinutes: staleMinutes(source.staleMinutes),
		keywords: routerKeywords(source.keywords),
		channel: textOption(source.channel),
		mention: textOption(source.mention),
	};
	const nonDefault =
		options.router !== undefined ||
		options.skipRouter ||
		options.staleMinutes !== DEFAULT_STALE_MINUTES ||
		options.keywords.length > 0 ||
		options.channel !== undefined ||
		options.mention !== undefined;
	return { options, intent: cli || anySourceValue || nonDefault };
}

function validateName(name: string, platform: NodeJS.Platform): void {
	try {
		validateVisibleSessionName(name, platform === "win32" ? "win32" : "posix");
	} catch {
		fail("invalid_name");
	}
}

function promptSource(value: string): VisibleSessionPromptSource {
	if (value === "@") fail("invalid_input");
	if (value.startsWith("@@")) {
		const literal = value.slice(1);
		if (canonicalControlPromptForms(literal) === undefined) fail("invalid_input");
		return { kind: "literal", text: literal };
	}
	if (value.startsWith("@")) return { kind: "file", path: value.slice(1) };
	if (canonicalControlPromptForms(value) === undefined) fail("invalid_input");
	return { kind: "literal", text: value };
}

function tailLines(value: string | undefined): number {
	if (value === undefined) return DEFAULT_TAIL_LINES;
	if (!/^[0-9]+$/.test(value)) fail("invalid_input");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TAIL_LINES) fail("invalid_input");
	return parsed;
}

function storedBackend(entry: VisibleSessionRegistryEntry): VisibleSessionStoredBackend {
	if (entry.backend === "conpty" || entry.backend === "tmux") return entry.backend;
	return fail("backend_unavailable");
}

async function currentEntry(
	dependencies: VisibleSessionCommandDependencies,
	name: string,
	platform: NodeJS.Platform,
): Promise<RegistryEntryReceipt> {
	validateName(name, platform);
	let registry: VisibleSessionRegistryFile;
	try {
		registry = await dependencies.registry.read();
	} catch {
		fail("state_corrupt");
	}
	const key = validateVisibleSessionName(name, platform === "win32" ? "win32" : "posix").key;
	const entry = registry.entries.find(candidate => candidate.name.key === key);
	if (!entry) fail("not_found");
	return { entry, revision: registry.revision, backend: storedBackend(entry) };
}

function mapServiceError(
	caught: unknown,
	backend: VisibleSessionStoredBackend | undefined,
	fallback: VisibleSessionPublicErrorCode,
): VisibleSessionPublicErrorCode {
	if (caught instanceof VisibleSessionPublicCommandError) return caught.code;
	if (!(caught instanceof VisibleSessionCommandError)) return fallback;
	switch (caught.code) {
		case "invalid_name":
			return "invalid_name";
		case "invalid_input":
		case "invalid_prompt":
			return "invalid_input";
		case "not_found":
			return "not_found";
		case "generation_mismatch":
		case "conflict":
			return "generation_conflict";
		case "not_recreatable":
			return "session_nonterminal";
		case "control_unavailable":
			return backend === "tmux" ? "backend_unavailable" : "control_failed";
		case "startup_failed":
			return "launch_failed";
		case "registry_unavailable":
		case "public_state_corrupt":
			return "state_corrupt";
		case "public_state_unavailable":
		case "public_state_transient":
		case "liveness_uncertain":
			return "liveness_uncertain";
		case "invalid_token":
		case "control_rejected":
			return "control_failed";
	}
	return fallback;
}

function success<R>(
	command: VisibleSessionSuccessCommand,
	name: string,
	generationId: string | null,
	backend: "conpty" | "tmux" | null,
	result: R,
): VisibleSessionSuccess<R> {
	return { schemaVersion: 1, ok: true, command, name, generationId, backend, result };
}

function failure(command: VisibleSessionFailureCommand, code: VisibleSessionPublicErrorCode): VisibleSessionFailure {
	return { schemaVersion: 1, ok: false, command, code, message: PUBLIC_MESSAGES[code], retryable: false };
}

function writeSuccess<R>(
	io: VisibleSessionCommandIo,
	json: boolean,
	value: VisibleSessionSuccess<R>,
	text: string | Uint8Array,
): VisibleSessionRunResult {
	io.stdout(json ? `${JSON.stringify(value)}\n` : text);
	return { exitCode: 0 };
}

function writeFailure(
	io: VisibleSessionCommandIo,
	command: VisibleSessionFailureCommand | undefined,
	json: boolean,
	code: VisibleSessionPublicErrorCode,
): VisibleSessionRunResult {
	if (command !== undefined && json && command !== "attach") io.stdout(`${JSON.stringify(failure(command, code))}\n`);
	else io.stderr(`${code.toUpperCase()}: ${PUBLIC_MESSAGES[code]}\n`);
	return {
		exitCode:
			code === "launch_failed" ||
			code === "control_failed" ||
			code === "state_corrupt" ||
			code === "liveness_uncertain" ||
			code === "terminal_restore_failed"
				? 1
				: 2,
	};
}

async function resolveStateDir(
	stateDir: string | undefined,
	worktree: string,
	context: RuntimeContext,
	dependencies: VisibleSessionCommandDependencies,
): Promise<string | undefined> {
	if (stateDir === undefined) return undefined;
	if (stateDir.length === 0 || stateDir.includes("\0")) fail("invalid_input");
	const paths = visibleSessionPaths(context.settings.getAgentDir());
	try {
		return await (dependencies.canonicalizeStateDir ?? canonicalizeCustomPublicBase)(path.resolve(stateDir), [
			paths.root,
			paths.privateRoot,
			paths.registryFile,
			worktree,
		]);
	} catch {
		fail("invalid_input");
	}
}

async function runCreate(invocation: ParsedInvocation, context: RuntimeContext): Promise<VisibleSessionRunResult> {
	const [name, worktreePath] = invocation.positionals;
	if (!name || !worktreePath) fail("invalid_input");
	validateName(name, context.platform);
	const backend = resolveBackend(invocation, context);
	const router = resolveRouterOptions(invocation, context);
	if (backend === "tmux" || context.platform !== "win32") fail("backend_unavailable");
	if (router.intent) fail("router_watch_unsupported");
	const dependencies = await context.dependencies();
	let worktree: { repository: string; worktree: string };
	try {
		worktree = await dependencies.resolveWorktree(worktreePath);
	} catch {
		fail("invalid_input");
	}
	const publicBase = await resolveStateDir(invocation.stateDir, worktree.worktree, context, dependencies);
	let receipt: VisibleSessionLaunchReceipt;
	try {
		receipt = await dependencies.service.create({
			name,
			repository: worktree.repository,
			worktree: worktree.worktree,
			backend: "conpty",
			publicBase,
			executable: dependencies.executableFor(worktree.worktree),
		});
	} catch (caught) {
		fail(mapServiceError(caught, "conpty", "launch_failed"));
	}
	return writeSuccess(
		context.io,
		invocation.json,
		success("create", name, receipt.generationId, "conpty", { publicRoot: receipt.publicRoot, status: "created" }),
		`${name} ${receipt.generationId} conpty\n`,
	);
}

async function runPrompt(invocation: ParsedInvocation, context: RuntimeContext): Promise<VisibleSessionRunResult> {
	const [name, input] = invocation.positionals;
	if (!name || input === undefined) fail("invalid_input");
	validateName(name, context.platform);
	const source = promptSource(input);
	const dependencies = await context.dependencies();
	const current = await currentEntry(dependencies, name, context.platform);
	if (current.backend !== "conpty") fail("backend_unavailable");
	try {
		await dependencies.service.prompt(name, source);
	} catch (caught) {
		fail(mapServiceError(caught, current.backend, "control_failed"));
	}
	return writeSuccess(
		context.io,
		invocation.json,
		success("prompt", current.entry.name.displayName, current.entry.active.generationId, current.backend, {
			accepted: true,
		}),
		`accepted ${current.entry.name.displayName} ${current.entry.active.generationId}\n`,
	);
}

async function runTail(invocation: ParsedInvocation, context: RuntimeContext): Promise<VisibleSessionRunResult> {
	const [name, requestedLines] = invocation.positionals;
	if (!name) fail("invalid_input");
	validateName(name, context.platform);
	const lines = tailLines(requestedLines);
	const dependencies = await context.dependencies();
	const current = await currentEntry(dependencies, name, context.platform);
	try {
		const pane = await dependencies.service.tail(name, { bytes: TAIL_BYTES, lines });
		return writeSuccess(
			context.io,
			invocation.json,
			success("tail", current.entry.name.displayName, current.entry.active.generationId, current.backend, pane),
			pane.text,
		);
	} catch (caught) {
		fail(mapServiceError(caught, current.backend, "state_corrupt"));
	}
}

function statusResult(receipt: VisibleSessionStatusReceipt): {
	phase: "terminal" | "ready" | "running" | "stale";
	reason: null;
	terminal: "final" | "vanished" | null;
	summary: null;
} {
	return { phase: receipt.phase, reason: null, terminal: receipt.terminal, summary: null };
}

async function runStatus(
	invocation: ParsedInvocation,
	context: RuntimeContext,
	command: "status" | "monitor",
): Promise<VisibleSessionRunResult> {
	const [name] = invocation.positionals;
	if (!name) fail("invalid_input");
	validateName(name, context.platform);
	const dependencies = await context.dependencies();
	const current = await currentEntry(dependencies, name, context.platform);
	try {
		const receipt =
			command === "status" ? await dependencies.service.status(name) : await dependencies.service.monitor(name);
		return writeSuccess(
			context.io,
			invocation.json,
			success(command, current.entry.name.displayName, receipt.generationId, current.backend, statusResult(receipt)),
			`${current.entry.name.displayName} ${receipt.phase} -\n`,
		);
	} catch (caught) {
		fail(mapServiceError(caught, current.backend, "state_corrupt"));
	}
}

async function runAttach(invocation: ParsedInvocation, context: RuntimeContext): Promise<VisibleSessionRunResult> {
	const [name] = invocation.positionals;
	if (!name) fail("invalid_input");
	if (!context.io.stdinIsTTY() || !context.io.stdoutIsTTY()) fail("invalid_input");
	validateName(name, context.platform);
	const dependencies = await context.dependencies();
	const current = await currentEntry(dependencies, name, context.platform);
	try {
		if (current.backend === "tmux") {
			const argv = await dependencies.service.sessionCommand(name, { readOnly: invocation.readOnly });
			if ((await dependencies.spawnAttached(argv)) !== 0) fail("control_failed");
		} else {
			await dependencies.service.attach({ name, readOnly: invocation.readOnly });
		}
		return { exitCode: 0 };
	} catch (caught) {
		fail(mapServiceError(caught, current.backend, "control_failed"));
	}
}

async function runCancel(invocation: ParsedInvocation, context: RuntimeContext): Promise<VisibleSessionRunResult> {
	const [name] = invocation.positionals;
	if (!name) fail("invalid_input");
	validateName(name, context.platform);
	const dependencies = await context.dependencies();
	const current = await currentEntry(dependencies, name, context.platform);
	if (current.backend !== "conpty") fail("backend_unavailable");
	try {
		const cancelled = await dependencies.service.cancel(name);
		const result = { cancelled: cancelled.cancelled, idempotent: !cancelled.cancelled };
		return writeSuccess(
			context.io,
			invocation.json,
			success("cancel", current.entry.name.displayName, current.entry.active.generationId, current.backend, result),
			`${cancelled.cancelled ? "cancelled" : "already-cancelled"} ${current.entry.name.displayName} ${current.entry.active.generationId}\n`,
		);
	} catch (caught) {
		fail(mapServiceError(caught, current.backend, "control_failed"));
	}
}

async function runRecreate(invocation: ParsedInvocation, context: RuntimeContext): Promise<VisibleSessionRunResult> {
	const [name] = invocation.positionals;
	if (!name) fail("invalid_input");
	if (invocation.stateDir !== undefined) fail("invalid_input");
	validateName(name, context.platform);
	const selectedBackend = resolveBackend(invocation, context);
	const router = resolveRouterOptions(invocation, context);
	if (selectedBackend === "tmux" || context.platform !== "win32") fail("backend_unavailable");
	if (router.intent) fail("router_watch_unsupported");
	const dependencies = await context.dependencies();
	const current = await currentEntry(dependencies, name, context.platform);
	if (current.backend !== "conpty") fail("backend_unavailable");
	let receipt: VisibleSessionLaunchReceipt;
	try {
		receipt = await dependencies.service.recreate({
			name,
			expectedRevision: current.revision,
			expectedActiveGeneration: current.entry.active.generationId,
			executable: dependencies.executableFor(current.entry.worktree),
		});
	} catch (caught) {
		fail(mapServiceError(caught, current.backend, "launch_failed"));
	}
	return writeSuccess(
		context.io,
		invocation.json,
		success("recreate", current.entry.name.displayName, receipt.generationId, "conpty", {
			publicRoot: receipt.publicRoot,
			status: "created",
		}),
		`${current.entry.name.displayName} ${receipt.generationId} conpty\n`,
	);
}

async function runInvocation(invocation: ParsedInvocation, context: RuntimeContext): Promise<VisibleSessionRunResult> {
	switch (invocation.command) {
		case "create":
			return runCreate(invocation, context);
		case "prompt":
			return runPrompt(invocation, context);
		case "tail":
			return runTail(invocation, context);
		case "status":
			return runStatus(invocation, context, "status");
		case "attach":
			return runAttach(invocation, context);
		case "monitor":
			return runStatus(invocation, context, "monitor");
		case "cancel":
			return runCancel(invocation, context);
		case "recreate":
			return runRecreate(invocation, context);
	}
	return fail("invalid_input");
}

function requestedJson(argv: readonly string[], command: VisibleSessionPublicCommand | undefined): boolean {
	return (
		command !== undefined &&
		command !== "attach" &&
		argv.some(value => value === "--json" || value.startsWith("--json="))
	);
}

/** Runs the public visible-session CLI without mutating process-global state. */
export async function runVisibleSessionCommand(
	argv: readonly string[],
	dependencies: Partial<VisibleSessionCommandDependencies> = {},
): Promise<VisibleSessionRunResult> {
	const command = publicCommand(argv[0]);
	const json = requestedJson(argv, command);
	const io = dependencies.io ?? defaultIo();
	try {
		const invocation = parseInvocation(argv);
		const context = await createRuntimeContext({ ...dependencies, io });
		return await runInvocation(invocation, context);
	} catch (caught) {
		const code =
			caught instanceof VisibleSessionPublicCommandError
				? caught.code
				: command === "create" || command === "recreate"
					? "launch_failed"
					: command === "prompt" || command === "cancel" || command === "attach"
						? "control_failed"
						: command === undefined
							? "invalid_input"
							: "state_corrupt";
		return writeFailure(io, command, json, code);
	}
}

export default class VisibleSession extends Command {
	static description = "Create and control named visible coding sessions";
	static strict = false;

	async run(): Promise<void> {
		const result = await runVisibleSessionCommand(this.argv);
		process.exitCode = result.exitCode;
	}
}
