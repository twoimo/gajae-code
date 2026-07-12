import { createHash } from "node:crypto";
import * as path from "node:path";
import {
	readVisibleSessionBackendId,
	type VisibleSessionSupportedBackendId,
	type VisibleSessionUnsupportedBackendId,
} from "./backend";
import {
	MAX_PUBLIC_TEXT_BYTES,
	MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
	readVisibleSessionBoundedFile,
	readVisibleSessionPublicFile,
	VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
	VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
	type VisibleSessionProjectedFinalRecord,
	type VisibleSessionProjectedMetadata,
	type VisibleSessionProjectedPromptAccepted,
	type VisibleSessionProjectedRuntime,
	type VisibleSessionProjectedVanishedRecord,
	type VisibleSessionPromptAccepted,
	type VisibleSessionPublicationManifest,
	VisibleSessionPublicFileChangedError,
	type VisibleSessionStateMetadata,
	type VisibleSessionStatePaths,
	type VisibleSessionStateRuntime,
	type VisibleSessionTerminalRecord,
	type VisibleSessionVanishedRecord,
	visibleSessionStatePaths,
} from "./state";
export const MAX_VISIBLE_SESSION_PANE_TAIL_BYTES = 64 * 1024;
export const MAX_VISIBLE_SESSION_PANE_TAIL_LINES = 1000;
const STABLE_READ_ATTEMPTS = 8;

export interface VisibleSessionPaneTailOptions {
	bytes: number;
	lines: number;
}

export interface VisibleSessionPaneTail {
	text: string;
	lines: number;
	truncated: boolean;
}

export type VisibleSessionPublicBackend = VisibleSessionSupportedBackendId | VisibleSessionUnsupportedBackendId;
export type VisibleSessionPublicProjectedMetadata = Omit<VisibleSessionProjectedMetadata, "backend"> & {
	backend: VisibleSessionPublicBackend;
};
export type VisibleSessionPublicProjectedRuntime = Omit<VisibleSessionProjectedRuntime, "backend"> & {
	backend: VisibleSessionPublicBackend;
};
export type VisibleSessionPublicProjectedPromptAccepted = Omit<VisibleSessionProjectedPromptAccepted, "backend"> & {
	backend: VisibleSessionPublicBackend;
};
export type VisibleSessionPublicProjectedFinal = Omit<VisibleSessionProjectedFinalRecord, "backend"> & {
	backend: VisibleSessionPublicBackend;
};
export type VisibleSessionPublicProjectedVanished = Omit<VisibleSessionProjectedVanishedRecord, "backend"> & {
	backend: VisibleSessionPublicBackend;
};
export type VisibleSessionPublicMetadata =
	| Omit<VisibleSessionStateMetadata, "authority" | "cleanup" | "projection">
	| VisibleSessionPublicProjectedMetadata;
export type VisibleSessionPublicRuntime = VisibleSessionStateRuntime | VisibleSessionPublicProjectedRuntime;
export type VisibleSessionPublicPromptAccepted =
	| VisibleSessionPromptAccepted
	| VisibleSessionPublicProjectedPromptAccepted;
export type VisibleSessionPublicFinal = VisibleSessionTerminalRecord | VisibleSessionPublicProjectedFinal;
export type VisibleSessionPublicVanished = VisibleSessionVanishedRecord | VisibleSessionPublicProjectedVanished;
type VisibleSessionProjectedMetadataRead = Omit<VisibleSessionProjectedMetadata, "backend"> & {
	backend: string;
};
type VisibleSessionProjectedRuntimeRead = Omit<VisibleSessionProjectedRuntime, "backend"> & {
	backend: string;
};
type VisibleSessionProjectedPromptAcceptedRead = Omit<VisibleSessionProjectedPromptAccepted, "backend"> & {
	backend: string;
};
type VisibleSessionProjectedFinalRead = Omit<VisibleSessionProjectedFinalRecord, "backend"> & {
	backend: string;
};
type VisibleSessionProjectedVanishedRead = Omit<VisibleSessionProjectedVanishedRecord, "backend"> & {
	backend: string;
};
type VisibleSessionMetadataRead = VisibleSessionStateMetadata | VisibleSessionProjectedMetadataRead;
type VisibleSessionRuntimeRead = VisibleSessionStateRuntime | VisibleSessionProjectedRuntimeRead;
type VisibleSessionPromptAcceptedRead = VisibleSessionPromptAccepted | VisibleSessionProjectedPromptAcceptedRead;
type VisibleSessionFinalRead = VisibleSessionTerminalRecord | VisibleSessionProjectedFinalRead;
type VisibleSessionVanishedRead = VisibleSessionVanishedRecord | VisibleSessionProjectedVanishedRead;

