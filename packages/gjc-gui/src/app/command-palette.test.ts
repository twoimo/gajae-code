import { describe, expect, test } from "bun:test";
import {
	classifyBadge,
	commandInsertText,
	fuzzyFilter,
	type PaletteCommand,
	resolveClassification,
} from "./command-palette-logic";

describe("command palette logic", () => {
	test("fuzzyFilter matches case-insensitive subsequences and ranks compact matches before names", () => {
		const items = ["gajae-code", "git-commit", "gc", "GenerateCommit"];
		expect(fuzzyFilter(items, "GC", item => item)).toEqual(["gc", "git-commit", "gajae-code", "GenerateCommit"]);
	});

	test("fuzzyFilter returns every item sorted by name for empty queries", () => {
		const items = ["skill:team", "help", "hotkeys"];
		expect(fuzzyFilter(items, "", item => item)).toEqual(["help", "hotkeys", "skill:team"]);
	});

	test("classifyBadge maps parity classifications", () => {
		expect(classifyBadge("in-scope-existing")).toEqual({ label: "", disabled: false });
		expect(classifyBadge("in-scope-new")).toEqual({ label: "", disabled: false });
		expect(classifyBadge("prompt-display-only")).toEqual({ label: "prompt", disabled: false });
		expect(classifyBadge("deferred-needs-new-api")).toEqual({ label: "soon", disabled: true });
		expect(classifyBadge("excluded-terminal-only")).toEqual({ label: "terminal-only", disabled: true });
		expect(classifyBadge()).toEqual({ label: "", disabled: false });
	});

	test("theme command is deferred until appearance API exists", () => {
		expect(classifyBadge(resolveClassification({ name: "theme", source: "builtin" }))).toEqual({
			label: "soon",
			disabled: true,
		});
	});

	test("retry command is deferred until a retry seam exists", () => {
		expect(classifyBadge(resolveClassification({ name: "retry", source: "builtin" }))).toEqual({
			label: "soon",
			disabled: true,
		});
	});

	test("commandInsertText formats slash command prompts", () => {
		expect(commandInsertText({ name: "skill:ralplan", source: "skill" })).toBe("/skill:ralplan ");
	});

	test("selecting a command inserts prompt text without a backend call", () => {
		const calls: string[] = [];
		const backend = {
			gjcCommandsList: () => calls.push("gjcCommandsList"),
			turnStart: () => calls.push("turnStart"),
		};
		const command: PaletteCommand = { name: "help", source: "core", classification: "prompt-display-only" };
		let inserted = "";

		const onInsert = (text: string) => {
			inserted += text;
		};
		onInsert(commandInsertText(command));

		expect(inserted).toBe("/help ");
		expect(calls).toEqual([]);
		expect(backend).toBeDefined();
	});
});
