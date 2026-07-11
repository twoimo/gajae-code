import * as fs from "node:fs/promises";
import * as os from "node:os";
import { getProjectDir } from "@gajae-code/utils";
import { getEmbeddedDefaultGjcSkillFragments } from "../defaults/gjc-defaults";
import { degradeRalplanIrcActivation, runNativeRalplanCommand } from "../gjc-runtime/ralplan-runtime";
import { modeStatePath } from "../gjc-runtime/session-layout";
import { readExistingStateForMutation } from "../gjc-runtime/state-writer";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { type Skill as CapabilitySkill, loadCapability } from "../discovery";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import type { SkillPromptDetails, WorkflowSkillActivation } from "../session/messages";
import { expandTilde } from "../tools/path-utils";
import type { LoadedSubskillActivation } from "./gjc-plugins";
import { buildSubskillInjection } from "./gjc-plugins/injection";
import { renderSkillAdvertisement } from "./gjc-plugins/runtime-adapters";
export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/**
	 * When `true`, the skill is loaded and reachable via `skill://<name>` and
	 * skill slash aliases, but is excluded from the rendered system prompt's
	 * `<skills>` listing.
	 */
	hide?: boolean;
	/** Source metadata for display */
	_source?: SourceMeta;
	/** Embedded SKILL.md content for bundled defaults that survive .gjc deletion. */
	content?: string;
}

export interface SkillWarning {
	skillPath: string;
	message: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/** Replace the active skill snapshot. Called once per top-level session. */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/** Reset the active skill snapshot. Test-only. */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || "custom";
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir(
		{ cwd: getProjectDir(), home: os.homedir(), repoRoot: null },
		{
			dir: options.dir,
			providerId,
			level,
			requireDescription: true,
		},
	);

	return {
		skills: result.items.map(capSkill => ({
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			source: options.source,
			hide: capSkill.frontmatter?.hide === true,
			_source: capSkill._source,
		})),
		warnings: (result.warnings ?? []).map(message => ({ skillPath: options.dir, message })),
	};
}

