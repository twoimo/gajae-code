import * as fs from "node:fs/promises";
import {
	CANONICAL_WORKFLOW_SKILLS,
	type CanonicalWorkflowSkill,
	getWorkflowRuntimeStateFragment,
} from "../extensibility/workflow-fragments";

import { modeStatePath } from "../gjc-runtime/session-layout";
import { readVisibleSkillActiveState, type SkillActiveEntry, type SkillActiveState } from "./active-state";
import { workflowReceiptStatus } from "./workflow-state-contract";
import { WORKFLOW_STATE_VERSION } from "./workflow-state-version";

export type WorkflowPhaseResolutionSource = "explicit" | "live" | "durable" | "dispatcher-only";
export type WorkflowFragmentKind = "phase" | "dispatcher";

export interface ImmutableWorkflowContext {
	skill: string;
	phase: string;
	sessionId: string;
	stateVersion: number;
}

export interface WorkflowPhaseResolution {
	skill: CanonicalWorkflowSkill;
	phase?: string;
	source: WorkflowPhaseResolutionSource;
	fragmentKind: WorkflowFragmentKind;
	diagnostics: readonly string[];
	stateVersion: number;
}

interface DurableWorkflowState {
	skill: string;
	session_id: string;
	current_phase: string;
	active: boolean;
	version: number;
}

function dispatcherOnly(skill: CanonicalWorkflowSkill, diagnostics: string[]): WorkflowPhaseResolution {
	return {
		skill,
		source: "dispatcher-only",
		fragmentKind: "dispatcher",
		diagnostics,
		stateVersion: WORKFLOW_STATE_VERSION,
	};
}

function declaredPhase(skill: CanonicalWorkflowSkill, phase: string): boolean {
	return getWorkflowRuntimeStateFragment(skill, phase.trim()) !== undefined;
}

function validActiveEntry(
	entry: SkillActiveEntry,
	skill: CanonicalWorkflowSkill,
	sessionId: string,
): string | undefined {
	if (entry.skill !== skill || entry.active === false || entry.stale === true) return undefined;
	if (entry.session_id !== undefined && entry.session_id !== sessionId) return undefined;
	if (workflowReceiptStatus(entry.receipt) === "stale") return undefined;
	const phase = entry.phase?.trim();
	return phase && declaredPhase(skill, phase) ? phase : undefined;
}

async function readDurableState(
	cwd: string,
	sessionId: string,
	skill: CanonicalWorkflowSkill,
): Promise<{ state?: DurableWorkflowState; diagnostic?: string }> {
	let text: string;
	try {
		text = await fs.readFile(modeStatePath(cwd, sessionId, skill), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { diagnostic: "durable state absent" };
		return { diagnostic: "durable state unreadable" };
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { diagnostic: "durable state malformed" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { diagnostic: "durable state invalid shape" };
	const state = value as Partial<DurableWorkflowState>;
	if (
		typeof state.skill !== "string" ||
		typeof state.session_id !== "string" ||
		typeof state.current_phase !== "string" ||
		typeof state.active !== "boolean" ||
		typeof state.version !== "number"
	)
		return { diagnostic: "durable state invalid shape" };
	if (state.version !== WORKFLOW_STATE_VERSION) return { diagnostic: "durable state version skew" };
	if (state.skill !== skill) return { diagnostic: "durable state skill mismatch" };
	if (state.session_id !== sessionId) return { diagnostic: "durable state session mismatch" };
	if (!state.active) return { diagnostic: "durable state inactive" };
	if (!declaredPhase(skill, state.current_phase)) return { diagnostic: "durable state unknown phase" };
	return { state: state as DurableWorkflowState };
}

export function isCanonicalWorkflowSkill(skill: string): skill is CanonicalWorkflowSkill {
	return (CANONICAL_WORKFLOW_SKILLS as readonly string[]).includes(skill);
}

export async function resolveWorkflowPhase(input: {
	skill: CanonicalWorkflowSkill;
	cwd?: string;
	sessionId?: string;
	explicit?: ImmutableWorkflowContext;
}): Promise<WorkflowPhaseResolution> {
	const { skill, explicit } = input;
	const sessionId = input.sessionId?.trim();
	if (explicit) {
		if (
			!sessionId ||
			explicit.skill !== skill ||
			explicit.sessionId !== sessionId ||
			explicit.stateVersion !== WORKFLOW_STATE_VERSION ||
			!declaredPhase(skill, explicit.phase)
		)
			return dispatcherOnly(skill, ["explicit workflow context invalid"]);
		return {
			skill,
			phase: explicit.phase.trim(),
			source: "explicit",
			fragmentKind: "phase",
			diagnostics: [],
			stateVersion: WORKFLOW_STATE_VERSION,
		};
	}
	if (!input.cwd || !sessionId) return dispatcherOnly(skill, ["workflow session context absent"]);

	const durable = await readDurableState(input.cwd, sessionId, skill);
	let visible: SkillActiveState | null;
	try {
		visible = await readVisibleSkillActiveState(input.cwd, sessionId);
	} catch {
		return dispatcherOnly(skill, ["live state unreadable", ...(durable.diagnostic ? [durable.diagnostic] : [])]);
	}
	const entries = visible?.active_skills ?? [];
	const phases = entries
		.map(entry => validActiveEntry(entry, skill, sessionId))
		.filter((phase): phase is string => phase !== undefined);
	const uniquePhases = [...new Set(phases)];
	const matchingEntries = entries.filter(entry => entry.skill === skill && entry.active !== false);
	if (matchingEntries.length > 0 && uniquePhases.length !== 1)
		return dispatcherOnly(skill, ["live state ambiguous or stale"]);
	const livePhase = uniquePhases[0];
	if (livePhase && durable.state && durable.state.current_phase !== livePhase)
		return dispatcherOnly(skill, ["live and durable state conflict"]);
	if (livePhase)
		return {
			skill,
			phase: livePhase,
			source: "live",
			fragmentKind: "phase",
			diagnostics: [],
			stateVersion: WORKFLOW_STATE_VERSION,
		};
	if (durable.state)
		return {
			skill,
			phase: durable.state.current_phase,
			source: "durable",
			fragmentKind: "phase",
			diagnostics: [],
			stateVersion: WORKFLOW_STATE_VERSION,
		};
	return dispatcherOnly(skill, [durable.diagnostic ?? "workflow phase absent"]);
}
