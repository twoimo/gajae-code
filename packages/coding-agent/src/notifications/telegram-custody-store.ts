import * as fs from "node:fs";
import * as path from "node:path";
import { daemonPaths } from "./daemon-paths";
import {
	type TelegramCustodyEpochBinding,
	type TelegramCustodyEpochFs,
	withCurrentTelegramCustodyEpoch,
} from "./telegram-custody-epoch";

export const TELEGRAM_CUSTODY_SCHEMA_VERSION = 3;
export const TELEGRAM_CUSTODY_MAX_RECORDS = 1_000;
export const TELEGRAM_CUSTODY_MAX_FILE_BYTES = 1_048_576;

export type TelegramCustodyState = "queued" | "in_flight" | "confirmed" | "unknown";
export type TelegramDeletionTrigger = "session_closed" | "orphan_reap";
export type TelegramTransportDiagnostic = "connection_reset" | "timeout" | "aborted" | "network" | "other";
export type TelegramRejectionClass = "not_found" | "forbidden" | "rate_limited" | "server_error" | "other";
export type TelegramCustodyDiagnostic =
	| { kind: "telegram_ok" }
	| { kind: "telegram_rejected"; rejection: TelegramRejectionClass; errorCode?: number }
	| { kind: "malformed_response" }
	| { kind: "transport_ambiguous"; transport: TelegramTransportDiagnostic }
	| { kind: "restart_after_claim" }
	| { kind: "legacy_unknown" };

export interface TelegramCustodyRecord {
	chatId: string;
	topicId: string;
	state: TelegramCustodyState;
	updatedAt: number;
	custodyEpoch?: number;
	trigger?: TelegramDeletionTrigger;
	diagnostic?: TelegramCustodyDiagnostic;
}

export type TelegramCustodyReadOnlyReason = "corrupt" | "forward_version" | "bounds" | "migration_write_failed";

export interface TelegramCustodyLoadResult {
	mode: "writable" | "read_only";
	reason?: TelegramCustodyReadOnlyReason;
	migrated: boolean;
	records: readonly TelegramCustodyRecord[];
}

export type TelegramCustodyMutationFailure = { ok: false; reason: "read_only" | "fenced" };
export type TelegramCustodyWriteResult = { ok: true } | TelegramCustodyMutationFailure;
export type TelegramCustodyQueueResult =
	| { ok: true; status: "queued"; record: TelegramCustodyRecord }
	| { ok: true; status: "blocked"; record: TelegramCustodyRecord }
	| TelegramCustodyMutationFailure;
export type TelegramCustodyClaimResult =
	| { ok: true; status: "claimed"; record: TelegramCustodyRecord }
	| { ok: true; status: "blocked"; record: TelegramCustodyRecord }
	| TelegramCustodyMutationFailure;

export interface TelegramCustodyStoreFs {
	mkdir(path: string, opts?: fs.MakeDirectoryOptions): Promise<unknown>;
	readFile(path: string, encoding: BufferEncoding): Promise<string>;
	writeFile(path: string, data: string, opts?: fs.WriteFileOptions): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	unlink(path: string): Promise<void>;
}

const CUSTODY_FILENAME = "telegram-deletion-custody.json";
const nodeFs: TelegramCustodyStoreFs = fs.promises as unknown as TelegramCustodyStoreFs;

type StoreMode = "writable" | "read_only";
type LegacyTelegramCustodyState = "queued" | "in_flight" | "unknown";
type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: "corrupt" | "bounds" };

interface TelegramCustodyV1Record {
	state: LegacyTelegramCustodyState;
	updatedAt: number;
	custodyEpoch?: number;
}

interface TelegramCustodyV1Snapshot {
	records: TelegramCustodyV2Record[];
}

interface TelegramCustodyV2Record {
	chatId: string;
	topicId: string;
	state: LegacyTelegramCustodyState;
	updatedAt: number;
	custodyEpoch?: number;
}

interface ParsedV2Snapshot {
	records: TelegramCustodyV2Record[];
}

interface ParsedV3Snapshot {
	records: TelegramCustodyRecord[];
	hasInFlight: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const keys = Object.keys(value);
	if (keys.length < required.length || keys.length > required.length + optional.length) return false;
	return (
		required.every(key => Object.hasOwn(value, key)) &&
		keys.every(key => required.includes(key) || optional.includes(key))
	);
}

