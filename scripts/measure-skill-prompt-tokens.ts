#!/usr/bin/env bun

import * as path from "node:path";
import {
	assembleWorkflowFragments,
	type CanonicalWorkflowSkill,
} from "../packages/coding-agent/src/extensibility/workflow-fragments";
import { WORKFLOW_MANIFEST } from "../packages/coding-agent/src/gjc-runtime/workflow-manifest";
import { buildSkillPromptMessage } from "../packages/coding-agent/src/extensibility/skills";


const repoRoot = path.join(import.meta.dir, "..");
export const baselinePath = path.join(import.meta.dir, "skill-prompt-token-baseline.json");
export const corpusPath = path.join(import.meta.dir, "skill-prompt-token-corpus.json");

export const NORMALIZED_SENTINELS = {
	absolutePath: "<ABSOLUTE_PATH>",
	date: "<DATE>",
	sessionId: "<SESSION_ID>",
	timestamp: "<TIMESTAMP>",
	uuid: "<UUID>",
	userArgs: "<USER_ARGS>",
} as const;

export const CANONICAL_SKILLS = [
	{ id: "deep-interview", path: "packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md" },
	{ id: "ultragoal", path: "packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md" },
	{ id: "team", path: "packages/coding-agent/src/defaults/gjc/skills/team/SKILL.md" },
	{ id: "ralplan", path: "packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md" },
] as const;

export type CanonicalSkillId = (typeof CANONICAL_SKILLS)[number]["id"];
export interface SkillPromptTokenMeasurement { chars: number; estimatedTokens: number; }
export interface SkillPromptTokenBaseline {
	schemaVersion: 1;
	normalization: typeof NORMALIZED_SENTINELS;
	skills: Record<CanonicalSkillId, SkillPromptTokenMeasurement>;
}
export type SkillPromptCorpusCase = {
	skill: CanonicalSkillId;
	kind: "dispatcher" | "phase";
	phase?: string;
	expectedFragmentIds: readonly string[];
	measurement: SkillPromptTokenMeasurement;
};
export interface SkillPromptTokenCorpus {
	schemaVersion: 1;
	normalization: typeof NORMALIZED_SENTINELS;
	inputs: { args: typeof NORMALIZED_SENTINELS.userArgs; sessionId: typeof NORMALIZED_SENTINELS.sessionId };
	cases: SkillPromptCorpusCase[];
}

export const DISPATCHER_TOKEN_BUDGET = 4096;
export const MINIMUM_SAVINGS: Record<CanonicalSkillId, number> = {
	"deep-interview": 8192,
	ultragoal: 4096,
	team: 3072,
	ralplan: 1024,
};

function isMeasurement(value: unknown): value is SkillPromptTokenMeasurement {
	return typeof value === "object" && value !== null
		&& typeof (value as { chars?: unknown }).chars === "number"
		&& Number.isInteger((value as { chars: number }).chars)
		&& (value as { chars: number }).chars >= 0
		&& typeof (value as { estimatedTokens?: unknown }).estimatedTokens === "number"
		&& (value as { estimatedTokens: number }).estimatedTokens === Math.ceil((value as { chars: number }).chars / 4);
}

function hasNormalization(value: unknown): value is typeof NORMALIZED_SENTINELS {
	return typeof value === "object" && value !== null
		&& Object.entries(NORMALIZED_SENTINELS).every(([key, sentinel]) => (value as Record<string, unknown>)[key] === sentinel);
}

export function isSkillPromptTokenBaseline(value: unknown): value is SkillPromptTokenBaseline {
	if (typeof value !== "object" || value === null) return false;
	const baseline = value as { schemaVersion?: unknown; normalization?: unknown; skills?: unknown };
	if (baseline.schemaVersion !== 1 || !hasNormalization(baseline.normalization) || typeof baseline.skills !== "object" || baseline.skills === null) return false;
	const skills = baseline.skills as Record<string, unknown>;
	return Object.keys(skills).length === CANONICAL_SKILLS.length && CANONICAL_SKILLS.every(({ id }) => isMeasurement(skills[id]));
}

