/**
 * Durable workflow gate broker (#315).
 *
 * Owns gate identity and lifecycle for one run:
 *  - run-scoped, monotonic, stable gate ids
 *  - pending gate persisted BEFORE it is emitted
 *  - resolution persisted BEFORE the workflow is allowed to advance
 *  - response-body hash + idempotency-key rules (cached replay, conflict detection)
 *  - exactly-once advance + audit
 *
 * Persistence is injected via {@link GateStore}; the in-memory store is used in
 * tests, the file-backed store gives crash-durable behavior for real runs.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type {
	WorkflowGate,
	WorkflowGateContext,
	WorkflowGateKind,
	WorkflowGateOption,
	WorkflowGateResolution,
	WorkflowGateResponse,
	WorkflowStage,
} from "./workflow-gate-types";
import { RESERVED_WORKFLOW_STAGES } from "./workflow-gate-types";
import { answerHashOf, canonicalJson, compileGateSchema, schemaHash, validateGateAnswer } from "./workflow-gate-schema";

/** SDK-native surface for emitting a workflow gate and awaiting its answer. */
export interface WorkflowGateEmitter {
	isUnattended(): boolean;
	emitGate(input: OpenGateInput): Promise<unknown>;
	onGateEmitted?(listener: (gate: WorkflowGate) => void): () => void;
	resolveGate?(response: WorkflowGateResponse): Promise<WorkflowGateResolution>;
	listPendingGates?(): WorkflowGate[];
}

/**
 * SDK-native workflow-gate emitter backed by a durable broker/store pair.
 *
 * Answers are resolved by the broker, so validation and idempotency have one
 * authority. Listeners replay durable pending gates when attached, allowing an
 * SDK host that starts after a gate was opened to discover it.
 */
export class BrokerWorkflowGateEmitter implements WorkflowGateEmitter {
	private readonly listeners = new Set<(gate: WorkflowGate) => void>();
	private readonly waiters = new Map<string, { resolve(answer: unknown): void }>();
	private readonly broker: WorkflowGateBroker;

	constructor(runId: string, private readonly store: GateStore) {
		this.broker = new WorkflowGateBroker(runId, store, {
			emit: gate => {
				for (const listener of this.listeners) listener(gate);
			},
			advance: (gate, answer) => {
				const waiter = this.waiters.get(gate.gate_id);
				if (!waiter) return;
				this.waiters.delete(gate.gate_id);
				waiter.resolve(answer);
			},
		});
	}

	isUnattended(): boolean {
		return true;
	}

	emitGate(input: OpenGateInput): Promise<unknown> {
		const gate = this.broker.openGate(input);
		// A listener may answer synchronously while the broker emits. The durable
		// record is the source of truth in that race; never strand its promise.
		const persisted = this.store.get(gate.gate_id);
		if (persisted?.status === "accepted") return Promise.resolve(persisted.answer);
		return new Promise(resolve => this.waiters.set(gate.gate_id, { resolve }));
	}

	onGateEmitted(listener: (gate: WorkflowGate) => void): () => void {
		this.listeners.add(listener);
		for (const gate of this.listPendingGates()) listener(gate);
		return () => this.listeners.delete(listener);
	}

	resolveGate(response: WorkflowGateResponse): Promise<WorkflowGateResolution> {
		return this.broker.resolve(response);
	}

	listPendingGates(): WorkflowGate[] {
		return this.store
			.list()
			.filter(record => record.status === "pending")
			.map(record => record.gate);
	}
}

const V1_STAGES: readonly WorkflowStage[] = ["deep-interview", "ralplan", "ultragoal"];

export interface PersistedGate {
	gate: WorkflowGate;
	status: "pending" | "accepted";
	idempotencyKey?: string;
	responseHash?: string;
	/** Raw accepted answer, retained so a crashed advance can be replayed. */
	answer?: unknown;
	resolution?: WorkflowGateResolution;
	advanced: boolean;
}

export interface GateStore {
	nextSeq(stage: WorkflowStage): number;
	put(record: PersistedGate): void;
	get(gateId: string): PersistedGate | undefined;
	/** All persisted gate records (used for crash recovery). */
	list(): PersistedGate[];
}

export class MemoryGateStore implements GateStore {
	private counters = new Map<WorkflowStage, number>();
	private gates = new Map<string, PersistedGate>();

	nextSeq(stage: WorkflowStage): number {
		const next = (this.counters.get(stage) ?? 0) + 1;
		this.counters.set(stage, next);
		return next;
	}
	put(record: PersistedGate): void {
		this.gates.set(record.gate.gate_id, structuredClone(record));
	}
	get(gateId: string): PersistedGate | undefined {
		const r = this.gates.get(gateId);
		return r ? structuredClone(r) : undefined;
	}
	list(): PersistedGate[] {
		return [...this.gates.values()].map(r => structuredClone(r));
	}
}

