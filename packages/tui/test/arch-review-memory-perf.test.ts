import { describe, expect, it } from "bun:test";
import {
	Editor,
	registerImageRetainedMemory,
	registerMarkdownRetainedMemory,
	type Terminal,
	TUI,
} from "@gajae-code/tui";
import { RetainedMemoryRegistry } from "@gajae-code/utils/retained-memory";
import { evaluateTuiRetentionGates } from "../../../scripts/measure-tui-retention";
import { TUI_RETAINED_MEMORY_CACHE_CLASSES } from "../../coding-agent/src/modes/interactive-mode";
import { defaultEditorTheme } from "./test-themes";

// retention budget evaluator
// The completeness inventory is maintained in its own section by the registry lane.
describe("TUI retained-memory budget evaluator", () => {
	it("keeps all retention thresholds inclusive", () => {
		const mib = 1024 * 1024;
		const gates = evaluateTuiRetentionGates({
			documentBytes: mib,
			undoBytes: 18 * mib,
			editP95Ms: 20,
			frameP95Ms: 16,
			frameAllocationBytes: 25,
			fullTranscriptAllocationBaselineBytes: 100,
			frameGrowthPercent: 10,
			markdownRegisteredBytes: 32 * mib,
			uniqueImageBytes: 100,
			duplicateImageOwnershipBytes: 5,
			terminalProtocolCacheBytes: 32 * mib,
		});
		expect(gates.every(gate => gate.pass)).toBe(true);
	});

	it("reports a separate failure for every over-budget pool", () => {
		const input = {
			documentBytes: 1,
			undoBytes: 19 * 1024 * 1024,
			editP95Ms: 21,
			frameP95Ms: 17,
			frameAllocationBytes: 26,
			fullTranscriptAllocationBaselineBytes: 100,
			frameGrowthPercent: 11,
			markdownRegisteredBytes: 32 * 1024 * 1024 + 1,
			uniqueImageBytes: 100,
			duplicateImageOwnershipBytes: 6,
			terminalProtocolCacheBytes: 32 * 1024 * 1024 + 1,
		};
		expect(
			evaluateTuiRetentionGates(input)
				.filter(gate => !gate.pass)
				.map(gate => gate.name),
		).toEqual([
			"editor undo",
			"edit p95",
			"frame p95",
			"allocs/frame",
			"10K->100K off-screen frame-time growth",
			"markdown registered",
			"duplicate image ownership",
			"terminal protocol cache",
		]);
	});
});

describe("TUI retained-memory registry completeness", () => {
	it("registers every long-lived TUI cache and pool class with its inventory buckets", () => {
		const registry = new RetainedMemoryRegistry();
		const editor = new Editor(defaultEditorTheme);
		const tui = new TUI({} as Terminal);
		const registrations = [
			editor.registerRetainedMemory(registry),
			...tui.registerRetainedMemory(registry),
			registerMarkdownRetainedMemory(registry),
			registerImageRetainedMemory(registry),
		];

		const pools = new Map(registry.sample().pools.map(pool => [pool.id, Object.keys(pool.buckets)]));
		for (const expected of TUI_RETAINED_MEMORY_CACHE_CLASSES)
			expect(pools.get(expected.id)).toEqual([...expected.buckets]);

		for (const registration of registrations) registration.dispose();
		tui.dispose();
	});
});
