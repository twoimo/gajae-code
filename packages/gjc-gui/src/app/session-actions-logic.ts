import type { ThreadView } from "./transcript";

export type ConfirmState = { kind: "delete" | "archive"; threadId: string; title: string } | null;

export type SessionTreeNode = {
	id: string;
	type: string;
	preview: string;
	active: boolean;
	children: SessionTreeNode[];
	label?: string | null;
};
export type FlatTreeNode = SessionTreeNode & { depth: number; marker: "•" | " "; text: string };

export function flattenSessionTree(nodes: SessionTreeNode[], depth = 0, visited = new Set<string>()): FlatTreeNode[] {
	const flattened: FlatTreeNode[] = [];
	for (const node of nodes) {
		if (visited.has(node.id)) continue;
		visited.add(node.id);
		const marker = node.active ? "•" : " ";
		const text = `${"  ".repeat(depth)}${marker} ${node.label ?? (node.preview || node.type)}`;
		flattened.push({ ...node, depth, marker, text });
		flattened.push(...flattenSessionTree(node.children, depth + 1, visited));
	}
	return flattened;
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

export function removeThread(threads: ThreadView[], id: string): ThreadView[] {
	return threads.filter(thread => thread.id !== id);
}

export function markThreadArchived(threads: ThreadView[], id: string): ThreadView[] {
	return threads.map(thread =>
		thread.id === id ? { ...thread, status: "archived", lastActivity: "archived" } : thread,
	);
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
