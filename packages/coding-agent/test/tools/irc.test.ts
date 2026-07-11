import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { RalplanIrcCoordinator } from "@gajae-code/coding-agent/gjc-runtime/ralplan-irc-coordinator";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { modeStatePath } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { IrcTool } from "@gajae-code/coding-agent/tools/irc";

interface FakeSession {
	session: AgentSession;
	calls: Array<{ from: string; message: string; awaitReply: boolean }>;
	/** Override the reply this fake session generates. */
	setReply: (text: string) => void;
	/** Cause the next respondAsBackground call to throw. */
	setError: (error: Error) => void;
	/** Cause respondAsBackground to fail before the recipient acknowledges delivery. */
	setPreDeliveryError: (error: Error) => void;
	/** Resolve the next respondAsBackground call only when allowed. */
	gateNextCall: () => { release: () => void };
}

function makeFakeSession(): FakeSession {
	let nextReply = "auto-reply";
	let nextError: Error | null = null;
	let gate: { promise: Promise<void>; release: () => void } | null = null;
	let preDeliveryError: Error | null = null;
	const calls: Array<{ from: string; message: string; awaitReply: boolean }> = [];
	const session = {
		respondAsBackground: async (args: { from: string; message: string; awaitReply?: boolean; onDelivered?: () => void }) => {
			const awaitReply = args.awaitReply !== false;
			calls.push({ from: args.from, message: args.message, awaitReply });
			if (preDeliveryError) {
				const err = preDeliveryError;
				preDeliveryError = null;
				throw err;
			}
			args.onDelivered?.();
			if (gate) {
				const g = gate;
				gate = null;
				await g.promise;
			}
			if (nextError) {
				const err = nextError;
				nextError = null;
				throw err;
			}
			return { replyText: awaitReply ? nextReply : null };
		},
	};
	return {
		session: session as unknown as AgentSession,
		calls,
		setReply: text => {
			nextReply = text;
		},
		setError: error => {
			nextError = error;
		},
		setPreDeliveryError: error => {
			preDeliveryError = error;
		},
		gateNextCall: () => {
			let release!: () => void;
			const promise = new Promise<void>(resolve => {
				release = resolve;
			});
			gate = { promise, release };
			return { release };
		},
	};
}

function makeToolSession(registry: AgentRegistry, agentId: string, cwd = "/tmp"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function seedActiveIrcRun(): Promise<{ cwd: string; sessionId: string; runId: string }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-irc-bound-send-"));
	tempDirs.push(cwd);
	const sessionId = "parent";
	const result = await runNativeRalplanCommand(["--irc", "--json", "--session-id", sessionId, "seed IRC run"], cwd);
	expect(result.status).toBe(0);
	return { cwd, sessionId, runId: (JSON.parse(result.stdout ?? "{}") as { run_id: string }).run_id };
}

async function expectIrcDegraded(cwd: string, sessionId: string, reason: string): Promise<void> {
	const state = JSON.parse(await fs.readFile(modeStatePath(cwd, sessionId, "ralplan"), "utf8")) as Record<string, unknown>;
	expect(state).toMatchObject({ irc_degraded: true, irc_degrade_reason: reason });
}

