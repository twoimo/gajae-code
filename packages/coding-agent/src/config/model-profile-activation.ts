import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import type { AgentSession } from "../session/agent-session";
import { formatClampedModelSelector } from "../thinking";
import {
	aggregateModelProfileRequiredProviders,
	formatAvailableProfileNames,
	formatModelProfileDisplayLabel,
	resolveProfileBindings,
} from "./model-profiles";
import {
	GJC_MODEL_ASSIGNMENT_TARGETS,
	type GjcModelAssignmentTargetId,
	isAuthenticated,
	kNoAuth,
	type ModelRegistry,
} from "./model-registry";
import { formatModelSelectorValue, resolveModelRoleValue } from "./model-resolver";
import { normalizeModelSelectorValue, type ModelSelectorValue } from "./model-selector-value";
import type { Settings } from "./settings";

const LEGACY_MODEL_PROFILE_ALIASES: ReadonlyMap<string, string> = new Map([["codex-standard", "codex-medium"]]);

type ModelProfileActivationSession = Pick<
	AgentSession,
	"model" | "thinkingLevel" | "sessionId" | "getConfiguredModelChain" | "setConfiguredModelChain"
> & {
	setModelTemporary?: AgentSession["setModelTemporary"];
	setActiveModelProfile?: (name: string | undefined) => void;
	getActiveModelProfile?: () => string | undefined;
	getSessionDefaultModelSelector?: () => string | undefined;
	recordResumeDefaultModel?: (selector: string) => void;
};


export interface PrepareModelProfileActivationOptions {
	session: ModelProfileActivationSession;
	modelRegistry: Pick<
		ModelRegistry,
		| "getModelProfile"
		| "getModelProfiles"
		| "getAvailableModelProfileNames"
		| "getApiKeyForProvider"
		| "getAll"
		| "resolveCanonicalModel"
		| "getCanonicalVariants"
		| "getCanonicalId"
	>;
	settings: Pick<Settings, "get">;
	profileName: string;
}
export interface ApplyModelProfileActivationOptions {
	persistDefault?: boolean;
	thinkingLevelOverride?: ThinkingLevel;
}
export interface PreparedModelProfileActivation {
	profileName: string;
	session: ModelProfileActivationSession & { setModelTemporary: AgentSession["setModelTemporary"] };
	settings: Pick<Settings, "clearOverride" | "get" | "getGlobal" | "override" | "set" | "flush">;
	previousModel: Model<Api> | undefined;
	previousThinkingLevel: ThinkingLevel | undefined;
	previousAgentModelOverrides: Record<string, ModelSelectorValue>;
	previousModelRoles: Record<string, ModelSelectorValue>;
	previousDefaultChain: readonly string[] | undefined;
	defaultModel: Model<Api> | undefined;
	defaultThinkingLevel: ThinkingLevel | undefined;
	/** Full configured default fallback chain, clamped entry-by-entry. */
	defaultChain: readonly string[];
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
	previousActiveModelProfile: string | undefined;
	/**
	 * The session resume default ("provider/id") captured BEFORE activation —
	 * the model resume would restore prior to this profile. Snapshotted
	 * separately from `previousModel` (the live runtime model, which may be a
	 * transient switch) so a failed-activation rollback restores the correct
	 * resume default without promoting a transient model to it.
	 */
	previousSessionDefaultModel: string | undefined;
}
export interface MaterializeModelProfileAssignmentOptions {
	session: Pick<
		ModelProfileActivationSession,
		"model" | "thinkingLevel" | "setActiveModelProfile" | "getActiveModelProfile"
	>;
	settings: Pick<Settings, "clearOverride" | "get" | "override" | "set">;
	role: GjcModelAssignmentTargetId;
	selector: string;
}

export interface MaterializeModelProfileAssignmentsOptions {
	session: Pick<
		ModelProfileActivationSession,
		"model" | "thinkingLevel" | "setActiveModelProfile" | "getActiveModelProfile"
	>;
	settings: Pick<Settings, "clearOverride" | "get" | "override" | "set">;
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>;
}

