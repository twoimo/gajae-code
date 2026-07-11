import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeRalplanCommand } from "../../src/gjc-runtime/ralplan-runtime";
import { modeStatePath } from "../../src/gjc-runtime/session-layout";

const roots: string[] = [];

async function root(): Promise<string> {
	const value = await fs.mkdtemp(path.join(os.tmpdir(), "ralplan-role-metadata-"));
	roots.push(value);
	return value;
}

async function writePlanner(cwd: string, id: string, resumable: boolean) {
	return await runNativeRalplanCommand(
		[
			"--write",
			"--stage",
			"planner",
			"--stage_n",
			"1",
			"--artifact",
			"# Plan",
			"--run-id",
			"role-run",
			"--session-id",
			"parent-session",
			"--planner-id",
			id,
			"--planner-resumable",
			String(resumable),
		],
		cwd,
	);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(value => fs.rm(value, { recursive: true, force: true })));
});

describe("ralplan IRC role first-write metadata", () => {
	it("persists runtime-derived role id and persistent resumability on the first artifact write", async () => {
		const cwd = await root();
		expect((await writePlanner(cwd, "1-Planner", true)).status).toBe(0);
		const state = JSON.parse(await fs.readFile(modeStatePath(cwd, "parent-session", "ralplan"), "utf8"));
		expect(state).toMatchObject({ planner_subagent_id: "1-Planner", planner_resumable: true });
	});

	it("persists ephemeral resumability as false", async () => {
		const cwd = await root();
		expect((await writePlanner(cwd, "1-Planner", false)).status).toBe(0);
		const state = JSON.parse(await fs.readFile(modeStatePath(cwd, "parent-session", "ralplan"), "utf8"));
		expect(state.planner_resumable).toBe(false);
	});

	it("rejects a later conflicting role write without changing the first recorded value", async () => {
		const cwd = await root();
		expect((await writePlanner(cwd, "1-Planner", true)).status).toBe(0);
		const result = await writePlanner(cwd, "2-Forged", false);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("refusing to overwrite recorded planner_subagent_id");
		const state = JSON.parse(await fs.readFile(modeStatePath(cwd, "parent-session", "ralplan"), "utf8"));
		expect(state).toMatchObject({ planner_subagent_id: "1-Planner", planner_resumable: true });
	});

	it("rejects mismatched role metadata before creating state or artifacts", async () => {
		const cwd = await root();
		const result = await runNativeRalplanCommand(
			[
				"--write",
				"--stage",
				"critic",
				"--stage_n",
				"3",
				"--artifact",
				"# Critic",
				"--run-id",
				"role-run",
				"--session-id",
				"parent-session",
				"--architect-id",
				"1-Architect",
				"--architect-resumable",
				"true",
			],
			cwd,
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("critic-stage write");
		expect(await fs.readdir(cwd)).toEqual([]);
	});
});
