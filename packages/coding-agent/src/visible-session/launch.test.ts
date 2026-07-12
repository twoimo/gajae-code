import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { controlEndpointFor } from "./control-server";
import {
	launchVisibleSession,
	parseVisibleSessionFinalAcknowledgement,
	parseVisibleSessionOwnerManifest,
	parseVisibleSessionOwnerReadyAcknowledgement,
	readVisibleSessionOwnerManifest,
	type VisibleSessionOwnerManifest,
	type VisibleSessionSpawnedProcess,
	visibleSessionOwnerReadyPath,
	visibleSessionRoleArgv,
	visibleSessionStartupDiagnosticsPath,
	writeVisibleSessionOwnerManifest,
} from "./launch";
import { VisibleSessionRegistry } from "./registry";

async function withTempDir<T>(callback: (directory: string) => Promise<T>): Promise<T> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-launch-"));
	try {
		return await callback(directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}
function deferredRole(pid: number, onKill?: () => void): VisibleSessionSpawnedProcess {
	const exit = Promise.withResolvers<number>();
	return {
		pid,
		unref() {},
		kill() {
			onKill?.();
			exit.resolve(0);
		},
		exited: exit.promise,
	};
}
function trackedTextStream(
	text: string,
	label: string,
	drained: string[],
	beforeClose?: () => Promise<void>,
	onDrained?: () => void,
): ReadableStream<Uint8Array> {
	let emitted = false;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!emitted) {
				emitted = true;
				controller.enqueue(Buffer.from(text));
				return;
			}
			const close = () => {
				drained.push(label);
				controller.close();
				onDrained?.();
			};
			if (beforeClose) return beforeClose().then(close);
			close();
		},
	});
}

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;
function runtime(mode: "source" | "compiled") {
	return {
		execPath: "/bin/gjc",
		mode,
		argsPrefix: mode === "source" ? ["/workspace/gjc.ts"] : [],
		reloadPicksUpSourceEdits: mode === "source",
	};
}
const launchReadinessDependencies = {
	gitProbe: async (command: readonly string[]) => ({
		exitCode: 0,
		stdout: command.includes("status") ? "" : "main\n",
	}),
	createReadyClient: () => ({ call: async () => ({ ok: true, result: true }) }),
	readMonitorReady: async (file: string) => {
		const value = JSON.parse(await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8")) as {
			generationId: string;
			leaseId: string;
		};
		return { schemaVersion: 1 as const, generationId: value.generationId, leaseId: value.leaseId, monitorPid: 11 };
	},
	readVanished: async (file: string) => {
		const publicRoot = path.dirname(file);
		const privateRoot = path.join(
			path.dirname(path.dirname(publicRoot)),
			"private",
			path.basename(path.dirname(publicRoot)),
			path.basename(publicRoot),
		);
		const value = JSON.parse(await fs.readFile(path.join(privateRoot, "manifest.json"), "utf8")) as {
			generationId: string;
		};
		return { generationId: value.generationId };
	},
	privateCredentialsPresent: async () => false,
};
function manifest(root: string): VisibleSessionOwnerManifest {
	const generationId = "1-abcdef";
	const privateRoot = path.join(root, "visible-sessions", "private", "alpha", generationId);
	return {
		schemaVersion: 3,
		generationId,
		startIdentity: "identity",
		leaseId: "lease-identity",
		agentDir: root,
		name: "Alpha",
		key: "alpha",
		repo: path.join(root, "repo"),
		worktree: path.join(root, "worktree"),
		backend: "conpty",
		publicRoot: path.join(root, "public", "alpha", generationId),
		privateRoot,
		tokenFilePath: path.join(privateRoot, "control-token"),
		controlEndpoint: controlEndpointFor({ privateGenerationRoot: privateRoot, generation: generationId }),
		executable: path.join(root, "owner"),
		args: ["--literal", "space value"],
		cwd: path.join(root, "worktree"),
		env: { LANG: "C" },
		ownerReadyDeadline: "2026-01-01T00:00:00.000Z",
		createdAt: "2025-12-31T23:59:30.000Z",
		branch: "main",
		worktreeBaselineDirty: false,
		runtimeStatePath: path.join(privateRoot, "runtime-state.json"),
		ownerRoleArgv: [
			process.execPath,
			"visible-session",
			"owner-internal",
			"--manifest",
			path.join(privateRoot, "manifest.json"),
		],
	};
}
function finalAcknowledgement(generationId: string): Record<string, unknown> {
	const runtimeStateSummary = {
		summary: "",
		status: "completed",
		updatedAt: "2026-01-01T00:00:00.000Z",
		present: false,
		valid: true,
		state: null,
		source: null,
		event: null,
		reason: null,
		terminal: true,
		terminalState: "completed",
		terminalSource: "test",
		finalResponsePresent: false,
		previousRuntimeState: null,
		sessionMatches: true,
		cwdMatches: true,
		ownerExitReason: "ready timeout",
		severity: "failure",
	};
	return {
		schemaVersion: 2,
		backend: "conpty",
		generation: generationId,
		generationId,
		owner: { pid: 71, startedAt: "2026-01-01T00:00:00.000Z" },
		session: "Alpha",
		status: 1,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
		paneLog: "pane.log",
		runtimeState: "runtime-state.json",
		turnEvidencePresent: false,
		promptAccepted: false,
		ownerExitReason: "ready timeout",
		severity: "failure",
		runtimeTerminal: true,
		runtimeTerminalState: "completed",
		runtimeTerminalSource: "test",
		worktreeBaselineDirty: false,
		observedRecoverableWorktreeChanges: false,
		worktreeChangedSinceBaseline: false,
		runtimeStateSummary,
		committedAt: "2026-01-01T00:00:01.000Z",
		runtimeSummary: "",
		worktreeSummary: "",
		evidenceSummary: "owner terminated after readiness timeout",
	};
}

