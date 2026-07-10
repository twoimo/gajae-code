import { describe, expect, test } from "bun:test";
import { DEFERRED_MODEL_SURFACES, parseModelLabel, validateModelInput } from "./model-panel-logic";

describe("model panel helpers", () => {
	test("validateModelInput rejects empty provider or model", () => {
		expect(validateModelInput("", "claude-sonnet-4")).toEqual({ ok: false, error: "Provider is required." });
		expect(validateModelInput("   ", "claude-sonnet-4")).toEqual({ ok: false, error: "Provider is required." });
		expect(validateModelInput("anthropic", "")).toEqual({ ok: false, error: "Model ID is required." });
		expect(validateModelInput("anthropic", "   ")).toEqual({ ok: false, error: "Model ID is required." });
	});

	test("validateModelInput accepts trimmed provider and model", () => {
		expect(validateModelInput(" anthropic ", " claude-sonnet-4 ")).toEqual({ ok: true });
	});

	test("parseModelLabel best-effort splits provider/model", () => {
		expect(parseModelLabel()).toEqual({});
		expect(parseModelLabel("   ")).toEqual({});
		expect(parseModelLabel("anthropic/claude-sonnet-4")).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4",
		});
		expect(parseModelLabel("grok-code-fast")).toEqual({ modelId: "grok-code-fast" });
		expect(parseModelLabel(" provider / model/with/slash ")).toEqual({
			provider: "provider",
			modelId: "model/with/slash",
		});
	});

	test("deferred surfaces exclude provider auth now that token-safe provider APIs are live", () => {
		expect(DEFERRED_MODEL_SURFACES.map(surface => surface.name)).not.toContain("provider-auth");
	});
});
