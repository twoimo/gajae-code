import { describe, expect, test } from "bun:test";
import type { AppServerClient } from "@gajae-code/app-server-client";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { type AppHostDeps, createApp, createAppHostDeps, type EndpointDescriptor, persistedSessionLabel } from "./main";

globalThis.window = {
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
} as unknown as Window & typeof globalThis;

function mockDeps(): AppHostDeps {
	const storageEntries = new Map<string, string>();
	const webSocket = minimalWebSocket();
	const client = minimalClient();
	return {
		resolveEndpoint: async (): Promise<EndpointDescriptor> => ({
			url: "http://127.0.0.1:1234/rpc",
			token: "test-token",
		}),
		createClient: ({ webSocketFactory }) => {
			webSocketFactory("ws://example");
			return client;
		},
		createWebSocket: () => webSocket,
		pickDirectory: async () => "/tmp/project",
		clipboard: { writeText: async () => undefined },
		storage: {
			getItem: key => storageEntries.get(key) ?? null,
			setItem: (key, value) => storageEntries.set(key, value),
		},
		timers: {
			setTimeout: ((handler: TimerHandler) => {
				if (typeof handler === "function") handler();
				return 1;
			}) as typeof globalThis.setTimeout,
			clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
			requestAnimationFrame: callback => {
				callback(0);
				return 1;
			},
		},
	};
}

function minimalWebSocket(): WebSocket {
	return {
		readyState: WebSocket.OPEN,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		close: () => undefined,
		send: () => undefined,
	} as unknown as WebSocket;
}