function isCanonicalChatId(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 32 && /^-?[1-9]\d*$/.test(value);
}

function isCanonicalTopicId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 20 && /^[1-9]\d*$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTelegramCustodyState(value: unknown): value is TelegramCustodyState {
	return value === "queued" || value === "in_flight" || value === "confirmed" || value === "unknown";
}

function isLegacyTelegramCustodyState(value: unknown): value is LegacyTelegramCustodyState {
	return value === "queued" || value === "in_flight" || value === "unknown";
}

function isTelegramDeletionTrigger(value: unknown): value is TelegramDeletionTrigger {
	return value === "session_closed" || value === "orphan_reap";
}

function isTelegramTransportDiagnostic(value: unknown): value is TelegramTransportDiagnostic {
	return (
		value === "connection_reset" ||
		value === "timeout" ||
		value === "aborted" ||
		value === "network" ||
		value === "other"
	);
}

function isTelegramRejectionClass(value: unknown): value is TelegramRejectionClass {
	return (
		value === "not_found" ||
		value === "forbidden" ||
		value === "rate_limited" ||
		value === "server_error" ||
		value === "other"
	);
}

function compareKeys(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function cloneDiagnostic(diagnostic: TelegramCustodyDiagnostic): TelegramCustodyDiagnostic {
	switch (diagnostic.kind) {
		case "telegram_ok":
		case "malformed_response":
		case "restart_after_claim":
		case "legacy_unknown":
			return { kind: diagnostic.kind };
		case "telegram_rejected":
			return diagnostic.errorCode === undefined
				? { kind: "telegram_rejected", rejection: diagnostic.rejection }
				: { kind: "telegram_rejected", rejection: diagnostic.rejection, errorCode: diagnostic.errorCode };
		case "transport_ambiguous":
			return { kind: "transport_ambiguous", transport: diagnostic.transport };
	}
}

function cloneRecord(record: TelegramCustodyRecord): TelegramCustodyRecord {
	const copy: TelegramCustodyRecord = {
		chatId: record.chatId,
		topicId: record.topicId,
		state: record.state,
		updatedAt: record.updatedAt,
	};
	if (record.custodyEpoch !== undefined) copy.custodyEpoch = record.custodyEpoch;
	if (record.trigger !== undefined) copy.trigger = record.trigger;
	if (record.diagnostic !== undefined) copy.diagnostic = cloneDiagnostic(record.diagnostic);
	return copy;
}

function cloneRecords(records: Iterable<TelegramCustodyRecord>): TelegramCustodyRecord[] {
	return Array.from(records, cloneRecord);
}

function readDiagnostic(value: unknown): TelegramCustodyDiagnostic | undefined {
	if (!isPlainObject(value) || typeof value.kind !== "string") return undefined;
	switch (value.kind) {
		case "telegram_ok":
			return hasExactKeys(value, ["kind"]) ? { kind: "telegram_ok" } : undefined;
		case "telegram_rejected":
			if (!hasExactKeys(value, ["kind", "rejection"], ["errorCode"]) || !isTelegramRejectionClass(value.rejection)) {
				return undefined;
			}
			if (!Object.hasOwn(value, "errorCode")) return { kind: "telegram_rejected", rejection: value.rejection };
			if (!isSafeInteger(value.errorCode)) return undefined;
			return { kind: "telegram_rejected", rejection: value.rejection, errorCode: value.errorCode };
		case "malformed_response":
			return hasExactKeys(value, ["kind"]) ? { kind: "malformed_response" } : undefined;
		case "transport_ambiguous":
			return hasExactKeys(value, ["kind", "transport"]) && isTelegramTransportDiagnostic(value.transport)
				? { kind: "transport_ambiguous", transport: value.transport }
				: undefined;
		case "restart_after_claim":
			return hasExactKeys(value, ["kind"]) ? { kind: "restart_after_claim" } : undefined;
		case "legacy_unknown":
			return hasExactKeys(value, ["kind"]) ? { kind: "legacy_unknown" } : undefined;
		default:
			return undefined;
	}
}

function readRecord(value: unknown): TelegramCustodyRecord | undefined {
	if (
		!isPlainObject(value) ||
		!hasExactKeys(value, ["chatId", "topicId", "state", "updatedAt"], ["custodyEpoch", "trigger", "diagnostic"])
	) {
		return undefined;
	}
	if (
		!isCanonicalChatId(value.chatId) ||
		!isCanonicalTopicId(value.topicId) ||
		!isTelegramCustodyState(value.state) ||
		!isNonNegativeSafeInteger(value.updatedAt)
	) {
		return undefined;
	}
	let custodyEpoch: number | undefined;
	if (Object.hasOwn(value, "custodyEpoch")) {
		if (!isNonNegativeSafeInteger(value.custodyEpoch)) return undefined;
		custodyEpoch = value.custodyEpoch;
	}
	let trigger: TelegramDeletionTrigger | undefined;
	if (Object.hasOwn(value, "trigger")) {
		if (!isTelegramDeletionTrigger(value.trigger)) return undefined;
		trigger = value.trigger;
	}
	const diagnostic = Object.hasOwn(value, "diagnostic") ? readDiagnostic(value.diagnostic) : undefined;
	if (Object.hasOwn(value, "diagnostic") && diagnostic === undefined) return undefined;
	if (value.state === "queued") {
		if (diagnostic !== undefined) return undefined;
	} else if (value.state === "in_flight") {
		if (diagnostic !== undefined || !isPositiveSafeInteger(custodyEpoch)) return undefined;
	} else if (value.state === "confirmed") {
		if (diagnostic?.kind !== "telegram_ok" || !isPositiveSafeInteger(custodyEpoch)) return undefined;
	} else if (
		diagnostic === undefined ||
		diagnostic.kind === "telegram_ok" ||
		(diagnostic.kind !== "legacy_unknown" &&
			diagnostic.kind !== "restart_after_claim" &&
			!isPositiveSafeInteger(custodyEpoch))
	) {
		return undefined;
	}

	const record: TelegramCustodyRecord = {
		chatId: value.chatId,
		topicId: value.topicId,
		state: value.state,
		updatedAt: value.updatedAt,
	};
	if (custodyEpoch !== undefined) record.custodyEpoch = custodyEpoch;
	if (trigger !== undefined) record.trigger = trigger;
	if (diagnostic !== undefined) record.diagnostic = diagnostic;
	return record;
}

function readV2Record(value: unknown): TelegramCustodyV2Record | undefined {
	if (!isPlainObject(value) || !hasExactKeys(value, ["chatId", "topicId", "state", "updatedAt"], ["custodyEpoch"])) {
		return undefined;
	}
	if (
		!isCanonicalChatId(value.chatId) ||
		!isCanonicalTopicId(value.topicId) ||
		!isLegacyTelegramCustodyState(value.state) ||
		!isNonNegativeSafeInteger(value.updatedAt)
	) {
		return undefined;
	}
	if (!Object.hasOwn(value, "custodyEpoch")) {
		return { chatId: value.chatId, topicId: value.topicId, state: value.state, updatedAt: value.updatedAt };
	}
	if (!isNonNegativeSafeInteger(value.custodyEpoch)) return undefined;
	return {
		chatId: value.chatId,
		topicId: value.topicId,
		state: value.state,
		updatedAt: value.updatedAt,
		custodyEpoch: value.custodyEpoch,
	};
}

function readV1Record(value: unknown): TelegramCustodyV1Record | undefined {
	if (!isPlainObject(value) || !hasExactKeys(value, ["state", "updatedAt"], ["custodyEpoch"])) return undefined;
	if (!isLegacyTelegramCustodyState(value.state) || !isNonNegativeSafeInteger(value.updatedAt)) return undefined;
	if (!Object.hasOwn(value, "custodyEpoch")) return { state: value.state, updatedAt: value.updatedAt };
	if (!isNonNegativeSafeInteger(value.custodyEpoch)) return undefined;
	return { state: value.state, updatedAt: value.updatedAt, custodyEpoch: value.custodyEpoch };
}

/** Validate decimal-only ID segments and form their unambiguous composite storage key. */
export function telegramCustodyKey(chatId: string, topicId: string): string {
	if (!isCanonicalChatId(chatId) || !isCanonicalTopicId(topicId)) {
		throw new Error("Invalid Telegram custody identifier");
	}
	return `${chatId}:${topicId}`;
}

function parseV3(value: unknown): ParseResult<ParsedV3Snapshot> {
	if (!isPlainObject(value) || !hasExactKeys(value, ["version", "records"]) || value.version !== 3) {
		return { ok: false, reason: "corrupt" };
	}
	if (!isPlainObject(value.records)) return { ok: false, reason: "corrupt" };

	const entries = Object.entries(value.records);
	if (entries.length > TELEGRAM_CUSTODY_MAX_RECORDS) return { ok: false, reason: "bounds" };

	const records: TelegramCustodyRecord[] = [];
	let hasInFlight = false;
	for (const [key, rawRecord] of entries) {
		const record = readRecord(rawRecord);
		if (!record) return { ok: false, reason: "corrupt" };
		if (key !== telegramCustodyKey(record.chatId, record.topicId)) return { ok: false, reason: "corrupt" };
		records.push(record);
		hasInFlight ||= record.state === "in_flight";
	}
	return {
		ok: true,
		value: {
			records: records.sort((left, right) =>
				compareKeys(telegramCustodyKey(left.chatId, left.topicId), telegramCustodyKey(right.chatId, right.topicId)),
			),
			hasInFlight,
		},
	};
}

function parseV2(value: unknown): ParseResult<ParsedV2Snapshot> {
	if (!isPlainObject(value) || !hasExactKeys(value, ["version", "records"]) || value.version !== 2) {
		return { ok: false, reason: "corrupt" };
	}
	if (!isPlainObject(value.records)) return { ok: false, reason: "corrupt" };

	const entries = Object.entries(value.records);
	if (entries.length > TELEGRAM_CUSTODY_MAX_RECORDS) return { ok: false, reason: "bounds" };

	const records: TelegramCustodyV2Record[] = [];
	for (const [key, rawRecord] of entries) {
		const record = readV2Record(rawRecord);
		if (!record) return { ok: false, reason: "corrupt" };
		if (key !== telegramCustodyKey(record.chatId, record.topicId)) return { ok: false, reason: "corrupt" };
		records.push(record);
	}
	return {
		ok: true,
		value: {
			records: records.sort((left, right) =>
				compareKeys(telegramCustodyKey(left.chatId, left.topicId), telegramCustodyKey(right.chatId, right.topicId)),
			),
		},
	};
}

function parseV1(value: unknown): ParseResult<TelegramCustodyV1Snapshot> {
	if (!isPlainObject(value) || !hasExactKeys(value, ["version", "chatId", "records"]) || value.version !== 1) {
		return { ok: false, reason: "corrupt" };
	}
	if (!isCanonicalChatId(value.chatId) || !isPlainObject(value.records)) return { ok: false, reason: "corrupt" };

	const entries = Object.entries(value.records);
	if (entries.length > TELEGRAM_CUSTODY_MAX_RECORDS) return { ok: false, reason: "bounds" };

	const records: TelegramCustodyV2Record[] = [];
	for (const [topicId, rawRecord] of entries) {
		if (!isCanonicalTopicId(topicId)) return { ok: false, reason: "corrupt" };
		const record = readV1Record(rawRecord);
		if (!record) return { ok: false, reason: "corrupt" };
		records.push({ ...record, chatId: value.chatId, topicId });
	}
	return { ok: true, value: { records } };
}

function migrateLegacyRecord(record: TelegramCustodyV2Record): TelegramCustodyRecord {
	const migrated: TelegramCustodyRecord = {
		chatId: record.chatId,
		topicId: record.topicId,
		state: record.state === "queued" ? "queued" : "unknown",
		updatedAt: record.updatedAt,
	};
	if (record.custodyEpoch !== undefined) migrated.custodyEpoch = record.custodyEpoch;
	if (record.state === "in_flight") migrated.diagnostic = { kind: "restart_after_claim" };
	if (record.state === "unknown") migrated.diagnostic = { kind: "legacy_unknown" };
	return migrated;
}

function classifyV3Records(records: readonly TelegramCustodyRecord[]): TelegramCustodyRecord[] {
	return records.map(record =>
		record.state === "in_flight"
			? { ...cloneRecord(record), state: "unknown", diagnostic: { kind: "restart_after_claim" } }
			: cloneRecord(record),
	);
}

function canonicalRecordsObject(records: Iterable<TelegramCustodyRecord>): Record<string, TelegramCustodyRecord> {
	const entries = Array.from(
		records,
		record => [telegramCustodyKey(record.chatId, record.topicId), cloneRecord(record)] as const,
	).sort((left, right) => compareKeys(left[0], right[0]));
	return Object.fromEntries(entries);
}

function serialize(records: Iterable<TelegramCustodyRecord>): string {
	return `${JSON.stringify(
		{ version: TELEGRAM_CUSTODY_SCHEMA_VERSION, records: canonicalRecordsObject(records) },
		null,
		2,
	)}\n`;
}

function findStringEnd(source: string, start: number): number | undefined {
	for (let position = start + 1; position < source.length; position++) {
		const character = source[position];
		if (character === "\\") {
			position++;
			continue;
		}
		if (character === '"') return position + 1;
	}
	return undefined;
}

/** JSON.parse intentionally accepts duplicate object members; custody files do not. */
function hasDuplicateObjectKeys(source: string): boolean {
	function skipWhitespace(position: number): number {
		while (/\s/.test(source[position] ?? "")) position++;
		return position;
	}

	function scanString(position: number): { value: string; end: number } | undefined {
		const end = findStringEnd(source, position);
		if (end === undefined) return undefined;
		try {
			return { value: JSON.parse(source.slice(position, end)) as string, end };
		} catch {
			return undefined;
		}
	}

	function scanValue(position: number): number | undefined {
		position = skipWhitespace(position);
		const character = source[position];
		if (character === '"') return scanString(position)?.end;
		if (character === "{") {
			position = skipWhitespace(position + 1);
			const keys = new Set<string>();
			if (source[position] === "}") return position + 1;
			while (true) {
				if (source[position] !== '"') return undefined;
				const key = scanString(position);
				if (!key || keys.has(key.value)) return undefined;
				keys.add(key.value);
				position = skipWhitespace(key.end);
				if (source[position] !== ":") return undefined;
				const valueEnd = scanValue(position + 1);
				if (valueEnd === undefined) return undefined;
				position = skipWhitespace(valueEnd);
				if (source[position] === "}") return position + 1;
				if (source[position] !== ",") return undefined;
				position = skipWhitespace(position + 1);
			}
		}
		if (character === "[") {
			position = skipWhitespace(position + 1);
			if (source[position] === "]") return position + 1;
			while (true) {
				const valueEnd = scanValue(position);
				if (valueEnd === undefined) return undefined;
				position = skipWhitespace(valueEnd);
				if (source[position] === "]") return position + 1;
				if (source[position] !== ",") return undefined;
				position = skipWhitespace(position + 1);
			}
		}
		while (position < source.length && !/[\s,}\]]/.test(source[position]!)) position++;
		return position;
	}

	const end = scanValue(0);
	return end === undefined || skipWhitespace(end) !== source.length;
}

