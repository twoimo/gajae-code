import { describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { controlEndpointFor, LocalControlServer } from "./control-server";
import { type VisibleSessionOwnerManifest, writeVisibleSessionOwnerManifest } from "./launch";
import { runVisibleSessionOwner } from "./owner";
import { VisibleSessionRegistry } from "./registry";
import { DEFAULT_PUBLIC_LOG_CAP_BYTES } from "./state";

setDefaultTimeout(30_000);
const cleanGitDirty = async (): Promise<{ exitCode: number; stdout: string }> => ({ exitCode: 0, stdout: "" });

async function withTempDir<T>(callback: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-owner-"));
	try {
		return await callback(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

class FakeControlServer {
	listened = false;
	closed = false;
	closeCalls = 0;
	closeFailure: Error | undefined;
	constructor(
		readonly options: {
			handler: (request: never, context: never) => Promise<unknown>;
			onFatalError?: (error: Error) => void;
		},
	) {}
	async listen(): Promise<void> {
		this.listened = true;
	}
	async close(): Promise<void> {
		this.closeCalls += 1;
		this.closed = true;
		if (this.closeFailure) throw this.closeFailure;
	}
	emitFatal(error: Error): void {
		this.options.onFatalError?.(error);
	}
}

class FakePty {
	options: unknown;
	writes: Array<string | Uint8Array> = [];
	resizes: Array<[number, number]> = [];
	killed = false;
	killCalls = 0;
	started = false;
	#onChunk: ((error: Error | null, chunk: string) => void) | undefined;
	writeFailure: Error | undefined;
	startFailure: Error | undefined;
	killFailure: Error | undefined;
	#done = Promise.withResolvers<{ exitCode?: number; cancelled: boolean; timedOut: boolean }>();
	constructor(readonly emitOnStart = true) {}
	async start(
		options: unknown,
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<{ exitCode?: number; cancelled: boolean; timedOut: boolean }> {
		this.options = options;
		this.started = true;
		this.#onChunk = onChunk;
		if (this.startFailure) throw this.startFailure;
		if (this.emitOnStart) {
			onChunk?.(null, "first");
			onChunk?.(null, "second");
		}
		return this.#done.promise;
	}
	emit(chunk: string): void {
		this.#onChunk?.(null, chunk);
	}
	emitError(error: Error): void {
		this.#onChunk?.(error, "");
	}
	write(data: string | Uint8Array): void {
		if (this.writeFailure) throw this.writeFailure;
		this.writes.push(data);
	}
	resize(columns: number, rows: number): void {
		this.resizes.push([columns, rows]);
	}
	kill(): void {
		this.killed = true;
		this.killCalls += 1;
		if (this.killFailure) throw this.killFailure;
	}
	finish(result: { exitCode?: number; cancelled: boolean; timedOut: boolean }): void {
		this.#done.resolve(result);
	}
}
async function waitForControlServer(
	getServer: () => FakeControlServer | undefined,
	timeoutMs = 10_000,
): Promise<FakeControlServer> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const server = getServer();
		if (server?.listened) return server;
		if (Date.now() >= deadline) throw new Error("control server did not become ready");
		await Bun.sleep(1);
	}
}

async function activeManifest(
	directory: string,
	pid: number,
): Promise<{ manifest: VisibleSessionOwnerManifest; registry: VisibleSessionRegistry }> {
	const agentDir = path.join(directory, "agent");
	const repository = path.join(directory, "repo");
	const worktree = path.join(directory, "worktree");
	await Promise.all([fs.mkdir(agentDir), fs.mkdir(repository), fs.mkdir(worktree)]);
	const gitInit = Bun.spawnSync(["git", "init", worktree]);
	if (gitInit.exitCode !== 0) throw new Error("test worktree initialization failed");
	const registry = new VisibleSessionRegistry({ agentDir });
	await registry.initialize();
	const prepared = await registry.create({ name: "alpha", repository, worktree, backend: "conpty" });
	const createdAt = new Date().toISOString();
	await registry.activateOwner({
		expectedRevision: prepared.revision,
		generationId: prepared.generation.generationId,
		startIdentity: prepared.generation.startIdentity,
		process: { pid, startedAt: createdAt, hostname: os.hostname() },
	});
	const generation = (await registry.read()).entries[0]?.active;
	if (generation?.status !== "active") throw new Error("test registry activation failed");
	const manifest: VisibleSessionOwnerManifest = {
		schemaVersion: 3,
		generationId: generation.generationId,
		startIdentity: generation.startIdentity,
		leaseId: generation.leaseId,
		agentDir,
		name: "alpha",
		key: "alpha",
		repo: repository,
		worktree,
		backend: "conpty",
		publicRoot: generation.publicRoot,
		privateRoot: generation.privateRoot,
		tokenFilePath: generation.tokenFilePath,
		controlEndpoint: controlEndpointFor({
			privateGenerationRoot: generation.privateRoot,
			generation: generation.generationId,
		}),
		executable: process.execPath,
		args: ["-e", "process.exit(0)"],
		cwd: worktree,
		env: { OWNER_TEST_SECRET: "secret-env" },
		ownerReadyDeadline: new Date(Date.now() + 60_000).toISOString(),
		createdAt,
		branch: "main",
		worktreeBaselineDirty: false,
		runtimeStatePath: path.join(generation.privateRoot, "runtime-state.json"),
		ownerRoleArgv: ["visible-session", "owner-internal", "--manifest", generation.manifestFilePath],
	};
	await writeVisibleSessionOwnerManifest(generation.manifestFilePath, manifest);
	return { manifest, registry };
}

describe.serial("visible-session owner", () => {
	it("refuses a registry process timestamp that does not match the manifest", async () => {
		await withTempDir(async directory => {
			const pid = 9181;
			const { manifest, registry } = await activeManifest(directory, pid);
			const snapshot = await registry.read();
			const process = snapshot.entries[0]?.active.process;
			if (!process) throw new Error("test registry process identity is missing");
			process.startedAt = "2025-01-01T00:00:00.000Z";
			let clock = Date.parse(manifest.ownerReadyDeadline) - 1;
			await expect(
				runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry: { read: async () => snapshot },
					pid,
					now: () => clock,
					sleep: async milliseconds => {
						clock += milliseconds;
					},
					installSignalHandlers: false,
				}),
			).rejects.toThrow("registry identity is not active");
		});
	});
	it("refuses a registry process hostname that does not match the current host", async () => {
		await withTempDir(async directory => {
			const pid = 9180;
			const { manifest, registry } = await activeManifest(directory, pid);
			const snapshot = await registry.read();
			const process = snapshot.entries[0]?.active.process;
			if (!process) throw new Error("test registry process identity is missing");
			process.hostname = `${os.hostname()}-mismatch`;
			let clock = Date.parse(manifest.ownerReadyDeadline) - 1;
			await expect(
				runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry: { read: async () => snapshot },
					pid,
					now: () => clock,
					sleep: async milliseconds => {
						clock += milliseconds;
					},
					installSignalHandlers: false,
				}),
			).rejects.toThrow("registry identity is not active");
		});
	});
	it("rejects control tokens outside the exact 32-byte boundary", async () => {
		for (const length of [31, 33]) {
			await withTempDir(async directory => {
				const pid = 9179;
				const { manifest, registry } = await activeManifest(directory, pid);
				await fs.writeFile(manifest.tokenFilePath, Buffer.alloc(length));
				await expect(
					runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
						registry,
						pid,
						installSignalHandlers: false,
					}),
				).rejects.toThrow("control token must be exactly 32 bytes");
			});
		}
	});
	it("rejects control tokens that change during bounded ingestion", async () => {
		await withTempDir(async directory => {
			const pid = 9178;
			const { manifest, registry } = await activeManifest(directory, pid);
			const token = await fs.readFile(manifest.tokenFilePath);
			let stats = 0;
			const handle = {
				stat: async () => ({
					isFile: () => true,
					size: token.length,
					dev: 1,
					ino: 1,
					mtimeMs: stats++ === 0 ? 1 : 2,
					ctimeMs: 1,
				}),
				read: async (buffer: Uint8Array) => {
					token.copy(buffer);
					return { bytesRead: token.length };
				},
				close: async () => {},
			};
			const open = vi.spyOn(fs, "open").mockResolvedValue(handle as never);
			try {
				await expect(
					runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
						registry,
						pid,
						installSignalHandlers: false,
					}),
				).rejects.toThrow("control token changed during read");
			} finally {
				open.mockRestore();
			}
		});
	});
	it("orders readiness, uses direct argv, serializes output, and redacts prompt data", async () => {
		await withTempDir(async directory => {
			const pid = 9182;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty();
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				cancelGraceMs: 1,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			const call = (action: string, data?: object) =>
				control.options.handler({ action, data } as never, {} as never);
			expect(await call("ready")).toBe(true);
			await call("write", { text: "typed" });
			await call("prompt", { text: "prompt-secret" });
			await call("resize", { columns: 120, rows: 40 });
			await call("cancel");
			expect(pty.options).toEqual({
				executable: manifest.executable,
				args: manifest.args,
				cwd: manifest.cwd,
				env: manifest.env,
			});
			expect(pty.writes.map(write => (typeof write === "string" ? write : new TextDecoder().decode(write)))).toEqual(
				["typed", "prompt-secret\r\n", "\u0003"],
			);
			expect(pty.resizes).toEqual([[120, 40]]);
			expect(pty.killCalls).toBe(1);
			pty.finish({ cancelled: true, timedOut: false });
			await running;
			expect(control.closeCalls).toBe(1);
			const pane = await fs.readFile(path.join(manifest.publicRoot, "pane.log"), "utf8");
			const events = await fs.readFile(path.join(manifest.publicRoot, "events.log"), "utf8");
			const final = await fs.readFile(path.join(manifest.publicRoot, "final.json"), "utf8");
			expect(pane.indexOf("first")).toBeLessThan(pane.indexOf("second"));
			expect(`${pane}${events}${final}`).not.toContain("prompt-secret");
			await expect(fs.stat(manifest.tokenFilePath)).resolves.toBeDefined();
			await expect(fs.stat(path.join(manifest.privateRoot, "manifest.json"))).resolves.toBeDefined();
		});
	});
	it("preserves split surrogate pairs and redacts short environment values and CRLF prompt echoes", async () => {
		await withTempDir(async directory => {
			const pid = 9191;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.env = { SHORT_SECRET: "x" };
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			await control.options.handler({ action: "prompt", data: { text: "zz\nqq" } } as never, {} as never);
			pty.emit("\ud83d");
			pty.emit("\ude00 x zz\r\nqq trailing");
			const tail = (await control.options.handler(
				{ action: "stream", data: { cursor: null, maxBytes: 4 } } as never,
				{} as never,
			)) as { truncated: boolean };
			expect(tail.truncated).toBe(true);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const pane = await fs.readFile(path.join(manifest.publicRoot, "pane.log"), "utf8");
			expect(pane).toContain("😀");
			expect(pane).not.toContain("x");
			expect(pane).not.toContain("zz\r\nqq");
			expect(pane).toContain("[redacted]");
		});
	});
	it("redacts ANSI-interleaved secrets across callback boundaries", async () => {
		await withTempDir(async directory => {
			const pid = 9194;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.env = { API_TOKEN: "secret" };
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			const output: string[] = [];
			let revision = 0;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async ({ entry }: { entry: string }) => {
					output.push(entry);
					return ++revision;
				},
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => new FakeControlServer(options as never),
			});
			while (!pty.started) await Bun.sleep(1);
			pty.emit("s\u001b[");
			pty.emit("31mec");
			pty.emit("ret\u001b[0m");
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			expect(output.join("")).not.toContain("secret");
			expect(output.join("")).toContain("[redacted]");
		});
	});
	it("redacts OSC-interleaved environment secrets across callback splits in pane, state, and stream output", async () => {
		await withTempDir(async directory => {
			const pid = 9197;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.env = { API_TOKEN: "secret" };
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("se\u001b]0;title");
			pty.emit("\u0007cr\u001bPignored\u001b\\et");
			const stream = (await control.options.handler(
				{ action: "stream", data: { cursor: 0, maxBytes: 1024 } } as never,
				{} as never,
			)) as { bytes: string };
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const pane = await fs.readFile(path.join(manifest.publicRoot, "pane.log"), "utf8");
			const streamed = Buffer.from(stream.bytes, "base64").toString("utf8");
			expect(pane).not.toContain("secret");
			expect(streamed).not.toContain("secret");
			expect(pane).toContain("[redacted]");
		});
	});
	it("redacts short inline secrets across ordinary, surrogate, ANSI, and OSC callback boundaries", async () => {
		await withTempDir(async directory => {
			const pid = 9205;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.env = { SHORT_SECRET: "x9" };
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("\ud83d");
			pty.emit("\ude00prefix");
			pty.emit("9suffix x\u001b[");
			pty.emit("31m9\u001b[0m x\u001b]0;title");
			pty.emit("\u00079");
			const stream = (await control.options.handler(
				{ action: "stream", data: { cursor: 0, maxBytes: 1024 } } as never,
				{} as never,
			)) as { bytes: string };
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const pane = await fs.readFile(path.join(manifest.publicRoot, "pane.log"), "utf8");
			const state = await fs.readFile(path.join(manifest.publicRoot, "events.log"), "utf8");
			const final = await fs.readFile(path.join(manifest.publicRoot, "final.json"), "utf8");
			const streamed = Buffer.from(stream.bytes, "base64").toString("utf8");
			for (const value of [pane, streamed]) {
				expect(value).not.toContain("x9");
				expect(value).toContain("[redacted]");
			}
			expect(`${state}${final}`).not.toContain("x9");
		});
	});
	it("passes evolved prompt secrets to the durable state redaction context", async () => {
		await withTempDir(async directory => {
			const pid = 9210;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const redactionUpdates: Array<readonly string[]> = [];
			let revision = 0;
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async (redactions: readonly string[]) => {
					redactionUpdates.push(redactions);
				},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			await control.options.handler({ action: "prompt", data: { text: "sec\nret" } } as never, {} as never);
			expect(redactionUpdates).toEqual([["sec\nret", "sec\r\nret"]]);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
		});
	});
	it("quarantines prompt redactions before durable admission waits", async () => {
		await withTempDir(async directory => {
			const pid = 9215;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const redactionStarted = Promise.withResolvers<void>();
			const redactionGate = Promise.withResolvers<void>();
			const output: string[] = [];
			let revision = 0;
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {
					redactionStarted.resolve();
					await redactionGate.promise;
				},
				appendOutput: async ({ entry }: { entry: string }) => {
					output.push(entry);
					return ++revision;
				},
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			const prompt = control.options.handler(
				{ action: "prompt", data: { text: "durable-await-secret" } } as never,
				{} as never,
			);
			await redactionStarted.promise;
			pty.emit("durable-await-secret");
			const live = (await control.options.handler(
				{ action: "stream", data: { cursor: 0, maxBytes: 1024 } } as never,
				{} as never,
			)) as { bytes: string };
			expect(Buffer.from(live.bytes, "base64").toString("utf8")).not.toContain("durable-await-secret");
			expect(Buffer.from(live.bytes, "base64").toString("utf8")).toContain("[redacted]");
			redactionGate.resolve();
			await prompt;
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			expect(output.join("")).not.toContain("durable-await-secret");
		});
	});
	it("fails closed before prompt acceptance or PTY write when redaction propagation fails", async () => {
		await withTempDir(async directory => {
			const pid = 9211;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let revision = 0;
			let accepted = false;
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {
					throw new Error("redaction propagation failed");
				},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => {
					accepted = true;
					return ++revision;
				},
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			await expect(
				control.options.handler({ action: "prompt", data: { text: "secret" } } as never, {} as never),
			).rejects.toThrow("redaction propagation failed");
			expect(pty.writes).toEqual([]);
			expect(pty.killed).toBe(true);
			expect(accepted).toBe(false);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await expect(running).rejects.toThrow("redaction propagation failed");
		});
	});
	it("redacts a prompt secret split across durable pane history and the reset stream ring", async () => {
		await withTempDir(async directory => {
			const pid = 9212;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("private-");
			const before = (await control.options.handler(
				{ action: "stream", data: { cursor: 0, maxBytes: 1024 } } as never,
				{} as never,
			)) as { endCursor: number; bytes: string };
			await control.options.handler({ action: "prompt", data: { text: "private-value" } } as never, {} as never);
			pty.emit("value");
			const stream = (await control.options.handler(
				{ action: "stream", data: { cursor: before.endCursor, maxBytes: 1024 } } as never,
				{} as never,
			)) as { startCursor: number; endCursor: number; bytes: string; truncated: boolean };
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const pane = await fs.readFile(path.join(manifest.publicRoot, "pane.log"), "utf8");
			expect(pane).not.toContain("private-value");
			expect(Buffer.from(stream.bytes, "base64").toString("utf8")).not.toContain("private-value");
			expect(stream.truncated).toBe(true);
			expect(
				Buffer.concat([Buffer.from(before.bytes, "base64"), Buffer.from(stream.bytes, "base64")]).toString("utf8"),
			).not.toContain("private-value");
		});
	});
	it("preserves unrelated replay history when adding a prompt redaction", async () => {
		await withTempDir(async directory => {
			const pid = 9213;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("Running READY\r\n");
			await control.options.handler({ action: "prompt", data: { text: "prompt-secret" } } as never, {} as never);
			const stream = (await control.options.handler(
				{ action: "stream", data: { cursor: null, maxBytes: 1024 } } as never,
				{} as never,
			)) as { bytes: string };
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			expect(Buffer.from(stream.bytes, "base64").toString("utf8")).toContain("Running READY");
		});
	});
	it("redacts ANSI-bearing prompt secrets without suppressing public output", async () => {
		await withTempDir(async directory => {
			const pid = 9199;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const prompt = "prompt\u001b[31m-secret";
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			await control.options.handler({ action: "prompt", data: { text: prompt } } as never, {} as never);
			pty.emit("prompt\u001b[");
			pty.emit("31m-secret");
			const stream = (await control.options.handler(
				{ action: "stream", data: { cursor: 0, maxBytes: 1024 } } as never,
				{} as never,
			)) as { bytes: string };
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const pane = await fs.readFile(path.join(manifest.publicRoot, "pane.log"), "utf8");
			expect(pane).not.toContain(prompt);
			expect(pane).toContain("[redacted]");
			expect(Buffer.from(stream.bytes, "base64").toString("utf8")).toContain("[redacted]");
		});
	});
	it("redacts ANSI-bearing argv and environment secrets without suppressing public output", async () => {
		await withTempDir(async directory => {
			const pid = 9200;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.args = ["unsafe\u001b[31m-argv"];
			manifest.env = { API_TOKEN: "unsafe\u001b]0;title\u0007-env" };
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("unsafe\u001b[31m-argv unsafe\u001b]0;title\u0007-env");
			const stream = (await control.options.handler(
				{ action: "stream", data: { cursor: 0, maxBytes: 1024 } } as never,
				{} as never,
			)) as { bytes: string };
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const pane = await fs.readFile(path.join(manifest.publicRoot, "pane.log"), "utf8");
			const streamed = Buffer.from(stream.bytes, "base64").toString("utf8");
			expect(pane).not.toContain("unsafe\u001b[31m-argv");
			expect(pane).not.toContain("unsafe\u001b]0;title\u0007-env");
			expect(streamed).not.toContain("unsafe\u001b[31m-argv");
			expect(streamed).not.toContain("unsafe\u001b]0;title\u0007-env");
			expect(pane).toContain("[redacted]");
			expect(streamed).toContain("[redacted]");
		});
	});
	it("redacts escape-bearing protected values in projected runtime and final scalars", async () => {
		await withTempDir(async directory => {
			const pid = 9202;
			const { manifest, registry } = await activeManifest(directory, pid);
			const protectedValue = "protected\u001b]0;title\u0007-value";
			manifest.env = { API_TOKEN: protectedValue };
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			await fs.writeFile(
				manifest.runtimeStatePath,
				JSON.stringify({
					session_id: manifest.name,
					cwd: manifest.worktree,
					workdir: manifest.worktree,
					state: "completed",
					source: protectedValue,
					event: protectedValue,
					reason: protectedValue,
					previous_runtime_state: protectedValue,
					final_response: {
						text: protectedValue,
						artifact_path: protectedValue,
						source: protectedValue,
					},
				}),
			);
			const pty = new FakePty(false);
			const runtimes: Array<Record<string, unknown>> = [];
			let final: Record<string, unknown> | undefined;
			let revision = 0;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async (_: unknown, runtime: Record<string, unknown>) => {
					runtimes.push(runtime);
					return ++revision;
				},
				recordPromptAccepted: async () => ++revision,
				commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
					final = record;
					return {};
				},
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => new FakeControlServer(options as never),
			});
			while (!pty.started) await Bun.sleep(1);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const runtime = runtimes.at(-1);
			if (!runtime || !final) throw new Error("runtime and final projections were not recorded");
			expect(runtime.state).toBe("completed");
			for (const key of ["source", "event", "reason", "previousRuntimeState", "terminalSource"])
				expect(runtime[key]).toBe("[redacted]");
			expect(runtime.terminalState).toBe("completed");
			const finalRuntime = final.runtimeStateSummary as Record<string, unknown>;
			expect(finalRuntime.state).toBe("completed");
			for (const key of ["source", "event", "reason", "previousRuntimeState", "terminalSource"])
				expect(finalRuntime[key]).toBe("[redacted]");
			expect(finalRuntime.terminalState).toBe("completed");
			expect(final.runtimeTerminalState).toBe("completed");
			expect(final.runtimeTerminalSource).toBe("[redacted]");
			expect(final).toMatchObject({
				status: 0,
				ownerExitReason: "runtime_completed",
				severity: "normal",
			});
			expect(JSON.stringify({ runtime, final })).not.toContain(protectedValue);
		});
	});
	it("classifies protected runtime semantics privately without publishing them", async () => {
		await withTempDir(async directory => {
			const pid = 9211;
			const { manifest, registry } = await activeManifest(directory, pid);
			const protectedValue = "process_postmortem";
			manifest.args = [protectedValue];
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			await control.options.handler({ action: "prompt", data: { text: "accepted" } } as never, {} as never);
			await fs.writeFile(
				manifest.runtimeStatePath,
				JSON.stringify({
					session_id: manifest.name,
					cwd: manifest.worktree,
					workdir: manifest.worktree,
					state: "errored",
					source: protectedValue,
					reason: protectedValue,
				}),
			);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("Working");
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const final = JSON.parse(await fs.readFile(path.join(manifest.publicRoot, "final.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(final.status).toBe(1);
			expect(final.severity).toBe("failure");
			expect(final.ownerExitReason).toBe("[redacted]");
			for (const file of ["runtime-state.json", "final.json", "events.log", "pane.log"])
				expect(await fs.readFile(path.join(manifest.publicRoot, file), "utf8")).not.toContain(protectedValue);
		});
	});
	it("redacts isolated secrets inside CSI and OSC control bytes", async () => {
		await withTempDir(async directory => {
			const pid = 9196;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.env = { UNRELATED: "1", ANOTHER: "ambient-secret", CSI: "x", OSC: "y" };
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			const output: string[] = [];
			let revision = 0;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async ({ entry }: { entry: string }) => {
					output.push(entry);
					return ++revision;
				},
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => new FakeControlServer(options as never),
			});
			while (!pty.started) await Bun.sleep(1);
			pty.emit("\u001b[31mambient-secret 1 \u001b[xm\u001b]y\u0007");
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const publicOutput = output.join("");
			expect(publicOutput).toContain("[redacted]");
			for (const secret of ["ambient-secret", "1", "x", "y"]) expect(publicOutput).not.toContain(secret);
		});
	});
	it("records exact durable evidence summaries when output suppression fails closed", async () => {
		await withTempDir(async directory => {
			const pid = 9210;
			const { manifest, registry } = await activeManifest(directory, pid);
			const candidates = Array.from({ length: 64 }, (_, index) => String.fromCodePoint(0xe000 + index)).join("");
			const cases = [
				{
					args: ["protected", "[redacted]", candidates],
					output: "protected",
					evidenceSummary: "redaction-marker-exhausted",
				},
				{
					args: [`${"x".repeat(16 * 1024 + 1)}z`],
					output: "x".repeat(16 * 1024 + 1),
					evidenceSummary: "redaction-buffer-exhausted",
				},
			];
			for (const testCase of cases) {
				manifest.args = testCase.args;
				await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
				const pty = new FakePty(false);
				let revision = 0;
				let final: Record<string, unknown> | undefined;
				const state = {
					initialize: async () => ({ revision }),
					addRedactions: async () => {},
					appendOutput: async () => ++revision,
					appendEvent: async () => ++revision,
					updateRuntime: async () => ++revision,
					recordPromptAccepted: async () => ++revision,
					commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
						final = record;
						return {};
					},
				};
				const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					state: state as never,
					gitDirty: cleanGitDirty,
					installSignalHandlers: false,
					createControlServer: options => new FakeControlServer(options as never),
				});
				while (!pty.started) await Bun.sleep(1);
				pty.emit(testCase.output);
				pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
				await running;
				if (!final) throw new Error("final record was not committed");
				expect(final.evidenceSummary).toBe(testCase.evidenceSummary);
			}
		});
	});
	it("does not synthesize argv secrets in truncation markers", async () => {
		await withTempDir(async directory => {
			const pid = 9195;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.args = ["visible-session"];
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("x".repeat(DEFAULT_PUBLIC_LOG_CAP_BYTES + 1));
			const stream = (await control.options.handler(
				{ action: "stream", data: { cursor: 0, maxBytes: 24 * 1024 } } as never,
				{} as never,
			)) as { bytes: string };
			expect(Buffer.from(stream.bytes, "base64").toString()).not.toContain("visible-session");
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
		});
	});
	it("redacts every callback split boundary without reconstructable public output", async () => {
		await withTempDir(async directory => {
			const pid = 9183;
			const { manifest, registry } = await activeManifest(directory, pid);
			manifest.args = ["argv-secret"];
			await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
			const token = (await fs.readFile(manifest.tokenFilePath)).toString("hex");
			for (const secret of [token, "argv-secret", "secret-env", "prompt-secret"]) {
				for (let split = 1; split < secret.length; split += 1) {
					const pty = new FakePty(false);
					const output: string[] = [];
					let revision = 0;
					let server: FakeControlServer | undefined;
					const state = {
						initialize: async () => ({ revision }),
						addRedactions: async () => {},
						appendOutput: async ({ entry }: { entry: string }) => {
							output.push(entry);
							return ++revision;
						},
						appendEvent: async () => ++revision,
						updateRuntime: async () => ++revision,
						recordPromptAccepted: async () => ++revision,
						commitFinal: async () => ({}),
					};
					const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
						registry,
						pty,
						pid,
						gitDirty: cleanGitDirty,
						state: state as never,
						installSignalHandlers: false,
						createControlServer: options => (server = new FakeControlServer(options as never)),
					});
					const control = await waitForControlServer(() => server);
					await control.options.handler(
						{ action: "prompt", data: { text: "prompt-secret" } } as never,
						{} as never,
					);
					pty.emit(`${"x".repeat(4096)}${secret.slice(0, split)}`);
					pty.emit(secret.slice(split));
					pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
					await running;
					for (const knownSecret of [token, "argv-secret", "secret-env", "prompt-secret"])
						expect(output.join("")).not.toContain(knownSecret);
					expect(output.join("")).toContain("[redacted]");
				}
			}
		});
	}, 30_000);
	it("uses a non-colliding delimiter or suppresses output when no delimiter is safe", async () => {
		await withTempDir(async directory => {
			const pid = 9187;
			const { manifest, registry } = await activeManifest(directory, pid);
			const token = (await fs.readFile(manifest.tokenFilePath)).toString("hex");
			const candidateCharacters = Array.from({ length: 64 }, (_, index) =>
				String.fromCodePoint(0xe000 + index),
			).join("");
			const cases = [
				{ secret: "[redacted]", prompt: true, expectedDelimiter: "\ue000", readable: false },
				{ secret: "redacted", prompt: false, expectedDelimiter: "\ue000", readable: false },
				{ secret: `[redacted]\ue000`, prompt: false, expectedDelimiter: "\ue001", readable: false },
				{ secret: "protected-value", prompt: false, expectedDelimiter: "[redacted]", readable: true },
				{ secret: "[redacted]tail", prompt: false, expectedDelimiter: "\ue000", readable: false },
				{
					secret: "redacted",
					additionalSecret: candidateCharacters,
					prompt: false,
					expectedDelimiter: undefined,
					readable: false,
				},
			];
			for (const testCase of cases) {
				manifest.args = testCase.prompt
					? ["-e", "process.exit(0)"]
					: [testCase.secret, ...(testCase.additionalSecret ? [testCase.additionalSecret] : [])];
				await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
				const pty = new FakePty(false);
				const output: string[] = [];
				let revision = 0;
				let server: FakeControlServer | undefined;
				const state = {
					initialize: async () => ({ revision }),
					addRedactions: async () => {},
					appendOutput: async ({ entry }: { entry: string }) => {
						output.push(entry);
						return ++revision;
					},
					appendEvent: async () => ++revision,
					updateRuntime: async () => ++revision,
					recordPromptAccepted: async () => ++revision,
					commitFinal: async () => ({}),
				};
				const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					gitDirty: cleanGitDirty,
					state: state as never,
					installSignalHandlers: false,
					createControlServer: options => (server = new FakeControlServer(options as never)),
				});
				const control = await waitForControlServer(() => server);
				if (testCase.prompt)
					await control.options.handler(
						{ action: "prompt", data: { text: testCase.secret } } as never,
						{} as never,
					);
				pty.emit(testCase.secret);
				pty.emit("subsequent output");
				pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
				await running;
				const publicOutput = output.join("");
				for (const knownSecret of [
					token,
					"secret-env",
					testCase.secret,
					...(testCase.additionalSecret ? [testCase.additionalSecret] : []),
				])
					expect(publicOutput).not.toContain(knownSecret);
				if (testCase.expectedDelimiter === undefined) {
					expect(publicOutput).toBe("");
				} else {
					expect(publicOutput).toContain(testCase.expectedDelimiter);
					if (testCase.readable) expect(publicOutput).toContain("[redacted]");
					expect(publicOutput).toContain("subsequent output");
				}
			}
		});
	});
	it("does not finalize after a queued state-write failure", async () => {
		await withTempDir(async directory => {
			const pid = 9184;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty();
			let committed = false;
			const state = {
				initialize: async () => ({ revision: 0 }),
				addRedactions: async () => {},
				appendOutput: async () => {
					throw new Error("append failed");
				},
				appendEvent: async () => 0,
				updateRuntime: async () => 0,
				recordPromptAccepted: async () => 0,
				commitFinal: async () => {
					committed = true;
					return {};
				},
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				state: state as never,
				installSignalHandlers: false,
				createControlServer: options => new FakeControlServer(options as never),
			});
			await Bun.sleep(1);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await expect(running).rejects.toThrow("append failed");
			expect(committed).toBe(false);
		});
	});
	it("serializes prompt redaction registration behind an in-flight durable append", async () => {
		await withTempDir(async directory => {
			const pid = 9193;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const gate = Promise.withResolvers<void>();
			const output: string[] = [];
			const operations: string[] = [];
			let calls = 0;
			let revision = 0;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {
					operations.push("redactions");
				},
				appendOutput: async ({ entry }: { entry: string }) => {
					calls += 1;
					if (calls === 1) await gate.promise;
					operations.push("append");
					output.push(entry);
					return ++revision;
				},
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async () => ({}),
			};
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				state: state as never,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("before\n");
			while (calls === 0) await Bun.sleep(1);
			const prompt = control.options.handler({ action: "prompt", data: { text: "secret" } } as never, {} as never);
			await Bun.sleep(1);
			expect(operations).toEqual([]);
			expect(calls).toBe(1);
			gate.resolve();
			await prompt;
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			expect(calls).toBeLessThanOrEqual(2);
			expect(output.join("")).toBe("before\n");
			expect(operations).toEqual(["append", "redactions"]);
		});
	});
	it("aggregates queued state and fallback control-close failures", async () => {
		await withTempDir(async directory => {
			const pid = 9186;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty();
			const killFailure = new Error("pty kill failed");
			pty.killFailure = killFailure;
			const appendFailure = new Error("append failed");
			const closeFailure = new Error("control close failed");
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision: 0 }),
				addRedactions: async () => {},
				appendOutput: async () => {
					throw appendFailure;
				},
				appendEvent: async () => 0,
				updateRuntime: async () => 0,
				recordPromptAccepted: async () => 0,
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				state: state as never,
				installSignalHandlers: false,
				createControlServer: options => {
					server = new FakeControlServer(options as never);
					server.closeFailure = closeFailure;
					return server;
				},
			});
			await waitForControlServer(() => server);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			const failure = await running.then(
				() => null,
				error => error,
			);
			expect(failure).toBeInstanceOf(AggregateError);
			expect((failure as AggregateError).errors).toEqual([appendFailure, killFailure, closeFailure]);
			expect(server?.closeCalls).toBe(1);
		});
	});
	it("leaves bootstrap artifacts intact without monitor authority", async () => {
		await withTempDir(async directory => {
			const pid = 9185;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let revision = 0;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				state: state as never,
				installSignalHandlers: false,
				createControlServer: options => new FakeControlServer(options as never),
			});
			await Bun.sleep(1);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			await expect(fs.stat(manifest.tokenFilePath)).resolves.toBeDefined();
			await expect(fs.stat(path.join(manifest.privateRoot, "manifest.json"))).resolves.toBeDefined();
		});
	});
	it("joins a late cancellation sleep failure after PTY settlement", async () => {
		await withTempDir(async directory => {
			const pid = 9203;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const sleep = Promise.withResolvers<void>();
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				sleep: async () => sleep.promise,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			const cancellation = control.options.handler({ action: "cancel" } as never, {} as never);
			pty.finish({ cancelled: true, timedOut: false });
			const failure = new Error("cancel sleep failed");
			sleep.reject(failure);
			await expect(cancellation).rejects.toBe(failure);
			await expect(running).rejects.toBe(failure);
			expect(pty.killCalls).toBe(0);
		});
	});
	it("kills after a Ctrl-C write failure and shares the cancellation failure", async () => {
		await withTempDir(async directory => {
			const pid = 9192;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			pty.writeFailure = new Error("ctrl-c write failed");
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				cancelGraceMs: 1,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			expect(await control.options.handler({ action: "ready" } as never, {} as never)).toBe(true);
			const cancel = () => control.options.handler({ action: "cancel" } as never, {} as never);
			const settled = await Promise.allSettled([cancel(), cancel()]);
			expect(settled).toHaveLength(2);
			for (const result of settled) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected") expect(result.reason).toBe(pty.writeFailure);
			}
			expect(pty.killCalls).toBe(1);
			pty.finish({ cancelled: true, timedOut: false });
			await expect(running).rejects.toThrow("ctrl-c write failed");
		});
	});
	it("reports post-bind hardening fatally before PTY start and closes the real server once", async () => {
		if (process.platform === "win32") return;
		await withTempDir(async directory => {
			const pid = 9204;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let closeCalls = 0;
			const chmod = vi.spyOn(fs, "chmod").mockImplementation(async target => {
				if (target === manifest.controlEndpoint) throw new Error("chmod failed");
			});
			try {
				await expect(
					runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
						registry,
						pty,
						pid,
						gitDirty: cleanGitDirty,
						installSignalHandlers: false,
						createControlServer: options => {
							const server = new LocalControlServer(options);
							const close = server.close.bind(server);
							vi.spyOn(server, "close").mockImplementation(async () => {
								closeCalls += 1;
								await close();
							});
							return server;
						},
					}),
				).rejects.toThrow("chmod failed");
				expect(pty.started).toBe(false);
				expect(closeCalls).toBe(1);
			} finally {
				chmod.mockRestore();
			}
		});
	});
	it("aggregates a post-listen control server error and closes once", async () => {
		await withTempDir(async directory => {
			const pid = 9198;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const fatal = new Error("post-listen server failure");
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			control.emitFatal(fatal);
			pty.finish({ exitCode: 1, cancelled: false, timedOut: false });
			await expect(running).rejects.toBe(fatal);
			expect(control.closeCalls).toBe(1);
		});
	});
	it("records a fatal writer failure over an otherwise terminal runtime", async () => {
		await withTempDir(async directory => {
			const pid = 9206;
			const { manifest, registry } = await activeManifest(directory, pid);
			await fs.writeFile(
				manifest.runtimeStatePath,
				JSON.stringify({
					session_id: manifest.name,
					cwd: manifest.worktree,
					workdir: manifest.worktree,
					state: "completed",
				}),
			);
			const pty = new FakePty(false);
			const fatal = new Error("writer infrastructure failed");
			let final: Record<string, unknown> | undefined;
			let revision = 0;
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
					final = record;
					return {};
				},
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			control.emitFatal(fatal);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await expect(running).rejects.toBe(fatal);
			if (!final) throw new Error("final record was not committed");
			expect(final).toMatchObject({
				status: 1,
				ownerExitReason: "owner_fatal_writer_error",
				severity: "failure",
				runtimeTerminal: true,
			});
			expect((final.runtimeStateSummary as Record<string, unknown>).severity).toBe("failure");
		});
	});
	it("records completion failure over an otherwise terminal runtime", async () => {
		await withTempDir(async directory => {
			const pid = 9211;
			const { manifest, registry } = await activeManifest(directory, pid);
			await fs.writeFile(
				manifest.runtimeStatePath,
				JSON.stringify({
					session_id: manifest.name,
					cwd: manifest.worktree,
					workdir: manifest.worktree,
					state: "completed",
				}),
			);
			const pty = new FakePty(false);
			const completionFailure = new Error("PTY completion failed");
			pty.startFailure = completionFailure;
			let revision = 0;
			let final: Record<string, unknown> | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
					final = record;
					return {};
				},
			};
			await expect(
				runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					state: state as never,
					gitDirty: cleanGitDirty,
					installSignalHandlers: false,
					createControlServer: options => new FakeControlServer(options as never),
				}),
			).rejects.toBe(completionFailure);
			if (!final) throw new Error("final record was not committed");
			expect(final).toMatchObject({
				status: 1,
				ownerExitReason: "owner_completion_failure",
				severity: "failure",
				runtimeTerminal: true,
			});
			expect((final.runtimeStateSummary as Record<string, unknown>).severity).toBe("failure");
		});
	});
	it("preserves decoded write bytes, latches cancellation, and streams only sanitized pane bytes", async () => {
		await withTempDir(async directory => {
			const pid = 9188;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				cancelGraceMs: 10,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			const call = (action: string, data?: object) =>
				control.options.handler({ action, data } as never, {} as never);
			const raw = Uint8Array.from([3, 0, 255, 128, 10, 27]);
			await call("write", { encoding: "base64", bytes: Buffer.from(raw).toString("base64") });
			await call("write", { text: "\u0003" });
			await call("prompt", { text: "prompt-secret" });
			expect(pty.writes[0]).toEqual(raw);
			expect(pty.writes[1]).toEqual(new TextEncoder().encode("\u0003"));
			expect(pty.writes[2]).toBe("prompt-secret\r\n");
			expect(await call("cancel")).toEqual({ accepted: true, idempotent: false, cancelRequested: true });
			expect(pty.writes[3]).toEqual(Uint8Array.of(3));
			expect(await Promise.all([call("cancel"), call("cancel")])).toEqual([
				{ accepted: true, idempotent: true, cancelRequested: true },
				{ accepted: true, idempotent: true, cancelRequested: true },
			]);
			expect(pty.killCalls).toBe(1);
			expect(await call("status")).toEqual({
				ready: true,
				running: true,
				generation: manifest.generationId,
				cancelRequested: true,
			});

			pty.emit("visible");
			pty.emit(" prompt-secret");
			const live = (await call("stream", { cursor: 0, maxBytes: 1024 })) as {
				startCursor: number;
				endCursor: number;
				bytes: string;
				truncated: boolean;
				running: boolean;
			};
			expect(Buffer.from(live.bytes, "base64").toString()).toBe("visible [redacted]");
			expect(live).toMatchObject({ startCursor: 0, endCursor: 18, truncated: false, running: true });
			expect(
				Buffer.from(
					((await call("stream", { cursor: null, maxBytes: 5 })) as { bytes: string }).bytes,
					"base64",
				).toString(),
			).toBe("cted]");
			expect(await call("stream", { cursor: live.endCursor, maxBytes: 1024 })).toEqual({
				startCursor: live.endCursor,
				endCursor: live.endCursor,
				bytes: "",
				truncated: false,
				running: true,
			});

			pty.emit("x".repeat(DEFAULT_PUBLIC_LOG_CAP_BYTES + 1));
			const stale = (await call("stream", { cursor: 0, maxBytes: 32 })) as {
				startCursor: number;
				endCursor: number;
				bytes: string;
				truncated: boolean;
			};
			expect(stale.truncated).toBe(true);
			expect(stale.endCursor - stale.startCursor).toBe(32);
			expect(Buffer.from(stale.bytes, "base64").toString()).not.toContain("prompt-secret");
			pty.finish({ cancelled: true, timedOut: false });
			await running;
		});
	}, 30_000);
	it("serializes an admitted prompt delivery before a later cancellation", async () => {
		await withTempDir(async directory => {
			const pid = 9216;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const acceptanceStarted = Promise.withResolvers<void>();
			const acceptanceGate = Promise.withResolvers<void>();
			let revision = 0;
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => {
					acceptanceStarted.resolve();
					await acceptanceGate.promise;
					return ++revision;
				},
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				cancelGraceMs: 1,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			const prompt = control.options.handler(
				{ action: "prompt", data: { text: "prompt-secret" } } as never,
				{} as never,
			);
			await acceptanceStarted.promise;
			const cancellation = control.options.handler({ action: "cancel" } as never, {} as never);
			acceptanceGate.resolve();
			await prompt;
			await cancellation;
			expect(pty.writes.map(write => (typeof write === "string" ? write : new TextDecoder().decode(write)))).toEqual(
				["prompt-secret\r\n", "\u0003"],
			);
			pty.finish({ cancelled: true, timedOut: false });
			await running;
		});
	});
	it("classifies an accepted cancellation even when the PTY reports a normal exit", async () => {
		await withTempDir(async directory => {
			const pid = 9217;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				cancelGraceMs: 1,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			await control.options.handler({ action: "cancel" } as never, {} as never);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const final = JSON.parse(await fs.readFile(path.join(manifest.publicRoot, "final.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(final).toMatchObject({
				ownerExitReason: "pty_cancelled",
				severity: "failure",
				status: 130,
			});
		});
	});
	it("keeps ANSI pane and stream bytes invariant across callback splits", async () => {
		const capture = async (splits: number[]): Promise<{ pane: Buffer; live: Buffer; start: number; end: number }> =>
			withTempDir(async directory => {
				const pid = 9190;
				const { manifest, registry } = await activeManifest(directory, pid);
				manifest.args = ["argv-secret"];
				await writeVisibleSessionOwnerManifest(path.join(manifest.privateRoot, "manifest.json"), manifest);
				const pty = new FakePty(false);
				let server: FakeControlServer | undefined;
				const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					gitDirty: cleanGitDirty,
					installSignalHandlers: false,
					createControlServer: options => (server = new FakeControlServer(options as never)),
				});
				const control = await waitForControlServer(() => server);
				const output = `${"😀".repeat(17_000)}\u001b[31mANSI\u001b[0m argv-secret`;
				let offset = 0;
				for (const split of splits) {
					pty.emit(output.slice(offset, offset + split));
					offset += split;
				}
				pty.emit(output.slice(offset));
				pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
				await running;
				const first = (await control.options.handler(
					{ action: "stream", data: { cursor: 0, maxBytes: 24 * 1024 } } as never,
					{} as never,
				)) as { startCursor: number; endCursor: number; bytes: string };
				const chunks = [Buffer.from(first.bytes, "base64")];
				let cursor = first.endCursor;
				while (chunks.at(-1)?.length === 24 * 1024) {
					const next = (await control.options.handler(
						{ action: "stream", data: { cursor, maxBytes: 24 * 1024 } } as never,
						{} as never,
					)) as { endCursor: number; bytes: string };
					chunks.push(Buffer.from(next.bytes, "base64"));
					cursor = next.endCursor;
				}
				return {
					pane: await fs.readFile(path.join(manifest.publicRoot, "pane.log")),
					live: Buffer.concat(chunks),
					start: first.startCursor,
					end: cursor,
				};
			});
		const whole = await capture([]);
		const fragmented = await capture([1, 2, 3, 5, 8, 13, 21, 34]);
		expect(fragmented.pane).toEqual(whole.pane);
		expect(fragmented.live).toEqual(fragmented.pane);
		expect(whole.live).toEqual(whole.pane);
		expect(fragmented.end - fragmented.start).toBe(fragmented.pane.length);
		expect(fragmented.pane.toString("utf8")).toContain("\u001b[31mANSI\u001b[0m");
		expect(fragmented.pane.toString("utf8")).toContain("[visible-session log truncated]\n");
		expect(fragmented.pane.toString("utf8")).toContain("[redacted]");
		expect(fragmented.pane.toString("utf8")).not.toContain("argv-secret");
	}, 60_000);
	it("records PTY startup failure and leaves cleanup to the monitor", async () => {
		await withTempDir(async directory => {
			const pid = 9201;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const failure = new Error("pty startup failed");
			pty.startFailure = failure;
			let server: FakeControlServer | undefined;
			await expect(
				runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					gitDirty: cleanGitDirty,
					installSignalHandlers: false,
					createControlServer: options => (server = new FakeControlServer(options as never)),
				}),
			).rejects.toBe(failure);
			expect(pty.killCalls).toBe(1);
			expect(server?.closeCalls).toBe(1);
			await expect(fs.stat(manifest.tokenFilePath)).resolves.toBeDefined();
			await expect(fs.stat(path.join(manifest.privateRoot, "manifest.json"))).resolves.toBeDefined();
		});
	});
	it("keeps aborted queued prompts from poisoning later prompt mutations", async () => {
		await withTempDir(async directory => {
			const pid = 9207;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const appendStarted = Promise.withResolvers<void>();
			const appendGate = Promise.withResolvers<void>();
			const redactions: Array<readonly string[]> = [];
			let revision = 0;
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async (values: readonly string[]) => {
					redactions.push(values);
				},
				appendOutput: async () => {
					appendStarted.resolve();
					await appendGate.promise;
					return ++revision;
				},
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => ++revision,
				commitFinal: async () => ({}),
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			pty.emit("queued output");
			await appendStarted.promise;
			const abort = new AbortController();
			const rejected = control.options.handler(
				{ action: "prompt", data: { text: "discarded" } } as never,
				{ signal: abort.signal } as never,
			);
			abort.abort();
			appendGate.resolve();
			await expect(rejected).rejects.toThrow("visible session owner request expired");
			await expect(
				control.options.handler(
					{ action: "prompt", data: { text: "expired" } } as never,
					{ deadline: Date.now() - 1 } as never,
				),
			).rejects.toThrow("visible session owner request expired");
			expect(redactions).toEqual([]);
			await control.options.handler({ action: "prompt", data: { text: "accepted" } } as never, {} as never);
			expect(redactions).toEqual([["accepted"]]);
			expect(pty.writes).toEqual(["accepted\r\n"]);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
		});
	});
	it("records prompt delivery failure after durable acceptance without poisoning final evidence", async () => {
		await withTempDir(async directory => {
			const pid = 9208;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			const failure = new Error("prompt delivery failed");
			pty.writeFailure = failure;
			let accepted = false;
			let final: Record<string, unknown> | undefined;
			let revision = 0;
			let server: FakeControlServer | undefined;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async () => ++revision,
				recordPromptAccepted: async () => {
					accepted = true;
					return ++revision;
				},
				commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
					final = record;
					return {};
				},
			};
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				state: state as never,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			const control = await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			await expect(
				control.options.handler({ action: "prompt", data: { text: "secret" } } as never, {} as never),
			).rejects.toBe(failure);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await expect(running).rejects.toBe(failure);
			expect(accepted).toBe(true);
			if (!final) throw new Error("prompt delivery failure did not commit final evidence");
			expect(final).toMatchObject({
				promptAccepted: true,
				ownerExitReason: "owner_prompt_delivery_failure",
				severity: "failure",
				status: 1,
			});
		});
	});
	it("treats Windows-equivalent runtime cwd paths as the same worktree", async () => {
		if (process.platform !== "win32") return;
		await withTempDir(async directory => {
			const pid = 9219;
			const { manifest, registry } = await activeManifest(directory, pid);
			const pty = new FakePty(false);
			let server: FakeControlServer | undefined;
			const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
				registry,
				pty,
				pid,
				gitDirty: cleanGitDirty,
				installSignalHandlers: false,
				createControlServer: options => (server = new FakeControlServer(options as never)),
			});
			await waitForControlServer(() => server);
			while (!pty.started) await Bun.sleep(1);
			await fs.writeFile(
				manifest.runtimeStatePath,
				JSON.stringify({
					session_id: manifest.name,
					cwd: manifest.worktree.toUpperCase().replaceAll("\\", "/"),
					state: "completed",
				}),
			);
			pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
			await running;
			const final = JSON.parse(await fs.readFile(path.join(manifest.publicRoot, "final.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(final).toMatchObject({
				ownerExitReason: "runtime_completed",
				severity: "normal",
				status: 0,
			});
		});
	});
	it("rejects short runtime snapshots as unstable", async () => {
		await withTempDir(async directory => {
			const pid = 9218;
			const { manifest, registry } = await activeManifest(directory, pid);
			const token = await fs.readFile(manifest.tokenFilePath);
			const stableTokenStat = {
				isFile: () => true,
				size: token.length,
				dev: 1,
				ino: 1,
				mtimeMs: 1,
				ctimeMs: 1,
			};
			const stableTokenHandle = {
				stat: async () => stableTokenStat,
				read: async (buffer: Uint8Array) => {
					token.copy(buffer);
					return { bytesRead: token.length };
				},
				close: async () => {},
			};
			let runtimeReads = 0;
			const shortRuntimeHandle = {
				stat: async () => ({ isFile: () => true, size: 2, mtimeMs: 1, ino: 1 }),
				read: async (buffer: Uint8Array) => {
					if (runtimeReads > 0) return { bytesRead: 0 };
					runtimeReads += 1;
					buffer[0] = 0x7b;
					return { bytesRead: 1 };
				},
				close: async () => {},
			};
			const originalOpen = fs.open;
			const open = vi.spyOn(fs, "open").mockImplementation((async (target, flags, mode) => {
				if (target === manifest.tokenFilePath) return stableTokenHandle as never;
				if (target === manifest.runtimeStatePath) return shortRuntimeHandle as never;
				return originalOpen(target, flags, mode);
			}) as typeof fs.open);
			const pty = new FakePty(false);
			const runtimes: Array<Record<string, unknown>> = [];
			let final: Record<string, unknown> | undefined;
			let revision = 0;
			const state = {
				initialize: async () => ({ revision }),
				addRedactions: async () => {},
				appendOutput: async () => ++revision,
				appendEvent: async () => ++revision,
				updateRuntime: async (_input: unknown, runtime: Record<string, unknown>) => {
					runtimes.push(runtime);
					return ++revision;
				},
				recordPromptAccepted: async () => ++revision,
				commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
					final = record;
					return {};
				},
			};
			try {
				const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					state: state as never,
					gitDirty: cleanGitDirty,
					installSignalHandlers: false,
					createControlServer: options => new FakeControlServer(options as never),
				});
				while (!pty.started) await Bun.sleep(1);
				pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
				await running;
				expect(runtimes.at(-1)?.status).toBe("unstable");
				if (!final) throw new Error("short runtime snapshot did not commit final evidence");
				expect(final).toMatchObject({
					ownerExitReason: "runtime_state_unstable",
					severity: "failure",
					status: 1,
				});
			} finally {
				open.mockRestore();
			}
		});
	});
	it("preserves bounded runtime-state read failures in terminal evidence", async () => {
		const cases: Array<{
			name: string;
			expected: "missing" | "malformed" | "overlimit" | "read_error";
			reason: string;
			setup: (runtimeStatePath: string) => Promise<void>;
		}> = [
			{
				name: "missing runtime state",
				expected: "missing",
				reason: "owner_exited_before_turn_evidence",
				setup: async () => {},
			},
			{
				name: "malformed JSON",
				expected: "malformed",
				reason: "runtime_state_malformed",
				setup: async runtimeStatePath => fs.writeFile(runtimeStatePath, "{"),
			},
			{
				name: "oversized JSON",
				expected: "overlimit",
				reason: "runtime_state_overlimit",
				setup: async runtimeStatePath => fs.writeFile(runtimeStatePath, "x".repeat(64 * 1024 + 1)),
			},
			{
				name: "unreadable runtime path",
				expected: "read_error",
				reason: "runtime_state_read_error",
				setup: async runtimeStatePath => fs.mkdir(runtimeStatePath),
			},
		];
		for (const testCase of cases) {
			await withTempDir(async directory => {
				const pid = 9209;
				const { manifest, registry } = await activeManifest(directory, pid);
				await testCase.setup(manifest.runtimeStatePath);
				const pty = new FakePty(false);
				const runtimes: Array<Record<string, unknown>> = [];
				let final: Record<string, unknown> | undefined;
				let revision = 0;
				const state = {
					initialize: async () => ({ revision }),
					addRedactions: async () => {},
					appendOutput: async () => ++revision,
					appendEvent: async () => ++revision,
					updateRuntime: async (_input: unknown, runtime: Record<string, unknown>) => {
						runtimes.push(runtime);
						return ++revision;
					},
					recordPromptAccepted: async () => ++revision,
					commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
						final = record;
						return {};
					},
				};
				const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					state: state as never,
					gitDirty: cleanGitDirty,
					installSignalHandlers: false,
					createControlServer: options => new FakeControlServer(options as never),
				});
				while (!pty.started) await Bun.sleep(1);
				pty.finish({ exitCode: 0, cancelled: false, timedOut: false });
				await running;
				expect(runtimes.at(-1)?.status).toBe(testCase.expected);
				if (!final) throw new Error(`${testCase.name} did not commit final evidence`);
				expect(final).toMatchObject({
					ownerExitReason: testCase.reason,
					severity: "failure",
					status: 1,
				});
			});
		}
	});
	it("classifies PTY and runtime terminal outcomes with explicit precedence", async () => {
		const cases: Array<{
			name: string;
			outcome: { exitCode?: number; cancelled: boolean; timedOut: boolean };
			runtimeState: "completed" | "errored";
			reason: string;
			severity: "normal" | "failure";
			status: number;
		}> = [
			{
				name: "timeout over completed runtime",
				outcome: { exitCode: 0, cancelled: false, timedOut: true },
				runtimeState: "completed",
				reason: "pty_timed_out",
				severity: "failure",
				status: 124,
			},
			{
				name: "cancellation over errored runtime",
				outcome: { cancelled: true, timedOut: false },
				runtimeState: "errored",
				reason: "pty_cancelled",
				severity: "failure",
				status: 130,
			},
			{
				name: "nonzero exit over completed runtime",
				outcome: { exitCode: 23, cancelled: false, timedOut: false },
				runtimeState: "completed",
				reason: "pty_exited_nonzero",
				severity: "failure",
				status: 23,
			},
			{
				name: "completed runtime",
				outcome: { exitCode: 0, cancelled: false, timedOut: false },
				runtimeState: "completed",
				reason: "runtime_completed",
				severity: "normal",
				status: 0,
			},
			{
				name: "errored runtime",
				outcome: { exitCode: 0, cancelled: false, timedOut: false },
				runtimeState: "errored",
				reason: "runtime_errored",
				severity: "failure",
				status: 1,
			},
		];
		for (const testCase of cases) {
			await withTempDir(async directory => {
				const pid = 9214;
				const { manifest, registry } = await activeManifest(directory, pid);
				await fs.writeFile(
					manifest.runtimeStatePath,
					JSON.stringify({
						session_id: manifest.name,
						cwd: manifest.worktree,
						state: testCase.runtimeState,
						source: "runtime",
					}),
				);
				const pty = new FakePty(false);
				let final: Record<string, unknown> | undefined;
				let revision = 0;
				const state = {
					initialize: async () => ({ revision }),
					addRedactions: async () => {},
					appendOutput: async () => ++revision,
					appendEvent: async () => ++revision,
					updateRuntime: async () => ++revision,
					recordPromptAccepted: async () => ++revision,
					commitFinal: async ({ record }: { record: Record<string, unknown> }) => {
						final = record;
						return {};
					},
				};
				const running = runVisibleSessionOwner(path.join(manifest.privateRoot, "manifest.json"), {
					registry,
					pty,
					pid,
					state: state as never,
					gitDirty: cleanGitDirty,
					installSignalHandlers: false,
					createControlServer: options => new FakeControlServer(options as never),
				});
				while (!pty.started) await Bun.sleep(1);
				pty.finish(testCase.outcome);
				await running;
				if (!final) throw new Error(`${testCase.name} did not commit final evidence`);
				expect(final).toMatchObject({
					ownerExitReason: testCase.reason,
					severity: testCase.severity,
					status: testCase.status,
				});
			});
		}
	});
});