function isReadonlyAssignmentMap(
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>,
): assignments is ReadonlyMap<GjcModelAssignmentTargetId, string> {
	return typeof (assignments as { entries?: unknown }).entries === "function";
}

function getMaterializedAssignments(
	assignments: ReadonlyMap<GjcModelAssignmentTargetId, string> | Partial<Record<GjcModelAssignmentTargetId, string>>,
): Array<[GjcModelAssignmentTargetId, string]> {
	if (isReadonlyAssignmentMap(assignments)) return [...assignments.entries()];
	const assignmentRecord: Partial<Record<GjcModelAssignmentTargetId, string>> = assignments;
	const result: Array<[GjcModelAssignmentTargetId, string]> = [];
	for (const role of Object.keys(assignmentRecord) as GjcModelAssignmentTargetId[]) {
		const selector = assignmentRecord[role];
		if (selector !== undefined) result.push([role, selector]);
	}
	return result;
}

export function materializeActiveModelProfileAssignment(options: MaterializeModelProfileAssignmentOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const target = GJC_MODEL_ASSIGNMENT_TARGETS[options.role];

	if (options.role === "default") {
		nextModelRoles.default = options.selector;
	} else if (!nextModelRoles.default && options.session.model) {
		nextModelRoles.default = formatModelSelectorValue(
			`${options.session.model.provider}/${options.session.model.id}`,
			options.session.thinkingLevel,
		);
	}

	if (target.settingsPath === "modelRoles") {
		nextModelRoles[options.role] = options.selector;
	} else {
		nextAgentModelOverrides[options.role] = options.selector;
	}

	options.settings.set("modelRoles", nextModelRoles);
	options.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
	options.settings.set("modelProfile.default", undefined);
	options.settings.clearOverride("modelProfile.default");
	options.settings.override("modelRoles", nextModelRoles);
	options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
	options.session.setActiveModelProfile?.(undefined);
	return true;
}

export function materializeActiveModelProfileAssignments(options: MaterializeModelProfileAssignmentsOptions): boolean {
	const activeProfile = options.session.getActiveModelProfile?.() ?? options.settings.get("modelProfile.default");
	if (!activeProfile) return false;

	const materializedAssignments = getMaterializedAssignments(options.assignments);
	if (materializedAssignments.length === 0) return true;

	const nextModelRoles = { ...options.settings.get("modelRoles") };
	const nextAgentModelOverrides = { ...options.settings.get("task.agentModelOverrides") };
	const includesDefault = materializedAssignments.some(([role]) => role === "default");

	if (!includesDefault && !nextModelRoles.default && options.session.model) {
		nextModelRoles.default = formatModelSelectorValue(
			`${options.session.model.provider}/${options.session.model.id}`,
			options.session.thinkingLevel,
		);
	}

	for (const [role, selector] of materializedAssignments) {
		const target = GJC_MODEL_ASSIGNMENT_TARGETS[role];
		if (target.settingsPath === "modelRoles") {
			nextModelRoles[role] = selector;
		} else {
			nextAgentModelOverrides[role] = selector;
		}
	}

	options.settings.set("modelRoles", nextModelRoles);
	options.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
	options.settings.set("modelProfile.default", undefined);
	options.settings.clearOverride("modelProfile.default");
	options.settings.override("modelRoles", nextModelRoles);
	options.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
	options.session.setActiveModelProfile?.(undefined);
	return true;
}

export function formatModelProfileCredentialError(profileLabel: string, providers: readonly string[]): string {
	return `Model profile "${profileLabel}" requires credentials for: ${providers.join(", ")}. Run /login and configure the missing provider(s), then retry.`;
}

function resolveModelProfileName(profileName: string, profiles: ReadonlyMap<string, unknown>): string {
	// A retired-name alias is fallback-only: never shadow a profile that actually
	// exists under the requested name (e.g. a user-defined `codex-standard`).
	if (profiles.has(profileName)) return profileName;
	const replacement = LEGACY_MODEL_PROFILE_ALIASES.get(profileName);
	return replacement && profiles.has(replacement) ? replacement : profileName;
}

