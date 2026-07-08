export type DeferredModelSurface = {
	name: "provider-auth";
	rationale: string;
	unblock: string;
};

export const DEFERRED_MODEL_SURFACES: DeferredModelSurface[] = [
	{
		name: "provider-auth",
		rationale: "needs token-safe provider/auth onboarding; no secret may be displayed",
		unblock: "Add token-safe provider login and credential entry APIs with no secret display before enabling onboarding or browser sign-in.",
	},
];

export type ModelCatalogEntry = { provider: string; modelId: string; label?: string; available?: boolean };
export type ProviderAuthView = { authKind: "oauth" | "api-key-env" | "none"; authenticated: boolean; envVar?: string | null };

export function providerAuthGuidance(provider: ProviderAuthView): string | undefined {
	if (provider.authKind === "api-key-env") return `Set ${provider.envVar ?? "the provider environment variable"}; raw keys are never entered here.`;
	if (provider.authKind === "oauth" && !provider.authenticated) return "Use browser sign-in; tokens and verifier values are never shown.";
	return undefined;
}
export type ModelCatalogGroup = { provider: string; models: ModelCatalogEntry[] };

export function groupModelCatalog(models: readonly ModelCatalogEntry[]): ModelCatalogGroup[] {
	const groups = new Map<string, ModelCatalogEntry[]>();
	for (const model of models) {
		const provider = model.provider.trim();
		if (!provider) continue;
		const bucket = groups.get(provider) ?? [];
		bucket.push(model);
		groups.set(provider, bucket);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([provider, entries]) => ({
			provider,
			models: entries.slice().sort((a, b) => a.modelId.localeCompare(b.modelId)),
		}));
}

export function selectThinkingLevel(levels: readonly string[], requested: string, current?: string): string {
	if (levels.includes(requested)) return requested;
	if (current && levels.includes(current)) return current;
	return levels[0] ?? "";
}

export function nextFastEnabled(current: boolean): boolean {
	return !current;
}

export function validateSettingValue(descriptor: { key: string; type: string }, value: unknown): { ok: boolean; error?: string } {
	if (descriptor.type === "boolean") return typeof value === "boolean" ? { ok: true } : { ok: false, error: `${descriptor.key} must be boolean.` };
	if (descriptor.type === "string") return typeof value === "string" ? { ok: true } : { ok: false, error: `${descriptor.key} must be string.` };
	return { ok: false, error: `${descriptor.key} has unsupported type ${descriptor.type}.` };
}

export function validateModelInput(provider: string, modelId: string): { ok: boolean; error?: string } {
	if (provider.trim().length === 0) return { ok: false, error: "Provider is required." };
	if (modelId.trim().length === 0) return { ok: false, error: "Model ID is required." };
	return { ok: true };
}

export function parseModelLabel(label?: string): { provider?: string; modelId?: string } {
	const trimmed = label?.trim();
	if (!trimmed) return {};
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { modelId: trimmed };
	const provider = trimmed.slice(0, slash).trim();
	const modelId = trimmed.slice(slash + 1).trim();
	return {
		...(provider ? { provider } : {}),
		...(modelId ? { modelId } : {}),
	};
}

export type ProviderAddInput = { preset?: string; compatibility?: string; providerId?: string; baseUrl?: string; apiKeyEnv?: string; models?: string; force?: boolean };
export type ProviderAddPayload = { preset: string; force?: boolean } | { compatibility: string; providerId: string; baseUrl: string; apiKeyEnv: string; models: string[]; force?: boolean };

export function providerAddPayload(input: ProviderAddInput): { ok: true; payload: ProviderAddPayload } | { ok: false; error: string } {
	const force = input.force === undefined ? undefined : input.force;
	const preset = input.preset?.trim();
	if (preset) return { ok: true, payload: force === undefined ? { preset } : { preset, force } };
	const compatibility = input.compatibility?.trim() || "openai-compatible";
	const providerId = input.providerId?.trim() ?? "";
	const baseUrl = input.baseUrl?.trim() ?? "";
	const apiKeyEnv = input.apiKeyEnv?.trim() ?? "";
	const models = (input.models ?? "").split(/[\n,]/).map(model => model.trim()).filter(Boolean);
	if (!providerId) return { ok: false, error: "Provider ID is required." };
	if (!baseUrl) return { ok: false, error: "Base URL is required." };
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) return { ok: false, error: "API key env var must be an environment variable name." };
	if (models.length === 0) return { ok: false, error: "At least one model is required." };
	const payload = { compatibility, providerId, baseUrl, apiKeyEnv, models, ...(force === undefined ? {} : { force }) };
	return { ok: true, payload };
}

export const GJC_MODEL_ASSIGNMENT_TARGET_IDS = ["default", "executor", "architect", "planner", "critic"] as const;
export type GjcModelAssignmentTargetId = (typeof GJC_MODEL_ASSIGNMENT_TARGET_IDS)[number];
export type ModelAssignInput = { threadId: string; role: string; provider: string; modelId: string; thinkingLevel?: string };
export function modelAssignPayload(input: ModelAssignInput): ModelAssignInput {
	return {
		threadId: input.threadId.trim(),
		role: input.role.trim(),
		provider: input.provider.trim(),
		modelId: input.modelId.trim(),
		...(input.thinkingLevel?.trim() ? { thinkingLevel: input.thinkingLevel.trim() } : {}),
	};
}
