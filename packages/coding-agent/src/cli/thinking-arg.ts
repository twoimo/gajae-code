import { type Effort, THINKING_EFFORTS } from "@gajae-code/ai/model-thinking";
import { CliParseError, splitArgvAtDelimiter } from "@gajae-code/utils/cli";

const THINKING_FLAG = "--thinking";
const THINKING_EQUALS_PREFIX = `${THINKING_FLAG}=`;
const EFFORT_BY_NAME: ReadonlyMap<string, Effort> = new Map(THINKING_EFFORTS.map(effort => [effort, effort]));
const REQUIRED_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"--mode",
	"--fork",
	"--provider",
	"--model",
	"--smol",
	"--slow",
	"--plan",
	"--mpreset",
	"--api-key",
	"--credential",
	"--system-prompt",
	"--append-system-prompt",
	"--provider-session-id",
	"--session-dir",
	"--listen",
	"--models",
	"--tools",
	"--export",
]);
const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["--resume", "-r", "--session", "--list-models"]);
const WORKTREE_VALUE_FLAGS: ReadonlySet<string> = new Set(["--worktree", "-w"]);

export interface ParsedThinkingArgument {
	effort: Effort;
	nextIndex: number;
}

function parseThinkingEffort(rawEffort: string): Effort {
	const effort = EFFORT_BY_NAME.get(rawEffort);
	if (effort === undefined) {
		throw new CliParseError(`Invalid --thinking effort "${rawEffort}". Valid values: ${THINKING_EFFORTS.join(", ")}`);
	}
	return effort;
}

export function parseThinkingArgumentAt(args: readonly string[], index: number): ParsedThinkingArgument | undefined {
	const arg = args[index];
	if (arg === THINKING_FLAG) {
		const rawEffort = args[index + 1];
		if (!rawEffort || rawEffort.startsWith("-")) {
			throw new CliParseError("--thinking requires <effort>");
		}
		return { effort: parseThinkingEffort(rawEffort), nextIndex: index + 1 };
	}

	if (arg?.startsWith(THINKING_EQUALS_PREFIX)) {
		const rawEffort = arg.slice(THINKING_EQUALS_PREFIX.length);
		if (!rawEffort) {
			throw new CliParseError("--thinking requires <effort>");
		}
		return { effort: parseThinkingEffort(rawEffort), nextIndex: index };
	}

	return undefined;
}

export function isStartupSlashCommandArg(arg: string | undefined): boolean {
	return (
		arg === "/provider" ||
		arg?.startsWith("/provider:") === true ||
		arg === "/provicer" ||
		arg?.startsWith("/provicer:") === true
	);
}

export function findLaunchArgumentEndIndex(args: readonly string[], index: number): number {
	const arg = args[index];
	const next = args[index + 1];
	if (arg === THINKING_FLAG) {
		return next && !next.startsWith("-") ? index + 1 : index;
	}
	if (arg && REQUIRED_VALUE_FLAGS.has(arg)) {
		return next === undefined ? index : index + 1;
	}
	if (arg && WORKTREE_VALUE_FLAGS.has(arg) && next && !next.startsWith("-") && !isStartupSlashCommandArg(next)) {
		return index + 1;
	}
	if (arg && OPTIONAL_VALUE_FLAGS.has(arg) && next && !next.startsWith("-")) {
		if (arg !== "--list-models" || !next.startsWith("@")) return index + 1;
	}
	return index;
}

export function findStartupSlashCommandIndex(args: readonly string[]): number | undefined {
	const options = splitArgvAtDelimiter(args).beforeDelimiter;
	for (let index = 0; index < options.length; index++) {
		const arg = options[index];
		if (isStartupSlashCommandArg(arg)) return index;
		index = findLaunchArgumentEndIndex(options, index);
	}
	return undefined;
}

export function getLaunchOptionArguments(args: readonly string[]): string[] {
	const options = splitArgvAtDelimiter(args).beforeDelimiter;
	const slashCommandIndex = findStartupSlashCommandIndex(options);
	return slashCommandIndex === undefined ? options : options.slice(0, slashCommandIndex);
}

export function findLaunchFlagIndex(args: readonly string[], flags: readonly string[]): number | undefined {
	const options = getLaunchOptionArguments(args);
	for (let index = 0; index < options.length; index++) {
		const arg = options[index];
		if (arg && flags.includes(arg)) return index;
		index = findLaunchArgumentEndIndex(options, index);
	}
	return undefined;
}

export function validateThinkingArguments(args: readonly string[]): void {
	const options = getLaunchOptionArguments(args);
	for (let index = 0; index < options.length; index++) {
		const thinkingArgument = parseThinkingArgumentAt(options, index);
		if (thinkingArgument) {
			index = thinkingArgument.nextIndex;
			continue;
		}
		index = findLaunchArgumentEndIndex(options, index);
	}
}