export interface VisibleSessionPublicState {
	metadata: VisibleSessionPublicMetadata;
	runtime: VisibleSessionPublicRuntime | null;
	promptAccepted: VisibleSessionPublicPromptAccepted | null;
	final: VisibleSessionPublicFinal | null;
	vanished: VisibleSessionPublicVanished | null;
	pane: VisibleSessionPaneTail;
}

export type VisibleSessionPublicStateErrorCode =
	| "partial_initialization"
	| "corrupt"
	| "generation_mismatch"
	| "unstable";

export class VisibleSessionPublicStateError extends Error {
	constructor(
		readonly code: VisibleSessionPublicStateErrorCode,
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "VisibleSessionPublicStateError";
	}
}
export type VisibleSessionPublicStateReaderOptions =
	| {
			/**
			 * Legacy compatibility is available only when this option selects schema 1.
			 * Schema 1 is the default when no option is supplied.
			 */
			expectedSchemaVersion?: 1;
			minimumEpoch?: never;
	  }
	| {
			/** Chosen by trusted configuration, never inferred from mutable public metadata. */
			expectedSchemaVersion: 2;
			/** Trusted lower bound for an authoritative schema-2 recovery read. */
			minimumEpoch?: number;
	  };
interface VisibleSessionPublicSnapshot {
	metadata: Buffer;
	runtime: Buffer | null;
	prompt: Buffer | null;
	pane: Buffer | null;
	events: Buffer | null;
	final: Buffer | null;
	vanished: Buffer | null;
	publication: Buffer | null;
	mutationJournal: Buffer | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validText(value: unknown): value is string {
	return (
		typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_PUBLIC_TEXT_BYTES
	);
}
function validStoredBackend(value: unknown): value is string {
	return validText(value) && readVisibleSessionBackendId(value).kind !== "invalid";
}


function validMetadata(value: unknown): value is VisibleSessionMetadataRead {
	if (!isRecord(value)) return false;
	if (value.schemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION) {
		return (
			(exactKeys(value, [
				"schemaVersion",
				"revision",
				"generationId",
				"authority",
				"createdAt",
				"normalSummary",
				"cleanup",
			]) ||
				exactKeys(value, [
					"schemaVersion",
					"revision",
					"generationId",
					"authority",
					"createdAt",
					"normalSummary",
					"cleanup",
					"projection",
				])) &&
			typeof value.revision === "number" &&
			Number.isSafeInteger(value.revision) &&
			value.revision >= 0 &&
			validText(value.generationId) &&
			validText(value.authority) &&
			validText(value.createdAt) &&
			validText(value.normalSummary) &&
			(value.cleanup === null || validCleanup(value.cleanup)) &&
			(value.projection === undefined || value.projection === null)
		);
	}
	return (
		value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
		exactKeys(value, [
			"schemaVersion",
			"session",
			"workdir",
			"branch",
			"createdAt",
			"gjcBin",
			"stateDir",
			"paneLog",
			"eventsLog",
			"finalStatus",
			"runtimeState",
			"vanishedStatus",
			"promptAcceptedStatus",
			"worktreeBaselineDirty",
			"backend",
			"generation",
			"generationId",
			"owner",
		]) &&
		validTexts(value, [
			"session",
			"workdir",
			"branch",
			"createdAt",
			"gjcBin",
			"stateDir",
			"paneLog",
			"eventsLog",
			"finalStatus",
			"runtimeState",
			"vanishedStatus",
			"promptAcceptedStatus",
			"generation",
			"generationId",
		]) &&
		typeof value.worktreeBaselineDirty === "boolean" &&
		validStoredBackend(value.backend) &&
		value.generation === value.generationId &&
		validOwner(value.owner)
	);
}

function validCleanup(value: unknown): boolean {
	return (
		isRecord(value) &&
		exactKeys(value, ["receipt", "status", "claimant"]) &&
		isRecord(value.receipt) &&
		exactKeys(value.receipt, ["kind", "generationId", "leaseId"]) &&
		value.receipt.kind === "cleanup-private-token" &&
		validText(value.receipt.generationId) &&
		validText(value.receipt.leaseId) &&
		(value.status === "pending" || value.status === "claimed" || value.status === "acknowledged") &&
		(value.claimant === null || validText(value.claimant))
	);
}

function validOwner(value: unknown): value is { pid: number; startedAt: string } {
	return (
		isRecord(value) &&
		exactKeys(value, ["pid", "startedAt"]) &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		validText(value.startedAt)
	);
}
function validManifest(value: unknown, generationId: string): value is VisibleSessionPublicationManifest {
	return (
		isRecord(value) &&
		exactKeys(value, ["schemaVersion", "epoch", "generationId", "owner", "files"]) &&
		value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
		typeof value.epoch === "number" &&
		Number.isSafeInteger(value.epoch) &&
		value.epoch >= 0 &&
		value.generationId === generationId &&
		validOwner(value.owner) &&
		isRecord(value.files) &&
		exactKeys(value.files, ["metadata", "runtime", "prompt", "pane", "events", "final", "vanished"]) &&
		Object.values(value.files).every(
			hash => hash === null || (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)),
		)
	);
}

