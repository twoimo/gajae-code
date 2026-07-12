import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DurableFsOutcomeCode, fsyncDirectory, publishCreateFile, publishReplaceFile } from "../native/index.js";

const temporaryDirectories: string[] = [];
const windowsIt = process.platform === "win32" ? it : it.skip;

async function holdTargetExclusively(target: string, milliseconds: number): Promise<Bun.Subprocess> {
	const script = [
		"$handle = [System.IO.File]::Open($args[0], 'Open', 'ReadWrite', 'None')",
		"[Console]::Out.WriteLine('ready')",
		`Start-Sleep -Milliseconds ${milliseconds}`,
		"$handle.Dispose()",
	].join("; ");
	const process = Bun.spawn(["powershell", "-NoProfile", "-Command", script, target], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = process.stdout.getReader();
	const { value, done } = await reader.read();
	reader.releaseLock();
	if (done || new TextDecoder().decode(value).trim() !== "ready") {
		const stderr = await new Response(process.stderr).text();
		throw new Error(`could not hold target exclusively: ${stderr}`);
	}
	return process;
}

async function waitForExit(process: Bun.Subprocess): Promise<void> {
	expect(await process.exited).toBe(0);
}

async function createTemporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-durable-fs-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("durable filesystem primitives", () => {
	it("publishes a flushed replacement and preserves the requested backup", async () => {
		const directory = await createTemporaryDirectory();
		const target = path.join(directory, "manifest");
		const replacement = path.join(directory, "manifest.next");
		const backup = path.join(directory, "manifest.backup");
		await fs.writeFile(target, "previous generation");
		await fs.writeFile(replacement, "published generation");

		const outcome = publishReplaceFile(replacement, target, backup);

		expect(outcome).toEqual({
			ok: true,
			code: DurableFsOutcomeCode.Ok,
			osCode: 0,
			operation: process.platform === "win32" ? "ReplaceFileW" : "publish replacement",
		});
		expect(await Bun.file(target).text()).toBe("published generation");
		expect(await Bun.file(backup).text()).toBe("previous generation");
		expect(await Bun.file(replacement).exists()).toBe(false);
	});

	it("win32 first-publication create installs a durable target without ReplaceFileW", async () => {
		const directory = await createTemporaryDirectory();
		const target = path.join(directory, "manifest");
		const replacement = path.join(directory, "manifest.next");
		await fs.writeFile(replacement, "first generation");
		const outcome = publishCreateFile(replacement, target);
		expect(outcome).toMatchObject({ ok: true, code: DurableFsOutcomeCode.Ok, operation: "create target" });
		expect(await Bun.file(target).text()).toBe("first generation");
		expect(await Bun.file(replacement).exists()).toBe(false);
	});

	it("returns a structured missing-target outcome without parsing an error message", async () => {
		const directory = await createTemporaryDirectory();
		const replacement = path.join(directory, "manifest.next");
		await fs.writeFile(replacement, "published generation");

		const outcome = publishReplaceFile(replacement, path.join(directory, "missing"));

		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe(DurableFsOutcomeCode.TargetMissing);
		expect(outcome.osCode).toBeNumber();
		expect(outcome.operation).toBe("stat target");
		expect(await Bun.file(replacement).text()).toBe("published generation");
	});

	it("rejects cross-directory publication with a stable outcome", async () => {
		const sourceDirectory = await createTemporaryDirectory();
		const targetDirectory = await createTemporaryDirectory();
		const target = path.join(targetDirectory, "manifest");
		const replacement = path.join(sourceDirectory, "manifest.next");
		await fs.writeFile(target, "previous generation");
		await fs.writeFile(replacement, "published generation");

		expect(publishReplaceFile(replacement, target)).toEqual({
			ok: false,
			code: DurableFsOutcomeCode.CrossDirectoryUnsupported,
			osCode: 0,
			operation: "validate publication directories",
		});
		expect(await Bun.file(target).text()).toBe("previous generation");
		expect(await Bun.file(replacement).text()).toBe("published generation");
	});

	windowsIt("returns a sharing violation while another process holds the target exclusively", async () => {
		const directory = await createTemporaryDirectory();
		const target = path.join(directory, "manifest");
		const replacement = path.join(directory, "manifest.next");
		await fs.writeFile(target, "previous generation");
		await fs.writeFile(replacement, "published generation");
		const holder = await holdTargetExclusively(target, 1_000);
		try {
			const result = publishReplaceFile(replacement, target);
			expect(result).toMatchObject({
				ok: false,
				code: DurableFsOutcomeCode.SharingViolation,
				osCode: 32,
				operation: "ReplaceFileW",
			});
			expect(await Bun.file(target).text()).toBe("previous generation");
			expect(await Bun.file(replacement).text()).toBe("published generation");
		} finally {
			await waitForExit(holder);
		}
	});

	windowsIt("does not wait through a delayed exclusive-handle close before publishing", async () => {
		const directory = await createTemporaryDirectory();
		const target = path.join(directory, "manifest");
		const replacement = path.join(directory, "manifest.next");
		await fs.writeFile(target, "previous generation");
		await fs.writeFile(replacement, "published generation");
		const holder = await holdTargetExclusively(target, 1_000);
		try {
			expect(publishReplaceFile(replacement, target)).toMatchObject({
				ok: false,
				code: DurableFsOutcomeCode.SharingViolation,
			});
		} finally {
			await waitForExit(holder);
		}
		expect(publishReplaceFile(replacement, target)).toMatchObject({ ok: true, code: DurableFsOutcomeCode.Ok });
		expect(await Bun.file(target).text()).toBe("published generation");
	});

	windowsIt("native fault injection exposes documented ReplaceFileW partial on-disk states", async () => {
		const directory = await createTemporaryDirectory();
		for (const [code, expected] of [
			["1175", { target: "previous", replacement: "next", backup: false }],
			["1176", { target: false, replacement: "next", backup: "previous" }],
			["1177", { target: "next", replacement: false, backup: "previous" }],
		] as const) {
			const target = path.join(directory, `target-${code}`);
			const replacement = path.join(directory, `replacement-${code}`);
			const backup = path.join(directory, `backup-${code}`);
			await fs.writeFile(target, "previous");
			await fs.writeFile(replacement, "next");
			process.env.PI_NATIVES_DURABLE_FS_TEST_FAULT = code;
			try {
				const result = publishReplaceFile(replacement, target, backup);
				expect(result.osCode).toBe(Number(code));
				for (const [file, contents] of [
					[target, expected.target],
					[replacement, expected.replacement],
					[backup, expected.backup],
				] as const) {
					if (contents === false) expect(await Bun.file(file).exists()).toBe(false);
					else expect(await Bun.file(file).text()).toBe(contents);
				}
			} finally {
				delete process.env.PI_NATIVES_DURABLE_FS_TEST_FAULT;
			}
		}
	});

	windowsIt("native post-ReplaceFileW durability fault preserves the published identities", async () => {
		const directory = await createTemporaryDirectory();
		const target = path.join(directory, "target-durability");
		const replacement = path.join(directory, "replacement-durability");
		const backup = path.join(directory, "backup-durability");
		await fs.writeFile(target, "previous");
		await fs.writeFile(replacement, "next");
		process.env.PI_NATIVES_DURABLE_FS_TEST_FAULT = "durability";
		try {
			const result = publishReplaceFile(replacement, target, backup);
			expect(result.code).toBe(DurableFsOutcomeCode.PublishedDurabilityUncertain);
			expect(await Bun.file(target).text()).toBe("next");
			expect(await Bun.file(replacement).exists()).toBe(false);
			expect(await Bun.file(backup).text()).toBe("previous");
		} finally {
			delete process.env.PI_NATIVES_DURABLE_FS_TEST_FAULT;
		}
	});

	it("flushes a directory through the cross-platform primitive", async () => {
		const directory = await createTemporaryDirectory();
		fsyncDirectory(directory);
	});
});