export function isSkillPromptTokenCorpus(value: unknown): value is SkillPromptTokenCorpus {
	if (typeof value !== "object" || value === null) return false;
	const corpus = value as { schemaVersion?: unknown; normalization?: unknown; inputs?: unknown; cases?: unknown };
	if (
		corpus.schemaVersion !== 1 ||
		!hasNormalization(corpus.normalization) ||
		!isCorpusInputs(corpus.inputs) ||
		!Array.isArray(corpus.cases)
	)
		return false;
	if (corpus.cases.length !== CANONICAL_SKILLS.length * 2) return false;
	return corpus.cases.every((entry, index) => {
		if (typeof entry !== "object" || entry === null) return false;
		const item = entry as Partial<SkillPromptCorpusCase>;
		const expectedSkill = CANONICAL_SKILLS[Math.floor(index / 2)]?.id;
		const expectedKind = index % 2 === 0 ? "dispatcher" : "phase";
		return item.skill === expectedSkill && item.kind === expectedKind && isMeasurement(item.measurement)
			&& Array.isArray(item.expectedFragmentIds) && item.expectedFragmentIds.every(id => typeof id === "string")
			&& (item.kind === "dispatcher"
				? item.phase === undefined && item.expectedFragmentIds.length === 1
				: typeof item.phase === "string" && item.expectedFragmentIds.length === 2);
	});
}

function isCorpusInputs(value: unknown): value is SkillPromptTokenCorpus["inputs"] {
	return typeof value === "object" && value !== null
		&& (value as { args?: unknown }).args === NORMALIZED_SENTINELS.userArgs
		&& (value as { sessionId?: unknown }).sessionId === NORMALIZED_SENTINELS.sessionId;
}

const absolutePathPattern = /(?<![:/])(?:~\/|\/(?:Users|home|tmp|private|var|workspace|workspaces|repo)\/)[^\s<>"'`|)\],;]+/g;
const timestampPattern = /\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const datePattern = /\b\d{4}-\d{2}-\d{2}\b/g;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const sessionIdPattern = /\b(?:session[-_])(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,})\b/g;
const userArgsPattern = /^(User:)\s.*$/gm;

/** Replaces only volatile prompt values with stable, non-empty sentinels. */
export function normalizeSkillPrompt(value: string): string {
	return value.replace(userArgsPattern, `$1 ${NORMALIZED_SENTINELS.userArgs}`)
		.replace(sessionIdPattern, `session-${NORMALIZED_SENTINELS.sessionId}`)
		.replace(uuidPattern, NORMALIZED_SENTINELS.uuid)
		.replace(timestampPattern, NORMALIZED_SENTINELS.timestamp)
		.replace(datePattern, NORMALIZED_SENTINELS.date)
		.replace(absolutePathPattern, NORMALIZED_SENTINELS.absolutePath);
}

export function estimateSkillPromptTokens(normalizedPrompt: string): number { return Math.ceil(normalizedPrompt.length / 4); }
export function measureNormalizedSkillPrompt(prompt: string): SkillPromptTokenMeasurement {
	const normalized = normalizeSkillPrompt(prompt);
	return { chars: normalized.length, estimatedTokens: estimateSkillPromptTokens(normalized) };
}

async function assembleCase(skill: CanonicalSkillId, kind: "dispatcher" | "phase"): Promise<SkillPromptCorpusCase> {
	const source = CANONICAL_SKILLS.find(candidate => candidate.id === skill);
	if (!source) throw new Error(`Unknown canonical skill: ${skill}`);
	const selectedPhase = kind === "phase" ? WORKFLOW_MANIFEST[skill].initialState : undefined;
	if (kind === "phase" && !selectedPhase) throw new Error(`No initial runtime state declared for ${skill}.`);
	const built = await buildSkillPromptMessage(
		{ name: skill, filePath: path.join(repoRoot, source.path), content: await Bun.file(path.join(repoRoot, source.path)).text() },
		NORMALIZED_SENTINELS.userArgs,
		selectedPhase ? { sessionId: NORMALIZED_SENTINELS.sessionId, workflowContext: { skill, phase: selectedPhase, sessionId: NORMALIZED_SENTINELS.sessionId, stateVersion: 2 } } : undefined,
	);
	const assembly = assembleWorkflowFragments(skill as CanonicalWorkflowSkill, selectedPhase);
	return { skill, kind, ...(selectedPhase ? { phase: selectedPhase } : {}), expectedFragmentIds: assembly.fragmentIds, measurement: measureNormalizedSkillPrompt(built.message) };
}

export async function measureSkillPromptCorpus(): Promise<SkillPromptTokenCorpus> {
	const cases: SkillPromptCorpusCase[] = [];
	for (const { id } of CANONICAL_SKILLS) {
		cases.push(await assembleCase(id, "dispatcher"), await assembleCase(id, "phase"));
	}
	return {
		schemaVersion: 1,
		normalization: NORMALIZED_SENTINELS,
		inputs: { args: NORMALIZED_SENTINELS.userArgs, sessionId: NORMALIZED_SENTINELS.sessionId },
		cases,
	};
}

