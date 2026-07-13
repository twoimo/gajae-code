import { describe, expect, test } from "bun:test";
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	allocateTelegramCustodyEpoch,
	TELEGRAM_CUSTODY_EPOCH_MAX_FILE_BYTES,
	TelegramCustodyEpochError,
	type TelegramCustodyEpochFs,
	telegramCustodyEpochPath,
	readTelegramCustodyEpoch,
	withCurrentTelegramCustodyEpoch,
} from "./telegram-custody-epoch";

class FailingEpochFs implements TelegramCustodyEpochFs {
	readonly #delegate: TelegramCustodyEpochFs = fs as unknown as TelegramCustodyEpochFs;
	readonly chmodCalls: { file: string; mode: number }[] = [];
	readonly renameCalls: { from: string; to: string }[] = [];
	readonly writeCalls: { file: string; mode: number | undefined }[] = [];
	readonly openCalls: { file: string; flags: string }[] = [];
	failWrite = false;
	failRename = false;
	failSyncAt: number | undefined;
	failSyncCode: string | undefined;
	#syncCalls = 0;

	async mkdir(file: string, options?: nodeFs.MakeDirectoryOptions): Promise<unknown> {
		return this.#delegate.mkdir(file, options);
	}

	async readFile(file: string, encoding: BufferEncoding): Promise<string> {
		return this.#delegate.readFile(file, encoding);
	}

	async writeFile(file: string, data: string, options?: nodeFs.WriteFileOptions): Promise<void> {
		this.writeCalls.push({
			file,
			mode: typeof options === "object" && options !== null ? (options.mode as number | undefined) : undefined,
		});
		if (this.failWrite) throw new Error("simulated write failure");
		await this.#delegate.writeFile(file, data, options);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		this.renameCalls.push({ from: oldPath, to: newPath });
		if (this.failRename) throw new Error("simulated rename failure");
		await this.#delegate.rename(oldPath, newPath);
	}

	async chmod(file: string, mode: number): Promise<void> {
		this.chmodCalls.push({ file, mode });
		await this.#delegate.chmod(file, mode);
	}

	async unlink(file: string): Promise<void> {
		await this.#delegate.unlink(file);
	}

	async open(file: string, flags: string, mode?: number): Promise<{ sync(): Promise<void>; close(): Promise<void> }> {
		this.openCalls.push({ file, flags });
		const handle = await this.#delegate.open(file, flags, mode);
		return {
			sync: async () => {
				this.#syncCalls++;
				if (this.#syncCalls === this.failSyncAt) {
					throw Object.assign(new Error("simulated sync failure"), { code: this.failSyncCode });
				}
				await handle.sync();
			},
			close: async () => handle.close(),
		};
	}
}

