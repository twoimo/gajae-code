import { describe, expect, test } from "bun:test";
import { DEFERRED_MODEL_SURFACES, GJC_MODEL_ASSIGNMENT_TARGET_IDS, groupModelCatalog, modelAssignPayload, nextFastEnabled, parseModelLabel, providerAddPayload, providerAuthGuidance, selectThinkingLevel, validateModelInput, validateSettingValue } from "./model-panel-logic";

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
		expect(parseModelLabel("anthropic/claude-sonnet-4")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
		expect(parseModelLabel("grok-code-fast")).toEqual({ modelId: "grok-code-fast" });
		expect(parseModelLabel(" provider / model/with/slash ")).toEqual({ provider: "provider", modelId: "model/with/slash" });
	});

	test("groups model catalog by provider with stable model ordering", () => {
		expect(groupModelCatalog([
			{ provider: "openai", modelId: "gpt-5" },
			{ provider: "anthropic", modelId: "claude-4" },
			{ provider: "openai", modelId: "gpt-4.1" },
		])).toEqual([
			{ provider: "anthropic", models: [{ provider: "anthropic", modelId: "claude-4" }] },
			{ provider: "openai", models: [{ provider: "openai", modelId: "gpt-4.1" }, { provider: "openai", modelId: "gpt-5" }] },
		]);
	});

	test("thinking selector keeps valid current level when requested level is unavailable", () => {
		expect(selectThinkingLevel(["low", "medium", "high"], "high", "medium")).toBe("high");
		expect(selectThinkingLevel(["low", "medium"], "max", "medium")).toBe("medium");
		expect(selectThinkingLevel(["low", "medium"], "max", "high")).toBe("low");
	});

	test("fast toggle flips the current enabled state", () => {
		expect(nextFastEnabled(false)).toBe(true);
		expect(nextFastEnabled(true)).toBe(false);
	});

	test("settings validation accepts declared primitive type only", () => {
		expect(validateSettingValue({ key: "autoResume", type: "boolean" }, true)).toEqual({ ok: true });
		expect(validateSettingValue({ key: "autoResume", type: "boolean" }, "true")).toEqual({ ok: false, error: "autoResume must be boolean." });
		expect(validateSettingValue({ key: "theme.dark", type: "string" }, "red-claw")).toEqual({ ok: true });
		expect(validateSettingValue({ key: "theme.dark", type: "string" }, false)).toEqual({ ok: false, error: "theme.dark must be string." });
	});

	test("deferred surfaces keep provider-auth without claiming sign-out is deferred", () => {
		const providerAuth = DEFERRED_MODEL_SURFACES.find(surface => surface.name === "provider-auth");
		expect(providerAuth).toBeDefined();
		expect(providerAuth?.unblock.toLowerCase()).toContain("no secret display");
		expect(`${providerAuth?.rationale} ${providerAuth?.unblock}`.toLowerCase()).not.toContain("logout");
		expect(`${providerAuth?.rationale} ${providerAuth?.unblock}`.toLowerCase()).not.toContain("sign-out");
	});

	test("provider auth guidance renders env and unauthenticated OAuth hints only", () => {
		expect(providerAuthGuidance({ authKind: "api-key-env", authenticated: false, envVar: "ANTHROPIC_API_KEY" })).toBe("Set ANTHROPIC_API_KEY; raw keys are never entered here.");
		expect(providerAuthGuidance({ authKind: "oauth", authenticated: false })).toBe("Use browser sign-in; tokens and verifier values are never shown.");
		expect(providerAuthGuidance({ authKind: "oauth", authenticated: true })).toBeUndefined();
		expect(providerAuthGuidance({ authKind: "none", authenticated: false })).toBeUndefined();
	});

	test("provider add payload uses apiKeyEnv and never apiKey", () => {
		const result = providerAddPayload({ providerId: "local", baseUrl: "https://example.test/v1", apiKeyEnv: "LOCAL_API_KEY", models: "alpha, beta" });
		expect(result).toEqual({ ok: true, payload: { compatibility: "openai-compatible", providerId: "local", baseUrl: "https://example.test/v1", apiKeyEnv: "LOCAL_API_KEY", models: ["alpha", "beta"] } });
		expect(JSON.stringify(result)).not.toContain("apiKey\"");
		expect(providerAddPayload({ providerId: "local", baseUrl: "https://example.test/v1", apiKeyEnv: "not valid", models: "alpha" })).toEqual({ ok: false, error: "API key env var must be an environment variable name." });
		expect(providerAddPayload({ preset: "openai" })).toEqual({ ok: true, payload: { preset: "openai" } });
	});

	test("model assign payload includes thread id and trims role provider model and optional thinking level", () => {
		expect(modelAssignPayload({ threadId: " thread-1 ", role: " primary ", provider: " openai ", modelId: " gpt-5 ", thinkingLevel: " low " })).toEqual({ threadId: "thread-1", role: "primary", provider: "openai", modelId: "gpt-5", thinkingLevel: "low" });
		expect(modelAssignPayload({ threadId: " thread-1 ", role: " fast ", provider: " openai ", modelId: " gpt-5 ", thinkingLevel: " " })).toEqual({ threadId: "thread-1", role: "fast", provider: "openai", modelId: "gpt-5" });
	});

	test("GUI model assignment roles match GJC target ids", () => {
		expect(GJC_MODEL_ASSIGNMENT_TARGET_IDS).toEqual(["default", "executor", "architect", "planner", "critic"]);
	});
});