/**
 * Rewrite a selector only within the selector provider's own alternative group.
 * Strict providers are never rewritten, and authenticated alternative providers
 * keep their original selectors.
 */
function rewriteSelectorProvider(
	selector: string,
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): string {
	const slash = selector.indexOf("/");
	if (slash < 0) return selector;

	const provider = selector.substring(0, slash);
	if (authenticatedProviders.has(provider)) return selector;

	const group = alternativeGroups.find(candidates => candidates.includes(provider));
	if (!group) return selector;

	const replacement = group.find(candidate => authenticatedProviders.has(candidate));
	if (!replacement) return selector;

	return replacement + selector.substring(slash);
}

function rewriteSelectorValueProvider(
	selectorValue: ModelSelectorValue,
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue).map(selector =>
		rewriteSelectorProvider(selector, authenticatedProviders, alternativeGroups),
	);
	return selectors.length === 1 && typeof selectorValue === "string" ? selectors[0] : selectors;
}

function rewriteBindingsProviders(
	bindings: {
		defaultSelector?: ModelSelectorValue;
		modelRoles: Record<string, ModelSelectorValue>;
		agentModelOverrides: Record<string, ModelSelectorValue>;
	},
	authenticatedProviders: ReadonlySet<string>,
	alternativeGroups: readonly (readonly string[])[],
): {
	defaultSelector?: ModelSelectorValue;
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
} {
	return {
		defaultSelector: bindings.defaultSelector
			? rewriteSelectorValueProvider(bindings.defaultSelector, authenticatedProviders, alternativeGroups)
			: undefined,
		modelRoles: Object.fromEntries(
			Object.entries(bindings.modelRoles).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups),
			]),
		),
		agentModelOverrides: Object.fromEntries(
			Object.entries(bindings.agentModelOverrides).map(([role, selector]) => [
				role,
				rewriteSelectorValueProvider(selector, authenticatedProviders, alternativeGroups),
			]),
		),
	};
}

function resolveAndClampSelectorValue(
	selectorValue: ModelSelectorValue,
	availableModels: Model<Api>[],
	options: { settings: Settings; modelRegistry: ModelRegistry },
	profileLabel: string,
	role: string,
): ModelSelectorValue {
	const selectors = normalizeModelSelectorValue(selectorValue);
	const clamped = selectors.map(selector => {
		const resolved = resolveModelRoleValue(selector, availableModels, options);
		if (!resolved.model) {
			throw new Error(`Model profile "${profileLabel}" ${role} selector did not resolve: ${selector}`);
		}
		return formatClampedModelSelector(selector, resolved.model);
	});
	return clamped.length === 1 && typeof selectorValue === "string" ? clamped[0] : clamped;
}

