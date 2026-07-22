import type { Keybinding } from "@gajae-code/tui";
import type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString">;
}

function key(bindings: HotkeysMarkdownBindings, action: Keybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

function appKey(bindings: HotkeysMarkdownBindings, action: AppKeybinding): string {
	return key(bindings, action);
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${key(bindings, "tui.editor.cursorUp")}/${key(bindings, "tui.editor.cursorDown")}\` | Move cursor / browse history (Up when empty) |`,
		`| \`${key(bindings, "tui.editor.cursorWordLeft")}/${key(bindings, "tui.editor.cursorWordRight")}\` | Move by word |`,
		`| \`${key(bindings, "tui.editor.cursorLineStart")}\` | Start of line |`,
		`| \`${key(bindings, "tui.editor.cursorLineEnd")}\` | End of line |`,
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${key(bindings, "tui.input.submit")}\` | Send / queue while busy |`,
		`| \`${appKey(bindings, "app.message.queue")}\` | Queue message for next turn |`,
		`| \`${appKey(bindings, "app.message.dequeue")}\` | Select queued message to edit |`,
		`| \`${key(bindings, "tui.input.newLine")}\` | New line |`,
		`| \`${key(bindings, "tui.editor.deleteWordBackward")}\` | Delete word backwards |`,
		`| \`${key(bindings, "tui.editor.deleteToLineStart")}\` | Delete to start of line |`,
		`| \`${key(bindings, "tui.editor.deleteToLineEnd")}\` | Delete to end of line |`,
		`| \`${appKey(bindings, "app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${appKey(bindings, "app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${key(bindings, "tui.input.tab")}\` | Path completion / accept autocomplete |`,
		`| \`${appKey(bindings, "app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${appKey(bindings, "app.clear")}\` | Clear editor (first) / exit (second) |`,
		`| \`${appKey(bindings, "app.exit")}\` | Exit (when editor is empty) |`,
		`| \`${appKey(bindings, "app.suspend")}\` | Suspend to background |`,
		`| \`${appKey(bindings, "app.commandPalette.open")}\` | Open command palette |`,
		`| \`${appKey(bindings, "app.session.new")}\` | Start a fresh session |`,
		`| \`${appKey(bindings, "app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${appKey(bindings, "app.model.cycleForward")}\` | Cycle configured model roles |`,
		`| \`${appKey(bindings, "app.model.cycleBackward")}\` | Cycle configured model roles temporarily |`,
		`| \`${appKey(bindings, "app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${appKey(bindings, "app.model.select")}\` | Select default model |`,
		`| \`${appKey(bindings, "app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${appKey(bindings, "app.history.search")}\` | Search prompt history |`,
		`| \`${appKey(bindings, "app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${appKey(bindings, "app.tool.backgroundFold")}\` twice | Fold supported foreground bash into a background job |`,
		`| \`${appKey(bindings, "app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${appKey(bindings, "app.editor.external")}\` | Edit message in external editor |`,
		`| \`${appKey(bindings, "app.clipboard.pasteImage")}\` | Paste image from clipboard |`,
		`| \`${appKey(bindings, "app.stt.toggle")}\` | Toggle speech-to-text recording |`,
		`| \`${appKey(bindings, "app.irc.sidebar.toggle")}\` | Toggle IRC sidebar |`,
		"| `?` | Show help / shortcuts |",
		"| `#` | Prompt actions (command-palette style actions) |",
		"| `/` | Slash commands (try `/help` or `/new`) |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
