import { DEFAULT_CWD, normalizeDirectoryInput } from "./directory-logic";

export class DirectoryValidationError extends Error {}

export type StartChatDecision =
	| { kind: "scratch"; cwd: string }
	| { kind: "project"; cwd: string }
	| { kind: "invalid-directory" };

export function startChatDecision(workingDirectory: string): StartChatDecision {
	const hasInput = workingDirectory.trim().length > 0;
	const normalized = normalizeDirectoryInput(workingDirectory);
	if (!hasInput) return { kind: "scratch", cwd: DEFAULT_CWD };
	if (!normalized) return { kind: "invalid-directory" };
	return normalized === DEFAULT_CWD ? { kind: "scratch", cwd: normalized } : { kind: "project", cwd: normalized };
}