export async function prepareModelProfileActivation(
	options: PrepareModelProfileActivationOptions,
): Promise<PreparedModelProfileActivation> {
	const profiles = options.modelRegistry.getModelProfiles();
	const profileName = resolveModelProfileName(options.profileName, profiles);
	const profile = profiles.get(profileName) ?? options.modelRegistry.getModelProfile(profileName);
	if (!profile) {
		const available = formatAvailableProfileNames(profiles);
		throw new Error(`Unknown model profile "${options.profileName}". Available profiles: ${available}`);
	}
	const profileLabel = formatModelProfileDisplayLabel(profile);

	const requiredProviders = aggregateModelProfileRequiredProviders(profile.requiredProviders, profile);
	const alternativeGroups = profile.alternativeProviderGroups ?? [];
	const alternativeSet = new Set(alternativeGroups.flat());

	const missingProviders: string[] = [];
	const authenticatedProviders: string[] = [];
	for (const provider of requiredProviders) {
		const apiKey = await options.modelRegistry.getApiKeyForProvider(provider, options.session.sessionId);
		if (apiKey !== kNoAuth && !isAuthenticated(apiKey)) {
			missingProviders.push(provider);
		} else {
			authenticatedProviders.push(provider);
		}
	}

	// Required providers are the only activation prerequisites. Mapped fallback
	// providers are resolution-time candidates and intentionally do not gate here.
	const strictMissing = missingProviders.filter(provider => !alternativeSet.has(provider));
	if (strictMissing.length > 0) {
		throw new Error(formatModelProfileCredentialError(profileLabel, strictMissing));
	}
	for (const group of alternativeGroups) {
		const groupAuthenticated = group.some(provider => authenticatedProviders.includes(provider));
		if (!groupAuthenticated) {
			throw new Error(formatModelProfileCredentialError(profileLabel, [...group]));
		}
	}

	const availableModels = options.modelRegistry.getAll();
	let bindings = resolveProfileBindings(profile);
	if (missingProviders.length > 0 && alternativeGroups.length > 0) {
		bindings = rewriteBindingsProviders(bindings, new Set(authenticatedProviders), alternativeGroups);
	}
	const defaultChain = bindings.defaultSelector
		? normalizeModelSelectorValue(
				resolveAndClampSelectorValue(
					bindings.defaultSelector,
					availableModels,
					{ settings: options.settings as Settings, modelRegistry: options.modelRegistry as ModelRegistry },
					profileLabel,
					"default",
				),
			)
		: [];
	const resolvedDefault = bindings.defaultSelector
		? resolveModelRoleValue(bindings.defaultSelector, availableModels, {
				settings: options.settings as Settings,
				modelRegistry: options.modelRegistry,
			})
		: undefined;

	const modelRoles: Record<string, ModelSelectorValue> = {};
	for (const [role, selectorValue] of Object.entries(bindings.modelRoles) as [
		GjcModelAssignmentTargetId,
		ModelSelectorValue,
	][]) {
		modelRoles[role] = resolveAndClampSelectorValue(
			selectorValue,
			availableModels,
			{ settings: options.settings as Settings, modelRegistry: options.modelRegistry as ModelRegistry },
			profileLabel,
			role,
		);
	}

	const agentModelOverrides: Record<string, ModelSelectorValue> = {};
	for (const [role, selectorValue] of Object.entries(bindings.agentModelOverrides) as [
		GjcModelAssignmentTargetId,
		ModelSelectorValue,
	][]) {
		agentModelOverrides[role] = resolveAndClampSelectorValue(
			selectorValue,
			availableModels,
			{ settings: options.settings as Settings, modelRegistry: options.modelRegistry as ModelRegistry },
			profileLabel,
			role,
		);
	}

	return {
		profileName,
		session: options.session as PreparedModelProfileActivation["session"],
		settings: options.settings as PreparedModelProfileActivation["settings"],
		previousModel: options.session.model,
		previousThinkingLevel: options.session.thinkingLevel,
		previousAgentModelOverrides: { ...options.settings.get("task.agentModelOverrides") },
		previousModelRoles: { ...options.settings.get("modelRoles") },
		previousDefaultChain: options.session.getConfiguredModelChain("default"),

		defaultModel: resolvedDefault?.model,
		defaultThinkingLevel: resolvedDefault?.thinkingLevel,
		defaultChain,
		modelRoles,
		agentModelOverrides,
		previousActiveModelProfile: options.session.getActiveModelProfile?.(),
		previousSessionDefaultModel: options.session.getSessionDefaultModelSelector?.(),
	};
}

