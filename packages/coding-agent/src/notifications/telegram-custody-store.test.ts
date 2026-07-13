import { describe, expect, test } from "bun:test";
import type * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { daemonPaths } from "./daemon-paths";
import { allocateTelegramCustodyEpoch, type TelegramCustodyEpochBinding } from "./telegram-custody-epoch";
import {
	TELEGRAM_CUSTODY_MAX_FILE_BYTES,
	TELEGRAM_CUSTODY_MAX_RECORDS,
	TELEGRAM_CUSTODY_SCHEMA_VERSION,
	type TelegramCustodyDiagnostic,
	type TelegramCustodyRecord,
	TelegramCustodyStore,
	type TelegramCustodyStoreFs,
	telegramCustodyKey,
} from "./telegram-custody-store";

const AGENT_DIR = "/virtual/agent";
const CUSTODY_PATH = path.join(daemonPaths(AGENT_DIR).dir, "telegram-deletion-custody.json");

function numericMode(mode: fs.Mode | undefined): number | undefined {
	return typeof mode === "number" ? mode : undefined;
}

function writeMode(options: fs.WriteFileOptions | undefined): number | undefined {
	if (!options || typeof options === "string") return undefined;
	return numericMode(options.mode);
}

class FakeFs implements TelegramCustodyStoreFs {
	readonly files = new Map<string, string>();
	readonly mkdirCalls: { path: string; mode: number | undefined }[] = [];
	readonly chmodCalls: { path: string; mode: number }[] = [];
	readonly writeCalls: { path: string; data: string; mode: number | undefined }[] = [];
	readonly renameCalls: { from: string; to: string }[] = [];
	readonly unlinkCalls: string[] = [];
	failRename = false;
	failWrite = false;

	async mkdir(file: string, options?: fs.MakeDirectoryOptions): Promise<undefined> {
		this.mkdirCalls.push({ path: file, mode: numericMode(options?.mode) });
		return undefined;
	}

