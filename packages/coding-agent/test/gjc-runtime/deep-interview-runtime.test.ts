import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("native gjc deep-interview runtime", () => {
	it("defaults to the SKILL.md default threshold (0.05) when no resolution flag or settings exist", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["my vague idea"], root);
		expect(result.status).toBe(0);
		const state = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "deep-interview-state.json"), "utf-8"),
		);
		expect(state.resolution).toBe("standard");
		expect(state.threshold).toBeCloseTo(0.05);
		expect(state.threshold_source).toBe("default");
		expect(state.state.initial_idea).toBe("my vague idea");
	});

	it("honors gjc.deepInterview.ambiguityThreshold in project .gjc/settings.json", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "settings.json"),
			JSON.stringify({ gjc: { deepInterview: { ambiguityThreshold: 0.08 } } }),
		);
		const result = await runNativeDeepInterviewCommand(["--standard", "--json", "idea"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.threshold).toBeCloseTo(0.08);
		expect(payload.threshold_source).toBe(path.join(root, ".gjc", "settings.json"));
	});

	it("--threshold beats project settings.json", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "settings.json"),
			JSON.stringify({ gjc: { deepInterview: { ambiguityThreshold: 0.08 } } }),
		);
		const result = await runNativeDeepInterviewCommand(
			["--threshold", "0.25", "--threshold-source", "flag:explicit", "--json", "idea"],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.threshold).toBeCloseTo(0.25);
		expect(payload.threshold_source).toBe("flag:explicit");
	});

	it("--quick / --standard / --deep map to their resolution thresholds", async () => {
		const root = await tempDir();
		const quick = await runNativeDeepInterviewCommand(["--quick", "--json", "idea"], root);
		expect(quick.status).toBe(0);
		expect(JSON.parse(quick.stdout ?? "{}").resolution).toBe("quick");
		expect(JSON.parse(quick.stdout ?? "{}").threshold).toBeCloseTo(0.6);

		const root2 = await tempDir();
		const deep = await runNativeDeepInterviewCommand(["--deep", "--json", "idea"], root2);
		expect(JSON.parse(deep.stdout ?? "{}").resolution).toBe("deep");
		expect(JSON.parse(deep.stdout ?? "{}").threshold).toBeCloseTo(0.35);
	});

	it("syncs deep-interview HUD chips for the active run", async () => {
		const root = await tempDir();
		await runNativeDeepInterviewCommand(["--standard", "idea body"], root);
		const active = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "skill-active-state.json"), "utf-8"),
		);
		const entry = (
			active.active_skills as Array<{
				skill: string;
				phase?: string;
				hud?: { chips?: Array<{ label: string; value?: string }> };
			}>
		).find(e => e.skill === "deep-interview");
		expect(entry).toBeTruthy();
		expect(entry?.phase).toBe("interviewing");
		const chips = entry?.hud?.chips ?? [];
		expect(chips.some(c => c.label === "phase" && c.value === "interviewing")).toBe(true);
		expect(chips.some(c => c.label === "ambiguity")).toBe(true);
	});

	it("rejects --threshold outside (0,1] with exit 2", async () => {
		const root = await tempDir();
		const tooBig = await runNativeDeepInterviewCommand(["--threshold", "1.5", "idea"], root);
		expect(tooBig.status).toBe(2);
		expect(tooBig.stderr).toContain("invalid --threshold");

		const negative = await runNativeDeepInterviewCommand(["--threshold", "-0.1", "idea"], root);
		expect(negative.status).toBe(2);
	});

	it("rejects combining multiple resolution flags with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--quick", "--deep", "idea"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("at most one");
	});

	it("rejects missing idea with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--standard"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("requires an idea");
	});

	it("rejects unknown flags with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--no-such-flag", "idea"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown flag");
	});
});