export async function applyPreparedModelProfileActivation(
	prepared: PreparedModelProfileActivation,
	options: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const previousModel = prepared.previousModel;
	const previousThinkingLevel = prepared.previousThinkingLevel;
	const previousAgentModelOverrides = prepared.previousAgentModelOverrides;
	const previousModelRoles = prepared.previousModelRoles;
	const previousPersistedDefault = prepared.settings.get("modelProfile.default");
	const previousDefaultThinkingLevel = prepared.settings.get("defaultThinkingLevel");
	const previousActiveModelProfile = prepared.previousActiveModelProfile;
	const previousSessionDefaultModel = prepared.previousSessionDefaultModel;
	let modelChanged = false;
	let overridesChanged = false;
	let defaultChanged = false;
	let modelRolesChanged = false;
	let defaultThinkingChanged = false;
	let defaultChainChanged = false;

	try {
		if (prepared.defaultChain.length > 0) {
			prepared.session.setConfiguredModelChain("default", prepared.defaultChain, "profile-activation", prepared.profileName, true);

			defaultChainChanged = true;
		}
		if (prepared.defaultModel) {
			await prepared.session.setModelTemporary(
				prepared.defaultModel,
				options.thinkingLevelOverride ?? prepared.defaultThinkingLevel,
				{
					persistAsSessionDefault: true,
					cause: "profile-activation",
				},
			);
			modelChanged = true;
		}
		if (Object.keys(prepared.modelRoles).length > 0) {
			prepared.settings.override("modelRoles", { ...previousModelRoles, ...prepared.modelRoles });
			modelRolesChanged = true;
		}
		if (Object.keys(prepared.agentModelOverrides).length > 0) {
			prepared.settings.override("task.agentModelOverrides", {
				...previousAgentModelOverrides,
				...prepared.agentModelOverrides,
			});
			overridesChanged = true;
		}
		if (options.persistDefault) {
			prepared.settings.set("modelRoles", {});
			prepared.settings.set("task.agentModelOverrides", {});
			if (prepared.defaultThinkingLevel !== undefined && prepared.defaultThinkingLevel !== ThinkingLevel.Inherit) {
				prepared.settings.set("defaultThinkingLevel", prepared.defaultThinkingLevel);
				defaultThinkingChanged = true;
			}
			prepared.settings.set("modelProfile.default", prepared.profileName);
			defaultChanged = true;
			await prepared.settings.flush();
		}
		prepared.session.setActiveModelProfile?.(prepared.profileName);
	} catch (error) {
		if (defaultChanged) {
			prepared.settings.set("modelProfile.default", previousPersistedDefault);
			prepared.settings.set("modelRoles", previousModelRoles);
			prepared.settings.set("task.agentModelOverrides", previousAgentModelOverrides);
			if (defaultThinkingChanged) {
				prepared.settings.set("defaultThinkingLevel", previousDefaultThinkingLevel);
			}
		}
		if (modelRolesChanged) {
			prepared.settings.override("modelRoles", previousModelRoles);
		}
		if (overridesChanged) {
			prepared.settings.override("task.agentModelOverrides", previousAgentModelOverrides);
		}
		if (defaultChainChanged) {
			prepared.session.setConfiguredModelChain(
				"default",
				prepared.previousDefaultChain ?? [],
				"rollback",
				prepared.previousActiveModelProfile,
				true,
			);
		}
		prepared.session.setActiveModelProfile?.(previousActiveModelProfile);
		if (modelChanged) {
			// Runtime rolls back to the pre-activation live model. That model may
			// itself be a transient retry/fallback/context-promotion/plan switch,
			// so it is recorded as role:"temporary" (NOT the resume default) to
			// preserve the issue #849 protection.
			if (previousModel) {
				await prepared.session.setModelTemporary(previousModel, previousThinkingLevel, { cause: "rollback" });
			}
			// The happy path already appended the profile main model as the resume
			// default (role:"default"). Re-assert the pre-activation resume default
			// so a failed activation does not poison future resume. Fall back to the
			// live model only when there was no explicit pre-activation default
			// (nothing to protect). Append-only — never touches the runtime model.
			const restoreDefaultSelector =
				previousSessionDefaultModel ??
				(previousModel ? `${previousModel.provider}/${previousModel.id}` : undefined);
			if (restoreDefaultSelector) {
				prepared.session.recordResumeDefaultModel?.(restoreDefaultSelector);
			}
		}
		throw error;
	}
}

