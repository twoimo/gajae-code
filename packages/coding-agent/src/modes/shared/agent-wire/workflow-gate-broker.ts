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
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { AskSelectedAckOutcome } from "../../../tools";
import { classifyAskGateDisposition } from "./deep-interview-gate";
import type {
	RpcWorkflowGate,
	RpcWorkflowGateContext,
	RpcWorkflowGateKind,
	RpcWorkflowGateOption,
	RpcWorkflowGateResolution,
	RpcWorkflowGateResponse,
	RpcWorkflowGateValidationError,
	RpcWorkflowStage,
} from "./protocol";
import { RESERVED_WORKFLOW_STAGES } from "./protocol";
import { answerHashOf, canonicalJson, compileGateSchema, schemaHash, validateGateAnswer } from "./workflow-gate-schema";

export type PersistedSemanticDisposition = "commit" | "resolve_without_commit";
export type PersistedResolutionOrigin =
	| { kind: "generic"; channel: "rpc" | "bridge" | "other" }
	| { kind: "telegram_notification"; interactionActionId: string }
	| { kind: "legacy_unknown" };
export type PersistedAckPolicy =
	| { kind: "none"; reason: "non_telegram" | "semantic_noncommit" | "legacy_unproven" }
	| {
			kind: "telegram_selected_v1";
			commitKey: string;
			actionId: string;
			state: "pending" | "attempt_started" | "delivered" | "failed" | "unknown";
			outcome?: AskSelectedAckOutcome;
			updatedAt: string;
	  };

export interface GateResolutionOptions {
	semanticDisposition?: PersistedSemanticDisposition;
	resolutionOrigin?: PersistedResolutionOrigin;
	ackPolicy?: PersistedAckPolicy;
	beforeAdvance?: () => Promise<void>;
}

const V1_STAGES: readonly RpcWorkflowStage[] = ["deep-interview", "ralplan", "ultragoal"];

export interface PersistedGate {
	gate: RpcWorkflowGate;
	status: "pending" | "accepted";
	idempotencyKey?: string;
	responseHash?: string;
	/** Raw accepted answer, retained so a crashed advance can be replayed. */
	answer?: unknown;
	resolution?: RpcWorkflowGateResolution;
	advanced: boolean;
	semanticDisposition?: PersistedSemanticDisposition;
	resolutionOrigin?: PersistedResolutionOrigin;
	ackPolicy?: PersistedAckPolicy;
}

export interface GateStore {
	nextSeq(stage: RpcWorkflowStage): number;
	put(record: PersistedGate): void;
	get(gateId: string): PersistedGate | undefined;
	/** All persisted gate records (used for crash recovery). */
	list(): PersistedGate[];
}

export class MemoryGateStore implements GateStore {
	private counters = new Map<RpcWorkflowStage, number>();
	private gates = new Map<string, PersistedGate>();

	nextSeq(stage: RpcWorkflowStage): number {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const GATE_ID_PATTERN = /^wg_[a-zA-Z0-9]+_(deep-interview|ralplan|ultragoal)_(\d+)$/;
const V1_GATE_KINDS: readonly string[] = ["question", "approval", "execution"];
const ACK_NONE_REASONS: readonly string[] = ["non_telegram", "semantic_noncommit", "legacy_unproven"];
const ACK_TELEGRAM_STATES: readonly string[] = ["pending", "attempt_started", "delivered", "failed", "unknown"];
const ACK_FAILED_REASONS: readonly string[] = [
	"unsupported",
	"no_participant",
	"ambiguous_participant",
	"route_missing",
	"expired",
	"cancelled",
	"telegram_rejected",
	"session_closed",
];
const ACK_UNKNOWN_REASONS: readonly string[] = [
	"transport_ambiguous",
	"origin_disconnected",
	"host_timeout",
	"shutdown",
];

function isAckOutcome(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.status === "delivered") return typeof value.messageId === "number";
	if (value.status === "failed") return typeof value.reason === "string" && ACK_FAILED_REASONS.includes(value.reason);
	if (value.status === "unknown")
		return typeof value.reason === "string" && ACK_UNKNOWN_REASONS.includes(value.reason);
	return false;
}

function isGateOption(value: unknown): boolean {
	return (
		isRecord(value) &&
		Object.hasOwn(value, "value") &&
		typeof value.label === "string" &&
		(value.description === undefined || typeof value.description === "string")
	);
}

function isPersistedResolutionOrigin(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "generic")
		return value.channel === "rpc" || value.channel === "bridge" || value.channel === "other";
	if (value.kind === "telegram_notification") return typeof value.interactionActionId === "string";
	return value.kind === "legacy_unknown";
}

