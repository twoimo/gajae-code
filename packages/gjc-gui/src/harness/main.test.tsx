import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { describeFailure } from "../app/connection-state-logic";
import { createApp, startChatDirectory } from "../app/main.tsx";
import {
	createHarnessDeps,
	HARNESS_CLIENT_METHODS,
	HarnessApp,
	HarnessClient,
	type HarnessScenario,
	readScenario,
} from "./main";

globalThis.window = {
	location: { search: "" },
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	},
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
} as unknown as Window & typeof globalThis;
globalThis.navigator = {} as Navigator;
globalThis.WebSocket = { OPEN: 1 } as typeof WebSocket;

function createHarnessClient() {
	return createHarnessDeps("happy").createClient({ webSocketFactory: () => ({}) as WebSocket });
}

async function rejectionFrom(action: () => Promise<unknown>): Promise<Error> {
	try {
		await action();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`Harness rejected with a non-Error value: ${String(error)}`);
	}
	throw new Error("Harness action was expected to reject.");
}

async function appClientMethodCalls(): Promise<Set<string>> {
	const source = await Bun.file(new URL("../app/main.tsx", import.meta.url)).text();
	const methods = new Set<string>();
	for (const match of source.matchAll(/\b(?:client|sessionClient|nextClient)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
		if (match[1]) methods.add(match[1]);
	}
	return methods;
}

describe("product harness", () => {
	test("renders the real chat, session, extensibility, and provider surfaces", () => {
		const html = renderToString(React.createElement(HarnessApp));
		expect(html).toContain("Desktop chat");
		expect(html).toContain("/projects/demo-app");
		expect(html).toContain("Persisted sessions");
		expect(html).toContain("Skills &amp; extensions");
		expect(html).toContain("Providers");
	});

	test("keeps the synthetic client aligned with calls extracted from the real app source", async () => {
		const client = createHarnessClient();
		const appMethods = await appClientMethodCalls();
		const manifest = new Set<string>(HARNESS_CLIENT_METHODS);
		expect(appMethods.size).toBeGreaterThan(0);
		for (const method of appMethods) {
			expect(manifest.has(method)).toBe(true);
			expect(Object.hasOwn(HarnessClient.prototype, method)).toBe(true);
		}
		for (const method of HARNESS_CLIENT_METHODS) {
			expect(Object.hasOwn(HarnessClient.prototype, method)).toBe(true);
			expect(typeof client[method]).toBe("function");
		}
	});

	test("selects deterministic scenarios from the query string and window override", () => {
		const previousSearch = window.location.search;
		const previousScenario = window.__harnessScenario;
		try {
			window.__harnessScenario = undefined;
			window.location.search = "?scenario=scratch";
			expect(readScenario()).toBe("scratch");
			window.location.search = "?scenario=clipboard-error";
			expect(readScenario()).toBe("clipboard-error");
			window.location.search = "?scenario=unknown";
			expect(readScenario()).toBe("happy");
			window.__harnessScenario = "token-rejected";
			expect(readScenario()).toBe("token-rejected");
		} finally {
			window.location.search = previousSearch;
			window.__harnessScenario = previousScenario;
		}
	});

	test("starts scratch blank and creates its first message in /tmp", async () => {
		const previousScenario = window.__harnessScenario;
		try {
			window.__harnessScenario = "scratch";
			const harnessHtml = renderToString(React.createElement(HarnessApp));
			expect(harnessHtml).toMatch(/<input[^>]*id="gjc-session-cwd"[^>]*value=""/);
			const deps = createHarnessDeps();
			expect(startChatDirectory("")).toBe("/tmp");

			const client = deps.createClient({ webSocketFactory: () => ({}) as WebSocket });
			expect((await client.threadLoadedList({})).data).toEqual([]);
			expect((await client.gjcSessionList({ scope: "all", limit: 100 })).sessions).toEqual([]);
			const started = await client.threadStart({ source: "gjc-gui" });
			await client.turnStart({ threadId: started.thread.id, text: "First synthetic scratch message" });
			expect((await client.gjcSessionList({ scope: "all", limit: 100 })).sessions).toEqual([
				expect.objectContaining({
					cwd: "/tmp",
					firstMessage: "First synthetic scratch message",
					id: started.thread.id,
				}),
			]);
		} finally {
			window.__harnessScenario = previousScenario;
		}
	});

	test("rejects clipboard writes without disconnecting the synthetic client", async () => {
		const deps = createHarnessDeps("clipboard-error");
		const client = deps.createClient({ webSocketFactory: () => ({}) as WebSocket });
		await expect(client.connect("ws://127.0.0.1:4178/rpc?token=harness")).resolves.toBeUndefined();
		await expect(deps.clipboard.writeText("synthetic copy")).rejects.toThrow("Synthetic clipboard write failed.");
		expect(window.__harnessClipboard?.writes).toEqual([]);
	});

	test("uses synthetic secrets that the connection error display redacts", async () => {
		const scenarios: Array<[HarnessScenario, "server-unavailable" | "token-rejected"]> = [
			["server-unavailable", "server-unavailable"],
			["token-rejected", "token-rejected"],
		];
		for (const [scenario, expectedFailure] of scenarios) {
			const deps = createHarnessDeps(scenario);
			const endpointError = await rejectionFrom(deps.resolveEndpoint);
			const client = deps.createClient({ webSocketFactory: () => ({}) as WebSocket });
			const clientError = await rejectionFrom(() => client.connect("ws://127.0.0.1:4178/rpc?token=harness"));
			expect(endpointError.message).toContain("synthetic-");
			expect(clientError.message).toBe(endpointError.message);

			const connection = describeFailure(endpointError);
			expect(connection.failure).toBe(expectedFailure);
			expect(connection.detail).toContain("[redacted]");
			expect(connection.detail).not.toContain("synthetic-");
			const html = renderToString(createApp({ deps, autoConnect: false, initialState: { connection } }));
			expect(html).toContain("[redacted]");
			expect(html).not.toContain(endpointError.message);
		}
	});

	test("keeps synthetic sessions and product mutations in memory", async () => {
		const client = createHarnessClient();
		const notifications: string[] = [];
		client.onNotification(notification => notifications.push(notification.method));

		const initial = await client.gjcSessionList({ scope: "all", limit: 100 });
		expect(initial.sessions).toHaveLength(3);
		const session = initial.sessions[0];
		if (!session) throw new Error("Harness requires a synthetic session fixture.");

		await client.gjcSessionRename({ sessionPath: session.path, title: "Renamed synthetic session" });
		const found = await client.gjcSessionSearch({ scope: "all", query: "renamed synthetic" });
		expect(found.total).toBe(1);
		expect(found.sessions[0]?.title).toBe("Renamed synthetic session");

		const opened = await client.gjcSessionOpen({ sessionPath: session.path });
		const tree = await client.gjcSessionTree({ threadId: opened.threadId });
		expect(tree.nodes[0]?.children[0]?.active).toBe(true);
		const exported = await client.gjcSessionExport({ sessionPath: session.path, format: "markdown", redact: true });
		expect(exported.content).toContain("[redacted]");

		await client.gjcSessionMove({ threadId: opened.threadId, targetCwd: "/projects/moved-demo" });
		const moved = await client.gjcSessionSearch({ scope: "all", query: "renamed synthetic" });
		const movedSession = moved.sessions[0];
		if (!movedSession) throw new Error("Moved synthetic session was not retained.");
		expect(movedSession.cwd).toBe("/projects/moved-demo");
		await client.gjcSessionDelete({ sessionPath: movedSession.path });
		expect((await client.gjcSessionSearch({ scope: "all", query: "renamed synthetic" })).total).toBe(0);

		const started = await client.threadStart({ source: "gjc-gui", cwd: "/projects/demo-app" });
		await client.turnStart({ threadId: started.thread.id, text: "Synthetic prompt" });
		expect(notifications).toContain("item/agentMessage/delta");

		await client.gjcAppearanceSet({ dark: "synthetic-light", light: "synthetic-light" });
		expect((await client.gjcAppearanceRead({})).dark).toBe("synthetic-light");
		await client.gjcSkillsSetEnabled({ skillId: "demo-review", enabled: false });
		expect((await client.gjcSkillsList({ threadId: started.thread.id })).skills[0]?.enabled).toBe(false);
		await client.gjcExtensionsSetEnabled({ extensionId: "ext.demo-theme", enabled: false });
		expect((await client.gjcExtensionsList({ threadId: started.thread.id })).extensions[0]?.state).toBe("disabled");
		await client.gjcPluginsSetEnabled({ pluginId: "plugin.demo-vcs", enabled: false });
		expect((await client.gjcPluginsList({ threadId: started.thread.id })).plugins[0]?.status).toBe("disabled");
		await client.gjcPluginsSetFeature({ pluginId: "plugin.demo-vcs", feature: "synthetic", enabled: true });
		await client.gjcPluginsSetSetting({ pluginId: "plugin.demo-vcs", key: "mode", value: "diagnostic" });
		expect(
			JSON.stringify(
				(await client.gjcPluginsInspect({ pluginId: "plugin.demo-vcs", threadId: started.thread.id })).plugin,
			),
		).toContain("diagnostic");

		await client.gjcProviderAdd({ providerId: "synthetic-added", apiKeyEnv: "SYNTHETIC_ADDED_KEY" });
		expect((await client.gjcProviderList({})).providers.some(provider => provider.id === "synthetic-added")).toBe(
			true,
		);
		await client.gjcAuthLogout({ providerId: "synthetic-provider" });
		expect(
			(await client.gjcAuthStatus({})).providers.find(provider => provider.providerId === "synthetic-provider")
				?.state,
		).toBe("unauthenticated");
		const login = await client.gjcAuthLoginStart({ providerId: "synthetic-oauth" });
		await client.gjcAuthLoginComplete({ flowId: login.flowId, redirectUrl: "https://synthetic.invalid/complete" });
		expect((await client.gjcAuthLoginPoll({ flowId: login.flowId })).state).toBe("authenticated");
	});
});
