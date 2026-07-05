import type { GjcExtensionsListResult, GjcPluginsInspectResult, GjcPluginsListResult, GjcSkillsListResult } from "@gajae-code/app-server-client";
import { fuzzyFilter } from "./command-palette-logic";

export type Skill = GjcSkillsListResult["skills"][number];
export type Extension = GjcExtensionsListResult["extensions"][number];
export type Plugin = GjcPluginsListResult["plugins"][number];
export type PluginInspection = NonNullable<GjcPluginsInspectResult["plugin"]>;

export { fuzzyFilter };

export const APPEARANCE_DEFERRED = {
	reason: "Theme/appearance runtime is not exposed by the app-server; deferred until an appearance seam exists.",
	unblock: "Expose a read/write appearance runtime seam through the app-server before enabling theme selection or appearance mutation in the GUI.",
} as const;

export type ExtensibilityCounts = {
	skills: number;
	extensions: number;
	plugins: number;
	total: number;
};

export function groupCounts({ skills, extensions, plugins }: { skills: readonly Skill[]; extensions: readonly Extension[]; plugins: readonly Plugin[] }): ExtensibilityCounts {
	return {
		skills: skills.length,
		extensions: extensions.length,
		plugins: plugins.length,
		total: skills.length + extensions.length + plugins.length,
	};
}

export const EXTENSIBILITY_MUTATION_PATHS: readonly string[] = [];
