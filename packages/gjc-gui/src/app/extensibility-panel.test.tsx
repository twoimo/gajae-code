import { afterEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppearanceSettings, AppearanceTheme, Extension, Plugin, Skill } from "./extensibility-logic";
import { ExtensibilityPanel } from "./extensibility-panel";

type Tab = "skills" | "extensions" | "plugins" | "appearance";

const skills: Skill[] = [{ name: "ralplan", source: "bundled", description: "Plan", enabled: true }];
const extensions: Extension[] = [
	{ id: "ext.review", name: "Review tools", kind: "workflow", source: "project", status: "active" },
];
const plugins: Plugin[] = [
	{ id: "plugin.notify", name: "Notifier", kind: "notification", source: "user", status: "masked" },
];
const appearance: AppearanceSettings = {
	dark: "red-claw",
	light: "blue-crab",
	symbolPreset: "unicode",
	colorBlindMode: false,
};
const appearanceThemes: AppearanceTheme[] = [
	{
		id: "red-claw",
		kind: "dark",
		builtin: true,
		semanticPreview: {
			bg: "#000000",
			bgElevated: "#111111",
			surface: "#222222",
			text: "#ffffff",
			textMuted: "#bbbbbb",
			accent: "#ff5a3d",
			border: "#333333",
			success: "#7bd88f",
			warning: "#f0b45a",
			danger: "#ff4f4f",
		},
	},
	{
		id: "blue-crab",
		kind: "light",
		builtin: true,
		semanticPreview: {
			bg: "#ffffff",
			bgElevated: "#eeeeee",
			surface: "#dddddd",
			text: "#000000",
			textMuted: "#444444",
			accent: "#3366ff",
			border: "#cccccc",
			success: "#3c8a4f",
			warning: "#a66b00",
			danger: "#b72d2d",
		},
	},
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
		const { document, Event } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		let activeTab: Tab = "appearance";
		const requestedTabs: Tab[] = [];
		const renderPanel = () =>
			mountedRoot?.render(
				<ExtensibilityPanel
					skills={skills}
					extensions={extensions}
					plugins={plugins}
					appearance={appearance}
					appearanceThemes={appearanceThemes}
					activeTab={activeTab}
					loading={false}
					onRefresh={() => undefined}
					onInspectExtension={() => undefined}
					onInspectPlugin={() => undefined}
					onTabChange={tab => {
						requestedTabs.push(tab);
						activeTab = tab;
						renderPanel();
					}}
				/>,
			);

		act(() => renderPanel());
		expect(container.textContent).toContain("Terminal appearance");

		const cases: Array<[string, Tab, string]> = [
			["Skills", "skills", "ralplan"],
			["Extensions", "extensions", "Review tools"],
			["Plugins", "plugins", "Notifier"],
			["Appearance", "appearance", "Terminal appearance"],
		];
		for (const [label, expectedTab, expectedContent] of cases) {
			const button = Array.from(container.querySelectorAll("button")).find(node =>
				node.textContent?.startsWith(label),
			);
			if (!button) throw new Error(`Missing ${label} tab`);
			act(() => button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(requestedTabs.at(-1)).toBe(expectedTab);
			expect(container.textContent).toContain(expectedContent);
		}

		expect(requestedTabs).toEqual(["skills", "extensions", "plugins", "appearance"]);
	});
});

