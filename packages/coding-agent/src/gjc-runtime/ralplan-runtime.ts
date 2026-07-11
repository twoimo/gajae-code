import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncSkillActiveState } from "../skill-state/active-state";
import { buildRalplanHudSummary } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import { renderCliWriteReceipt } from "./cli-write-receipt";
import {
	formatRalplanStagePresence,
	parseRalplanIndexLine,
	type RalplanIndexRow,
	summarizeRalplanIndex,
} from "./ledger-event-renderer";
import { GJC_RALPLAN_ARTIFACT_ENV, isRestrictedRoleAgentBash } from "./restricted-role-agent-bash";
import { modeStatePath, sessionPlansDir } from "./session-layout";
import { resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import { migrateWorkflowState } from "./state-migrations";
import { runNativeStateCommand } from "./state-runtime";
import {
	appendJsonlIdempotent,
	readExistingStateForMutation,
	withWorkflowStateLock,
	writeArtifact,
	writeWorkflowEnvelopeAtomic,
} from "./state-writer";

/**
 * Native implementation of `gjc ralplan`.
 *
 * Two invocation shapes are handled natively:
 *
 * 1. **Consensus handoff**: `gjc ralplan [--interactive] [--deliberate] [--irc] [--architect <kind>]
 *    [--critic <kind>] [--session-id <id>] "<task>"` validates the documented flag surface,
 *    seeds `.gjc/state/ralplan-state.json`, and updates the shared HUD rail via
 *    `syncSkillActiveState`. The CLI never *runs* the Planner / Architect / Critic / deliberation loop itself —
 *    that lives in the bundled `/skill:ralplan` skill — but it accepts every documented flag so
 *    scripted users see a useful response and the active run is visible to the TUI.
 *
 * 2. **Artifact write**: `gjc ralplan --write --stage <type> --stage_n <N>
 *    (--artifact <path-or-string> | --artifact-env GJC_RALPLAN_ARTIFACT)
 *    [--run-id <id>] [--session-id <id>] [--json]` persists Planner / Architect
 *    / Critic / revision / post-interview / ADR / final markdown under `.gjc/plans/ralplan/<run-id>/`, maintains
 *    an `index.jsonl` audit log, copies `final` stages to `pending-approval.md`, and advances
 *    the HUD chip to reflect the latest persisted stage.
 */

export interface RalplanCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const KNOWN_STAGES = [
	"planner",
	"architect",
	"critic",
	"deliberation",
	"revision",
	"post-interview",
	"adr",
	"final",
] as const;
type RalplanStage = (typeof KNOWN_STAGES)[number];

const KNOWN_ARCHITECT_KINDS = new Set(["openai-code"]);
const KNOWN_CRITIC_KINDS = new Set(["openai-code"]);

const PATH_COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

const SUBAGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const KNOWN_FALLBACK_REASONS = new Set([
	"context_unavailable",
	"not_found",
	"no_runner",
	"resume_failed",
	"process_restart",
	"missing_record",
]);

class RalplanCommandError extends Error {
	constructor(
		public readonly exitStatus: number,
		message: string,
	) {
		super(message);
		this.name = "RalplanCommandError";
	}
}

const VALUE_FLAGS = new Set([
	"--stage",
	"--stage_n",
	"--artifact",
	"--artifact-env",
	"--run-id",
	"--session-id",
	"--architect",
	"--critic",
	"--planner-id",
	"--planner-resumable",
	"--architect-id",
	"--architect-resumable",
	"--critic-id",
	"--critic-resumable",
	"--fallback-reason",
	"--fallback-attempted-id",
	"--fallback-stage-n",
	"--fallback-receipt-path",
]);

const ARTIFACT_WRITE_ONLY_VALUE_FLAGS = new Set([
	"--planner-id",
	"--planner-resumable",
	"--architect-id",
	"--architect-resumable",
	"--critic-id",
	"--critic-resumable",
	"--fallback-reason",
	"--fallback-attempted-id",
	"--fallback-stage-n",
	"--fallback-receipt-path",
]);

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

export function isRalplanArtifactWriteInvocation(args: readonly string[]): boolean {
	return hasFlag(args, "--write");
}

function isRalplanDoctorInvocation(args: readonly string[]): boolean {
	return args[0] === "doctor";
}

function assertSafePathComponent(value: string, label: string): void {
	if (!PATH_COMPONENT_RE.test(value) || value.includes("..")) {
		throw new RalplanCommandError(2, `invalid path component for --${label}: ${value}`);
	}
}

function assertKnownStage(stage: string): asserts stage is RalplanStage {
	if (!(KNOWN_STAGES as readonly string[]).includes(stage)) {
		throw new RalplanCommandError(2, `unknown --stage: ${stage}. Expected one of: ${KNOWN_STAGES.join(", ")}.`);
	}
}

function parseStageN(raw: string | undefined): number {
	if (!raw) throw new RalplanCommandError(2, "--stage_n is required");
	if (!/^[1-9][0-9]{0,2}$/.test(raw)) {
		throw new RalplanCommandError(2, `invalid --stage_n: ${raw}. Expected integer 1..999.`);
	}
	const value = Number.parseInt(raw, 10);
	if (value < 1 || value > 999) {
		throw new RalplanCommandError(2, `invalid --stage_n: ${raw}. Expected integer 1..999.`);
	}
	return value;
}

function pad2(value: number): string {
	return value.toString().padStart(2, "0");
}

function defaultRunId(now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
	const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = now.getUTCDate().toString().padStart(2, "0");
	const hh = now.getUTCHours().toString().padStart(2, "0");
	const min = now.getUTCMinutes().toString().padStart(2, "0");
	const suffix = randomBytes(2).toString("hex");
	return `${yyyy}-${mm}-${dd}-${hh}${min}-${suffix}`;
}

async function resolveArtifactContent(rawArtifact: string, cwd: string): Promise<string> {
	if (isRestrictedRoleAgentBash()) return rawArtifact;
	const candidate = path.isAbsolute(rawArtifact) ? rawArtifact : path.resolve(cwd, rawArtifact);
	try {
		const stat = await fs.stat(candidate);
		if (stat.isFile()) return await fs.readFile(candidate, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
			throw new RalplanCommandError(2, `failed to read --artifact ${candidate}: ${err.message}`);
		}
	}
	return rawArtifact;
}

/* ------------------------------ artifact write ------------------------------ */

interface ResolvedArtifactArgs {
	stage: RalplanStage;
	stageN: number;
	runId: string;
	artifact: string;
	sessionId: string;
	json: boolean;
}

function ralplanStatePath(cwd: string, sessionId: string): string {
	return modeStatePath(cwd, sessionId, "ralplan");
}

/** Reads and validates the persisted state that authorizes a live IRC pass. */
export async function hasActiveRalplanIrcRun(cwd: string, sessionId: string, runId: string): Promise<boolean> {
	const existingRead = await readExistingStateForMutation(ralplanStatePath(cwd, sessionId));
	return (
		existingRead.kind === "valid" &&
		existingRead.value.active === true &&
		existingRead.value.irc === true &&
		existingRead.value.irc_degraded !== true &&
		existingRead.value.run_id === runId
	);
}

async function readActiveRunId(cwd: string, sessionId: string): Promise<string | undefined> {
	const statePath = ralplanStatePath(cwd, sessionId);
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "absent") return undefined;
	if (existingRead.kind === "corrupt") {
		throw new RalplanCommandError(
			2,
			`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
		);
	}
	const candidate = typeof existingRead.value.run_id === "string" ? existingRead.value.run_id.trim() : "";
	if (!candidate) return undefined;
	assertSafePathComponent(candidate, "run-id");
	return candidate;
}

/**
 * Run-state phases that an artifact write must never reopen. Once ralplan has
 * reached a terminal/handed-off phase, a stray `--write` must not regress
 * `current_phase` back to a stage — that would silently re-arm a chain guard or
 * undo Stop semantics. Every other phase advances to track the stage just
 * persisted so run-state stays coherent with the active ralplan stage.
 */
const PHASE_LOCK = new Set([
	"final",
	"handoff",
	"complete",
	"completed",
	"failed",
	"cancelled",
	"canceled",
	"inactive",
]);

/** Phase that keeps run-state coherent with the stage just written, preserving locked phases. */
function advanceCurrentPhase(existingPhase: unknown, stage: RalplanStage): string {
	const current = typeof existingPhase === "string" ? existingPhase.trim() : "";
	if (current && PHASE_LOCK.has(current)) return current;
	return stage;
}

async function persistActiveRunId(cwd: string, sessionId: string, runId: string, stage: RalplanStage): Promise<void> {
	const statePath = ralplanStatePath(cwd, sessionId);
	await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") {
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
				);
			}
			let existing: Record<string, unknown> = existingRead.kind === "valid" ? existingRead.value : {};

			// A new run_id is a fresh run, not a stray write on the prior run: never inherit a
			// previous run's terminal/locked phase (which would start the new run already
			// "complete"/"handoff" and disarm the Stop hook). PHASE_LOCK only guards same-run writes.
			const isNewRun = existing.run_id !== runId;
			const nextPhase = isNewRun ? stage : advanceCurrentPhase(existing.current_phase, stage);
			if (
				existing.run_id === runId &&
				existing.version === WORKFLOW_STATE_VERSION &&
				existing.current_phase === nextPhase &&
				(existing.active === true || PHASE_LOCK.has(nextPhase))
			) {
				return;
			}
			existing.run_id = runId;
			if (typeof existing.skill !== "string") existing.skill = "ralplan";
			// A successful persist means ralplan is actively writing this run's artifacts, so always
			// re-assert active. Fallback-only init left active:false after a clear (#644, sibling of #638).
			existing.active = true;
			existing.current_phase = nextPhase;
			existing = migrateWorkflowState(existing, "ralplan").state;
			existing.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, existing, {
				cwd,
				receipt: { cwd, skill: "ralplan", owner: "gjc-runtime", command: "gjc ralplan persist-run-id", sessionId },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
		},
		{ cwd },
	);
}

/* --------------------------- planner run-state --------------------------- */

interface RoleStateUpdate {
	subagentId?: string;
	resumable?: boolean;
}

interface PlannerFallbackStateUpdate {
	reason: string;
	attemptedId: string;
	stageN: number;
	receiptPath?: string;
}

interface PlannerStateUpdate {
	roles: Partial<Record<"planner" | "architect" | "critic", RoleStateUpdate>>;
	plannerFallback?: PlannerFallbackStateUpdate;
}

function parseBooleanFlag(raw: string, flag: string): boolean {
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new RalplanCommandError(2, `invalid ${flag}: ${raw}. Expected "true" or "false".`);
}

function assertSubagentId(value: string, label: string): void {
	if (!SUBAGENT_ID_RE.test(value)) throw new RalplanCommandError(2, `invalid ${label}: ${value}`);
}

function plannerFlagValue(args: readonly string[], flag: string): string | undefined {
	const value = flagValue(args, flag);
	if (value === undefined && hasFlag(args, flag)) throw new RalplanCommandError(2, `missing value for ${flag}.`);
	return value;
}

function parsePlannerStateArgs(args: readonly string[]): PlannerStateUpdate | undefined {
	const roles: PlannerStateUpdate["roles"] = {};
	for (const role of ["planner", "architect", "critic"] as const) {
		const idFlag = `--${role}-id`;
		const resumableFlag = `--${role}-resumable`;
		const subagentId = plannerFlagValue(args, idFlag);
		const resumableRaw = plannerFlagValue(args, resumableFlag);
		if (subagentId === undefined && resumableRaw === undefined) continue;
		const update: RoleStateUpdate = {};
		if (subagentId !== undefined) {
			assertSubagentId(subagentId, idFlag);
			update.subagentId = subagentId;
		}
		if (resumableRaw !== undefined) update.resumable = parseBooleanFlag(resumableRaw, resumableFlag);
		roles[role] = update;
	}
	const fallbackReason = plannerFlagValue(args, "--fallback-reason");
	const fallbackAttemptedId = plannerFlagValue(args, "--fallback-attempted-id");
	const fallbackStageNRaw = plannerFlagValue(args, "--fallback-stage-n");
	const fallbackReceiptPath = plannerFlagValue(args, "--fallback-receipt-path");
	const anyFallback = [fallbackReason, fallbackAttemptedId, fallbackStageNRaw, fallbackReceiptPath].some(
		value => value !== undefined,
	);
	let plannerFallback: PlannerFallbackStateUpdate | undefined;
	if (anyFallback) {
		if (!fallbackReason)
			throw new RalplanCommandError(2, "--fallback-reason is required when recording planner fallback metadata.");
		if (!KNOWN_FALLBACK_REASONS.has(fallbackReason))
			throw new RalplanCommandError(
				2,
				`invalid --fallback-reason: ${fallbackReason}. Expected one of: ${[...KNOWN_FALLBACK_REASONS].join(", ")}.`,
			);
		if (fallbackAttemptedId === undefined)
			throw new RalplanCommandError(
				2,
				"--fallback-attempted-id is required when recording planner fallback metadata.",
			);
		assertSubagentId(fallbackAttemptedId, "--fallback-attempted-id");
		if (fallbackStageNRaw === undefined)
			throw new RalplanCommandError(2, "--fallback-stage-n is required when recording planner fallback metadata.");
		if (fallbackReceiptPath !== undefined && fallbackReceiptPath.trim() === "")
			throw new RalplanCommandError(2, "--fallback-receipt-path must not be empty.");
		plannerFallback = {
			reason: fallbackReason,
			attemptedId: fallbackAttemptedId,
			stageN: parseStageN(fallbackStageNRaw),
			receiptPath: fallbackReceiptPath,
		};
	}
	if (Object.keys(roles).length === 0 && !plannerFallback) return undefined;
	return { roles, plannerFallback };
}

function assertPlannerStateStageContract(stage: RalplanStage, update: PlannerStateUpdate | undefined): void {
	if (!update) return;
	const expectedRole =
		stage === "revision"
			? "planner"
			: stage === "planner" || stage === "architect" || stage === "critic"
				? stage
				: undefined;
	for (const role of Object.keys(update.roles) as Array<"planner" | "architect" | "critic">) {
		if (role !== expectedRole) {
			const expected = expectedRole ? `--${expectedRole}-*` : "no role metadata";
			throw new RalplanCommandError(
				2,
				`refusing --${role}-* metadata on a ${stage}-stage write; this stage accepts ${expected}.`,
			);
		}
	}
}

function plannerStatePayload(update: PlannerStateUpdate): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const [role, roleUpdate] of Object.entries(update.roles) as Array<
		["planner" | "architect" | "critic", RoleStateUpdate]
	>) {
		if (roleUpdate.subagentId !== undefined) payload[`${role}_subagent_id`] = roleUpdate.subagentId;
		if (roleUpdate.resumable !== undefined) payload[`${role}_resumable`] = roleUpdate.resumable;
	}
	if (update.plannerFallback) {
		payload.planner_fallback_reason = update.plannerFallback.reason;
		payload.planner_fallback_attempted_id = update.plannerFallback.attemptedId;
		payload.planner_fallback_stage_n = update.plannerFallback.stageN;
		if (update.plannerFallback.receiptPath !== undefined)
			payload.planner_fallback_receipt_path = update.plannerFallback.receiptPath;
	}
	return payload;
}

async function applyPlannerStateUpdate(
	cwd: string,
	sessionId: string,
	stage: RalplanStage,
	update: PlannerStateUpdate,
): Promise<void> {
	const statePath = ralplanStatePath(cwd, sessionId);
	await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt")
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
				);
			let existing: Record<string, unknown> = existingRead.kind === "valid" ? existingRead.value : {};
			const recordedCriticId = existing.critic_subagent_id;
			const requestedArchitectId = update.roles.architect?.subagentId;
			if (
				stage === "critic" &&
				typeof recordedCriticId === "string" &&
				requestedArchitectId !== undefined &&
				requestedArchitectId !== recordedCriticId
			) {
				throw new RalplanCommandError(
					2,
					`refusing --architect-id ${requestedArchitectId} on a critic-stage write: recorded critic role id is ${recordedCriticId}.`,
				);
			}

			let changed = false;
			for (const [role, roleUpdate] of Object.entries(update.roles) as Array<
				["planner" | "architect" | "critic", RoleStateUpdate]
			>) {
				for (const [field, value] of Object.entries({
					subagent_id: roleUpdate.subagentId,
					resumable: roleUpdate.resumable,
				})) {
					if (value === undefined) continue;
					const key = `${role}_${field}`;
					if (!(key in existing)) {
						existing[key] = value;
						changed = true;
					} else if (existing[key] !== value) {
						throw new RalplanCommandError(
							2,
							`refusing to overwrite recorded ${key}: existing value ${JSON.stringify(existing[key])} conflicts with ${JSON.stringify(value)}.`,
						);
					}
				}
			}
			if (update.plannerFallback) {
				Object.assign(existing, plannerStatePayload({ roles: {}, plannerFallback: update.plannerFallback }));
				changed = true;
			}
			if (!changed) return;
			if (typeof existing.skill !== "string") existing.skill = "ralplan";
			if (typeof existing.active !== "boolean") existing.active = true;
			if (typeof existing.current_phase !== "string") existing.current_phase = "planner";
			existing = migrateWorkflowState(existing, "ralplan").state;
			existing.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, existing, {
				cwd,
				receipt: { cwd, skill: "ralplan", owner: "gjc-runtime", command: "gjc ralplan planner-state", sessionId },
				audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "ralplan", sessionId },
			});
		},
		{ cwd },
	);
}

async function resolveArtifactArgs(args: readonly string[], cwd: string): Promise<ResolvedArtifactArgs> {
	const stage = flagValue(args, "--stage");
	if (!stage) throw new RalplanCommandError(2, "--stage is required for ralplan --write");
	assertKnownStage(stage);

	const stageN = parseStageN(flagValue(args, "--stage_n"));

	const rawArtifact = flagValue(args, "--artifact");
	const artifactEnvName = flagValue(args, "--artifact-env");
	const artifactSources = [rawArtifact, artifactEnvName].filter(value => value !== undefined);
	if (artifactSources.length === 0 || artifactSources.some(value => value === "")) {
		throw new RalplanCommandError(2, "--artifact or --artifact-env is required for ralplan --write");
	}
	if (artifactSources.length > 1) {
		throw new RalplanCommandError(2, "--artifact and --artifact-env are mutually exclusive");
	}
	if (artifactEnvName !== undefined && artifactEnvName !== GJC_RALPLAN_ARTIFACT_ENV) {
		throw new RalplanCommandError(2, `--artifact-env must be ${GJC_RALPLAN_ARTIFACT_ENV}`);
	}

	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");
	const sessionIdRaw = sessionId;

	// Precedence for run_id:
	//   1. explicit --run-id flag
	//   2. existing run_id field in .gjc/state[/sessions/<id>]/ralplan-state.json
	//   3. explicit --session-id flag (use as run id)
	//   4. freshly generated default run id
	const explicitRunId = flagValue(args, "--run-id")?.trim();
	const runId = explicitRunId || (await readActiveRunId(cwd, sessionId)) || sessionIdRaw || defaultRunId();
	assertSafePathComponent(runId, "run-id");

	const artifact =
		artifactEnvName !== undefined
			? (process.env[GJC_RALPLAN_ARTIFACT_ENV] ?? "")
			: await resolveArtifactContent(rawArtifact!, cwd);
	if (artifact === "") {
		throw new RalplanCommandError(2, "artifact content is empty");
	}
	return { stage: stage as RalplanStage, stageN, runId, artifact, sessionId, json: hasFlag(args, "--json") };
}

interface PersistedArtifact {
	runId: string;
	path: string;
	stage: RalplanStage;
	stageN: number;
	sha256: string;
	createdAt: string;
	pendingApprovalPath?: string;
}

/**
 * Content-addressed identity for an `index.jsonl` row: a repeated `--write` of the
 * same `(stage, stage_n)` at identical content (same sha256) is the #638 duplicate
 * the append must collapse. Rows missing these fields opt out of dedup.
 */
function ralplanIndexKey(entry: unknown): string | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const record = entry as Record<string, unknown>;
	const { stage, stage_n, sha256 } = record;
	if (typeof stage !== "string" || typeof stage_n !== "number" || typeof sha256 !== "string") return undefined;
	return `${stage}\u0000${stage_n}\u0000${sha256}`;
}

async function persistArtifact(
	resolved: ResolvedArtifactArgs,
	cwd: string,
	content: string,
	sha256: string,
): Promise<PersistedArtifact> {
	const runDir = path.join(sessionPlansDir(cwd, resolved.sessionId), "ralplan", resolved.runId);

	const fileName = `stage-${pad2(resolved.stageN)}-${resolved.stage}.md`;
	const filePath = path.join(runDir, fileName);
	await writeArtifact(filePath, content, {
		cwd,
		audit: {
			category: "artifact",
			verb: "write",
			owner: "gjc-runtime",
			skill: "ralplan",
			sessionId: resolved.sessionId,
		},
	});

	const createdAt = new Date().toISOString();
	const indexEntry = {
		stage: resolved.stage,
		stage_n: resolved.stageN,
		path: filePath,
		created_at: createdAt,
		sha256,
	};
	await appendJsonlIdempotent(path.join(runDir, "index.jsonl"), indexEntry, {
		cwd,
		audit: {
			category: "ledger",
			verb: "append",
			owner: "gjc-runtime",
			skill: "ralplan",
			sessionId: resolved.sessionId,
		},
		key: ralplanIndexKey,
	});

	let pendingApprovalPath: string | undefined;
	if (resolved.stage === "final") {
		pendingApprovalPath = path.join(runDir, "pending-approval.md");
		await writeArtifact(pendingApprovalPath, content, {
			cwd,
			audit: {
				category: "artifact",
				verb: "write",
				owner: "gjc-runtime",
				skill: "ralplan",
				sessionId: resolved.sessionId,
			},
		});
	}

	return {
		runId: resolved.runId,
		path: filePath,
		stage: resolved.stage,
		stageN: resolved.stageN,
		sha256,
		createdAt,
		pendingApprovalPath,
	};
}

/** The persisted `(stage, stage_n)` artifact recorded in a run's `index.jsonl`. */
interface ExistingStageArtifact {
	path: string;
	sha256: string;
	createdAt: string;
}

/**
 * Find the most recent `index.jsonl` row for a `(stage, stage_n)` pair so a
 * repeated `--write` can dedupe instead of silently clobbering the artifact and
 * appending a duplicate ledger row. Best-effort: a missing or unreadable index
 * yields `undefined`, treated as "no prior artifact". The ledger is the source of
 * truth for dedup because it is exactly what a duplicate write would corrupt.
 */
async function findExistingStageArtifact(
	cwd: string,
	sessionId: string,
	runId: string,
	stage: RalplanStage,
	stageN: number,
): Promise<ExistingStageArtifact | undefined> {
	const indexPath = path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId, "index.jsonl");
	let text: string;
	try {
		text = await fs.readFile(indexPath, "utf8");
	} catch {
		return undefined;
	}
	let match: ExistingStageArtifact | undefined;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let row: unknown;
		try {
			row = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const record = row as Record<string, unknown>;
		if (record.stage !== stage || record.stage_n !== stageN) continue;
		if (typeof record.path !== "string" || typeof record.sha256 !== "string") continue;
		match = {
			path: record.path,
			sha256: record.sha256,
			createdAt: typeof record.created_at === "string" ? record.created_at : "",
		};
	}
	return match;
}

/** Verify the canonical deliberation receipt and ledger entry before opening its IRC boundary. */
export async function hasPersistedRalplanDeliberationReceipt(
	cwd: string,
	sessionId: string,
	runId: string,
	stageN: number,
	expectedTranscriptSha256: string,
): Promise<boolean> {
	const receipt = await findExistingStageArtifact(cwd, sessionId, runId, "deliberation", stageN);
	if (!receipt) return false;
	const expectedPath = path.join(
		sessionPlansDir(cwd, sessionId),
		"ralplan",
		runId,
		`stage-${pad2(stageN)}-deliberation.md`,
	);
	if (receipt.path !== expectedPath) return false;
	try {
		const content = await fs.readFile(expectedPath, "utf8");
		const contentSha256 = createHash("sha256").update(content).digest("hex");
		return contentSha256 === receipt.sha256 && receipt.sha256 === expectedTranscriptSha256;
	} catch {
		return false;
	}
}

/**
 * Read and parse the run's `index.jsonl` rows. Best-effort: returns [] when the
 * file is absent or unreadable so HUD sync never fails on a missing index.
 */
async function readRalplanIndexRows(cwd: string, sessionId: string, runId: string): Promise<RalplanIndexRow[]> {
	try {
		const indexPath = path.join(sessionPlansDir(cwd, sessionId), "ralplan", runId, "index.jsonl");
		const text = await fs.readFile(indexPath, "utf8");
		const rows: RalplanIndexRow[] = [];
		for (const line of text.split(/\r?\n/)) {
			const row = parseRalplanIndexLine(line);
			if (row) rows.push(row);
		}
		return rows;
	} catch {
		return [];
	}
}

async function syncRalplanHud(options: {
	cwd: string;
	sessionId: string;
	stage: string;
	pendingApproval: boolean;
	iteration?: number;
	runId?: string;
	latestSummary?: string;
}): Promise<void> {
	try {
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: "ralplan",
			active: !options.pendingApproval || options.stage === "final",
			phase: options.stage,
			sessionId: options.sessionId,
			source: "gjc-ralplan-native",
			hud: await buildRalplanHud(options),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

async function buildRalplanHud(options: {
	cwd: string;
	stage: string;
	pendingApproval: boolean;
	iteration?: number;
	latestSummary?: string;
	runId?: string;
	sessionId?: string;
}) {
	let iterationFromIndex: number | undefined;
	let stages: string | undefined;
	if (options.runId && options.sessionId) {
		const rows = await readRalplanIndexRows(options.cwd, options.sessionId, options.runId);
		if (rows.length > 0) {
			const summary = summarizeRalplanIndex(rows);
			iterationFromIndex = summary.iteration;
			stages = formatRalplanStagePresence(summary.currentStages);
		}
	}
	return buildRalplanHudSummary({
		stage: options.stage,
		iteration: options.iteration,
		iterationFromIndex,
		stages,
		pendingApproval: options.pendingApproval,
		latestSummary: options.latestSummary,
		updatedAt: new Date().toISOString(),
	});
}

async function handleArtifactWrite(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	const plannerState = parsePlannerStateArgs(args);
	const resolved = await resolveArtifactArgs(args, cwd);
	assertPlannerStateStageContract(resolved.stage, plannerState);
	const content = resolved.artifact.endsWith("\n") ? resolved.artifact : `${resolved.artifact}\n`;
	const sha256 = createHash("sha256").update(content).digest("hex");

	// Duplicate-write guard: a second `--write` for the same (stage, stage_n) must not
	// silently clobber the artifact or append a duplicate ledger row. Classify before any
	// state mutation so a conflict never regresses run-state phase.
	const existingArtifact = await findExistingStageArtifact(
		cwd,
		resolved.sessionId,
		resolved.runId,
		resolved.stage,
		resolved.stageN,
	);
	if (existingArtifact) {
		if (existingArtifact.sha256 !== sha256) {
			throw new RalplanCommandError(
				2,
				`refusing to overwrite ralplan ${resolved.stage} stage ${resolved.stageN} at ${existingArtifact.path}: an artifact with different content already exists (existing sha256=${existingArtifact.sha256}, new sha256=${sha256}). Use a new --stage_n to record another pass.`,
			);
		}
		if (plannerState) await applyPlannerStateUpdate(cwd, resolved.sessionId, resolved.stage, plannerState);
		return buildDeduplicatedResult(resolved, existingArtifact, sha256, cwd);
	}

	if (plannerState) {
		await applyPlannerStateUpdate(cwd, resolved.sessionId, resolved.stage, plannerState);
	}
	// Keep run-state `current_phase` coherent with the stage being persisted.
	await persistActiveRunId(cwd, resolved.sessionId, resolved.runId, resolved.stage);
	const persisted = await persistArtifact(resolved, cwd, content, sha256);
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "ralplan-runtime", path: persisted.path });
	await syncRalplanHud({
		cwd,
		sessionId: resolved.sessionId,
		stage: persisted.stage,
		runId: persisted.runId,
		pendingApproval: persisted.stage === "final",
		iteration: persisted.stageN,
		latestSummary: `persisted ${persisted.stage} stage ${persisted.stageN}`,
	});
	const payload: Record<string, unknown> = {
		run_id: persisted.runId,
		path: persisted.path,
		stage: persisted.stage,
		stage_n: persisted.stageN,
		sha256: persisted.sha256,
		created_at: persisted.createdAt,
	};
	if (persisted.pendingApprovalPath) payload.pending_approval_path = persisted.pendingApprovalPath;
	if (plannerState) payload.planner_state = plannerStatePayload(plannerState);
	const stdout = resolved.json
		? `${JSON.stringify(payload, null, 2)}\n`
		: `Persisted ralplan ${persisted.stage} stage ${persisted.stageN} at ${persisted.path}.\n`;
	return { status: 0, stdout };
}

/**
 * Deterministic no-op receipt for an identical repeated `--write`: report the
 * already-persisted artifact without rewriting the file, appending a ledger row, or
 * churning run-state. `deduplicated: true` lets callers distinguish it from a fresh write.
 */
function buildDeduplicatedResult(
	resolved: ResolvedArtifactArgs,
	existing: ExistingStageArtifact,
	sha256: string,
	cwd: string,
): RalplanCommandResult {
	const payload: Record<string, unknown> = {
		run_id: resolved.runId,
		path: existing.path,
		stage: resolved.stage,
		stage_n: resolved.stageN,
		sha256,
		created_at: existing.createdAt,
		deduplicated: true,
	};
	if (resolved.stage === "final") {
		payload.pending_approval_path = path.join(
			sessionPlansDir(cwd, resolved.sessionId),
			"ralplan",
			resolved.runId,
			"pending-approval.md",
		);
	}
	const stdout = resolved.json
		? `${JSON.stringify(payload, null, 2)}\n`
		: `ralplan ${resolved.stage} stage ${resolved.stageN} already persisted at ${existing.path} (identical content; no changes written).\n`;
	return { status: 0, stdout };
}

/* -------------------------------- handoff -------------------------------- */

interface ConsensusHandoffArgs {
	interactive: boolean;
	deliberate: boolean;
	irc: boolean;
	architectKind?: string;
	criticKind?: string;
	sessionId: string;
	task: string;
	json: boolean;
}

function extractPositionalTask(args: readonly string[]): string {
	const parts: string[] = [];
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (VALUE_FLAGS.has(arg)) {
			skipNext = true;
			continue;
		}
		if (arg === "--interactive" || arg === "--deliberate" || arg === "--irc" || arg === "--write" || arg === "--json")
			continue;
		if (arg.startsWith("-")) {
			throw new RalplanCommandError(2, `unknown flag for gjc ralplan: ${arg}`);
		}
		parts.push(arg);
	}
	return parts.join(" ").trim();
}

function assertNoArtifactWriteOnlyFlags(args: readonly string[]): void {
	const flag = args.find(arg => ARTIFACT_WRITE_ONLY_VALUE_FLAGS.has(arg));
	if (flag) throw new RalplanCommandError(2, `${flag} is only valid with gjc ralplan --write.`);
}

function resolveConsensusArgs(args: readonly string[], cwd: string): ConsensusHandoffArgs {
	assertNoArtifactWriteOnlyFlags(args);
	const architectKind = flagValue(args, "--architect")?.trim() || undefined;
	if (architectKind && !KNOWN_ARCHITECT_KINDS.has(architectKind)) {
		throw new RalplanCommandError(
			2,
			`unknown --architect kind: ${architectKind}. Expected one of: ${[...KNOWN_ARCHITECT_KINDS].join(", ")}.`,
		);
	}
	const criticKind = flagValue(args, "--critic")?.trim() || undefined;
	if (criticKind && !KNOWN_CRITIC_KINDS.has(criticKind)) {
		throw new RalplanCommandError(
			2,
			`unknown --critic kind: ${criticKind}. Expected one of: ${[...KNOWN_CRITIC_KINDS].join(", ")}.`,
		);
	}
	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");
	const task = extractPositionalTask(args);
	return {
		interactive: hasFlag(args, "--interactive"),
		deliberate: hasFlag(args, "--deliberate"),
		irc: hasFlag(args, "--irc"),
		architectKind,
		criticKind,
		sessionId,
		task,
		json: hasFlag(args, "--json"),
	};
}

async function seedRalplanState(
	cwd: string,
	resolved: ConsensusHandoffArgs,
): Promise<{ statePath: string; runId: string }> {
	const statePath = ralplanStatePath(cwd, resolved.sessionId);
	const runId = await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") {
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
				);
			}
			const existing = existingRead.kind === "valid" ? existingRead.value : {};
			const existingRunId = typeof existing.run_id === "string" ? existing.run_id.trim() : "";
			if (existingRunId) assertSafePathComponent(existingRunId, "run-id");
			const existingPhase = typeof existing.current_phase === "string" ? existing.current_phase.trim() : "";
			const reuseActiveRun = Boolean(existingRunId) && existing.active === true && !PHASE_LOCK.has(existingPhase);
			const nextRunId = reuseActiveRun
				? existingRunId
				: existingRunId
					? defaultRunId()
					: resolved.sessionId || defaultRunId();
			assertSafePathComponent(nextRunId, "run-id");
			const payload: Record<string, unknown> = {
				...(reuseActiveRun ? existing : {}),
				skill: "ralplan",
				version: WORKFLOW_STATE_VERSION,
				mode: resolved.deliberate ? "deliberate" : "short",
				interactive: resolved.interactive,
				task: resolved.task,
				run_id: nextRunId,
				updated_at: new Date().toISOString(),
			};
			if (!reuseActiveRun) {
				payload.active = true;
				payload.current_phase = "planner";
			}
			if (resolved.irc) {
				payload.irc = true;
				if (!("irc_degraded" in payload)) payload.irc_degraded = false;
			}
			if (resolved.architectKind) payload.architect_kind = resolved.architectKind;
			if (resolved.criticKind) payload.critic_kind = resolved.criticKind;
			if (resolved.sessionId) payload.session_id = resolved.sessionId;
			await writeWorkflowEnvelopeAtomic(statePath, payload, {
				cwd,
				receipt: {
					cwd,
					skill: "ralplan",
					owner: "gjc-runtime",
					command: "gjc ralplan seed",
					sessionId: resolved.sessionId,
				},
				audit: {
					category: "state",
					verb: "write",
					owner: "gjc-runtime",
					skill: "ralplan",
					sessionId: resolved.sessionId,
				},
			});
			return nextRunId;
		},
		{ cwd },
	);
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "ralplan-runtime", path: statePath });
	return { statePath, runId };
}

export interface RalplanIrcActivationDegradationArgs {
	cwd: string;
	sessionId: string;
	runId: string;
	reason: string;
}

export interface RalplanIrcPassDegradationArgs extends RalplanIrcActivationDegradationArgs {
	stageN: number;
}

async function latchRalplanIrcDegradation(args: RalplanIrcActivationDegradationArgs, stageN?: number): Promise<void> {
	assertSafePathComponent(args.sessionId, "session-id");
	assertSafePathComponent(args.runId, "run-id");
	if (!args.reason.trim()) throw new RalplanCommandError(2, "IRC degradation reason must not be empty.");
	if (stageN !== undefined && (!Number.isInteger(stageN) || stageN < 1 || stageN > 999)) {
		throw new RalplanCommandError(2, `invalid IRC degradation stage: ${stageN}`);
	}
	const statePath = ralplanStatePath(args.cwd, args.sessionId);
	await withWorkflowStateLock(
		statePath,
		async () => {
			const existingRead = await readExistingStateForMutation(statePath);
			if (existingRead.kind === "corrupt") {
				throw new RalplanCommandError(
					2,
					`existing ralplan state is corrupt or tampered (${existingRead.error}); refusing to overwrite ${statePath}`,
				);
			}
			if (existingRead.kind !== "valid")
				throw new RalplanCommandError(2, "no active matching IRC ralplan run to degrade.");
			let state = existingRead.value;
			if (state.run_id !== args.runId || state.active !== true || state.irc !== true) {
				throw new RalplanCommandError(2, "no active matching IRC ralplan run to degrade.");
			}
			if (state.irc_degraded === true) return;
			state.irc_degraded = true;
			state.irc_degrade_reason = args.reason;
			state.irc_degraded_at = new Date().toISOString();
			if (stageN !== undefined) state.irc_degraded_at_stage_n = stageN;
			state = migrateWorkflowState(state, "ralplan").state;
			state.updated_at = new Date().toISOString();
			await writeWorkflowEnvelopeAtomic(statePath, state, {
				cwd: args.cwd,
				receipt: {
					cwd: args.cwd,
					skill: "ralplan",
					owner: "gjc-runtime",
					command: "gjc ralplan irc-degrade",
					sessionId: args.sessionId,
				},
				audit: {
					category: "state",
					verb: "write",
					owner: "gjc-runtime",
					skill: "ralplan",
					sessionId: args.sessionId,
				},
			});
		},
		{ cwd: args.cwd },
	);
}

export async function degradeRalplanIrcActivation(args: RalplanIrcActivationDegradationArgs): Promise<void> {
	await latchRalplanIrcDegradation(args);
}

export async function degradeRalplanIrcPass(args: RalplanIrcPassDegradationArgs): Promise<void> {
	await latchRalplanIrcDegradation(args, args.stageN);
}

async function handleConsensusHandoff(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	const resolved = resolveConsensusArgs(args, cwd);
	if (!resolved.task) {
		throw new RalplanCommandError(2, 'gjc ralplan requires a task description, e.g. `gjc ralplan "<task>"`.');
	}
	const { statePath, runId } = await seedRalplanState(cwd, resolved);
	const mode = resolved.deliberate ? "deliberate" : "short";
	await syncRalplanHud({
		cwd,
		sessionId: resolved.sessionId,
		stage: "planner",
		runId,
		pendingApproval: false,
		iteration: 1,
		latestSummary: `${mode} run · ${resolved.interactive ? "interactive" : "automated"}${resolved.irc ? " · irc" : ""}`,
	});

	const summary = {
		skill: "ralplan",
		mode,
		state_path: statePath,
		run_id: runId,
		handoff: "/skill:ralplan",
		...(resolved.irc ? { irc: true } : {}),
	};
	const stdout = resolved.json
		? renderCliWriteReceipt({ ok: true, ...summary })
		: [
				`ralplan seed run_id=${runId}`,
				`state_path=${statePath}`,
				`mode=${mode} interactive=${resolved.interactive} architect=${resolved.architectKind ?? "default"} critic=${resolved.criticKind ?? "default"}${resolved.irc ? " irc=true" : ""}`,
				"handoff=/skill:ralplan",
				"",
			].join("\n");
	return { status: 0, stdout };
}

async function handleDoctor(args: readonly string[], cwd: string): Promise<RalplanCommandResult> {
	return await runNativeStateCommand(["doctor", "--skill", "ralplan", ...args.slice(1)], cwd);
}

/* -------------------------------- entry --------------------------------- */

export async function runNativeRalplanCommand(args: string[], cwd = process.cwd()): Promise<RalplanCommandResult> {
	try {
		if (isRalplanDoctorInvocation(args)) return await handleDoctor(args, cwd);
		if (isRalplanArtifactWriteInvocation(args)) return await handleArtifactWrite(args, cwd);
		return await handleConsensusHandoff(args, cwd);
	} catch (error) {
		if (error instanceof RalplanCommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