export class TelegramCustodyStore {
	readonly #agentDir: string;
	readonly #dir: string;
	readonly #file: string;
	readonly #fsImpl: TelegramCustodyStoreFs;
	readonly #now: () => number;
	readonly #fence: { binding: TelegramCustodyEpochBinding; fs?: TelegramCustodyEpochFs } | undefined;
	#mode: StoreMode = "writable";
	#records = new Map<string, TelegramCustodyRecord>();
	#operations: Promise<void> = Promise.resolve();

	constructor(input: {
		agentDir: string;
		fs?: TelegramCustodyStoreFs;
		now?: () => number;
		fence?: { binding: TelegramCustodyEpochBinding; fs?: TelegramCustodyEpochFs };
	}) {
		this.#agentDir = input.agentDir;
		this.#dir = daemonPaths(input.agentDir).dir;
		this.#file = path.join(this.#dir, CUSTODY_FILENAME);
		this.#fsImpl = input.fs ?? nodeFs;
		this.#now = input.now ?? Date.now;
		this.#fence =
			input.fence === undefined
				? undefined
				: {
						binding: {
							ownerId: input.fence.binding.ownerId,
							custodyEpoch: input.fence.binding.custodyEpoch,
						},
						fs: input.fence.fs,
					};
	}

	async load(): Promise<TelegramCustodyLoadResult> {
		return this.#serializeOperation<TelegramCustodyLoadResult>(async () => this.#load());
	}