function validTexts(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.every(key => validText(value[key]));
}

function validNullableText(value: unknown): boolean {
	return value === null || validText(value);
}

function validRuntime(value: unknown, generationId?: string): value is VisibleSessionRuntimeRead {
	if (!isRecord(value)) return false;
	if (exactKeys(value, ["summary", "status", "updatedAt"]))
		return validTexts(value, ["summary", "status", "updatedAt"]);
	return (
		value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
		exactKeys(value, [
			"schemaVersion",
			"backend",
			"generation",
			"generationId",
			"owner",
			"summary",
			"status",
			"updatedAt",
			"present",
			"valid",
			"state",
			"source",
			"event",
			"reason",
			"terminal",
			"terminalState",
			"terminalSource",
			"finalResponsePresent",
			"previousRuntimeState",
			"sessionMatches",
			"cwdMatches",
		]) &&
		validStoredBackend(value.backend) &&
		value.generation === value.generationId &&
		(generationId === undefined || value.generationId === generationId) &&
		validOwner(value.owner) &&
		validTexts(value, ["generation", "generationId", "summary", "status", "updatedAt"]) &&
		["present", "valid", "terminal", "finalResponsePresent", "sessionMatches", "cwdMatches"].every(
			key => typeof value[key] === "boolean",
		) &&
		["state", "source", "event", "reason", "terminalState", "terminalSource", "previousRuntimeState"].every(key =>
			validNullableText(value[key]),
		)
	);
}

function validPrompt(value: unknown, generationId?: string): value is VisibleSessionPromptAcceptedRead {
	if (!isRecord(value)) return false;
	if (exactKeys(value, ["acceptedAt", "summary"])) return validTexts(value, ["acceptedAt", "summary"]);
	return (
		value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
		exactKeys(value, [
			"schemaVersion",
			"backend",
			"generation",
			"generationId",
			"owner",
			"session",
			"acceptedAt",
			"summary",
			"worktreeBaselineDirty",
		]) &&
		validStoredBackend(value.backend) &&
		value.generation === value.generationId &&
		(generationId === undefined || value.generationId === generationId) &&
		value.summary === "prompt accepted" &&
		validOwner(value.owner) &&
		validTexts(value, ["generation", "generationId", "session", "acceptedAt"]) &&
		typeof value.worktreeBaselineDirty === "boolean"
	);
}