describe("ExtensibilityPanel protocol-backed toggles", () => {
	test("uses disabled extension state and plugin status to request enable", () => {
		const { document, Event } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		const extensionCalls: boolean[] = [];
		const pluginCalls: boolean[] = [];
		act(() =>
			mountedRoot?.render(
				<ExtensibilityPanel
					skills={[]}
					extensions={[{ ...extensions[0], state: "disabled" }]}
					plugins={[{ ...plugins[0], status: "disabled" }]}
					activeTab="extensions"
					loading={false}
					onRefresh={() => undefined}
					onInspectExtension={() => undefined}
					onInspectPlugin={() => undefined}
					onExtensionEnabled={(_, enabled) => extensionCalls.push(enabled)}
					onPluginEnabled={(_, enabled) => pluginCalls.push(enabled)}
				/>,
			),
		);
		const click = (label: string) => {
			const button = Array.from(container.querySelectorAll("button")).find(node => node.textContent === label);
			if (!button) throw new Error(`Missing ${label} button`);
			act(() => button.dispatchEvent(new Event("click", { bubbles: true })));
		};
		click("Enable");
		act(() =>
			mountedRoot?.render(
				<ExtensibilityPanel
					skills={[]}
					extensions={[{ ...extensions[0], state: "disabled" }]}
					plugins={[{ ...plugins[0], status: "disabled" }]}
					activeTab="plugins"
					loading={false}
					onRefresh={() => undefined}
					onInspectExtension={() => undefined}
					onInspectPlugin={() => undefined}
					onExtensionEnabled={(_, enabled) => extensionCalls.push(enabled)}
					onPluginEnabled={(_, enabled) => pluginCalls.push(enabled)}
				/>,
			),
		);
		click("Enable");
		expect(extensionCalls).toEqual([true]);
		expect(pluginCalls).toEqual([true]);
	});
});

