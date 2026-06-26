/**
 * Phase 0 inventory-extractor PoC for the unified RPC SDK.
 *
 * Derives the single command-classification manifest from the existing
 * authoritative sources so the future Rust + TS schedulers consume ONE
 * generated artifact instead of hand-maintained lists:
 *
 *   - command set + bridge scope: RPC_COMMAND_SCOPE_REGISTRY / scopeForRpcCommand
 *     (packages/coding-agent/src/modes/shared/agent-wire/scopes.ts)
 *   - scheduler lane (fast-lane vs ordered): RPC_CANCELLATION_COMMANDS,
 *     RPC_SAFE_READ_CONTROL_COMMANDS, isFastLaneRpcCommand
 *     (packages/coding-agent/src/modes/rpc/rpc-mode.ts:83-169)
 *
 * The manifest is the Phase 0 gate artifact: it MUST classify every current
 * RpcCommand with zero unclassified entries. CI (later phases) regenerates and
 * diffs this file; any new command without a scope or lane fails the build.
 *
 * Usage:
 *   bun run scripts/rpc-sdk/generate-command-manifest.ts            # write
 *   bun run scripts/rpc-sdk/generate-command-manifest.ts --check    # verify in sync
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	RPC_CANCELLATION_COMMANDS,
	RPC_SAFE_READ_CONTROL_COMMANDS,
	isFastLaneRpcCommand,
} from "../../packages/coding-agent/src/modes/rpc/rpc-mode";
import {
	RPC_COMMAND_TYPES,
	type RpcCommandType,
	scopeForRpcCommand,
} from "../../packages/coding-agent/src/modes/shared/agent-wire/scopes";

type Lane = "fast_lane_cancellation" | "fast_lane_safe_read" | "ordered";

interface CommandEntry {
	command: RpcCommandType;
	bridgeScope: string;
	lane: Lane;
}

interface CommandManifest {
	schemaVersion: 1;
	kind: "rpc-sdk-command-classification";
	generatedFrom: string[];
	commandCount: number;
	commands: CommandEntry[];
	unclassified: RpcCommandType[];
}

function laneFor(command: RpcCommandType): Lane {
	if (RPC_CANCELLATION_COMMANDS.has(command)) return "fast_lane_cancellation";
	if (RPC_SAFE_READ_CONTROL_COMMANDS.has(command)) return "fast_lane_safe_read";
	return "ordered";
}

export function buildManifest(): CommandManifest {
	const commands: CommandEntry[] = [];
	const unclassified: RpcCommandType[] = [];

	for (const command of [...RPC_COMMAND_TYPES].sort()) {
		const bridgeScope = scopeForRpcCommand(command);
		const lane = laneFor(command);
		// Cross-check the derived lane against the canonical predicate so a future
		// source edit that desyncs the two sets is caught here, not at runtime.
		const fastLane = lane !== "ordered";
		if (fastLane !== isFastLaneRpcCommand(command)) {
			throw new Error(
				`lane desync for "${command}": derived ${lane} but isFastLaneRpcCommand=${isFastLaneRpcCommand(command)}`,
			);
		}
		if (!bridgeScope) {
			unclassified.push(command);
			continue;
		}
		commands.push({ command, bridgeScope, lane });
	}

	return {
		schemaVersion: 1,
		kind: "rpc-sdk-command-classification",
		generatedFrom: [
			"packages/coding-agent/src/modes/shared/agent-wire/scopes.ts",
			"packages/coding-agent/src/modes/rpc/rpc-mode.ts",
		],
		commandCount: commands.length,
		commands,
		unclassified,
	};
}

const OUT_PATH = join(
	import.meta.dir,
	"..",
	"..",
	"docs",
	"rpc-sdk",
	"command-classification-manifest.json",
);

function render(manifest: CommandManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main(): void {
	const manifest = buildManifest();
	if (manifest.unclassified.length > 0) {
		console.error(
			`FAIL: ${manifest.unclassified.length} unclassified command(s): ${manifest.unclassified.join(", ")}`,
		);
		process.exit(1);
	}
	const next = render(manifest);
	const check = process.argv.includes("--check");
	if (check) {
		let current = "";
		try {
			current = readFileSync(OUT_PATH, "utf8");
		} catch {
			console.error(`FAIL: manifest missing at ${OUT_PATH}; run without --check to generate.`);
			process.exit(1);
		}
		if (current !== next) {
			console.error("FAIL: command manifest out of sync with sources; regenerate.");
			process.exit(1);
		}
		console.log(
			`OK: command manifest in sync (${manifest.commandCount} commands, sha256 ${createHash("sha256").update(next).digest("hex").slice(0, 12)})`,
		);
		return;
	}
	writeFileSync(OUT_PATH, next);
	console.log(
		`OK: wrote ${manifest.commandCount} commands to docs/rpc-sdk/command-classification-manifest.json`,
	);
}

if (import.meta.main) {
	main();
}
