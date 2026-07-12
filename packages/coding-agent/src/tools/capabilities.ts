import type { AgentTool } from "@gajae-code/agent-core";

export type ToolProvenance = "builtin" | "discovered" | "mcp" | "plugin";
export type ToolEffect = "none" | "read" | "write" | "delete" | "unknown";
export type ToolExecution = "none" | "sandboxed" | "process" | "arbitrary" | "unknown";

export interface ToolOperationCapability {
	filesystem: ToolEffect;
	external: ToolEffect;
	execution: ToolExecution;
	destructive?: boolean;
	interactive?: boolean;
}

export type TrustedToolOperationClassifier = (args: unknown) => ToolOperationCapability;

export interface ToolCapabilityDescriptor {
	provenance: ToolProvenance;
	filesystem: ToolEffect;
	external: ToolEffect;
	execution: ToolExecution;
	destructive: boolean;
	interactive: boolean;
	classifyOperation?: TrustedToolOperationClassifier;
}

export interface ToolCapabilityRegistration {
	readonly provenance: ToolProvenance;
	readonly descriptor: ToolCapabilityDescriptor;
	readonly version: 1;
}

const effectRank: Record<ToolEffect, number> = { none: 0, read: 1, write: 2, delete: 3, unknown: 4 };
const executionRank: Record<ToolExecution, number> = { none: 0, sandboxed: 1, process: 2, arbitrary: 3, unknown: 4 };

function maxEffect(a: ToolEffect, b: ToolEffect): ToolEffect {
	return effectRank[a] >= effectRank[b] ? a : b;
}
function maxExecution(a: ToolExecution, b: ToolExecution): ToolExecution {
	return executionRank[a] >= executionRank[b] ? a : b;
}

export function classifyToolOperation(capability: ToolCapabilityDescriptor, args: unknown): ToolCapabilityDescriptor {
	const operation = capability.classifyOperation?.(args);
	if (!operation) return capability;
	return {
		...capability,
		filesystem: maxEffect(capability.filesystem, operation.filesystem),
		external: maxEffect(capability.external, operation.external),
		execution: maxExecution(capability.execution, operation.execution),
		destructive: capability.destructive || operation.destructive === true,
		interactive: capability.interactive || operation.interactive === true,
	};
}

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const total = (
	filesystem: ToolEffect = "none",
	external: ToolEffect = "none",
	execution: ToolExecution = "none",
	overrides: Pick<ToolOperationCapability, "destructive" | "interactive"> = {},
): ToolOperationCapability => ({ filesystem, external, execution, ...overrides });
const unknownOperation = (): ToolOperationCapability => total("unknown", "unknown", "unknown");

