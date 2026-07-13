#!/usr/bin/env bun

/**
 * Static verification for the generated gajae-code plugin bundles.
 *
 * Asserts the security and contract invariants the host bundles must hold:
 * - the three delegate tools exist in the coordinator contract;
 * - committed files exactly match the renderer output, including no unexpected installable files;
 * - the nested plugin layout matches the verified Claude + Codex shapes;
 * - generated MCP config is fail-closed (WORKDIR_ROOTS, no invalid ROOTS, no MUTATIONS);
 * - the Codex .mcp.json file uses a Codex-accepted shape (mcp_servers wrapper or
 *   a direct server map), while manifests keep the camelCase `mcpServers` field
 *   per the official Codex plugin docs.
 * - every generated installable file uses the exact Coordinator MCP command and omits
 *   tmux machine ingress.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES } from "../packages/coding-agent/src/coordinator/contract";
import { findUnexpectedPluginFiles, renderPluginFiles } from "./generate-gjc-plugins";

const PLUGIN_DIR = "gajae-code";

interface GateResult {
	name: string;
	ok: boolean;
	detail: string;
}

const results: GateResult[] = [];
function gate(name: string, ok: boolean, detail: string): void {
	results.push({ name, ok, detail });
}

const files = renderPluginFiles();
function read(rel: string): string {
	return files.get(rel) ?? "";
}
function readJson(rel: string): Record<string, unknown> {
	return JSON.parse(read(rel) || "{}") as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function coordinatorMcpServer(config: Record<string, unknown>): Record<string, unknown> | undefined {
	const servers = record(config.mcpServers) ?? record(config.mcp_servers) ?? config;
	return record(servers["gjc-coordinator"]);
}

function hasCanonicalCoordinatorMcpCommand(server: Record<string, unknown> | undefined): boolean {
	return (
		server?.command === "gjc" &&
		Array.isArray(server.args) &&
		server.args.length === 2 &&
		server.args[0] === "mcp-serve" &&
		server.args[1] === "coordinator"
	);
}

const delegateTools = COORDINATOR_MCP_TOOL_NAMES.filter(name => name.startsWith("gjc_delegate_"));
const delegateToolSet = new Set<string>(delegateTools);
gate(
	"delegate tools in contract",
	delegateTools.length === 3 &&
		["gjc_delegate_plan", "gjc_delegate_execute", "gjc_delegate_team"].every(tool =>
			delegateToolSet.has(tool),
		),
	`found: ${delegateTools.join(", ") || "none"}`,
);

// The generator's --check enforces byte-for-byte content and the complete file set;
// this verifier independently rejects unexpected on-disk installable files.

// Required nested layout (verified installable on Claude Code + Codex CLI 0.139.0).
const claudeManifest = path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
const codexManifest = path.join(PLUGIN_DIR, ".codex-plugin", "plugin.json");
const claudeMcp = path.join(PLUGIN_DIR, ".mcp.json");
const codexMcp = path.join(PLUGIN_DIR, ".codex.mcp.json");
const skill = path.join(PLUGIN_DIR, "skills", "gjc-delegation", "SKILL.md");
const codexMarketplace = path.join(".agents", "plugins", "marketplace.json");
const claudeMarketplace = path.join(".claude-plugin", "marketplace.json");
const unexpectedPluginFiles = findUnexpectedPluginFiles(files);
gate(
	"no unexpected installable plugin files",
	unexpectedPluginFiles.length === 0,
	unexpectedPluginFiles.join(", ") || "none",
);

gate(
	"nested plugin layout present",
[claudeManifest, codexManifest, claudeMcp, codexMcp, skill].every(rel => files.has(rel)),
	`plugin folder ./${PLUGIN_DIR}/`,
);
gate(
	"repo marketplaces present at documented paths",
	files.has(codexMarketplace) && files.has(claudeMarketplace),
	`${codexMarketplace}, ${claudeMarketplace}`,
);

// Marketplace sources point at the plugin folder and stay inside the root.
const codexMkt = readJson(codexMarketplace) as {
	plugins?: Array<{ source?: { source?: string; path?: string }; policy?: Record<string, unknown>; category?: string }>;
};
const codexEntry = codexMkt.plugins?.[0];
gate(
	"Codex marketplace uses local source shape",
	codexEntry?.source?.source === "local" &&
		codexEntry.source.path === `./${PLUGIN_DIR}` &&
		!!codexEntry.policy?.installation &&
		!!codexEntry.policy?.authentication &&
		!!codexEntry.category,
	JSON.stringify(codexEntry?.source ?? null),
);
const claudeMkt = readJson(claudeMarketplace) as { plugins?: Array<{ source?: unknown }> };
const claudeSources = claudeMkt.plugins?.map(p => p.source) ?? [];
gate(
	"Claude marketplace source stays inside root",
	claudeSources.length > 0 &&
		claudeSources.every(s => typeof s === "string" && s === `./${PLUGIN_DIR}` && !s.includes("..")),
	claudeSources.map(s => JSON.stringify(s)).join(", ") || "none",
);

// Manifests use the documented camelCase `mcpServers` field.
const codexManifestObj = readJson(codexManifest);
gate(
	"Codex manifest uses mcpServers field",
	codexManifestObj.mcpServers === "./.codex.mcp.json" && !("mcp_servers" in codexManifestObj),
	Object.keys(codexManifestObj).join(", "),
);

// The Codex .mcp.json FILE uses a Codex-accepted shape: mcp_servers wrapper or a
// direct server map. The Claude .mcp.json FILE uses the mcpServers wrapper.
const codexMcpObj = readJson(codexMcp);
const codexMcpOk = "mcp_servers" in codexMcpObj || "gjc-coordinator" in codexMcpObj;
gate("Codex .mcp.json uses mcp_servers or direct map", codexMcpOk && !("mcpServers" in codexMcpObj), Object.keys(codexMcpObj).join(", "));
const claudeMcpObj = readJson(claudeMcp);
gate("Claude .mcp.json uses mcpServers wrapper", "mcpServers" in claudeMcpObj, Object.keys(claudeMcpObj).join(", "));
const coordinatorMcpServers = [claudeMcpObj, codexMcpObj].map(coordinatorMcpServer);
gate(
	"coordinator MCP uses the exact shipped command and args",
	coordinatorMcpServers.every(hasCanonicalCoordinatorMcpCommand),
	JSON.stringify(coordinatorMcpServers.map(server => ({ command: server?.command, args: server?.args }))),
);

// Fail-closed env invariants across every generated .mcp.json.
const mcpFiles = [...files.keys()].filter(rel => rel.endsWith(".mcp.json"));
let workdirRootsOk = true;
let noBadRoots = true;
let noMutations = true;
for (const rel of mcpFiles) {
	const text = read(rel);
	if (!text.includes("GJC_COORDINATOR_MCP_WORKDIR_ROOTS")) workdirRootsOk = false;
	if (/GJC_COORDINATOR_MCP_ROOTS[^_]/.test(text)) noBadRoots = false;
	if (text.includes("GJC_COORDINATOR_MCP_MUTATIONS")) noMutations = false;
}
gate("MCP config uses WORKDIR_ROOTS", mcpFiles.length > 0 && workdirRootsOk, `mcp files: ${mcpFiles.length}`);
gate("MCP config omits invalid ROOTS var", noBadRoots, "no GJC_COORDINATOR_MCP_ROOTS present");
gate("MCP config omits MUTATIONS by default", noMutations, "fail-closed: mutations off until opt-in");

// Command/skill docs reference the delegate tools.
let docsReferenceTools = true;
for (const tool of delegateTools) {
	const referenced = [...files].some(([rel, text]) => rel.endsWith(".md") && text.includes(tool));
	if (!referenced) docsReferenceTools = false;
}
gate("docs reference delegate tools", docsReferenceTools, "command/skill docs mention each delegate tool");

function normalizeShellContinuations(contents: string): string {
	return contents.replace(/\\\r?\n[ \t]*/g, " ");
}