	list(): readonly TelegramCustodyRecord[] {
		return cloneRecords(this.#records.values()).sort((left, right) =>
			compareKeys(telegramCustodyKey(left.chatId, left.topicId), telegramCustodyKey(right.chatId, right.topicId)),
		);
	}

	get(input: { chatId: string; topicId: string }): TelegramCustodyRecord | undefined {
		const record = this.#records.get(telegramCustodyKey(input.chatId, input.topicId));
		return record === undefined ? undefined : cloneRecord(record);
	}

	async put(record: TelegramCustodyRecord): Promise<TelegramCustodyWriteResult> {
		const validated = readRecord(record);
		if (!validated) throw new Error("Invalid Telegram custody record");
		const copy = cloneRecord(validated);
		return this.#serializeOperation<TelegramCustodyWriteResult>(async () => {
			if (this.#mode === "read_only") return { ok: false, reason: "read_only" };
			if (this.#fence) {
				if (copy.custodyEpoch !== undefined && copy.custodyEpoch !== this.#fence.binding.custodyEpoch) {
					return { ok: false, reason: "fenced" };
				}
				copy.custodyEpoch = this.#fence.binding.custodyEpoch;
			}
			const next = new Map(this.#records);
			next.set(telegramCustodyKey(copy.chatId, copy.topicId), copy);
			if (next.size > TELEGRAM_CUSTODY_MAX_RECORDS) throw new Error("Telegram custody record limit exceeded");
			const persisted = await this.#persist(next.values());
			if (!persisted.ok) return persisted;
			this.#records = next;
			return { ok: true };
		});
	}

