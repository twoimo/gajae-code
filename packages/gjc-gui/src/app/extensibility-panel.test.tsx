import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ExtensibilityPanel } from "./extensibility-panel";
import type { AppearanceSettings, AppearanceTheme, Extension, Plugin, Skill } from "./extensibility-logic";

type Tab = "skills" | "extensions" | "plugins" | "appearance";

const skills: Skill[] = [{ name: "ralplan", source: "bundled", description: "Plan", enabled: true }];
const extensions: Extension[] = [{ id: "ext.review", name: "Review tools", kind: "workflow", source: "project", status: "active" }];
const plugins: Plugin[] = [{ id: "plugin.notify", name: "Notifier", kind: "notification", source: "user", status: "masked" }];
const appearance: AppearanceSettings = { dark: "red-claw", light: "blue-crab", symbolPreset: "unicode", colorBlindMode: false };
const appearanceThemes: AppearanceTheme[] = [
	{ id: "red-claw", kind: "dark", builtin: true, semanticPreview: { bg: "#000000", bgElevated: "#111111", surface: "#222222", text: "#ffffff", textMuted: "#bbbbbb", accent: "#ff5a3d", border: "#333333", success: "#7bd88f", warning: "#f0b45a", danger: "#ff4f4f" } },
	{ id: "blue-crab", kind: "light", builtin: true, semanticPreview: { bg: "#ffffff", bgElevated: "#eeeeee", surface: "#dddddd", text: "#000000", textMuted: "#444444", accent: "#3366ff", border: "#cccccc", success: "#3c8a4f", warning: "#a66b00", danger: "#b72d2d" } },
];

let mountedRoot: Root | undefined;

afterEach(() => {
	if (mountedRoot) {
		act(() => mountedRoot?.unmount());
		mountedRoot = undefined;
	}
});

describe("ExtensibilityPanel tabs", () => {
	test("controlled activeTab calls parent callback and follows parent tab updates", () => {
		const { document, Event } = parseHTML("<main id=\"root\"></main>");
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		let activeTab: Tab = "appearance";
		const requestedTabs: Tab[] = [];
		const renderPanel = () => mountedRoot?.render(<ExtensibilityPanel skills={skills} extensions={extensions} plugins={plugins} appearance={appearance} appearanceThemes={appearanceThemes} activeTab={activeTab} loading={false} onRefresh={() => undefined} onInspectExtension={() => undefined} onInspectPlugin={() => undefined} onTabChange={tab => { requestedTabs.push(tab); activeTab = tab; renderPanel(); }} />);

		act(() => renderPanel());
		expect(container.textContent).toContain("Terminal appearance");

		const cases: Array<[string, Tab, string]> = [["Skills", "skills", "ralplan"], ["Extensions", "extensions", "Review tools"], ["Plugins", "plugins", "Notifier"], ["Appearance", "appearance", "Terminal appearance"]];
		for (const [label, expectedTab, expectedContent] of cases) {
			const button = Array.from(container.querySelectorAll("button")).find(node => node.textContent?.startsWith(label));
			if (!button) throw new Error(`Missing ${label} tab`);
			act(() => button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(requestedTabs.at(-1)).toBe(expectedTab);
			expect(container.textContent).toContain(expectedContent);
		}

		expect(requestedTabs).toEqual(["skills", "extensions", "plugins", "appearance"]);
	});
});

describe("ExtensibilityPanel appearance preview", () => {
	test("sets preview candidate only on activation, not hover or focus", () => {
		const { document, Event } = parseHTML("<main id=\"root\"></main>");
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		const previews: AppearanceSettings[] = [];

		act(() => mountedRoot?.render(<ExtensibilityPanel skills={skills} extensions={extensions} plugins={plugins} appearance={appearance} appearanceThemes={appearanceThemes} activeTab="appearance" loading={false} onRefresh={() => undefined} onInspectExtension={() => undefined} onInspectPlugin={() => undefined} onPreviewAppearance={next => previews.push(next)} />));
		const themeButton = Array.from(container.querySelectorAll("button")).find(node => node.textContent?.includes("blue-crab"));
		if (!themeButton) throw new Error("Missing blue-crab theme button");

		act(() => themeButton.dispatchEvent(new Event("mouseenter", { bubbles: true, cancelable: true })));
		act(() => themeButton.dispatchEvent(new Event("focus", { bubbles: true, cancelable: true })));
		expect(previews).toEqual([]);

		act(() => themeButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
		expect(previews.at(-1)?.light).toBe("blue-crab");
	});

	test("renders semantic token sample block for theme preview", () => {
		const { document } = parseHTML("<main id=\"root\"></main>");
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);

		act(() => mountedRoot?.render(<ExtensibilityPanel skills={skills} extensions={extensions} plugins={plugins} appearance={appearance} appearanceThemes={appearanceThemes} activeTab="appearance" loading={false} onRefresh={() => undefined} onInspectExtension={() => undefined} onInspectPlugin={() => undefined} />));
		const sample = container.querySelector(".appearance-theme-sample");

		expect(sample?.textContent).toContain("streaming transcript");
		expect(sample?.textContent).toContain("read DESIGN.md");
		expect(sample?.getAttribute("style")).toContain("background-color:#000000");
		expect(sample?.getAttribute("style")).toContain("border-color:#333333");
	});
});