export interface MaterializeModelProfileForDeletionResult {
	modelRoles: Record<string, ModelSelectorValue>;
	agentModelOverrides: Record<string, ModelSelectorValue>;
	previousModelRoles: Record<string, ModelSelectorValue>;
	previousAgentModelOverrides: Record<string, ModelSelectorValue>;
	previousDefaultProfile: string | undefined;
	previousPersistedDefaultProfile: string | undefined;
	previousActiveModelProfile: string | undefined;
}

export async function materializeModelProfileForDeletion(
	options: PrepareModelProfileActivationOptions & {
		settings: Pick<Settings, "clearOverride" | "flush" | "get" | "getGlobal" | "override" | "set">;
	},
): Promise<MaterializeModelProfileForDeletionResult> {
	const prepared = await prepareModelProfileActivation(options);
	const previousDefaultProfile = prepared.settings.get("modelProfile.default");
	const previousPersistedDefaultProfile = prepared.settings.getGlobal("modelProfile.default");
	const nextModelRoles = {
		...prepared.previousModelRoles,
		...(prepared.defaultModel
			? {
					default: formatModelSelectorValue(
						`${prepared.defaultModel.provider}/${prepared.defaultModel.id}`,
						prepared.defaultThinkingLevel,
					),
				}
			: {}),
		...prepared.modelRoles,
	};
	const nextAgentModelOverrides = {
		...prepared.previousAgentModelOverrides,
		...prepared.agentModelOverrides,
	};

	try {
		prepared.settings.set("modelRoles", nextModelRoles);
		prepared.settings.set("task.agentModelOverrides", nextAgentModelOverrides);
		prepared.settings.set("modelProfile.default", undefined);
		prepared.settings.clearOverride("modelProfile.default");
		prepared.settings.override("modelRoles", nextModelRoles);
		prepared.settings.override("task.agentModelOverrides", nextAgentModelOverrides);
		prepared.session.setActiveModelProfile?.(undefined);
		await prepared.settings.flush();
	} catch (error) {
		prepared.settings.set("modelRoles", prepared.previousModelRoles);
		prepared.settings.set("task.agentModelOverrides", prepared.previousAgentModelOverrides);
		prepared.settings.set("modelProfile.default", previousPersistedDefaultProfile);
		prepared.settings.override("modelRoles", prepared.previousModelRoles);
		prepared.settings.override("task.agentModelOverrides", prepared.previousAgentModelOverrides);
		prepared.settings.override("modelProfile.default", previousDefaultProfile);
		prepared.session.setActiveModelProfile?.(prepared.previousActiveModelProfile);
		throw error;
	}

	return {
		modelRoles: nextModelRoles,
		agentModelOverrides: nextAgentModelOverrides,
		previousModelRoles: prepared.previousModelRoles,
		previousAgentModelOverrides: prepared.previousAgentModelOverrides,
		previousDefaultProfile,
		previousPersistedDefaultProfile,
		previousActiveModelProfile: prepared.previousActiveModelProfile,
	};
}

export async function restoreMaterializedModelProfileForDeletion(options: {
	settings: Pick<Settings, "flush" | "override" | "set">;
	session: Pick<ModelProfileActivationSession, "setActiveModelProfile">;
	snapshot: MaterializeModelProfileForDeletionResult;
}): Promise<void> {
	options.settings.set("modelRoles", options.snapshot.previousModelRoles);
	options.settings.set("task.agentModelOverrides", options.snapshot.previousAgentModelOverrides);
	options.settings.set("modelProfile.default", options.snapshot.previousPersistedDefaultProfile);
	options.settings.override("modelRoles", options.snapshot.previousModelRoles);
	options.settings.override("task.agentModelOverrides", options.snapshot.previousAgentModelOverrides);
	options.settings.override("modelProfile.default", options.snapshot.previousDefaultProfile);
	options.session.setActiveModelProfile?.(options.snapshot.previousActiveModelProfile);
	await options.settings.flush();
}

export async function activateModelProfile(
	options: PrepareModelProfileActivationOptions,
	applyOptions: ApplyModelProfileActivationOptions = {},
): Promise<void> {
	const prepared = await prepareModelProfileActivation(options);
	await applyPreparedModelProfileActivation(prepared, applyOptions);
}