	async remove(input: { chatId: string; topicId: string }): Promise<TelegramCustodyWriteResult> {
		const key = telegramCustodyKey(input.chatId, input.topicId);
		return this.#serializeOperation<TelegramCustodyWriteResult>(async () => {
			if (this.#mode === "read_only") return { ok: false, reason: "read_only" };
			const next = new Map(this.#records);
			next.delete(key);
			const persisted = await this.#persist(next.values());
			if (!persisted.ok) return persisted;
			this.#records = next;
			return { ok: true };
		});
	}

	async queueDeletion(input: {
		chatId: string;
		topicId: string;
		trigger: TelegramDeletionTrigger;
	}): Promise<TelegramCustodyQueueResult> {
		const key = telegramCustodyKey(input.chatId, input.topicId);
		if (!isTelegramDeletionTrigger(input.trigger)) throw new Error("Invalid Telegram deletion trigger");
		return this.#serializeOperation<TelegramCustodyQueueResult>(async () => {
			if (this.#mode === "read_only") return { ok: false, reason: "read_only" };
			const existing = this.#records.get(key);
			if (existing !== undefined && existing.state !== "queued") {
				return { ok: true, status: "blocked", record: cloneRecord(existing) };
			}
			const custodyEpoch = this.#activeFenceEpoch();
			if (custodyEpoch === undefined) return { ok: false, reason: "fenced" };
			const record: TelegramCustodyRecord = {
				chatId: input.chatId,
				topicId: input.topicId,
				state: "queued",
				updatedAt: this.#timestamp(),
				custodyEpoch,
				trigger: input.trigger,
			};
			const next = new Map(this.#records);
			next.set(key, record);
			if (next.size > TELEGRAM_CUSTODY_MAX_RECORDS) throw new Error("Telegram custody record limit exceeded");
			const persisted = await this.#persist(next.values());
			if (!persisted.ok) return persisted;
			this.#records = next;
			return { ok: true, status: "queued", record: cloneRecord(record) };
		});
	}

