import type { ThreadView } from "./transcript";

export type ConfirmState = { kind: "delete" | "archive"; threadId: string; title: string } | null;

export type DeferredSessionAction = { name: string; rationale: string };

export const DEFERRED_SESSION_ACTIONS: DeferredSessionAction[] = [
	{ name: "Rename", rationale: "Needs a persistent session metadata API." },
	{ name: "Move", rationale: "Needs a workspace/session relocation API." },
	{ name: "Export", rationale: "Needs a transcript dump/export API." },
	{ name: "Tree", rationale: "Needs session branch navigation API support." },
	{ name: "Search", rationale: "Needs persistent history search API support." },
];

export function removeThread(threads: ThreadView[], id: string): ThreadView[] {
	return threads.filter(thread => thread.id !== id);
}

export function markThreadArchived(threads: ThreadView[], id: string): ThreadView[] {
	return threads.map(thread => (thread.id === id ? { ...thread, status: "archived", lastActivity: "archived" } : thread));
}

export function openConfirm(kind: Exclude<ConfirmState, null>["kind"], thread: ThreadView): ConfirmState {
	return { kind, threadId: thread.id, title: thread.title };
}

export function cancelConfirm(): ConfirmState {
	return null;
}

export function confirmSessionAction(
	state: ConfirmState,
	handlers: { onDelete(threadId: string): void; onArchive(threadId: string): void },
): ConfirmState {
	if (!state) return null;
	if (state.kind === "delete") handlers.onDelete(state.threadId);
	if (state.kind === "archive") handlers.onArchive(state.threadId);
	return null;
}