async function withAgentDirectory(operation: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-custody-epoch-"));
	try {
		await operation(agentDir);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

async function expectFailure(
	operation: Promise<unknown>,
	reason: TelegramCustodyEpochError["reason"],
): Promise<void> {
	await expect(operation).rejects.toMatchObject({ name: "TelegramCustodyEpochError", reason });
}

describe("Telegram custody epoch", () => {
	test("allocates durable positive epochs monotonically across restarts", async () => {
		await withAgentDirectory(async agentDir => {
			const first = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-a" });
			const second = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-b" });

			expect(first).toEqual({ ownerId: "owner-a", custodyEpoch: 1 });
			expect(second).toEqual({ ownerId: "owner-b", custodyEpoch: 2 });
			expect(await readTelegramCustodyEpoch({ agentDir })).toEqual(second);
		});
	});

	test("serializes concurrent contenders into unique monotonically increasing bindings", async () => {
		await withAgentDirectory(async agentDir => {
			const bindings = await Promise.all(
				["owner-a", "owner-b", "owner-c", "owner-d", "owner-e"].map(ownerId =>
					allocateTelegramCustodyEpoch({ agentDir, ownerId }),
				),
			);

			expect(bindings.map(binding => binding.custodyEpoch).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
			expect(new Set(bindings.map(binding => binding.ownerId))).toEqual(
				new Set(["owner-a", "owner-b", "owner-c", "owner-d", "owner-e"]),
			);
		});
	});

	test("fences stale bindings, including owner-id ABA reuse", async () => {
		await withAgentDirectory(async agentDir => {
			const first = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-a" });
			const second = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-b" });
			const third = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-a" });
			let called = false;

			expect(await withCurrentTelegramCustodyEpoch({ agentDir, binding: first }, async () => {
				called = true;
			})).toEqual({ ok: false, reason: "fenced" });
			expect(await withCurrentTelegramCustodyEpoch({ agentDir, binding: second }, async () => undefined)).toEqual({
				ok: false,
				reason: "fenced",
			});
			expect(await withCurrentTelegramCustodyEpoch({ agentDir, binding: third }, async () => "current")).toEqual({
				ok: true,
				value: "current",
			});
			expect(called).toBe(false);
		});
	});

	test("rejects malformed, duplicate, extra, invalid, forward, and oversized snapshots without rewriting bytes", async () => {
		await withAgentDirectory(async agentDir => {
			const epochPath = telegramCustodyEpochPath(agentDir);
			const corruptSources = [
				"{ not json",
				'{"version":1,"version":1,"custodyEpoch":1,"ownerId":"owner"}',
				'{"version":1,"custodyEpoch":1,"ownerId":"owner","extra":true}',
				'{"version":1,"custodyEpoch":1}',
				'{"version":0,"custodyEpoch":1,"ownerId":"owner"}',
				'{"version":1.5,"custodyEpoch":1,"ownerId":"owner"}',
				'{"version":1,"custodyEpoch":0,"ownerId":"owner"}',
				'{"version":1,"custodyEpoch":-1,"ownerId":"owner"}',
				'{"version":1,"custodyEpoch":1.5,"ownerId":"owner"}',
				`{"version":1,"custodyEpoch":${Number.MAX_SAFE_INTEGER + 1},"ownerId":"owner"}`,
				'{"version":1,"custodyEpoch":1,"ownerId":""}',
				" ".repeat(TELEGRAM_CUSTODY_EPOCH_MAX_FILE_BYTES + 1),
			];
			for (const source of corruptSources) {
				await fs.mkdir(path.dirname(epochPath), { recursive: true });
				await fs.writeFile(epochPath, source);
				await expectFailure(readTelegramCustodyEpoch({ agentDir }), "corrupt");
				await expectFailure(allocateTelegramCustodyEpoch({ agentDir, ownerId: "next-owner" }), "corrupt");
				expect(await fs.readFile(epochPath, "utf8")).toBe(source);
			}

			const forward = '{"version":2,"custodyEpoch":1,"ownerId":"owner"}';
			await fs.writeFile(epochPath, forward);
			await expectFailure(readTelegramCustodyEpoch({ agentDir }), "forward_version");
			await expectFailure(allocateTelegramCustodyEpoch({ agentDir, ownerId: "next-owner" }), "forward_version");
			expect(await fs.readFile(epochPath, "utf8")).toBe(forward);
		});
	});
	test("rejects an oversized owner allocation before publishing a target or temporary file", async () => {
		await withAgentDirectory(async agentDir => {
			const epochPath = telegramCustodyEpochPath(agentDir);
			const fakeFs = new FailingEpochFs();

			await expectFailure(
				allocateTelegramCustodyEpoch({
					agentDir,
					ownerId: "x".repeat(TELEGRAM_CUSTODY_EPOCH_MAX_FILE_BYTES),
					fs: fakeFs,
				}),
				"corrupt",
			);

			await expect(fs.access(epochPath)).rejects.toMatchObject({ code: "ENOENT" });
			expect(fakeFs.writeCalls).toEqual([]);
			expect((await fs.readdir(path.dirname(epochPath))).some(entry => entry.endsWith(".tmp"))).toBe(false);
		});
	});

	test("preserves an exhausted source and does not reset or reuse its epoch", async () => {
		await withAgentDirectory(async agentDir => {
			const epochPath = telegramCustodyEpochPath(agentDir);
			const source = `{"version":1,"custodyEpoch":${Number.MAX_SAFE_INTEGER},"ownerId":"owner"}\n`;
			await fs.mkdir(path.dirname(epochPath), { recursive: true });
			await fs.writeFile(epochPath, source);

			await expectFailure(allocateTelegramCustodyEpoch({ agentDir, ownerId: "next-owner" }), "exhausted");
			expect(await fs.readFile(epochPath, "utf8")).toBe(source);
		});
	});

	test("uses same-directory 0600 temporary writes and never returns a binding after write barriers fail", async () => {
		await withAgentDirectory(async agentDir => {
			const epochPath = telegramCustodyEpochPath(agentDir);
			for (const failure of ["write", "temp-sync", "rename", "target-sync", "target-sync-eperm"] as const) {
				const fakeFs = new FailingEpochFs();
				if (failure === "write") fakeFs.failWrite = true;
				if (failure === "rename") fakeFs.failRename = true;
				if (failure === "temp-sync") fakeFs.failSyncAt = 1;
				if (failure === "target-sync" || failure === "target-sync-eperm") {
					fakeFs.failSyncAt = 2;
					fakeFs.failSyncCode = failure === "target-sync-eperm" ? "EPERM" : undefined;
				}
				await expect(allocateTelegramCustodyEpoch({ agentDir, ownerId: `owner-${failure}`, fs: fakeFs })).rejects.toThrow(
					"simulated",
				);
				const entries = await fs.readdir(path.dirname(epochPath));
				expect(entries.some(entry => entry.endsWith(".tmp"))).toBe(false);
			}

			const fakeFs = new FailingEpochFs();
			const binding = await allocateTelegramCustodyEpoch({ agentDir, ownerId: "owner-ok", fs: fakeFs });
			expect(binding.custodyEpoch).toBeGreaterThan(0);
			expect(fakeFs.writeCalls[0]?.mode).toBe(0o600);
			expect(fakeFs.chmodCalls.some(call => call.file !== path.dirname(epochPath) && call.mode === 0o600)).toBe(true);
			expect(path.dirname(fakeFs.renameCalls[0]!.from)).toBe(path.dirname(fakeFs.renameCalls[0]!.to));
			expect(fakeFs.openCalls.map(call => call.flags)).toEqual(["r+", "r+", "r"]);
		});
	});
});