function minimalClient(
	overrides: Partial<Pick<AppServerClient, "connect" | "initialize" | "notify" | "onNotification" | "close">> = {},
): AppServerClient {
	const base: Pick<AppServerClient, "connect" | "initialize" | "notify" | "onNotification" | "close"> = {
		connect: async () => undefined,
		initialize: async () => ({ platformFamily: "test", platformOs: "test", userAgent: "test" }),
		notify: () => undefined,
		onNotification: () => () => undefined,
		close: () => undefined,
		...overrides,
	};
	return base as AppServerClient;
}
function visibleText(html: string): string {
	return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

describe("app host seams", () => {
	test("default host can be overridden for all dependency kinds", async () => {
		const deps = mockDeps();
		const host = createAppHostDeps(deps);
		expect(await host.resolveEndpoint()).toEqual({ url: "http://127.0.0.1:1234/rpc", token: "test-token" });
		expect(await host.pickDirectory()).toBe("/tmp/project");
		await expect(host.clipboard.writeText("copy")).resolves.toBeUndefined();
		host.storage.setItem("k", "v");
		expect(host.storage.getItem("k")).toBe("v");
		expect(host.timers.requestAnimationFrame(() => undefined)).toBe(1);
		expect(host.createWebSocket("ws://example")).toHaveProperty("send");
		expect(host.createClient({ webSocketFactory: host.createWebSocket })).toHaveProperty("connect");
	});

	test("autoConnect uses injected endpoint, websocket, and client seams", async () => {
		const calls: string[] = [];
		let connectedUrl: string | undefined;
		const endpoint: EndpointDescriptor = { url: "http://127.0.0.1:4321/rpc", token: "seam-token" };
		const webSocket = minimalWebSocket();
		const client = minimalClient({
			connect: async url => {
				calls.push("connect");
				connectedUrl = url;
			},
			initialize: async () => {
				calls.push("initialize");
				return { platformFamily: "test", platformOs: "test", userAgent: "test" };
			},
		});
		const deps: AppHostDeps = {
			...mockDeps(),
			resolveEndpoint: async () => {
				calls.push("resolveEndpoint");
				return endpoint;
			},
			createWebSocket: url => {
				calls.push(`createWebSocket:${url}`);
				return webSocket;
			},
			createClient: ({ webSocketFactory }) => {
				calls.push("createClient");
				webSocketFactory("ws://injected.example/socket");
				return client;
			},
		};

		const previousWindow = globalThis.window;
		const previousDocument = globalThis.document;
		const { document, window } = parseHTML('<main id="test-root"></main>');
		const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
		const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		(window.HTMLElement.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => undefined;
		globalThis.window = window as unknown as Window & typeof globalThis;
		globalThis.document = document as unknown as Document;
		const container = document.getElementById("test-root");
		if (!container) throw new Error("Missing app host test root");
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(createApp({ deps, autoConnect: true }));
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});
		} finally {
			await act(async () => root.unmount());
			globalThis.window = previousWindow;
			globalThis.document = previousDocument;
			if (previousActEnvironment === undefined) delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
			else actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		}

		expect(calls).toContain("resolveEndpoint");
		expect(calls).toContain("createClient");
		expect(calls).toContain("createWebSocket:ws://injected.example/socket");
		expect(calls).toContain("connect");
		expect(calls).toContain("initialize");
		expect(connectedUrl).toBe("http://127.0.0.1:4321/rpc?token=seam-token");
	});

	test("product smoke renders through test host without real Tauri or WebSocket", async () => {
		const html = renderToString(
			createApp({
				deps: mockDeps(),
				autoConnect: false,
				initialState: { connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" } },
			}),
		);
		expect(html).toContain("Desktop chat");
		expect(html).toContain("Start with a scratch chat");
	});

	test("initial help glossary renders copy without client calls", async () => {
		const calls: string[] = [];
		const client = minimalClient({
			connect: async () => {
				calls.push("connect");
			},
			initialize: async () => {
				calls.push("initialize");
				return { platformFamily: "test", platformOs: "test", userAgent: "test" };
			},
			notify: () => calls.push("notify"),
			onNotification: () => {
				calls.push("onNotification");
				return () => undefined;
			},
			close: () => calls.push("close"),
		});
		const html = renderToString(
			createApp({
				deps: { ...mockDeps(), createClient: () => client },
				autoConnect: false,
				initialState: {
					connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" },
					helpOpen: true,
				},
			}),
		);
		const text = visibleText(html);
		expect(text).toContain("Chat / session");
		expect(text).toContain("Scratch chat");
		expect(text).toContain("Project folder / working directory");
		expect(text).toContain("Compact");
		expect(text).toContain("Copy / Dump");
		expect(text).toContain("Approvals");
		expect(text).toContain("Coming later");
		expect(calls).toEqual([]);
	});

	test("first extensibility paint shows loading until catalogs finish loading", async () => {
		const html = renderToString(
			createApp({
				deps: mockDeps(),
				autoConnect: false,
				initialState: {
					connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" },
					workspaceView: "extensibility",
					transcript: {
						activeThreadId: "thread-ext",
						modelLabel: "anthropic/claude-sonnet-4",
						threads: [{ id: "thread-ext", title: "Catalog Thread", status: "idle", lastActivity: "idle" }],
						items: [],
						approvals: [],
						seq: 0,
					},
				},
			}),
		);
		expect(html).toContain("Loading catalogs");
		expect(html).not.toContain("No skills are installed");
	});

	test("booting first paint shows busy connection copy", async () => {
		const html = renderToString(createApp({ deps: mockDeps(), autoConnect: false }));
		expect(html).toContain("Gajae Code is opening the local chat connection.");
		expect(html).not.toContain("Connection unavailable");
	});

	test("clipboard failure keeps the app connected", async () => {
		const deps: AppHostDeps = {
			...mockDeps(),
			clipboard: {
				writeText: async () => {
					throw new Error("Clipboard API is unavailable");
				},
			},
		};
		const html = renderToString(
			createApp({
				deps,
				autoConnect: false,
				initialState: { connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" } },
			}),
		);
		expect(html).not.toContain("Connection error");
		expect(html).toContain("Start with a scratch chat");
	});
	test("redacts synthetic secrets from rendered approval surfaces", async () => {
		const html = renderToString(
			createApp({
				deps: mockDeps(),
				autoConnect: false,
				initialState: {
					connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc?token=secret-token" },
					transcript: {
						activeThreadId: "thread-secret",
						modelLabel: "test-model",
						threads: [{ id: "thread-secret", title: "thread-secret", status: "idle", lastActivity: "idle" }],
						items: [
							{
								id: "tool-secret",
								threadId: "thread-secret",
								role: "tool",
								status: "completed",
								content: "",
								tool: { name: "read", args: "token=secret-token", output: "Authorization: Bearer abc.def" },
							},
						],
						approvals: [
							{
								kind: "host-uri",
								id: "host-secret",
								threadId: "thread-secret",
								turnId: "turn-secret",
								operation: "read",
								url: "gjc://example.test/path?token=secret-token",
								content: "api_key=secret-key",
								contentPreview: "api_key=[redacted]",
								status: "pending",
								generation: 1,
							},
							{
								kind: "workflow-gate",
								id: "gate-secret",
								threadId: "thread-secret",
								gateKind: "approval",
								stage: "ultragoal",
								required: true,
								schema: { token: "secret-token" },
								context: { prompt: "approve Authorization: Bearer abc.def" },
								status: "pending",
								generation: 1,
							},
						],
						seq: 0,
					},
				},
			}),
		);
		expect(html).not.toContain("secret-token");
		expect(html).not.toContain("secret-key");
		expect(html).not.toContain("abc.def");
		expect(html).toContain("[redacted]");
		expect(html).toContain("api_key=[redacted]");
		expect(html).toContain("Copy and Dump export visible conversation content; the app adds no credentials.");
		expect(html).toContain('aria-describedby="copy-export-hint"');
	});

	test("deferred model and session controls render disabled without client mutation calls", async () => {
		const calls: string[] = [];
		const client = minimalClient({
			notify: () => calls.push("notify"),
		});
		const deps: AppHostDeps = {
			...mockDeps(),
			createClient: () => client,
		};
		const html = renderToString(
			createApp({
				deps,
				autoConnect: false,
				initialState: {
					connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" },
					transcript: {
						activeThreadId: "thread-deferred",
						modelLabel: "anthropic/claude-sonnet-4",
						threads: [{ id: "thread-deferred", title: "Deferred Thread", status: "idle", lastActivity: "idle" }],
						items: [],
						approvals: [],
						seq: 0,
					},
				},
			}),
		);
		expect(html).toContain("More model &amp; settings surfaces");
		expect(html).toContain("More session actions");
		expect(html).toContain("Execution state coming soon");
		expect(html).toContain("Provider sign-in");
		expect(html).toContain("Rename");
		expect(html).toContain("todos");
		expect(html).toContain('disabled=""');
		expect(calls).toEqual([]);
	});

	test("model and session deferred visible text stays user-facing", async () => {
		const html = renderToString(
			createApp({
				deps: mockDeps(),
				autoConnect: false,
				initialState: {
					connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" },
					transcript: {
						activeThreadId: "thread-copy",
						modelLabel: "anthropic/claude-sonnet-4",
						threads: [{ id: "thread-copy", title: "Copy Thread", status: "idle", lastActivity: "idle" }],
						items: [],
						approvals: [],
						seq: 0,
					},
				},
			}),
		);
		const text = visibleText(html);
		expect(text).not.toContain(" API");
		expect(text).not.toContain("runtime seam");
		expect(text).not.toContain("mutations deferred");
		expect(text).not.toContain("app-server");
	});
	test("renders plain transcript, approval, session, and copy-announcement labels", async () => {
		const html = renderToString(
			createApp({
				deps: mockDeps(),
				autoConnect: false,
				initialState: {
					connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" },
					recentDirectories: ["/Users/alice/projects/very-long-project-name"],
					transcript: {
						activeThreadId: "019f441e42da7000a8b12770d0522ada",
						modelLabel: "anthropic/claude-sonnet-4",
						threads: [
							{
								id: "019f441e42da7000a8b12770d0522ada",
								title: "019f441e-42da-7000-a8b1-2770d0522ada",
								status: "archived",
								lastActivity: "archived",
								cwd: "/Users/alice/projects/very-long-project-name",
							},
						],
						items: [
							{
								id: "assistant-running",
								threadId: "019f441e42da7000a8b12770d0522ada",
								role: "assistant",
								status: "running",
								content: "",
							},
							{
								id: "reasoning-running",
								threadId: "019f441e42da7000a8b12770d0522ada",
								role: "reasoning",
								status: "running",
								content: "",
							},
							{
								id: "tool-done",
								threadId: "019f441e42da7000a8b12770d0522ada",
								role: "tool",
								status: "completed",
								title: "write",
								content: "",
								tool: { name: "write", output: "+1|ok" },
							},
							{
								id: "tool-stop",
								threadId: "019f441e42da7000a8b12770d0522ada",
								role: "tool",
								status: "interrupted",
								title: "bash",
								content: "",
								tool: { name: "bash" },
							},
						],
						approvals: [
							{
								kind: "host-tool",
								id: "host-tool",
								threadId: "019f441e42da7000a8b12770d0522ada",
								turnId: "turn",
								tool: "edit",
								args: {},
								status: "pending",
								generation: 1,
							},
							{
								kind: "workflow-gate",
								id: "gate",
								threadId: "019f441e42da7000a8b12770d0522ada",
								gateKind: "question",
								stage: "ralplan",
								required: true,
								schema: {},
								context: {},
								status: "pending",
								generation: 1,
							},
						],
						seq: 0,
					},
				},
			}),
		);
		const text = visibleText(html);
		expect(text).toContain("d0522ada · archived");
		expect(text).toContain("very-long-project-name");
		expect(html).toContain('title="~/projects/very-long-project-name"');
		expect(text).toContain("Writing…");
		expect(text).toContain("Thinking");
		expect(text).toContain("Done");
		expect(text).toContain("Stopped");
		expect(text).toContain("Host tool approval · Waiting");
		expect(text).toContain("Workflow gate · Respond in terminal app");
		expect(text).toContain("respond in the terminal app to continue");
		expect(html).toContain('class="copy-status" role="status" aria-live="polite"');
		expect(html).not.toContain('class="transcript" aria-live');
	});

	test("thread label redacts exact home-directory cwd", async () => {
		const html = renderToString(
			createApp({
				deps: mockDeps(),
				autoConnect: false,
				initialState: {
					connection: { kind: "connected", endpointUrl: "http://127.0.0.1:1234/rpc" },
					transcript: {
						activeThreadId: undefined,
						modelLabel: "test-model",
						threads: [
							{
								id: "thread-posix",
								title: "thread-posix",
								status: "idle",
								lastActivity: "idle",
								cwd: "/Users/realname",
							},
							{
								id: "thread-win",
								title: "thread-win",
								status: "idle",
								lastActivity: "idle",
								cwd: "C:\\Users\\alice",
							},
						],
						items: [],
						approvals: [],
						seq: 0,
					},
				},
			}),
		);
		const text = visibleText(html);
		expect(text).not.toContain("realname");
		expect(text).not.toContain("alice");
	});

	test("persisted session labels redact home paths in titles and first messages", async () => {
		expect(
			persistedSessionLabel({
				title: "Investigate /Users/alice/secret-project failure",
				firstMessage: undefined,
				id: "session-title",
			}),
		).toBe("Investigate ~/secret-project failure");
		expect(
			persistedSessionLabel({
				title: undefined,
				firstMessage: "Open C:\\Users\\alice\\secret-project",
				id: "session-message",
			}),
		).toBe("Open ~\\secret-project");
	});
});
