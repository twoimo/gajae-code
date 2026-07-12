export const AGENT_WIRE_CURRENT_VERSION = 2 as const;
export const AGENT_WIRE_PREVIOUS_VERSION = 1 as const;
export const AGENT_WIRE_SUPPORTED_VERSIONS = [AGENT_WIRE_PREVIOUS_VERSION, AGENT_WIRE_CURRENT_VERSION] as const;

export type AgentWireVersion = (typeof AGENT_WIRE_SUPPORTED_VERSIONS)[number];

export interface AgentWireVersionRange {
	min: number;
	max: number;
}

export function isAgentWireVersion(value: unknown): value is AgentWireVersion {
	return value === AGENT_WIRE_PREVIOUS_VERSION || value === AGENT_WIRE_CURRENT_VERSION;
}

export function isAgentWireVersionRange(value: unknown): value is AgentWireVersionRange {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const range = value as Record<string, unknown>;
	return (
		typeof range.min === "number" &&
		Number.isInteger(range.min) &&
		typeof range.max === "number" &&
		Number.isInteger(range.max) &&
		range.min <= range.max
	);
}

/** Returns the highest locally supported version within the peer's inclusive range. */
export function selectAgentWireVersion(range: AgentWireVersionRange): AgentWireVersion | undefined {
	for (const version of [...AGENT_WIRE_SUPPORTED_VERSIONS].reverse()) {
		if (range.min <= version && version <= range.max) return version;
	}
	return undefined;
}
