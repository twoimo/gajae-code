import { describe, expect, test } from "bun:test";
import { classifyBadge, commandAction, commandDisabled, commandDisplayText, commandInsertText, fuzzyFilter, type PaletteCommand, type PaletteCommandAction } from "./command-palette-logic";

const command = (name: string, source = "builtin", classification = "in-scope-existing") => ({ name, source, classification }) as PaletteCommand;
const matrixImplementedBuiltins = [
	"/agents", "/context", "/jobs", "/login", "/logout", "/monitors", "/move", "/usage", "/tree",
	"/export", "/rename", "/fast", "/goal",
	"/model", "/theme", "/session", "/settings", "/provider", "/tools", "/skills", "/extensions", "/plugins",
	"/compact", "/retry", "/new", "/copy", "/dump", "/drop", "/resume",
];


describe("command palette logic", () => {
	test("fuzzyFilter matches case-insensitive subsequences and ranks compact matches before names", () => {
		const items = ["gajae-code", "git-commit", "gc", "GenerateCommit"];
		expect(fuzzyFilter(items, "GC", item => item)).toEqual(["gc", "git-commit", "gajae-code", "GenerateCommit"]);
	});

	test("fuzzyFilter returns every item sorted by name for empty queries", () => {
		const items = ["skill:team", "help", "hotkeys"];
		expect(fuzzyFilter(items, "", item => item)).toEqual(["help", "hotkeys", "skill:team"]);
	});

	test("classifyBadge maps server-provided parity classifications", () => {
		expect(classifyBadge("in-scope-existing")).toEqual({ label: "", disabled: false });
		expect(classifyBadge("in-scope-new")).toEqual({ label: "", disabled: false });
		expect(classifyBadge("prompt-display-only")).toEqual({ label: "prompt", disabled: false });
		expect(classifyBadge("deferred-needs-new-api")).toEqual({ label: "soon", disabled: true });
		expect(classifyBadge("excluded-terminal-only")).toEqual({ label: "terminal-only", disabled: true });
		expect(classifyBadge()).toEqual({ label: "", disabled: false });
	});

	test("no stale client map disables implemented commands", () => {
		expect(classifyBadge(command("/provider", "builtin", "in-scope-new").classification)).toEqual({ label: "", disabled: false });
		expect(classifyBadge(command("/settings", "builtin", "in-scope-new").classification)).toEqual({ label: "", disabled: false });
	});

	test("real slash-prefixed server rows route to GUI actions with single-slash display and insert text", () => {
		const cases: Array<[PaletteCommand, PaletteCommandAction]> = [
			[command("/help", "builtin", "prompt-display-only"), { kind: "local-sheet", target: "help" }],
			[command("/model"), { kind: "navigate", target: "model" }],
			[command("/compact"), { kind: "invoke", target: "compact" }],
			[command("/drop"), { kind: "invoke", target: "drop" }],
			[command("/login", "builtin", "in-scope-new"), { kind: "navigate", target: "provider" }],
			[command("/move", "builtin", "in-scope-new"), { kind: "invoke", target: "move" }],
			[command("/theme"), { kind: "navigate", target: "theme" }],
			[command("/skill:foo", "skill", "prompt-display-only"), { kind: "disabled", reason: "Skill commands are not expandable in the GUI yet" }],
		];
		for (const [row, action] of cases) {
			expect(commandAction(row)).toEqual(action);
			expect(commandDisplayText(row)).toBe(`/${row.name.replace(/^\//, "")}`);
			expect(commandInsertText(row)).toBe(`${commandDisplayText(row)} `);
			expect(commandDisplayText(row).startsWith("//")).toBe(false);
		}
	});

	test("only non-builtin prompt templates fall back to insert-prompt", () => {
		expect(commandAction(command("/skill:ralplan", "skill", "prompt-display-only")).kind).toBe("disabled");
		expect(commandAction(command("/prompt-template", "extension", "prompt-display-only"))).toEqual({ kind: "insert-prompt" });
	});

	test("enabled builtin commands never fall back to insert-prompt", () => {
		const builtinNames = [...matrixImplementedBuiltins, "/help", "/hotkeys"];
		for (const name of builtinNames) {
			const action = commandAction(command(name, "builtin", name === "/help" || name === "/hotkeys" ? "prompt-display-only" : "in-scope-existing"));
			expect(action.kind, name).not.toBe("insert-prompt");
			expect(commandDisabled(command(name, "builtin", name === "/help" || name === "/hotkeys" ? "prompt-display-only" : "in-scope-existing")), name).toBe(false);
		}
	});

	test("matrix-implemented in-scope builtins have non-disabled palette actions", () => {
		for (const name of matrixImplementedBuiltins) {
			const row = command(name, "builtin", "in-scope-new");
			const action = commandAction(row);
			expect(action.kind, name).not.toBe("disabled");
			expect(action.kind, name).not.toBe("insert-prompt");
			expect(commandDisabled(row), name).toBe(false);
		}
	});

	test("help and hotkeys actions are local-only and do not mutate backend prompts", () => {
		const calls: string[] = [];
		const backend = { gjcCommandsList: () => calls.push("gjcCommandsList"), turnStart: () => calls.push("turnStart") };
		const actions: PaletteCommandAction[] = [];
		for (const name of ["/help", "/hotkeys"]) actions.push(commandAction(command(name, "builtin", "prompt-display-only")));

		expect(actions).toEqual([{ kind: "local-sheet", target: "help" }, { kind: "local-sheet", target: "hotkeys" }]);
		expect(calls).toEqual([]);
		expect(backend).toBeDefined();
	});

	test("drop composite ordering is delete current thread then start fresh", async () => {
		const calls: string[] = [];
		const runDrop = async () => {
			calls.push("delete:thread-1");
			calls.push("new");
		};
		expect(commandAction(command("/drop"))).toEqual({ kind: "invoke", target: "drop" });
		await runDrop();
		expect(calls).toEqual(["delete:thread-1", "new"]);
	});
});
