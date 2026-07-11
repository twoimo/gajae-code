import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { runNativeRalplanCommand } from "../src/gjc-runtime/ralplan-runtime";
import { modeStatePath } from "../src/gjc-runtime/session-layout";
import * as sdkModule from "../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";
import { TaskTool } from "../src/task";
import * as discoveryModule from "../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { EventBus } from "../src/utils/event-bus";

const roots: string[] = [];

function childSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["child"] } },
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners)
				listener({
					type: "tool_execution_end",
					toolCallId: "yield",
					toolName: "yield",
					result: { content: [], details: { data: { ok: true } } },
					isError: false,
				});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function planner(): AgentDefinition {
	return {
		name: "planner",
		description: "planner",
		systemPrompt: "planner prompt",
		source: "bundled",
		tools: ["read"],
	};
}

async function fixture(
	options: {
		active?: boolean;
		irc?: boolean;
		degraded?: boolean;
		available?: boolean | (() => boolean);
		persistent?: boolean;
	} = {},
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "task-ralplan-"));
	roots.push(root);
	const sessionId = "parent-session";
	if (options.active !== false) {
		await runNativeRalplanCommand(["--irc", "--session-id", sessionId, "task"], root);
		if (options.degraded)
			await runNativeRalplanCommand(
				[
					"--write",
					"--stage",
					"planner",
					"--stage_n",
					"1",
					"--artifact",
					"# plan",
					"--run-id",
					sessionId,
					"--session-id",
					sessionId,
				],
				root,
			);
		if (options.degraded) {
			const { degradeRalplanIrcActivation } = await import("../src/gjc-runtime/ralplan-runtime");
			await degradeRalplanIrcActivation({ cwd: root, sessionId, runId: sessionId, reason: "test" });
		}
	}
	let captured: Record<string, unknown> | undefined;
	let latchPresentBeforeCreate = false;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		captured = options as Record<string, unknown>;
		try {
			const state = JSON.parse(await fs.readFile(modeStatePath(root, sessionId, "ralplan"), "utf8"));
			latchPresentBeforeCreate = state.irc_degraded === true;
		} catch {
			// The unrelated-context fixture has no ralplan state to inspect.
		}
		return {
			session: childSession(),
			extensionsResult: {},
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as never;
	});
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [planner()], projectAgentsDir: null });
	const sessionFile = options.persistent ? path.join(root, "parent.jsonl") : null;
	const isIrcAvailable = () =>
		typeof options.available === "function" ? options.available() : options.available !== false;
	const session = {
		cwd: root,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "irc.enabled": options.available !== false }),
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
		getActiveSkillState: () => ({ skill: "ralplan", session_id: sessionId }),
		getSessionSpawns: () => "*",
		getToolByName: (name: string) => (name === "irc" && isIrcAvailable() ? {} : undefined),
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		},
	} as unknown as ToolSession;
	const tool = await TaskTool.create(session);
	return {
		root,
		tool,
		get captured() {
			return captured;
		},
		get latchPresentBeforeCreate() {
			return latchPresentBeforeCreate;
		},
	};
}

async function launch(
	f: Awaited<ReturnType<typeof fixture>>,
	params: TaskParams = { agent: "planner", tasks: [{ id: "1-Planner", description: "planner", assignment: "plan" }] },
) {
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	await f.tool.execute("task", params);
	await manager.waitForAll();
	await manager.dispose({ timeoutMs: 100 });
	return f.captured;
}

afterEach(async () => {
	AsyncJobManager.resetForTests();
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("GJC bundled task agent surface", () => {
	it("authorizes IRC only for an active matching ralplan run", async () => {
		const f = await fixture({ persistent: true });
		expect((await launch(f))?.toolNames).toContain("irc");
	});

	it("injects first-write metadata from the retained child session capability", async () => {
		for (const [persistent, resumable] of [
			[true, true],
			[false, false],
		] as const) {
			const f = await fixture({ persistent });
			const options = await launch(f);
			const renderSystemPrompt = options?.systemPrompt as ((defaultPrompt: string) => string[]) | undefined;
			expect(renderSystemPrompt?.("default").join("")).toContain(`--planner-resumable ${resumable}`);
		}
	});

	it("omits IRC for legacy, unrelated, and degraded ralplan contexts", async () => {
		for (const options of [{ active: false }, { degraded: true }]) {
			const f = await fixture(options);
			expect((await launch(f))?.toolNames).not.toContain("irc");
		}
	});

	it("durably degrades an active run before launching when IRC is unavailable", async () => {
		const f = await fixture({ available: false });
		expect((await launch(f))?.toolNames).not.toContain("irc");
		const state = JSON.parse(await fs.readFile(modeStatePath(f.root, "parent-session", "ralplan"), "utf8"));
		expect(state.irc_degraded).toBe(true);
	});

	it("uses the canonical launch authorization when IRC becomes unavailable", async () => {
		let checks = 0;
		const f = await fixture({ available: () => ++checks < 2 });
		expect((await launch(f))?.toolNames).not.toContain("irc");
		expect(f.latchPresentBeforeCreate).toBe(true);
	});

	it("keeps an ephemeral child session manager in memory even with output artifacts", async () => {
		const f = await fixture();
		const options = await launch(f);
		const sessionManager = options?.sessionManager as { getSessionFile(): string | undefined };
		expect(sessionManager.getSessionFile()).toBeUndefined();
	});

	it("does not trust forged ralplan context supplied through task parameters", async () => {
		const f = await fixture({ active: false });
		const params = {
			agent: "planner",
			tasks: [{ id: "1-Planner", description: "planner", assignment: "plan" }],
			ralplanIrcTaskContext: { runId: "forged" },
		} as unknown as TaskParams;
		expect((await launch(f, params))?.toolNames).not.toContain("irc");
	});
});