	async readFile(file: string): Promise<string> {
		const contents = this.files.get(file);
		if (contents === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return contents;
	}

	async writeFile(file: string, data: string, options?: fs.WriteFileOptions): Promise<void> {
		this.writeCalls.push({ path: file, data, mode: writeMode(options) });
		if (this.failWrite) throw new Error("simulated write failure");
		this.files.set(file, data);
	}

	async chmod(file: string, mode: number): Promise<void> {
		this.chmodCalls.push({ path: file, mode });
	}

	async rename(from: string, to: string): Promise<void> {
		this.renameCalls.push({ from, to });
		if (this.failRename) throw new Error("simulated rename failure");
		const contents = this.files.get(from);
		if (contents === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		this.files.delete(from);
		this.files.set(to, contents);
	}

	async unlink(file: string): Promise<void> {
		this.unlinkCalls.push(file);
		this.files.delete(file);
	}
}

function storeWith(fakeFs: FakeFs): TelegramCustodyStore {
	return new TelegramCustodyStore({ agentDir: AGENT_DIR, fs: fakeFs, now: () => 1 });
}
async function fencedStoreWith(
	fakeFs: FakeFs,
	agentDir: string,
	now: () => number = () => 1,
): Promise<{ binding: TelegramCustodyEpochBinding; store: TelegramCustodyStore }> {
	const binding = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-a" });
	return {
		binding,
		store: new TelegramCustodyStore({
			agentDir,
			fs: fakeFs,
			now,
			fence: { binding },
		}),
	};
}

function dynamicCustodyPath(agentDir: string): string {
	return path.join(daemonPaths(agentDir).dir, "telegram-deletion-custody.json");
}
function custodyRecord(overrides: Partial<TelegramCustodyRecord> = {}): TelegramCustodyRecord {
	return {
		chatId: "42",
		topicId: "77",
		state: "queued",
		updatedAt: 1,
		...overrides,
	};
}

function serialized(fakeFs: FakeFs): { version: number; records: Record<string, TelegramCustodyRecord> } {
	return JSON.parse(fakeFs.files.get(CUSTODY_PATH)!) as {
		version: number;
		records: Record<string, TelegramCustodyRecord>;
	};
}

describe("TelegramCustodyStore", () => {
	test("loads a missing file as an empty writable store", async () => {
		const store = storeWith(new FakeFs());
		expect(await store.load()).toEqual({ mode: "writable", migrated: false, records: [] });
		expect(store.list()).toEqual([]);
	});

	test("round-trips all states with deterministic composite key order and separate chats", async () => {
		const fakeFs = new FakeFs();
		const store = storeWith(fakeFs);
		await store.load();
		await store.put(custodyRecord({ chatId: "2", topicId: "7", state: "queued" }));
		await store.put(custodyRecord({ chatId: "10", topicId: "7", state: "in_flight", custodyEpoch: 2 }));
		await store.put(
			custodyRecord({
				chatId: "2",
				topicId: "1",
				state: "unknown",
				custodyEpoch: 3,
				diagnostic: { kind: "transport_ambiguous", transport: "network" },
			}),
		);
		await store.put(
			custodyRecord({
				chatId: "2",
				topicId: "8",
				state: "confirmed",
				custodyEpoch: 4,
				diagnostic: { kind: "telegram_ok" },
			}),
		);

		expect(Object.keys(serialized(fakeFs).records)).toEqual(["10:7", "2:1", "2:7", "2:8"]);
		expect(serialized(fakeFs).records["10:7"]?.state).toBe("in_flight");
		expect(store.get({ chatId: "2", topicId: "7" })).toEqual(custodyRecord({ chatId: "2", topicId: "7" }));
		expect(store.get({ chatId: "10", topicId: "7" })).toEqual(
			custodyRecord({ chatId: "10", topicId: "7", state: "in_flight", custodyEpoch: 2 }),
		);

		const reader = storeWith(fakeFs);
		const loaded = await reader.load();
		expect(loaded).toEqual({
			mode: "writable",
			migrated: false,
			records: [
				custodyRecord({
					chatId: "10",
					topicId: "7",
					state: "unknown",
					custodyEpoch: 2,
					diagnostic: { kind: "restart_after_claim" },
				}),
				custodyRecord({
					chatId: "2",
					topicId: "1",
					state: "unknown",
					custodyEpoch: 3,
					diagnostic: { kind: "transport_ambiguous", transport: "network" },
				}),
				custodyRecord({ chatId: "2", topicId: "7" }),
				custodyRecord({
					chatId: "2",
					topicId: "8",
					state: "confirmed",
					custodyEpoch: 4,
					diagnostic: { kind: "telegram_ok" },
				}),
			],
		});
		expect(serialized(fakeFs).records["10:7"]).toMatchObject({
			state: "unknown",
			diagnostic: { kind: "restart_after_claim" },
		});
	});

	test("strictly migrates a v1 single-chat record object and preserves an optional epoch", async () => {
		const fakeFs = new FakeFs();
		fakeFs.files.set(
			CUSTODY_PATH,
			JSON.stringify({
				version: 1,
				chatId: "-100123",
				records: {
					"9": { state: "in_flight", updatedAt: 20, custodyEpoch: 3 },
					"2": { state: "queued", updatedAt: 10 },
				},
			}),
		);

		const result = await storeWith(fakeFs).load();
		expect(result).toEqual({
			mode: "writable",
			migrated: true,
			records: [
				custodyRecord({ chatId: "-100123", topicId: "2", updatedAt: 10 }),
				custodyRecord({
					chatId: "-100123",
					topicId: "9",
					state: "unknown",
					updatedAt: 20,
					custodyEpoch: 3,
					diagnostic: { kind: "restart_after_claim" },
				}),
			],
		});
		expect(serialized(fakeFs)).toEqual({
			version: TELEGRAM_CUSTODY_SCHEMA_VERSION,
			records: {
				"-100123:2": custodyRecord({ chatId: "-100123", topicId: "2", updatedAt: 10 }),
				"-100123:9": custodyRecord({
					chatId: "-100123",
					topicId: "9",
					state: "unknown",
					updatedAt: 20,
					custodyEpoch: 3,
					diagnostic: { kind: "restart_after_claim" },
				}),
			},
		});
	});

	test("strictly migrates v2 queued and unknown custody and marks prior claims as unknown", async () => {
		const fakeFs = new FakeFs();
		fakeFs.files.set(
			CUSTODY_PATH,
			JSON.stringify({
				version: 2,
				records: {
					"42:7": custodyRecord({ topicId: "7", state: "in_flight", custodyEpoch: 8 }),
					"42:8": custodyRecord({ topicId: "8", state: "unknown", custodyEpoch: 4 }),
					"42:9": custodyRecord({ topicId: "9", state: "queued" }),
				},
			}),
		);

		const result = await storeWith(fakeFs).load();
		expect(result).toEqual({
			mode: "writable",
			migrated: true,
			records: [
				custodyRecord({
					topicId: "7",
					state: "unknown",
					custodyEpoch: 8,
					diagnostic: { kind: "restart_after_claim" },
				}),
				custodyRecord({
					topicId: "8",
					state: "unknown",
					custodyEpoch: 4,
					diagnostic: { kind: "legacy_unknown" },
				}),
				custodyRecord({ topicId: "9", state: "queued" }),
			],
		});
		expect(serialized(fakeFs)).toMatchObject({
			version: TELEGRAM_CUSTODY_SCHEMA_VERSION,
			records: {
				"42:7": { state: "unknown", diagnostic: { kind: "restart_after_claim" } },
				"42:8": { state: "unknown", diagnostic: { kind: "legacy_unknown" } },
			},
		});
		expect(fakeFs.renameCalls).toHaveLength(1);
	});
	test("converts a recovered v3 claim to restart-after-claim before it can be reused", async () => {
		const fakeFs = new FakeFs();
		fakeFs.files.set(
			CUSTODY_PATH,
			JSON.stringify({
				version: TELEGRAM_CUSTODY_SCHEMA_VERSION,
				records: {
					"42:7": {
						chatId: "42",
						topicId: "7",
						state: "in_flight",
						updatedAt: 1,
						custodyEpoch: 8,
						trigger: "session_closed",
					},
				},
			}),
		);

		const store = storeWith(fakeFs);
		expect(await store.load()).toEqual({
			mode: "writable",
			migrated: false,
			records: [
				custodyRecord({
					topicId: "7",
					state: "unknown",
					custodyEpoch: 8,
					trigger: "session_closed",
					diagnostic: { kind: "restart_after_claim" },
				}),
			],
		});
		expect(await store.claimDeletion({ chatId: "42", topicId: "7" })).toEqual({
			ok: true,
			status: "blocked",
			record: custodyRecord({
				topicId: "7",
				state: "unknown",
				custodyEpoch: 8,
				trigger: "session_closed",
				diagnostic: { kind: "restart_after_claim" },
			}),
		});
		expect(serialized(fakeFs).records["42:7"]).toMatchObject({
			state: "unknown",
			diagnostic: { kind: "restart_after_claim" },
		});
	});

	test("rejects malformed JSON, duplicate members, key mismatches, and unknown states without rewrite", async () => {
		const invalidDocuments = [
			"{ not JSON",
			'{"version":2,"version":2,"records":{}}',
			JSON.stringify({ version: 2, records: { "42:8": custodyRecord({ topicId: "7" }) } }),
			JSON.stringify({ version: 2, records: { "42:7": { ...custodyRecord(), state: "sent" } } }),
		];

		for (const source of invalidDocuments) {
			const fakeFs = new FakeFs();
			fakeFs.files.set(CUSTODY_PATH, source);
			const store = storeWith(fakeFs);
			expect(await store.load()).toEqual({ mode: "read_only", reason: "corrupt", migrated: false, records: [] });
			expect(fakeFs.files.get(CUSTODY_PATH)).toBe(source);
			expect(fakeFs.writeCalls).toHaveLength(0);
			expect(await store.put(custodyRecord())).toEqual({ ok: false, reason: "read_only" });
		}
	});
	test("rejects state-invalid and raw diagnostic shapes without rewriting v3 bytes", async () => {
		const base = { chatId: "42", topicId: "7", updatedAt: 1, custodyEpoch: 1 };
		const invalidRecords: unknown[] = [
			{ ...base, state: "queued", diagnostic: { kind: "legacy_unknown" } },
			{ ...base, state: "confirmed", diagnostic: { kind: "telegram_rejected", rejection: "other" } },
			{ ...base, state: "unknown", diagnostic: { kind: "telegram_ok" } },
			{
				...base,
				state: "unknown",
				diagnostic: { kind: "transport_ambiguous", transport: "network", message: "secret message" },
			},
			{
				...base,
				state: "unknown",
				diagnostic: { kind: "telegram_rejected", rejection: "other", errorCode: "400" },
			},
			{
				...base,
				state: "unknown",
				diagnostic: { kind: "telegram_rejected", rejection: "other", description: "bot-token" },
			},
		];

		for (const record of invalidRecords) {
			const fakeFs = new FakeFs();
			const source = JSON.stringify({ version: TELEGRAM_CUSTODY_SCHEMA_VERSION, records: { "42:7": record } });
			fakeFs.files.set(CUSTODY_PATH, source);
			expect(await storeWith(fakeFs).load()).toEqual({
				mode: "read_only",
				reason: "corrupt",
				migrated: false,
				records: [],
			});
			expect(fakeFs.files.get(CUSTODY_PATH)).toBe(source);
			expect(fakeFs.writeCalls).toHaveLength(0);
		}
	});

	test("rejects invalid IDs, timestamps, epochs, and excess record properties", async () => {
		const invalidRecords: unknown[] = [
			{ chatId: "+1", topicId: "7", state: "queued", updatedAt: 1 },
			{ chatId: "01", topicId: "7", state: "queued", updatedAt: 1 },
			{ chatId: "-0", topicId: "7", state: "queued", updatedAt: 1 },
			{ chatId: "0", topicId: "7", state: "queued", updatedAt: 1 },
			{ chatId: "1".repeat(33), topicId: "7", state: "queued", updatedAt: 1 },
			{ chatId: "1", topicId: "0", state: "queued", updatedAt: 1 },
			{ chatId: "1", topicId: "-7", state: "queued", updatedAt: 1 },
			{ chatId: "1", topicId: "1".repeat(21), state: "queued", updatedAt: 1 },
			{ chatId: "1", topicId: "7", state: "queued", updatedAt: -1 },
			{ chatId: "1", topicId: "7", state: "queued", updatedAt: Number.MAX_SAFE_INTEGER + 1 },
			{ chatId: "1", topicId: "7", state: "queued", updatedAt: 1, custodyEpoch: -1 },
			{ chatId: "1", topicId: "7", state: "queued", updatedAt: 1, unexpected: true },
		];
		for (const record of invalidRecords) {
			const fakeFs = new FakeFs();
			fakeFs.files.set(CUSTODY_PATH, JSON.stringify({ version: 2, records: { "1:7": record } }));
			expect(await storeWith(fakeFs).load()).toEqual({
				mode: "read_only",
				reason: "corrupt",
				migrated: false,
				records: [],
			});
		}

		const writableFs = new FakeFs();
		const writableStore = storeWith(writableFs);
		await writableStore.load();
		await expect(
			writableStore.put({ ...custodyRecord(), topicId: "01" } as unknown as TelegramCustodyRecord),
		).rejects.toThrow("Invalid Telegram custody record");
		await expect(
			writableStore.put({ ...custodyRecord(), custodyEpoch: undefined } as unknown as TelegramCustodyRecord),
		).rejects.toThrow("Invalid Telegram custody record");
		expect(writableFs.writeCalls).toHaveLength(0);
	});

	test("honors the 1,000-record and file-size boundaries without touching oversized source bytes", async () => {
		const exactlyAtLimit = Object.fromEntries(
			Array.from({ length: TELEGRAM_CUSTODY_MAX_RECORDS }, (_, index) => [
				`42:${index + 1}`,
				custodyRecord({ topicId: String(index + 1) }),
			]),
		);
		const validFs = new FakeFs();
		validFs.files.set(CUSTODY_PATH, JSON.stringify({ version: 2, records: exactlyAtLimit }));
		const validStore = storeWith(validFs);
		const validResult = await validStore.load();
		expect(validResult.mode).toBe("writable");
		expect(validResult.records).toHaveLength(TELEGRAM_CUSTODY_MAX_RECORDS);
		const writesBeforeOverLimit = validFs.writeCalls.length;
		await expect(
			validStore.put(custodyRecord({ topicId: String(TELEGRAM_CUSTODY_MAX_RECORDS + 1) })),
		).rejects.toThrow("Telegram custody record limit exceeded");
		expect(validFs.writeCalls).toHaveLength(writesBeforeOverLimit);
		const atFileLimit = JSON.stringify({ version: TELEGRAM_CUSTODY_SCHEMA_VERSION, records: {} });
		const paddedAtLimit = `${atFileLimit}${" ".repeat(TELEGRAM_CUSTODY_MAX_FILE_BYTES - Buffer.byteLength(atFileLimit, "utf8"))}`;
		const fileLimitFs = new FakeFs();
		fileLimitFs.files.set(CUSTODY_PATH, paddedAtLimit);
		expect(await storeWith(fileLimitFs).load()).toEqual({ mode: "writable", migrated: false, records: [] });

		const tooMany = Object.fromEntries(
			Array.from({ length: TELEGRAM_CUSTODY_MAX_RECORDS + 1 }, (_, index) => [
				`42:${index + 1}`,
				custodyRecord({ topicId: String(index + 1) }),
			]),
		);
		for (const source of [
			JSON.stringify({ version: 2, records: tooMany }),
			" ".repeat(TELEGRAM_CUSTODY_MAX_FILE_BYTES + 1),
		]) {
			const fakeFs = new FakeFs();
			fakeFs.files.set(CUSTODY_PATH, source);
			const store = storeWith(fakeFs);
			expect(await store.load()).toEqual({ mode: "read_only", reason: "bounds", migrated: false, records: [] });
			expect(fakeFs.files.get(CUSTODY_PATH)).toBe(source);
			expect(fakeFs.writeCalls).toHaveLength(0);
		}
	});

	test("preserves forward-version bytes and disables mutation", async () => {
		const fakeFs = new FakeFs();
		const source = '{"version":4,"future":"preserve exactly"}\n';
		fakeFs.files.set(CUSTODY_PATH, source);
		const store = storeWith(fakeFs);
		expect(await store.load()).toEqual({
			mode: "read_only",
			reason: "forward_version",
			migrated: false,
			records: [],
		});
		expect(await store.remove({ chatId: "42", topicId: "7" })).toEqual({ ok: false, reason: "read_only" });
		expect(await store.queueDeletion({ chatId: "42", topicId: "7", trigger: "session_closed" })).toEqual({
			ok: false,
			reason: "read_only",
		});
		expect(await store.removeConfirmed({ chatId: "42", topicId: "7" })).toEqual({ ok: true });
		expect(fakeFs.files.get(CUSTODY_PATH)).toBe(source);
		expect(fakeFs.writeCalls).toHaveLength(0);
	});

	test("classifies a failed v1 migration as read-only and does not promote memory to writable", async () => {
		const fakeFs = new FakeFs();
		const source = JSON.stringify({
			version: 1,
			chatId: "42",
			records: { "7": { state: "queued", updatedAt: 1 } },
		});
		fakeFs.files.set(CUSTODY_PATH, source);
		fakeFs.failRename = true;
		const store = storeWith(fakeFs);

		expect(await store.load()).toEqual({
			mode: "read_only",
			reason: "migration_write_failed",
			migrated: false,
			records: [custodyRecord({ topicId: "7" })],
		});
		expect(fakeFs.files.get(CUSTODY_PATH)).toBe(source);
		expect(store.list()).toEqual([custodyRecord({ topicId: "7" })]);
		expect(await store.put(custodyRecord({ topicId: "8" }))).toEqual({ ok: false, reason: "read_only" });
		expect(fakeFs.unlinkCalls).toHaveLength(1);
	});

	test("uses restrictive permissions, same-directory atomic renames, and cleans temporary writes on failure", async () => {
		const fakeFs = new FakeFs();
		const store = storeWith(fakeFs);
		await store.load();
		await store.put(custodyRecord());
		expect(fakeFs.mkdirCalls).toEqual([{ path: daemonPaths(AGENT_DIR).dir, mode: 0o700 }]);
		expect(fakeFs.chmodCalls[0]).toEqual({ path: daemonPaths(AGENT_DIR).dir, mode: 0o700 });
		expect(fakeFs.writeCalls[0]?.mode).toBe(0o600);
		expect(fakeFs.chmodCalls[1]?.mode).toBe(0o600);
		expect(path.dirname(fakeFs.renameCalls[0]!.from)).toBe(path.dirname(fakeFs.renameCalls[0]!.to));

		const before = fakeFs.files.get(CUSTODY_PATH);
		fakeFs.failWrite = true;
		await expect(store.put(custodyRecord({ topicId: "8" }))).rejects.toThrow("simulated write failure");
		expect(store.get({ chatId: "42", topicId: "8" })).toBeUndefined();
		expect(fakeFs.files.get(CUSTODY_PATH)).toBe(before);
		expect([...fakeFs.files.keys()].some(file => file.endsWith(".tmp"))).toBe(false);
		expect(fakeFs.unlinkCalls).toHaveLength(1);
	});

	test("serializes overlapping puts and removes and returns copies from read APIs", async () => {
		const fakeFs = new FakeFs();
		const store = storeWith(fakeFs);
		await store.load();
		const first = store.put(custodyRecord({ topicId: "1" }));
		const second = store.put(custodyRecord({ topicId: "2" }));
		const third = store.remove({ chatId: "42", topicId: "1" });
		expect(await Promise.all([first, second, third])).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
		expect(store.list()).toEqual([custodyRecord({ topicId: "2" })]);

		const fromGet = store.get({ chatId: "42", topicId: "2" })!;
		fromGet.state = "unknown";
		const fromList = store.list()[0]!;
		fromList.state = "unknown";
		expect(store.get({ chatId: "42", topicId: "2" })?.state).toBe("queued");
	});

	test("serializes only custody fields and validates delimiter-safe decimal keys", async () => {
		const fakeFs = new FakeFs();
		const store = storeWith(fakeFs);
		await store.load();
		await store.put(custodyRecord({ chatId: "-100123", topicId: "77", custodyEpoch: 9 }));
		const data = fakeFs.files.get(CUSTODY_PATH)!;
		expect(data).toContain('"-100123:77"');
		expect(data).not.toMatch(/token|session|endpoint|fingerprint|messageText/i);
		expect(telegramCustodyKey("1", "23")).toBe("1:23");
		expect(telegramCustodyKey("12", "3")).toBe("12:3");
		expect(() => telegramCustodyKey("01", "3")).toThrow("Invalid Telegram custody identifier");
	});
	test("queues, claims, settles, and removes only a durable confirmed deletion", async () => {
		const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-custody-store-"));
		try {
			const fakeFs = new FakeFs();
			const { binding, store } = await fencedStoreWith(fakeFs, agentDir);
			await store.load();

			expect(await store.queueDeletion({ chatId: "42", topicId: "77", trigger: "session_closed" })).toEqual({
				ok: true,
				status: "queued",
				record: {
					chatId: "42",
					topicId: "77",
					state: "queued",
					updatedAt: 1,
					custodyEpoch: binding.custodyEpoch,
					trigger: "session_closed",
				},
			});
			expect(await store.claimDeletion({ chatId: "42", topicId: "77" })).toEqual({
				ok: true,
				status: "claimed",
				record: {
					chatId: "42",
					topicId: "77",
					state: "in_flight",
					updatedAt: 1,
					custodyEpoch: binding.custodyEpoch,
					trigger: "session_closed",
				},
			});
			expect(
				await store.settleDeletion({
					chatId: "42",
					topicId: "77",
					diagnostic: { kind: "telegram_ok" },
				}),
			).toEqual({ ok: true });
			expect(store.get({ chatId: "42", topicId: "77" })).toEqual({
				chatId: "42",
				topicId: "77",
				state: "confirmed",
				updatedAt: 1,
				custodyEpoch: binding.custodyEpoch,
				trigger: "session_closed",
				diagnostic: { kind: "telegram_ok" },
			});
			expect(await store.claimDeletion({ chatId: "42", topicId: "77" })).toEqual({
				ok: true,
				status: "blocked",
				record: store.get({ chatId: "42", topicId: "77" })!,
			});
			expect(await store.removeConfirmed({ chatId: "42", topicId: "77" })).toEqual({ ok: true });
			expect(await store.removeConfirmed({ chatId: "42", topicId: "77" })).toEqual({ ok: true });

			const diagnostics: readonly TelegramCustodyDiagnostic[] = [
				{ kind: "telegram_rejected", rejection: "not_found", errorCode: 400 },
				{ kind: "malformed_response" },
				{ kind: "transport_ambiguous", transport: "connection_reset" },
				{ kind: "restart_after_claim" },
				{ kind: "legacy_unknown" },
			];
			for (const [index, diagnostic] of diagnostics.entries()) {
				const topicId = String(80 + index);
				await store.queueDeletion({ chatId: "42", topicId, trigger: "orphan_reap" });
				await store.claimDeletion({ chatId: "42", topicId });
				expect(await store.settleDeletion({ chatId: "42", topicId, diagnostic })).toEqual({ ok: true });
				expect(store.get({ chatId: "42", topicId })).toMatchObject({
					state: "unknown",
					custodyEpoch: binding.custodyEpoch,
					trigger: "orphan_reap",
					diagnostic,
				});
				expect(await store.removeConfirmed({ chatId: "42", topicId })).toEqual({ ok: false, reason: "fenced" });
			}
			expect(fakeFs.files.get(dynamicCustodyPath(agentDir))).not.toMatch(
				/token|description|message|stack|endpoint/i,
			);
		} finally {
			await fsPromises.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("serializes concurrent claims and fences same-owner ABA before every mutation", async () => {
		const concurrentAgentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-custody-store-"));
		try {
			const fakeFs = new FakeFs();
			const { store } = await fencedStoreWith(fakeFs, concurrentAgentDir);
			await store.load();
			await store.queueDeletion({ chatId: "42", topicId: "77", trigger: "session_closed" });
			const claims = await Promise.all(
				Array.from({ length: 4 }, () => store.claimDeletion({ chatId: "42", topicId: "77" })),
			);
			expect(claims.filter(claim => claim.ok && claim.status === "claimed")).toHaveLength(1);
			expect(claims.filter(claim => claim.ok && claim.status === "blocked")).toHaveLength(3);
			expect(store.get({ chatId: "42", topicId: "77" })?.state).toBe("in_flight");
		} finally {
			await fsPromises.rm(concurrentAgentDir, { recursive: true, force: true });
		}

		const abaAgentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-custody-store-"));
		try {
			const fakeFs = new FakeFs();
			const { binding: firstBinding, store: firstStore } = await fencedStoreWith(fakeFs, abaAgentDir);
			const custodyPath = dynamicCustodyPath(abaAgentDir);
			await firstStore.load();
			await firstStore.queueDeletion({ chatId: "42", topicId: "77", trigger: "session_closed" });

			const secondBinding = await allocateTelegramCustodyEpoch({ agentDir: abaAgentDir, ownerId: "owner-a" });
			const beforeOldMutation = fakeFs.files.get(custodyPath);
			const recordsBeforeOldMutation = firstStore.list();
			const writesBeforeOldMutation = fakeFs.writeCalls.length;
			expect(firstBinding.custodyEpoch).toBeLessThan(secondBinding.custodyEpoch);
			expect(await firstStore.queueDeletion({ chatId: "42", topicId: "77", trigger: "orphan_reap" })).toEqual({
				ok: false,
				reason: "fenced",
			});
			expect(await firstStore.claimDeletion({ chatId: "42", topicId: "77" })).toEqual({
				ok: false,
				reason: "fenced",
			});
			expect(fakeFs.files.get(custodyPath)).toBe(beforeOldMutation);
			expect(firstStore.list()).toEqual(recordsBeforeOldMutation);
			expect(fakeFs.writeCalls).toHaveLength(writesBeforeOldMutation);

			const secondStore = new TelegramCustodyStore({
				agentDir: abaAgentDir,
				fs: fakeFs,
				now: () => 2,
				fence: { binding: secondBinding },
			});
			await secondStore.load();
			expect(await secondStore.claimDeletion({ chatId: "42", topicId: "77" })).toMatchObject({
				ok: true,
				status: "claimed",
				record: { custodyEpoch: secondBinding.custodyEpoch },
			});

			await allocateTelegramCustodyEpoch({ agentDir: abaAgentDir, ownerId: "owner-a" });
			const beforeStaleSettle = fakeFs.files.get(custodyPath);
			const recordsBeforeStaleSettle = secondStore.list();
			const writesBeforeStaleSettle = fakeFs.writeCalls.length;
			expect(
				await secondStore.settleDeletion({
					chatId: "42",
					topicId: "77",
					diagnostic: { kind: "telegram_ok" },
				}),
			).toEqual({ ok: false, reason: "fenced" });
			expect(await secondStore.removeConfirmed({ chatId: "42", topicId: "77" })).toEqual({
				ok: false,
				reason: "fenced",
			});
			expect(fakeFs.files.get(custodyPath)).toBe(beforeStaleSettle);
			expect(secondStore.list()).toEqual(recordsBeforeStaleSettle);
			expect(fakeFs.writeCalls).toHaveLength(writesBeforeStaleSettle);
		} finally {
			await fsPromises.rm(abaAgentDir, { recursive: true, force: true });
		}
	});

	test("keeps memory and disk unchanged when guarded queue, claim, settlement, or removal persistence fails", async () => {
		const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-custody-store-"));
		try {
			const fakeFs = new FakeFs();
			const { store } = await fencedStoreWith(fakeFs, agentDir);
			const custodyPath = dynamicCustodyPath(agentDir);
			await store.load();

			fakeFs.failWrite = true;
			await expect(store.queueDeletion({ chatId: "42", topicId: "77", trigger: "session_closed" })).rejects.toThrow(
				"simulated write failure",
			);
			expect(store.get({ chatId: "42", topicId: "77" })).toBeUndefined();
			expect(fakeFs.files.get(custodyPath)).toBeUndefined();

			fakeFs.failWrite = false;
			await store.queueDeletion({ chatId: "42", topicId: "77", trigger: "session_closed" });
			const beforeClaim = fakeFs.files.get(custodyPath);
			fakeFs.failWrite = true;
			await expect(store.claimDeletion({ chatId: "42", topicId: "77" })).rejects.toThrow("simulated write failure");
			expect(store.get({ chatId: "42", topicId: "77" })?.state).toBe("queued");
			expect(fakeFs.files.get(custodyPath)).toBe(beforeClaim);

			fakeFs.failWrite = false;
			await store.claimDeletion({ chatId: "42", topicId: "77" });
			const beforeUnknown = fakeFs.files.get(custodyPath);
			fakeFs.failWrite = true;
			await expect(
				store.settleDeletion({
					chatId: "42",
					topicId: "77",
					diagnostic: { kind: "transport_ambiguous", transport: "timeout" },
				}),
			).rejects.toThrow("simulated write failure");
			expect(store.get({ chatId: "42", topicId: "77" })?.state).toBe("in_flight");
			expect(fakeFs.files.get(custodyPath)).toBe(beforeUnknown);

			fakeFs.failWrite = false;
			await store.queueDeletion({ chatId: "42", topicId: "78", trigger: "orphan_reap" });
			await store.claimDeletion({ chatId: "42", topicId: "78" });
			const beforeConfirmed = fakeFs.files.get(custodyPath);
			fakeFs.failWrite = true;
			await expect(
				store.settleDeletion({
					chatId: "42",
					topicId: "78",
					diagnostic: { kind: "telegram_ok" },
				}),
			).rejects.toThrow("simulated write failure");
			expect(store.get({ chatId: "42", topicId: "78" })?.state).toBe("in_flight");
			expect(fakeFs.files.get(custodyPath)).toBe(beforeConfirmed);

			fakeFs.failWrite = false;
			await store.settleDeletion({ chatId: "42", topicId: "78", diagnostic: { kind: "telegram_ok" } });
			const beforeRemoval = fakeFs.files.get(custodyPath);
			fakeFs.failWrite = true;
			await expect(store.removeConfirmed({ chatId: "42", topicId: "78" })).rejects.toThrow(
				"simulated write failure",
			);
			expect(store.get({ chatId: "42", topicId: "78" })?.state).toBe("confirmed");
			expect(fakeFs.files.get(custodyPath)).toBe(beforeRemoval);
		} finally {
			await fsPromises.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("permits a newer current epoch to perform confirmed local-only cleanup", async () => {
		const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-custody-store-"));
		try {
			const fakeFs = new FakeFs();
			const { store: firstStore } = await fencedStoreWith(fakeFs, agentDir);
			await firstStore.load();
			await firstStore.queueDeletion({ chatId: "42", topicId: "77", trigger: "session_closed" });
			await firstStore.claimDeletion({ chatId: "42", topicId: "77" });
			await firstStore.settleDeletion({ chatId: "42", topicId: "77", diagnostic: { kind: "telegram_ok" } });

			const secondBinding = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-a" });
			const secondStore = new TelegramCustodyStore({
				agentDir,
				fs: fakeFs,
				now: () => 1,
				fence: { binding: secondBinding },
			});
			await secondStore.load();
			expect(await secondStore.claimDeletion({ chatId: "42", topicId: "77" })).toMatchObject({
				ok: true,
				status: "blocked",
				record: { state: "confirmed" },
			});
			expect(await secondStore.removeConfirmed({ chatId: "42", topicId: "77" })).toEqual({ ok: true });
			expect(secondStore.get({ chatId: "42", topicId: "77" })).toBeUndefined();
		} finally {
			await fsPromises.rm(agentDir, { recursive: true, force: true });
		}
	});
	test("requires a positive active fence for new deletion mutations", async () => {
		const fakeFs = new FakeFs();
		const store = storeWith(fakeFs);
		await store.load();
		expect(await store.queueDeletion({ chatId: "42", topicId: "77", trigger: "session_closed" })).toEqual({
			ok: false,
			reason: "fenced",
		});
		expect(await store.claimDeletion({ chatId: "42", topicId: "77" })).toEqual({ ok: false, reason: "fenced" });
		expect(
			await store.settleDeletion({
				chatId: "42",
				topicId: "77",
				diagnostic: { kind: "telegram_ok" },
			}),
		).toEqual({ ok: false, reason: "fenced" });
		expect(fakeFs.writeCalls).toHaveLength(0);
	});
	test("stamps active fence epochs and leaves stale or mismatched writes unchanged", async () => {
		const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-custody-store-"));
		try {
			const fakeFs = new FakeFs();
			const binding = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-a" });
			const custodyPath = path.join(daemonPaths(agentDir).dir, "telegram-deletion-custody.json");
			const store = new TelegramCustodyStore({
				agentDir,
				fs: fakeFs,
				now: () => 1,
				fence: { binding },
			});
			await store.load();

			expect(await store.put(custodyRecord())).toEqual({ ok: true });
			expect(await store.put(custodyRecord({ topicId: "8", custodyEpoch: binding.custodyEpoch }))).toEqual({
				ok: true,
			});
			const stamped = JSON.parse(fakeFs.files.get(custodyPath)!) as {
				records: Record<string, TelegramCustodyRecord>;
			};
			expect(stamped.records["42:77"]?.custodyEpoch).toBe(binding.custodyEpoch);
			expect(stamped.records["42:8"]?.custodyEpoch).toBe(binding.custodyEpoch);

			const beforeMismatch = fakeFs.files.get(custodyPath);
			const recordsBeforeMismatch = store.list();
			const writesBeforeMismatch = fakeFs.writeCalls.length;
			expect(await store.put(custodyRecord({ topicId: "9", custodyEpoch: binding.custodyEpoch + 1 }))).toEqual({
				ok: false,
				reason: "fenced",
			});
			expect(fakeFs.files.get(custodyPath)).toBe(beforeMismatch);
			expect(store.list()).toEqual(recordsBeforeMismatch);
			expect(fakeFs.writeCalls).toHaveLength(writesBeforeMismatch);

			await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-a" });
			const beforeStale = fakeFs.files.get(custodyPath);
			const recordsBeforeStale = store.list();
			const writesBeforeStale = fakeFs.writeCalls.length;
			expect(await store.put(custodyRecord({ topicId: "9" }))).toEqual({ ok: false, reason: "fenced" });
			expect(await store.remove({ chatId: "42", topicId: "77" })).toEqual({ ok: false, reason: "fenced" });
			expect(fakeFs.files.get(custodyPath)).toBe(beforeStale);
			expect(store.list()).toEqual(recordsBeforeStale);
			expect(fakeFs.writeCalls).toHaveLength(writesBeforeStale);
		} finally {
			await fsPromises.rm(agentDir, { recursive: true, force: true });
		}
	});
});
