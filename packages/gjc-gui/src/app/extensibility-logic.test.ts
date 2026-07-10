import { describe, expect, test } from "bun:test";
import {
	APPEARANCE_DEFERRED,
	EXTENSIBILITY_MUTATION_PATHS,
	type Extension,
	fuzzyFilter,
	groupCounts,
	type Plugin,
	type Skill,
} from "./extensibility-logic";

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

describe("extensibility logic", () => {
	test("fuzzyFilter ranks matching catalog entries and excludes misses", () => {
		expect(fuzzyFilter(skills, "rp", skill => skill.name).map(skill => skill.name)).toEqual(["ralplan"]);
		// Subsequence match ranks the contiguous "git" in plugin.git first; other
		// subsequence hits may follow, so assert ranking rather than exclusion.
		expect(fuzzyFilter(plugins, "git", plugin => `${plugin.name} ${plugin.id}`).map(plugin => plugin.id)[0]).toBe(
			"plugin.git",
		);
		expect(fuzzyFilter(extensions, "missing", extension => extension.name)).toEqual([]);
	});

	test("APPEARANCE_DEFERRED exposes reason and unblock guidance", () => {
		expect(APPEARANCE_DEFERRED.reason).toContain("Theme/appearance runtime is not exposed");
		expect(APPEARANCE_DEFERRED.unblock.toLowerCase()).toContain("appearance runtime seam");
	});

	test("groupCounts returns per-catalog and total counts", () => {
		expect(groupCounts({ skills, extensions, plugins })).toEqual({ skills: 2, extensions: 1, plugins: 2, total: 5 });
	});

	test("mutation paths match the frozen contract", () => {
		expect(EXTENSIBILITY_MUTATION_PATHS).toEqual([
			"gjc/appearance/set",
			"gjc/skills/setEnabled",
			"gjc/extensions/setEnabled",
			"gjc/plugins/setEnabled",
			"gjc/plugins/setFeature",
			"gjc/plugins/setSetting",
		]);
	});
});
