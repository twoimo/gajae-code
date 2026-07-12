import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { modeStatePath } from "../src/gjc-runtime/session-layout";
import { syncSkillActiveState } from "../src/skill-state/active-state";
import { resolveWorkflowPhase } from "../src/skill-state/workflow-phase-resolver";

const roots: string[] = [];

async function project(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-phase-resolver-"));
	roots.push(cwd);
	return cwd;
}

async function durable(cwd: string, sessionId: string, state: unknown): Promise<void> {
	const statePath = modeStatePath(cwd, sessionId, "ralplan");
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, JSON.stringify(state));
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveWorkflowPhase", () => {
	test("accepts only matching immutable context and never falls through invalid context", async () => {
		const cwd = await project();
		await durable(cwd, "s", {
			version: 2,
			skill: "ralplan",
			session_id: "s",
			current_phase: "planner",
			active: true,
		});
		const accepted = await resolveWorkflowPhase({
			skill: "ralplan",
			cwd,
			sessionId: "s",
			explicit: { skill: "ralplan", phase: "architect", sessionId: "s", stateVersion: 2 },
		});
		expect(accepted).toMatchObject({ phase: "architect", source: "explicit", fragmentKind: "phase" });

		const rejected = await resolveWorkflowPhase({
			skill: "ralplan",
			cwd,
			sessionId: "s",
			explicit: { skill: "ralplan", phase: "unknown", sessionId: "s", stateVersion: 2 },
		});
		expect(rejected).toMatchObject({ source: "dispatcher-only", fragmentKind: "dispatcher" });
	});

	test("uses valid live state, accepts agreeing durable state, and rejects conflicts", async () => {
		const cwd = await project();
		await syncSkillActiveState({ cwd, sessionId: "s", skill: "ralplan", active: true, phase: "planner" });
		await durable(cwd, "s", {
			version: 2,
			skill: "ralplan",
			session_id: "s",
			current_phase: "planner",
			active: true,
		});
		expect(await resolveWorkflowPhase({ skill: "ralplan", cwd, sessionId: "s" })).toMatchObject({
			phase: "planner",
			source: "live",
		});
		await durable(cwd, "s", {
			version: 2,
			skill: "ralplan",
			session_id: "s",
			current_phase: "architect",
			active: true,
		});
		expect(await resolveWorkflowPhase({ skill: "ralplan", cwd, sessionId: "s" })).toMatchObject({
			source: "dispatcher-only",
		});
	});

	test("fails closed for absent, malformed, mismatched, inactive, unknown, and version-skewed durable state", async () => {
		const cwd = await project();
		const absent = await resolveWorkflowPhase({ skill: "ralplan", cwd, sessionId: "s" });
		expect(absent).toMatchObject({ source: "dispatcher-only" });
		for (const state of [
			"{",
			{ version: 2, skill: "team", session_id: "s", current_phase: "planner", active: true },
			{ version: 2, skill: "ralplan", session_id: "other", current_phase: "planner", active: true },
			{ version: 2, skill: "ralplan", session_id: "s", current_phase: "planner", active: false },
			{ version: 2, skill: "ralplan", session_id: "s", current_phase: "unknown", active: true },
			{ version: 1, skill: "ralplan", session_id: "s", current_phase: "planner", active: true },
		]) {
			const statePath = modeStatePath(cwd, "s", "ralplan");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(statePath, typeof state === "string" ? state : JSON.stringify(state));
			expect(await resolveWorkflowPhase({ skill: "ralplan", cwd, sessionId: "s" })).toMatchObject({
				source: "dispatcher-only",
			});
		}
	});
});