interface FileState {
	counters: Record<string, number>;
	gates: Record<string, PersistedGate>;
}

/** Crash-durable JSON-file backed store. Writes the full state on every mutation. */
export class FileGateStore implements GateStore {
	private state: FileState;
	constructor(private readonly filePath: string) {
		mkdirSync(path.dirname(filePath), { recursive: true });
		this.state = this.load();
	}
	private load(): FileState {
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { counters: {}, gates: {} };
			throw err;
		}
		try {
			return JSON.parse(raw) as FileState;
		} catch (err) {
			// Fail closed: a corrupt state file must not be silently reset (that would
			// drop counters/gates and risk gate-id reuse). Quarantine + throw.
			const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
			try {
				renameSync(this.filePath, quarantine);
			} catch {
				/* best-effort quarantine */
			}
			throw new Error(
				`corrupt gate store at ${this.filePath} (quarantined to ${quarantine}): ${(err as Error).message}`,
			);
		}
	}
	private flush(): void {
		// Atomic write: serialize to a temp file, fsync, then rename over the target.
		const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
		const fd = openSync(tmp, "w");
		try {
			writeFileSync(fd, JSON.stringify(this.state, null, 2));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.filePath);
	}
	nextSeq(stage: WorkflowStage): number {
		const next = (this.state.counters[stage] ?? 0) + 1;
		this.state.counters[stage] = next;
		this.flush();
		return next;
	}
	put(record: PersistedGate): void {
		this.state.gates[record.gate.gate_id] = record;
		this.flush();
	}
	get(gateId: string): PersistedGate | undefined {
		const r = this.state.gates[gateId];
		return r ? (JSON.parse(JSON.stringify(r)) as PersistedGate) : undefined;
	}
	list(): PersistedGate[] {
		return Object.values(this.state.gates).map(r => JSON.parse(JSON.stringify(r)) as PersistedGate);
	}
}

export type GateAuditEvent =
	| { event: "gate_emitted"; gate_id: string; stage: WorkflowStage; kind: WorkflowGateKind }
	| { event: "gate_response_accepted"; gate_id: string; answer_hash: string }
	| { event: "gate_response_rejected"; gate_id: string; answer_hash: string }
	| { event: "gate_response_idempotent_replay"; gate_id: string }
	| { event: "gate_response_idempotency_conflict"; gate_id: string }
	| { event: "gate_response_already_resolved"; gate_id: string }
	| { event: "gate_response_unknown_gate"; gate_id: string }
	| { event: "gate_advance_recovered"; gate_id: string };

export interface BrokerHooks {
	/** Called once when a pending gate has been persisted and should be emitted. */
	emit?(gate: WorkflowGate): void;
	/**
	 * Invoked to advance the workflow after an accepted resolution is durably
	 * committed. MUST be idempotent keyed by `gate.gate_id`: `recover()` replays
	 * it for any gate left `accepted` but not `advanced` by a crash.
	 */
	advance?(gate: WorkflowGate, answer: unknown): void | Promise<void>;
	/** Append-only audit sink. */
	audit?(event: GateAuditEvent): void;
}

export interface OpenGateInput {
	stage: WorkflowStage;
	kind: WorkflowGateKind;
	schema: WorkflowGate["schema"];
	options?: WorkflowGateOption[];
	context?: WorkflowGateContext;
}

export class WorkflowGateBrokerError extends Error {
	constructor(
		readonly code: "unknown_gate" | "already_resolved" | "idempotency_conflict" | "invalid_workflow_stage",
		message: string,
	) {
		super(message);
		this.name = "WorkflowGateBrokerError";
	}
}

export class WorkflowGateBroker {
	constructor(
		private readonly runId: string,
		private readonly store: GateStore,
		private readonly hooks: BrokerHooks = {},
	) {}

	private runShort(): string {
		return this.runId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "run";
	}

	/** Open and emit a gate. The pending record is persisted BEFORE emission. */
	openGate(input: OpenGateInput): WorkflowGate {
		if (RESERVED_WORKFLOW_STAGES.includes(input.stage) || !V1_STAGES.includes(input.stage)) {
			throw new WorkflowGateBrokerError(
				"invalid_workflow_stage",
				`stage "${input.stage}" is not a v1 workflow stage`,
			);
		}
		// Asserts schema shape (throws WorkflowGateSchemaError on unsupported keywords).
		compileGateSchema(input.schema);
		const seq = this.store.nextSeq(input.stage).toString().padStart(6, "0");
		const gateId = `wg_${this.runShort()}_${input.stage}_${seq}`;
		const gate: WorkflowGate = {
			type: "workflow_gate",
			gate_id: gateId,
			stage: input.stage,
			kind: input.kind,
			schema: input.schema,
			schema_hash: schemaHash(input.schema),
			options: input.options,
			context: input.context ?? {},
			created_at: new Date().toISOString(),
			required: true,
		};
		// Persist pending BEFORE emit so a crash never loses an emitted gate.
		this.store.put({ gate, status: "pending", advanced: false });
		this.hooks.emit?.(gate);
		this.hooks.audit?.({ event: "gate_emitted", gate_id: gateId, stage: gate.stage, kind: gate.kind });
		return gate;
	}

