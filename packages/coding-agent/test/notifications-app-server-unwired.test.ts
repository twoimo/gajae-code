import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension } from "../src/notifications/index";
import { getAskAnswerSource } from "../src/tools/ask-answer-registry";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

test("unwired app-server notifications refuse to start instead of registering a dropping endpoint", async () => {
	const previousNotifications = process.env.GJC_NOTIFICATIONS;
	const previousAppServer = process.env.GJC_NOTIFICATIONS_APP_SERVER;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notifications-app-server-unwired-"));
	const sessionId = `app-server-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const notifications: Array<{ message: string; level: string }> = [];
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		sendUserMessage: () => {},
	} as never;
	const ctx = {
		cwd,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Unwired app server",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;

	try {
		process.env.GJC_NOTIFICATIONS = "1";
		process.env.GJC_NOTIFICATIONS_APP_SERVER = "1";
		createNotificationsExtension(api);

		await commands.get("notify")!.handler("on", ctx);

		expect(notifications).toEqual([{ message: "Notifications failed to start for this session.", level: "error" }]);
		expect(getAskAnswerSource(sessionId)).toBeUndefined();
		expect(fs.existsSync(path.join(cwd, ".gjc", "state", "notifications", `${sessionId}.json`))).toBe(false);
		expect(handlers.get("session_start")).toBeDefined();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		if (previousNotifications === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = previousNotifications;
		if (previousAppServer === undefined) delete process.env.GJC_NOTIFICATIONS_APP_SERVER;
		else process.env.GJC_NOTIFICATIONS_APP_SERVER = previousAppServer;
	}
});
