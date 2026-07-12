import { describe, expect, it } from "bun:test";
import { getDefaultGjcDefinitions } from "../src/defaults/gjc-defaults";
import {
	assembleWorkflowFragments,
	CANONICAL_WORKFLOW_SKILLS,
	getWorkflowFragmentDefinitions,
	getWorkflowPhaseFragment,
	getWorkflowRuntimeStateFragment,
	WORKFLOW_ALLOWED_PHASES,
	WORKFLOW_FRAGMENT_MANIFEST,
	WORKFLOW_FRAGMENT_MANIFEST_VERSION,
	WORKFLOW_RUNTIME_STATE_FRAGMENT_MAP,
} from "../src/extensibility/workflow-fragments";
import { WORKFLOW_MANIFEST } from "../src/gjc-runtime/workflow-manifest";

describe("workflow fragment manifest", () => {
	it("is a fixed complete static manifest with one dispatcher and unique phases per canonical skill", () => {
		expect(WORKFLOW_FRAGMENT_MANIFEST_VERSION).toBe(2);

		expect(Object.keys(WORKFLOW_FRAGMENT_MANIFEST).sort()).toEqual([...CANONICAL_WORKFLOW_SKILLS].sort());

		for (const skill of CANONICAL_WORKFLOW_SKILLS) {
			const definition = WORKFLOW_FRAGMENT_MANIFEST[skill];
			expect(definition.dispatcher.phase).toBe("dispatcher");
			expect(definition.dispatcher.relativePath).toBe(`skill-fragments/${skill}/dispatcher.md`);
			expect(definition.dispatcher.content.length).toBeGreaterThan(0);
			expect(WORKFLOW_ALLOWED_PHASES[skill]).toEqual(definition.phases.map(fragment => fragment.phase));
			expect(new Set(definition.phases.map(fragment => fragment.phase)).size).toBe(definition.phases.length);
		}

		const fragments = getWorkflowFragmentDefinitions();
		expect(new Set(fragments.map(fragment => fragment.id)).size).toBe(fragments.length);
	});

	it("registers every static workflow fragment as a non-public parent-scoped asset", () => {
		const registered = getDefaultGjcDefinitions().filter(definition => definition.kind === "skill-fragment");
		for (const fragment of getWorkflowFragmentDefinitions()) {
			const definition = registered.find(candidate => candidate.relativePath === fragment.relativePath);
			expect(definition).toEqual({
				kind: "skill-fragment",
				parentSkillName: fragment.skill,
				relativePath: fragment.relativePath,
				content: fragment.content,
			});
		}
	});

	it("maps every authoritative runtime state to a declared concrete fragment and fails closed for unknown states", () => {
		for (const skill of CANONICAL_WORKFLOW_SKILLS) {
			const declaredPhases = WORKFLOW_ALLOWED_PHASES[skill];
			const runtimeStates = WORKFLOW_MANIFEST[skill].states.map(state => state.id);
			expect(Object.keys(WORKFLOW_RUNTIME_STATE_FRAGMENT_MAP[skill]).sort()).toEqual([...runtimeStates].sort());

			for (const state of runtimeStates) {
				const fragment = getWorkflowRuntimeStateFragment(skill, state);
				expect(fragment).toBeDefined();
				expect(declaredPhases).toContain(fragment!.phase);
				expect(assembleWorkflowFragments(skill, state).fragmentIds).toEqual([`${skill}/dispatcher`, fragment!.id]);
			}

			expect(getWorkflowPhaseFragment(skill, "undeclared-phase")).toBeUndefined();
			expect(assembleWorkflowFragments(skill, "undeclared-phase").fragmentIds).toEqual([`${skill}/dispatcher`]);
		}
	});

	it("keeps every dispatcher non-authoritative", () => {
		const prohibitedMarkers = [
			"create-goals",
			"complete-goals",
			"checkpoint",
			"approve",
			"record-review-blockers",
			"gjc team",
			"execute",
		];

		for (const skill of CANONICAL_WORKFLOW_SKILLS) {
			const content = WORKFLOW_FRAGMENT_MANIFEST[skill].dispatcher.content.toLowerCase();
			for (const marker of prohibitedMarkers) {
				expect(content).not.toContain(marker);
			}
		}
	});
});
