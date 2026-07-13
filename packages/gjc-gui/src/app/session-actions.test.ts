import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SessionActions } from "./session-actions";
import {
	cancelConfirm,
	confirmSessionAction,
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

	test("accessible action labels redact home-path titles", () => {
		const pathTitles = [
			"Fix /Users/realname/secret-project build",
			"Fix C:\\Users\\alice\\secret-project build",
			"Fix c:/users/alice/secret-project build",
		];
		for (const title of pathTitles) {
			const html = renderToString(
				createElement(SessionActions, {
					thread: { id: "thread-path", title, status: "idle", lastActivity: "idle" },
					onFork: () => undefined,
					onArchive: () => undefined,
					onDelete: () => undefined,
				}),
			);
			expect(html).not.toContain("realname");
			expect(html).not.toContain("alice");
			expect(html).toContain("Session actions for Fix ~");
		}
	});
});
