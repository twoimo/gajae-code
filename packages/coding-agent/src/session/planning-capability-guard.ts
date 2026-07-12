import type { AgentTool } from "@gajae-code/agent-core";
import type { ToolCapabilityDescriptor } from "../tools/capabilities";
import { classifyToolOperation } from "../tools/capabilities";

export type PlanningCapabilityDecision = { allowed: true } | { allowed: false; reason: string };

export function evaluatePlanningCapability(input: {
	tool: Pick<AgentTool, "name">;
	args: unknown;
	capability: ToolCapabilityDescriptor;
	activeSkill?: string | null;
	phase?: string | null;
}): PlanningCapabilityDecision {
	const activeSkill = input.activeSkill;
	if (!activeSkill) return { allowed: true };
	const phase = (input.phase ?? "").trim().toLowerCase();
	const terminal = ["complete", "completed", "failed", "cancelled", "canceled", "inactive", "handoff"];
	const ultragoalPhases = ["goal-planning", "pending", "active", "blocked", ...terminal];
	const planning =
		(activeSkill === "ultragoal" && (phase === "goal-planning" || !ultragoalPhases.includes(phase))) ||
		((activeSkill === "deep-interview" || activeSkill === "ralplan") && !terminal.includes(phase));
	if (!planning) return { allowed: true };
	const capability = classifyToolOperation(input.capability, input.args);
	if (capability.provenance !== "builtin") return { allowed: false, reason: "untrusted tool provenance" };
	if (capability.filesystem === "unknown" || capability.external === "unknown" || capability.execution === "unknown") {
		return { allowed: false, reason: "unknown tool capability" };
	}
	if (capability.destructive) return { allowed: false, reason: "destructive operation" };
	if (capability.filesystem === "write" || capability.filesystem === "delete")
		return { allowed: false, reason: "filesystem mutation" };
	if (capability.external === "write" || capability.external === "delete")
		return { allowed: false, reason: "external mutation" };
	if (capability.execution !== "none") return { allowed: false, reason: "execution-spawning operation" };
	if (capability.interactive) return { allowed: false, reason: "interactive control" };
	return { allowed: true };
}