function validRuntimeSummary(value: unknown): boolean {
	return (
		isRecord(value) &&
		exactKeys(value, [
			"summary",
			"status",
			"updatedAt",
			"present",
			"valid",
			"state",
			"source",
			"event",
			"reason",
			"terminal",
			"terminalState",
			"terminalSource",
			"finalResponsePresent",
			"previousRuntimeState",
			"sessionMatches",
			"cwdMatches",
			"ownerExitReason",
			"severity",
		]) &&
		validTexts(value, ["summary", "status", "updatedAt", "ownerExitReason"]) &&
		["present", "valid", "terminal", "finalResponsePresent", "sessionMatches", "cwdMatches"].every(
			key => typeof value[key] === "boolean",
		) &&
		["state", "source", "event", "reason", "terminalState", "terminalSource", "previousRuntimeState"].every(key =>
			validNullableText(value[key]),
		) &&
		(value.severity === "normal" || value.severity === "failure")
	);
}

function validFinal(value: unknown, generationId: string): value is VisibleSessionFinalRead {
	if (!isRecord(value)) return false;
	if (value.schemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION)
		return (
			exactKeys(value, [
				"schemaVersion",
				"generationId",
				"committedAt",
				"ownerExitReason",
				"severity",
				"runtimeSummary",
				"worktreeSummary",
				"evidenceSummary",
			]) &&
			value.generationId === generationId &&
			validTexts(value, [
				"committedAt",
				"ownerExitReason",
				"runtimeSummary",
				"worktreeSummary",
				"evidenceSummary",
			]) &&
			(value.severity === "info" || value.severity === "warning" || value.severity === "error")
		);
	return (
		value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
		exactKeys(value, [
			"schemaVersion",
			"backend",
			"generation",
			"generationId",
			"owner",
			"session",
			"status",
			"startedAt",
			"finishedAt",
			"paneLog",
			"runtimeState",
			"turnEvidencePresent",
			"promptAccepted",
			"ownerExitReason",
			"severity",
			"runtimeTerminal",
			"runtimeTerminalState",
			"runtimeTerminalSource",
			"worktreeBaselineDirty",
			"observedRecoverableWorktreeChanges",
			"worktreeChangedSinceBaseline",
			"runtimeStateSummary",
			"committedAt",
			"runtimeSummary",
			"worktreeSummary",
			"evidenceSummary",
		]) &&
		validStoredBackend(value.backend) &&
		value.generation === generationId &&
		value.generationId === generationId &&
		validOwner(value.owner) &&
		validTexts(value, [
			"session",
			"startedAt",
			"finishedAt",
			"paneLog",
			"runtimeState",
			"ownerExitReason",
			"committedAt",
			"runtimeSummary",
			"worktreeSummary",
			"evidenceSummary",
		]) &&
		typeof value.status === "number" &&
		Number.isSafeInteger(value.status) &&
		value.status >= 0 &&
		value.severity !== undefined &&
		(value.severity === "normal" || value.severity === "failure") &&
		typeof value.turnEvidencePresent === "boolean" &&
		typeof value.promptAccepted === "boolean" &&
		typeof value.runtimeTerminal === "boolean" &&
		typeof value.worktreeBaselineDirty === "boolean" &&
		typeof value.observedRecoverableWorktreeChanges === "boolean" &&
		typeof value.worktreeChangedSinceBaseline === "boolean" &&
		validNullableText(value.runtimeTerminalState) &&
		validNullableText(value.runtimeTerminalSource) &&
		validRuntimeSummary(value.runtimeStateSummary)
	);
}