function isPersistedAckPolicy(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "none") return typeof value.reason === "string" && ACK_NONE_REASONS.includes(value.reason);
	if (value.kind === "telegram_selected_v1") {
		return (
			typeof value.commitKey === "string" &&
			typeof value.actionId === "string" &&
			typeof value.state === "string" &&
			ACK_TELEGRAM_STATES.includes(value.state) &&
			typeof value.updatedAt === "string" &&
			(value.outcome === undefined || isAckOutcome(value.outcome))
		);
	}
	return false;
}

function isPersistedGate(gateId: string, record: unknown): record is PersistedGate {
	if (!isRecord(record) || !isRecord(record.gate)) return false;
	const { gate } = record;
	if (
		typeof gate.gate_id !== "string" ||
		gate.gate_id !== gateId ||
		gate.type !== "workflow_gate" ||
		typeof gate.stage !== "string" ||
		!V1_STAGES.includes(gate.stage as RpcWorkflowStage) ||
		typeof gate.kind !== "string" ||
		!V1_GATE_KINDS.includes(gate.kind) ||
		!isRecord(gate.schema) ||
		typeof gate.schema_hash !== "string" ||
		!isRecord(gate.context) ||
		typeof gate.created_at !== "string" ||
		gate.required !== true ||
		(gate.options !== undefined && !(Array.isArray(gate.options) && gate.options.every(isGateOption))) ||
		(record.status !== "pending" && record.status !== "accepted") ||
		typeof record.advanced !== "boolean" ||
		(record.semanticDisposition !== undefined &&
			record.semanticDisposition !== "commit" &&
			record.semanticDisposition !== "resolve_without_commit") ||
		(record.resolutionOrigin !== undefined && !isPersistedResolutionOrigin(record.resolutionOrigin)) ||
		(record.ackPolicy !== undefined && !isPersistedAckPolicy(record.ackPolicy))
	) {
		return false;
	}
	// The advertised schema must still compile and match its stored hash, or
	// recovery could validate answers against a schema the run never advertised.
	try {
		compileGateSchema(gate.schema as RpcWorkflowGate["schema"]);
	} catch {
		return false;
	}
	if (schemaHash(gate.schema as RpcWorkflowGate["schema"]) !== gate.schema_hash) return false;
	if (record.status === "pending") return record.advanced === false;
	if (
		typeof record.responseHash !== "string" ||
		!isRecord(record.resolution) ||
		record.resolution.gate_id !== gateId ||
		record.resolution.status !== "accepted" ||
		typeof record.resolution.answer_hash !== "string" ||
		typeof record.resolution.resolved_at !== "string"
	) {
		return false;
	}
	if (record.advanced) return true;
	// An unadvanced accepted record will have its retained answer replayed by
	// recover(); require the answer to still match both persisted hashes so a
	// tampered/garbled answer can never advance the workflow.
	if (!Object.hasOwn(record, "answer")) return false;
	if (answerHashOf(record.answer) !== record.resolution.answer_hash) return false;
	return answerHashOf({ gate_id: gateId, answer: record.answer }) === record.responseHash;
}