	async claimDeletion(input: { chatId: string; topicId: string }): Promise<TelegramCustodyClaimResult> {
		const key = telegramCustodyKey(input.chatId, input.topicId);
		return this.#serializeOperation<TelegramCustodyClaimResult>(async () => {
			if (this.#mode === "read_only") return { ok: false, reason: "read_only" };
			const existing = this.#records.get(key);
			if (existing === undefined) return { ok: false, reason: "fenced" };
			if (existing.state !== "queued") return { ok: true, status: "blocked", record: cloneRecord(existing) };
			const custodyEpoch = this.#activeFenceEpoch();
			if (custodyEpoch === undefined) return { ok: false, reason: "fenced" };
			const record: TelegramCustodyRecord = {
				chatId: existing.chatId,
				topicId: existing.topicId,
				state: "in_flight",
				updatedAt: this.#timestamp(),
				custodyEpoch,
			};
			if (existing.trigger !== undefined) record.trigger = existing.trigger;
			const next = new Map(this.#records);
			next.set(key, record);
			const persisted = await this.#persist(next.values());
			if (!persisted.ok) return persisted;
			this.#records = next;
			return { ok: true, status: "claimed", record: cloneRecord(record) };
		});
	}

	async settleDeletion(input: {
		chatId: string;
		topicId: string;
		diagnostic: TelegramCustodyDiagnostic;
	}): Promise<TelegramCustodyWriteResult> {
		const key = telegramCustodyKey(input.chatId, input.topicId);
		const diagnostic = readDiagnostic(input.diagnostic);
		if (diagnostic === undefined) throw new Error("Invalid Telegram custody diagnostic");
		return this.#serializeOperation<TelegramCustodyWriteResult>(async () => {
			if (this.#mode === "read_only") return { ok: false, reason: "read_only" };
			const existing = this.#records.get(key);
			const custodyEpoch = this.#activeFenceEpoch();
			if (
				existing === undefined ||
				existing.state !== "in_flight" ||
				custodyEpoch === undefined ||
				existing.custodyEpoch !== custodyEpoch
			) {
				return { ok: false, reason: "fenced" };
			}
			const record: TelegramCustodyRecord = {
				chatId: existing.chatId,
				topicId: existing.topicId,
				state: diagnostic.kind === "telegram_ok" ? "confirmed" : "unknown",
				updatedAt: this.#timestamp(),
				custodyEpoch,
				diagnostic,
			};
			if (existing.trigger !== undefined) record.trigger = existing.trigger;
			const next = new Map(this.#records);
			next.set(key, record);
			const persisted = await this.#persist(next.values());
			if (!persisted.ok) return persisted;
			this.#records = next;
			return { ok: true };
		});
	}

