import { describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { resolveAgentCreationModel } from "@gajae-code/coding-agent/modes/components/agent-dashboard";

const availableModel = {
	provider: "available-provider",
	id: "available-model",
	name: "Available model",
	api: "openai-responses",
	contextWindow: 1_000,
	maxTokens: 1_000,
} as Model;

function createRegistry(models: Model[]) {
	return {
		getAvailable: () => models,
		resolveCanonicalModel: () => undefined,
	};
}

describe("agent dashboard model resolution", () => {
	test("surfaces configured selectors that do not resolve instead of using an arbitrary model", () => {
		expect(() => resolveAgentCreationModel(["missing-provider/missing-model"], createRegistry([availableModel]) as never, undefined)).toThrow(
		"Configured model selector(s) did not resolve: missing-provider/missing-model.",
	);
});

	test("uses the first available model only when no preference was configured", () => {
		expect(resolveAgentCreationModel([], createRegistry([availableModel]) as never, undefined)).toBe(availableModel);
	});
});