/** Measures raw SKILL.md bodies only for the explicit frozen-baseline update command. */
export async function measureCurrentSkillPrompts(): Promise<SkillPromptTokenBaseline> {
	const skills = {} as Record<CanonicalSkillId, SkillPromptTokenMeasurement>;
	for (const skill of CANONICAL_SKILLS) skills[skill.id] = measureNormalizedSkillPrompt(await Bun.file(path.join(repoRoot, skill.path)).text());
	return { schemaVersion: 1, normalization: NORMALIZED_SENTINELS, skills };
}

export function formatBaseline(baseline: SkillPromptTokenBaseline): string { return `${JSON.stringify(baseline, null, "\t")}\n`; }
export function formatCorpus(corpus: SkillPromptTokenCorpus): string { return `${JSON.stringify(corpus, null, "\t")}\n`; }
export async function readBaseline(filePath = baselinePath): Promise<SkillPromptTokenBaseline> { return await Bun.file(filePath).json() as SkillPromptTokenBaseline; }
export async function readCorpus(filePath = corpusPath): Promise<SkillPromptTokenCorpus> { return await Bun.file(filePath).json() as SkillPromptTokenCorpus; }

export function tokenSavings(baseline: SkillPromptTokenBaseline, corpus: SkillPromptTokenCorpus): Record<CanonicalSkillId, number> {
	const savings = {} as Record<CanonicalSkillId, number>;
	for (const { id } of CANONICAL_SKILLS) {
		const concreteCase = corpus.cases.find(entry => entry.skill === id && entry.kind === "phase");
		if (!concreteCase) throw new Error(`Corpus has no concrete phase case for ${id}.`);
		savings[id] = baseline.skills[id].estimatedTokens - concreteCase.measurement.estimatedTokens;
	}
	return savings;
}

export async function checkBaseline(filePath = baselinePath): Promise<boolean> { return isSkillPromptTokenBaseline(await readBaseline(filePath)); }
export async function checkSkillPromptTokenContracts(): Promise<{ dispatcherTokens: Record<CanonicalSkillId, number>; savings: Record<CanonicalSkillId, number> }> {
	const [baseline, corpus, measured] = await Promise.all([readBaseline(), readCorpus(), measureSkillPromptCorpus()]);
	if (!isSkillPromptTokenBaseline(baseline)) throw new Error(`Invalid skill prompt token baseline: ${baselinePath}`);
	if (!isSkillPromptTokenCorpus(corpus)) throw new Error(`Invalid skill prompt token corpus: ${corpusPath}`);
	if (formatCorpus(corpus) !== formatCorpus(measured)) throw new Error("Skill prompt token corpus differs. Review the change and run bun scripts/measure-skill-prompt-tokens.ts --update-corpus.");
	const dispatcherTokens = {} as Record<CanonicalSkillId, number>;
	for (const { id } of CANONICAL_SKILLS) {
		const dispatcher = corpus.cases.find(entry => entry.skill === id && entry.kind === "dispatcher");
		if (!dispatcher) throw new Error(`Corpus has no dispatcher case for ${id}.`);
		dispatcherTokens[id] = dispatcher.measurement.estimatedTokens;
		if (dispatcherTokens[id] > DISPATCHER_TOKEN_BUDGET) throw new Error(`${id} dispatcher exceeds ${DISPATCHER_TOKEN_BUDGET} estimated tokens: ${dispatcherTokens[id]}.`);
	}
	const savings = tokenSavings(baseline, corpus);
	for (const { id } of CANONICAL_SKILLS) if (savings[id] < MINIMUM_SAVINGS[id]) throw new Error(`${id} savings ${savings[id]} is below required ${MINIMUM_SAVINGS[id]}.`);
	return { dispatcherTokens, savings };
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const updateBaseline = process.argv.includes("--update-baseline");
	const updateCorpus = process.argv.includes("--update-corpus");
	if ([check, updateBaseline, updateCorpus].filter(Boolean).length > 1) throw new Error("Use only one of --check, --update-baseline, or --update-corpus.");
	if (updateBaseline) { await Bun.write(baselinePath, formatBaseline(await measureCurrentSkillPrompts())); console.log(`Updated ${path.relative(repoRoot, baselinePath)}.`); return; }
	if (updateCorpus) { await Bun.write(corpusPath, formatCorpus(await measureSkillPromptCorpus())); console.log(`Updated ${path.relative(repoRoot, corpusPath)}.`); return; }
	if (check) { const result = await checkSkillPromptTokenContracts(); console.log(JSON.stringify(result)); return; }
	console.log(formatCorpus(await measureSkillPromptCorpus()));
}

if (import.meta.main) await main();
