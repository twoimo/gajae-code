import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildReceipt } from "./combined-natural-exit-child";

const CHILD_TEST_TIMEOUT_MS = 30_000;
const WALL_TIMEOUT_MS = 120_000;
const OUTPUT_BYTE_LIMIT = 1_048_576;

interface StreamSummary {
	byteCount: number;
	truncated: boolean;
}

async function summarizeStream(stream: ReadableStream<Uint8Array> | null): Promise<StreamSummary> {
	if (!stream) return { byteCount: 0, truncated: false };
	const reader = stream.getReader();
	let byteCount = 0;
	let truncated = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			byteCount += value.byteLength;
			if (byteCount > OUTPUT_BYTE_LIMIT) truncated = true;
		}
	} finally {
		reader.releaseLock();
	}

	return { byteCount, truncated };
}

function isPidDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

it("runs four visible-session suites in a child and exits naturally", async () => {
	const repoRoot = path.resolve(import.meta.dir, "../../../..");
	const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-natural-exit-"));
	const receiptPath = path.join(tmpRoot, "combined-natural-exit-receipt.json");
	const childScript = path.join(import.meta.dir, "combined-natural-exit-child.ts");
	let child: ReturnType<typeof Bun.spawn> | undefined;

	try {
		child = Bun.spawn(
			[
				process.execPath,
				childScript,
				"--child",
				`--receipt=${receiptPath}`,
				`--tmp-root=${tmpRoot}`,
				`--repo-root=${repoRoot}`,
				`--timeout-ms=${CHILD_TEST_TIMEOUT_MS}`,
			],
			{
				cwd: repoRoot,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					TMPDIR: tmpRoot,
					TMP: tmpRoot,
					TEMP: tmpRoot,
				},
			},
		);

		const childTimedOut = Promise.withResolvers<true>();
		const wallTimeout = setTimeout(() => childTimedOut.resolve(true), WALL_TIMEOUT_MS);
		const childStdout = summarizeStream(child.stdout as ReadableStream<Uint8Array>);
		const childStderr = summarizeStream(child.stderr as ReadableStream<Uint8Array>);

		const timedOut = await Promise.race([
			child.exited.then(() => false as const),
			childTimedOut.promise.then(() => true as const),
		]);
		clearTimeout(wallTimeout);

		if (timedOut) {
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
		const exitCode = await child.exited.catch(() => 1);
		const childSignal = ((child as { signalCode?: string | null }).signalCode ?? null) as string | null;
		const [stdout, stderr] = await Promise.all([childStdout, childStderr]);
		const receiptText = await fs.readFile(receiptPath, "utf8");
		const receipt = JSON.parse(receiptText) as ChildReceipt;

		expect(timedOut).toBe(false);
		expect(exitCode).toBe(0);
		expect(childSignal).toBeNull();

		expect(receipt.childPid).toBe(child.pid);
		expect(receipt.childExitCode).toBe(0);
		expect(receipt.childSignal).toBeNull();
		expect(receipt.timedOut).toBe(false);
		expect(receipt.failures).toBe(0);
		expect(receipt.listenerDeltas.stdin).toEqual({});
		expect(receipt.listenerDeltas.stdout).toEqual({});
		expect(receipt.terminal.baselineHash).toBe(receipt.terminal.afterHash);
		expect(isPidDead(receipt.childPid)).toBe(true);
		expect(receipt.stdout.byteCount).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);
		expect(receipt.stderr.byteCount).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);
		expect(stdout.byteCount).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);
		expect(stderr.byteCount).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);

		for (const endpoint of receipt.endpoints) {
			expect(endpoint.status === "absent" || endpoint.status === "refused").toBe(true);
			expect(endpoint.pathHash).toMatch(/^[0-9a-f]{64}$/);
		}
	} finally {
		if (child) {
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
			await child.exited.catch(() => undefined);
		}
		await fs.rm(tmpRoot, { recursive: true, force: true });
	}
});
