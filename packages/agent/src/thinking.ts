/**
 * Agent-local thinking selector.
 *
 * `off` disables reasoning, while `inherit` defers to a higher-level selector.
 */
export const ThinkingLevel = {
	Inherit: "inherit",
	Off: "off",
	Minimal: "minimal",
	Low: "low",
	Medium: "medium",
	High: "high",
	XHigh: "xhigh",
	Max: "max",
	Ultra: "ultra",
} as const;

export type ThinkingLevel = (typeof ThinkingLevel)[keyof typeof ThinkingLevel];
export type ResolvedThinkingLevel = Exclude<ThinkingLevel, "inherit">;
