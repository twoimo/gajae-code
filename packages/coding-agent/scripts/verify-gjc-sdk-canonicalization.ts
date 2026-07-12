#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = process.env.GJC_SDK_CANONICALIZATION_SCAN_ROOT
	? path.resolve(process.env.GJC_SDK_CANONICALIZATION_SCAN_ROOT)
	: path.resolve(import.meta.dir, "..", "..", "..");
const scannerPath = "packages/coding-agent/scripts/verify-gjc-sdk-canonicalization.ts";
const packageManifestPath = "packages/coding-agent/package.json";
const retiredPythonRpcPackagePath = "python/gjc-rpc/";
const retiredBridgeClientPackagePattern = /^packages\/[^/]*bridge-client[^/]*\//;
const bridgeOrUnattendedImportPattern =
	/(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?|\bimport\s*\(\s*)["'][^"']*(?:bridge-client|(?:^|\/)unattended)(?:["'/]|$)/g;
const pythonUnattendedProtocolClientPattern =
	/\b(?:negotiate_unattended|UnattendedAccepted|UnattendedBudget|parse_unattended_accepted|workflow_gate_response)\b/g;
const pythonGjcRpcImportPattern = /^\s*(?:from\s+gjc_rpc(?:\.|\s)|import\s+gjc_rpc(?:\.|\s|,|$))/gm;
const modeRpcInvocationPatterns = [/--mode(?:\s+|=)["']?rpc(?:\b|["'])/g, /["']--mode["']\s*,\s*["']rpc["']/g];
const allowedRpcModeInvocationTests = new Set([
	"packages/coding-agent/test/sdk-downgrade-rollback.test.ts",
	"packages/coding-agent/test/sdk-removed-ingresses.test.ts",
]);
const retiredAgentWireSubpaths = [
	"./modes/shared/agent-wire/host-tool-bridge",
	"./modes/shared/agent-wire/host-uri-bridge",
	"./modes/shared/agent-wire/ui-request-broker",
	"./modes/shared/agent-wire/ui-result",
	"./modes/shared/agent-wire/wire-types",
] as const;
const retiredTmuxMachineBusPaths = new Set(["scripts/gjc-session/prompt.sh", "scripts/gjc-session/tail.sh"]);
const machineTmuxDocumentationPaths = new Set([
	"docs/gjc-session-clawhip-routing.md",
	"packages/coding-agent/src/setup/hermes/templates/operator-instructions.v1.md",
]);
const machineTmuxDocumentationPattern =
	/(?:scripts\/gjc-session\/(?:prompt|tail)\.sh|\b(?:load-buffer|paste-buffer|send-keys|capture-pane|pipe-pane)\b|(?:\.\/)?(?:scripts\/)?gjc-session\/create\.sh(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)){3})/g;
const tmuxMachineBusPrimitivePattern = /\b(?:load-buffer|paste-buffer|send-keys|capture-pane|pipe-pane)\b/g;
function normalizeShellContinuations(contents: string): string {
	return contents.replace(/\\\r?\n[ \t]*/g, " ");
}

function isWorkspacePackageManifest(file: string): boolean {
	return file === "package.json" || (file.startsWith("packages/") && file.endsWith("/package.json"));
}

function resolveExportTarget(exports: Record<string, unknown>, subpath: string): unknown {
	if (Object.hasOwn(exports, subpath)) return exports[subpath];
	const candidates = Object.entries(exports)
		.filter(([key]) => key.includes("*"))
		.map(([key, target]) => {
			const [prefix, suffix] = key.split("*");
			return subpath.startsWith(prefix) && subpath.endsWith(suffix) ? { key, target } : undefined;
		})
		.filter((candidate): candidate is { key: string; target: unknown } => candidate !== undefined)
		.sort((left, right) => right.key.length - left.key.length);
	return candidates[0]?.target;
}

function exportTargetStrings(target: unknown): string[] {
	if (typeof target === "string") return [target];
	if (!target || typeof target !== "object") return [];
	return Object.values(target as Record<string, unknown>).flatMap(exportTargetStrings);
}

function retiredIngressSource(file: string): boolean {
	return /\/src\/(?:modes\/(?:rpc|bridge|unattended)(?:\/|$)|(?:rpc|bridge|unattended)(?:\/|\.[cm]?[jt]sx?$))/.test(
		file,
	);
}

function broadExportReachesSource(
	exports: Record<string, unknown>,
	exportPath: string,
	target: unknown,
	sourcePath: string,
): boolean {
	for (const targetPath of exportTargetStrings(target)) {
		if (!targetPath.includes("*")) continue;
		const [prefix, suffix] = targetPath.split("*");
		if (!sourcePath.startsWith(prefix) || !sourcePath.endsWith(suffix)) continue;
		const wildcard = sourcePath.slice(prefix.length, sourcePath.length - suffix.length);
		const resolved = resolveExportTarget(exports, exportPath.replace("*", wildcard));
		if (exportTargetStrings(resolved).length > 0) return true;
	}
	return false;
}

function isPython(file: string): boolean {
	return file.endsWith(".py");
}

function isPythonDistributionMetadata(file: string): boolean {
	return /(?:^|\/)(?:pyproject\.toml|setup\.(?:py|cfg)|requirements(?:[-._][^/]*)?\.txt)$/.test(file);
}

function isPackageMetadata(file: string): boolean {
	return file.endsWith("package.json") || isPythonDistributionMetadata(file);
}

function isGeneratedDocumentationIndex(file: string): boolean {
	return file === "packages/coding-agent/src/internal-urls/docs-index.generated.ts";
}

function isHistoricalLegacyPythonRpcArtifact(file: string): boolean {
	return (
		file.startsWith("artifacts/") ||
		file.startsWith("issues/") ||
		file.includes("/artifacts/") ||
		file.includes("/issues/") ||
		/(?:^|\/)(?:CHANGELOG|HISTORY)\.[^/]+$/i.test(file)
	);
}