export interface LoadSkillsOptions extends SkillsSettings {
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		enabled = true,
		enablePiUser = true,
		enablePiProject = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}

	// GJC only accepts native `.gjc` skills. Other providers may still exist for
	// their own capabilities, but their skill surfaces are intentionally ignored.
	function isSourceEnabled(source: SourceMeta): boolean {
		const { provider, level } = source;
		if (provider !== "native") return false;
		if (level === "user") return enablePiUser;
		if (level === "project") return enablePiProject;
		return false;
	}

	// Use capability API to load all skills
	const result = await loadCapability<CapabilitySkill>(skillCapability.id, { cwd, disabledExtensions });

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	// Check if skill name matches any of the include patterns
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	// Check if skill name matches any of the ignore patterns
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);
	// Filter skills by source and patterns first
	const filteredSkills = result.items.filter(capSkill => {
		if (disabledSkillNames.has(capSkill.name)) return false;
		if (!isSourceEnabled(capSkill._source)) return false;
		if (matchesIgnorePatterns(capSkill.name)) return false;
		if (!matchesIncludePatterns(capSkill.name)) return false;
		return true;
	});

	// Batch resolve all real paths in parallel
	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		const existing = skillMap.get(capSkill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(capSkill.name, {
				name: capSkill.name,
				description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
				filePath: capSkill.path,
				baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
				source: `${capSkill._source.provider}:${capSkill.level}`,
				hide: capSkill.frontmatter?.hide === true,
				_source: capSkill._source,
			});
			realPathSet.add(resolvedPath);
		}
	}

	const customDirectoryResults = await Promise.all(
		customDirectories.map(async dir => {
			const expandedDir = expandTilde(dir);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home: os.homedir(), repoRoot: null },
				{
					dir: expandedDir,
					providerId: "custom",
					level: "user",
					requireDescription: true,
				},
			);
			return { expandedDir, scanResult };
		}),
	);

	const allCustomSkills: Array<{ skill: Skill; path: string }> = [];
	for (const { expandedDir, scanResult } of customDirectoryResults) {
		for (const capSkill of scanResult.items) {
			if (disabledSkillNames.has(capSkill.name)) continue;
			if (matchesIgnorePatterns(capSkill.name)) continue;
			if (!matchesIncludePatterns(capSkill.name)) continue;
			allCustomSkills.push({
				skill: {
					name: capSkill.name,
					description:
						typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
					filePath: capSkill.path,
					baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
					source: "custom:user",
					hide: capSkill.frontmatter?.hide === true,
					_source: { ...capSkill._source, providerName: "Custom" },
				},
				path: capSkill.path,
			});
		}
		collisionWarnings.push(...(scanResult.warnings ?? []).map(message => ({ skillPath: expandedDir, message })));
	}

	const customRealPaths = await Promise.all(
		allCustomSkills.map(async ({ path }) => {
			try {
				return await fs.realpath(path);
			} catch {
				return path;
			}
		}),
	);

	for (let i = 0; i < allCustomSkills.length; i++) {
		const { skill } = allCustomSkills[i];
		const resolvedPath = customRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;

		const existing = skillMap.get(skill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: skill.filePath,
				message: `name collision: "${skill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(skill.name, skill);
			realPathSet.add(resolvedPath);
		}
	}

	const skills = Array.from(skillMap.values());
	// Deterministic ordering for prompt stability (case-insensitive, then exact name, then path).
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));

	return {
		skills,
		warnings: [...(result.warnings ?? []).map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}

export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

export interface BuildSkillPromptMessageContext {
	subskillActivation?: LoadedSubskillActivation;
	subskillActivationSet?: LoadedSubskillActivation[];
	currentPhase?: string;
	cwd?: string;
	sessionId?: string;
}

export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

export function isNamespacedSkillSlashCommandName(commandName: string): boolean {
	return commandName.startsWith("skill:");
}

export function getSkillSlashCommandNames(skill: Pick<Skill, "name">): string[] {
	return [getSkillSlashCommandName(skill)];
}

export function isSkillSlashCommandName(commandName: string, skill: Pick<Skill, "name">): boolean {
	return commandName === getSkillSlashCommandName(skill);
}

export interface ResolvedSkillSlashCommand {
	name: string;
	description: string;
	skill: Skill;
}

export interface ParsedSkillInvocation {
	commandName: string;
	args: string;
	skill: Skill;
}

interface SkillTokenMatch {
	index: number;
	end: number;
	commandName: string;
	skill: Skill;
}

function buildInlineSkillInvocationArgs(text: string, matches: readonly SkillTokenMatch[]): string {
	const pieces: string[] = [];
	let cursor = 0;
	for (const match of matches) {
		pieces.push(text.slice(cursor, match.index));
		cursor = match.end;
	}
	pieces.push(text.slice(cursor));
	return pieces
		.join("")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.trim();
}

export function parseSkillInvocations(
	text: string,
	skillsByCommandName: ReadonlyMap<string, Skill>,
): ParsedSkillInvocation[] {
	const trimmedText = text.trim();
	if (!trimmedText) return [];
	const canonicalSkillCommandPattern = /(^|\s)\/(skill:[^\s]+)/g;
	const matches: SkillTokenMatch[] = [];
	for (const match of trimmedText.matchAll(canonicalSkillCommandPattern)) {
		const commandName = match[2];
		if (!commandName) continue;
		const skill = skillsByCommandName.get(commandName);
		if (!skill) continue;
		const leading = match[1] ?? "";
		const index = (match.index ?? 0) + leading.length;
		matches.push({
			index,
			end: index + commandName.length + 1,
			commandName,
			skill,
		});
	}
	if (matches.length === 0) return [];
	if (matches[0]?.index !== 0) {
		// Preserve leading slash-command semantics: `/skill:unknown /skill:alpha`
		// should remain plain text rather than silently skipping the unknown
		// leading command and invoking the later known one.
		if (trimmedText.startsWith("/")) return [];
		const args = buildInlineSkillInvocationArgs(trimmedText, matches);
		return matches.map(match => ({
			commandName: match.commandName,
			args,
			skill: match.skill,
		}));
	}
	return matches.map((match, index) => {
		const next = matches[index + 1];
		return {
			commandName: match.commandName,
			args: trimmedText.slice(match.end, next?.index).trim(),
			skill: match.skill,
		};
	});
}

export function resolveSkillSlashCommands(
	skills: readonly Skill[],
	_reservedDirectCommandNames: ReadonlySet<string>,
): ResolvedSkillSlashCommand[] {
	const commands: ResolvedSkillSlashCommand[] = [];
	const claimedNames = new Set<string>();
	for (const skill of skills) {
		if (skill.hide === true) continue;
		for (const name of getSkillSlashCommandNames(skill)) {
			if (claimedNames.has(name)) {
				continue;
			}
			claimedNames.add(name);
			commands.push({ name, description: skill.description, skill });
		}
	}
	return commands;
}

interface RalplanInvocationFlags {
	interactive: boolean;
	irc: boolean;
	argv: string[];
	hasTask: boolean;
	hasWorkflowFlags: boolean;
}

class RalplanActivationError extends Error {
	constructor(message: string, readonly operation: "native_handoff" | "fragment_load", readonly status?: number, readonly stderr?: string, readonly cause?: Error) {
		super(message);
		this.name = "RalplanActivationError";
	}
}

function bounded(value: unknown, limit = 1_000): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replaceAll("\u0000", "").trim();
	return normalized ? normalized.slice(0, limit) : undefined;
}

function parseRalplanInvocation(args: string): RalplanInvocationFlags {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let interactive = false;
	let irc = false;
	let hasTask = false;
	let hasWorkflowFlags = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--interactive") {
			interactive = true;
			hasWorkflowFlags = true;
			continue;
		}
		if (token === "--deliberate" || token === "--irc") {
			if (token === "--irc") irc = true;
			hasWorkflowFlags = true;
			continue;
		}
		if (token === "--architect" || token === "--critic") {
			if (!tokens[index + 1] || tokens[index + 1]!.startsWith("-")) {
				throw new RalplanActivationError(`${token} requires a non-option value`, "native_handoff", 2);
			}
			hasWorkflowFlags = true;
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			throw new RalplanActivationError(`unsupported ralplan option: ${token}`, "native_handoff", 2);
		}
		hasTask = true;
	}
	return { interactive, irc, argv: tokens, hasTask, hasWorkflowFlags };
}

async function readMatchingRalplanState(cwd: string, sessionId: string, runId?: string): Promise<Record<string, unknown> | undefined> {
	const read = await readExistingStateForMutation(modeStatePath(cwd, sessionId, "ralplan"));
	if (read.kind === "corrupt") throw new Error(`ralplan state is corrupt or unreadable: ${read.error}`);
	if (read.kind !== "valid") return undefined;
	const state = read.value;
	if (state.session_id !== sessionId || typeof state.run_id !== "string" || !state.run_id.trim() || (runId !== undefined && state.run_id !== runId)) return undefined;
	return state;
}

function activationWarning(error: RalplanActivationError): NonNullable<WorkflowSkillActivation["warning"]> {
	return { code: "ralplan_irc_activation_degraded", operation: error.operation, message: error.message, ...(error.status === undefined ? {} : { status: error.status }), ...(error.stderr ? { stderr: error.stderr } : {}), ...(error.cause?.name ? { causeName: error.cause.name } : {}) };
}

function legacyContinuationInstruction(): string {
	return "\n\n---\n\n<ralplan-irc-degraded>IRC activation is durably degraded for this run. Continue with fresh-spawn legacy Planner, Architect, and Critic roles for the entire run; do not call coordinator pass operations or resume persisted IRC roles. Receipts remain the only consensus verdict authority.</ralplan-irc-degraded>";
}

async function loadRalplanIrcFragment(skill: Pick<Skill, "filePath">): Promise<string> {
	if (skill.filePath.startsWith("embedded:")) {
		const fragment = getEmbeddedDefaultGjcSkillFragments("ralplan").find(candidate => candidate.relativePath === "skill-fragments/ralplan/irc-consensus.md");
		if (!fragment) throw new Error("embedded ralplan IRC fragment is unavailable");
		return fragment.content;
	}
	return await Bun.file(path.resolve(path.dirname(skill.filePath), "..", "..", "skill-fragments", "ralplan", "irc-consensus.md")).text();
}

export async function prepareWorkflowSkillInvocation(skill: Pick<Skill, "name" | "filePath">, args: string, context: BuildSkillPromptMessageContext | undefined): Promise<{ activation?: WorkflowSkillActivation; fragment?: string; legacyContinuation: boolean }> {
	if (skill.name !== "ralplan" || !context?.cwd || !context.sessionId) return { legacyContinuation: false };
	const flags = parseRalplanInvocation(args);
	let activationError: RalplanActivationError | undefined;
	let runId: string | undefined;
	try {
		const result = await runNativeRalplanCommand(["--session-id", context.sessionId, "--json", ...flags.argv], context.cwd);
		if (result.status !== 0) throw new RalplanActivationError(`ralplan native handoff failed (status=${result.status})`, "native_handoff", result.status, bounded(result.stderr));
		if (!result.stdout?.trim()) throw new RalplanActivationError("ralplan native handoff returned no JSON receipt", "native_handoff", result.status, bounded(result.stderr));
		let payload: Record<string, unknown>;
		try { payload = JSON.parse(result.stdout) as Record<string, unknown>; } catch (cause) { throw new RalplanActivationError("ralplan native handoff returned invalid JSON", "native_handoff", result.status, bounded(result.stderr), cause instanceof Error ? cause : undefined); }
		if (payload.ok !== true || payload.skill !== "ralplan" || typeof payload.run_id !== "string" || !payload.run_id.trim() || payload.state_path !== modeStatePath(context.cwd, context.sessionId, "ralplan")) throw new RalplanActivationError("ralplan native handoff returned an invalid receipt", "native_handoff", result.status, bounded(result.stderr));
		runId = payload.run_id;
		const state = await readMatchingRalplanState(context.cwd, context.sessionId, runId);
		if (!state || (flags.irc && (payload.irc !== true || state.irc !== true))) throw new RalplanActivationError("ralplan native handoff state does not match the validated receipt", "native_handoff", result.status, bounded(result.stderr));
		if (state.irc_degraded === true) {
			const degradeReason = bounded(state.irc_degrade_reason) ?? "activation_failed";
			return { activation: { skill: "ralplan", sessionId: context.sessionId, runId, interactive: flags.interactive, ircRequested: flags.irc, ircActive: false, degraded: true, degradeReason }, legacyContinuation: true };
		}
		const activation: WorkflowSkillActivation = { skill: "ralplan", sessionId: context.sessionId, runId, interactive: flags.interactive, ircRequested: flags.irc, ircActive: state.irc === true && state.irc_degraded !== true, degraded: false };
		if (!activation.ircActive) return { activation, legacyContinuation: false };
		try { return { activation, fragment: await loadRalplanIrcFragment(skill), legacyContinuation: false }; }
		catch (cause) { activationError = new RalplanActivationError("ralplan IRC fragment could not be loaded", "fragment_load", undefined, undefined, cause instanceof Error ? cause : undefined); }
	} catch (cause) {
		activationError = cause instanceof RalplanActivationError ? cause : new RalplanActivationError("ralplan native handoff failed", "native_handoff", undefined, undefined, cause instanceof Error ? cause : undefined);
		if (!flags.irc) {
			if (!flags.hasWorkflowFlags && !flags.hasTask && activationError.status === 2) return { legacyContinuation: true };
			throw activationError;
		}
	}
	let state: Record<string, unknown> | undefined;
	try {
		state = await readMatchingRalplanState(context.cwd, context.sessionId, runId);
	} catch (readError) {
		throw new AggregateError([activationError, readError], "ralplan activation recovery state read failed");
	}
	const matchingRunId = typeof state?.run_id === "string" ? state.run_id : undefined;
	if (!activationError || !matchingRunId || state?.active !== true || state.irc !== true || state.irc_degraded === true) throw activationError ?? new Error("ralplan activation failed without a recoverable run");
	const reason = activationError.operation === "fragment_load" ? "fragment_unavailable" : "activation_failed";
	try { await degradeRalplanIrcActivation({ cwd: context.cwd, sessionId: context.sessionId, runId: matchingRunId, reason }); }
	catch (degradationError) { throw new AggregateError([activationError, degradationError], "ralplan activation degradation failed"); }
	let confirmed: Record<string, unknown> | undefined;
	try {
		confirmed = await readMatchingRalplanState(context.cwd, context.sessionId, matchingRunId);
	} catch (confirmationError) {
		throw new AggregateError([activationError, confirmationError], "ralplan activation degradation confirmation failed");
	}
	if (confirmed?.active !== true || confirmed.irc !== true || confirmed.irc_degraded !== true || confirmed.irc_degrade_reason !== reason) throw new AggregateError([activationError, new Error("ralplan activation degradation was not durably confirmed")], "ralplan activation degradation confirmation failed");
	return { activation: { skill: "ralplan", sessionId: context.sessionId, runId: matchingRunId, interactive: flags.interactive, ircRequested: flags.irc, ircActive: false, degraded: true, degradeReason: reason, warning: activationWarning(activationError) }, legacyContinuation: true };
}

export async function buildSkillPromptMessage(
	skill: Pick<Skill, "name" | "filePath" | "content">,
	args: string,
	context?: BuildSkillPromptMessageContext,
): Promise<BuiltSkillPromptMessage> {
	const content = typeof skill.content === "string" ? skill.content : await Bun.file(skill.filePath).text();
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
	const workflow = await prepareWorkflowSkillInvocation(skill, args, context);
	const metaLines = [`Skill: ${skill.filePath}`];
	const trimmedArgs = args.trim();
	if (trimmedArgs) {
		metaLines.push(`User: ${trimmedArgs}`);
	}
	let message = `${body}${workflow.fragment ? `\n\n---\n\n${workflow.fragment.trim()}` : ""}${workflow.legacyContinuation ? legacyContinuationInstruction() : ""}\n\n---\n\n${metaLines.join("\n")}`;
	const details: SkillPromptDetails = {
		name: skill.name,
		path: skill.filePath,
		args: trimmedArgs || undefined,
		lineCount: body ? body.split("\n").length : 0,
		...(workflow.activation ? { workflowActivation: workflow.activation } : {}),
	};
	if (context?.subskillActivationSet) {
		details.subskillActivationSet = context.subskillActivationSet;
	}
	if (context) {
		const injection = context.cwd
			? await buildSubskillInjection({
					cwd: context.cwd,
					sessionId: context.sessionId,
					skillName: skill.name,
					activation: context.subskillActivation,
					currentPhase: context.currentPhase,
				})
			: null;
		if (injection) {
			message += injection.block;
			details.subskillActivation = injection.details ?? context.subskillActivation;
		} else if (context.subskillActivation) {
			details.subskillActivation = context.subskillActivation;
		}
		// Tier-1 advertisement: metadata-only list of installed sub-skills bound to
		// this parent skill, so the agent can choose one contextually.
		if (context.cwd) {
			try {
				const advert = await renderSkillAdvertisement({
					cwd: context.cwd,
					skillName: skill.name,
					phase: context.currentPhase,
				});
				if (advert) message += `\n\n${advert}`;
			} catch {
				// Advertisement is best-effort; never block skill prompt construction.
			}
		}
	}
	return {
		message,
		details,
	};
}
