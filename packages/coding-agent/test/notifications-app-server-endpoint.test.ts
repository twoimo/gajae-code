import { describe, expect, test } from "bun:test";
import { AppServerNotificationEndpoint } from "../src/notifications/app-server-endpoint";

function fakeEndpoint() {
	const frames: unknown[] = [];
	const endpoint = new AppServerNotificationEndpoint({
		sessionId: "session-1",
		pushNotification: frame => frames.push(frame),
	});
	return {
		endpoint,
		frames,
		notificationCall: (method: string, params: unknown) => endpoint.handleNotificationCall(method, params),
	};
}

describe("AppServerNotificationEndpoint", () => {
	test("registerAsk pushes action_needed with id, question, and options", () => {
		const { endpoint, frames } = fakeEndpoint();

		endpoint.registerAsk(
			JSON.stringify({
				id: "ask-1",
				kind: "ask",
				sessionId: "session-1",
				question: "Continue?",
				options: ["Yes", "No"],
			}),
			true,
		);

		expect(frames).toEqual([
			{
				type: "action_needed",
				id: "ask-1",
				kind: "ask",
				sessionId: "session-1",
				question: "Continue?",
				options: ["Yes", "No"],
			},
		]);
	});

	test("reply fires onReply and resolveClient pushes client action_resolved", () => {
		const { endpoint, frames, notificationCall } = fakeEndpoint();
		const replies: unknown[] = [];
		endpoint.onReply((err, reply) => replies.push({ err, reply }));
		endpoint.registerAsk(
			JSON.stringify({ id: "ask-1", kind: "ask", sessionId: "session-1", question: "Continue?", options: ["Yes"] }),
			true,
		);

		expect(notificationCall("gjc/notifications/reply", { id: "ask-1", answer: "Yes" })).toEqual({ ok: true });
		expect(replies).toEqual([{ err: null, reply: { id: "ask-1", answerJson: "Yes", idempotencyKey: undefined } }]);

		endpoint.resolveClient("ask-1", "Yes");
		expect(frames.at(-1)).toEqual({ type: "action_resolved", id: "ask-1", resolvedBy: "client" });
	});

	test("resolveLocal pushes local action_resolved and later reply is rejected", () => {
		const { endpoint, frames, notificationCall } = fakeEndpoint();
		endpoint.registerAsk(
			JSON.stringify({ id: "ask-1", kind: "ask", sessionId: "session-1", question: "Continue?", options: ["Yes"] }),
			true,
		);

		endpoint.resolveLocal("ask-1");
		expect(frames.at(-1)).toEqual({ type: "action_resolved", id: "ask-1", resolvedBy: "local" });

		expect(notificationCall("gjc/notifications/reply", { id: "ask-1", answer: "Yes" })).toEqual({
			rejected: "already_answered",
		});
		expect(frames.at(-1)).toEqual({ type: "reply_rejected", id: "ask-1", reason: "already_answered" });
	});

	test("idempotency same key and body re-acks, different body conflicts", () => {
		const { endpoint, frames, notificationCall } = fakeEndpoint();
		endpoint.registerAsk(
			JSON.stringify({
				id: "ask-1",
				kind: "ask",
				sessionId: "session-1",
				question: "Continue?",
				options: ["Yes", "No"],
			}),
			true,
		);

		expect(
			notificationCall("gjc/notifications/reply", { id: "ask-1", answer: "Yes", idempotencyKey: "key-1" }),
		).toEqual({ ok: true });
		endpoint.resolveClient("ask-1", "Yes", "key-1");
		const frameCountAfterResolve = frames.length;

		expect(
			notificationCall("gjc/notifications/reply", { id: "ask-1", answer: "Yes", idempotencyKey: "key-1" }),
		).toEqual({ ok: true });
		expect(frames).toHaveLength(frameCountAfterResolve);

		expect(
			notificationCall("gjc/notifications/reply", { id: "ask-1", answer: "No", idempotencyKey: "key-1" }),
		).toEqual({ rejected: "idempotency_conflict" });
		expect(frames.at(-1)).toEqual({ type: "reply_rejected", id: "ask-1", reason: "idempotency_conflict" });
	});

	test("userMessage and configCommand return ok", () => {
		const { notificationCall } = fakeEndpoint();

		expect(notificationCall("gjc/notifications/userMessage", { text: "hello" })).toEqual({ ok: true });
		expect(notificationCall("gjc/notifications/configCommand", { command: { verbosity: "lean" } })).toEqual({
			ok: true,
		});
	});

	test("ping returns pong and subscribe returns replay frames", () => {
		const { endpoint, notificationCall } = fakeEndpoint();
		endpoint.registerAsk(
			JSON.stringify({ id: "ask-1", kind: "ask", sessionId: "session-1", question: "Continue?", options: [] }),
			true,
		);

		expect(notificationCall("gjc/notifications/ping", {})).toEqual({ pong: true });
		expect(notificationCall("gjc/notifications/subscribe", {})).toEqual([
			{
				type: "action_needed",
				id: "ask-1",
				kind: "ask",
				sessionId: "session-1",
				question: "Continue?",
				options: [],
			},
		]);
	});

	test("latches acceptance at first reply: a duplicate before resolve is already_answered", () => {
		const { endpoint, notificationCall } = fakeEndpoint();
		const replies: string[] = [];
		endpoint.onReply((_e, r) => {
			if (r) replies.push(r.answerJson);
		});
		endpoint.registerAsk(JSON.stringify({ id: "ask-1", kind: "ask", sessionId: "session-1", question: "Q" }), true);

		// First reply is accepted and forwarded once.
		expect(notificationCall("gjc/notifications/reply", { id: "ask-1", answer: 0 })).toEqual({ ok: true });
		// A second reply BEFORE the async consumer calls resolveClient must not
		// forward again.
		expect(notificationCall("gjc/notifications/reply", { id: "ask-1", answer: 1 })).toEqual({
			rejected: "already_answered",
		});
		expect(replies).toEqual(["0"]);
	});

	test("tombstones a resolved ask so subscribe no longer replays it", () => {
		const { endpoint, notificationCall } = fakeEndpoint();
		endpoint.registerAsk(JSON.stringify({ id: "ask-1", kind: "ask", sessionId: "session-1", question: "Q" }), true);
		expect((notificationCall("gjc/notifications/subscribe", {}) as unknown[]).length).toBe(1);

		endpoint.resolveClient("ask-1", "0");
		// After resolution the sticky action_needed is gone from replay.
		expect(notificationCall("gjc/notifications/subscribe", {})).toEqual([]);
	});
});