function isFileState(value: unknown): value is FileState {
	if (!isRecord(value) || !Object.hasOwn(value, "counters") || !Object.hasOwn(value, "gates")) return false;
	const { counters, gates } = value;
	if (!isRecord(counters) || !isRecord(gates)) return false;
	if (
		!Object.values(counters).every(
			counter => typeof counter === "number" && Number.isSafeInteger(counter) && counter >= 0,
		)
	) {
		return false;
	}
	const highestSeqByStage = new Map<string, number>();
	for (const [gateId, record] of Object.entries(gates)) {
		if (!isPersistedGate(gateId, record)) return false;
		const gateIdParts = GATE_ID_PATTERN.exec(gateId);
		if (!gateIdParts) return false;
		const [, stage, sequenceText] = gateIdParts;
		if (record.gate.stage !== stage) return false;
		const sequence = Number(sequenceText);
		if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
		highestSeqByStage.set(stage, Math.max(highestSeqByStage.get(stage) ?? 0, sequence));
	}
	return [...highestSeqByStage].every(([stage, highestSequence]) => {
		const counter = counters[stage];
		return typeof counter === "number" && counter >= highestSequence;
	});
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

/**
 * Persist directory-entry mutations (marker creation, quarantine/state renames).
 * A file-data fsync alone does not persist the rename in the parent directory,
 * so without this a power loss could drop both the corruption marker and the
 * quarantined state, silently resetting the store. Filesystems that reject
 * directory fsync get a compatibility diagnostic instead of a hard failure.
 */
function fsyncParentDirectory(filePath: string): void {
	let dirFd: number | undefined;
	try {
		dirFd = openSync(path.dirname(filePath), "r");
		fsyncSync(dirFd);
	} catch (error) {
		if (!isUnsupportedDirectorySyncError(error)) throw error;
		try {
			process.stderr.write("gjc gate store directory sync unsupported\n");
		} catch {
			// Compatibility diagnostics must not alter store durability semantics.
		}
	} finally {
		if (dirFd !== undefined) closeSync(dirFd);
	}
}

/** Crash-durable JSON-file backed store. Writes the full state on every mutation. */
export class FileGateStore implements GateStore {
	private state: FileState;
	constructor(private readonly filePath: string) {
		mkdirSync(path.dirname(filePath), { recursive: true });
		const markerPath = this.corruptionMarkerPath();
		if (existsSync(markerPath)) {
			throw new Error(
				`corrupt gate store at ${this.filePath}: quarantine marker ${markerPath} exists; inspect the quarantined state and manually remove the marker only after recovery`,
			);
		}
		this.state = this.load();
	}
	private corruptionMarkerPath(): string {
		return `${this.filePath}.corrupt.lock`;
	}
	private quarantine(error: unknown): never {
		const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
		const markerPath = this.corruptionMarkerPath();
		const reason = error instanceof Error ? error.message : String(error);
		let markerFd: number | undefined;
		try {
			markerFd = openSync(markerPath, "w");
			writeFileSync(markerFd, JSON.stringify({ quarantinedPath: quarantine, reason }, null, 2));
			fsyncSync(markerFd);
		} catch (markerError) {
			const markerReason = markerError instanceof Error ? markerError.message : String(markerError);
			throw new Error(
				`corrupt gate store at ${this.filePath}: unable to create quarantine marker ${markerPath}: ${markerReason}`,
			);
		} finally {
			if (markerFd !== undefined) closeSync(markerFd);
		}
		// Persist the marker's directory entry BEFORE the state is renamed away so
		// a crash between the two cannot leave neither marker nor original path.
		fsyncParentDirectory(markerPath);
		try {
			renameSync(this.filePath, quarantine);
			fsyncParentDirectory(this.filePath);
		} catch (quarantineError) {
			const quarantineReason = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
			throw new Error(
				`corrupt gate store at ${this.filePath}: quarantine marker ${markerPath} was created but moving the state failed: ${quarantineReason}`,
			);
		}
		throw new Error(
			`corrupt gate store at ${this.filePath} (quarantined to ${quarantine}): ${reason}; inspect it and manually remove ${markerPath} only after recovery`,
		);
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
			const parsed: unknown = JSON.parse(raw);
			if (!isFileState(parsed)) throw new Error("invalid gate store state shape");
			return parsed;
		} catch (err) {
			// Fail closed: a corrupt state file must not be silently reset (that would
			// drop counters/gates and risk gate-id reuse). Quarantine + lock it.
			return this.quarantine(err);
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
		fsyncParentDirectory(this.filePath);
	}
	nextSeq(stage: RpcWorkflowStage): number {
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
	| { event: "gate_emitted"; gate_id: string; stage: RpcWorkflowStage; kind: RpcWorkflowGateKind }
	| { event: "gate_emit_failed"; gate_id: string; stage: RpcWorkflowStage; kind: RpcWorkflowGateKind }
	| { event: "gate_response_accepted"; gate_id: string; answer_hash: string }
	| { event: "gate_response_rejected"; gate_id: string; answer_hash: string }
	| { event: "gate_response_idempotent_replay"; gate_id: string }
	| { event: "gate_response_idempotency_conflict"; gate_id: string }
	| { event: "gate_response_already_resolved"; gate_id: string }
	| { event: "gate_response_unknown_gate"; gate_id: string }
	| { event: "gate_advance_recovered"; gate_id: string };

export interface BrokerHooks {
	/** Called once when a pending gate has been persisted and should be emitted. */
	emit?(gate: RpcWorkflowGate): void;
	/**
	 * Invoked to advance the workflow after an accepted resolution is durably
	 * committed. MUST be idempotent keyed by `gate.gate_id`: `recover()` replays
	 * it for any gate left `accepted` but not `advanced` by a crash.
	 */
	advance?(gate: RpcWorkflowGate, answer: unknown): void | Promise<void>;
	/** Runs after durable acceptance and before advance, including crash recovery. */
	finalizeAccepted?(record: PersistedGate): Promise<void>;

	/** Append-only audit sink. */
	audit?(event: GateAuditEvent): void;
}

export interface OpenGateInput {
	stage: RpcWorkflowStage;
	kind: RpcWorkflowGateKind;
	schema: RpcWorkflowGate["schema"];
	options?: RpcWorkflowGateOption[];
	context?: RpcWorkflowGateContext;
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
	private readonly recovering = new Set<string>();
	private readonly gateLocks = new Map<string, Promise<void>>();

	private async withGateLock<T>(gateId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.gateLocks.get(gateId) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		const current = previous.then(() => release.promise);
		this.gateLocks.set(gateId, current);
		await previous;
		try {
			return await operation();
		} finally {
			release.resolve();
			if (this.gateLocks.get(gateId) === current) this.gateLocks.delete(gateId);
		}
	}

	constructor(
		private readonly runId: string,
		private readonly store: GateStore,
		private readonly hooks: BrokerHooks = {},
	) {}

	classifyDisposition(gateId: string, answer: unknown): PersistedSemanticDisposition {
		const record = this.store.get(gateId);
		if (!record) throw new WorkflowGateBrokerError("unknown_gate", `no pending gate ${gateId}`);
		return classifyAskGateDisposition(record.gate, answer);
	}
	validationError(gateId: string, keyword: string, message: string): RpcWorkflowGateValidationError {
		const record = this.store.get(gateId);
		return {
			code: "invalid_workflow_gate_answer",
			gate_id: gateId,
			schema_hash: record ? schemaHash(record.gate.schema) : "",
			errors: [{ path: "$", keyword, message }],
		};
	}

	updateAckPolicy(gateId: string, ackPolicy: PersistedAckPolicy): void {
		const record = this.store.get(gateId);
		if (record?.status !== "accepted")
			throw new WorkflowGateBrokerError("unknown_gate", `no accepted gate ${gateId}`);
		this.store.put({ ...record, ackPolicy });
	}

	async #advanceAccepted(gateId: string): Promise<boolean> {
		const accepted = this.store.get(gateId);
		if (accepted?.status !== "accepted") {
			throw new WorkflowGateBrokerError("unknown_gate", `accepted gate ${gateId} disappeared before advance`);
		}
		if (accepted.advanced) return false;
		await this.hooks.finalizeAccepted?.(accepted);
		const finalized = this.store.get(gateId);
		if (finalized?.status !== "accepted") {
			throw new WorkflowGateBrokerError("unknown_gate", `accepted gate ${gateId} disappeared before advance`);
		}
		if (finalized.advanced) return false;
		await this.hooks.advance?.(finalized.gate, finalized.answer);
		const latest = this.store.get(gateId);
		if (latest?.status !== "accepted") {
			throw new WorkflowGateBrokerError("unknown_gate", `accepted gate ${gateId} disappeared after advance`);
		}
		this.store.put({ ...latest, advanced: true });
		return true;
	}

	private runShort(): string {
		return this.runId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "run";
	}

	/** Open and emit a gate. The pending record is persisted BEFORE emission. */
	openGate(input: OpenGateInput): RpcWorkflowGate {
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
		const gate: RpcWorkflowGate = {
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
		try {
			this.hooks.emit?.(gate);
		} catch (error) {
			this.hooks.audit?.({ event: "gate_emit_failed", gate_id: gateId, stage: gate.stage, kind: gate.kind });
			throw error;
		}
		this.hooks.audit?.({ event: "gate_emitted", gate_id: gateId, stage: gate.stage, kind: gate.kind });
		return gate;
	}

	/**
	 * Resolve a gate with an answer. Validates against the advertised schema.
	 * On success the resolution is persisted BEFORE `advance` is invoked exactly
	 * once. Invalid answers leave the gate pending (per #315 acceptance).
	 */
	async resolve(
		response: RpcWorkflowGateResponse,
		options: GateResolutionOptions = {},
	): Promise<RpcWorkflowGateResolution> {
		return this.withGateLock(response.gate_id, () => this.resolveUnlocked(response, options));
	}

	private async resolveUnlocked(
		response: RpcWorkflowGateResponse,
		options: GateResolutionOptions = {},
	): Promise<RpcWorkflowGateResolution> {
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
				await this.#advanceAccepted(response.gate_id);
				return record.resolution as RpcWorkflowGateResolution;
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

		const semanticDisposition =
			options.semanticDisposition ?? classifyAskGateDisposition(record.gate, response.answer);
		const resolutionOrigin = options.resolutionOrigin ?? { kind: "generic", channel: "rpc" as const };
		const ackPolicy =
			options.ackPolicy ??
			({ kind: "none", reason: semanticDisposition === "commit" ? "non_telegram" : "semantic_noncommit" } as const);

		const resolution: RpcWorkflowGateResolution = {
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
			semanticDisposition,
			resolutionOrigin,
			ackPolicy,
		});
		this.hooks.audit?.({ event: "gate_response_accepted", gate_id: response.gate_id, answer_hash: answerHash });
		await options.beforeAdvance?.();
		await this.#advanceAccepted(response.gate_id);
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
			if (listed.status !== "accepted" || listed.advanced || this.recovering.has(listed.gate.gate_id)) continue;
			this.recovering.add(listed.gate.gate_id);
			try {
				await this.withGateLock(listed.gate.gate_id, async () => {
					const advanced = await this.#advanceAccepted(listed.gate.gate_id);
					if (!advanced) return;
					this.hooks.audit?.({ event: "gate_advance_recovered", gate_id: listed.gate.gate_id });
					recovered.push(listed.gate.gate_id);
				});
			} finally {
				this.recovering.delete(listed.gate.gate_id);
			}
		}
		return recovered;
	}

	/** Canonical serialization helper (exposed for callers/tests). */
	static canonical(value: unknown): string {
		return canonicalJson(value);
	}
}