function validVanished(value: unknown, generationId: string): value is VisibleSessionVanishedRead {
	if (!isRecord(value)) return false;
	if (value.schemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION)
		return (
			exactKeys(value, ["schemaVersion", "generationId", "committedAt", "reason", "evidenceSummary"]) &&
			value.generationId === generationId &&
			validTexts(value, ["committedAt", "reason", "evidenceSummary"])
		);
	return (
		value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
		exactKeys(value, [
			"schemaVersion",
			"backend",
			"generation",
			"generationId",
			"owner",
			"session",
			"workdir",
			"detectedAt",
			"committedAt",
			"reason",
			"phase",
			"severity",
			"promptAccepted",
			"finalPresent",
			"tuiReady",
			"paneLog",
			"eventsLog",
			"finalStatus",
			"runtimeState",
			"promptAcceptedStatus",
			"evidenceSummary",
		]) &&
		validStoredBackend(value.backend) &&
		value.generation === generationId &&
		value.generationId === generationId &&
		validOwner(value.owner) &&
		validTexts(value, [
			"session",
			"workdir",
			"detectedAt",
			"committedAt",
			"reason",
			"phase",
			"paneLog",
			"eventsLog",
			"finalStatus",
			"runtimeState",
			"promptAcceptedStatus",
			"evidenceSummary",
		]) &&
		value.severity === "failure" &&
		value.finalPresent === false &&
		typeof value.promptAccepted === "boolean" &&
		typeof value.tuiReady === "boolean"
	);
}
function hasProjectedOwner(value: unknown): value is {
	schemaVersion: 2;
	owner: { pid: number; startedAt: string };
	generation: string;
	generationId: string;
} {
	return (
		isRecord(value) &&
		value.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
		validOwner(value.owner) &&
		validText(value.generation) &&
		validText(value.generationId)
	);
}

function consistentProjection(
	metadata: VisibleSessionMetadataRead,
	values: readonly unknown[],
): boolean {
	if (metadata.schemaVersion !== VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION) return true;
	return values.every(value => {
		if (value === null) return true;
		if (
			!hasProjectedOwner(value) ||
			value.owner.pid !== metadata.owner.pid ||
			value.owner.startedAt !== metadata.owner.startedAt
		)
			return false;
		if (!isRecord(value)) return false;
		const record: Record<string, unknown> = value;
		if (record.generation !== metadata.generation || record.generationId !== metadata.generationId) return false;
		if (record.backend !== metadata.backend) return false;
		if ("session" in record && record.session !== metadata.session) return false;
		if ("workdir" in record && record.workdir !== metadata.workdir) return false;
		if ("paneLog" in record && record.paneLog !== metadata.paneLog) return false;
		if ("eventsLog" in record && record.eventsLog !== metadata.eventsLog) return false;
		if ("runtimeState" in record && record.runtimeState !== metadata.runtimeState) return false;
		if ("finalStatus" in record && record.finalStatus !== metadata.finalStatus) return false;
		if ("vanishedStatus" in record && record.vanishedStatus !== metadata.vanishedStatus) return false;
		if ("promptAcceptedStatus" in record && record.promptAcceptedStatus !== metadata.promptAcceptedStatus)
			return false;
		if ("worktreeBaselineDirty" in record && record.worktreeBaselineDirty !== metadata.worktreeBaselineDirty)
			return false;
		if (
			"runtimeStateSummary" in record &&
			isRecord(record.runtimeStateSummary) &&
			(record.runtimeTerminal !== record.runtimeStateSummary.terminal ||
				record.runtimeTerminalState !== record.runtimeStateSummary.terminalState ||
				record.runtimeTerminalSource !== record.runtimeStateSummary.terminalSource ||
				record.ownerExitReason !== record.runtimeStateSummary.ownerExitReason ||
				record.severity !== record.runtimeStateSummary.severity)
		)
			return false;
		return true;
	});
}

/** Reads the untrusted public recovery projection without acquiring writer authority. */
export class VisibleSessionPublicStateReader {
	readonly #paths: VisibleSessionStatePaths;
	readonly #generationId: string;
	readonly #expectedSchemaVersion: 1 | 2;
	readonly #minimumEpoch: number | null;

