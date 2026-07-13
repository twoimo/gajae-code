import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RpcWorkflowGate } from "@gajae-code/coding-agent/modes/shared/agent-wire/protocol";
import {
	FileGateStore,
	type GateAuditEvent,
	MemoryGateStore,
	WorkflowGateBroker,
	WorkflowGateBrokerError,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

function makeBroker(
	extra: { audit?: (e: GateAuditEvent) => void; advance?: (g: RpcWorkflowGate, a: unknown) => void } = {},
) {
	const emitted: RpcWorkflowGate[] = [];
	const audit: GateAuditEvent[] = [];
	const advanced: Array<{ gate: RpcWorkflowGate; answer: unknown }> = [];
	const broker = new WorkflowGateBroker("2026-06-05-0449-4845", new MemoryGateStore(), {
		emit: g => emitted.push(g),
		advance: (g, a) => {
			advanced.push({ gate: g, answer: a });
			extra.advance?.(g, a);
		},
		audit: e => {
			audit.push(e);
			extra.audit?.(e);
		},
	});
	return { broker, emitted, audit, advanced };
}

describe("WorkflowGateBroker", () => {
	it("emits run-scoped monotonic gate ids per stage", () => {
		const { broker, emitted } = makeBroker();
		const g1 = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["a", "b"] } });
		const g2 = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["a", "b"] } });
		expect(g1.gate_id).toBe("wg_04494845_ralplan_000001");
		expect(g2.gate_id).toBe("wg_04494845_ralplan_000002");
		expect(emitted).toHaveLength(2);
		expect(g1.schema_hash).toBeTruthy();
		expect(g1.required).toBe(true);
	});

	it("rejects reserved/unknown stages", () => {
		const { broker } = makeBroker();
		expect(() => broker.openGate({ stage: "team" as never, kind: "question", schema: { type: "string" } })).toThrow(
			WorkflowGateBrokerError,
		);
	});

	it("accepts a valid answer, persists before advancing exactly once", async () => {
		const { broker, advanced, audit } = makeBroker();
		const gate = broker.openGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: ["approve"] },
		});
		const res = await broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		expect(res.status).toBe("accepted");
		expect(advanced).toHaveLength(1);
		expect(audit.some(e => e.event === "gate_response_accepted")).toBe(true);
	});

	it("preserves acknowledgement policy updates made before advance", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-ack-policy-"));
		const file = path.join(dir, "gates.json");
		const store = new FileGateStore(file);
		let broker: WorkflowGateBroker;
		broker = new WorkflowGateBroker("run-ack-policy", store, {
			finalizeAccepted: async record => {
				if (record.ackPolicy?.kind !== "telegram_selected_v1") throw new Error("missing Telegram policy");
				broker.updateAckPolicy(record.gate.gate_id, {
					...record.ackPolicy,
					state: "delivered",
					outcome: { status: "delivered", messageId: 42 },
					updatedAt: "terminal",
				});
			},
		});
		const gate = broker.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		await broker.resolve(
			{ gate_id: gate.gate_id, answer: "yes" },
			{
				semanticDisposition: "commit",
				resolutionOrigin: { kind: "telegram_notification", interactionActionId: "interaction-1" },
				ackPolicy: {
					kind: "telegram_selected_v1",
					commitKey: "commit-1",
					actionId: "interaction-1",
					state: "pending",
					updatedAt: "pending",
				},
			},
		);
		expect(store.get(gate.gate_id)).toMatchObject({
			advanced: true,
			ackPolicy: {
				kind: "telegram_selected_v1",
				state: "delivered",
				outcome: { status: "delivered", messageId: 42 },
			},
		});
		const reopened = new FileGateStore(file).get(gate.gate_id);
		expect(reopened).toMatchObject({
			status: "accepted",
			advanced: true,
			answer: "yes",
			semanticDisposition: "commit",
			resolutionOrigin: { kind: "telegram_notification", interactionActionId: "interaction-1" },
			resolution: { gate_id: gate.gate_id, status: "accepted" },
			ackPolicy: {
				kind: "telegram_selected_v1",
				commitKey: "commit-1",
				actionId: "interaction-1",
				state: "delivered",
				outcome: { status: "delivered", messageId: 42 },
			},
		});
	});

	it("leaves the gate pending on an invalid answer", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: ["approve"] },
		});
		const res = await broker.resolve({ gate_id: gate.gate_id, answer: "nope" });
		expect(res.status).toBe("rejected");
		expect(res.error?.code).toBe("invalid_workflow_gate_answer");
		expect(advanced).toHaveLength(0);
		// Gate still pending → a subsequent valid answer is accepted.
		const ok = await broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		expect(ok.status).toBe("accepted");
	});

	it("is idempotent on replay and detects conflicts", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate({ stage: "ultragoal", kind: "execution", schema: { type: "boolean" } });
		const first = await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "k1" });
		const replay = await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "k1" });
		expect(replay).toEqual(first);
		expect(advanced).toHaveLength(1); // exactly once
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: false, idempotency_key: "k1" })).rejects.toThrow(
			/idempotency_conflict|conflict/,
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toThrow(
			/already_resolved|resolved/,
		);
	});

	it("completes advance before returning an idempotent replay after a crash", async () => {
		const store = new MemoryGateStore();
		let advances = 0;
		const broker = new WorkflowGateBroker("run-replay-advance", store, {
			advance: () => {
				advances++;
			},
		});
		const gate = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		const response = { gate_id: gate.gate_id, answer: "approve", idempotency_key: "replay-key" };

		await expect(
			broker.resolve(response, {
				beforeAdvance: async () => {
					throw new Error("simulated crash before advance");
				},
			}),
		).rejects.toThrow(/crash/);
		const cachedResolution = store.get(gate.gate_id)?.resolution;
		expect(store.get(gate.gate_id)).toMatchObject({ status: "accepted", advanced: false });
		if (!cachedResolution) throw new Error("accepted gate must retain a resolution before replay");

		const replay = await broker.resolve(response);
		expect(replay).toEqual(cachedResolution);
		expect(store.get(gate.gate_id)).toMatchObject({ status: "accepted", advanced: true });
		expect(advances).toBe(1);

		await expect(broker.resolve(response)).resolves.toEqual(replay);
		expect(advances).toBe(1);
	});

	it("audits failed emission while preserving the pending gate for a later answer", async () => {
		const store = new MemoryGateStore();
		const audit: GateAuditEvent[] = [];
		const broker = new WorkflowGateBroker("run-emit-failed", store, {
			emit: () => {
				throw new Error("emit unavailable");
			},
			audit: event => audit.push(event),
		});

		expect(() => broker.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } })).toThrow(
			/emit unavailable/,
		);
		const [persisted] = store.list();
		expect(persisted).toMatchObject({ status: "pending", advanced: false });
		expect(audit).toEqual([
			{
				event: "gate_emit_failed",
				gate_id: persisted?.gate.gate_id,
				stage: "deep-interview",
				kind: "question",
			},
		]);

		await expect(broker.resolve({ gate_id: persisted?.gate.gate_id ?? "", answer: "answer" })).resolves.toMatchObject(
			{
				status: "accepted",
			},
		);
	});

	it("throws on unknown gate ids", async () => {
		const { broker } = makeBroker();
		await expect(broker.resolve({ gate_id: "wg_x_ralplan_000099", answer: 1 })).rejects.toThrow(
			WorkflowGateBrokerError,
		);
	});

	it("persists durably across broker instances with FileGateStore", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-store-"));
		const file = path.join(dir, "gates.json");
		const b1 = new WorkflowGateBroker("run-xyz", new FileGateStore(file));
		const gate = b1.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		// New broker instance, same backing file → sees the pending gate.
		const b2 = new WorkflowGateBroker("run-xyz", new FileGateStore(file));
		const res = await b2.resolve({ gate_id: gate.gate_id, answer: "an answer" });
		expect(res.status).toBe("accepted");
	});

	it("serializes live resolution with recovery so advance runs after finalization exactly once", async () => {
		const store = new MemoryGateStore();
		const finalizationStarted = Promise.withResolvers<void>();
		const releaseFinalization = Promise.withResolvers<void>();
		let advances = 0;
		const broker = new WorkflowGateBroker("run-concurrent-recovery", store, {
			finalizeAccepted: async () => {
				finalizationStarted.resolve();
				await releaseFinalization.promise;
			},
			advance: () => {
				advances++;
			},
		});
		const gate = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		const resolving = broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		await finalizationStarted.promise;
		const recovering = broker.recover();
		await Promise.resolve();
		expect(advances).toBe(0);
		releaseFinalization.resolve();
		await expect(resolving).resolves.toMatchObject({ status: "accepted" });
		await expect(recovering).resolves.toEqual([]);
		expect(advances).toBe(1);
	});

	it("recover() advances accepted-but-not-advanced gates exactly once", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-recover-"));
		const file = path.join(dir, "gates.json");
		// First broker: advance throws AFTER the durable accept write, simulating a
		// crash between accept and the advanced:true commit.
		const store1 = new FileGateStore(file);
		const b1 = new WorkflowGateBroker("run-rec", store1, {
			advance: () => {
				throw new Error("simulated crash during advance");
			},
		});
		const gate = b1.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["go"] } });
		await expect(b1.resolve({ gate_id: gate.gate_id, answer: "go" })).rejects.toThrow(/crash/);

		// Fresh broker over the same file recovers exactly once.
		let advances = 0;
		const b2 = new WorkflowGateBroker("run-rec", new FileGateStore(file), {
			advance: () => {
				advances += 1;
			},
		});
		const recovered = await b2.recover();
		expect(recovered).toEqual([gate.gate_id]);
		expect(advances).toBe(1);
		// A second recover() is a no-op (already advanced).
		expect(await b2.recover()).toEqual([]);
		expect(advances).toBe(1);
	});

	async function writeAcceptedUnadvancedState(file: string): Promise<string> {
		const broker = new WorkflowGateBroker("run-fixture", new FileGateStore(file), {
			advance: () => {
				throw new Error("simulated crash during advance");
			},
		});
		const gate = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: "approve" })).rejects.toThrow(/crash/);
		return gate.gate_id;
	}

	function tamperState(file: string, mutate: (state: Record<string, unknown>) => void): void {
		const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		mutate(state);
		writeFileSync(file, JSON.stringify(state));
	}

	it("quarantines accepted records missing their durable resolution", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-accepted-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			delete (state.gates as Record<string, Record<string, unknown>>)[gateId]?.resolution;
		});

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("quarantines an unadvanced accepted answer that no longer matches its hashes", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-answer-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			(state.gates as Record<string, Record<string, unknown>>)[gateId]!.answer = "tampered answer";
		});

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("quarantines a gate whose stored schema_hash does not match its schema", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-schema-hash-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			const gate = (state.gates as Record<string, Record<string, Record<string, unknown>>>)[gateId]!.gate;
			gate.schema_hash = "not-the-real-hash";
		});

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("quarantines a gate missing required protocol fields", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-fields-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			const gate = (state.gates as Record<string, Record<string, Record<string, unknown>>>)[gateId]!.gate;
			delete gate.created_at;
			delete gate.required;
		});

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("quarantines a record carrying a malformed ackPolicy union", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-ack-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			(state.gates as Record<string, Record<string, unknown>>)[gateId]!.ackPolicy = { kind: "bogus" };
		});

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("quarantines a gate advertising malformed options or non-literal required", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-options-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			const gate = (state.gates as Record<string, Record<string, Record<string, unknown>>>)[gateId]!.gate;
			gate.options = [{ value: "a" }];
		});
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		unlinkSync(`${file}.corrupt.lock`);

		const gateId2 = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			const gate = (state.gates as Record<string, Record<string, Record<string, unknown>>>)[gateId2]!.gate;
			gate.required = false;
		});
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("quarantines a telegram ack policy missing updatedAt or carrying a malformed outcome", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-ack-fields-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			(state.gates as Record<string, Record<string, unknown>>)[gateId]!.ackPolicy = {
				kind: "telegram_selected_v1",
				commitKey: "commit",
				actionId: "action",
				state: "pending",
			};
		});
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		unlinkSync(`${file}.corrupt.lock`);

		const gateId2 = await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			(state.gates as Record<string, Record<string, unknown>>)[gateId2]!.ackPolicy = {
				kind: "telegram_selected_v1",
				commitKey: "commit",
				actionId: "action",
				state: "delivered",
				updatedAt: "now",
				outcome: { status: "delivered" },
			};
		});
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("quarantines state whose counter could reuse a persisted gate id", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-counter-"));
		const file = path.join(dir, "gates.json");
		await writeAcceptedUnadvancedState(file);
		tamperState(file, state => {
			(state.counters as Record<string, number>).ralplan = 0;
		});

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(existsSync(`${file}.corrupt.lock`)).toBe(true);
	});

	it("keeps a corrupt FileGateStore locked until its marker is manually removed", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-lock-"));
		const file = path.join(dir, "gates.json");
		const marker = `${file}.corrupt.lock`;
		writeFileSync(file, "{ not valid json");

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
			quarantinedPath: expect.stringContaining(`${file}.corrupt-`),
			reason: expect.any(String),
		});
		expect(() => new FileGateStore(file)).toThrow(/quarantine marker.*manually remove/);

		unlinkSync(marker);
		expect(new FileGateStore(file).list()).toEqual([]);
	});

	it("loads a structurally valid persisted gate state", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-valid-state-"));
		const file = path.join(dir, "gates.json");
		const gateId = await writeAcceptedUnadvancedState(file);
		const pendingGateId = new WorkflowGateBroker("run-fixture", new FileGateStore(file), {}).openGate({
			stage: "deep-interview",
			kind: "question",
			schema: { type: "string" },
		}).gate_id;

		const reopened = new FileGateStore(file);
		expect(reopened.get(gateId)).toMatchObject({ status: "accepted", advanced: false });
		expect(reopened.get(pendingGateId)).toMatchObject({ status: "pending", advanced: false });
		expect(existsSync(`${file}.corrupt.lock`)).toBe(false);
	});

	it("quarantines structurally corrupt FileGateStore state", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-shape-"));
		const file = path.join(dir, "gates.json");
		writeFileSync(
			file,
			JSON.stringify({
				counters: { ralplan: -1 },
				gates: {
					wg_wrong_ralplan_000001: {
						gate: { gate_id: "wg_different_ralplan_000001" },
						status: "invalid",
						advanced: "false",
					},
				},
			}),
		);

		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
		expect(readdirSync(dir).some(name => name.startsWith("gates.json.corrupt-"))).toBe(true);
	});

	it("fails closed on a corrupt FileGateStore instead of silently resetting", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-"));
		const file = path.join(dir, "gates.json");
		writeFileSync(file, "{ not valid json");
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
	});
});
