import deepInterviewClosureSpec from "../defaults/gjc/skill-fragments/deep-interview/closure-spec.md" with {
	type: "text",
};
import deepInterviewDispatcher from "../defaults/gjc/skill-fragments/deep-interview/dispatcher.md" with {
	type: "text",
};
import deepInterviewHandoff from "../defaults/gjc/skill-fragments/deep-interview/handoff.md" with { type: "text" };
import deepInterviewInitializeTopology from "../defaults/gjc/skill-fragments/deep-interview/initialize-topology.md" with {
	type: "text",
};
import deepInterviewInterviewing from "../defaults/gjc/skill-fragments/deep-interview/interviewing.md" with {
	type: "text",
};
import deepInterviewThresholdSuitability from "../defaults/gjc/skill-fragments/deep-interview/threshold-suitability.md" with {
	type: "text",
};
import ralplanDispatcher from "../defaults/gjc/skill-fragments/ralplan/dispatcher.md" with { type: "text" };
import ralplanFinalApproval from "../defaults/gjc/skill-fragments/ralplan/final-approval.md" with { type: "text" };
import ralplanHandoff from "../defaults/gjc/skill-fragments/ralplan/handoff.md" with { type: "text" };
import ralplanPlanner from "../defaults/gjc/skill-fragments/ralplan/planner.md" with { type: "text" };
import ralplanPostInterview from "../defaults/gjc/skill-fragments/ralplan/post-interview.md" with { type: "text" };
import ralplanReview from "../defaults/gjc/skill-fragments/ralplan/review.md" with { type: "text" };
import ralplanRevision from "../defaults/gjc/skill-fragments/ralplan/revision.md" with { type: "text" };
import teamDispatcher from "../defaults/gjc/skill-fragments/team/dispatcher.md" with { type: "text" };
import teamIntegrationShutdown from "../defaults/gjc/skill-fragments/team/integration-shutdown.md" with {
	type: "text",
};
import teamPreflightIntake from "../defaults/gjc/skill-fragments/team/preflight-intake.md" with { type: "text" };
import teamRunningMonitoring from "../defaults/gjc/skill-fragments/team/running-monitoring.md" with { type: "text" };
import teamStarting from "../defaults/gjc/skill-fragments/team/starting.md" with { type: "text" };
import teamTerminal from "../defaults/gjc/skill-fragments/team/terminal.md" with { type: "text" };
import ultragoalCheckpoint from "../defaults/gjc/skill-fragments/ultragoal/checkpoint.md" with { type: "text" };
import ultragoalCleanupReview from "../defaults/gjc/skill-fragments/ultragoal/cleanup-review.md" with { type: "text" };
import ultragoalDispatcher from "../defaults/gjc/skill-fragments/ultragoal/dispatcher.md" with { type: "text" };
import ultragoalExecution from "../defaults/gjc/skill-fragments/ultragoal/execution.md" with { type: "text" };
import ultragoalGoalPlanning from "../defaults/gjc/skill-fragments/ultragoal/goal-planning.md" with { type: "text" };
import ultragoalHandoff from "../defaults/gjc/skill-fragments/ultragoal/handoff.md" with { type: "text" };

export const WORKFLOW_FRAGMENT_MANIFEST_VERSION = 2 as const;

export const CANONICAL_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"] as const;
export type CanonicalWorkflowSkill = (typeof CANONICAL_WORKFLOW_SKILLS)[number];

export type WorkflowFragmentDefinition<Skill extends CanonicalWorkflowSkill = CanonicalWorkflowSkill> = {
	id: `${Skill}/${string}`;
	skill: Skill;
	phase: string;
	relativePath: `skill-fragments/${Skill}/${string}.md`;
	content: string;
};

export type WorkflowFragmentAssembly = {
	manifestVersion: typeof WORKFLOW_FRAGMENT_MANIFEST_VERSION;
	skill: CanonicalWorkflowSkill;
	dispatcher: WorkflowFragmentDefinition;
	phase?: WorkflowFragmentDefinition;
	fragmentIds: readonly string[];
};

function fragment<Skill extends CanonicalWorkflowSkill>(
	skill: Skill,
	phase: string,
	content: string,
): WorkflowFragmentDefinition<Skill> {
	return {
		id: `${skill}/${phase}`,
		skill,
		phase,
		relativePath: `skill-fragments/${skill}/${phase}.md`,
		content,
	};
}

