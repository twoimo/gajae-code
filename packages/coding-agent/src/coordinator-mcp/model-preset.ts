import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { type ModelProfileDefinition, mergeModelProfiles } from "../config/model-profiles";
import { ModelsConfigFile } from "../config/model-registry";

/**
 * Loads the merged built-in + custom model-profile registry the way the `gjc`
 * CLI resolves `--mpreset`, so coordinator MCP launches select the same
 * authoritative profile the spawned child will activate. Custom profiles live
 * in the shared models config, which the child inherits, so both sides agree.
 */
export type CoordinatorModelProfileLoader = () =>
	| Map<string, ModelProfileDefinition>
	| Promise<Map<string, ModelProfileDefinition>>;

const MAX_ECHOED_MPRESET_LENGTH = 128;

export const loadCoordinatorModelProfiles: CoordinatorModelProfileLoader = () => {
	const configFile = ModelsConfigFile.relocate(path.join(getAgentDir(), "models.yml"));
	configFile.invalidate();
	return mergeModelProfiles(configFile.load()?.profiles);
};

function sortedProfileNames(profiles: ReadonlyMap<string, ModelProfileDefinition>): string[] {
	return [...profiles.keys()].sort((left, right) => left.localeCompare(right));
}

export type CoordinatorMpresetResolution =
	| { ok: true; mpreset: string | null }
	| { ok: false; reason: "unknown_model_profile"; mpreset: string; available_profiles: string[] };

/**
 * Resolve a coordinator `mpreset` argument against the merged profile registry.
 * Absent/blank values are a no-op (`mpreset: null`); unknown names are rejected
 * with the available-profile listing and never reach a spawned child command.
 */
export async function resolveCoordinatorMpreset(
	raw: unknown,
	loadProfiles: CoordinatorModelProfileLoader,
): Promise<CoordinatorMpresetResolution> {
	if (raw === undefined || raw === null) return { ok: true, mpreset: null };
	const requested = typeof raw === "string" ? raw.trim() : "";
	if (typeof raw === "string" && requested.length === 0) return { ok: true, mpreset: null };
	const profiles = await loadProfiles();
	if (typeof raw !== "string" || !profiles.has(requested)) {
		return {
			ok: false,
			reason: "unknown_model_profile",
			mpreset: requested.slice(0, MAX_ECHOED_MPRESET_LENGTH),
			available_profiles: sortedProfileNames(profiles),
		};
	}
	return { ok: true, mpreset: requested };
}