const machineTmuxRoutePattern =
	/(?:\b(?:capture-pane|pipe-pane)\b|\[\s*["'](?:capture|pipe)["']\s*,\s*["']pane["']\s*\]\.join\(\s*["']-["']\s*\)|\btmux\s+(?:watch|load-buffer|paste-buffer|send-keys)\b|(?:scripts\/)?gjc-session\/(?:prompt|tail|watch)(?:\.sh)?\b|\bgjc-session\s+(?:prompt|tail|watch)\b|(?:\.\/)?(?:scripts\/)?gjc-session\/create\.sh(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)){3}|\bgjc-session\s+create(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)){3})/g;
const installableMachineRouteReferences = [...files].flatMap(([rel, text]) => {
	const normalizedText = normalizeShellContinuations(text);
	return [...normalizedText.matchAll(machineTmuxRoutePattern)].map(match => `${rel}:${match[0]}`);
});
const machineTmuxRouteRegressionFixtures = [
	"tmux pipe-pane -t owner 'sink'",
	'"$TMUX_BIN" pipe-pane -t owner "sink"',
	"$TMUX_BIN \\\n  pipe-pane -t owner sink",
	'$TMUX_BIN capture-pane -p -t owner',
	'["capture", "pane"].join("-")',
	'["pipe", "pane"].join("-")',
	'./scripts/gjc-session/create.sh bot /repo --print "task"',
	"scripts/gjc-session/create.sh bot /repo positional-prompt",
	"gjc-session create bot /repo --file task.md",
	"gjc-session create bot /repo resume",
	"gjc-session create bot /repo \\\n  positional-prompt",
];
const uncoveredMachineTmuxRoutes = machineTmuxRouteRegressionFixtures.filter(
	fixture => !new RegExp(machineTmuxRoutePattern.source).test(normalizeShellContinuations(fixture)),
);
gate(
	"tmux machine-ingress matcher covers regression fixtures",
	uncoveredMachineTmuxRoutes.length === 0,
	uncoveredMachineTmuxRoutes.join(", ") || "all covered",
);
gate(
	"all generated installable files omit tmux machine ingress",
	installableMachineRouteReferences.length === 0,
	installableMachineRouteReferences.join(", ") || "none",
);

let failures = 0;
for (const result of results) {
	process.stdout.write(`[${result.ok ? "PASS" : "FAIL"}] ${result.name} — ${result.detail}\n`);
	if (!result.ok) failures++;
}
if (failures > 0) {
	process.stderr.write(`\n${failures} plugin gate(s) failed.\n`);
	process.exit(1);
}
process.stdout.write(`\nAll ${results.length} plugin gates passed.\n`);
