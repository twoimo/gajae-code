import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

type ControlTestProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;
type EndpointState = "absent" | "refused" | "connected";

const CHILD_COMMAND_TIMEOUT_MS = 30_000;
const WALL_TIMEOUT_MS = 110_000;
const OUTPUT_BYTE_LIMIT = 1_048_576;
const ENDPOINT_PROBE_TIMEOUT_MS = 5_000;

interface StreamSummary {
	byteCount: number;
	exceeded: boolean;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function stopChild(child: ControlTestProcess): void {
	if (child.exitCode === null) child.kill("SIGKILL");
}

async function drainBounded(stream: ReadableStream<Uint8Array>, child: ControlTestProcess): Promise<StreamSummary> {
	const reader = stream.getReader();
	let byteCount = 0;
	let exceeded = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = OUTPUT_BYTE_LIMIT - byteCount;
			byteCount += Math.min(value.byteLength, Math.max(remaining, 0));
			if (value.byteLength > remaining && !exceeded) {
				exceeded = true;
				stopChild(child);
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { byteCount, exceeded };
}

async function discoverControlEndpoints(directory: string): Promise<string[]> {
	const endpoints: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) endpoints.push(...(await discoverControlEndpoints(entryPath)));
		else if (entry.name === "control-v1.sock") endpoints.push(entryPath);
	}
	return endpoints;
}

async function endpointState(endpoint: string): Promise<EndpointState> {
	try {
		await fs.lstat(endpoint);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "absent";
		throw error;
	}

	const deferred = Promise.withResolvers<EndpointState>();
	const socket = net.createConnection({ path: endpoint });
	const timeout = setTimeout(() => {
		socket.destroy();
		deferred.reject(new Error("control_endpoint_probe_timeout"));
	}, ENDPOINT_PROBE_TIMEOUT_MS);
	const finish = (state: EndpointState): void => {
		clearTimeout(timeout);
		socket.destroy();
		deferred.resolve(state);
	};
	socket.once("connect", () => finish("connected"));
	socket.once("error", error => {
		const code = errorCode(error);
		if (code === "ENOENT") finish("absent");
		else if (code === "ECONNREFUSED") finish("refused");
		else {
			clearTimeout(timeout);
			socket.destroy();
			deferred.reject(error);
		}
	});
	return deferred.promise;
}

function isPidAbsent(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return errorCode(error) === "ESRCH";
	}
}

it(
	"runs only the control suites in a child and exits naturally",
	async () => {
		const repoRoot = path.resolve(import.meta.dir, "../../../..");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-control-natural-exit-"));
		let child: ControlTestProcess | undefined;
		let output: Promise<[StreamSummary, StreamSummary]> | undefined;
		let wallTimeout: NodeJS.Timeout | undefined;

		try {
			child = Bun.spawn(
				[
					process.execPath,
					"test",
					"--timeout",
					`${CHILD_COMMAND_TIMEOUT_MS}`,
					"packages/coding-agent/src/visible-session/control-protocol.test.ts",
					"packages/coding-agent/src/visible-session/control-transport.test.ts",
				],
				{
					cwd: repoRoot,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
				},
			);
			const childPid = child.pid;
			output = Promise.all([drainBounded(child.stdout, child), drainBounded(child.stderr, child)]);
			const timedOut = Promise.withResolvers<true>();
			wallTimeout = setTimeout(() => timedOut.resolve(true), WALL_TIMEOUT_MS);
			const timeout = await Promise.race([
				child.exited.then(() => false as const),
				timedOut.promise,
			]);
			clearTimeout(wallTimeout);
			wallTimeout = undefined;
			if (timeout) stopChild(child);

			const exitCode = await child.exited;
			const [stdout, stderr] = await output;
			output = undefined;
			const endpoints = await discoverControlEndpoints(tempRoot);
			const endpointStates = await Promise.all(endpoints.map(endpointState));

			expect(timeout).toBe(false);
			expect(exitCode).toBe(0);
			expect(child.signalCode).toBeNull();
			expect(isPidAbsent(childPid)).toBe(true);
			expect(stdout.exceeded).toBe(false);
			expect(stderr.exceeded).toBe(false);
			expect(stdout.byteCount).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);
			expect(stderr.byteCount).toBeLessThanOrEqual(OUTPUT_BYTE_LIMIT);
			expect(endpointStates.every(state => state === "absent" || state === "refused")).toBe(true);
		} finally {
			if (wallTimeout) clearTimeout(wallTimeout);
			if (child) {
				stopChild(child);
				await child.exited;
			}
			if (output) await output;
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	},
	WALL_TIMEOUT_MS + 10_000,
);
