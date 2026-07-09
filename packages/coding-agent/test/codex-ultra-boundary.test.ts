import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { parseArgs } from "@gajae-code/coding-agent/cli/args";
import { buildCanonicalModelIndex } from "@gajae-code/coding-agent/config/model-equivalence";
import {
	AGENT_THINKING_EFFORTS,
	getAvailableThinkingLevelsForModel,
	parseEffort,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
	supportsUltraThinking,
	toReasoningEffort,
} from "@gajae-code/coding-agent/thinking";

describe("Codex Ultra boundary", () => {
	it("keeps Ultra local while sending max provider reasoning", () => {
		const sol = getBundledModel("openai-codex", "gpt-5.6-sol");
		const terra = getBundledModel("openai-codex", "gpt-5.6-terra");

		expect(parseThinkingLevel("ultra")).toBe(ThinkingLevel.Ultra);
		expect(AGENT_THINKING_EFFORTS.at(-1)).toBe(ThinkingLevel.Ultra);
		expect(parseArgs(["--thinking", "ultra"]).thinking).toBe(ThinkingLevel.Ultra);
		expect(parseEffort("ultra")).toBeUndefined();
		expect(supportsUltraThinking(sol)).toBe(true);
		expect(supportsUltraThinking(terra)).toBe(false);
		expect(getAvailableThinkingLevelsForModel(sol)).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
			ThinkingLevel.Ultra,
		]);
		expect(getAvailableThinkingLevelsForModel(terra)).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(resolveThinkingLevelForModel(sol, ThinkingLevel.Ultra)).toBe(ThinkingLevel.Ultra);
		expect(resolveThinkingLevelForModel(terra, ThinkingLevel.Ultra)).toBe(Effort.Max);
		expect(toReasoningEffort(ThinkingLevel.Ultra)).toBe(Effort.Max);
	});

	it("does not treat branded -ultra model IDs as effort suffixes", () => {
		const fugu = getBundledModel("fugu", "fugu");
		const fuguUltra = getBundledModel("fugu", "fugu-ultra");
		const index = buildCanonicalModelIndex([fugu, fuguUltra]);

		expect(index.bySelector.get("fugu/fugu")).toBe("fugu");
		expect(index.bySelector.get("fugu/fugu-ultra")).toBe("fugu-ultra");
		expect(index.records.map(record => record.id)).toEqual(["fugu", "fugu-ultra"]);
	});
});