	async removeConfirmed(input: { chatId: string; topicId: string }): Promise<TelegramCustodyWriteResult> {
		const key = telegramCustodyKey(input.chatId, input.topicId);
		return this.#serializeOperation<TelegramCustodyWriteResult>(async () => {
			const existing = this.#records.get(key);
			if (existing === undefined) return { ok: true };
			if (this.#mode === "read_only") return { ok: false, reason: "read_only" };
			if (existing.state !== "confirmed" || this.#activeFenceEpoch() === undefined) {
				return { ok: false, reason: "fenced" };
			}
			const next = new Map(this.#records);
			next.delete(key);
			const persisted = await this.#persist(next.values());
			if (!persisted.ok) return persisted;
			this.#records = next;
			return { ok: true };
		});
	}

	async #load(): Promise<TelegramCustodyLoadResult> {
		let source: string;
		try {
			source = await this.#fsImpl.readFile(this.#file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.#mode = "writable";
			this.#records = new Map();
			return { mode: "writable", migrated: false, records: [] };
		}

		if (Buffer.byteLength(source, "utf8") > TELEGRAM_CUSTODY_MAX_FILE_BYTES) return this.#readOnly("bounds", []);

		let document: unknown;
		try {
			if (hasDuplicateObjectKeys(source)) return this.#readOnly("corrupt", []);
			document = JSON.parse(source) as unknown;
		} catch {
			return this.#readOnly("corrupt", []);
		}

		if (
			isPlainObject(document) &&
			typeof document.version === "number" &&
			Number.isSafeInteger(document.version) &&
			document.version > TELEGRAM_CUSTODY_SCHEMA_VERSION
		) {
			return this.#readOnly("forward_version", []);
		}

