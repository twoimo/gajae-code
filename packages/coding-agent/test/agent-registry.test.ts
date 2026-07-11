import { describe, expect, it } from "bun:test";
import { AgentRegistry, DuplicateLiveAgentIdError, type AgentRegistrationToken } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";

function register(registry: AgentRegistry, id = "1-Worker") {
	return registry.register({
		id,
		displayName: "worker",
		kind: "sub",
		session: null,
	});
}

const session = {} as AgentSession;

describe("AgentRegistry", () => {
	it("attached event carries the exact registration token", () => {
		const registry = new AgentRegistry();
		const registration = register(registry);
		const events: Array<{ token: AgentRegistrationToken; id: string }> = [];
		registry.onChange(event => {
			if (event.type === "attached") events.push({ id: event.id, token: event.token });
		});

		registry.attachSession("1-Worker", session, registration.token);
		registry.attachSession("1-Worker", session, registration.token);

		expect(events).toEqual([{ id: "1-Worker", token: registration.token }]);
	});

	it("silent pre-registration with null session cannot satisfy an attachment wait", () => {
		const registry = new AgentRegistry();
		let attached = 0;
		registry.onChange(event => {
			if (event.type === "attached") attached += 1;
		});
		const registration = register(registry);

		expect(registry.get("1-Worker")?.session).toBeNull();
		expect(attached).toBe(0);

		registry.attachSession("1-Worker", session, registration.token);
		expect(attached).toBe(1);
	});

	it("rejects duplicate live registrations without replacing the current generation", () => {
		const registry = new AgentRegistry();
		const first = register(registry);
		registry.attachSession("1-Worker", {} as AgentSession, first.token);
		expect(() => register(registry)).toThrow(DuplicateLiveAgentIdError);
		expect(registry.get("1-Worker")?.session).not.toBeNull();
	});

	it("token-mismatched detach and unregister are rejected without mutation", () => {
		const registry = new AgentRegistry();
		const registration = register(registry);
		registry.attachSession("1-Worker", session, registration.token);

		registry.detachSession("1-Worker", Symbol("wrong"));
		registry.unregister("1-Worker", Symbol("wrong"));
		registry.setStatus("1-Worker", "idle", Symbol("wrong"));

		expect(registry.get("1-Worker")?.session).toBe(session);
		expect(registry.get("1-Worker")?.status).toBe("running");
	});
});
