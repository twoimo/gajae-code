import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNotificationsExtension, notificationsEnabled } from "../src/notifications/index";
import { readEndpoint } from "../src/notifications/telegram-reference";

type Handler = (event: unknown, ctx: unknown) => unknown;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

test("a whitespace notifications token is absent and a generated control token is used", async () => {
	const previousNotifications = process.env.GJC_NOTIFICATIONS;
	const previousToken = process.env.GJC_NOTIFICATIONS_TOKEN;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notifications-token-"));
	const handlers = new Map<string, Handler>();
	const sessionId = `token-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Token test",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;

	try {
		delete process.env.GJC_NOTIFICATIONS;
		process.env.GJC_NOTIFICATIONS_TOKEN = " \t ";
		expect(notificationsEnabled()).toBe(false);

		process.env.GJC_NOTIFICATIONS = "1";
		createNotificationsExtension(api);
		await handlers.get("session_start")!({ type: "session_start" }, ctx);

		const endpointPath = path.join(cwd, ".gjc", "state", "notifications", `${sessionId}.json`);
		await waitFor(() => fs.existsSync(endpointPath), "notification endpoint");
		const { token } = readEndpoint(endpointPath);
		expect(token.trim()).not.toBe("");
		expect(token).not.toBe(" \t ");

		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		if (previousNotifications === undefined) delete process.env.GJC_NOTIFICATIONS;
		else process.env.GJC_NOTIFICATIONS = previousNotifications;
		if (previousToken === undefined) delete process.env.GJC_NOTIFICATIONS_TOKEN;
		else process.env.GJC_NOTIFICATIONS_TOKEN = previousToken;
	}
});
