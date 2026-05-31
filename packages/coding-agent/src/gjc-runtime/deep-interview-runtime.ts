import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncSkillActiveState } from "../skill-state/active-state";
import { buildDeepInterviewHudSummary } from "../skill-state/workflow-hud";

/**
 * Native implementation of `gjc deep-interview`.
 *
 * The CLI itself does not run the Socratic interview; that lives inside the `/skill:deep-interview`
 * skill executed by the agent. This handler validates the documented argument-hint surface
 * (`[--quick|--standard|--deep] <idea>`), seeds `.gjc/state/deep-interview-state.json`, and
 * updates the shared HUD rail via `syncSkillActiveState` so the active interview is visible to
 * the TUI.
 */

export interface DeepInterviewCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const PATH_COMPONENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

const DEFAULT_AMBIGUITY_THRESHOLD = 0.05;

const RESOLUTION_THRESHOLDS = {
	quick: 0.6,
	standard: 0.5,
	deep: 0.35,
} as const;

type DeepInterviewResolution = keyof typeof RESOLUTION_THRESHOLDS;

class DeepInterviewCommandError extends Error {
	constructor(
		public readonly exitStatus: number,
		message: string,
	) {
		super(message);
		this.name = "DeepInterviewCommandError";
	}
}

const VALUE_FLAGS = new Set(["--session-id", "--threshold", "--threshold-source"]);

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
	return args.includes(flag);
}

function assertSafePathComponent(value: string, label: string): void {
	if (!PATH_COMPONENT_RE.test(value) || value.includes("..")) {
		throw new DeepInterviewCommandError(2, `invalid path component for --${label}: ${value}`);
	}
}

function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

interface ResolvedDeepInterviewArgs {
	resolution: DeepInterviewResolution;
	threshold: number;
	thresholdSource: string;
	sessionId?: string;
	idea: string;
	json: boolean;
}

async function readSettingsAmbiguityThreshold(
	settingsPath: string,
): Promise<{ threshold: number; source: string } | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(settingsPath, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return undefined;
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const candidate = (parsed as { gjc?: { deepInterview?: { ambiguityThreshold?: unknown } } })?.gjc?.deepInterview
		?.ambiguityThreshold;
	if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0 || candidate > 1) {
		return undefined;
	}
	return { threshold: candidate, source: settingsPath };
}

async function resolveConfiguredAmbiguityThreshold(
	cwd: string,
): Promise<{ threshold: number; source: string } | undefined> {
	const projectSettings = path.join(cwd, ".gjc", "settings.json");
	const projectValue = await readSettingsAmbiguityThreshold(projectSettings);
	if (projectValue) return projectValue;
	const configDir = process.env.GJC_CONFIG_DIR?.trim() || path.join(os.homedir(), ".gjc");
	const userSettings = path.join(configDir, "settings.json");
	return await readSettingsAmbiguityThreshold(userSettings);
}

async function resolveDeepInterviewArgs(args: readonly string[], cwd: string): Promise<ResolvedDeepInterviewArgs> {
	const sessionId = flagValue(args, "--session-id")?.trim() || undefined;
	if (sessionId) assertSafePathComponent(sessionId, "session-id");

	const explicitResolutions = (["quick", "standard", "deep"] as const).filter(name => hasFlag(args, `--${name}`));
	if (explicitResolutions.length > 1) {
		throw new DeepInterviewCommandError(2, "pass at most one of --quick, --standard, --deep");
	}
	const resolution: DeepInterviewResolution | undefined = explicitResolutions[0];

	// Precedence: --threshold > settings.json (project then user) > resolution flag default > 0.05.
	let threshold: number = DEFAULT_AMBIGUITY_THRESHOLD;
	let thresholdSource = "default";
	const thresholdOverride = flagValue(args, "--threshold");
	if (thresholdOverride !== undefined) {
		const parsed = Number(thresholdOverride);
		if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
			throw new DeepInterviewCommandError(
				2,
				`invalid --threshold: ${thresholdOverride}. Expected 0 < threshold <= 1.`,
			);
		}
		threshold = parsed;
		thresholdSource = flagValue(args, "--threshold-source")?.trim() || "flag:--threshold";
	} else {
		const configured = await resolveConfiguredAmbiguityThreshold(cwd);
		if (configured) {
			threshold = configured.threshold;
			thresholdSource = configured.source;
		} else if (resolution) {
			threshold = RESOLUTION_THRESHOLDS[resolution];
			thresholdSource = `flag:--${resolution}`;
		}
	}

	const ideaParts: string[] = [];
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
		if (arg === "--quick" || arg === "--standard" || arg === "--deep" || arg === "--json") continue;
		if (arg.startsWith("-")) {
			throw new DeepInterviewCommandError(2, `unknown flag for gjc deep-interview: ${arg}`);
		}
		ideaParts.push(arg);
	}
	const idea = ideaParts.join(" ").trim();
	const effectiveResolution: DeepInterviewResolution = resolution ?? "standard";
	return {
		resolution: effectiveResolution,
		threshold,
		thresholdSource,
		sessionId,
		idea,
		json: hasFlag(args, "--json"),
	};
}