describe("ExtensibilityPanel extension inspection", () => {
	test("renders only the matching inspected extension after Inspect", () => {
		const { document, Event } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		const extensionRows: Extension[] = [
			extensions[0],
			{ id: "ext.audit", name: "Audit tools", kind: "workflow", source: "user", status: "inactive" },
		];
		const inspectedReview: Extension = {
			...extensionRows[0],
			provider: "review-provider",
			status: "available",
			state: "shadowed",
			disabledReason: "shadowed",
			shadowedBy: "project:review",
		};
		const inspectedAudit: Extension = {
			...extensionRows[1],
			provider: "audit-provider",
			status: "available",
			state: "active",
		};
		const inspectCalls: string[] = [];
		let extensionInspection: Extension | undefined;
		const renderPanel = () =>
			mountedRoot?.render(
				<ExtensibilityPanel
					skills={[]}
					extensions={extensionRows}
					plugins={[]}
					extensionInspection={extensionInspection}
					activeTab="extensions"
					loading={false}
					onRefresh={() => undefined}
					onInspectExtension={id => inspectCalls.push(id)}
					onInspectPlugin={() => undefined}
				/>,
			);

		act(() => renderPanel());
		const reviewTriggerCard = Array.from(container.querySelectorAll("article")).find(card =>
			card.textContent?.includes("Review tools"),
		);
		const inspect = Array.from(reviewTriggerCard?.querySelectorAll("button") ?? []).find(
			node => node.textContent === "Inspect",
		);
		if (!inspect) throw new Error("Missing Review tools Inspect button");
		act(() => inspect.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
		expect(inspectCalls).toEqual(["ext.review"]);

		extensionInspection = inspectedReview;
		act(() => renderPanel());
		const details = container.querySelector('[aria-label="Extension inspection details"]');
		expect(details?.textContent).toContain("Inspection details");
		expect(details?.textContent).toContain("Provider");
		expect(details?.textContent).toContain("review-provider");
		expect(details?.textContent).toContain("Status");
		expect(details?.textContent).toContain("available");
		expect(details?.textContent).toContain("State");
		expect(details?.textContent).toContain("shadowed");
		expect(details?.textContent).toContain("Disabled reason");
		expect(details?.textContent).toContain("Shadowed by");
		expect(details?.textContent).toContain("project:review");

		extensionInspection = inspectedAudit;
		act(() => renderPanel());
		const reviewCard = Array.from(container.querySelectorAll("article")).find(card =>
			card.textContent?.includes("Review tools"),
		);
		const auditCard = Array.from(container.querySelectorAll("article")).find(card =>
			card.textContent?.includes("Audit tools"),
		);
		expect(reviewCard?.textContent).not.toContain("audit-provider");
		expect(auditCard?.textContent).toContain("audit-provider");
	});
});

describe("ExtensibilityPanel appearance preview", () => {
	test("sets preview candidate only on activation, not hover or focus", () => {
		const { document, Event } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		const previews: AppearanceSettings[] = [];

		act(() =>
			mountedRoot?.render(
				<ExtensibilityPanel
					skills={skills}
					extensions={extensions}
					plugins={plugins}
					appearance={appearance}
					appearanceThemes={appearanceThemes}
					activeTab="appearance"
					loading={false}
					onRefresh={() => undefined}
					onInspectExtension={() => undefined}
					onInspectPlugin={() => undefined}
					onPreviewAppearance={next => previews.push(next)}
				/>,
			),
		);
		const themeButton = Array.from(container.querySelectorAll("button")).find(node =>
			node.textContent?.includes("blue-crab"),
		);
		if (!themeButton) throw new Error("Missing blue-crab theme button");

		act(() => themeButton.dispatchEvent(new Event("mouseenter", { bubbles: true, cancelable: true })));
		act(() => themeButton.dispatchEvent(new Event("focus", { bubbles: true, cancelable: true })));
		expect(previews).toEqual([]);

		act(() => themeButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
		expect(previews.at(-1)?.light).toBe("blue-crab");
	});

	test("renders semantic token sample block for theme preview", () => {
		const { document } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);

		act(() =>
			mountedRoot?.render(
				<ExtensibilityPanel
					skills={skills}
					extensions={extensions}
					plugins={plugins}
					appearance={appearance}
					appearanceThemes={appearanceThemes}
					activeTab="appearance"
					loading={false}
					onRefresh={() => undefined}
					onInspectExtension={() => undefined}
					onInspectPlugin={() => undefined}
				/>,
			),
		);
		const sample = container.querySelector(".appearance-theme-sample");

		expect(sample?.textContent).toContain("streaming transcript");
		expect(sample?.textContent).toContain("read DESIGN.md");
		expect(sample?.getAttribute("style")).toContain("background-color:#000000");
		expect(sample?.getAttribute("style")).toContain("border-color:#333333");
	});
});

describe("ExtensibilityPanel plugin settings", () => {
	test("renders canonical setting schemas without feature mutation controls", () => {
		const { document, Event } = parseHTML('<main id="root"></main>');
		globalThis.document = document;
		globalThis.window = document.defaultView ?? globalThis.window;
		globalThis.Event = Event;
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const container = document.getElementById("root");
		if (!container) throw new Error("Missing test root");
		mountedRoot = createRoot(container);
		const settingCalls: Array<[string, unknown]> = [];
		act(() =>
			mountedRoot?.render(
				<ExtensibilityPanel
					skills={[]}
					extensions={[]}
					plugins={plugins}
					activeTab="plugins"
					pluginInspection={
						{
							plugin: plugins[0],
							manifest: {
								features: { unsupported: true },
								settings: {
									mode: { type: "enum", values: ["safe", "fast"] },
									retries: { type: "number", min: 1, max: 3, step: 1 },
									enabled: { type: "boolean" },
									token: { type: "string", secret: true },
								},
							},
							settings: { mode: "safe", retries: 2, enabled: true, token: "masked" },
						} as never
					}
					loading={false}
					onRefresh={() => undefined}
					onInspectExtension={() => undefined}
					onInspectPlugin={() => undefined}
					onPluginSetting={(_, key, value) => settingCalls.push([key, value])}
				/>,
			),
		);
		expect(container.textContent).not.toContain("Features");
		const select = container.querySelector("select");
		if (!(select instanceof window.HTMLSelectElement)) throw new Error("Missing enum setting");
		expect(Array.from(select.options, option => option.value)).toEqual(["safe", "fast"]);
		const number = container.querySelector('input[type="number"]');
		if (!(number instanceof window.HTMLInputElement)) throw new Error("Missing number setting");
		expect(number.getAttribute("min")).toBe("1");
		expect(number.getAttribute("max")).toBe("3");
		act(() => {
			number.value = "NaN";
			number.dispatchEvent(new Event("focusout", { bubbles: true }));
		});
		expect(container.textContent).toContain("Enter a finite value within the allowed range and step.");
		expect(settingCalls).toEqual([]);
	});
});
