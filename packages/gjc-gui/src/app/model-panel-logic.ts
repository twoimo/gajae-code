export type DeferredModelSurface = {
	name: "model-catalog" | "thinking" | "fast" | "settings";
	rationale: string;
	unblock: string;
};

export const DEFERRED_MODEL_SURFACES: DeferredModelSurface[] = [
	{
		name: "model-catalog",
		rationale: "needs gjc/model/catalog read API",
		unblock: "Add a read-only model catalog API before enabling catalog browsing.",
	},
	{
		name: "thinking",
		rationale: "needs gjc/thinking read/set API",
		unblock: "Add thinking read/set API support before enabling controls.",
	},
	{
		name: "fast",
		rationale: "needs gjc/fast status/toggle API",
		unblock: "Add fast status/toggle API support before enabling controls.",
	},
	{
		name: "settings",
		rationale: "needs gjc/settings schema/read/update API",
		unblock: "Add settings schema/read/update API support before enabling controls.",
	},
];

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
