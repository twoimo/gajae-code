#!/usr/bin/env bun
// Deterministic, replay-safe live-proof for G002 generated-client SSOT repair.
// Exercises the newly-wrapped request methods and a newly-typed server
// notification against an in-memory fake transport (no network, no clock),
// plus two adversarial cases (unknown-method notification isolation and an
// error-response frame). Prints exactly "G002_VERIFY_OK" on success.

import { AppServerClient, AppServerResponseError } from "../src/client";


type Listener = (event: { data: unknown }) => void;

class FakeSocket {
	readyState = 1;
	sent: string[] = [];
	errorMethods = new Set<string>();
	#listeners = new Map<string, Set<Listener>>();
	addEventListener(type: string, listener: Listener): void {
		(this.#listeners.get(type) ?? this.#listeners.set(type, new Set()).get(type)!).add(listener);
	}
	removeEventListener(type: string, listener: Listener): void {
		this.#listeners.get(type)?.delete(listener);
	}
	send(payload: string): void {
		this.sent.push(payload);
		const frame = JSON.parse(payload) as { id?: number; method: string };
		if (frame.id !== undefined) {
			const response = this.errorMethods.has(frame.method)
				? { id: frame.id, error: { code: -32000, message: "adversarial error frame" } }
				: { id: frame.id, result: { ok: true } };
			this.#emit("message", { data: JSON.stringify(response) });
		}
	}
	close(): void {
		this.readyState = 3;
	}
	emit(envelope: unknown): void {
		this.#emit("message", { data: JSON.stringify(envelope) });
	}
	#emit(type: string, event: { data: unknown }): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`G002 verify failed: ${message}`);
}

const socket = new FakeSocket();
const client = new AppServerClient({ webSocketFactory: () => socket });
await client.connect("ws://fake");

// Newly-typed server notification round-trips through the typed listener.
let openedGateId: string | undefined;
let genericCount = 0;
client.onNotification(() => {
	genericCount += 1;
});
client.onNotification("gjc/workflowGate/opened", params => {
	openedGateId = (params as { gate?: { gate_id?: string } }).gate?.gate_id;
});
socket.emit({
	method: "gjc/workflowGate/opened",
	params: { threadId: "t1", generation: 1, gate: { gate_id: "gate-42" } },
});
assert(openedGateId === "gate-42", "workflowGate/opened notification not typed-routed");
assert(genericCount === 1, "generic listener did not receive typed notification");

// Adversarial 1: an unknown notification method must not fire the typed
// listener but must still reach the generic listener without throwing.
socket.emit({ method: "gjc/totallyUnknownMethod", params: {} });
assert(openedGateId === "gate-42", "unknown method wrongly triggered typed listener");
assert(genericCount === 2, "generic listener did not receive unknown-method notification");

// Each newly-wrapped request sends the correct wire method.
await client.threadFork({ threadId: "t1" } as never);
await client.threadDelete({ threadId: "t1" } as never);
await client.threadArchive({ threadId: "t1" } as never);
await client.threadLoadedList({} as never);
await client.gjcHostUriSchemesSet({ threadId: "t1", schemes: [] } as never);
await client.gjcHostUrisResult({ threadId: "t1", requestId: "r1", ok: true } as never);
await client.gjcWorkflowGateList({ threadId: "t1" } as never);
await client.gjcWorkflowGateRespond({ threadId: "t1", gateId: "gate-42" } as never);

const methods = socket.sent.map(frame => (JSON.parse(frame) as { method: string }).method);
const expected = [
	"thread/fork",
	"thread/delete",
	"thread/archive",
	"thread/loaded/list",
	"gjc/hostUriSchemes/set",
	"gjc/hostUris/result",
	"gjc/workflowGate/list",
	"gjc/workflowGate/respond",
];
for (const method of expected) {
	assert(methods.includes(method), `wrapper did not send ${method}`);
}

// Adversarial 2: an error-response frame must reject the wrapper promise with
// a typed AppServerResponseError, not resolve.
const errSocket = new FakeSocket();
errSocket.errorMethods.add("thread/fork");
const errClient = new AppServerClient({ webSocketFactory: () => errSocket });
await errClient.connect("ws://fake");
let rejected = false;
try {
	await errClient.threadFork({ threadId: "t1" } as never);
} catch (error) {
	rejected = error instanceof AppServerResponseError;
}
assert(rejected, "error-response frame did not reject wrapper with AppServerResponseError");

client.close();
errClient.close();
console.log("G002_VERIFY_OK");
