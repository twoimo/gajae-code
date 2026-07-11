import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcWorkflowGate } from "../src/modes/rpc/rpc-types";
import { createNotificationsExtension } from "../src/notifications/index";
import { getAskAnswerSource, notifyWorkflowGateEmitterChanged } from "../src/tools/ask-answer-registry";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function startInteractiveNotifications() {
	const previous = process.env.GJC_NOTIFICATIONS;
	process.env.GJC_NOTIFICATIONS = "1";
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
		sendUserMessage: () => {},
	} as never;
	createNotificationsExtension(api);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-selected-ack-"));
	tempDirs.push(cwd);
	const sessionId = `ack-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "Selected ack",
			getArtifactsDir: () => cwd,
			getCwd: () => cwd,
		},
	} as never;
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
	const endpointPath = path.join(cwd, ".gjc", "state", "notifications", `${sessionId}.json`);
	const endpoint = await waitFor(() => {
		try {
			return JSON.parse(fs.readFileSync(endpointPath, "utf8")) as { url: string; token: string };
		} catch {
			return undefined;
		}
	}, "notification endpoint");
	return {
		handlers,
		ctx,
		sessionId,
		endpoint,
		restore: async () => {
			await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
			if (previous === undefined) delete process.env.GJC_NOTIFICATIONS;
			else process.env.GJC_NOTIFICATIONS = previous;
		},
	};
}

function socketMessages(ws: WebSocket): {
	next(type: string): Promise<Record<string, unknown>>;
	all: Record<string, unknown>[];
} {
	const all: Record<string, unknown>[] = [];
	ws.addEventListener("message", event => {
		all.push(JSON.parse(String(event.data)) as Record<string, unknown>);
	});
	return {
		all,
		next: type =>
			waitFor(() => {
				const index = all.findIndex(message => message.type === type);
				if (index < 0) return undefined;
				return all.splice(index, 1)[0];
			}, type),
	};
}

test("interactive notification settlement awaits Selected result before action resolution", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		ws.send(
			JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				capabilities: ["ask_controls_v1", "ask_selected_ack_v1"],
			}),
		);

		const source = getAskAnswerSource(harness.sessionId);
		expect(source).toBeDefined();
		const answerPromise = source!.awaitAnswerRequest!(
			{ question: "Proceed?", options: ["yes", "no"], interaction: "selector", controls: [] },
			undefined,
		);
		const action = await messages.next("action_needed");
		ws.send(
			JSON.stringify({
				type: "reply",
				id: action.id,
				answer: 0,
				token: harness.endpoint.token,
				idempotencyKey: "answer-1",
			}),
		);
		const receipt = await answerPromise;
		expect(receipt && typeof receipt !== "string" ? receipt.interaction : undefined).toEqual({
			kind: "value",
			value: "yes",
		});
		if (!receipt || typeof receipt === "string") throw new Error("expected typed receipt");
		let settled = false;
		const settlement = receipt.settle({ kind: "commit" }).then(result => {
			settled = true;
			return result;
		});
		const ackRequest = await messages.next("ask_selected_ack_request");
		expect(settled).toBe(false);
		expect(ackRequest).toMatchObject({ mode: "live", actionId: action.id });
		expect(messages.all.some(message => message.type === "action_resolved")).toBe(false);
		ws.send(
			JSON.stringify({
				type: "ask_selected_ack_result",
				requestId: ackRequest.requestId,
				commitKey: ackRequest.commitKey,
				outcome: { status: "delivered", messageId: 77 },
			}),
		);
		expect(await settlement).toEqual({ kind: "committed", ack: { status: "delivered", messageId: 77 } });
		expect(await messages.next("action_resolved")).toMatchObject({ id: action.id, resolvedBy: "client" });
		ws.close();
	} finally {
		await harness.restore();
	}
}, 20_000);

test("unsupported acknowledgement capability fails open without losing the accepted answer", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		const source = getAskAnswerSource(harness.sessionId)!;
		const answerPromise = source.awaitAnswerRequest!(
			{ question: "Proceed?", options: ["yes"], interaction: "selector", controls: [] },
			undefined,
		);
		const action = await messages.next("action_needed");
		ws.send(JSON.stringify({ type: "reply", id: action.id, answer: 0, token: harness.endpoint.token }));
		const receipt = await answerPromise;
		if (!receipt || typeof receipt === "string") throw new Error("expected typed receipt");
		expect(await receipt.settle({ kind: "commit" })).toEqual({
			kind: "committed",
			ack: { status: "failed", reason: "unsupported" },
		});
		expect(await messages.next("action_resolved")).toMatchObject({ id: action.id });
		expect(messages.all.some(message => message.type === "ask_selected_ack_request")).toBe(false);
		ws.close();
	} finally {
		await harness.restore();
	}
}, 20_000);

test("invalid interactive replies close the old claim and reissue a fresh action", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		const source = getAskAnswerSource(harness.sessionId)!;
		const answerPromise = source.awaitAnswerRequest!(
			{ question: "Proceed?", options: ["yes"], interaction: "selector", controls: [] },
			undefined,
		);
		const first = await messages.next("action_needed");
		ws.send(JSON.stringify({ type: "reply", id: first.id, answer: 99, token: harness.endpoint.token }));
		expect(await messages.next("action_resolved")).toMatchObject({ id: first.id });
		const second = await messages.next("action_needed");
		expect(second.id).not.toBe(first.id);
		ws.send(JSON.stringify({ type: "reply", id: second.id, answer: 0, token: harness.endpoint.token }));
		const receipt = await answerPromise;
		if (!receipt || typeof receipt === "string") throw new Error("expected typed receipt");
		expect(receipt.interaction).toEqual({ kind: "value", value: "yes" });
		expect(await receipt.settle({ kind: "resolve_without_commit", reason: "cancelled" })).toEqual({
			kind: "resolved_without_commit",
		});
		expect(await messages.next("action_resolved")).toMatchObject({ id: second.id });
		ws.close();
	} finally {
		await harness.restore();
	}
}, 20_000);

test("attaches unattended workflow gates installed after session_start", async () => {
	const harness = await startInteractiveNotifications();
	try {
		const ws = new WebSocket(`${harness.endpoint.url}/?token=${encodeURIComponent(harness.endpoint.token)}`);
		const messages = socketMessages(ws);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
		});
		await messages.next("hello");
		let emitGate: ((gate: RpcWorkflowGate) => void) | undefined;
		let terminalRegistered = false;
		let recoveryRegistered = false;
		let unattended = false;
		const gate = {
			isUnattended: () => unattended,
			emitGate: async () => undefined,
			onGateEmitted: (listener: (value: RpcWorkflowGate) => void) => {
				emitGate = listener;
				return () => {
					emitGate = undefined;
				};
			},
			resolveGate: async () => ({ gate_id: "gate-1", status: "accepted", answer_hash: "", resolved_at: "now" }),
			registerGateTerminalController: () => {
				terminalRegistered = true;
				return () => {};
			},
			setAckRecoveryParticipant: (participant: unknown) => {
				recoveryRegistered = participant !== null;
			},
		};
		notifyWorkflowGateEmitterChanged(harness.sessionId, gate as never);
		expect(terminalRegistered).toBe(true);
		expect(recoveryRegistered).toBe(true);
		unattended = true;
		emitGate?.({
			type: "workflow_gate",
			gate_id: "gate-1",
			stage: "deep-interview",
			kind: "question",
			schema: { type: "object" },
			schema_hash: "hash",
			options: [{ value: "yes", label: "yes" }],
			context: { prompt: "Late gate?", stage_state: { multi: false, navigation_label: "Done" } },
			created_at: new Date().toISOString(),
			required: true,
		});
		expect(await messages.next("action_needed")).toMatchObject({ kind: "ask", question: "Late gate?" });
		ws.close();
	} finally {
		notifyWorkflowGateEmitterChanged(harness.sessionId, undefined);
		await harness.restore();
	}
}, 20_000);
