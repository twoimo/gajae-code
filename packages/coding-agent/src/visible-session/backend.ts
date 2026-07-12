import type { VisibleSessionGeneration, VisibleSessionRegistryEntry } from "./types";

export const VISIBLE_SESSION_BACKEND_IDS = ["conpty", "tmux", "wsl-tmux"] as const;
export type VisibleSessionBackendId = (typeof VISIBLE_SESSION_BACKEND_IDS)[number];
export interface VisibleSessionBackendCapabilities {
	localControl: boolean;
	interactiveAttach: boolean;
	routerWatch: boolean;
}
export interface VisibleSessionBackendUnavailable {
	kind: "unavailable";
	backend: VisibleSessionBackendId;
	reason: string;
}
export type VisibleSessionBackendTerminalStatus = "completed" | "failed" | "cancelled" | "vanished";
export interface VisibleSessionBackendTerminal {
	kind: "terminal";
	backend: VisibleSessionBackendId;
	status: VisibleSessionBackendTerminalStatus;
}
export interface VisibleSessionBackendContext {
	entry: VisibleSessionRegistryEntry;
	generation: VisibleSessionGeneration;
}
export interface VisibleSessionBackendSessionCommandInput {
	context: VisibleSessionBackendContext;
	readOnly?: boolean;
}
export interface VisibleSessionBackendRunning {
	kind: "running";
	backend: VisibleSessionBackendId;
}
export interface VisibleSessionBackendCancelAccepted {
	kind: "accepted";
	backend: VisibleSessionBackendId;
}
export type VisibleSessionBackendProbe =
	| VisibleSessionBackendRunning
	| VisibleSessionBackendTerminal
	| VisibleSessionBackendUnavailable;
export type VisibleSessionBackendCancelResult =
	| VisibleSessionBackendCancelAccepted
	| VisibleSessionBackendTerminal
	| VisibleSessionBackendUnavailable;
export interface VisibleSessionBackendPort {
	readonly id: VisibleSessionBackendId;
	readonly capabilities: VisibleSessionBackendCapabilities;
	sessionCommand(
		input: VisibleSessionBackendSessionCommandInput,
	): Promise<readonly string[] | VisibleSessionBackendUnavailable>;
	probe(context: VisibleSessionBackendContext): Promise<VisibleSessionBackendProbe>;
	cancel(context: VisibleSessionBackendContext): Promise<VisibleSessionBackendCancelResult>;
}
export interface VisibleSessionSupportedBackendId {
	kind: "supported";
	backend: VisibleSessionBackendId;
	source: "canonical" | "legacy";
}
export interface VisibleSessionUnsupportedBackendId {
	kind: "unsupported";
	rawId: string;
}
export interface VisibleSessionInvalidBackendId {
	kind: "invalid";
}
export type VisibleSessionBackendIdRead =
	| VisibleSessionSupportedBackendId
	| VisibleSessionUnsupportedBackendId
	| VisibleSessionInvalidBackendId;

export function readVisibleSessionBackendId(value: unknown): VisibleSessionBackendIdRead {
	if (typeof value !== "string" || value.length === 0) return { kind: "invalid" };
	if (value === "native") return { kind: "supported", backend: "conpty", source: "legacy" };
	if (value === "conpty" || value === "tmux" || value === "wsl-tmux") {
		return { kind: "supported", backend: value, source: "canonical" };
	}
	return { kind: "unsupported", rawId: value };
}