	/**
	 * Resolve a gate with an answer. Validates against the advertised schema.
	 * On success the resolution is persisted BEFORE `advance` is invoked exactly
	 * once. Invalid answers leave the gate pending (per #315 acceptance).
	 */
	async resolve(response: WorkflowGateResponse): Promise<WorkflowGateResolution> {
		const record = this.store.get(response.gate_id);
		if (!record) {
			this.hooks.audit?.({ event: "gate_response_unknown_gate", gate_id: response.gate_id });
			throw new WorkflowGateBrokerError("unknown_gate", `no pending gate ${response.gate_id}`);
		}
		const responseHash = answerHashOf({ gate_id: response.gate_id, answer: response.answer });

		if (record.status === "accepted") {
			const sameBody = record.responseHash === responseHash;
			const sameKey = record.idempotencyKey === response.idempotency_key;
			if (response.idempotency_key !== undefined && sameKey && sameBody) {
				this.hooks.audit?.({ event: "gate_response_idempotent_replay", gate_id: response.gate_id });
				return record.resolution as WorkflowGateResolution;
			}
			if (response.idempotency_key !== undefined && sameKey && !sameBody) {
				this.hooks.audit?.({ event: "gate_response_idempotency_conflict", gate_id: response.gate_id });
				throw new WorkflowGateBrokerError(
					"idempotency_conflict",
					`idempotency_conflict: gate ${response.gate_id} resolved with a different body`,
				);
			}
			this.hooks.audit?.({ event: "gate_response_already_resolved", gate_id: response.gate_id });
			throw new WorkflowGateBrokerError("already_resolved", `already_resolved: gate ${response.gate_id}`);
		}

		const compiled = compileGateSchema(record.gate.schema);
		const validationError = validateGateAnswer(compiled, response.gate_id, response.answer);
		const answerHash = answerHashOf(response.answer);
		if (validationError) {
			// Leave the gate pending so the agent can retry with a valid answer.
			this.hooks.audit?.({ event: "gate_response_rejected", gate_id: response.gate_id, answer_hash: answerHash });
			return {
				gate_id: response.gate_id,
				status: "rejected",
				answer_hash: answerHash,
				resolved_at: new Date().toISOString(),
				error: validationError,
			};
		}

		const resolution: WorkflowGateResolution = {
			gate_id: response.gate_id,
			status: "accepted",
			answer_hash: answerHash,
			resolved_at: new Date().toISOString(),
		};
		// Persist resolution BEFORE advancing the workflow (exactly-once advance).
		// `answer` is retained so a crash before the advanced:true write can be
		// recovered via recover().
		this.store.put({
			gate: record.gate,
			status: "accepted",
			idempotencyKey: response.idempotency_key,
			responseHash,
			answer: response.answer,
			resolution,
			advanced: false,
		});
		this.hooks.audit?.({ event: "gate_response_accepted", gate_id: response.gate_id, answer_hash: answerHash });
		await this.hooks.advance?.(record.gate, response.answer);
		this.store.put({
			gate: record.gate,
			status: "accepted",
			idempotencyKey: response.idempotency_key,
			responseHash,
			answer: response.answer,
			resolution,
			advanced: true,
		});
		return resolution;
	}

	/**
	 * Recover any gate left `accepted` but not `advanced` by a crash between the
	 * durable accept and the advanced commit. Replays `advance` (which must be
	 * idempotent) exactly once per gate and marks it advanced. Returns the ids
	 * that were recovered.
	 */
	async recover(): Promise<string[]> {
		const recovered: string[] = [];
		for (const listed of this.store.list()) {
			if (listed.status !== "accepted" || listed.advanced) continue;
			// Re-read immediately before advancing so a concurrent recoverer that
			// already advanced this gate (stale snapshot) cannot double-advance.
			const rec = this.store.get(listed.gate.gate_id);
			if (rec?.status !== "accepted" || rec.advanced) continue;
			await this.hooks.advance?.(rec.gate, rec.answer);
			this.store.put({ ...rec, advanced: true });
			this.hooks.audit?.({ event: "gate_advance_recovered", gate_id: rec.gate.gate_id });
			recovered.push(rec.gate.gate_id);
		}
		return recovered;
	}

	/** Canonical serialization helper (exposed for callers/tests). */
	static canonical(value: unknown): string {
		return canonicalJson(value);
	}
}