describe("IrcTool", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	it("createIf returns null when irc is disabled", () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			agentRegistry: registry,
			getAgentId: () => "0-Main",
		};
		session.settings.set("irc.enabled", false);
		expect(IrcTool.createIf(session)).toBeNull();
	});

	it("createIf returns null without registry/agentId", () => {
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		expect(IrcTool.createIf(session)).toBeNull();
	});

	it("op=list returns peers visible to the caller", async () => {
		const main = makeFakeSession();
		const sub = makeFakeSession();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({
			id: "0-AuthLoader",
			displayName: "task",
			kind: "sub",
			parentId: "0-Main",
			session: sub.session,
		});

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-1", { op: "list" });
		expect(result.details?.op).toBe("list");
		expect(result.details?.peers).toEqual([
			{
				id: "0-AuthLoader",
				displayName: "task",
				kind: "sub",
				status: "running",
				parentId: "0-Main",
			},
		]);
		expect(result.details?.channels).toEqual(["all", "0-AuthLoader"]);
	});

	it("op=send DM returns the recipient's prose reply", async () => {
		const main = makeFakeSession();
		const sub = makeFakeSession();
		sub.setReply("pong");
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({
			id: "0-AuthLoader",
			displayName: "task",
			kind: "sub",
			parentId: "0-Main",
			session: sub.session,
		});

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-2", {
			op: "send",
			to: "0-AuthLoader",
			message: "ping",
		});
		expect(result.details?.delivered).toEqual(["0-AuthLoader"]);
		expect(result.details?.replies).toEqual([{ from: "0-AuthLoader", text: "pong" }]);
		expect(sub.calls).toEqual([{ from: "0-Main", message: "ping", awaitReply: true }]);
	});

	it("op=send returns immediately even when the recipient is mid-tool-call", async () => {
		// Simulate "blocked recipient": gateNextCall holds respondAsBackground
		// pending until we release it. From the sender's perspective the call
		// must still complete because the side-channel does not block on the
		// recipient's main loop in a real session.
		const main = makeFakeSession();
		const sub = makeFakeSession();
		sub.setReply("ok");
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Busy", displayName: "task", kind: "sub", parentId: "0-Main", session: sub.session });

		const gate = sub.gateNextCall();
		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const pending = tool.execute("call-3", { op: "send", to: "0-Busy", message: "are you there?" });
		// Release the gate after a microtask: the dispatch was already issued
		// even though the recipient was holding.
		setTimeout(() => gate.release(), 5);
		const result = await pending;
		expect(result.details?.delivered).toEqual(["0-Busy"]);
		expect(result.details?.replies).toEqual([{ from: "0-Busy", text: "ok" }]);
	});

	it("op=send to=all broadcasts (default no reply, only injection on each peer)", async () => {
		const main = makeFakeSession();
		const subA = makeFakeSession();
		const subB = makeFakeSession();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-A", displayName: "task", kind: "sub", parentId: "0-Main", session: subA.session });
		registry.register({ id: "0-B", displayName: "task", kind: "sub", parentId: "0-Main", session: subB.session });

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-4", { op: "send", to: "all", message: "anyone there?" });
		expect(new Set(result.details?.delivered)).toEqual(new Set(["0-A", "0-B"]));
		expect(result.details?.replies ?? []).toEqual([]);
		expect(subA.calls).toEqual([{ from: "0-Main", message: "anyone there?", awaitReply: false }]);
		expect(subB.calls).toEqual([{ from: "0-Main", message: "anyone there?", awaitReply: false }]);
	});

	it("op=send returns notFound when target is unknown", async () => {
		const main = makeFakeSession();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-5", { op: "send", to: "0-Ghost", message: "hi" });
		expect(result.details?.delivered ?? []).toEqual([]);
		expect(result.details?.notFound).toEqual(["0-Ghost"]);
	});

	it("op=send surfaces recipient errors as failed", async () => {
		const main = makeFakeSession();
		const sub = makeFakeSession();
		sub.setError(new Error("model unavailable"));
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		registry.register({ id: "0-Down", displayName: "task", kind: "sub", parentId: "0-Main", session: sub.session });

		const tool = new IrcTool(makeToolSession(registry, "0-Main"));
		const result = await tool.execute("call-6", { op: "send", to: "0-Down", message: "ping" });
		expect(result.details?.delivered ?? []).toEqual([]);
		expect(result.details?.failed).toEqual([{ id: "0-Down", error: "model unavailable" }]);
	});
	it("DM delivery failure latches canonical degradation for the active IRC run", async () => {
		const { cwd, sessionId, runId } = await seedActiveIrcRun();
		const main = makeFakeSession();
		const bad = makeFakeSession();
		bad.setPreDeliveryError(new Error("down"));
		const mainRegistration = registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		const badRegistration = registry.register({ id: "0-Bad", displayName: "bad", kind: "sub", session: bad.session });
		const coordinator = new RalplanIrcCoordinator({ registry, cwd });
		coordinator.startPass({ parentSessionId: sessionId, runId, stageN: 1, cursorGeneration: 1 });
		coordinator.bindRegisteredChild("0-Main", { parentSessionId: sessionId, runId, role: "planner", token: mainRegistration.token });
		coordinator.bindRegisteredChild("0-Bad", { parentSessionId: sessionId, runId, role: "critic", token: badRegistration.token });

		const result = await new IrcTool(makeToolSession(registry, "0-Main", cwd)).execute("x", { op: "send", to: "0-Bad", message: "ping" });
		expect(result.details?.failed).toEqual([{ id: "0-Bad", error: "down" }]);
		await expectIrcDegraded(cwd, sessionId, "delivery_failed");
	});

	it("partial broadcast delivery failure latches canonical degradation for the active IRC run", async () => {
		const { cwd, sessionId, runId } = await seedActiveIrcRun();
		const main = makeFakeSession();
		const good = makeFakeSession();
		const bad = makeFakeSession();
		bad.setPreDeliveryError(new Error("down"));
		const mainRegistration = registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		const goodRegistration = registry.register({ id: "0-Good", displayName: "good", kind: "sub", session: good.session });
		const badRegistration = registry.register({ id: "0-Bad", displayName: "bad", kind: "sub", session: bad.session });
		const coordinator = new RalplanIrcCoordinator({ registry, cwd });
		coordinator.startPass({ parentSessionId: sessionId, runId, stageN: 1, cursorGeneration: 1 });
		for (const [id, role, token] of [["0-Main", "planner", mainRegistration.token], ["0-Good", "architect", goodRegistration.token], ["0-Bad", "critic", badRegistration.token]] as const) {
			coordinator.bindRegisteredChild(id, { parentSessionId: sessionId, runId, role, token });
		}

		const result = await new IrcTool(makeToolSession(registry, "0-Main", cwd)).execute("x", { op: "send", to: "all", message: "ping" });
		expect(result.details?.delivered).toEqual(["0-Good"]);
		expect(result.details?.failed).toEqual([{ id: "0-Bad", error: "down" }]);
		await expectIrcDegraded(cwd, sessionId, "delivery_failed");
	});

	it("terminal peer reports unreachable and latches canonical degradation for the active IRC run", async () => {
		const { cwd, sessionId, runId } = await seedActiveIrcRun();
		const mainRegistration = registry.register({ id: "0-Main", displayName: "main", kind: "main", session: makeFakeSession().session });
		const terminal = makeFakeSession();
		const terminalRegistration = registry.register({ id: "0-Done", displayName: "done", kind: "sub", session: terminal.session });
		const coordinator = new RalplanIrcCoordinator({ registry, cwd });
		coordinator.startPass({ parentSessionId: sessionId, runId, stageN: 1, cursorGeneration: 1 });
		coordinator.bindRegisteredChild("0-Main", { parentSessionId: sessionId, runId, role: "planner", token: mainRegistration.token });
		coordinator.bindRegisteredChild("0-Done", { parentSessionId: sessionId, runId, role: "critic", token: terminalRegistration.token });
		registry.setStatus("0-Done", "completed", terminalRegistration.token);

		const result = await new IrcTool(makeToolSession(registry, "0-Main", cwd)).execute("x", { op: "send", to: "0-Done", message: "ping" });
		expect(result.details?.delivered ?? []).toEqual([]);
		await expectIrcDegraded(cwd, sessionId, "peer_unreachable");
	});

	it("unknown peer reports notFound and latches canonical degradation for the active IRC run", async () => {
		const { cwd, sessionId, runId } = await seedActiveIrcRun();
		const mainRegistration = registry.register({ id: "0-Main", displayName: "main", kind: "main", session: makeFakeSession().session });
		const coordinator = new RalplanIrcCoordinator({ registry, cwd });
		coordinator.startPass({ parentSessionId: sessionId, runId, stageN: 1, cursorGeneration: 1 });
		coordinator.bindRegisteredChild("0-Main", { parentSessionId: sessionId, runId, role: "planner", token: mainRegistration.token });

		const result = await new IrcTool(makeToolSession(registry, "0-Main", cwd)).execute("x", { op: "send", to: "ghost", message: "ping" });
		expect(result.details?.notFound).toEqual(["ghost"]);
		await expectIrcDegraded(cwd, sessionId, "peer_unreachable");
	});

	it("bound never-resolving recipient times out and latches canonical degradation for the active IRC run", async () => {
		const { cwd, sessionId, runId } = await seedActiveIrcRun();
		const main = makeFakeSession();
		const stuck = { respondAsBackground: () => new Promise(() => {}) } as unknown as AgentSession;
		const mainRegistration = registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
		const stuckRegistration = registry.register({ id: "0-Stuck", displayName: "stuck", kind: "sub", session: stuck });
		const coordinator = new RalplanIrcCoordinator({ registry, cwd, sendTimeoutMs: 5 });
		coordinator.startPass({ parentSessionId: sessionId, runId, stageN: 1, cursorGeneration: 1 });
		coordinator.bindRegisteredChild("0-Main", { parentSessionId: sessionId, runId, role: "planner", token: mainRegistration.token });
		coordinator.bindRegisteredChild("0-Stuck", { parentSessionId: sessionId, runId, role: "critic", token: stuckRegistration.token });

		const result = await new IrcTool(makeToolSession(registry, "0-Main", cwd)).execute("x", { op: "send", to: "0-Stuck", message: "ping" });
		expect(result.details?.failed).toEqual([{ id: "0-Stuck", error: "Ralplan IRC send timed out." }]);
		await expectIrcDegraded(cwd, sessionId, "send_timeout");
	});
	it("unbound generic IRC send preserves existing behavior and has no internal timer", async () => {
		const main = makeFakeSession(), peer = makeFakeSession(); const gate = peer.gateNextCall(); registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session }); registry.register({ id: "0-Peer", displayName: "peer", kind: "sub", session: peer.session }); const pending = new IrcTool(makeToolSession(registry, "0-Main")).execute("x", { op: "send", to: "0-Peer", message: "ping" }); await Bun.sleep(10); gate.release(); expect((await pending).details?.delivered).toEqual(["0-Peer"]);
	});
});
