import { describe, expect, it } from "bun:test";
import {
	defaultMessageQueueKeysForPlatform,
	formatKeyHint,
	formatKeyHints,
	KeybindingsManager,
} from "../src/config/keybindings";
import type { Extension, ExtensionRuntime } from "../src/extensibility/extensions";
import { ExtensionRunner } from "../src/extensibility/extensions";

describe("KeybindingsManager.getDisplayString", () => {
	it("formats bindings using the supplied platform context", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.dequeue": "alt+up",
			"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
		});

		expect(keybindings.getDisplayString("app.message.dequeue", { platform: "darwin" })).toBe("⌥↑");
		expect(keybindings.getDisplayString("app.clipboard.copyPrompt", { platform: "win32" })).toBe(
			"Alt+Shift+C/Ctrl+Shift+C",
		);
	});
	it("uses the configured default context across composed consumers", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.commandPalette.open": "super+p",
		});
		keybindings.setDisplayContext({ platform: "darwin" });

		expect(keybindings.getDisplayString("app.commandPalette.open")).toBe("⌘P");
		expect(keybindings.getDisplayString("app.commandPalette.open", { platform: "linux" })).toBe("Super+P");
	});

	it("returns an empty string when the action has no binding", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.clipboard.copyPrompt": [],
		});
		expect(keybindings.getDisplayString("app.clipboard.copyPrompt")).toBe("");
	});
});

describe("platform-aware key hint formatting", () => {
	it("formats modifier order, special keys, and literal plus on all platforms", () => {
		expect(formatKeyHint("super+ctrl+p", { platform: "darwin" })).toBe("⌃⌘P");
		expect(formatKeyHint("ctrl+alt+shift+super+enter", { platform: "darwin" })).toBe("⌃⌥⇧⌘↩");
		expect(formatKeyHint("ctrl++", { platform: "darwin" })).toBe("⌃+");
		expect(formatKeyHint("ctrl+backspace", { platform: "darwin" })).toBe("⌃⌫");
		expect(formatKeyHint("alt+left", { platform: "darwin" })).toBe("⌥←");
		expect(formatKeyHint("super+p", { platform: "win32" })).toBe("Super+P");
		expect(formatKeyHint("ctrl+escape", { platform: "linux" })).toBe("Ctrl+Esc");
		expect(formatKeyHints(["alt+up", "ctrl++"], { platform: "linux" })).toBe("Alt+Up/Ctrl++");
	});

	it("uses a fixed safe fallback for invalid input", () => {
		expect(formatKeyHint("command+p", { platform: "darwin" })).toBe("Invalid keybinding");
		expect(formatKeyHint("ctrl+\u001b[31m", { platform: "linux" })).toBe("Invalid keybinding");
	});
});

describe("message keybinding defaults", () => {
	it("does not bind follow-up to Ctrl+Enter by default", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getKeys("app.message.followUp")).toEqual([]);
		expect(keybindings.getDisplayString("app.message.followUp")).toBe("");
		expect(keybindings.getDisplayString("app.message.queue")).toBe(
			process.platform === "darwin" ? "⌥Q" : process.platform === "win32" ? "Alt+Q" : "Alt+Enter",
		);
	});

	it("binds queue editing to both Alt+Up and Alt+Down by default", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.getKeys("app.message.dequeue")).toEqual(["alt+up", "alt+down"]);
		expect(keybindings.getDisplayString("app.message.dequeue")).toBe(
			process.platform === "darwin" ? "⌥↑/⌥↓" : "Alt+Up/Alt+Down",
		);
	});

	it("uses Alt+Q for native Windows and macOS queue shortcuts", () => {
		expect(defaultMessageQueueKeysForPlatform("win32")).toBe("alt+q");
		expect(defaultMessageQueueKeysForPlatform("linux")).toBe("alt+enter");
		expect(defaultMessageQueueKeysForPlatform("darwin")).toBe("alt+q");
	});
});

describe("extension shortcut reservations", () => {
	it("keeps Ctrl+Enter reserved for composer submit", () => {
		const shortcut = {
			shortcut: "ctrl+enter" as const,
			description: "conflicting shortcut",
			handler: () => {},
			extensionPath: "test-extension",
		};
		const extension: Extension = {
			path: "test-extension",
			resolvedPath: "test-extension",
			handlers: new Map(),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map([["ctrl+enter", shortcut]]),
		};
		const runtime = {
			flagValues: new Map(),
			pendingProviderRegistrations: [],
		} as unknown as ExtensionRuntime;
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);

		expect(runner.getShortcuts().has("ctrl+enter")).toBe(false);
	});
});
