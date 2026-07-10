import type { AppServerClient, ServerNotificationEnvelope, ThreadSummary } from "@gajae-code/app-server-client";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { type AppHostDeps, createApp } from "../app/main.tsx";

export type HarnessScenario = "happy" | "failure" | "server-unavailable" | "token-rejected" | "inspect-error";

declare global {
	interface Window {
		__harnessScenario?: HarnessScenario;
		__harnessClipboard?: { writes: string[]; lastText?: string; writeText(text: string): Promise<void> };
	}
}

type NotificationListener = (notification: ServerNotificationEnvelope) => void;

type HarnessThread = ThreadSummary & { archived?: boolean; cwd?: string };

const MODEL_LABEL = "synthetic-provider/synthetic-model";

export function createHarnessDeps(scenario = readScenario()): AppHostDeps {
	const storage = new Map<string, string>();
	const client = new HarnessClient(scenario);
	const clipboard = createClipboard();
	return {
		resolveEndpoint: async () => {
			if (scenario === "server-unavailable" || scenario === "failure") throw new Error("server unavailable");
			if (scenario === "token-rejected") throw new Error("token rejected");
			return { url: "http://127.0.0.1:44111/rpc", token: "synthetic-token" };
		},
		createClient: ({ webSocketFactory }) => {
			webSocketFactory("ws://127.0.0.1:44111/rpc?token=synthetic-token");
			return client as unknown as AppServerClient;
		},
		createWebSocket: () => minimalWebSocket(),
		pickDirectory: async () => "/projects/demo-app",
		clipboard,
		storage: {
			getItem: key => storage.get(key) ?? null,
			setItem: (key, value) => storage.set(key, value),
		},
		timers: {
			setTimeout: window.setTimeout.bind(window),
			clearTimeout: window.clearTimeout.bind(window),
			requestAnimationFrame: window.requestAnimationFrame.bind(window),
		},
	};
}