function isActiveLegacyPythonRpcTarget(file: string): boolean {
	if (
		isGeneratedDocumentationIndex(file) ||
		isHistoricalLegacyPythonRpcArtifact(file) ||
		/(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/.test(file)
	)
		return false;
	if (isPackageMetadata(file)) return true;
	return (
		file.startsWith("src/") ||
		file.startsWith("scripts/") ||
		/^(?:packages|python)\/[^/]+\/(?:src|scripts)\//.test(file)
	);
}

function legacyPythonRpcViolations(file: string, contents: string): string[] {
	const violations: string[] = [];
	if (isPython(file)) {
		for (const match of contents.matchAll(pythonGjcRpcImportPattern)) {
			violations.push(`${file}:${lineNumber(contents, match.index ?? 0)}: imports removed gjc_rpc Python client`);
		}
		for (const match of contents.matchAll(pythonUnattendedProtocolClientPattern)) {
			violations.push(
				`${file}:${lineNumber(contents, match.index ?? 0)}: uses removed Python unattended protocol client ${match[0]}`,
			);
		}
	}
	if (isPythonDistributionMetadata(file)) {
		for (const match of contents.matchAll(/\bgjc-rpc\b/gi)) {
			violations.push(
				`${file}:${lineNumber(contents, match.index ?? 0)}: declares removed gjc-rpc distribution metadata`,
			);
		}
	}
	return violations;
}

function isExecutableSource(file: string): boolean {
	return /\.(?:[cm]?[jt]sx?|py)$/.test(file);
}

function rpcModeInvocationViolations(file: string, contents: string): string[] {
	if (isGeneratedDocumentationIndex(file) || !isExecutableSource(file) || allowedRpcModeInvocationTests.has(file))
		return [];
	return modeRpcInvocationPatterns.flatMap(pattern =>
		[...contents.matchAll(pattern)].map(
			match => `${file}:${lineNumber(contents, match.index ?? 0)}: invokes removed --mode rpc`,
		),
	);
}

function bridgeClientPackageMetadataViolation(file: string, contents: string): string | undefined {
	if (!file.endsWith("package.json")) return undefined;
	try {
		const manifest = JSON.parse(contents) as { name?: unknown };
		if (isWorkspacePackageManifest(file) && manifest.name === "@gajae-code/bridge-client") {
			return `${file}: uses retired bridge-client package identity`;
		}
	} catch {
		return undefined;
	}
	return /["']@gajae-code\/bridge-client["']\s*:/.test(contents)
		? `${file}: declares removed bridge-client package metadata`
		: undefined;
}

// These are the only server owners permitted to couple a listener to session/control internals.
const sanctionedServerHosts = new Map<string, string>([
	[
		"packages/coding-agent/src/sdk/bus/index.ts",
		"NotificationServer is the SDK-owned notification host and wires the sanctioned SDK control surface.",
	],
	[
		"packages/coding-agent/src/sdk/broker/transport.ts",
		"BrokerTransport is the SDK-owned broker WebSocket transport.",
	],
	[
		"packages/coding-agent/src/harness-control-plane/control-endpoint.ts",
		"ControlServer owns a private owner-local Unix socket; it is not an external session server.",
	],
]);

function commandOutput(command: string[]): string {
	const result = Bun.spawnSync(command, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
	return new TextDecoder().decode(result.stdout);
}

function isSource(file: string): boolean {
	return /\.(?:[cm]?[jt]sx?|json|py|toml)$/.test(file);
}

const sanctionedTmuxPaths = new Map<string, string>([
	[
		"packages/coding-agent/src/gjc-runtime/team-runtime.ts",
		"Team runtime owns worker process startup and its controlled worker-pane input.",
	],
	[
		"packages/coding-agent/src/modes/tmux-scroll.ts",
		"Tmux scroll mode controls the current terminal viewport through copy-mode; it never delivers a session prompt.",
	],
	[
		"packages/coding-agent/test/gjc-runtime/team-runtime.test.ts",
		"Team runtime tests exercise sanctioned worker-pane startup commands.",
	],
	[
		"packages/coding-agent/test/modes/tmux-scroll.test.ts",
		"Tmux scroll tests exercise terminal-local copy-mode viewport controls.",
	],
]);

const coordinatorMcpRoot = "packages/coding-agent/src/coordinator-mcp/server.ts";
function isPublishedGjcSessionShellHelper(file: string): boolean {
	return file.startsWith("scripts/gjc-session/") && file.endsWith(".sh");
}

function pythonFirstArgument(contents: string, openingParen: number): { text: string; start: number } | undefined {
	let depth = 0;
	let quote: "'" | '"' | undefined;
	for (let index = openingParen + 1; index < contents.length; index++) {
		const character = contents[index];
		if (quote) {
			if (character === "\\") {
				index++;
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "(" || character === "[" || character === "{") {
			depth++;
			continue;
		}
		if (character === ")" || character === "]" || character === "}") {
			if (depth === 0 && character === ")") {
				return { text: contents.slice(openingParen + 1, index), start: openingParen + 1 };
			}
			depth--;
			continue;
		}
		if (character === "," && depth === 0) {
			return { text: contents.slice(openingParen + 1, index), start: openingParen + 1 };
		}
	}
	return undefined;
}

function tmuxCreateStartupViolations(file: string, contents: string): string[] {
	if (file !== "scripts/gjc-session/create.sh") return [];
	const violations: string[] = [];
	const violation = (offset: number, detail: string) =>
		violations.push(`${file}:${lineNumber(contents, offset)}: ${detail}`);
	const exactArityGuard =
		/^\s*\[\[\s+\$#\s+-eq\s+2\s+\]\]\s+\|\|\s+\{\s*echo\s+["']Usage:\s+\$0\s+<session-name>\s+<worktree-path>["']\s+>&2;\s+exit\s+2;\s*\}\s*$/gm;
	const arityGuards = [...contents.matchAll(exactArityGuard)];
	const twoOperandArityChecks = [...contents.matchAll(/\[\[\s+\$#\s+-eq\s+2\s+\]\]/g)];
	const arityGuard = arityGuards[0];
	const guardPrefix = arityGuard ? contents.slice(0, arityGuard.index ?? 0) : "";
	if (
		arityGuards.length !== 1 ||
		twoOperandArityChecks.length !== 1 ||
		/(?:^|[;\n])\s*(?:if|while|until|for|case|function)\b/m.test(guardPrefix) ||
		/(?:&&|\|\|)\s*(?:\\\r?\n\s*)?$/.test(guardPrefix)
	) {
		violation(arityGuard?.index ?? 0, "human-only tmux owner must have one fail-closed exact two-operand guard");
	}

	const canonicalCommand = /^\s*command\s*=\s*\[\s*os\.environ\[\s*["']GJC_SESSION_GJC_BIN["']\s*\]\s*\]\s*$/gm;
	const canonicalCommands = [...contents.matchAll(canonicalCommand)];
	const commandMutations = [
		...contents.matchAll(/\bcommand\s*(?:\[[^\]\n]*\]\s*=|\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(|\+=|=)/g),
	];
	if (
		canonicalCommands.length !== 1 ||
		commandMutations.length !== 1 ||
		commandMutations[0]?.index !== canonicalCommands[0]?.index
	) {
		violation(
			commandMutations[0]?.index ?? 0,
			"human-only tmux owner must launch exactly GJC_SESSION_GJC_BIN with zero startup arguments",
		);
	}
	const canonicalInteractivePopenAssignment =
		/^\s*child\s*=\s*subprocess\.Popen\(\s*command\s*(?:,\s*cwd\s*=\s*os\.environ\[\s*["']GJC_SESSION_WORKDIR["']\s*\])?\s*\)\s*$/;
	const pythonCommandAssignment =
		/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?=(?:\(\s*)?(?:command\b|\[\s*\*?command\b|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\s*\(\s*command\b))[^\n]*$/gm;
	for (const match of contents.matchAll(pythonCommandAssignment)) {
		if (canonicalInteractivePopenAssignment.test(match[0])) continue;
		violation(match.index ?? 0, "human-only tmux owner must not construct or wrap a non-lifecycle GJC argv");
	}

	const allowedGjcEnvironmentReferences: Array<{ start: number; end: number }> = canonicalCommands.map(match => ({
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
	const subprocessCalls = /\bsubprocess\.(Popen|run|call|check_call|check_output)\s*\(/g;
	let interactiveLaunches = 0;
	for (const match of contents.matchAll(subprocessCalls)) {
		const openingParen = (match.index ?? 0) + match[0].lastIndexOf("(");
		const argument = pythonFirstArgument(contents, openingParen);
		if (!argument) continue;
		const isInteractiveLaunch = match[1] === "Popen" && argument.text.trim() === "command";
		const isLifecycleCall =
			/^\s*\[\s*os\.environ\[\s*["']GJC_SESSION_GJC_BIN["']\s*\]\s*,\s*["']--internal-tmux-owner-isolation["']\s*\]\s*$/.test(
				argument.text,
			);
		if (isInteractiveLaunch) {
			interactiveLaunches++;
			continue;
		}
		if (isLifecycleCall) {
			allowedGjcEnvironmentReferences.push({ start: argument.start, end: argument.start + argument.text.length });
			continue;
		}
		if (/\bcommand\b|os\.environ\[\s*["']GJC_SESSION_GJC_BIN["']\s*\]/.test(argument.text)) {
			violation(
				match.index ?? 0,
				"human-only tmux owner must invoke GJC only with zero interactive argv or the exact owner-isolation lifecycle argv",
			);
		}
	}
	if (interactiveLaunches !== 1) {
		violation(0, "human-only tmux owner must launch exactly one zero-argv interactive GJC process");
	}
	for (const match of contents.matchAll(/os\.environ\[\s*["']GJC_SESSION_GJC_BIN["']\s*\]/g)) {
		const offset = match.index ?? 0;
		if (!allowedGjcEnvironmentReferences.some(range => offset >= range.start && offset < range.end)) {
			violation(offset, "human-only tmux owner must not construct or wrap a non-lifecycle GJC argv");
		}
	}

	const normalizedContents = normalizeShellContinuations(contents);
	const shellGjcInvocations =
		/(?:^|[|;&(]\s*|\btimeout\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)\s+)(["']?)\$(?:GJC_BIN|GJC_SESSION_GJC_BIN|\{(?:GJC_BIN|GJC_SESSION_GJC_BIN)\})\1([^\r\n;|&)]*)/gm;
	for (const match of normalizedContents.matchAll(shellGjcInvocations)) {
		const argumentsText = (match[2] ?? "").trim().replace(/["']$/, "");
		const isZeroArgInteractiveLaunch = argumentsText.length === 0;
		const isLifecycleCall = /^(?:["']?--internal-tmux-owner-isolation["']?)$/.test(argumentsText);
		if (!isZeroArgInteractiveLaunch && !isLifecycleCall) {
			violation(match.index ?? 0, "human-only tmux owner invokes GJC with a non-lifecycle startup argument");
		}
	}
	for (const match of contents.matchAll(/\bGJC_SESSION_FLAGS\b/g)) {
		violation(match.index ?? 0, "human-only tmux owner exposes caller-provided startup arguments");
	}
	return violations;
}

const canonicalSdkClientModule = "packages/coding-agent/src/sdk/client/client.ts";
const coordinatorDirectAuthorityPatterns = [
	/\bimport\s+(?:type\s+)?[\s\S]*?\sfrom\s*["'][^"']*(?:session\/agent-session|sdk\/session|sdk\/host\/control)["']/g,
	/\b(?:new\s+)?AgentSession\b/g,
	/\b(?:agentSession|agent_session|session)\s*\.\s*(?:prompt|promptCustomMessage|abort|abortAndPrompt|followUp|answer)\s*\(/g,
];

function isSanctionedTmuxPath(file: string): boolean {
	return sanctionedTmuxPaths.has(file);
}

function lineNumber(contents: string, offset: number): number {
	return contents.slice(0, offset).split(/\r?\n/).length;
}

const machineEntrypoints = new Map<string, string>([
	["packages/coding-agent/src/modes/acp/acp-agent.ts", "ACP"],
	["packages/coding-agent/src/commands/mcp-serve.ts", "MCP"],
	["packages/coding-agent/src/sdk/cli/session-cli.ts", "daemon session CLI"],
]);

const machineWrapperEntrypoints = new Map<string, string>([
	["packages/coding-agent/src/commands/acp.ts", "ACP command"],
	["packages/coding-agent/src/commands/daemon.ts", "daemon command"],
	["packages/coding-agent/src/commands/mcp-serve.ts", "MCP command"],
	["packages/coding-agent/src/sdk/cli/session-cli.ts", "daemon session CLI"],
]);
const rootAcpEntrypoint = "packages/coding-agent/src/main.ts";
const directMachineWrapperRoutePattern =
	/(?:\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'][^"']*(?:session\/agent-session|sdk\/session|sdk\/host\/(?:control|query)|session\/client-bridge|modes\/(?:rpc|bridge)|\/(?:rpc|bridge)(?=[-"'/.]|$)|unattended)(?:[-"'/.]|$)|\bimport\s*\(\s*["'][^"']*(?:session\/agent-session|sdk\/session|sdk\/host\/(?:control|query)|session\/client-bridge|modes\/(?:rpc|bridge)|\/(?:rpc|bridge)(?=[-"'/.]|$)|unattended)(?:[-"'/.]|$)|["'](?:rpc|bridge)(?:[-"'/.]|$)|--mode(?:\s+|=)["']?rpc(?:\b|["'])|["']--mode["']\s*,\s*["']rpc["']|\b(?:new\s+)?AgentSession\b|\b(?:agentSession|agent_session|session)\s*\.\s*(?:prompt|promptCustomMessage|abort|abortAndPrompt|followUp|answer)\s*\(|(?:Bun\.(?:spawn|spawnSync)|runner)\s*\(\s*\[[^\]]*?\b(?:tmux|tmux_command)\b)/g;

function directMachineWrapperRouteViolations(file: string, owner: string, contents: string): string[] {
	return [...contents.matchAll(directMachineWrapperRoutePattern)].map(
		match =>
			`${file}:${lineNumber(contents, match.index ?? 0)}: ${owner} wrapper bypasses SDK/ACP/Coordinator through direct session, RPC, or tmux routing (${match[0]})`,
	);
}

function rootAcpModeViolations(contents: string): string[] {
	const branch = /if\s*\(\s*mode\s*===\s*["']acp["']\s*\)\s*\{([\s\S]*?)\n\s*\}\s*else\s*\{/.exec(contents)?.[1];
	if (branch === undefined) return [`${rootAcpEntrypoint}: root --mode acp lacks an isolated ACP dispatch branch`];
	const violations: string[] = [];
	if (
		!/await\s*\(\s*deps\.runAcpMode\s*\?\?\s*\(await import\(["']\.\/modes\/acp["']\)\)\.runAcpMode\)\s*\(/.test(
			branch,
		)
	) {
		violations.push(`${rootAcpEntrypoint}: root --mode acp must dispatch only through the SDK ACP bootstrap`);
	}
	const branchOffset = contents.indexOf(branch);
	for (const match of branch.matchAll(directMachineWrapperRoutePattern)) {
		violations.push(
			`${rootAcpEntrypoint}:${lineNumber(contents, branchOffset + (match.index ?? 0))}: root --mode acp bypasses SDK ACP through direct session, RPC, or tmux routing (${match[0]})`,
		);
	}
	return violations;
}

const relativeImportPattern =
	/(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts"];

function isProductionTypeScript(file: string): boolean {
	return (
		file.startsWith("packages/coding-agent/src/") &&
		/\.(?:[cm]?tsx?)$/.test(file) &&
		!/\.(?:test|spec)\.[cm]?tsx?$/.test(file)
	);
}

function relativeImports(contents: string): string[] {
	return [...contents.matchAll(relativeImportPattern)]
		.map(match => match[1] ?? match[2])
		.filter(specifier => specifier.startsWith("."));
}

function resolveRelativeImport(importer: string, specifier: string, sourceFiles: Set<string>): string | undefined {
	const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
	const extension = path.posix.extname(resolved);
	const nodeNextSourceExtensions =
		extension === ".js" ? [".ts", ".tsx"] : extension === ".mjs" ? [".mts"] : extension === ".cjs" ? [".cts"] : [];
	const candidates = extension
		? [
				...nodeNextSourceExtensions.map(
					sourceExtension => `${resolved.slice(0, -extension.length)}${sourceExtension}`,
				),
				resolved,
			]
		: [
				...sourceExtensions.map(sourceExtension => `${resolved}${sourceExtension}`),
				...sourceExtensions.map(sourceExtension => `${resolved}/index${sourceExtension}`),
			];
	return candidates.find(candidate => sourceFiles.has(candidate));
}

function importGraphReaches(root: string, target: string, contentsByFile: Map<string, string>): boolean {
	const sourceFiles = new Set(contentsByFile.keys());
	const pending = [root];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.shift();
		if (!current || visited.has(current)) continue;
		if (current === target) return true;
		visited.add(current);
		for (const specifier of relativeImports(contentsByFile.get(current) ?? "")) {
			const resolved = resolveRelativeImport(current, specifier, sourceFiles);
			if (resolved && !visited.has(resolved)) pending.push(resolved);
		}
	}
	return false;
}

function scanPackageExports(contents: string, sourceFiles: readonly string[]): string[] {
	let manifest: { exports?: Record<string, unknown> };
	try {
		manifest = JSON.parse(contents) as { exports?: Record<string, unknown> };
	} catch (error) {
		return [
			`${packageManifestPath}: invalid package manifest: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
	if (!manifest.exports || typeof manifest.exports !== "object") return [];

	const violations: string[] = [];
	for (const [exportPath, target] of Object.entries(manifest.exports)) {
		if (target === null) continue;
		if (/^\.\/modes\/rpc(?:\/|$)/.test(exportPath)) {
			violations.push(
				`${packageManifestPath}: removed RPC mode remains externally exported as ${JSON.stringify(exportPath)}`,
			);
		}
		if (/(?:^|\/|[-_])(?:bridge|unattended)(?:\/|[-_]|$)/.test(exportPath)) {
			violations.push(
				`${packageManifestPath}: removed bridge or unattended surface remains externally exported as ${JSON.stringify(exportPath)}`,
			);
		}
	}
	for (const sourceFile of sourceFiles) {
		if (!retiredIngressSource(sourceFile)) continue;
		const sourcePath = `./${sourceFile.slice("packages/coding-agent/".length)}`;
		for (const [exportPath, target] of Object.entries(manifest.exports)) {
			if (!exportPath.includes("*")) continue;
			if (broadExportReachesSource(manifest.exports, exportPath, target, sourcePath)) {
				violations.push(
					`${packageManifestPath}: retired ingress source ${sourceFile} is reachable through broad export ${JSON.stringify(exportPath)}`,
				);
			}
		}
	}
	for (const subpath of retiredAgentWireSubpaths) {
		if (resolveExportTarget(manifest.exports, subpath) != null) {
			violations.push(
				`${packageManifestPath}: retired agent-wire surface remains externally exported as ${JSON.stringify(subpath)}`,
			);
		}
	}
	return violations;
}

function forbiddenMachineModule(file: string): string | undefined {
	if (file === "packages/coding-agent/src/modes/acp/acp-event-mapper.ts") return undefined;
	if (file === "packages/coding-agent/src/main.ts" || file === "packages/coding-agent/src/modes/interactive-mode.ts")
		return "process bootstrap/main session host";
	if (file === "packages/coding-agent/src/sdk/session.ts") return "direct session mutation module";
	if (file === "packages/coding-agent/src/session/agent-session.ts") return "AgentSession";
	if (file.startsWith("packages/coding-agent/src/runtime-mcp/")) return "MCPManager";
	if (file === "packages/coding-agent/src/extensibility/extensions/runner.ts") return "extension runner";
	if (
		file === "packages/coding-agent/src/session/client-bridge.ts" ||
		file === "packages/coding-agent/src/modes/acp/acp-client-bridge.ts"
	)
		return "direct client bridge";
	if (
		file === "packages/coding-agent/src/sdk/host/control.ts" ||
		file === "packages/coding-agent/src/sdk/host/query.ts"
	)
		return "host control/query dispatch";
	if (file.startsWith("packages/coding-agent/src/session/")) return "direct session mutation module";
	return undefined;
}

function scanMachineImportGraphs(contentsByFile: Map<string, string>): string[] {
	const sourceFiles = new Set(contentsByFile.keys());
	const violations: string[] = [];
	for (const [root, owner] of machineEntrypoints) {
		if (!sourceFiles.has(root)) continue;
		const pending = [{ file: root, chain: [root] }];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.shift();
			if (!current || visited.has(current.file)) continue;
			visited.add(current.file);
			const forbidden = current.file === root ? undefined : forbiddenMachineModule(current.file);
			if (forbidden) {
				violations.push(
					`${root}: ${owner} machine entrypoint reaches forbidden ${forbidden} via ${current.chain.join(" -> ")}`,
				);
				continue;
			}
			if (current.file === "packages/coding-agent/src/modes/acp/acp-event-mapper.ts") continue;
			for (const specifier of relativeImports(contentsByFile.get(current.file) ?? "")) {
				const target = resolveRelativeImport(current.file, specifier, sourceFiles);
				if (target && !visited.has(target)) pending.push({ file: target, chain: [...current.chain, target] });
			}
		}
	}
	return violations;
}

async function scan(): Promise<string[]> {
	const deleted = new Set(commandOutput(["git", "ls-files", "-z", "--deleted"]).split("\0").filter(Boolean));
	const files = commandOutput(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"])
		.split("\0")
		.filter(file => file && !deleted.has(file));
	const violations: string[] = [];
	const contentsByFile = new Map<string, string>();

	for (const file of files) {
		if (retiredIngressSource(file)) {
			violations.push(`${file}: retired RPC/bridge/unattended ingress source survived`);
		}
		if (retiredBridgeClientPackagePattern.test(file)) {
			violations.push(`${file}: removed bridge-client workspace package source survived`);
		}
		if (file.startsWith(retiredPythonRpcPackagePath)) {
			violations.push(`${file}: retired Python gjc-rpc package source survived`);
		}
		if (retiredTmuxMachineBusPaths.has(file)) {
			violations.push(`${file}: retired tmux machine prompt or viewing helper survived`);
		}
		if (machineTmuxDocumentationPaths.has(file)) {
			const contents = await Bun.file(path.join(repoRoot, file)).text();
			const normalizedContents = normalizeShellContinuations(contents);
			for (const match of normalizedContents.matchAll(machineTmuxDocumentationPattern)) {
				violations.push(
					`${file}:${lineNumber(normalizedContents, match.index ?? 0)}: published machine documentation directs tmux prompt or viewing access`,
				);
			}
		}
		if (isPublishedGjcSessionShellHelper(file)) {
			const contents = await Bun.file(path.join(repoRoot, file)).text();
			const normalizedContents = normalizeShellContinuations(contents);
			for (const match of normalizedContents.matchAll(tmuxMachineBusPrimitivePattern)) {
				violations.push(
					`${file}:${lineNumber(normalizedContents, match.index ?? 0)}: published shell helper performs tmux machine prompt injection or pane viewing`,
				);
			}
			violations.push(...tmuxCreateStartupViolations(file, contents));
		}
		if (file === scannerPath || !isSource(file)) continue;

		let contents: string;
		try {
			contents = await Bun.file(path.join(repoRoot, file)).text();
		} catch (error) {
			throw new Error(
				`Unable to scan tracked file ${file}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		violations.push(...rpcModeInvocationViolations(file, contents));
		if (isActiveLegacyPythonRpcTarget(file)) violations.push(...legacyPythonRpcViolations(file, contents));
		if (file === packageManifestPath) violations.push(...scanPackageExports(contents, files));
		const bridgeClientMetadataViolation = bridgeClientPackageMetadataViolation(file, contents);
		if (bridgeClientMetadataViolation) violations.push(bridgeClientMetadataViolation);
		if (isProductionTypeScript(file)) contentsByFile.set(file, contents);
		const wrapper = machineWrapperEntrypoints.get(file);
		if (wrapper) violations.push(...directMachineWrapperRouteViolations(file, wrapper, contents));
		if (file === rootAcpEntrypoint) violations.push(...rootAcpModeViolations(contents));

		for (const match of contents.matchAll(
			/(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'][^"']*modes\/(?:rpc|bridge)(?:["'/]|$)/g,
		)) {
			violations.push(
				`${file}:${lineNumber(contents, match.index ?? 0)}: imports removed modes/rpc or modes/bridge`,
			);
		}
		for (const match of contents.matchAll(bridgeOrUnattendedImportPattern)) {
			violations.push(
				`${file}:${lineNumber(contents, match.index ?? 0)}: imports removed bridge-client or unattended surface`,
			);
		}
		for (const match of contents.matchAll(/\bGJC_BRIDGE_[A-Z0-9_]*\b/g)) {
			violations.push(
				`${file}:${lineNumber(contents, match.index ?? 0)}: forbidden bridge environment reference ${match[0]}`,
			);
		}

		if (file === "packages/coding-agent/src/cli.ts") {
			const modeFlag = /mode:\s*Flags\.string\([\s\S]*?options:\s*\[([^\]]*)\]/.exec(contents);
			if (modeFlag && /["'](?:rpc|rpc-ui|bridge)["']/.test(modeFlag[1])) {
				violations.push(`${file}: --mode option retains rpc, rpc-ui, or bridge`);
			}
		}
		if (file === "packages/coding-agent/src/commands/acp.ts") {
			if (
				!/parsed\.mode\s*=\s*["']acp["']/.test(contents) ||
				!/runRootCommand\s*\(\s*parsed\s*,\s*args\s*\)/.test(contents)
			) {
				violations.push(`${file}: shipped ACP command does not dispatch through the root ACP bootstrap`);
			}
		}
		if (file === "packages/coding-agent/src/commands/daemon.ts") {
			if (!/runSdkSessionCli\s*\(/.test(contents)) {
				violations.push(`${file}: shipped daemon session command does not dispatch the SDK session CLI`);
			}
		}
		if (file === "packages/coding-agent/src/modes/acp/acp-agent.ts") {
			if (!/from\s*["'][^"']*sdk\/acp(?:\/adapter)?["']/.test(contents)) {
				violations.push(`${file}: shipped ACP entrypoint does not import the SDK ACP adapter`);
			}
			for (const match of contents.matchAll(/\brecord\.session\.(?:prompt|promptCustomMessage|abort)\s*\(/g)) {
				violations.push(
					`${file}:${lineNumber(contents, match.index ?? 0)}: shipped ACP entrypoint bypasses SDK control`,
				);
			}
		}
		if (file === "packages/coding-agent/src/commands/mcp-serve.ts") {
			if (
				!/from\s*["'][^"']*sdk\/mcp\/server["']/.test(contents) ||
				!/from\s*["'][^"']*coordinator-mcp\/server["']/.test(contents) ||
				!/runSdkMcpStdio\s*\(/.test(contents) ||
				!/runCoordinatorMcpStdio\s*\(/.test(contents)
			) {
				violations.push(`${file}: shipped MCP command does not dispatch the SDK MCP server`);
			}
		}

		const createsListener =
			/\b(?:Bun\.(?:serve|listen)|\w+\.createServer\s*\(|\w+\.listen\s*\(|new\s+NotificationServer\s*\()/.test(
				contents,
			);
		const importsSessionInternals =
			/import[\s\S]*?from\s*["'][^"']*(?:agent-session|sdk\/host\/control|session\/agent-session)["']/.test(
				contents,
			);
		if (
			createsListener &&
			importsSessionInternals &&
			file.startsWith("packages/coding-agent/src/") &&
			!sanctionedServerHosts.has(file)
		) {
			violations.push(`${file}: listener imports AgentSession or dispatch internals outside a sanctioned host`);
		}

		if (isProductionTypeScript(file) && file !== coordinatorMcpRoot) {
			for (const match of contents.matchAll(
				/(?:Bun\.(?:spawn|spawnSync)|runner)\s*\(\s*\[[^\]]*?\b(?:tmux|tmux_command)\b[^\]]*?["'](set-buffer|paste-buffer|send-keys)["']([^\n]*)/g,
			)) {
				const primitive = match[1];
				const args = match[2];
				const injectsContent =
					primitive !== "send-keys" ||
					(!/\s-X\b/.test(args) && !/^\s*[^\n]*\s(?:Escape|Enter|C-m)["']?\s*\)?;?\s*$/.test(args));
				if (injectsContent && !isSanctionedTmuxPath(file)) {
					violations.push(
						`${file}:${lineNumber(contents, match.index ?? 0)}: tmux ${primitive} content injection is outside sanctioned process lifecycle`,
					);
				}
			}
		}
		if (file === coordinatorMcpRoot) {
			for (const match of contents.matchAll(/\b(set-buffer|paste-buffer|send-keys)\b/g)) {
				violations.push(
					`${file}:${lineNumber(contents, match.index ?? 0)}: tmux ${match[1]} content injection is outside sanctioned process lifecycle`,
				);
			}
			for (const match of contents.matchAll(/\bcapture-pane\b/g)) {
				violations.push(
					`${file}:${lineNumber(contents, match.index ?? 0)}: coordinator MCP reads tmux pane content outside SDK queries`,
				);
			}
			for (const pattern of coordinatorDirectAuthorityPatterns) {
				for (const match of contents.matchAll(pattern)) {
					violations.push(
						`${file}:${lineNumber(contents, match.index ?? 0)}: coordinator MCP directly mutates AgentSession or control internals`,
					);
				}
			}
		}
	}
	violations.push(...scanMachineImportGraphs(contentsByFile));
	if (
		contentsByFile.has(coordinatorMcpRoot) &&
		!importGraphReaches(coordinatorMcpRoot, canonicalSdkClientModule, contentsByFile)
	) {
		violations.push(
			`${coordinatorMcpRoot}: coordinator MCP does not reach the canonical SDK client through its import graph`,
		);
	}
	return violations;
}

async function runSelfTestFixture(
	files: Record<string, string>,
	expectedExitCode: number,
	expectedOutput?: string,
): Promise<void> {
	const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-canonicalization-"));
	try {
		for (const [file, contents] of Object.entries(files)) {
			const destination = path.join(fixture, file);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.writeFile(destination, contents);
		}
		const init = Bun.spawnSync(["git", "init", "-q"], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
		const add = Bun.spawnSync(["git", "add", "."], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
		if (init.exitCode !== 0 || add.exitCode !== 0) throw new Error("unable to create scanner self-test fixture");
		const result = Bun.spawnSync([process.execPath, import.meta.path], {
			cwd: repoRoot,
			env: { ...process.env, GJC_SDK_CANONICALIZATION_SCAN_ROOT: fixture },
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
		if (result.exitCode !== expectedExitCode) {
			throw new Error(`self-test expected exit ${expectedExitCode}, got ${result.exitCode}: ${output}`);
		}
		if (expectedOutput && !output.includes(expectedOutput)) {
			throw new Error(`self-test expected output ${JSON.stringify(expectedOutput)}, got: ${output}`);
		}
	} finally {
		await fs.rm(fixture, { recursive: true, force: true });
	}
}

async function selfTest(): Promise<void> {
	await runSelfTestFixture(
		{ "packages/coding-agent/package.json": '{"exports":{"./modes/rpc/*":"./src/modes/rpc/*.ts"}}\n' },
		1,
		"removed RPC mode remains externally exported",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json":
				'{"exports":{"./commands/gjc-runtime-bridge":"./src/bridge.ts","./unattended":"./src/unattended.ts"}}\n',
		},
		1,
		"removed bridge or unattended surface remains externally exported",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json":
				'{"exports":{"./modes/rpc/*":null,"./commands/gjc-runtime-bridge":null,"./unattended":null,"./modes/shared/agent-wire/*":null}}\n',
		},
		0,
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json": '{"exports":{"./modes/*":{"import":"./src/modes/*.ts"}}}\n',
		},
		1,
		"retired agent-wire surface remains externally exported",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json":
				'{"exports":{"./modes/*":{"import":"./src/modes/*.ts"},"./modes/shared/agent-wire/*":null}}\n',
		},
		0,
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json": '{"exports":{"./*":"./src/*.ts"}}\n',
			"packages/coding-agent/src/unattended/legacy.ts": "export const retired = true;\n",
		},
		1,
		"retired ingress source packages/coding-agent/src/unattended/legacy.ts is reachable through broad export",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json": '{"exports":{"./*":"./src/*.ts"}}\n',
			"packages/coding-agent/src/rpc.ts": "export const retired = true;\n",
		},
		1,
		"retired ingress source packages/coding-agent/src/rpc.ts is reachable through broad export",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json": '{"exports":{"./*":"./src/*.ts"}}\n',
			"packages/coding-agent/src/bridge.ts": "export const retired = true;\n",
		},
		1,
		"retired ingress source packages/coding-agent/src/bridge.ts is reachable through broad export",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json": '{"exports":{"./*":"./src/*.ts"}}\n',
			"packages/coding-agent/src/unattended.ts": "export const retired = true;\n",
		},
		1,
		"retired ingress source packages/coding-agent/src/unattended.ts is reachable through broad export",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/package.json": '{"exports":{"./runtime-mcp/*":"./src/runtime-mcp/*.ts"}}\n',
			"packages/coding-agent/src/runtime-mcp/tool-bridge.ts": "export const neutral = true;\n",
		},
		0,
	);
	const realManifest = await Bun.file(path.join(repoRoot, packageManifestPath)).text();
	await runSelfTestFixture({ [packageManifestPath]: realManifest }, 0);
	await runSelfTestFixture(
		{ "packages/bridge-client/src/index.ts": "export const legacyBridge = true;\n" },
		1,
		"removed bridge-client workspace package source survived",
	);
	await runSelfTestFixture(
		{ "package.json": '{"catalog":{"@gajae-code/bridge-client":"0.0.0"}}\n' },
		1,
		"declares removed bridge-client package metadata",
	);
	await runSelfTestFixture(
		{ "packages/renamed-workspace/package.json": '{"name":"@gajae-code/bridge-client"}\n' },
		1,
		"uses retired bridge-client package identity",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/consumer.ts":
				'import { BridgeClient } from "@gajae-code/bridge-client";\nvoid BridgeClient;\n',
		},
		1,
		"imports removed bridge-client or unattended surface",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/consumer.ts":
				'import { legacyUnattended } from "./unattended";\nvoid legacyUnattended;\n',
		},
		1,
		"imports removed bridge-client or unattended surface",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/test/fixtures/neutral-name.ts": 'Bun.spawnSync(["gjc", "--mode", "rpc"]);\n',
		},
		1,
		"invokes removed --mode rpc",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/test/fixtures/neutral-expect.ts":
				'expect(Bun.spawnSync(["gjc", "--mode", "rpc"])).toBeDefined();\n',
		},
		1,
		"invokes removed --mode rpc",
	);
	await runSelfTestFixture({ "docs/rpc-removal.md": "The RPC compatibility fixture was removed.\n" }, 0);
	await runSelfTestFixture(
		{ "scripts/gjc-session/prompt.sh": "#!/usr/bin/env bash\n" },
		1,
		"retired tmux machine prompt or viewing helper survived",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/unsafe.sh":
				"#!/usr/bin/env bash\ntmux load-buffer -b prompt -\ntmux capture-pane -p -t session\n",
		},
		1,
		"published shell helper performs tmux machine prompt injection or pane viewing",
	);
	const canonicalCreateFixture = `#!/usr/bin/env bash
[[ $# -eq 2 ]] || { echo "Usage: $0 <session-name> <worktree-path>" >&2; exit 2; }
command = [os.environ["GJC_SESSION_GJC_BIN"]]
child = subprocess.Popen(command)
subprocess.run([os.environ["GJC_SESSION_GJC_BIN"], "--internal-tmux-owner-isolation"])
"$GJC_BIN" --internal-tmux-owner-isolation
`;
	await runSelfTestFixture({ "scripts/gjc-session/create.sh": canonicalCreateFixture }, 0);
	await runSelfTestFixture(
		{ "scripts/gjc-session/create.sh": `${canonicalCreateFixture}\nGJC_SESSION_FLAGS=unsafe\n` },
		1,
		"exposes caller-provided startup arguments",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'[[ $# -eq 2 ]] || { echo "Usage: $0 <session-name> <worktree-path>" >&2; exit 2; }',
				"[[ $# -eq 2 ]] || true",
			),
		},
		1,
		"must have one fail-closed exact two-operand guard",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'[[ $# -eq 2 ]] || { echo "Usage: $0 <session-name> <worktree-path>" >&2; exit 2; }',
				'if false; then\n[[ $# -eq 2 ]] || { echo "Usage: $0 <session-name> <worktree-path>" >&2; exit 2; }\nfi',
			),
		},
		1,
		"must have one fail-closed exact two-operand guard",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				"child = subprocess.Popen(command)",
				'command.extend(["--file", "task.md"])\nchild = subprocess.Popen(command)',
			),
		},
		1,
		"must launch exactly GJC_SESSION_GJC_BIN with zero startup arguments",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				"child = subprocess.Popen(command)",
				'command += ["--file", "task.md"]\nchild = subprocess.Popen(command)',
			),
		},
		1,
		"must launch exactly GJC_SESSION_GJC_BIN with zero startup arguments",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				"child = subprocess.Popen(command)",
				'child = subprocess.Popen(command + ["--file", "task.md"])',
			),
		},
		1,
		"must invoke GJC only with zero interactive argv or the exact owner-isolation lifecycle argv",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				"child = subprocess.Popen(command)",
				'launch = command + ["--file", "task.md"]\nchild = subprocess.Popen(launch)',
			),
		},
		1,
		"must not construct or wrap a non-lifecycle GJC argv",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": `${canonicalCreateFixture}\nlaunch = [os.environ["GJC_SESSION_GJC_BIN"], "--file", "task.md"]\nsubprocess.Popen(launch)\n`,
		},
		1,
		"must not construct or wrap a non-lifecycle GJC argv",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'[os.environ["GJC_SESSION_GJC_BIN"], "--internal-tmux-owner-isolation"]',
				'[\n  os.environ["GJC_SESSION_GJC_BIN"],\n  "--internal-tmux-owner-isolation",\n  "--file",\n  "task.md",\n]',
			),
		},
		1,
		"must invoke GJC only with zero interactive argv or the exact owner-isolation lifecycle argv",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'"$GJC_BIN" --internal-tmux-owner-isolation',
				'captured=$("$GJC_BIN" --file task.md)',
			),
		},
		1,
		"invokes GJC with a non-lifecycle startup argument",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'"$GJC_BIN" --internal-tmux-owner-isolation',
				'"$GJC_BIN" --internal-tmux-owner-isolation \\\n  --file task.md',
			),
		},
		1,
		"invokes GJC with a non-lifecycle startup argument",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'"$GJC_BIN" --internal-tmux-owner-isolation',
				'"$GJC_BIN" \\\n  --file task.md',
			),
		},
		1,
		"invokes GJC with a non-lifecycle startup argument",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'"$GJC_BIN" --internal-tmux-owner-isolation',
				'"$GJC_BIN" \\\n  session status',
			),
		},
		1,
		"invokes GJC with a non-lifecycle startup argument",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'"$GJC_BIN" --internal-tmux-owner-isolation',
				'"$GJC_BIN" \\\n  "write a prompt"',
			),
		},
		1,
		"invokes GJC with a non-lifecycle startup argument",
	);
	await runSelfTestFixture(
		{
			"scripts/gjc-session/create.sh": canonicalCreateFixture.replace(
				'"$GJC_BIN" --internal-tmux-owner-isolation',
				'"$GJC_BIN" --internal-tmux-owner-isolation \\\n  "write a prompt"',
			),
		},
		1,
		"invokes GJC with a non-lifecycle startup argument",
	);
	const realCreate = await Bun.file(path.join(repoRoot, "scripts/gjc-session/create.sh")).text();
	await runSelfTestFixture({ "scripts/gjc-session/create.sh": realCreate }, 0);
	await runSelfTestFixture(
		{ "scripts/gjc-session/watch-output.sh": "#!/usr/bin/env bash\n$TMUX_BIN \\\n  pipe-pane -t session 'sink'\n" },
		1,
		"published shell helper performs tmux machine prompt injection or pane viewing",
	);
	await runSelfTestFixture(
		{ "docs/gjc-session-clawhip-routing.md": "$TMUX_BIN \\\n  pipe-pane -t owner 'sink'\n" },
		1,
		"published machine documentation directs tmux prompt or viewing access",
	);
	await runSelfTestFixture(
		{
			"docs/gjc-session-clawhip-routing.md": './scripts/gjc-session/create.sh bot /repo \\\n  --print "task"\n',
		},
		1,
		"published machine documentation directs tmux prompt or viewing access",
	);
	await runSelfTestFixture(
		{ "scripts/gjc-session/watch-output.sh": "#!/usr/bin/env bash\ntmux pipe-pane -t session 'sink'\n" },
		1,
		"published shell helper performs tmux machine prompt injection or pane viewing",
	);
	await runSelfTestFixture(
		{ "docs/gjc-session-clawhip-routing.md": "scripts/gjc-session/tail.sh visible output\n" },
		1,
		"published machine documentation directs tmux prompt or viewing access",
	);
	await runSelfTestFixture(
		{ "docs/gjc-session-clawhip-routing.md": "tmux pipe-pane -t owner 'sink'\n" },
		1,
		"published machine documentation directs tmux prompt or viewing access",
	);
	await runSelfTestFixture(
		{ "docs/gjc-session-clawhip-routing.md": './scripts/gjc-session/create.sh bot /repo --print "task"\n' },
		1,
		"published machine documentation directs tmux prompt or viewing access",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/unsanctioned.ts": 'Bun.spawnSync(["tmux", "send-keys", "-t", "pane", "prompt"]);\n',
		},
		1,
		"tmux send-keys content injection is outside sanctioned process lifecycle",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/gjc-runtime/team-runtime.ts":
				'Bun.spawnSync(["tmux", "send-keys", "-t", "pane", "prompt"]);\n',
		},
		0,
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts":
				'import { SdkClient } from "../sdk/client/client";\nBun.spawnSync(["tmux", "paste-buffer", "-t", "pane"]);\nvoid SdkClient;\n',
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
		},
		1,
		"tmux paste-buffer content injection is outside sanctioned process lifecycle",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts":
				'import { SdkClient } from "../sdk/client/client";\nBun.spawnSync(["tmux", "set-buffer", "prompt"]);\nvoid SdkClient;\n',
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
		},
		1,
		"tmux set-buffer content injection is outside sanctioned process lifecycle",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts":
				'import { SdkClient } from "../sdk/client/client";\nBun.spawnSync(["tmux", "capture-pane", "-p"]);\nvoid SdkClient;\n',
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
		},
		1,
		"coordinator MCP reads tmux pane content outside SDK queries",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts":
				'import { SdkClient } from "../sdk/client/client";\nimport { AgentSession } from "../session/agent-session";\nconst session = {} as AgentSession;\nsession.prompt("bypass");\nvoid SdkClient;\n',
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
			"packages/coding-agent/src/session/agent-session.ts": "export class AgentSession {}\n",
		},
		1,
		"coordinator MCP directly mutates AgentSession or control internals",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts":
				'import { SdkClient } from "../sdk/client/client";\nimport { control } from "../sdk/host/control";\ncontrol({ operation: "turn.prompt" });\nvoid SdkClient;\n',
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
			"packages/coding-agent/src/sdk/host/control.ts": "export function control(): void {}\n",
		},
		1,
		"coordinator MCP directly mutates AgentSession or control internals",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts":
				'import { SdkClient } from "../sdk/client/client";\nasync function writeSessionState() { await fs.writeFile("metadata.json", "{}\\n"); }\nvoid SdkClient;\n',
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
		},
		0,
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts": "export const server = true;\n",
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
		},
		1,
		"coordinator MCP does not reach the canonical SDK client through its import graph",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/coordinator-mcp/server.ts":
				'import { SdkClient } from "../sdk/client/client";\nexport async function startProcessLifecycle() { Bun.spawn(["tmux", "new-session", "-d"]); return SdkClient; }\n',
			"packages/coding-agent/src/sdk/client/client.ts": "export class SdkClient {}\n",
		},
		0,
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/bridge-env.ts":
				"const endpoint = process.env.GJC_BRIDGE_ENDPOINT;\nvoid endpoint;\n",
		},
		1,
		"forbidden bridge environment reference GJC_BRIDGE_ENDPOINT",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/cli.ts":
				'const flags = { mode: Flags.string({ options: ["interactive", "rpc"] }) };\nvoid flags;\n',
		},
		1,
		"--mode option retains rpc, rpc-ui, or bridge",
	);
	await runSelfTestFixture(
		{ "python/gjc-rpc/src/gjc_rpc/client.py": "class RpcClient: pass\n" },
		1,
		"retired Python gjc-rpc package source survived",
	);
	await runSelfTestFixture(
		{ "python/robogjc/src/controller.py": "from gjc_rpc import RpcClient\n" },
		1,
		"imports removed gjc_rpc Python client",
	);
	await runSelfTestFixture(
		{ "scripts/legacy-controller.py": 'subprocess.run(["gjc", "--mode", "rpc"])\n' },
		1,
		"invokes removed --mode rpc",
	);
	await runSelfTestFixture(
		{ "python/robogjc/pyproject.toml": '[project]\ndependencies = ["gjc-rpc>=0.1.0"]\n' },
		1,
		"declares removed gjc-rpc distribution metadata",
	);
	await runSelfTestFixture(
		{ "python/robogjc/src/controller.py": 'client.negotiate_unattended(actor="legacy")\n' },
		1,
		"uses removed Python unattended protocol client negotiate_unattended",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/test/sdk-downgrade-rollback.test.ts":
				'const legacy = "gjc --mode rpc";\nvoid legacy;\n',
		},
		0,
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/test/sdk-removed-ingresses.test.ts":
				'const rejected = ["--mode", "rpc"];\nvoid rejected;\n',
		},
		0,
	);
	await runSelfTestFixture({ "docs/sdk-migration.md": "`--mode rpc` has been removed; use the SDK instead.\n" }, 0);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/internal-urls/docs-index.generated.ts":
				'export const docs = "--mode rpc has been removed";\n',
		},
		0,
	);
	await runSelfTestFixture({ "artifacts/closure-report.json": '{"legacy":"gjc --mode rpc"}\n' }, 0);
	await runSelfTestFixture(
		{ "packages/coding-agent/src/consumer.ts": 'import { legacyRpc } from "./modes/rpc/legacy";\nvoid legacyRpc;\n' },
		1,
		"imports removed modes/rpc or modes/bridge",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/unsanctioned-listener.ts":
				'import { AgentSession } from "./agent-session";\nBun.serve({ fetch() { return new Response("ok"); } });\nvoid AgentSession;\n',
		},
		1,
		"listener imports AgentSession or dispatch internals outside a sanctioned host",
	);
	await runSelfTestFixture(
		{ "packages/coding-agent/src/modes/rpc/zombie.ts": "export const zombie = true;\n" },
		1,
		"retired RPC/bridge/unattended ingress source survived",
	);
	await runSelfTestFixture(
		{ "packages/coding-agent/src/modes/unattended/zombie.ts": "export const zombie = true;\n" },
		1,
		"retired RPC/bridge/unattended ingress source survived",
	);
	await runSelfTestFixture(
		{ "packages/coding-agent/src/bridge/zombie.ts": "export const zombie = true;\n" },
		1,
		"retired RPC/bridge/unattended ingress source survived",
	);
	await runSelfTestFixture(
		{ "packages/coding-agent/src/unattended/zombie.ts": "export const zombie = true;\n" },
		1,
		"retired RPC/bridge/unattended ingress source survived",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/modes/acp/acp-agent.ts":
				'import { AgentSession } from "../../core/agent-session";\nconst record = {} as { session: AgentSession };\nrecord.session.prompt("bypass");\n',
		},
		1,
		"shipped ACP entrypoint does not import the SDK ACP adapter",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/commands/mcp-serve.ts":
				'import { runCoordinatorMcpServer } from "../coordinator-mcp/server";\nvoid runCoordinatorMcpServer;\n',
		},
		1,
		"shipped MCP command does not dispatch the SDK MCP server",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/modes/acp/acp-agent.ts":
				'import { AcpSdkAdapter } from "../../sdk/acp";\nimport "./harmless-wrapper";\nvoid AcpSdkAdapter;\n',
			"packages/coding-agent/src/modes/acp/harmless-wrapper.ts":
				'import { AgentSession } from "../../session/agent-session";\nvoid AgentSession;\n',
			"packages/coding-agent/src/session/agent-session.ts": "export class AgentSession {}\n",
		},
		1,
		"ACP machine entrypoint reaches forbidden AgentSession",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/commands/mcp-serve.ts":
				'import { runSdkMcpStdio } from "../sdk/mcp/server";\nimport "../harmless-wrapper";\nvoid runSdkMcpStdio;\n',
			"packages/coding-agent/src/harmless-wrapper.ts":
				'import { ClientBridge } from "./session/client-bridge";\nvoid ClientBridge;\n',
			"packages/coding-agent/src/session/client-bridge.ts": "export class ClientBridge {}\n",
		},
		1,
		"MCP machine entrypoint reaches forbidden direct client bridge",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/commands/mcp-serve.ts":
				'import { runSdkMcpStdio } from "../sdk/mcp/server.js";\nimport "../wrapper.js";\nvoid runSdkMcpStdio;\n',
			"packages/coding-agent/src/wrapper.ts":
				'import { ClientBridge } from "./session/client-bridge.js";\nvoid ClientBridge;\n',
			"packages/coding-agent/src/session/client-bridge.ts": "export class ClientBridge {}\n",
		},
		1,
		"MCP machine entrypoint reaches forbidden direct client bridge",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/modes/acp/acp-agent.ts":
				'import { AcpSdkAdapter } from "../../sdk/acp";\nimport "./adapter-wrapper";\nvoid AcpSdkAdapter;\n',
			"packages/coding-agent/src/modes/acp/adapter-wrapper.ts":
				'import { SdkClient } from "../../sdk/client";\nvoid SdkClient;\n',
			"packages/coding-agent/src/sdk/client.ts": "export class SdkClient {}\n",
		},
		0,
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/commands/acp.ts":
				'import { AgentSession } from "../session/agent-session";\nvoid AgentSession;\n',
		},
		1,
		"ACP command wrapper bypasses SDK/ACP/Coordinator through direct session, RPC, or tmux routing",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/commands/daemon.ts": 'Bun.spawn(["tmux", "new-session", "-d"]);\n',
		},
		1,
		"daemon command wrapper bypasses SDK/ACP/Coordinator through direct session, RPC, or tmux routing",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/commands/mcp-serve.ts": 'import { RpcClient } from "../rpc";\nvoid RpcClient;\n',
		},
		1,
		"MCP command wrapper bypasses SDK/ACP/Coordinator through direct session, RPC, or tmux routing",
	);
	await runSelfTestFixture(
		{
			"packages/coding-agent/src/main.ts":
				'const mode = "acp";\nif (mode === "acp") {\n const session = new AgentSession();\n session.prompt("bypass");\n} else {\n void 0;\n}\n',
		},
		1,
		"root --mode acp bypasses SDK ACP through direct session, RPC, or tmux routing",
	);
}

if (process.argv.includes("--self-test")) await selfTest();
try {
	const violations = await scan();
	if (violations.length > 0) {
		process.stderr.write(`GJC SDK canonicalization violations found:\n${violations.join("\n")}\n`);
		process.exit(1);
	}
	process.stdout.write(
		`GJC SDK canonicalization verification passed (${sanctionedServerHosts.size} sanctioned server hosts).\n`,
	);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}