	constructor(publicRoot: string, generationId: string, options: VisibleSessionPublicStateReaderOptions = {}) {
		if (!validText(generationId)) throw new Error("Visible session public reader requires an exact generation ID");
		if (
			options.expectedSchemaVersion !== undefined &&
			options.expectedSchemaVersion !== VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION &&
			options.expectedSchemaVersion !== VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION
		)
			throw new Error("Visible session public reader schema version is invalid");
		if (
			options.minimumEpoch !== undefined &&
			options.expectedSchemaVersion !== VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION
		)
			throw new Error("Visible session public reader minimum epoch requires schema 2");
		if (
			options.minimumEpoch !== undefined &&
			(!Number.isSafeInteger(options.minimumEpoch) || options.minimumEpoch < 0)
		)
			throw new Error("Visible session public reader epoch is invalid");
		const root = path.resolve(publicRoot);
		this.#paths = visibleSessionStatePaths(root);
		for (const file of [
			this.#paths.metadata,
			this.#paths.runtimeState,
			this.#paths.promptAccepted,
			this.#paths.final,
			this.#paths.vanished,
			this.#paths.pane,
			this.#paths.publication,
			this.#paths.mutationJournal,
		]) {
			if (!isContained(root, file)) throw new Error("Visible session public state path escapes its root");
		}
		this.#generationId = generationId;
		this.#expectedSchemaVersion = options.expectedSchemaVersion ?? VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION;
		this.#minimumEpoch = options.minimumEpoch ?? null;
	}