class HarnessClient {
	#scenario: HarnessScenario;
	#listeners = new Set<NotificationListener>();
	#seq = 0;
	#threadCounter = 100;
	#turnCounter = 1;
	#threads: HarnessThread[] = [
		thread("thread-demo-active", "running", 2, "/projects/demo-app"),
		thread("thread-demo-review", "idle", 1, "/projects/demo-lib"),
		{ ...thread("thread-demo-archived", "archived", 1, "/projects/demo-archive"), archived: true },
	];

	constructor(scenario: HarnessScenario) {
		this.#scenario = scenario;
	}

	async connect(): Promise<void> {
		if (this.#scenario === "server-unavailable" || this.#scenario === "failure")
			throw new Error("server unavailable");
		if (this.#scenario === "token-rejected") throw new Error("token rejected");
	}

	async initialize() {
		return { platformFamily: "harness", platformOs: "browser", userAgent: "synthetic-harness" };
	}

	notify(): void {}

	onNotification(listener: NotificationListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {}

	async threadStart(params: { cwd?: string }) {
		const next = thread(`thread-demo-${this.#threadCounter++}`, "idle", 1, params.cwd ?? "/projects/demo-app");
		this.#threads = [next, ...this.#threads];
		return { thread: next };
	}

	async threadResume(params: { threadId: string }) {
		return { resumed: true, thread: this.#requireThread(params.threadId) };
	}

	async threadRead(params: { threadId: string }) {
		return { thread: this.#requireThread(params.threadId) };
	}

	async threadLoadedList() {
		return { data: this.#threads.map(thread => thread.id) };
	}

	async threadFork(params: { threadId: string }) {
		const source = this.#requireThread(params.threadId);
		const forked = {
			...thread(`thread-demo-fork-${this.#threadCounter++}`, "idle", 1, source.cwd),
			forkedFromId: source.id,
		};
		this.#threads = [forked, ...this.#threads];
		return { thread: forked };
	}

	async threadArchive(params: { threadId: string }) {
		this.#threads = this.#threads.map(item =>
			item.id === params.threadId ? { ...item, status: "archived", archived: true } : item,
		);
		return {};
	}

	async threadDelete(params: { threadId: string }) {
		this.#threads = this.#threads.filter(item => item.id !== params.threadId);
		return {};
	}

	async turnStart(params: { threadId: string }) {
		const turnId = `turn-demo-${this.#turnCounter++}`;
		this.#emitScript(params.threadId, turnId);
		return { turn: { id: turnId, status: "completed" } };
	}

	async turnInterrupt() {
		return {};
	}

	async gjcStateRead() {
		return { model: { provider: "synthetic-provider", id: "synthetic-model", label: MODEL_LABEL } };
	}

	async gjcCommandsList() {
		return {
			commands: [
				{ name: "/status", source: "synthetic", description: "Show synthetic status", classification: "safe" },
				{
					name: "/compact",
					source: "synthetic",
					description: "Compact the synthetic session",
					classification: "safe",
				},
			],
		};
	}

	async gjcToolsList() {
		return {
			tools: [
				{ name: "read", active: true, description: "Read synthetic project files" },
				{ name: "edit", active: true, description: "Preview a synthetic diff" },
			],
		};
	}

	async gjcSkillsList() {
		return {
			skills: [
				{ name: "demo-review", source: "project", description: "Synthetic review skill", enabled: true },
				{ name: "demo-plan", source: "user", description: "Synthetic planning skill", enabled: true },
			],
		};
	}

	async gjcExtensionsList() {
		return {
			extensions: [
				{ id: "ext.demo-theme", name: "Demo Theme", source: "synthetic", kind: "ui", status: "enabled" },
				{ id: "ext.demo-lint", name: "Demo Lint", source: "synthetic", kind: "analysis", status: "enabled" },
			],
		};
	}

	async gjcExtensionsInspect(params: { extensionId: string }) {
		if (this.#scenario === "inspect-error" || params.extensionId.includes("error"))
			throw new Error("synthetic extension inspect failure");
		return {
			extension: {
				id: params.extensionId,
				name: "Inspected Demo Extension",
				source: "synthetic",
				kind: "ui",
				status: "enabled",
			},
		};
	}

	async gjcPluginsList() {
		return {
			plugins: [
				{ id: "plugin.demo-vcs", name: "Demo VCS", source: "synthetic", kind: "mcp", status: "enabled" },
				{ id: "plugin.demo-ci", name: "Demo CI", source: "synthetic", kind: "automation", status: "disabled" },
			],
		};
	}

	async gjcPluginsInspect(params: { pluginId: string }) {
		if (this.#scenario === "inspect-error" || params.pluginId.includes("error"))
			throw new Error("synthetic plugin inspect failure");
		return {
			plugin: {
				plugin: {
					id: params.pluginId,
					name: "Inspected Demo Plugin",
					source: "synthetic",
					kind: "mcp",
					status: "enabled",
				},
				manifest: { name: "demo-plugin", permissions: ["read:/projects/demo-app"] },
				settings: { mode: "synthetic" },
			},
		};
	}

	async gjcModelSet(params: { provider: string; modelId: string }) {
		return { model: `${params.provider}/${params.modelId}` };
	}

	async gjcCompact() {
		return { compacted: true };
	}
	async gjcHostToolsResult() {
		return {};
	}
	async gjcHostUrisResult() {
		return {};
	}
	async gjcWorkflowGateRespond(params: { gate_id: string }) {
		return {
			gate_id: params.gate_id,
			status: "accepted",
			answer_hash: "synthetic-answer",
			resolved_at: "2026-07-09T00:00:00.000Z",
		};
	}

	#emitScript(threadId: string, turnId: string): void {
		const assistantId = `assistant-${turnId}`;
		const toolCallId = `call-${turnId}`;
		const toolItemId = `tool-output-${turnId}`;
		this.#emit({ method: "turn/started", params: { threadId, turnId, seq: this.#nextSeq() } });
		this.#emit({
			method: "item/started",
			params: { threadId, itemId: assistantId, itemType: "assistant_message", seq: this.#nextSeq() },
		});
		for (const delta of ["Harness reply: ", "created a synthetic plan, ", "ran a tool, and produced a diff.\n\n"]) {
			this.#emit({
				method: "item/agentMessage/delta",
				params: { threadId, itemId: assistantId, delta, seq: this.#nextSeq() },
			});
		}
		this.#emit({
			method: "gjc/hostTools/call",
			params: {
				threadId,
				turnId,
				callId: toolCallId,
				tool: "edit",
				args: { path: "/projects/demo-app/src/demo.ts", diff: "-old\n+new" },
				generation: 1,
			},
		});
		this.#emit({
			method: "item/started",
			params: {
				threadId,
				itemId: toolItemId,
				itemType: "tool_result",
				toolName: "edit",
				content:
					"output:\nApplied synthetic diff to /projects/demo-app/src/demo.ts\n--- a/src/demo.ts\n+++ b/src/demo.ts\n@@\n-old\n+new",
				seq: this.#nextSeq(),
			},
		});
		this.#emit({
			method: "item/completed",
			params: { threadId, itemId: toolItemId, itemType: "tool_result", seq: this.#nextSeq() },
		});
		this.#emit({
			method: "item/completed",
			params: { threadId, itemId: assistantId, itemType: "assistant_message", seq: this.#nextSeq() },
		});
		this.#emit({ method: "turn/completed", params: { threadId, turnId, status: "completed", seq: this.#nextSeq() } });
	}

	#emit(notification: ServerNotificationEnvelope): void {
		for (const listener of this.#listeners) listener(notification);
	}

	#nextSeq(): number {
		return ++this.#seq;
	}

	#requireThread(threadId: string): HarnessThread {
		const found = this.#threads.find(thread => thread.id === threadId);
		if (!found) throw new Error(`Unknown synthetic thread ${threadId}`);
		return found;
	}
}

function thread(id: string, status: ThreadSummary["status"], generation: number, cwd?: string): HarnessThread {
	return {
		id,
		status,
		generation,
		turns: [{ id: `${id}-turn`, cwd: cwd ?? "/projects/demo-app", model: MODEL_LABEL }],
		cwd,
	};
}

function createClipboard(): Pick<Clipboard, "writeText"> {
	const recorder = {
		writes: [] as string[],
		lastText: undefined as string | undefined,
		async writeText(text: string) {
			this.writes.push(text);
			this.lastText = text;
		},
	};
	window.__harnessClipboard = recorder;
	return typeof navigator !== "undefined" && "clipboard" in navigator ? navigator.clipboard : recorder;
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

function readScenario(): HarnessScenario {
	const fromWindow = typeof window !== "undefined" ? window.__harnessScenario : undefined;
	if (fromWindow) return fromWindow;
	const value = new URLSearchParams(window.location.search).get("scenario");
	if (value === "failure" || value === "server-unavailable" || value === "token-rejected" || value === "inspect-error")
		return value;
	return "happy";
}

export function HarnessApp() {
	return createApp({
		deps: createHarnessDeps(),
		autoConnect: true,
		initialState: { workingDirectory: "/projects/demo-app" },
	});
}

const root = typeof document === "undefined" ? null : document.getElementById("root");
if (root)
	createRoot(root).render(
		<React.StrictMode>
			<HarnessApp />
		</React.StrictMode>,
	);
