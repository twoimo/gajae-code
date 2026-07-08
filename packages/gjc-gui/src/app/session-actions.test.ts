import { describe, expect, test } from "bun:test";
import type { ThreadView } from "./transcript";
import {
	buildSessionBrowserParams,
	cancelConfirm,
	clampRovingIndex,
	confirmSessionAction,
	DEFERRED_SESSION_ACTIONS,
	composerSubmitMode,
	deriveUnifiedSessionRows,
	escapeAction,
	interleaveApprovals,
	nextRightRailCollapsed,
	nextRovingIndex,
	markThreadArchived,
	flattenSessionTree,
	openConfirm,
	retryLastTurnAction,
	removeThread,
	sessionDeletePayload,
	sessionLabelPayload,
	sessionNavigatePayload,
	sessionOpenPayload,
	sessionRowStatusPresentation,
	validateSessionLabel,
	dryRunSessionMove,
	executeSessionMove,
	sessionMovePayload,
} from "./session-actions-logic";

const threads: ThreadView[] = [
	{ id: "thread-a", title: "Alpha", status: "idle", lastActivity: "idle" },
	{ id: "thread-b", title: "Beta", status: "running", lastActivity: "running" },
];

describe("session action helpers", () => {
	test("removeThread removes only the requested thread", () => {
		expect(removeThread(threads, "thread-a")).toEqual([threads[1]]);
		expect(removeThread(threads, "missing")).toEqual(threads);
	});

	test("markThreadArchived marks only the requested thread archived", () => {
		expect(markThreadArchived(threads, "thread-b")).toEqual([
			threads[0],
			{ ...threads[1], status: "archived", lastActivity: "archived" },
		]);
	});

	test("delete confirmation calls onDelete only after confirm", () => {
		const calls: string[] = [];
		const confirm = openConfirm("delete", threads[0]);
		expect(confirm).toEqual({ kind: "delete", threadId: "thread-a", title: "Alpha" });

		expect(cancelConfirm()).toBeNull();
		expect(calls).toEqual([]);

		expect(
			confirmSessionAction(confirm, {
				onDelete: id => calls.push(`delete:${id}`),
				onArchive: id => calls.push(`archive:${id}`),
			}),
		).toBeNull();
		expect(calls).toEqual(["delete:thread-a"]);
	});

	test("archive confirmation calls onArchive only after confirm", () => {
		const calls: string[] = [];
		const confirm = openConfirm("archive", threads[1]);

		expect(cancelConfirm()).toBeNull();
		expect(calls).toEqual([]);

		expect(
			confirmSessionAction(confirm, {
				onDelete: id => calls.push(`delete:${id}`),
				onArchive: id => calls.push(`archive:${id}`),
			}),
		).toBeNull();
		expect(calls).toEqual(["archive:thread-b"]);
	});

	test("retry action calls generated gjcRetry wrapper for active thread", async () => {
		const calls: Array<{ threadId: string }> = [];
		const didRetry = await retryLastTurnAction({ gjcRetry: async params => calls.push(params) }, "thread-a");

		expect(didRetry).toBe(true);
		expect(calls).toEqual([{ threadId: "thread-a" }]);
	});

	test("retry action is a no-op without an active thread", async () => {
		const calls: Array<{ threadId: string }> = [];
		const didRetry = await retryLastTurnAction({ gjcRetry: async params => calls.push(params) }, undefined);

		expect(didRetry).toBe(false);
		expect(calls).toEqual([]);
	});

	test("deferred session actions list unavailable API-backed features", () => {
		expect(DEFERRED_SESSION_ACTIONS.map(action => action.name)).toEqual(["Move"]);
		expect(DEFERRED_SESSION_ACTIONS.every(action => action.rationale.length > 0)).toBe(true);
	});

	test("session browser params preserve all scope by default and add cwd for folder scope", () => {
		expect(buildSessionBrowserParams("  ", "all", "/repo")).toEqual({ scope: "all", limit: 50 });
		expect(buildSessionBrowserParams(" alpha ", "cwd", "/repo", 25)).toEqual({ query: "alpha", scope: "cwd", cwd: "/repo", limit: 25 });
		expect(buildSessionBrowserParams("alpha", "cwd", undefined)).toEqual({ query: "alpha", scope: "all", limit: 50 });
	});

	test("session row action helpers build wrapper payloads", () => {
		expect(sessionOpenPayload("/sessions/a.jsonl")).toEqual({ sessionPath: "/sessions/a.jsonl" });
		expect(sessionDeletePayload("/sessions/a.jsonl")).toEqual({ sessionPath: "/sessions/a.jsonl" });
	});

	test("tree flattening and navigation payloads retain active marker and ids", () => {
		const flat = flattenSessionTree([
			{ id: "root", type: "message", preview: "Root", active: false, children: [{ id: "leaf", type: "tool", preview: "Leaf", active: true, children: [], label: "Chosen" }] },
		]);

		expect(flat.map(node => ({ id: node.id, depth: node.depth, marker: node.marker, text: node.text }))).toEqual([
			{ id: "root", depth: 0, marker: " ", text: "  Root" },
			{ id: "leaf", depth: 1, marker: "•", text: "  • Chosen" },
		]);
		expect(sessionNavigatePayload("thread-a", "leaf")).toEqual({ threadId: "thread-a", entryId: "leaf" });
		expect(sessionNavigatePayload("thread-a", "leaf", true)).toEqual({ threadId: "thread-a", entryId: "leaf", summarize: true });
	});

	test("label helpers allow empty labels and reject labels over 200 chars", () => {
		expect(validateSessionLabel("")).toBeNull();
		expect(validateSessionLabel("x".repeat(200))).toBeNull();
		expect(validateSessionLabel("x".repeat(201))).toBe("Label must be 200 characters or fewer.");
		expect(sessionLabelPayload("thread-a", "entry-b", "  label  ")).toEqual({ threadId: "thread-a", entryId: "entry-b", label: "label" });
	});

	test("unified session rows mark loaded and active status with tree indentation", () => {
		const rows = deriveUnifiedSessionRows({
			threads,
			sessions: [{ id: "thread-a", title: "Stored alpha", firstMessage: null, path: "/a", modifiedAt: "today" }, { id: "stored", title: null, firstMessage: "Saved", path: "/s", modifiedAt: "yesterday" }],
			tree: [{ id: "branch", type: "message", preview: "Branch", active: false, children: [], marker: " ", text: "Branch", depth: 1 }],
			activeThreadId: "thread-a",
		});
		expect(rows.map(row => ({ id: row.id, status: row.status, loaded: row.loaded, depth: row.depth }))).toEqual([
			{ id: "thread-a", status: "active", loaded: true, depth: 0 },
			{ id: "thread-b", status: "running", loaded: true, depth: 0 },
			{ id: "stored", status: "stored", loaded: false, depth: 0 },
			{ id: "branch", status: "stored", loaded: false, depth: 2 },
		]);
	});

	test("session row status labels cover active idle running archived error and stored", () => {
		const rows = deriveUnifiedSessionRows({
			threads: [
				{ id: "active", title: "Active", status: "idle" },
				{ id: "idle", title: "Idle", status: "idle" },
				{ id: "running", title: "Running", status: "running" },
				{ id: "archived", title: "Archived", status: "archived" },
				{ id: "error", title: "Error", status: "error" },
			],
			sessions: [{ id: "stored", path: "/stored", modifiedAt: "saved" }],
			tree: [],
			activeThreadId: "active",
		});
		expect(rows.map(row => [row.id, sessionRowStatusPresentation(row.status).label, sessionRowStatusPresentation(row.status).tone])).toEqual([
			["active", "active", "success"],
			["idle", "idle", "dim"],
			["running", "running", "warning"],
			["archived", "archived", "dim"],
			["error", "error", "danger"],
			["stored", "stored", "dim"],
		]);
	});

	test("right rail collapse obeys responsive breakpoint", () => {
		expect(nextRightRailCollapsed(false, "toggle", 1400)).toBe(true);
		expect(nextRightRailCollapsed(true, "expand", 1400)).toBe(false);
		expect(nextRightRailCollapsed(false, "expand", 900)).toBe(true);
	});

	test("approvals interleave after the blocked turn", () => {
		const entries = interleaveApprovals([{ id: "group-t1", turnId: "t1" }, { id: "group-t2", turnId: "t2" }], [{ id: "gate", turnId: "t1" }]);
		expect(entries.map(entry => entry.kind === "item" ? entry.item.id : entry.approval.id)).toEqual(["group-t1", "gate", "group-t2"]);
	});

	test("turnless approvals render at the current/latest item deterministically", () => {
		const entries = interleaveApprovals([{ id: "latest", turnId: "t1" }], [{ id: "workflow-gate" }]);
		expect(entries.map(entry => entry.kind === "item" ? entry.item.id : entry.approval.id)).toEqual(["latest", "workflow-gate"]);
	});

	test("escape layering and busy enter decisions are explicit", () => {
		expect(escapeAction({ overlayOpen: true, transientOpen: true, queuedText: "steer", running: true })).toBe("close-overlay");
		expect(escapeAction({ overlayOpen: false, transientOpen: true, queuedText: "steer", running: true })).toBe("dismiss-transient");
		expect(escapeAction({ overlayOpen: false, transientOpen: false, queuedText: "steer", running: true })).toBe("clear-queued");
		expect(escapeAction({ overlayOpen: false, transientOpen: false, queuedText: "", running: true })).toBe("interrupt");
		expect(composerSubmitMode({ connected: true, busy: true, text: " steer " })).toBe("queue");
		expect(composerSubmitMode({ connected: true, busy: false, text: " hi " })).toBe("send");
		expect(composerSubmitMode({ connected: false, busy: false, text: " hi " })).toBe("ignore");
	});

	test("roving list index wraps with arrow keys and clamps when rows change", () => {
		expect(nextRovingIndex(0, "ArrowUp", 3)).toBe(2);
		expect(nextRovingIndex(2, "ArrowDown", 3)).toBe(0);
		expect(nextRovingIndex(1, "Home", 3)).toBe(0);
		expect(nextRovingIndex(1, "End", 3)).toBe(2);
		expect(clampRovingIndex(4, 3)).toBe(2);
		expect(clampRovingIndex(0, 0)).toBe(-1);
	});
});

	test("session move runs dryRun then confirmed execute payloads", async () => {
		const calls: unknown[] = [];
		const dryRun = { dryRun: true as const, sourceSessionFile: "/old/session.json", targetSessionFile: "/new/session.json", artifactsDirs: ["/old/artifacts"], crossDevice: false, conflicts: [] };
		const client = { gjcSessionMove: async (params: { threadId: string; targetCwd: string; dryRun?: boolean }) => { calls.push(params); return params.dryRun ? dryRun : { dryRun: false as const, movedTo: params.targetCwd, sessionPath: "/new/session.json" }; } };
		expect(sessionMovePayload("thread-1", "/new", true)).toEqual({ threadId: "thread-1", targetCwd: "/new", dryRun: true });
		const state = await dryRunSessionMove(client as { gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun: true }): Promise<typeof dryRun> }, "thread-1", "/new");
		expect(state?.plan).toEqual(dryRun);
		const result = await executeSessionMove(client as { gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun?: false }): Promise<{ dryRun: false; movedTo: string; sessionPath: string }> }, state);
		expect(result).toEqual({ dryRun: false, movedTo: "/new", sessionPath: "/new/session.json" });
		expect(calls).toEqual([{ threadId: "thread-1", targetCwd: "/new", dryRun: true }, { threadId: "thread-1", targetCwd: "/new", dryRun: false }]);
	});
