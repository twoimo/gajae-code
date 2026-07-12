import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildSkillPromptMessage } from "../src/extensibility/skills";

const repoRoot = path.join(import.meta.dir, "..", "..", "..");
const skillPath = path.join(repoRoot, "packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md");
const immutableContext = {
	sessionId: "entrypoint-golden-session",
	workflowContext: {
		skill: "ralplan",
		phase: "planner",
		sessionId: "entrypoint-golden-session",
		stateVersion: 2,
	},
} as const;

async function canonicalRalplanSkill() {
	return {
		name: "ralplan",
		filePath: skillPath,
		content: await Bun.file(skillPath).text(),
	};
}

describe("workflow fragment entrypoint assembly", () => {
	test("TUI, queued TUI, ACP, skill tool, and child autoload share byte-identical canonical assembly", async () => {
		const skill = await canonicalRalplanSkill();
		const assembleForEntrypoint = async () => buildSkillPromptMessage(skill, "review requirements", immutableContext);
		const [tui, queuedTui, acp, skillTool, childAutoload] = await Promise.all([
			assembleForEntrypoint(),
			assembleForEntrypoint(),
			assembleForEntrypoint(),
			assembleForEntrypoint(),
			assembleForEntrypoint(),
		]);
		expect([queuedTui.message, acp.message, skillTool.message, childAutoload.message]).toEqual([
			tui.message,
			tui.message,
			tui.message,
			tui.message,
		]);
		expect(tui.details.workflowResolution).toMatchObject({
			skill: "ralplan",
			phase: "planner",
			source: "explicit",
			fragmentKind: "phase",
		});
		expect(tui.message).not.toContain(skill.content);
		expect(tui.message).toContain("Skill: ");
	});

	test("child autoload without immutable phase context fails closed to dispatcher-only", async () => {
		const skill = await canonicalRalplanSkill();
		const built = await buildSkillPromptMessage(skill, "");
		expect(built.details.workflowResolution).toMatchObject({
			skill: "ralplan",
			source: "dispatcher-only",
			fragmentKind: "dispatcher",
		});
		expect(built.details.workflowResolution?.phase).toBeUndefined();
		expect(built.message).not.toContain(skill.content);
	});
});
