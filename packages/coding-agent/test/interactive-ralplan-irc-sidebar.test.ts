import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { RalplanIrcLifecycleEvent } from "@gajae-code/coding-agent/gjc-runtime/ralplan-irc-coordinator";
import { IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const lifecycle = (type: RalplanIrcLifecycleEvent["type"]): RalplanIrcLifecycleEvent => ({
	type,
	parentSessionId: "session",
	runId: "run",
	stageN: 1,
});

describe("interactive ralplan IRC sidebar lifecycle", () => {
	let dir: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let notify: ((event: RalplanIrcLifecycleEvent) => void) | undefined;

	beforeEach(async () => {
		dir = TempDir.createSync("gjc-ralplan-irc-sidebar-");
		await Settings.init({ inMemory: true, cwd: dir.path() });
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		await initTheme();
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated({ "irc.enabled": true, "irc.sidebar.enabled": true }),
			modelRegistry: registry,
		});
		vi.spyOn(session, "onRalplanIrcLifecycle").mockImplementation(listener => {
			notify = listener;
			return () => {};
		});
		mode = new InteractiveMode(session, "test");
		await mode.init();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		auth?.close();
		dir?.removeSync();
		resetSettingsForTest();
	});

	function sidebar(): IrcSplitViewComponent {
		const split = mode.ui.children.find(child => child instanceof IrcSplitViewComponent);
		if (!split) throw new Error("Expected IRC split view");
		return split;
	}

	it("no --irc does not auto-open the IRC sidebar", () => {
		expect(sidebar().visible).toBe(false);
	});

	it("non-interactive --irc records deliberation without auto-opening the IRC sidebar", () => {
		mode.ircLedger.observe(
			{
				observationId: "non-interactive",
				kind: "incoming",
				from: "a",
				to: "b",
				text: "recorded",
				timestamp: Date.now(),
			},
			false,
		);
		expect(mode.ircLedger.getSidebarRecords()).toHaveLength(1);
		expect(sidebar().visible).toBe(false);
	});

	it("interactive IRC pass start opens the workflow-owned sidebar", () => {
		session.settings.set("irc.sidebar.enabled", false);
		notify?.(lifecycle("open"));
		expect(sidebar().visible).toBe(true);
	});

	it("IRC degradation closes the workflow-owned sidebar", () => {
		notify?.(lifecycle("open"));
		notify?.(lifecycle("close"));
		expect(sidebar().visible).toBe(false);
	});

	it("IRC completion and session reset release workflow sidebar ownership", () => {
		notify?.(lifecycle("open"));
		notify?.(lifecycle("close"));
		expect(sidebar().visible).toBe(false);
		notify?.(lifecycle("open"));
		mode.resetIrcSidebarSession();
		expect(sidebar().visible).toBe(false);
	});

	it("logical session reset clears manually requested sidebar visibility", () => {
		mode.toggleIrcSidebar();
		expect(sidebar().visible).toBe(true);
		mode.resetIrcSidebarSession();
		expect(sidebar().visible).toBe(false);
	});

	it("manual IRC sidebar toggle remains compatible before and after workflow ownership", () => {
		mode.toggleIrcSidebar();
		expect(sidebar().visible).toBe(true);
		notify?.(lifecycle("open"));
		mode.toggleIrcSidebar();
		expect(sidebar().visible).toBe(true);
		notify?.(lifecycle("close"));
		expect(sidebar().visible).toBe(false);
		mode.toggleIrcSidebar();
		expect(sidebar().visible).toBe(true);
	});

	it("boundary ask presents the interjection affordance and submits its text as a user message", async () => {
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue();
		vi.spyOn(mode, "showHookEditor").mockResolvedValue("Ask the parent to reconsider the rollout.");
		notify?.(lifecycle("open"));
		notify?.(lifecycle("boundary_ask_ready"));
		await Bun.sleep(0);
		expect(prompt).toHaveBeenCalledWith("Ask the parent to reconsider the rollout.", undefined);
	});

	it("does not prompt an interjection after workflow ownership is released", async () => {
		const ask = vi.spyOn(mode, "showHookEditor");
		notify?.(lifecycle("open"));
		notify?.(lifecycle("close"));
		notify?.(lifecycle("boundary_ask_ready"));
		await Bun.sleep(0);
		expect(ask).not.toHaveBeenCalled();
	});
});
