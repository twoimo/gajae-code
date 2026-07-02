import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { type AppServerHost, type CreatedThread, startAppServer } from "../src/modes/app-server/host";
import { AppServerNotificationEndpoint } from "../src/notifications/app-server-endpoint";

// Token-free Phase 7 proof: a WS subscriber (a fake chat adapter) talks to the
// real native AppServer over its loopback WS transport, driving the
// gjc/notifications action lifecycle through AppServerNotificationEndpoint.

type Json = Record<string, unknown>;

class NotifHost implements AppServerHost {
	constructor(private readonly endpoint: AppServerNotificationEndpoint) {}
	async createThread(): Promise<CreatedThread> {
		return { threadId: `thr_${randomUUID()}`, sessionMetadata: {} };
	}
	resumeThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	forkThread(): Promise<CreatedThread> {
		return this.createThread();
	}
	async backendCall(): Promise<unknown> {
		return {};
	}
	async notificationCall(method: string, params: unknown): Promise<unknown> {
		return this.endpoint.handleNotificationCall(method, params);
	}
}

function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.once("open", () => resolve(ws));
		ws.once("error", reject);
	});
}

function waitForEvent(frames: Json[], predicate: (f: Json) => boolean, timeoutMs = 3000): Promise<Json> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			const hit = frames.find(predicate);
			if (hit) return resolve(hit);
			if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for frame"));
			setTimeout(tick, 15);
		};
		tick();
	});
}

describe("gjc/notifications over the app-server WS transport", () => {
	it("delivers action_needed and resolves a client reply end-to-end", async () => {
		const replies: Array<{ id: string; answerJson: string }> = [];
		const endpoint = new AppServerNotificationEndpoint({
			sessionId: "sess-int",
			pushNotification: () => {}, // replaced below with the real handle push
		});
		const host = new NotifHost(endpoint);
		const handle = startAppServer(host, { onFrame: () => {} });
		// Wire outbound frames through the real native push.
		(endpoint as unknown as { pushNotification: (f: unknown) => void }).pushNotification = (f: unknown) =>
			handle.pushNotification(f);
		endpoint.onReply((_err, reply) => {
			if (!reply) return;
			replies.push({ id: reply.id, answerJson: reply.answerJson });
			// Mirror the real consumer (notifications/index.ts): resolve the ask,
			// which emits action_resolved{resolvedBy:"client"}.
			endpoint.resolveClient(reply.id, reply.answerJson, reply.idempotencyKey);
		});

		const url = await handle.server.listenWs("127.0.0.1", 0, "tok", `sess-${randomUUID()}`, undefined);
		const ws = await connect(`${url}/?token=tok`);
		const frames: Json[] = [];
		const events: Json[] = [];
		ws.on("message", data => {
			const msg = JSON.parse(data.toString()) as Json;
			frames.push(msg);
			if (msg.method === "gjc/notifications/event") events.push(msg.params as Json);
		});

		try {
			ws.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
			ws.send(JSON.stringify({ method: "initialized" }));
			await new Promise(r => setTimeout(r, 100));

			// Subscribe to the notifications channel.
			ws.send(JSON.stringify({ id: 2, method: "gjc/notifications/subscribe", params: {} }));
			await waitForEvent(frames, f => f.id === 2 && (f.result as Json)?.ok === true);

			// The session raises an ask.
			endpoint.registerAsk(
				JSON.stringify({
					id: "ask1",
					kind: "ask",
					sessionId: "sess-int",
					question: "Proceed?",
					options: ["Yes", "No"],
				}),
				true,
			);
			const actionNeeded = await waitForEvent(events, e => e.type === "action_needed" && e.id === "ask1");
			expect(actionNeeded.question).toBe("Proceed?");
			expect(actionNeeded.options).toEqual(["Yes", "No"]);

			// The remote client replies.
			ws.send(JSON.stringify({ method: "gjc/notifications/reply", params: { id: "ask1", answer: 0 } }));
			const resolved = await waitForEvent(events, e => e.type === "action_resolved" && e.id === "ask1");
			expect(resolved.resolvedBy).toBe("client");
			expect(replies).toEqual([{ id: "ask1", answerJson: "0" }]);
		} finally {
			ws.close();
		}
	});

	it("does not deliver gjc/notifications/event to an unsubscribed connection", async () => {
		const endpoint = new AppServerNotificationEndpoint({ sessionId: "sess-neg", pushNotification: () => {} });
		const host = new NotifHost(endpoint);
		const handle = startAppServer(host, { onFrame: () => {} });
		(endpoint as unknown as { pushNotification: (f: unknown) => void }).pushNotification = (f: unknown) =>
			handle.pushNotification(f);

		const url = await handle.server.listenWs("127.0.0.1", 0, "tok", `sess-${randomUUID()}`, undefined);

		// Two clients: one subscribes, one does NOT.
		const subbed = await connect(`${url}/?token=tok`);
		const unsubbed = await connect(`${url}/?token=tok`);
		const subEvents: Json[] = [];
		const unsubEvents: Json[] = [];
		subbed.on("message", d => {
			const m = JSON.parse(d.toString()) as Json;
			if (m.method === "gjc/notifications/event") subEvents.push(m.params as Json);
		});
		unsubbed.on("message", d => {
			const m = JSON.parse(d.toString()) as Json;
			if (m.method === "gjc/notifications/event") unsubEvents.push(m.params as Json);
		});
		try {
			for (const ws of [subbed, unsubbed]) {
				ws.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
				ws.send(JSON.stringify({ method: "initialized" }));
			}
			await new Promise(r => setTimeout(r, 100));
			// Only `subbed` opts in.
			subbed.send(JSON.stringify({ id: 2, method: "gjc/notifications/subscribe", params: {} }));
			await new Promise(r => setTimeout(r, 100));

			endpoint.registerAsk(
				JSON.stringify({ id: "ask-neg", kind: "ask", sessionId: "sess-neg", question: "Q" }),
				true,
			);
			await waitForEvent(subEvents, e => e.type === "action_needed" && e.id === "ask-neg");
			// Give the unsubscribed client ample time; it must receive nothing.
			await new Promise(r => setTimeout(r, 150));
			expect(unsubEvents).toEqual([]);
		} finally {
			subbed.close();
			unsubbed.close();
		}
	});
});
