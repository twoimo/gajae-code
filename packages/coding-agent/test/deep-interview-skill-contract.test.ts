import { describe, expect, it } from "bun:test";
import { getEmbeddedDefaultGjcSkillFragments } from "../src/defaults/gjc-defaults";
import { assembleWorkflowFragments, getWorkflowFragmentDefinitions } from "../src/extensibility/workflow-fragments";

const runtimeFragments = getWorkflowFragmentDefinitions().filter(fragment => fragment.skill === "deep-interview");
const staticFragments = getEmbeddedDefaultGjcSkillFragments("deep-interview");
const skill = runtimeFragments.map(fragment => fragment.content).join("\n");
const bundledRoleNames = new Set(["architect", "critic", "executor", "planner"]);

function phaseContent(phase: string): string {
	const fragment = runtimeFragments.find(candidate => candidate.phase === phase);
	if (fragment === undefined) throw new Error(`missing deep-interview ${phase} fragment`);
	return fragment.content;
}

describe("deep-interview fragment assembly contract", () => {
	it("keeps the dispatcher and runtime phase selection unchanged", () => {
		expect(runtimeFragments.map(fragment => fragment.phase)).toEqual([
			"dispatcher",
			"threshold-suitability",
			"initialize-topology",
			"interviewing",
			"closure-spec",
			"handoff",
		]);

		for (const [state, phase] of [
			["interviewing", "interviewing"],
			["handoff", "handoff"],
			["complete", "closure-spec"],
		] as const) {
			const assembly = assembleWorkflowFragments("deep-interview", state);
			expect(assembly.fragmentIds).toEqual(["deep-interview/dispatcher", `deep-interview/${phase}`]);
		}
	});

	it("uses final-User-line guidance and supported role vocabulary throughout the static fragment corpus", () => {
		expect(phaseContent("threshold-suitability")).toContain(
			"default to English unless the final `User:` line makes another user/session language obvious",
		);
		expect(phaseContent("initialize-topology")).toContain("final `User:` line");
		expect(staticFragments).toHaveLength(9);

		for (const fragment of staticFragments) {
			expect(fragment.content).not.toContain("{{ARGUMENTS}}");
			expect(fragment.content).not.toMatch(/\banalyst\b/i);
			for (const role of fragment.content.matchAll(/\b(architect|critic|executor|planner|analyst)\b/gi)) {
				expect(bundledRoleNames.has(role[1].toLowerCase())).toBe(true);
			}
		}
	});
});

describe("deep-interview skill conflict-aware scoring contract", () => {
	it("documents the ambiguity-raising triggers and established facts", () => {
		for (const required of [
			"A direct contradiction",
			"B internal inconsistency",
			"C low-quality/evasive",
			"D scope expansion",
			"established_facts",
		]) {
			expect(skill).toContain(required);
		}
	});

	it("documents bidirectional scoring mechanism A without a penalty term", () => {
		expect(skill).toMatch(/BIDIRECTIONAL/i);
		expect(skill).toMatch(/NON-MONOTONIC/i);
		expect(skill).toMatch(/mechanism A/i);
		expect(skill).toMatch(/no separate penalty term/i);
	});

	it("requires structured scorer output for conflict transitions", () => {
		expect(skill).toMatch(/Structured scorer output is required/i);
		for (const required of [
			"affected_dimension",
			"prior_ambiguity",
			"new_ambiguity",
			"contradicted_established_fact",
		]) {
			expect(skill).toContain(required);
		}
	});

	it("reports ambiguity direction and validates trigger transitions", () => {
		expect(skill).toContain("{prior_score}% -> {score}% {up|down|flat}");
		expect(skill).toMatch(/TRANSITION VALIDATION/i);
		expect(skill).toMatch(
			/trigger is present, the affected dimension must not improve and overall ambiguity must rise/i,
		);
	});

	it("documents convergence pacing as deferred", () => {
		expect(skill).toMatch(/Convergence Pacing deferral/i);
		expect(skill).toMatch(/min-round floor, score-drop cap, (confidence )?dampening/i);
		expect(skill).toMatch(/Bidirectional scoring is the pacing mechanism/i);
	});
});

describe("deep-interview simple-request escape hatch", () => {
	it("stops before interview state, Round 0, or spec writing when the request is already clear and small", () => {
		const suitabilityGate = phaseContent("threshold-suitability");
		const initialize = phaseContent("initialize-topology");

		expect(suitabilityGate.indexOf("## Phase 0.5: Suitability Gate")).toBeGreaterThanOrEqual(0);
		expect(initialize.indexOf("## Phase 1: Initialize")).toBeGreaterThanOrEqual(0);
		expect(initialize.indexOf("## Round 0: Topology Enumeration Gate")).toBeGreaterThanOrEqual(0);
		expect(suitabilityGate).toMatch(/clear,\s+bounded,\s+low-risk/i);
		expect(suitabilityGate).toContain("gjc state read --mode deep-interview --json");
		expect(suitabilityGate).toContain("gjc state clear --force --mode deep-interview");
		expect(suitabilityGate).toMatch(/newly seeded empty interview/i);
		expect(suitabilityGate).toMatch(/no recorded `rounds`[\s\S]*no `spec_path`[\s\S]*no `handoff_from`/i);
		expect(suitabilityGate).toMatch(/If state already contains rounds[\s\S]*do not clear it/i);
		expect(suitabilityGate).toMatch(/Preserve the active interview/i);
		expect(suitabilityGate).toMatch(/do not initialize deep-interview state/i);
		expect(suitabilityGate).toMatch(/do not run Round 0/i);
		expect(suitabilityGate).toMatch(/do not write a pending-approval spec/i);
		expect(suitabilityGate).toMatch(/direct implementation/i);
	});
});

describe("deep-interview ask clarification contract", () => {
	it("treats clarificationQuestion as a non-answer and re-asks without scoring", () => {
		for (const required of [
			"clarificationQuestion",
			"treat it as a non-answer about the displayed choices",
			"call `ask` again with the exact original question, options, and `deepInterview.*` metadata",
			"bypasses Step 2b′ auto-answer, Step 2b″ free-text refine, Step 2c ambiguity scoring",
			"must not be recorded as a round answer",
		]) {
			expect(skill).toContain(required);
		}
	});
});
