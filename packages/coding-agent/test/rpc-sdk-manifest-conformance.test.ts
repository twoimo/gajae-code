import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	RPC_CANCELLATION_COMMANDS,
	RPC_SAFE_READ_CONTROL_COMMANDS,
	isFastLaneRpcCommand,
} from "../src/modes/rpc/rpc-mode";
import { RPC_COMMAND_TYPES, scopeForRpcCommand } from "../src/modes/shared/agent-wire/scopes";

// Cross-language conformance: the generated command-classification manifest that
// crates/gjc-rpc-sdk embeds (include_str!) MUST stay faithful to the authoritative
// TS sources (scopes.ts + rpc-mode.ts). This is the TS half of the single-source-of-
// truth guarantee; the Rust generator's `--check` is the Rust half.

interface ManifestEntry {
	command: string;
	bridgeScope: string;
	lane: "fast_lane_cancellation" | "fast_lane_safe_read" | "ordered";
}
interface Manifest {
	commandCount: number;
	commands: ManifestEntry[];
	unclassified: string[];
}

const MANIFEST_PATH = join(import.meta.dir, "..", "..", "..", "docs", "rpc-sdk", "command-classification-manifest.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

function expectedLane(command: string): ManifestEntry["lane"] {
	if (RPC_CANCELLATION_COMMANDS.has(command as never)) return "fast_lane_cancellation";
	if (RPC_SAFE_READ_CONTROL_COMMANDS.has(command as never)) return "fast_lane_safe_read";
	return "ordered";
}

describe("rpc-sdk command-classification manifest conformance", () => {
	test("manifest command set equals RPC_COMMAND_TYPES exactly", () => {
		const manifestCommands = new Set(manifest.commands.map(c => c.command));
		const tsCommands = new Set<string>(RPC_COMMAND_TYPES);
		expect(manifest.unclassified).toEqual([]);
		expect(manifest.commandCount).toBe(RPC_COMMAND_TYPES.length);
		expect([...manifestCommands].sort()).toEqual([...tsCommands].sort());
	});

	test("each manifest entry's bridgeScope matches scopeForRpcCommand", () => {
		for (const entry of manifest.commands) {
			expect(entry.bridgeScope).toBe(scopeForRpcCommand(entry.command as never));
		}
	});

	test("each manifest lane matches the TS fast-lane classification", () => {
		for (const entry of manifest.commands) {
			expect(entry.lane).toBe(expectedLane(entry.command));
			const isFast = entry.lane !== "ordered";
			expect(isFast).toBe(isFastLaneRpcCommand(entry.command as never));
		}
	});

	test("exactly the documented fast-lane membership (3 cancellation + 8 safe-read)", () => {
		const byLane = (lane: ManifestEntry["lane"]) => manifest.commands.filter(c => c.lane === lane).length;
		expect(byLane("fast_lane_cancellation")).toBe(3);
		expect(byLane("fast_lane_safe_read")).toBe(8);
		expect(byLane("ordered")).toBe(manifest.commandCount - 11);
	});
});
