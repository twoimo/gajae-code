import { describe, expect, test } from "bun:test";
import {
	cancelConfirm,
	confirmSessionAction,
	DEFERRED_SESSION_ACTIONS,
	markThreadArchived,
	openConfirm,
	removeThread,
} from "./session-actions-logic";
import type { ThreadView } from "./transcript";

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

	test("deferred session actions list unavailable API-backed features", () => {
		expect(DEFERRED_SESSION_ACTIONS.map(action => action.name)).toEqual([
			"Rename",
			"Move",
			"Export",
			"Tree",
			"Search",
		]);
		expect(DEFERRED_SESSION_ACTIONS.every(action => action.rationale.length > 0)).toBe(true);
	});
});
