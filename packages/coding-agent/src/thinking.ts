import { type ResolvedThinkingLevel, ThinkingLevel } from "@gajae-code/agent-core/thinking";
import {
	clampThinkingLevelForModel,
	Effort,
	getSupportedEfforts,
	THINKING_EFFORTS,
} from "@gajae-code/ai/model-thinking";
import type { Model } from "@gajae-code/ai/types";

export { getThinkingLevelMetadata, type ThinkingLevelMetadata } from "./thinking-metadata";

export type AgentThinkingEffort = Exclude<ThinkingLevel, typeof ThinkingLevel.Inherit | typeof ThinkingLevel.Off>;
type NativeThinkingEffort = Exclude<AgentThinkingEffort, typeof ThinkingLevel.Ultra>;

export const AGENT_THINKING_EFFORTS: readonly AgentThinkingEffort[] = [
	ThinkingLevel.Minimal,
	ThinkingLevel.Low,
	ThinkingLevel.Medium,
	ThinkingLevel.High,
	ThinkingLevel.XHigh,
	ThinkingLevel.Max,
	ThinkingLevel.Ultra,
];

const NATIVE_EFFORT_BY_THINKING_LEVEL: Record<NativeThinkingEffort, Effort> = {
	[ThinkingLevel.Minimal]: Effort.Minimal,
	[ThinkingLevel.Low]: Effort.Low,
	[ThinkingLevel.Medium]: Effort.Medium,
	[ThinkingLevel.High]: Effort.High,
	[ThinkingLevel.XHigh]: Effort.XHigh,
	[ThinkingLevel.Max]: Effort.Max,
};

const THINKING_LEVEL_BY_NATIVE_EFFORT: Record<Effort, NativeThinkingEffort> = {
	[Effort.Minimal]: ThinkingLevel.Minimal,
	[Effort.Low]: ThinkingLevel.Low,
	[Effort.Medium]: ThinkingLevel.Medium,
	[Effort.High]: ThinkingLevel.High,
	[Effort.XHigh]: ThinkingLevel.XHigh,
	[Effort.Max]: ThinkingLevel.Max,
};

const THINKING_LEVELS = new Set<string>([
	ThinkingLevel.Inherit,
	ThinkingLevel.Off,
	...AGENT_THINKING_EFFORTS,
]);
const AGENT_EFFORT_LEVELS = new Set<string>(AGENT_THINKING_EFFORTS);
const EFFORT_LEVELS = new Set<string>(THINKING_EFFORTS);

/**
 * Parses a provider-facing effort value.
 */
export function parseEffort(value: string | null | undefined): Effort | undefined {
	return value !== undefined && value !== null && EFFORT_LEVELS.has(value) ? (value as Effort) : undefined;
}
/**
 * Parses an agent-local effort value.
 */
export function parseAgentThinkingEffort(value: string | null | undefined): AgentThinkingEffort | undefined {
	return value !== undefined && value !== null && AGENT_EFFORT_LEVELS.has(value)
		? (value as AgentThinkingEffort)
		: undefined;
}

/**
 * Parses an agent-local thinking selector.
 */
export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return value !== undefined && value !== null && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
}

/**
 * Ultra is a GJC orchestration tier, not a provider-native reasoning effort.
 * It is intentionally limited to Codex GPT-5.6 Sol, whose provider component
 * runs at max while GJC encourages parallel task delegation.
 */
export function supportsUltraThinking(model: Model | undefined): boolean {
	return (
		model?.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		model.id === "gpt-5.6-sol"
	);
}

/**
 * Converts an agent-local selector into the effort sent to providers.
 */
export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level === ThinkingLevel.Ultra ? Effort.Max : NATIVE_EFFORT_BY_THINKING_LEVEL[level];
}

function fromReasoningEffort(effort: Effort | undefined): NativeThinkingEffort | undefined {
	return effort === undefined ? undefined : THINKING_LEVEL_BY_NATIVE_EFFORT[effort];
}

function clampAgentThinkingEffort(
	model: Model | undefined,
	level: AgentThinkingEffort,
): AgentThinkingEffort | undefined {
	return fromReasoningEffort(clampThinkingLevelForModel(model, toReasoningEffort(level)));
}

/**
 * Resolves a selector against the current model while preserving explicit "off".
 */
export function resolveThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	if (level === ThinkingLevel.Off) {
		return ThinkingLevel.Off;
	}
	if (level === ThinkingLevel.Ultra && supportsUltraThinking(model)) {
		return ThinkingLevel.Ultra;
	}
	return clampAgentThinkingEffort(model, level);
}

export function clampExplicitThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit || level === ThinkingLevel.Off) {
		return level;
	}
	if (level === ThinkingLevel.Ultra && supportsUltraThinking(model)) {
		return ThinkingLevel.Ultra;
	}
	return clampAgentThinkingEffort(model, level);
}

export function getAvailableThinkingLevelsForModel(model: Model | undefined): readonly AgentThinkingEffort[] {
	if (!model?.reasoning) return [];
	const efforts = getSupportedEfforts(model).map(effort => fromReasoningEffort(effort)!);
	return supportsUltraThinking(model) ? [...efforts, ThinkingLevel.Ultra] : efforts;
}

export function formatClampedModelSelector(selector: string, model: Model | undefined): string {
	const slashIdx = selector.indexOf("/");
	if (slashIdx <= 0) return selector;
	const id = selector.slice(slashIdx + 1);
	const colonIdx = id.lastIndexOf(":");
	if (colonIdx === -1) return selector;
	const suffix = id.slice(colonIdx + 1);
	const thinkingLevel = parseThinkingLevel(suffix);
	if (!thinkingLevel) return selector;
	const clamped = clampExplicitThinkingLevelForModel(model, thinkingLevel);
	return clamped && clamped !== ThinkingLevel.Inherit
		? `${selector.slice(0, slashIdx + 1)}${id.slice(0, colonIdx)}:${clamped}`
		: selector.slice(0, slashIdx + 1) + id.slice(0, colonIdx);
}