	async read(options: VisibleSessionPaneTailOptions): Promise<VisibleSessionPublicState> {
		this.#validateTailOptions(options);
		for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
			try {
				const files = await this.#readSnapshotFiles();
				const metadata = this.#parseRequiredMetadata(files.metadata);
				if (metadata.schemaVersion !== this.#expectedSchemaVersion)
					throw new VisibleSessionPublicStateError("corrupt");
				if (
					this.#expectedSchemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION &&
					files.mutationJournal !== null
				)
					continue;
				const manifest =
					this.#expectedSchemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION
						? this.#parseManifest(files.publication)
						: null;
				if (this.#expectedSchemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION && !manifest)
					throw new VisibleSessionPublicStateError("partial_initialization");
				if (manifest) {
					if (metadata.schemaVersion !== VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION)
						throw new VisibleSessionPublicStateError("corrupt");
					if (
						manifest.owner.pid !== metadata.owner.pid ||
						manifest.owner.startedAt !== metadata.owner.startedAt ||
						(this.#minimumEpoch !== null && manifest.epoch < this.#minimumEpoch)
					)
						throw new VisibleSessionPublicStateError("corrupt");
					if (!this.#matchesManifest(manifest, files)) continue;
				}
				if (
					metadata.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION &&
					(metadata.stateDir !== this.#paths.root ||
						metadata.paneLog !== this.#paths.pane ||
						metadata.eventsLog !== this.#paths.events ||
						metadata.finalStatus !== this.#paths.final ||
						metadata.runtimeState !== this.#paths.runtimeState ||
						metadata.vanishedStatus !== this.#paths.vanished ||
						metadata.promptAcceptedStatus !== this.#paths.promptAccepted)
				)
					throw new VisibleSessionPublicStateError("corrupt");
				const runtime = this.#parseOptional(files.runtime, value => validRuntime(value, this.#generationId));
				const promptAccepted = this.#parseOptional(files.prompt, value => validPrompt(value, this.#generationId));
				const final = this.#parseOptional(files.final, value => validFinal(value, this.#generationId));
				const vanished = this.#parseOptional(files.vanished, value => validVanished(value, this.#generationId));
				const pane = this.#paneFromBytes(files.pane, options);
				if (final && vanished) throw new VisibleSessionPublicStateError("corrupt");
				if (!consistentProjection(metadata, [runtime, promptAccepted, final, vanished]))
					throw new VisibleSessionPublicStateError("corrupt");
				const stableMetadata = await this.#readPublicFile(this.#paths.metadata);
				if (!stableMetadata.equals(files.metadata)) continue;
				if (manifest) {
					const stableManifest = await this.#readOptionalPublicFile(this.#paths.publication);
					if (files.publication === null || !stableManifest?.equals(files.publication)) continue;
				}
				if (this.#expectedSchemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION) {
					const stableMutationJournal = await this.#readOptionalLegacyMutationJournal();
					if (
						files.mutationJournal === null
							? stableMutationJournal !== null
							: !stableMutationJournal?.equals(files.mutationJournal)
					)
						continue;
				}
				return {
					metadata: projectMetadata(metadata),
					runtime: projectRuntime(runtime),
					promptAccepted: projectPromptAccepted(promptAccepted),
					final: projectFinal(final),
					vanished: projectVanished(vanished),
					pane,
				};
			} catch (caught) {
				if (
					caught instanceof VisibleSessionPublicFileChangedError ||
					(caught as NodeJS.ErrnoException).code === "ENOENT"
				) {
					if (attempt + 1 === STABLE_READ_ATTEMPTS) throw new VisibleSessionPublicStateError("unstable");
					continue;
				}
				throw caught;
			}
		}
		throw new VisibleSessionPublicStateError("unstable");
	}

	async readPaneTail(options: VisibleSessionPaneTailOptions): Promise<VisibleSessionPaneTail> {
		this.#validateTailOptions(options);
		return (await this.read(options)).pane;
	}

	#validateTailOptions(options: VisibleSessionPaneTailOptions): void {
		if (
			!Number.isSafeInteger(options.bytes) ||
			!Number.isSafeInteger(options.lines) ||
			options.bytes <= 0 ||
			options.lines <= 0 ||
			options.bytes > MAX_VISIBLE_SESSION_PANE_TAIL_BYTES ||
			options.lines > MAX_VISIBLE_SESSION_PANE_TAIL_LINES
		)
			throw new Error("Visible session pane tail limits are invalid");
	}

	async #readSnapshotFiles(): Promise<VisibleSessionPublicSnapshot> {
		try {
			return {
				metadata: await this.#readPublicFile(this.#paths.metadata),
				runtime: await this.#readOptionalPublicFile(this.#paths.runtimeState),
				prompt: await this.#readOptionalPublicFile(this.#paths.promptAccepted),
				pane: await this.#readOptionalPublicFile(this.#paths.pane),
				events: await this.#readOptionalPublicFile(this.#paths.events),
				final: await this.#readOptionalPublicFile(this.#paths.final),
				vanished: await this.#readOptionalPublicFile(this.#paths.vanished),
				publication: await this.#readOptionalPublicFile(this.#paths.publication),
				mutationJournal: await this.#readOptionalLegacyMutationJournal(),
			};
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code === "ENOENT")
				throw new VisibleSessionPublicStateError("partial_initialization");
			throw caught;
		}
	}
	#parseRequiredMetadata(bytes: Buffer): VisibleSessionMetadataRead {
		const value = this.#parseJson(bytes);
		if (!validMetadata(value)) throw new VisibleSessionPublicStateError("corrupt");
		if (value.generationId !== this.#generationId) throw new VisibleSessionPublicStateError("generation_mismatch");
		return value;
	}
	#parseManifest(bytes: Buffer | null): VisibleSessionPublicationManifest | null {
		if (bytes === null) return null;
		const manifest = this.#parseJson(bytes);
		if (!validManifest(manifest, this.#generationId)) throw new VisibleSessionPublicStateError("corrupt");
		return manifest;
	}
	#parseOptional<T>(bytes: Buffer | null, valid: (value: unknown) => value is T): T | null {
		if (bytes === null) return null;
		const value = this.#parseJson(bytes);
		if (!valid(value)) throw new VisibleSessionPublicStateError("corrupt");
		return value;
	}
	#parseJson(bytes: Buffer): unknown {
		try {
			return JSON.parse(decodeUtf8(bytes)) as unknown;
		} catch (caught) {
			if (caught instanceof VisibleSessionPublicStateError) throw caught;
			throw new VisibleSessionPublicStateError("corrupt");
		}
	}
	#matchesManifest(manifest: VisibleSessionPublicationManifest, files: VisibleSessionPublicSnapshot): boolean {
		const contents: Record<keyof VisibleSessionPublicationManifest["files"], Buffer | null> = {
			metadata: files.metadata,
			runtime: files.runtime,
			prompt: files.prompt,
			pane: files.pane,
			events: files.events,
			final: files.final,
			vanished: files.vanished,
		};
		return Object.entries(manifest.files).every(([name, expected]) => {
			const bytes = contents[name as keyof VisibleSessionPublicationManifest["files"]];
			return expected === null
				? bytes === null
				: bytes !== null && createHash("sha256").update(bytes).digest("hex") === expected;
		});
	}
	#paneFromBytes(bytes: Buffer | null, options: VisibleSessionPaneTailOptions): VisibleSessionPaneTail {
		if (bytes === null) return { text: "", lines: 0, truncated: false };
		const tail = bytes.length > options.bytes ? bytes.subarray(bytes.length - options.bytes) : bytes;
		let start = 0;
		while (start < tail.length && (tail[start] & 0xc0) === 0x80) start += 1;
		const text = decodeUtf8(tail.subarray(start));
		const parts = text.match(/[^\n]*(?:\n|$)/g)?.filter(part => part.length > 0) ?? [];
		const selected = parts.slice(-options.lines);
		return {
			text: selected.join(""),
			lines: selected.length,
			truncated: bytes.length > options.bytes || selected.length !== parts.length,
		};
	}

	async #readPublicFile(file: string): Promise<Buffer> {
		try {
			return await readVisibleSessionPublicFile(file);
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code === "ENOENT") throw caught;
			if (caught instanceof VisibleSessionPublicFileChangedError) throw caught;
			throw new VisibleSessionPublicStateError("corrupt", { cause: caught });
		}
	}
	async #readOptionalLegacyMutationJournal(): Promise<Buffer | null> {
		try {
			return await readVisibleSessionBoundedFile(
				this.#paths.mutationJournal,
				MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES * 2,
			);
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
			if (caught instanceof VisibleSessionPublicFileChangedError) throw caught;
			throw new VisibleSessionPublicStateError("corrupt", { cause: caught });
		}
	}
	async #readOptionalPublicFile(file: string): Promise<Buffer | null> {
		try {
			return await this.#readPublicFile(file);
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw caught;
		}
	}
}