		const v3 = parseV3(document);
		if (v3.ok) {
			const records = classifyV3Records(v3.value.records);
			if (v3.value.hasInFlight) {
				try {
					if (!(await this.#persist(records)).ok) return this.#readOnly("migration_write_failed", records);
				} catch {
					return this.#readOnly("migration_write_failed", records);
				}
			}
			this.#mode = "writable";
			this.#setRecords(records);
			return { mode: "writable", migrated: false, records: this.list() };
		}

		const v2 = parseV2(document);
		if (v2.ok) {
			const records = v2.value.records.map(migrateLegacyRecord);
			try {
				if (!(await this.#persist(records)).ok) return this.#readOnly("migration_write_failed", records);
			} catch {
				return this.#readOnly("migration_write_failed", records);
			}
			this.#mode = "writable";
			this.#setRecords(records);
			return { mode: "writable", migrated: true, records: this.list() };
		}

		const v1 = parseV1(document);
		if (!v1.ok) {
			return this.#readOnly(
				v3.reason === "bounds" || v2.reason === "bounds" || v1.reason === "bounds" ? "bounds" : "corrupt",
				[],
			);
		}
		const records = v1.value.records.map(migrateLegacyRecord);
		try {
			if (!(await this.#persist(records)).ok) return this.#readOnly("migration_write_failed", records);
		} catch {
			return this.#readOnly("migration_write_failed", records);
		}
		this.#mode = "writable";
		this.#setRecords(records);
		return { mode: "writable", migrated: true, records: this.list() };
	}

	#activeFenceEpoch(): number | undefined {
		if (
			this.#fence === undefined ||
			typeof this.#fence.binding.ownerId !== "string" ||
			this.#fence.binding.ownerId.length === 0 ||
			!isPositiveSafeInteger(this.#fence.binding.custodyEpoch)
		) {
			return undefined;
		}
		return this.#fence.binding.custodyEpoch;
	}

	#timestamp(): number {
		const timestamp = this.#now();
		if (!isNonNegativeSafeInteger(timestamp)) throw new Error("Invalid Telegram custody timestamp");
		return timestamp;
	}

	#readOnly(
		reason: TelegramCustodyReadOnlyReason,
		records: readonly TelegramCustodyRecord[],
	): TelegramCustodyLoadResult {
		this.#mode = "read_only";
		this.#setRecords(records);
		return { mode: "read_only", reason, migrated: false, records: this.list() };
	}

	#setRecords(records: Iterable<TelegramCustodyRecord>): void {
		this.#records = new Map(
			Array.from(
				records,
				record => [telegramCustodyKey(record.chatId, record.topicId), cloneRecord(record)] as const,
			),
		);
	}

	async #persist(records: Iterable<TelegramCustodyRecord>): Promise<TelegramCustodyWriteResult> {
		const data = serialize(records);
		if (Buffer.byteLength(data, "utf8") > TELEGRAM_CUSTODY_MAX_FILE_BYTES) {
			throw new Error("Telegram custody snapshot exceeds the maximum file size");
		}
		if (!this.#fence) {
			await this.#persistAtomically(data);
			return { ok: true };
		}
		const result = await withCurrentTelegramCustodyEpoch(
			{
				agentDir: this.#agentDir,
				binding: this.#fence.binding,
				fs: this.#fence.fs,
			},
			async () => {
				await this.#persistAtomically(data);
			},
		);
		return result.ok ? { ok: true } : result;
	}

	async #persistAtomically(data: string): Promise<void> {
		await this.#fsImpl.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		await this.#fsImpl.chmod(this.#dir, 0o700);
		const temporaryFile = `${this.#file}.${process.pid}.${this.#now()}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			await this.#fsImpl.writeFile(temporaryFile, data, { mode: 0o600 });
			await this.#fsImpl.chmod(temporaryFile, 0o600);
			await this.#fsImpl.rename(temporaryFile, this.#file);
		} catch (error) {
			await this.#fsImpl.unlink(temporaryFile).catch(() => undefined);
			throw error;
		}
	}

	async #serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#operations.then(operation, operation);
		this.#operations = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
