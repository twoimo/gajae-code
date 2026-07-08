import type { ThreadView } from "./transcript";

export type ConfirmState = { kind: "delete" | "archive" | "move"; threadId: string; title: string } | null;

export type DeferredSessionAction = { name: string; rationale: string };

export const DEFERRED_SESSION_ACTIONS: DeferredSessionAction[] = [
	{ name: "Move", rationale: "Filesystem workspace/session relocation needs dry-run and rollback design before shipping." },
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

export async function retryLastTurnAction(client: { gjcRetry(params: { threadId: string }): Promise<unknown> }, threadId: string | null | undefined): Promise<boolean> {
	if (!threadId) return false;
	await client.gjcRetry({ threadId });
	return true;
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


export type SessionListEntry = { id: string; title?: string | null; firstMessage?: string | null; path: string; modifiedAt: string };
export type SessionTreeNode = { id: string; type: string; preview: string; active: boolean; children: SessionTreeNode[]; label?: string | null };
export type FlatTreeNode = SessionTreeNode & { depth: number; marker: "•" | " "; text: string };
export type SessionScope = "all" | "cwd";



export function flattenSessionTree(nodes: SessionTreeNode[], depth = 0): FlatTreeNode[] {
	return nodes.flatMap(node => {
		const marker = node.active ? "•" : " ";
		const text = `${"  ".repeat(depth)}${marker} ${node.label ?? (node.preview || node.type)}`;
		return [{ ...node, depth, marker, text }, ...flattenSessionTree(node.children, depth + 1)];
	});
}
export function buildSessionBrowserParams(query: string, scope: SessionScope, cwd: string | undefined, limit = 50): { query?: string; scope: SessionScope; cwd?: string; limit: number } {
	const params: { query?: string; scope: SessionScope; cwd?: string; limit: number } = { scope: scope === "cwd" && cwd ? "cwd" : "all", limit };
	const trimmed = query.trim();
	if (trimmed) params.query = trimmed;
	if (params.scope === "cwd") params.cwd = cwd;
	return params;
}

export function sessionOpenPayload(sessionPath: string): { sessionPath: string } {
	return { sessionPath };
}

export function sessionDeletePayload(sessionPath: string): { sessionPath: string } {
	return { sessionPath };
}

export function sessionNavigatePayload(threadId: string, entryId: string, summarize?: boolean): { threadId: string; entryId: string; summarize?: boolean } {
	return summarize === undefined ? { threadId, entryId } : { threadId, entryId, summarize };
}

export function sessionLabelPayload(threadId: string, entryId: string, label: string): { threadId: string; entryId: string; label: string } {
	return { threadId, entryId, label: label.trim() };
}

export function validateSessionLabel(label: string): string | null {
	if (label.length > 200) return "Label must be 200 characters or fewer.";
	return null;
}

export function validateRenameTitle(title: string): string | null {
	const trimmed = title.trim();
	if (!trimmed) return "Title is required.";
	if (trimmed.length > 200) return "Title must be 200 characters or fewer.";
	return null;
}

export function provenanceLabel(provenance: { exportedAt: string; redacted: boolean; tool: string }): string {
	return `${provenance.tool} · ${provenance.redacted ? "redacted" : "raw"} · ${provenance.exportedAt}`;
}

export type SessionMoveDryRunResult = { dryRun: true; sourceSessionFile: string; targetSessionFile: string; artifactsDirs: string[]; crossDevice: boolean; conflicts: string[] };
export type SessionMoveConfirmState = { threadId: string; targetCwd: string; plan: SessionMoveDryRunResult } | null;

export function sessionMovePayload(threadId: string, targetCwd: string, dryRun: boolean): { threadId: string; targetCwd: string; dryRun: boolean } {
	return { threadId, targetCwd, dryRun };
}

export async function dryRunSessionMove(client: { gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun: true }): Promise<SessionMoveDryRunResult> }, threadId: string, targetCwd: string): Promise<SessionMoveConfirmState> {
	const plan = await client.gjcSessionMove(sessionMovePayload(threadId, targetCwd, true) as { threadId: string; targetCwd: string; dryRun: true });
	return { threadId, targetCwd, plan };
}

export async function executeSessionMove(client: { gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun?: false }): Promise<{ dryRun: false; movedTo: string; sessionPath: string }> }, state: SessionMoveConfirmState): Promise<{ dryRun: false; movedTo: string; sessionPath: string } | undefined> {
	if (!state) return undefined;
	return client.gjcSessionMove({ threadId: state.threadId, targetCwd: state.targetCwd, dryRun: false });
}

export type UnifiedSessionRow = {
	id: string;
	path?: string;
	title: string;
	meta: string;
	depth: number;
	loaded: boolean;
	active: boolean;
	status: "active" | "idle" | "running" | "stored" | "archived" | "error" | "new";
};

