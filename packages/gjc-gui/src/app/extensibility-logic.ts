import type {
	GjcExtensionsListResult,
	GjcPluginsInspectResult,
	GjcPluginsListResult,
	GjcSkillsListResult,
} from "@gajae-code/app-server-client";
import { fuzzyFilter } from "./command-palette-logic";

export type Skill = GjcSkillsListResult["skills"][number];
export type Extension = GjcExtensionsListResult["extensions"][number];
export type Plugin = GjcPluginsListResult["plugins"][number];
export type PluginInspection = NonNullable<GjcPluginsInspectResult["plugin"]>;
export type AppearanceSemanticPreview = {
	bg: string;
	bgElevated: string;
	surface: string;
	text: string;
	textMuted: string;
	accent: string;
	border: string;
	success: string;
	warning: string;
	danger: string;
};
export type AppearanceTheme = {
	id: string;
	kind: "dark" | "light";
	builtin: boolean;
	semanticPreview: AppearanceSemanticPreview;
};
export type AppearanceSettings = {
	dark: string;
	light: string;
	symbolPreset?: string;
	colorBlindMode?: boolean;
};

export type AppearancePreviewState = {
	baseline: AppearanceSettings;
	candidate: AppearanceSettings;
	previewActive: boolean;
};

export function createAppearancePreviewState(baseline: AppearanceSettings): AppearancePreviewState {
	return { baseline, candidate: baseline, previewActive: false };
}

export function previewAppearance(
	state: AppearancePreviewState,
	patch: Partial<AppearanceSettings>,
): AppearancePreviewState {
	return { ...state, candidate: { ...state.baseline, ...patch }, previewActive: true };
}

export function restoreAppearancePreview(state: AppearancePreviewState): AppearancePreviewState {
	return { ...state, candidate: state.baseline, previewActive: false };
}

export function restoreAppearancePreviewOnConnectionLoss(
	state: AppearancePreviewState | undefined,
): AppearancePreviewState | undefined {
	return state ? restoreAppearancePreview(state) : undefined;
}

export function commitAppearancePreview(
	_state: AppearancePreviewState,
	applied: AppearanceSettings,
): AppearancePreviewState {
	return { baseline: applied, candidate: applied, previewActive: false };
}

export { fuzzyFilter };

export type ExtensibilityCounts = {
	skills: number;
	extensions: number;
	plugins: number;
	total: number;
};

export function groupCounts({
	skills,
	extensions,
	plugins,
}: {
	skills: readonly Skill[];
	extensions: readonly Extension[];
	plugins: readonly Plugin[];
}): ExtensibilityCounts {
	return {
		skills: skills.length,
		extensions: extensions.length,
		plugins: plugins.length,
		total: skills.length + extensions.length + plugins.length,
	};
}

export const EXTENSIBILITY_MUTATION_PATHS: readonly string[] = [
	"gjc/appearance/set",
	"gjc/skills/setEnabled",
	"gjc/extensions/setEnabled",
	"gjc/plugins/setEnabled",
	"gjc/plugins/setFeature",
	"gjc/plugins/setSetting",
];

export function setEnabledPayload(
	idKey: "skillId" | "extensionId" | "pluginId",
	id: string,
	enabled: boolean,
): Record<string, string | boolean> {
	return { [idKey]: id, enabled };
}

export function pluginFeaturePayload(pluginId: string, feature: string, enabled: boolean) {
	return { pluginId, feature, enabled };
}

export function pluginSettingPayload(pluginId: string, key: string, value: unknown) {
	return { pluginId, key, value };
}

export function isSecretSettingKey(key: string): boolean {
	return /secret|token|password|api[_-]?key|credential/i.test(key);
}

export function maskSecretValue(value: unknown, key = ""): string {
	if (isSecretSettingKey(key)) return value === undefined || value === null || value === "" ? "" : "••••••••";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}