async function seedDeepInterviewState(cwd: string, resolved: ResolvedDeepInterviewArgs): Promise<string> {
	const stateDir = resolved.sessionId
		? path.join(cwd, ".gjc", "state", "sessions", encodeSessionSegment(resolved.sessionId))
		: path.join(cwd, ".gjc", "state");
	await fs.mkdir(stateDir, { recursive: true });
	const statePath = path.join(stateDir, "deep-interview-state.json");
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = {
		active: true,
		current_phase: "interviewing",
		skill: "deep-interview",
		resolution: resolved.resolution,
		threshold: resolved.threshold,
		threshold_source: resolved.thresholdSource,
		state: {
			initial_idea: resolved.idea,
			rounds: [],
			current_ambiguity: 1.0,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
		},
		updated_at: now,
	};
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await fs.writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`);
	return statePath;
}

async function syncDeepInterviewHud(options: {
	cwd: string;
	sessionId?: string;
	phase: string;
	ambiguity?: number;
	threshold?: number;
	roundCount?: number;
	specStatus?: string;
}): Promise<void> {
	try {
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: "deep-interview",
			active: options.phase !== "complete",
			phase: options.phase,
			sessionId: options.sessionId,
			source: "gjc-deep-interview-native",
			hud: buildDeepInterviewHudSummary({
				phase: options.phase,
				ambiguity: options.ambiguity,
				threshold: options.threshold,
				roundCount: options.roundCount,
				specStatus: options.specStatus,
				updatedAt: new Date().toISOString(),
			}),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

export async function runNativeDeepInterviewCommand(
	args: string[],
	cwd = process.cwd(),
): Promise<DeepInterviewCommandResult> {
	try {
		const resolved = await resolveDeepInterviewArgs(args, cwd);
		if (!resolved.idea) {
			throw new DeepInterviewCommandError(
				2,
				'gjc deep-interview requires an idea, e.g. `gjc deep-interview "<idea>"`.',
			);
		}
		const statePath = await seedDeepInterviewState(cwd, resolved);
		await syncDeepInterviewHud({
			cwd,
			sessionId: resolved.sessionId,
			phase: "interviewing",
			ambiguity: 1,
			threshold: resolved.threshold,
			roundCount: 0,
		});

		const summary = {
			skill: "deep-interview",
			resolution: resolved.resolution,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
			idea: resolved.idea,
			state_path: statePath,
			handoff: "Run `/skill:deep-interview` inside the GJC agent to drive the Socratic interview loop.",
		};
		const stdout = resolved.json
			? `${JSON.stringify(summary, null, 2)}\n`
			: [
					`Seeded deep-interview ${resolved.resolution} run at ${statePath}.`,
					`Threshold: ${(resolved.threshold * 100).toFixed(0)}% (source: ${resolved.thresholdSource}).`,
					"Run `/skill:deep-interview` inside the GJC agent to execute the interview.",
					"",
				].join("\n");
		return { status: 0, stdout };
	} catch (error) {
		if (error instanceof DeepInterviewCommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