export function deriveUnifiedSessionRows(params: {
	threads: Array<{ id: string; title?: string; cwd?: string; status?: string; lastActivity?: string }>;
	sessions: SessionListEntry[];
	tree: FlatTreeNode[];
	activeThreadId?: string;
}): UnifiedSessionRow[] {
	const sessionById = new Map(params.sessions.map(session => [session.id, session]));
	const rows: UnifiedSessionRow[] = [];
	const seen = new Set<string>();
	for (const thread of params.threads) {
		const session = sessionById.get(thread.id);
		seen.add(thread.id);
		rows.push({
			id: thread.id,
			path: session?.path,
			title: thread.title || session?.title || session?.firstMessage || thread.cwd || thread.id,
			meta: [thread.lastActivity || session?.modifiedAt, thread.cwd].filter(Boolean).join(" · "),
			depth: 0,
			loaded: true,
			active: thread.id === params.activeThreadId,
			status: thread.status === "error" ? "error" : thread.status === "archived" ? "archived" : thread.status === "running" ? "running" : thread.id === params.activeThreadId ? "active" : "idle",
		});
	}
	for (const session of params.sessions) {
		if (seen.has(session.id)) continue;
		seen.add(session.id);
		rows.push({
			id: session.id,
			path: session.path,
			title: session.title || session.firstMessage || session.id,
			meta: session.modifiedAt,
			depth: 0,
			loaded: false,
			active: false,
			status: "stored",
		});
	}
	for (const node of params.tree) {
		if (seen.has(node.id)) continue;
		rows.push({
			id: node.id,
			title: node.label ?? (node.preview || node.type),
			meta: node.type,
			depth: node.depth + 1,
			loaded: false,
			active: node.active,
			status: node.active ? "active" : "stored",
		});
	}
	return rows;
}

export function sessionRowStatusPresentation(status: UnifiedSessionRow["status"]): { label: string; tone: "success" | "warning" | "danger" | "dim" } {
	if (status === "active") return { label: "active", tone: "success" };
	if (status === "running") return { label: "running", tone: "warning" };
	if (status === "error") return { label: "error", tone: "danger" };
	if (status === "archived") return { label: "archived", tone: "dim" };
	if (status === "stored") return { label: "stored", tone: "dim" };
	return { label: "idle", tone: "dim" };
}

export function clampRovingIndex(current: number, count: number): number {
	if (count <= 0) return -1;
	if (current < 0) return 0;
	return Math.min(current, count - 1);
}


export function nextRovingIndex(current: number, key: string, count: number): number {
	if (count <= 0) return -1;
	if (key === "ArrowDown") return (current + 1) % count;
	if (key === "ArrowUp") return (current - 1 + count) % count;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return current;
}

export function nextRightRailCollapsed(current: boolean, action: "toggle" | "collapse" | "expand", viewportWidth: number): boolean {
	if (viewportWidth < 1180) return true;
	if (action === "toggle") return !current;
	return action === "collapse";
}

export function escapeAction(state: { overlayOpen: boolean; transientOpen: boolean; queuedText: string; running: boolean }): "close-overlay" | "dismiss-transient" | "clear-queued" | "interrupt" | "none" {
	if (state.overlayOpen) return "close-overlay";
	if (state.transientOpen) return "dismiss-transient";
	if (state.queuedText.trim()) return "clear-queued";
	if (state.running) return "interrupt";
	return "none";
}

export function composerSubmitMode(params: { connected: boolean; busy: boolean; text: string }): "send" | "queue" | "ignore" {
	if (!params.connected || !params.text.trim()) return "ignore";
	return params.busy ? "queue" : "send";
}

export type InterleavedEntry<TItem, TApproval> = { kind: "item"; item: TItem } | { kind: "approval"; approval: TApproval };

export function interleaveApprovals<TItem extends { id: string; turnId?: string; createdAt?: string | number }, TApproval extends { id: string; turnId?: string; createdAt?: string | number }>(items: TItem[], approvals: TApproval[]): Array<InterleavedEntry<TItem, TApproval>> {
	const entries: Array<InterleavedEntry<TItem, TApproval>> = [];
	const pending = [...approvals];
	for (const item of items) {
		entries.push({ kind: "item", item });
		const matched = pending.filter(approval => approval.turnId && approval.turnId === item.turnId);
		for (const approval of matched) {
			entries.push({ kind: "approval", approval });
			pending.splice(pending.indexOf(approval), 1);
		}
	}
	// Workflow gates without a turnId are not tied to a specific transcript item;
	// render them after the current/latest item instead of relying on insertion order.
	for (const approval of pending) entries.push({ kind: "approval", approval });
	return entries;
}