class RecordingRegistry extends VisibleSessionRegistry {
	activation: { pid: number; startIdentity: string } | undefined;
	override async activateOwner(input: Parameters<VisibleSessionRegistry["activateOwner"]>[0]) {
		this.activation = { pid: input.process.pid, startIdentity: input.startIdentity };
		return super.activateOwner(input);
	}
}
class FailingActivationRegistry extends VisibleSessionRegistry {
	override async activateOwner(): Promise<never> {
		throw new Error("activation failed");
	}
}

describe("visible-session launch", () => {
	it("keeps source and compiled hidden role argv exact and un-serialized", () => {
		const file = "/private/alpha/1/manifest with spaces;$x.json";
		expect(visibleSessionRoleArgv(runtime("source"), "owner-internal", file)).toEqual([
			"/workspace/gjc.ts",
			"visible-session",
			"owner-internal",
			"--manifest",
			file,
		]);
		expect(visibleSessionRoleArgv(runtime("compiled"), "monitor-internal", file)).toEqual([
			"visible-session",
			"monitor-internal",
			"--manifest",
			file,
		]);
	});
	it("rejects non-conpty backend records before allocating a generation", async () => {
		await expect(
			launchVisibleSession({
				registry: new VisibleSessionRegistry({ agentDir: "/agent" }),
				input: { name: "Alpha", repository: "/repo", worktree: "/worktree", backend: "tmux" },
				executable: { executable: "/owner", args: [], cwd: "/worktree", env: {} },
			}),
		).rejects.toThrow("requires the conpty backend");
	});

	it("uses the manifest owner timestamp as the exact registry identity in source and compiled launches", async () => {
		for (const mode of ["source", "compiled"] as const) {
			await withTempDir(async root => {
				const repository = path.join(root, "repo");
				const worktree = path.join(root, "worktree");
				const agentDir = path.join(root, "agent");
				await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
				const registry = new VisibleSessionRegistry({ agentDir });
				const manifests: string[] = [];
				await launchVisibleSession(
					{
						registry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					},
					{
						runtime: runtime(mode),
						...launchReadinessDependencies,
						readMonitorReady: async file => {
							const value = JSON.parse(
								await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8"),
							) as {
								generationId: string;
								leaseId: string;
							};
							return {
								schemaVersion: 1,
								generationId: value.generationId,
								leaseId: value.leaseId,
								monitorPid: 33,
							};
						},
						spawn: command => {
							manifests.push(command.at(-1) ?? "");
							return deferredRole(31 + manifests.length);
						},
					},
				);
				const active = (await registry.read()).entries[0]?.active;
				const ownerManifest = await readVisibleSessionOwnerManifest(manifests[0] ?? "");
				expect(active?.process).toEqual({
					pid: 32,
					startedAt: ownerManifest.createdAt,
					hostname: os.hostname(),
				});
			});
		}
	});
	it("writes a strict private schema atomically with private permissions", async () => {
		await withTempDir(async root => {
			const value = manifest(root);
			const file = path.join(value.privateRoot, "manifest.json");
			await writeVisibleSessionOwnerManifest(file, value);
			expect(await readVisibleSessionOwnerManifest(file)).toEqual(value);
			expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8"))).sort()).toEqual(Object.keys(value).sort());
			if (process.platform !== "win32") {
				expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
				expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
			}
			expect(() => parseVisibleSessionOwnerManifest({ ...value, token: "secret" })).toThrow("schema");
			expect(() => parseVisibleSessionOwnerManifest({ ...value, tokenFilePath: root })).toThrow("schema");
			expect(() => parseVisibleSessionOwnerManifest({ ...value, backend: "native" })).toThrow("schema");
		});
	});

	it("activates the owner before monitor launch and reports only after authenticated ready", async () => {
		await withTempDir(async root => {
			const agentDir = path.join(root, "agent");
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "work tree '雪'");
			await Promise.all([fs.mkdir(agentDir), fs.mkdir(repository), fs.mkdir(worktree)]);
			const registry = new RecordingRegistry({ agentDir });
			const spawned: { command: readonly string[]; options: unknown; process: VisibleSessionSpawnedProcess }[] = [];
			let readyCalls = 0;
			let unrefs = 0;
			let clock = 0;
			const probes: string[][] = [];
			const receipt = await launchVisibleSession(
				{
					registry,
					input: { name: "Alpha", repository, worktree, backend: "conpty" },
					executable: {
						executable: path.join(root, "owner"),
						args: ["--prompt", "private prompt"],
						cwd: worktree,
						env: { SECRET: "not-control-token" },
					},
					ownerReadyTimeoutMs: 1_000,
				},
				{
					runtime: runtime("compiled"),
					...launchReadinessDependencies,
					gitProbe: async command => {
						probes.push([...command]);
						return { exitCode: 0, stdout: command.includes("status") ? "?? untracked.txt\n" : "feature/雪\n" };
					},
					spawn: (command, options) => {
						const process = {
							pid: spawned.length + 10,
							unref() {
								unrefs++;
							},
							kill() {},
							exited: Promise.withResolvers<number>().promise,
						};
						spawned.push({ command, options, process });
						return process;
					},
					createReadyClient: () => ({
						call: async () => ({ ok: true, result: ++readyCalls === 2 }),
					}),
					now: () => clock,
					sleep: async milliseconds => {
						clock += milliseconds;
					},
				},
			);
			expect(registry.activation).toEqual({ pid: 10, startIdentity: expect.any(String) });
			expect(spawned).toHaveLength(2);
			for (const spawn of spawned) {
				expect(spawn.options).toEqual({
					detached: true,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
					shell: false,
				});
				expect(spawn.command).not.toContain("private prompt");
				expect(spawn.command).not.toContain("not-control-token");
			}
			expect(readyCalls).toBe(2);
			expect(unrefs).toBe(2);
			expect(receipt).toEqual({
				generationId: expect.any(String),
				backend: "conpty",
				publicRoot: expect.any(String),
				ownerPid: 10,
				monitorPid: 11,
			});
			expect(JSON.stringify(receipt)).not.toContain("token");
			expect(probes).toEqual([
				["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"],
				["git", "-C", worktree, "status", "--porcelain=v1", "--untracked-files=normal"],
			]);
			const ownerManifest = await readVisibleSessionOwnerManifest(spawned[0]?.command.at(-1) ?? "");
			expect(ownerManifest).toMatchObject({
				schemaVersion: 3,
				createdAt: "1970-01-01T00:00:00.000Z",
				branch: "feature/雪",
				worktreeBaselineDirty: true,
				runtimeStatePath: path.join(ownerManifest.privateRoot, "runtime-state.json"),
				ownerRoleArgv: spawned[0]?.command,
			});
			expect(
				parseVisibleSessionOwnerReadyAcknowledgement(
					JSON.parse(await fs.readFile(visibleSessionOwnerReadyPath(ownerManifest.privateRoot), "utf8")),
				),
			).toEqual({
				schemaVersion: 1,
				generationId: receipt.generationId,
				leaseId: ownerManifest.leaseId,
				ownerPid: receipt.ownerPid,
			});
		});
	});
	it("does not start the status probe or allocate a generation after the branch probe exhausts the deadline", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const registry = new VisibleSessionRegistry({ agentDir });
			await registry.initialize();
			const probes: string[][] = [];
			let clock = 0;
			let spawns = 0;
			await expect(
				launchVisibleSession(
					{
						registry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
						ownerReadyTimeoutMs: 100,
					},
					{
						runtime: runtime("compiled"),
						now: () => clock,
						gitProbe: async command => {
							probes.push([...command]);
							if (!command.includes("status")) clock = 100;
							return { exitCode: 0, stdout: command.includes("status") ? "" : "main\n" };
						},
						spawn: () => {
							spawns += 1;
							return deferredRole(10 + spawns);
						},
					},
				),
			).rejects.toThrow("launch deadline elapsed");
			expect(probes).toEqual([["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]]);
			expect(spawns).toBe(0);
			expect((await registry.read()).entries).toEqual([]);
		});
	});
	it("cancels and joins a deadline-losing injected Git probe before rejecting", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			let cancelled = false;
			let joined = false;
			const settled = Promise.withResolvers<void>();
			const launch = launchVisibleSession(
				{
					registry: new VisibleSessionRegistry({ agentDir }),
					input: { name: "Alpha", repository, worktree, backend: "conpty" },
					executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					ownerReadyTimeoutMs: 10,
				},
				{
					runtime: runtime("compiled"),
					gitProbe: async (_command, { signal }) => {
						signal.addEventListener(
							"abort",
							() => {
								cancelled = true;
								joined = true;
								settled.resolve();
							},
							{ once: true },
						);
						await settled.promise;
						return { exitCode: 0, stdout: "main\n" };
					},
				},
			);
			await expect(launch).rejects.toThrow("launch deadline elapsed");
			expect({ cancelled, joined }).toEqual({ cancelled: true, joined: true });
		});
	});
	it("does not write a manifest or spawn roles when allocation exhausts the deadline", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const registry = new VisibleSessionRegistry({ agentDir });
			const create = registry.create.bind(registry);
			let clock = 0;
			let spawns = 0;
			const createSpy = vi.spyOn(registry, "create").mockImplementation(async input => {
				const created = await create(input);
				clock = 100;
				return created;
			});
			try {
				await expect(
					launchVisibleSession(
						{
							registry,
							input: { name: "Alpha", repository, worktree, backend: "conpty" },
							executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
							ownerReadyTimeoutMs: 100,
						},
						{
							runtime: runtime("compiled"),
							now: () => clock,
							gitProbe: async command => ({
								exitCode: 0,
								stdout: command.includes("status") ? "" : "main\n",
							}),
							spawn: () => {
								spawns += 1;
								return deferredRole(10 + spawns);
							},
						},
					),
				).rejects.toThrow("launch deadline elapsed");
			} finally {
				createSpy.mockRestore();
			}
			const active = (await registry.read()).entries[0]?.active;
			expect(active?.status).toBe("prepared");
			expect(spawns).toBe(0);
			if (!active) throw new Error("Expected the prepared generation to remain allocated");
			await expect(fs.access(active.manifestFilePath)).rejects.toThrow();
		});
	});
	it("joins stdout and stderr from both default Git baseline probes", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const drained: string[] = [];
			const gitCommands: string[][] = [];
			let roleSpawns = 0;
			const releaseBranchStderr = Promise.withResolvers<void>();
			const branchStdoutDrained = Promise.withResolvers<void>();
			const branchStderrBlocked = Promise.withResolvers<void>();
			function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
			function mockSpawn(command: string[], options?: SpawnOptions): Subprocess;
			function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), _second?: SpawnOptions): Subprocess {
				const command = Array.isArray(first) ? first : first.cmd;
				if (command[0] === "git") {
					const stage = command.includes("status") ? "status" : "branch";
					gitCommands.push(command);
					return {
						pid: 1,
						stdout: trackedTextStream(
							stage === "status" ? "" : "main\n",
							`${stage}:stdout`,
							drained,
							undefined,
							stage === "branch" ? () => branchStdoutDrained.resolve() : undefined,
						),
						stderr: trackedTextStream(
							`${stage} warning\n`,
							`${stage}:stderr`,
							drained,
							stage === "branch"
								? () => {
										branchStderrBlocked.resolve();
										return releaseBranchStderr.promise;
									}
								: undefined,
						),
						exited: Promise.resolve(0),
						kill() {},
					} as Subprocess;
				}
				const exit = Promise.withResolvers<number>();
				return {
					pid: 71 + roleSpawns++,
					stdout: null,
					stderr: null,
					exited: exit.promise,
					unref() {},
					kill() {
						exit.resolve(0);
					},
				} as unknown as Subprocess;
			}
			const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
			try {
				const launch = launchVisibleSession(
					{
						registry: new VisibleSessionRegistry({ agentDir }),
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					},
					{
						runtime: runtime("compiled"),
						createReadyClient: () => ({ call: async () => ({ ok: true, result: true }) }),
						readMonitorReady: async file => {
							const value = JSON.parse(
								await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8"),
							) as { generationId: string; leaseId: string };
							return { schemaVersion: 1 as const, ...value, monitorPid: 72 };
						},
					},
				);
				await Promise.all([branchStdoutDrained.promise, branchStderrBlocked.promise]);
				await Promise.resolve();
				await Promise.resolve();
				expect(gitCommands).toHaveLength(1);
				expect(roleSpawns).toBe(0);
				releaseBranchStderr.resolve();
				await launch;
				expect(gitCommands).toEqual([
					["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"],
					["git", "-C", worktree, "status", "--porcelain=v1", "--untracked-files=normal"],
				]);
				expect(drained.sort()).toEqual(["branch:stderr", "branch:stdout", "status:stderr", "status:stdout"]);
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});
	it("joins the default Git child and both drains before its launch deadline rejects", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const drained: string[] = [];
			const release = Promise.withResolvers<void>();
			const exited = Promise.withResolvers<number>();
			let kills = 0;
			const completeExit = () => {
				if (drained.length === 2) exited.resolve(137);
			};
			function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
			function mockSpawn(command: string[], options?: SpawnOptions): Subprocess;
			function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), _second?: SpawnOptions): Subprocess {
				const command = Array.isArray(first) ? first : first.cmd;
				if (command[0] !== "git") throw new Error("role launch must not begin before the Git deadline");
				return {
					pid: 1,
					stdout: trackedTextStream("main\n", "stdout", drained, () => release.promise, completeExit),
					stderr: trackedTextStream("warning\n", "stderr", drained, () => release.promise, completeExit),
					exited: exited.promise,
					kill() {
						kills += 1;
						release.resolve();
					},
				} as Subprocess;
			}
			const spawnSpy = vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
			try {
				await expect(
					launchVisibleSession(
						{
							registry: new VisibleSessionRegistry({ agentDir }),
							input: { name: "Alpha", repository, worktree, backend: "conpty" },
							executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
							ownerReadyTimeoutMs: 10,
						},
						{ runtime: runtime("compiled") },
					),
				).rejects.toThrow("launch deadline elapsed");
				expect({ kills, drained: drained.sort() }).toEqual({ kills: 1, drained: ["stderr", "stdout"] });
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});
	it("surfaces an early owner exit with its role and exit code", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const exits = Promise.withResolvers<number>();
			const registry = new VisibleSessionRegistry({ agentDir });
			let ordinal = 0;
			queueMicrotask(() => exits.resolve(17));
			await expect(
				launchVisibleSession(
					{
						registry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
						ownerReadyTimeoutMs: 10,
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						now: () => 0,
						sleep: async () => {},
						readVanished: async () => ({
							generationId: (await registry.read()).entries[0]?.active.generationId ?? "",
						}),
						privateCredentialsPresent: async () => false,
						spawn: () => {
							ordinal++;
							return ordinal === 1
								? {
										pid: 71,
										unref() {},
										kill() {
											exits.resolve(17);
										},
										exited: exits.promise,
									}
								: deferredRole(72);
						},
					},
				),
			).rejects.toThrow("owner role exited before readiness (exit code 17)");
		});
	});
	it("does not accept a ready owner response behind a stale monitor acknowledgement", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const registry = new VisibleSessionRegistry({ agentDir });
			let calls = 0;
			let clock = 0;
			await expect(
				launchVisibleSession(
					{
						registry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
						ownerReadyTimeoutMs: 1_000,
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						createReadyClient: () => ({
							call: async () => {
								calls++;
								return { ok: true, result: true };
							},
						}),
						readMonitorReady: async () => ({
							schemaVersion: 1,
							generationId: "stale-generation",
							leaseId: "stale-lease",
							monitorPid: 20,
						}),
						now: () => clock,
						sleep: async milliseconds => {
							clock += milliseconds;
						},
						spawn: () => ({
							pid: 20,
							unref() {},
							kill() {},
							exited: Promise.withResolvers<number>().promise,
						}),
					},
				),
			).rejects.toThrow("monitor readiness acknowledgement identity does not match");
			expect(calls).toBe(0);
		});
	});
	it("rejects a readiness receipt whose only mismatch is the monitor PID", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			let clock = 0;
			let calls = 0;
			await expect(
				launchVisibleSession(
					{
						registry: new VisibleSessionRegistry({ agentDir }),
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
						ownerReadyTimeoutMs: 100,
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						createReadyClient: () => ({
							call: async () => {
								calls += 1;
								return { ok: true, result: true };
							},
						}),
						readMonitorReady: async file => {
							const value = JSON.parse(
								await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8"),
							) as {
								generationId: string;
								leaseId: string;
							};
							return { schemaVersion: 1 as const, ...value, monitorPid: 999 };
						},
						now: () => clock,
						sleep: async milliseconds => {
							clock += milliseconds;
						},
						spawn: () => deferredRole(20),
					},
				),
			).rejects.toThrow("monitor readiness acknowledgement identity does not match");
			expect(calls).toBe(0);
		});
	});

	it("keeps spawn and activation failures recoverable as prepared allocations", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree)]);
			const executable = { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} };
			const spawnRegistry = new VisibleSessionRegistry({
				agentDir: await fs.mkdtemp(path.join(root, "spawn-agent-")),
			});
			await expect(
				launchVisibleSession(
					{
						registry: spawnRegistry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable,
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						spawn: () => {
							throw new Error("spawn failed");
						},
					},
				),
			).rejects.toThrow("spawn failed");
			expect((await spawnRegistry.read()).entries[0].active.status).toBe("prepared");

			let killed = 0;
			const activationRegistry = new FailingActivationRegistry({
				agentDir: await fs.mkdtemp(path.join(root, "activation-agent-")),
			});
			await expect(
				launchVisibleSession(
					{
						registry: activationRegistry,
						input: { name: "Beta", repository, worktree, backend: "conpty" },
						executable,
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						spawn: () =>
							deferredRole(12, () => {
								killed++;
							}),
					},
				),
			).rejects.toThrow("activation failed");
			expect(killed).toBe(1);
			expect((await activationRegistry.read()).entries[0].active.status).toBe("prepared");
		});
	});
	it("does not roll back an activation until a nonterminating owner has exited after hard kill", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const registry = new VisibleSessionRegistry({ agentDir });
			const signals: (NodeJS.Signals | undefined)[] = [];
			const never = Promise.withResolvers<number>();
			let spawns = 0;
			await expect(
				launchVisibleSession(
					{
						registry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						sleep: async () => {},
						spawn: () => {
							if (spawns++ > 0) throw new Error("monitor startup failed");
							return {
								pid: 41,
								unref() {},
								kill(signal) {
									signals.push(signal);
								},
								exited: never.promise,
							};
						},
					},
				),
			).rejects.toThrow("did not exit after hard kill");
			expect(signals).toEqual([undefined, "SIGKILL"]);
			expect((await registry.read()).entries[0]?.active.status).toBe("active");
		});
	});
	it("keeps a ready monitor for failed-owner recovery and permits recreation from vanished evidence", async () => {
		await withTempDir(async root => {
			const agentDir = path.join(root, "agent");
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			await Promise.all([fs.mkdir(agentDir), fs.mkdir(repository), fs.mkdir(worktree)]);
			const registry = new VisibleSessionRegistry({ agentDir });
			let clock = 0;
			let ready = false;
			let killedOwners = 0;
			let spawns = 0;
			let monitorPid = 0;
			const dependencies = {
				runtime: runtime("compiled"),
				...launchReadinessDependencies,
				spawn: () => {
					const ordinal = ++spawns;
					const pid = 69 + ordinal;
					if (ordinal % 2 === 0) monitorPid = pid;
					return deferredRole(pid, () => {
						if (ordinal === 1) killedOwners++;
					});
				},
				createReadyClient: () => ({ call: async () => ({ ok: ready, result: true }) }),
				readMonitorReady: async (file: string) => {
					const value = JSON.parse(await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8")) as {
						generationId: string;
						leaseId: string;
					};
					return { schemaVersion: 1 as const, ...value, monitorPid };
				},
				now: () => clock,
				sleep: async (milliseconds: number) => {
					if (milliseconds <= 100) clock += milliseconds;
				},
				readVanished: async (_file: string) => {
					const current = (await registry.read()).entries[0]?.active;
					if (!current) throw new Error("missing active generation");
					return { generationId: current.generationId };
				},
				privateCredentialsPresent: async () => false,
			};
			const executable = { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} };
			await expect(
				launchVisibleSession(
					{
						registry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable,
						ownerReadyTimeoutMs: 1_000,
					},
					dependencies,
				),
			).rejects.toThrow("ready");
			const failed = (await registry.read()).entries[0]?.active;
			expect(failed?.status).toBe("active");
			expect(killedOwners).toBe(1);

			ready = true;
			const recreated = await launchVisibleSession(
				{
					registry,
					recreate: true,
					input: {
						name: "Alpha",
						repository,
						worktree,
						backend: "conpty",
						expectedRevision: (await registry.read()).revision,
						expectedActiveGeneration: failed?.generationId ?? "",
					},
					executable,
				},
				dependencies,
			);
			expect(recreated.generationId).not.toBe(failed?.generationId);
		});
	});
	it("accepts a strict final receipt while separately waiting for failed-launch cleanup", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			expect(parseVisibleSessionFinalAcknowledgement(finalAcknowledgement("1-abcdef"))).toEqual({
				generationId: "1-abcdef",
			});
			expect(() =>
				parseVisibleSessionFinalAcknowledgement({ ...finalAcknowledgement("1-abcdef"), unexpected: true }),
			).toThrow("corrupt");
			const registry = new VisibleSessionRegistry({ agentDir });
			let clock = 0;
			let spawns = 0;
			let finalWritten = false;
			const launch = launchVisibleSession(
				{
					registry,
					input: { name: "Alpha", repository, worktree, backend: "conpty" },
					executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					ownerReadyTimeoutMs: 1_000,
				},
				{
					runtime: runtime("compiled"),
					gitProbe: async command => ({
						exitCode: 0,
						stdout: command.includes("status") ? "" : "main\n",
					}),
					spawn: () => deferredRole(71 + spawns++),
					createReadyClient: () => ({ call: async () => ({ ok: false, result: false }) }),
					readMonitorReady: async file => {
						const value = JSON.parse(
							await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8"),
						) as {
							generationId: string;
							leaseId: string;
						};
						return { schemaVersion: 1, ...value, monitorPid: 72 };
					},
					now: () => clock,
					sleep: async milliseconds => {
						clock += milliseconds;
					},
					privateCredentialsPresent: async manifest => {
						if (!finalWritten) {
							finalWritten = true;
							await fs.writeFile(
								path.join(manifest.publicRoot, "final.json"),
								`${JSON.stringify(finalAcknowledgement(manifest.generationId))}\n`,
							);
						}
						return false;
					},
				},
			);
			await expect(launch).rejects.toThrow("ready");
			expect(finalWritten).toBe(true);
			expect((await registry.read()).entries[0]?.active.status).toBe("active");
		});
	});
	it("rolls back the exact owner activation when monitor startup and recovery both fail", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const registry = new VisibleSessionRegistry({ agentDir });
			let spawns = 0;
			let ownerKills = 0;
			await expect(
				launchVisibleSession(
					{
						registry,
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						spawn: () => {
							spawns++;
							if (spawns === 1)
								return deferredRole(41, () => {
									ownerKills++;
								});
							throw new Error(spawns === 2 ? "monitor startup failed" : "recovery monitor startup failed");
						},
					},
				),
			).rejects.toMatchObject({
				errors: expect.arrayContaining([
					expect.objectContaining({ message: "monitor startup failed" }),
					expect.objectContaining({ message: "recovery monitor startup failed" }),
				]),
			});
			expect(ownerKills).toBe(1);
			expect((await registry.read()).entries[0]?.active).toMatchObject({ status: "prepared" });
		});
	});

	it("requires both terminal evidence and private cleanup before recovery completes", async () => {
		for (const recovery of [
			{ terminalEvidence: false, privateCredentialsPresent: false },
			{ terminalEvidence: true, privateCredentialsPresent: true },
		]) {
			await withTempDir(async root => {
				const repository = path.join(root, "repo");
				const worktree = path.join(root, "worktree");
				const agentDir = path.join(root, "agent");
				await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
				const registry = new VisibleSessionRegistry({ agentDir });
				let clock = 0;
				let ownerKills = 0;
				let monitorKills = 0;
				let spawns = 0;
				let monitorPid = 0;
				await expect(
					launchVisibleSession(
						{
							registry,
							input: { name: "Alpha", repository, worktree, backend: "conpty" },
							executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
							ownerReadyTimeoutMs: 1_000,
						},
						{
							runtime: runtime("source"),
							...launchReadinessDependencies,
							createReadyClient: () => ({ call: async () => ({ ok: false, result: false }) }),
							readMonitorReady: async file => {
								const value = JSON.parse(
									await fs.readFile(path.join(path.dirname(file), "manifest.json"), "utf8"),
								) as { generationId: string; leaseId: string };
								return { schemaVersion: 1 as const, ...value, monitorPid };
							},
							now: () => clock,
							sleep: async milliseconds => {
								clock += milliseconds;
							},
							readVanished: async () => {
								if (!recovery.terminalEvidence) throw new Error("owner has not terminalized");
								const active = (await registry.read()).entries[0]?.active;
								if (!active) throw new Error("missing active generation");
								return { generationId: active.generationId };
							},
							privateCredentialsPresent: async () => recovery.privateCredentialsPresent,
							spawn: () => {
								const ordinal = ++spawns;
								if (ordinal === 2) monitorPid = 50 + ordinal;
								return deferredRole(50 + ordinal, () => {
									if (ordinal === 1) ownerKills++;
									else monitorKills++;
								});
							},
						},
					),
				).rejects.toMatchObject({
					errors: [
						expect.objectContaining({ message: expect.stringContaining("roles did not become ready") }),
						expect.objectContaining({
							message: expect.stringContaining("recovery monitor did not terminalize and clean up"),
						}),
					],
				});
				expect({ ownerKills, monitorKills, spawns }).toEqual({ ownerKills: 1, monitorKills: 0, spawns: 2 });
				expect((await registry.read()).entries[0]?.active).toMatchObject({
					status: "active",
					process: { pid: 51 },
				});
			});
		}
	});
	it("rejects an owner exit settled by the affirmative readiness response", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const ownerExit = Promise.withResolvers<number>();
			let spawned = 0;
			await expect(
				launchVisibleSession(
					{
						registry: new VisibleSessionRegistry({ agentDir }),
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						createReadyClient: () => ({
							call: async () => {
								ownerExit.resolve(0);
								return { ok: true, result: true };
							},
						}),
						readMonitorReady: async file => ({
							...(await launchReadinessDependencies.readMonitorReady(file)),
							monitorPid: 82,
						}),
						spawn: () => {
							spawned += 1;
							return spawned === 1
								? { pid: 81, unref() {}, kill: () => ownerExit.resolve(0), exited: ownerExit.promise }
								: deferredRole(82);
						},
					},
				),
			).rejects.toThrow("owner role exited");
		});
	});
	it("clears successful readiness deadlines", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
			let ordinal = 0;
			try {
				await launchVisibleSession(
					{
						registry: new VisibleSessionRegistry({ agentDir }),
						input: { name: "Alpha", repository, worktree, backend: "conpty" },
						executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
					},
					{
						runtime: runtime("compiled"),
						...launchReadinessDependencies,
						spawn: (_command, _options) => deferredRole(10 + ordinal++),
					},
				);
				expect(clearTimeoutSpy).toHaveBeenCalled();
			} finally {
				clearTimeoutSpy.mockRestore();
			}
		});
	});
	it("cancels open detached stderr streams at the readiness cutoff", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			let cancelled = 0;
			let ordinal = 0;
			await launchVisibleSession(
				{
					registry: new VisibleSessionRegistry({ agentDir }),
					input: { name: "Alpha", repository, worktree, backend: "conpty" },
					executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
				},
				{
					runtime: runtime("compiled"),
					...launchReadinessDependencies,
					spawn: () => {
						ordinal += 1;
						return {
							...deferredRole(9 + ordinal),
							stderr:
								ordinal === 1
									? new ReadableStream<Uint8Array>({
											pull() {},
											cancel() {
												cancelled += 1;
											},
										})
									: null,
						};
					},
				},
			);
			expect(cancelled).toBe(1);
		});
	});
	it("retains byte-bounded split-token startup diagnostics", async () => {
		await withTempDir(async root => {
			const repository = path.join(root, "repo");
			const worktree = path.join(root, "worktree");
			const agentDir = path.join(root, "agent");
			await Promise.all([fs.mkdir(repository), fs.mkdir(worktree), fs.mkdir(agentDir)]);
			let ordinal = 0;
			const receipt = await launchVisibleSession(
				{
					registry: new VisibleSessionRegistry({ agentDir }),
					input: { name: "Alpha", repository, worktree, backend: "conpty" },
					executable: { executable: path.join(root, "owner"), args: [], cwd: worktree, env: {} },
				},
				{
					runtime: runtime("compiled"),
					...launchReadinessDependencies,
					spawn: command => {
						ordinal += 1;
						const tokenFilePath = path.join(path.dirname(String(command.at(-1))), "control-token");
						return {
							...deferredRole(9 + ordinal),
							stderr:
								ordinal === 1
									? new ReadableStream<Uint8Array>({
											async start(controller) {
												const token = (await fs.readFile(tokenFilePath)).toString("hex");
												controller.enqueue(Buffer.from(`prefix ${token.slice(0, 40)}`));
												controller.enqueue(
													Buffer.from(`${token.slice(40)} trailing ${"雪".repeat(3_000)}`),
												);
												controller.close();
											},
										})
									: null,
						};
					},
				},
			);
			await Bun.sleep(0);
			const privateRoot = path.join(root, "agent", "visible-sessions", "private", "alpha", receipt.generationId);
			const token = (await fs.readFile(path.join(privateRoot, "control-token"))).toString("hex");
			const diagnostics = await fs.readFile(visibleSessionStartupDiagnosticsPath(privateRoot), "utf8");
			expect(diagnostics).not.toContain(token);
			expect(Buffer.byteLength(diagnostics, "utf8")).toBeLessThanOrEqual(8_192);
			expect(diagnostics).toContain("--- owner stderr ---");
			expect(diagnostics).toContain("prefix [redacted] trailing");
		});
	});
});
