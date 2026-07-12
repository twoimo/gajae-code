import { describe, expect, test, vi } from "bun:test";
import { Agent } from "@gajae-code/agent-core";
import type { Model, ProviderSessionState } from "@gajae-code/ai";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const model = { provider: "test", id: "model", api: "openai-responses", name: "model" } as Model;

function createSession(): AgentSession {
	const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } });
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: { getAvailable: () => [], getApiKey: async () => "key" } as never,
	});
}

function state(close: ReturnType<typeof vi.fn>): ProviderSessionState {
	return { close } as ProviderSessionState;
}

describe("temporary provider-session suspension", () => {
	test("restores suspended state, supports LIFO nesting, and ignores stale tokens", () => {
		const session = createSession();
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));
		const outer = session.beginTemporaryProviderSessionScope("plan-mode");
		const outerMap = session.providerSessionState;
		expect(session.agent.providerSessionState).toBe(outerMap);
		expect(originalClose).not.toHaveBeenCalled();
		const outerClose = vi.fn();
		outerMap.set("outer", state(outerClose));
		const inner = session.beginTemporaryProviderSessionScope("profile-preview");
		const innerClose = vi.fn();
		session.providerSessionState.set("inner", state(innerClose));
		expect(session.restoreTemporaryProviderSessionScope(outer)).toBe(false);
		expect(session.restoreTemporaryProviderSessionScope(inner)).toBe(true);
		expect(innerClose).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState).toBe(outerMap);
		expect(session.restoreTemporaryProviderSessionScope(outer)).toBe(true);
		expect(outerClose).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("original")).toBe(true);
		expect(session.agent.providerSessionState).toBe(session.providerSessionState);
		expect(session.restoreTemporaryProviderSessionScope(outer)).toBe(false);
	});

	test("new session drains provider state and installs a new shared map", async () => {
		const session = createSession();
		const oldMap = session.providerSessionState;
		const oldClose = vi.fn();
		oldMap.set("old", state(oldClose));

		await session.newSession();

		expect(oldClose).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState).not.toBe(oldMap);
		expect(session.agent.providerSessionState).toBe(session.providerSessionState);
		expect(session.agent.providerSessionState).not.toBe(oldMap);
	});

	test("stale supplied scope after a permanent change cannot mutate the session", async () => {
		const session = createSession();
		const temporaryModel = { ...model, id: "temporary" } as Model;
		const permanentModel = { ...model, id: "permanent" } as Model;
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));
		const staleScope = session.beginTemporaryProviderSessionScope("plan-mode");
		const activeMap = session.providerSessionState;
		const activeClose = vi.fn();
		activeMap.set("active", state(activeClose));

		await session.setModel(permanentModel, "default", { cause: "user-selection" });
		await session.setModelTemporary(temporaryModel, undefined, {
			cause: "temporary-operation",
			providerSessionScope: staleScope,
		});

		expect(originalClose).toHaveBeenCalledTimes(1);
		expect(activeClose).not.toHaveBeenCalled();
		expect(session.model).toBe(permanentModel);
		expect(session.providerSessionState).toBe(activeMap);
		expect(session.agent.providerSessionState).toBe(activeMap);
		expect(session.sessionManager.buildSessionContext().models.default).toBe("test/permanent");
	});

	test("commit closes suspended state and disposal drains each map exactly once", async () => {
		const session = createSession();
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));
		const scope = session.beginTemporaryProviderSessionScope("temporary-cycle");
		const temporaryClose = vi.fn();
		session.providerSessionState.set("temporary", state(temporaryClose));
		expect(session.commitTemporaryProviderSessionScope(scope)).toBe(true);
		expect(originalClose).toHaveBeenCalledTimes(1);
		await session.dispose();
		expect(temporaryClose).toHaveBeenCalledTimes(1);
	});

	test("temporary model changes preserve the suspended map until a permanent change commits it", async () => {
		const session = createSession();
		const originalClose = vi.fn();
		session.providerSessionState.set("original", state(originalClose));

		await session.setModelTemporary(model, undefined, { cause: "temporary-operation", reason: "context-promotion" });
		expect(originalClose).not.toHaveBeenCalled();

		await session.setModel(model, "default", { cause: "user-selection" });
		expect(originalClose).toHaveBeenCalledTimes(1);
	});
});
