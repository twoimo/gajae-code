import type { VisibleSessionBackendId, VisibleSessionUnsupportedBackendId } from "./backend";

export const VISIBLE_SESSION_SCHEMA_VERSION = 1 as const;
export type VisibleSessionBackend = VisibleSessionBackendId;
export type VisibleSessionStoredBackend = VisibleSessionBackend | VisibleSessionUnsupportedBackendId;
export type VisibleSessionPlatform = "win32" | "posix";
export type VisibleSessionGenerationStatus = "prepared" | "active";
export interface VisibleSessionTmuxOwnership {
	socketKey: string;
	sessionName: string;
	stateFilePath: string;
	ownerGeneration: string;
}
export interface VisibleSessionName {
	displayName: string;
	key: string;
}
export interface VisibleSessionProcessIdentity {
	pid: number;
	startedAt: string;
	hostname: string;
}
export interface ManagedPublicBase {
	id: string;
	path: string;
	claimedAt: string;
}
export interface VisibleSessionGeneration {
	generationId: string;
	counter: number;
	status: VisibleSessionGenerationStatus;
	startIdentity: string;
	leaseId: string;
	publicBaseId: string;
	publicRoot: string;
	privateRoot: string;
	manifestFilePath: string;
	createdAt: string;
	process?: VisibleSessionProcessIdentity;
	tokenFilePath: string;
	tokenSha256: string;
	tmux?: VisibleSessionTmuxOwnership;
}
export interface VisibleSessionRegistryEntry {
	name: VisibleSessionName;
	repository: string;
	worktree: string;
	backend: VisibleSessionStoredBackend;
	active: VisibleSessionGeneration;
	history: VisibleSessionGeneration[];
}
export interface VisibleSessionRegistryFile {
	schemaVersion: typeof VISIBLE_SESSION_SCHEMA_VERSION;
	revision: number;
	nextGenerationCounter: number;
	managedPublicBases: ManagedPublicBase[];
	entries: VisibleSessionRegistryEntry[];
}
export interface CreateVisibleSessionInput {
	name: string;
	repository: string;
	worktree: string;
	backend: VisibleSessionBackend;
	publicBase?: string;
}
export interface RecreateVisibleSessionInput extends CreateVisibleSessionInput {
	expectedRevision: number;
	expectedActiveGeneration: string;
}
export interface ActivateVisibleSessionOwnerInput {
	expectedRevision: number;
	generationId: string;
	startIdentity: string;
	process: VisibleSessionProcessIdentity;
}
export interface RollbackVisibleSessionOwnerActivationInput {
	expectedRevision: number;
	generationId: string;
	startIdentity: string;
	process: VisibleSessionProcessIdentity;
}
export interface CreateVisibleSessionResult {
	revision: number;
	entry: VisibleSessionRegistryEntry;
	generation: VisibleSessionGeneration;
}
