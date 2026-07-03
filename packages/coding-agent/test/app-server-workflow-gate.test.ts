import { describe, expect, it } from "bun:test";
import { AgentSessionHost } from "../src/modes/app-server/agent-session-host";
import { startAppServer } from "../src/modes/app-server/host";
import type { WorkflowGateEmitter } from "../src/modes/shared/agent-wire/unattended-session";
import type { OpenGateInput } from "../src/modes/shared/agent-wire/workflow-gate-broker";
import { schemaHash } from "../src/modes/shared/agent-wire/workflow-gate-schema";
import type { RpcWorkflowGate } from "../src/modes/shared/agent-wire/workflow-gate-types";
import type { AgentSessionEvent } from "../src/session/agent-session";

class FakeSession {
	readonly sessionId = "thr_workflow_gate";
	emitter: WorkflowGateEmitter | undefined;
	subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	async steer(): Promise<void> {}
	async abort(): Promise<void> {}
	async executeBash(): Promise<unknown> {
		return {};
	}
	dispose(): void {}
	setWorkflowGateEmitter(emitter: WorkflowGateEmitter | undefined): void {
		this.emitter = emitter;
	}
}

async function init(handle: ReturnType<typeof startAppServer>): Promise<string> {
	const conn = handle.openConnection();
	await handle.dispatch(conn, JSON.stringify({ id: 0, method: "initialize", params: {} }));
	await handle.dispatch(conn, JSON.stringify({ method: "initialized" }));
	return conn;
}

async function request(
	handle: ReturnType<typeof startAppServer>,
	conn: string,
	id: number,
	method: string,
	params: unknown,
) {
	const raw = await handle.dispatch(conn, JSON.stringify({ id, method, params }));
	expect(raw).toBeString();
	return JSON.parse(raw as string);
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
	for (let i = 0; i < 100; i += 1) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for condition");
}

const gateInput: OpenGateInput = {
	stage: "ralplan",
	kind: "approval",
	schema: {
		type: "object",
		required: ["decision"],
		properties: { decision: { type: "string", enum: ["approve", "request-changes"] } },
		additionalProperties: false,
	},
	context: { title: "Approve plan?", summary: "plan" },
};

describe("app-server workflow gate wire", () => {
	it("opens, lists, validates, resolves, and enforces idempotency over JSON-RPC", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const frames: Array<Record<string, any>> = [];
		const handle = startAppServer(host, { onFrame: frame => frames.push(JSON.parse(frame)) });
		const conn = await init(handle);
		const start = await request(handle, conn, 1, "thread/start", { cwd: "/repo" });
		const threadId = start.result.thread.id as string;
		expect(threadId).toBe("thr_workflow_gate");
		expect(session.emitter).toBeDefined();
		expect(session.emitter?.isUnattended()).toBe(true);

		const answerPromise = session.emitter!.emitGate(gateInput);
		const opened = await waitFor(() => frames.find(frame => frame.method === "gjc/workflowGate/opened"));
		const gate = opened.params as RpcWorkflowGate & { threadId: string; generation: number };
		expect(gate.threadId).toBe(threadId);
		expect(gate.generation).toBe(1);
		expect(gate.type).toBe("workflow_gate");
		expect(gate.gate_id).toMatch(/^wg_flowgate_ralplan_000001$/);
		expect(gate.stage).toBe("ralplan");
		expect(gate.kind).toBe("approval");
		expect(gate.schema_hash).toBe(schemaHash(gateInput.schema));
		expect(gate.context).toEqual(gateInput.context ?? {});
		expect(gate.required).toBe(true);

		const listed = await request(handle, conn, 2, "gjc/workflowGate/list", { threadId });
		expect(listed.result.gates.map((g: RpcWorkflowGate) => g.gate_id)).toEqual([gate.gate_id]);

		const reconnect = await init(handle);
		const listedAfterReconnect = await request(handle, reconnect, 3, "gjc/workflowGate/list", { threadId });
		expect(listedAfterReconnect.result.gates.map((g: RpcWorkflowGate) => g.gate_id)).toEqual([gate.gate_id]);

		const invalid = await request(handle, conn, 4, "gjc/workflowGate/respond", {
			threadId,
			gate_id: gate.gate_id,
			answer: { decision: "reject" },
		});
		expect(invalid.error).toBeUndefined();
		expect(invalid.result.status).toBe("rejected");
		expect(invalid.result.error.code).toBe("invalid_workflow_gate_answer");
		expect(invalid.result.error.gate_id).toBe(gate.gate_id);
		const stillPending = await request(handle, conn, 5, "gjc/workflowGate/list", { threadId });
		expect(stillPending.result.gates.map((g: RpcWorkflowGate) => g.gate_id)).toEqual([gate.gate_id]);

		const validAnswer = { decision: "approve" };
		const accepted = await request(handle, conn, 6, "gjc/workflowGate/respond", {
			threadId,
			gate_id: gate.gate_id,
			answer: validAnswer,
			idempotency_key: "idem-1",
		});
		expect(accepted.error).toBeUndefined();
		expect(accepted.result.status).toBe("accepted");
		await expect(answerPromise).resolves.toEqual(validAnswer);
		const afterAcceptList = await request(handle, conn, 7, "gjc/workflowGate/list", { threadId });
		expect(afterAcceptList.result.gates).toEqual([]);

		const replay = await request(handle, conn, 8, "gjc/workflowGate/respond", {
			threadId,
			gate_id: gate.gate_id,
			answer: validAnswer,
			idempotency_key: "idem-1",
		});
		expect(replay.result).toEqual(accepted.result);

		const conflict = await request(handle, conn, 9, "gjc/workflowGate/respond", {
			threadId,
			gate_id: gate.gate_id,
			answer: { decision: "request-changes" },
			idempotency_key: "idem-1",
		});
		expect(conflict.error.data).toEqual({ code: "idempotency_conflict", gate_id: gate.gate_id });

		const alreadyResolved = await request(handle, conn, 10, "gjc/workflowGate/respond", {
			threadId,
			gate_id: gate.gate_id,
			answer: validAnswer,
		});
		expect(alreadyResolved.error.data).toEqual({ code: "already_resolved", gate_id: gate.gate_id });

		const unknown = await request(handle, conn, 11, "gjc/workflowGate/respond", {
			threadId,
			gate_id: "wg_missing",
			answer: validAnswer,
		});
		expect(unknown.error.data).toEqual({ code: "unknown_gate", gate_id: "wg_missing" });

		const schema = JSON.parse(handle.server.schemaJson());
		expect(schema.definitions.RpcWorkflowGate).toBeDefined();
		expect(schema.definitions.WorkflowGateOpenedParams).toBeDefined();
	});
});