export const WORKFLOW_FRAGMENT_MANIFEST = {
	"deep-interview": {
		dispatcher: fragment("deep-interview", "dispatcher", deepInterviewDispatcher),
		phases: [
			fragment("deep-interview", "threshold-suitability", deepInterviewThresholdSuitability),
			fragment("deep-interview", "initialize-topology", deepInterviewInitializeTopology),
			fragment("deep-interview", "interviewing", deepInterviewInterviewing),
			fragment("deep-interview", "closure-spec", deepInterviewClosureSpec),
			fragment("deep-interview", "handoff", deepInterviewHandoff),
		],
	},
	ralplan: {
		dispatcher: fragment("ralplan", "dispatcher", ralplanDispatcher),
		phases: [
			fragment("ralplan", "planner", ralplanPlanner),
			fragment("ralplan", "review", ralplanReview),
			fragment("ralplan", "revision", ralplanRevision),
			fragment("ralplan", "post-interview", ralplanPostInterview),
			fragment("ralplan", "final-approval", ralplanFinalApproval),
			fragment("ralplan", "handoff", ralplanHandoff),
		],
	},
	ultragoal: {
		dispatcher: fragment("ultragoal", "dispatcher", ultragoalDispatcher),
		phases: [
			fragment("ultragoal", "goal-planning", ultragoalGoalPlanning),
			fragment("ultragoal", "execution", ultragoalExecution),
			fragment("ultragoal", "cleanup-review", ultragoalCleanupReview),
			fragment("ultragoal", "checkpoint", ultragoalCheckpoint),
			fragment("ultragoal", "handoff", ultragoalHandoff),
		],
	},
	team: {
		dispatcher: fragment("team", "dispatcher", teamDispatcher),
		phases: [
			fragment("team", "preflight-intake", teamPreflightIntake),
			fragment("team", "starting", teamStarting),
			fragment("team", "running-monitoring", teamRunningMonitoring),
			fragment("team", "integration-shutdown", teamIntegrationShutdown),
			fragment("team", "terminal", teamTerminal),
		],
	},
} as const satisfies Record<
	CanonicalWorkflowSkill,
	{ dispatcher: WorkflowFragmentDefinition; phases: readonly WorkflowFragmentDefinition[] }
>;

export const WORKFLOW_ALLOWED_PHASES = {
	"deep-interview": WORKFLOW_FRAGMENT_MANIFEST["deep-interview"].phases.map(fragment => fragment.phase),
	ralplan: WORKFLOW_FRAGMENT_MANIFEST.ralplan.phases.map(fragment => fragment.phase),
	ultragoal: WORKFLOW_FRAGMENT_MANIFEST.ultragoal.phases.map(fragment => fragment.phase),
	team: WORKFLOW_FRAGMENT_MANIFEST.team.phases.map(fragment => fragment.phase),
} as const satisfies { readonly [Skill in CanonicalWorkflowSkill]: readonly string[] };

/**
 * Maps authoritative runtime `current_phase` values to their prompt fragment.
 * Runtime phase names intentionally remain distinct from presentation-oriented
 * fragment names, so this table must be updated with WORKFLOW_MANIFEST states.
 */
export const WORKFLOW_RUNTIME_STATE_FRAGMENT_MAP = {
	"deep-interview": {
		interviewing: "interviewing",
		handoff: "handoff",
		complete: "closure-spec",
	},
	ralplan: {
		planner: "planner",
		architect: "review",
		critic: "review",
		revision: "revision",
		"post-interview": "post-interview",
		adr: "final-approval",
		final: "final-approval",
		handoff: "handoff",
	},
	ultragoal: {
		missing: "goal-planning",
		"goal-planning": "goal-planning",
		pending: "goal-planning",
		active: "execution",
		blocked: "checkpoint",
		failed: "checkpoint",
		complete: "cleanup-review",
		handoff: "handoff",
	},
	team: {
		starting: "starting",
		running: "running-monitoring",
		awaiting_integration: "integration-shutdown",
		complete: "terminal",
		failed: "terminal",
		cancelled: "terminal",
		handoff: "terminal",
	},
} as const satisfies { readonly [Skill in CanonicalWorkflowSkill]: Readonly<Record<string, string>> };

export function getWorkflowRuntimeStateFragment(
	skill: CanonicalWorkflowSkill,
	state: string,
): WorkflowFragmentDefinition | undefined {
	const phase = (WORKFLOW_RUNTIME_STATE_FRAGMENT_MAP[skill] as Readonly<Record<string, string>>)[state];
	return phase === undefined ? undefined : getWorkflowPhaseFragment(skill, phase);
}

export function getWorkflowDispatcher(skill: CanonicalWorkflowSkill): WorkflowFragmentDefinition {
	return WORKFLOW_FRAGMENT_MANIFEST[skill].dispatcher;
}

export function getWorkflowPhaseFragment(
	skill: CanonicalWorkflowSkill,
	phase: string,
): WorkflowFragmentDefinition | undefined {
	return WORKFLOW_FRAGMENT_MANIFEST[skill].phases.find(fragment => fragment.phase === phase);
}

export function assembleWorkflowFragments(
	skill: CanonicalWorkflowSkill,
	runtimeState?: string,
): WorkflowFragmentAssembly {
	const dispatcher = getWorkflowDispatcher(skill);
	const selectedPhase = runtimeState === undefined ? undefined : getWorkflowRuntimeStateFragment(skill, runtimeState);
	return {
		manifestVersion: WORKFLOW_FRAGMENT_MANIFEST_VERSION,
		skill,
		dispatcher,
		...(selectedPhase === undefined ? {} : { phase: selectedPhase }),
		fragmentIds: selectedPhase === undefined ? [dispatcher.id] : [dispatcher.id, selectedPhase.id],
	};
}

export function getWorkflowFragmentDefinitions(): readonly WorkflowFragmentDefinition[] {
	return CANONICAL_WORKFLOW_SKILLS.flatMap(skill => [
		WORKFLOW_FRAGMENT_MANIFEST[skill].dispatcher,
		...WORKFLOW_FRAGMENT_MANIFEST[skill].phases,
	]);
}