const READ_ONLY_SHELL_COMMANDS = new Set(["ls", "cat", "head", "tail", "pwd", "printf", "echo", "rg", "wc", "which"]);
const READ_ONLY_GIT_COMMANDS = new Set(["status", "log", "diff", "show"]);
// Ripgrep options that spawn external processes (preprocessors, hostname
// resolution, decompression binaries). Reject separated, `=`-joined long
// forms, and short bundles containing `z`.
const RG_PROCESS_SPAWNING_LONG_OPTIONS = ["--pre", "--pre-glob", "--hostname-bin", "--search-zip"];
function isProcessSpawningRgOption(word: string): boolean {
	if (word.startsWith("--")) {
		return RG_PROCESS_SPAWNING_LONG_OPTIONS.some(option => word === option || word.startsWith(`${option}=`));
	}
	// Short options: `-z` alone or bundled (e.g. `-iz`). Stop at `-` (stdin) and `--`.
	return word.length > 1 && word.startsWith("-") && word.includes("z");
}
// Positive grammar for git options: only explicitly proven read-only display
// options are allowed. Anything else (e.g. `--output=<file>` writes a file,
// `--ext-diff` spawns an external program) fails closed as unknown.
const SAFE_GIT_OPTIONS = new Set([
	"--short",
	"--stat",
	"--oneline",
	"--name-only",
	"--name-status",
	"--cached",
	"--staged",
	"--patch",
	"-p",
	"-s",
]);
function isSafeGitOption(word: string): boolean {
	return SAFE_GIT_OPTIONS.has(word) || /^-\d+$/.test(word) || /^-n\d+$/.test(word);
}
const bashClassifier: TrustedToolOperationClassifier = args => {
	const rawCommand = record(args).command;
	const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
	if (!command || /[;&|`$()<>\n]/.test(command)) return unknownOperation();
	// Fail closed on any quoting or escaping: POSIX quote concatenation (e.g.
	// partially quoted option fragments) cannot be classified safely without a
	// full shell lexer, so quoted commands are never proven read-only.
	if (/['"\\]/.test(command)) return unknownOperation();
	const words = command.split(/\s+/);
	const executable = words[0];
	if (READ_ONLY_SHELL_COMMANDS.has(executable)) {
		if (executable === "rg" && words.slice(1).some(isProcessSpawningRgOption)) return unknownOperation();
		return total("read");
	}
	if (executable === "git" && words[1] && READ_ONLY_GIT_COMMANDS.has(words[1])) {
		if (words.slice(2).some(word => word.startsWith("-") && !isSafeGitOption(word))) return unknownOperation();
		return total("read");
	}
	return unknownOperation();
};
const browserClassifier: TrustedToolOperationClassifier = args => {
	const action = String(record(args).action ?? record(args).op ?? "").toLowerCase();
	if (action === "act" || action === "run") return total("none", "write", "arbitrary", { interactive: true });
	if (action === "open") return total("none", "read", "process");
	if (action === "screenshot" || action === "read") return total("none", "read");
	return unknownOperation();
};
const computerClassifier: TrustedToolOperationClassifier = args => {
	const op = String(record(args).op ?? record(args).action ?? "").toLowerCase();
	return op === "screenshot" || op === "read"
		? total("none", "read")
		: total("none", "write", "none", { interactive: true });
};
const githubClassifier: TrustedToolOperationClassifier = args => {
	const op = String(record(args).op ?? "").toLowerCase();
	return op === "repo_view" || op.startsWith("search_") || op === "run_watch"
		? total("none", "read")
		: unknownOperation();
};
const cronClassifier: TrustedToolOperationClassifier = args =>
	String(record(args).op ?? "").toLowerCase() === "list" ? total("none", "read") : unknownOperation();
const jobClassifier: TrustedToolOperationClassifier = args => {
	const value = record(args);
	const keys = Object.keys(value).filter(key => value[key] !== undefined && value[key] !== false);
	return keys.length > 0 && keys.every(key => key === "list" || key === "tail")
		? total("none", "read")
		: unknownOperation();
};
const resolveClassifier: TrustedToolOperationClassifier = args => {
	const action = String(record(args).action ?? "").toLowerCase();
	if (action === "discard") return total();
	if (action === "apply") return total("write", "write", "unknown");
	return unknownOperation();
};

const descriptor = (overrides: Partial<ToolCapabilityDescriptor> = {}): ToolCapabilityDescriptor => ({
	provenance: "builtin",
	filesystem: "none",
	external: "none",
	execution: "none",
	destructive: false,
	interactive: false,
	...overrides,
});

export const BUILTIN_TOOL_CAPABILITIES: Readonly<Record<string, ToolCapabilityDescriptor>> = {
	read: descriptor({ filesystem: "read" }),
	bash: descriptor({ classifyOperation: bashClassifier }),
	edit: descriptor({ filesystem: "write" }),
	ast_grep: descriptor({ filesystem: "read" }),
	ast_edit: descriptor({ filesystem: "write" }),
	render_mermaid: descriptor(),
	ask: descriptor(),
	debug: descriptor({ execution: "process" }),
	bisect: descriptor({ execution: "process", filesystem: "write" }),
	eval: descriptor({ execution: "arbitrary" }),
	calc: descriptor(),
	ssh: descriptor({ external: "write", execution: "process" }),
	github: descriptor({ classifyOperation: githubClassifier }),
	find: descriptor({ filesystem: "read" }),
	search: descriptor({ filesystem: "read" }),
	lsp: descriptor({ filesystem: "read" }),
	browser: descriptor({ classifyOperation: browserClassifier }),
	computer: descriptor({ classifyOperation: computerClassifier }),
	checkpoint: descriptor({ filesystem: "write" }),
	rewind: descriptor({ filesystem: "write", destructive: true }),
	task: descriptor({ execution: "process" }),
	subagent: descriptor({ execution: "process" }),
	job: descriptor({ classifyOperation: jobClassifier }),
	monitor: descriptor({ execution: "process" }),
	cron: descriptor({ classifyOperation: cronClassifier }),
	recipe: descriptor({ execution: "process" }),
	irc: descriptor({ external: "write" }),
	todo_write: descriptor(),
	web_search: descriptor({ external: "read" }),
	search_tool_bm25: descriptor(),
	skill_discovery: descriptor({ filesystem: "read" }),
	telegram_send: descriptor({ external: "write" }),
	write: descriptor({ filesystem: "write" }),
	skill: descriptor(),
	goal: descriptor(),
	yield: descriptor(),
	report_finding: descriptor(),
	resolve: descriptor({ classifyOperation: resolveClassifier }),
};

const UNKNOWN: ToolCapabilityDescriptor = descriptor({
	provenance: "discovered",
	filesystem: "unknown",
	external: "unknown",
	execution: "unknown",
});
const registrations = new WeakMap<AgentTool, ToolCapabilityRegistration>();

export function registerToolCapability(tool: AgentTool, provenance: ToolProvenance, builtinName?: string): void {
	const source = provenance === "builtin" && builtinName ? BUILTIN_TOOL_CAPABILITIES[builtinName] : undefined;
	const descriptorValue = Object.freeze({ ...(source ?? UNKNOWN), provenance });
	registrations.set(tool, Object.freeze({ provenance, descriptor: descriptorValue, version: 1 }));
}

export function transferToolCapability(source: AgentTool, target: AgentTool): void {
	const registration = registrations.get(source);
	if (registration) registrations.set(target, registration);
}

export function resolveToolCapability(tool: AgentTool): ToolCapabilityDescriptor {
	return registrations.get(tool)?.descriptor ?? UNKNOWN;
}