function projectBackend(backend: string): VisibleSessionPublicBackend {
	const result = readVisibleSessionBackendId(backend);
	if (result.kind === "invalid") throw new VisibleSessionPublicStateError("corrupt");
	return result;
}

function projectMetadata(metadata: VisibleSessionMetadataRead): VisibleSessionPublicMetadata {
	if (metadata.schemaVersion === VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION)
		return { ...metadata, backend: projectBackend(metadata.backend) };
	return {
		schemaVersion: metadata.schemaVersion,
		revision: metadata.revision,
		generationId: metadata.generationId,
		createdAt: metadata.createdAt,
		normalSummary: metadata.normalSummary,
	};
}

function projectRuntime(runtime: VisibleSessionRuntimeRead | null): VisibleSessionPublicRuntime | null {
	if (runtime === null || !("schemaVersion" in runtime)) return runtime;
	return { ...runtime, backend: projectBackend(runtime.backend) };
}

function projectPromptAccepted(
	promptAccepted: VisibleSessionPromptAcceptedRead | null,
): VisibleSessionPublicPromptAccepted | null {
	if (promptAccepted === null || !("schemaVersion" in promptAccepted)) return promptAccepted;
	return { ...promptAccepted, backend: projectBackend(promptAccepted.backend) };
}

function projectFinal(final: VisibleSessionFinalRead | null): VisibleSessionPublicFinal | null {
	if (final === null || final.schemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION) return final;
	return { ...final, backend: projectBackend(final.backend) };
}

function projectVanished(vanished: VisibleSessionVanishedRead | null): VisibleSessionPublicVanished | null {
	if (vanished === null || vanished.schemaVersion === VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION) return vanished;
	return { ...vanished, backend: projectBackend(vanished.backend) };
}

function isContained(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return (
		relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
	);
}

function decodeUtf8(content: Buffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch {
		throw new VisibleSessionPublicStateError("corrupt");
	}
}
