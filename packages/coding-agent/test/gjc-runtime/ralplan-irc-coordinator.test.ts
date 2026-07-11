import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { RalplanIrcCoordinator } from "@gajae-code/coding-agent/gjc-runtime/ralplan-irc-coordinator";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { IrcTool } from "@gajae-code/coding-agent/tools/irc";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function root() { const value = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-g004-")); roots.push(value); return value; }
function toolSession(registry: AgentRegistry, id: string, sessionId: string): ToolSession { return { cwd: "/tmp", hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings: Settings.isolated(), agentRegistry: registry, getAgentId: () => id, getSessionId: () => sessionId }; }
function child(registry: AgentRegistry, id: string, role: "planner" | "architect" | "critic", coordinator: RalplanIrcCoordinator, parent = "parent", run = "run") { const registration = registry.register({ id, displayName: role, kind: "sub", parentId: "0-Main", session: null }); expect(coordinator.bindRegisteredChild(id, { parentSessionId: parent, runId: run, role, token: registration.token })).toBe(true); registry.attachSession(id, {} as AgentSession, registration.token); return registration; }
async function completePass(c: RalplanIrcCoordinator, registry: AgentRegistry, cursor: { parentSessionId: string; runId: string; stageN: number; cursorGeneration: number }, body: string): Promise<string> {
	expect(c.startPass(cursor)).toBe(true);
	child(registry, `planner-${cursor.cursorGeneration}`, "planner", c, cursor.parentSessionId, cursor.runId);
	child(registry, `architect-${cursor.cursorGeneration}`, "architect", c, cursor.parentSessionId, cursor.runId);
	child(registry, `critic-${cursor.cursorGeneration}`, "critic", c, cursor.parentSessionId, cursor.runId);
	c.recordDelivery({ from: `critic-${cursor.cursorGeneration}`, to: `planner-${cursor.cursorGeneration}`, body: "review", delivered: true });
	c.recordObservation({ observationId: `observation-${cursor.cursorGeneration}`, from: `critic-${cursor.cursorGeneration}`, to: `planner-${cursor.cursorGeneration}`, body, kind: "message", timestamp: cursor.cursorGeneration });
	const transcript = c.endPass(cursor);
	expect(transcript).toBeDefined();
	return transcript!;
}

async function seedIrcRun(cwd: string): Promise<string> {
	const result = await runNativeRalplanCommand(["--irc", "--json", "--session-id", "parent", "task"], cwd);
	return JSON.parse(result.stdout!).run_id;
}

describe("RalplanIrcCoordinator", () => {
 it("role caller cannot invoke any ralplan control operation", async () => { const registry = new AgentRegistry(); new RalplanIrcCoordinator({ registry, cwd: await root() }); for (const op of ["ralplan_pass_start", "ralplan_pass_end", "ralplan_status", "ralplan_report_failure", "ralplan_activation_degrade"] as const) { const result = await new IrcTool(toolSession(registry, "1-Planner", "parent")).execute("x", { op, runId: "run", stageN: 1, cursorGeneration: 1 }); expect(result.content[0]?.text).toContain("restricted"); } });
 it("spoofed run id wrong owner and stale cursor are rejected without mutation", async () => { const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd: await root() }); expect(c.startPass({ parentSessionId: "parent", runId: "run", stageN: 2, cursorGeneration: 4 })).toBe(true); expect(c.endPass({ parentSessionId: "other", runId: "run", stageN: 2, cursorGeneration: 4 })).toBeUndefined(); expect(c.endPass({ parentSessionId: "parent", runId: "spoof", stageN: 2, cursorGeneration: 4 })).toBeUndefined(); expect(c.endPass({ parentSessionId: "parent", runId: "run", stageN: 2, cursorGeneration: 3 })).toBeUndefined(); expect(c.state).toBe("awaiting_attachments"); });
 it("pre-pass activation degradation is main-only and requires matching active run", async () => { const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd: await root() }); c.startPass({ parentSessionId: "parent", runId: "run", stageN: 1, cursorGeneration: 1 }); c.close(); expect(await c.activationDegrade({ parentSessionId: "other", runId: "run", reason: "x" })).toBe(false); expect(await c.activationDegrade({ parentSessionId: "parent", runId: "wrong", reason: "x" })).toBe(false); });
 it("child binding routes delivery and relay without role-supplied run data", async () => { const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd: await root() }); c.startPass({ parentSessionId: "parent", runId: "run", stageN: 1, cursorGeneration: 1 }); child(registry, "1-Planner", "planner", c); child(registry, "2-Architect", "architect", c); child(registry, "3-Critic", "critic", c); expect(c.state).toBe("awaiting_required_dm"); c.recordDelivery({ from: "3-Critic", to: "1-Planner", body: "review", delivered: true }); expect(c.state).toBe("deliberation_open"); expect(c.transcript).toHaveLength(0); });
 it("deduplicates observation IDs while preserving arrival sequence", async () => { const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd: await root() }); const cursor = { parentSessionId: "parent", runId: "run", stageN: 1, cursorGeneration: 1 }; c.startPass(cursor); child(registry, "planner", "planner", c); child(registry, "critic", "critic", c); c.recordObservation({ observationId: "later", from: "critic", to: "planner", body: "second", kind: "message", timestamp: 2 }); c.recordObservation({ observationId: "earlier", from: "critic", to: "planner", body: "first", kind: "message", timestamp: 1 }); c.recordObservation({ observationId: "later", from: "critic", to: "planner", body: "duplicate", kind: "message", timestamp: 3 }); expect(c.transcript.map(x => [x.observationId, x.sequence])).toEqual([["later", 1], ["earlier", 2]]); expect(c.renderTranscript()).toContain("second"); expect(c.renderTranscript()).toContain("first");
 });

 it("two concurrent parent runs cannot cross-contaminate or cross-degrade", async () => { const registry = new AgentRegistry(); const a = new RalplanIrcCoordinator({ registry, cwd: await root() }); const b = new RalplanIrcCoordinator({ registry, cwd: await root() }); a.startPass({ parentSessionId: "a", runId: "a", stageN: 1, cursorGeneration: 1 }); b.startPass({ parentSessionId: "b", runId: "b", stageN: 1, cursorGeneration: 1 }); expect(a.bindRegisteredChild("x", { parentSessionId: "b", runId: "b", role: "planner", token: Symbol() })).toBe(false); expect(await a.reportFailure({ parentSessionId: "b", runId: "b", stageN: 1, cursorGeneration: 1, reason: "x" })).toBe(false); expect(a.state).toBe("awaiting_attachments"); });
 it("late event after close or generation change is ignored", async () => { const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd: await root() }); c.startPass({ parentSessionId: "parent", runId: "run", stageN: 1, cursorGeneration: 1 }); const p = child(registry, "1-Planner", "planner", c); c.close(); registry.attachSession("1-Planner", {} as AgentSession, p.token); expect(c.state).toBe("closed"); expect(c.transcript).toHaveLength(0); });
 it("resume failure report freezes pass closes UI and latches degradation", async () => { const cwd = await root(); const previous = process.env.GJC_SESSION_ID; process.env.GJC_SESSION_ID = "parent"; try { const seed = await runNativeRalplanCommand(["--irc", "--json", "--session-id", "parent", "task"], cwd); const run = JSON.parse(seed.stdout!).run_id; const events: string[] = []; const c = new RalplanIrcCoordinator({ registry: new AgentRegistry(), cwd, onLifecycle: e => events.push(e.type) }); c.startPass({ parentSessionId: "parent", runId: run, stageN: 1, cursorGeneration: 1 }); expect(await c.reportFailure({ parentSessionId: "parent", runId: run, stageN: 1, cursorGeneration: 1, reason: "resume_failed" })).toBe(true); expect(c.state).toBe("degraded"); expect(events).toContain("close"); } finally { if (previous === undefined) delete process.env.GJC_SESSION_ID; else process.env.GJC_SESSION_ID = previous; } });
 it("deliberation write failure report freezes pass and latches degradation", async () => { const cwd = await root(); const previous = process.env.GJC_SESSION_ID; process.env.GJC_SESSION_ID = "parent"; try { const seed = await runNativeRalplanCommand(["--irc", "--json", "--session-id", "parent", "task"], cwd); const run = JSON.parse(seed.stdout!).run_id; const c = new RalplanIrcCoordinator({ registry: new AgentRegistry(), cwd }); c.startPass({ parentSessionId: "parent", runId: run, stageN: 1, cursorGeneration: 1 }); await c.reportFailure({ parentSessionId: "parent", runId: run, stageN: 1, cursorGeneration: 1, reason: "deliberation_write_failed" }); const state = JSON.parse(await fs.readFile(path.join(cwd, ".gjc", "_session-parent", "state", "ralplan-state.json"), "utf8")); expect(state.irc_degraded).toBe(true); expect(c.state).toBe("degraded"); } finally { if (previous === undefined) delete process.env.GJC_SESSION_ID; else process.env.GJC_SESSION_ID = previous; } });
 it("rejects pass end before deliberation opens", async () => { const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd: await root() }); const cursor = { parentSessionId: "parent", runId: "run", stageN: 1, cursorGeneration: 1 }; expect(c.startPass(cursor)).toBe(true); expect(c.endPass(cursor)).toBeUndefined(); expect(c.state).toBe("awaiting_attachments"); });
	it("rejects a self-consistent deliberation artifact whose content differs from the completed transcript", async () => {
		const cwd = await root(); const runId = await seedIrcRun(cwd); const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd }); const cursor = { parentSessionId: "parent", runId, stageN: 1, cursorGeneration: 1 };
		await completePass(c, registry, cursor, "expected transcript");
		expect((await runNativeRalplanCommand(["--write", "--stage", "deliberation", "--stage_n", "1", "--run-id", runId, "--session-id", "parent", "--artifact", "wrong content"], cwd)).status).toBe(0);
		expect(await c.recordDeliberationReceipt(cursor)).toBe(false);
	});
	it("rejects a prior generation's deliberation artifact at the same stage", async () => {
		const cwd = await root(); const runId = await seedIrcRun(cwd); const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd }); const first = { parentSessionId: "parent", runId, stageN: 1, cursorGeneration: 1 };
		const firstTranscript = await completePass(c, registry, first, "first generation");
		expect((await runNativeRalplanCommand(["--write", "--stage", "deliberation", "--stage_n", "1", "--run-id", runId, "--session-id", "parent", "--artifact", firstTranscript], cwd)).status).toBe(0);
		const second = { ...first, cursorGeneration: 2 }; await completePass(c, registry, second, "second generation");
		expect(await c.recordDeliberationReceipt(second)).toBe(false);
	});
	it("accepts the canonical artifact for the just-completed transcript", async () => {
		const cwd = await root(); const runId = await seedIrcRun(cwd); const registry = new AgentRegistry(); const c = new RalplanIrcCoordinator({ registry, cwd }); const cursor = { parentSessionId: "parent", runId, stageN: 1, cursorGeneration: 1 };
		const transcript = await completePass(c, registry, cursor, "expected transcript");
		expect((await runNativeRalplanCommand(["--write", "--stage", "deliberation", "--stage_n", "1", "--run-id", runId, "--session-id", "parent", "--artifact", transcript], cwd)).status).toBe(0);
		expect(await c.recordDeliberationReceipt(cursor)).toBe(true);
	});
});
