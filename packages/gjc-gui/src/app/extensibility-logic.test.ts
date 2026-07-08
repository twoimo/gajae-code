import { describe, expect, test } from "bun:test";
import { EXTENSIBILITY_MUTATION_PATHS, createAppearancePreviewState, fuzzyFilter, groupCounts, maskSecretValue, pluginFeaturePayload, pluginSettingPayload, previewAppearance, restoreAppearancePreview, restoreAppearancePreviewOnConnectionLoss, setEnabledPayload, type AppearanceSettings, type Extension, type Plugin, type Skill } from "./extensibility-logic";

const skills: Skill[] = [
	{ name: "ralplan", source: "bundled", description: "Consensus planning", enabled: true },
	{ name: "deep-interview", source: "bundled", description: "Requirements interview", enabled: false },
];

const extensions: Extension[] = [
	{ id: "ext.review", name: "Review tools", kind: "workflow", source: "project", status: "active" },
];

const plugins: Plugin[] = [
	{ id: "plugin.notify", name: "Notifier", kind: "notification", source: "user", status: "masked" },
	{ id: "plugin.git", name: "Git helper", kind: "vcs", source: "project" },
];

const appearance: AppearanceSettings = { dark: "red-claw", light: "blue-crab", symbolPreset: "unicode", colorBlindMode: false };

describe("extensibility logic", () => {
	test("fuzzyFilter ranks matching catalog entries and excludes misses", () => {
		expect(fuzzyFilter(skills, "rp", skill => skill.name).map(skill => skill.name)).toEqual(["ralplan"]);
		expect(fuzzyFilter(plugins, "git", plugin => `${plugin.name} ${plugin.id}`).map(plugin => plugin.id)[0]).toBe("plugin.git");
		expect(fuzzyFilter(extensions, "missing", extension => extension.name)).toEqual([]);
	});

	test("groupCounts returns per-catalog and total counts", () => {
		expect(groupCounts({ skills, extensions, plugins })).toEqual({ skills: 2, extensions: 1, plugins: 2, total: 5 });
	});

	test("appearance preview state restores the last-read baseline on cancel or disconnect", () => {
		const initial = createAppearancePreviewState(appearance);
		const preview = previewAppearance(initial, { dark: "夜テーマ", colorBlindMode: true });
		expect(preview.previewActive).toBe(true);
		expect(preview.candidate.dark).toBe("夜テーマ");
		expect(preview.candidate.colorBlindMode).toBe(true);
		expect(restoreAppearancePreview(preview)).toEqual(initial);
	});

	test("disconnect-resets-preview", () => {
		const preview = previewAppearance(createAppearancePreviewState(appearance), { dark: "붉은 집게 테마", symbolPreset: "ascii" });
		expect(restoreAppearancePreviewOnConnectionLoss(preview)).toEqual(createAppearancePreviewState(appearance));
	});

	test("logic exposes strict appearance and toggle mutation paths", () => {
		expect(EXTENSIBILITY_MUTATION_PATHS).toEqual(["gjc/appearance/set", "gjc/skills/setEnabled", "gjc/extensions/setEnabled", "gjc/plugins/setEnabled", "gjc/plugins/setFeature", "gjc/plugins/setSetting"]);
	});

	test("toggle and plugin payload helpers match frozen contract", () => {
		expect(setEnabledPayload("skillId", "ralplan", false)).toEqual({ skillId: "ralplan", enabled: false });
		expect(setEnabledPayload("extensionId", "ext.review", true)).toEqual({ extensionId: "ext.review", enabled: true });
		expect(setEnabledPayload("pluginId", "plugin.git", false)).toEqual({ pluginId: "plugin.git", enabled: false });
		expect(pluginFeaturePayload("plugin.git", "diff", true)).toEqual({ pluginId: "plugin.git", feature: "diff", enabled: true });
		expect(pluginSettingPayload("plugin.git", "apiToken", "secret")).toEqual({ pluginId: "plugin.git", key: "apiToken", value: "secret" });
	});

	test("secret setting values are masked while non-secrets round trip visibly", () => {
		expect(maskSecretValue("sk-live", "apiKey")).toBe("••••••••");
		expect(maskSecretValue("plain", "label")).toBe("plain");
		expect(maskSecretValue(true, "enabled")).toBe("true");
	});
});
