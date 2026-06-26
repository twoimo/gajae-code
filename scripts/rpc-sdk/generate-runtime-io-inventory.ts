/**
 * Phase 1 runtime_io_inventory generator for the unified RPC SDK.
 *
 * Enumerates the COMPLETE runtime I/O surface the unified GjcFrame must carry,
 * so later phases (Phase 5 conformance) can assert fixture coverage == inventory
 * exactly. Sources, in order of authority:
 *
 *   - commands:            RPC_COMMAND_TYPES (scopes.ts)              [runtime-derived]
 *   - agent events:        AGENT_WIRE_EVENT_TYPES (event-contract.ts) [runtime-derived]
 *   - frame types:         AgentWireFrameType union (event-contract.ts)
 *   - notification msgs:   ServerMessage / ClientMessage (crates/gjc-notifications/src/protocol.rs)
 *
 * The command and agent-event sets are imported at runtime so they cannot drift.
 * The frame-type and notification sets are mirrored from the cited sources and
 * carry a `source` pointer; Phase 5 upgrades these to a generated equality gate
 * against the Rust enums. `--check` fails CI if the generated file is stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_WIRE_EVENT_TYPES } from "../../packages/coding-agent/src/modes/shared/agent-wire/event-contract";
import { RPC_COMMAND_TYPES } from "../../packages/coding-agent/src/modes/shared/agent-wire/scopes";

// Mirrored from event-contract.ts `AgentWireFrameType` (no runtime array exists).
const FRAME_TYPES = [
	"ready",
	"event",
	"response",
	"ui_request",
	"permission_request",
	"host_tool_call",
	"host_uri_request",
	"reset",
	"workflow_gate",
	"error",
] as const;

// Mirrored from crates/gjc-notifications/src/protocol.rs `ServerMessage`.
const NOTIFICATION_SERVER_MESSAGES = [
	"action_needed",
	"action_resolved",
	"reply_rejected",
	"identity_header",
	"context_update",
	"turn_stream",
	"image_attachment",
	"file_attachment",
	"config_update",
	"hello",
	"activity",
	"inbound_ack",
	"pong",
] as const;

// Mirrored from crates/gjc-notifications/src/protocol.rs `ClientMessage`.
const NOTIFICATION_CLIENT_MESSAGES = ["reply", "hello", "user_message", "config_command", "ping"] as const;

interface InventorySection {
	name: string;
	source: string;
	derivedAtRuntime: boolean;
	count: number;
	items: string[];
}

interface RuntimeIoInventory {
	schemaVersion: 1;
	kind: "rpc-sdk-runtime-io-inventory";
	protocolVersion: 1;
	sections: InventorySection[];
	totalItems: number;
}

export function buildInventory(): RuntimeIoInventory {
	const sections: InventorySection[] = [
		{
			name: "commands",
			source: "packages/coding-agent/src/modes/shared/agent-wire/scopes.ts",
			derivedAtRuntime: true,
			count: RPC_COMMAND_TYPES.length,
			items: [...RPC_COMMAND_TYPES].sort(),
		},
		{
			name: "agent_events",
			source: "packages/coding-agent/src/modes/shared/agent-wire/event-contract.ts",
			derivedAtRuntime: true,
			count: AGENT_WIRE_EVENT_TYPES.length,
			items: [...AGENT_WIRE_EVENT_TYPES].sort(),
		},
		{
			name: "frame_types",
			source: "packages/coding-agent/src/modes/shared/agent-wire/event-contract.ts (AgentWireFrameType)",
			derivedAtRuntime: false,
			count: FRAME_TYPES.length,
			items: [...FRAME_TYPES].sort(),
		},
		{
			name: "notification_server_messages",
			source: "crates/gjc-notifications/src/protocol.rs (ServerMessage)",
			derivedAtRuntime: false,
			count: NOTIFICATION_SERVER_MESSAGES.length,
			items: [...NOTIFICATION_SERVER_MESSAGES].sort(),
		},
		{
			name: "notification_client_messages",
			source: "crates/gjc-notifications/src/protocol.rs (ClientMessage)",
			derivedAtRuntime: false,
			count: NOTIFICATION_CLIENT_MESSAGES.length,
			items: [...NOTIFICATION_CLIENT_MESSAGES].sort(),
		},
	];
	const totalItems = sections.reduce((sum, s) => sum + s.count, 0);
	for (const s of sections) {
		if (s.count === 0) throw new Error(`inventory section "${s.name}" is empty; source ${s.source} may have moved`);
		if (new Set(s.items).size !== s.items.length) throw new Error(`inventory section "${s.name}" has duplicates`);
	}
	return { schemaVersion: 1, kind: "rpc-sdk-runtime-io-inventory", protocolVersion: 1, sections, totalItems };
}

const OUT_PATH = join(import.meta.dir, "..", "..", "docs", "rpc-sdk", "runtime-io-inventory.json");

function render(inv: RuntimeIoInventory): string {
	return `${JSON.stringify(inv, null, 2)}\n`;
}

function main(): void {
	const inv = buildInventory();
	const next = render(inv);
	if (process.argv.includes("--check")) {
		let current = "";
		try {
			current = readFileSync(OUT_PATH, "utf8");
		} catch {
			console.error(`FAIL: inventory missing at ${OUT_PATH}; run without --check to generate.`);
			process.exit(1);
		}
		if (current !== next) {
			console.error("FAIL: runtime_io_inventory out of sync with sources; regenerate.");
			process.exit(1);
		}
		console.log(`OK: runtime_io_inventory in sync (${inv.totalItems} items across ${inv.sections.length} sections)`);
		return;
	}
	writeFileSync(OUT_PATH, next);
	console.log(`OK: wrote ${inv.totalItems} items across ${inv.sections.length} sections to docs/rpc-sdk/runtime-io-inventory.json`);
}

if (import.meta.main) {
	main();
}
