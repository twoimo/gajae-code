import { describe, expect, it } from "bun:test";
import { formatKeyHint } from "../../../src/config/keybindings";
import { buildHelpMarkdown } from "../../../src/modes/controllers/command-controller";
import { buildHotkeysMarkdown, formatHotkeyMarkdownCode } from "../../../src/modes/utils/hotkeys-markdown";

describe("buildHotkeysMarkdown", () => {
	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "⌃⇧L",
			"app.clipboard.copyPrompt": "⌃⇧P",
			"app.message.queue": "⌥↩",
			"app.plan.toggle": "⌥M",
			"app.tools.expand": "⌃O",
			"app.interrupt": "⎋",
			"app.clear": "⌃C",
			"app.exit": "⌃D",
			"app.suspend": "⌃Z",
			"app.session.new": "⌃N",
			"app.thinking.cycle": "⇧⇥",
			"app.commandPalette.open": "⌃P",
			"app.model.cycleForward": "⌥N",
			"app.model.cycleBackward": "⌥⇧N",
			"app.model.selectTemporary": "⌃⇧L",
			"app.model.select": "⌃L",
			"app.history.search": "⌃R",
			"app.thinking.toggle": "⌃T",
			"app.editor.external": "⌃G",
			"app.clipboard.pasteImage": "⌃V",
			"app.stt.toggle": "⌥H",
			"tui.editor.cursorUp": "↑",
			"tui.editor.cursorDown": "↓",
			"tui.editor.cursorWordLeft": "⌥←",
			"tui.editor.cursorWordRight": "⌥→",
			"tui.editor.cursorLineStart": "Home/⌃A",
			"tui.editor.cursorLineEnd": "End/⌃E",
			"tui.input.submit": "↩",
			"tui.input.newLine": "⇧↩",
			"tui.editor.deleteWordBackward": "⌃W/⌥⌫",
			"tui.editor.deleteToLineStart": "⌃U",
			"tui.editor.deleteToLineEnd": "⌃K",
			"tui.input.tab": "⇥",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `⌃⇧P` | Copy whole prompt |");
		expect(markdown).toContain("| `↩` | Send / queue while busy |");
		expect(markdown).toContain("| `⌥↩` | Queue message for next turn |");
		expect(markdown).toContain(`| \`⇧↩/${formatKeyHint("ctrl+j")}\` | New line |`);
		expect(markdown).toContain("| `⌃⇧L` | Select model (temporary) |");
		expect(markdown).toContain("| `⌃L` | Select default model |");
		expect(markdown).toContain("| `⌥M` | Toggle plan mode |");
		expect(markdown).toContain("| `⌃N` | Start a fresh session |");
		expect(markdown).toContain("| `⌃P` | Open command palette |");
		expect(markdown).toContain("| `#` | Prompt actions (command-palette style actions) |");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("keeps the editor Ctrl+J newline path visible after remapping or unbinding the configured action", () => {
		const render = (newLine: string): string =>
			buildHotkeysMarkdown({
				keybindings: {
					getDisplayString(action) {
						return action === "tui.input.newLine" ? newLine : "Ctrl+K";
					},
				},
			});

		expect(render("Alt+Enter")).toContain(`| \`Alt+Enter/${formatKeyHint("ctrl+j")}\` | New line |`);
		expect(render("")).toContain(`| \`Disabled/${formatKeyHint("ctrl+j")}\` | New line |`);
	});

	it("escapes Markdown metacharacters in dynamic table labels", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					if (action === "tui.input.submit") return "Ctrl+|";
					if (action === "app.message.queue") return "`";
					if (action === "app.message.dequeue") return "\\";
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Ctrl+\\|` | Send / queue while busy |");
		expect(markdown).toContain("| `` ` `` | Queue message for next turn |");
		expect(markdown).toContain("| `\\` | Select queued message to edit |");
		expect(formatHotkeyMarkdownCode("``")).toBe("``` `` ```");
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Ctrl+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Disabled` | Select model (temporary) |");
		expect(markdown).toContain("| `Ctrl+L` | Select default model |");
	});
});

describe("buildHelpMarkdown", () => {
	it("advertises effective submit and tab bindings for autocomplete confirmation", () => {
		const requestedActions: string[] = [];
		const markdown = buildHelpMarkdown({
			getDisplayString(action) {
				requestedActions.push(action);
				if (action === "tui.input.submit") return "Ctrl+Enter";
				if (action === "tui.input.tab") return "";
				if (action === "tui.select.up") return "Ctrl+|";
				if (action === "tui.select.down") return "\\";
				if (action === "app.session.new") return "Alt+`";
				return "Ctrl+M";
			},
		});

		expect(markdown).toContain("then use `Ctrl+|/\\` and `Ctrl+Enter/Disabled`.");
		expect(markdown).toContain("| Start a fresh session | `` Alt+` `` or `/new` |");
		expect(requestedActions).not.toContain("tui.select.confirm");
	});
});
