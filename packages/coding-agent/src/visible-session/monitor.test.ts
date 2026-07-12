import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProcessStatus } from "@gajae-code/natives";
import { ControlClientError } from "./control-client";
import { controlEndpointFor } from "./control-server";
import {
	type VisibleSessionOwnerManifest,
	visibleSessionControlToken,
	visibleSessionOwnerReadyPath,
	writeVisibleSessionOwnerReady,
} from "./launch";
import {
	runVisibleSessionMonitor,
	type VisibleSessionMonitorDependencies,
	visibleSessionMonitorHealthPath,
	writeVisibleSessionMonitorReady,
} from "./monitor";
import { VisibleSessionStateMonitor, VisibleSessionStateOwner, type VisibleSessionStateProjection } from "./state";
import type { VisibleSessionRegistryFile } from "./types";

async function temporary<T>(run: (root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-monitor-"));
	try {
		return await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function fixture(root: string): Promise<{
	manifest: VisibleSessionOwnerManifest;
	state: VisibleSessionStateMonitor;
	owner: VisibleSessionStateOwner;
	deps: VisibleSessionMonitorDependencies;
}> {
	const generationId = "1-abcdef";
	const privateRoot = path.join(root, "visible-sessions", "private", "alpha", generationId);
	const publicRoot = path.join(root, "visible-sessions", "public", "alpha", generationId);
	const token = Buffer.alloc(32, 7);
	const manifest: VisibleSessionOwnerManifest = {
		schemaVersion: 3,
		generationId,
		startIdentity: "owner-identity",
		leaseId: "0123456789abcdef0123456789abcdef",
		agentDir: root,
		name: "Alpha",
		key: "alpha",
		repo: path.join(root, "repo"),
		worktree: path.join(root, "worktree"),
		backend: "conpty",
		publicRoot,
		privateRoot,
		tokenFilePath: path.join(privateRoot, "control-token"),
		controlEndpoint: controlEndpointFor({ privateGenerationRoot: privateRoot, generation: generationId }),
		executable: path.join(root, "gjc"),
		args: [],
		cwd: root,
		env: {},
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
	const identity = {
		generationId,
		leaseId: manifest.leaseId,
		owner: { pid: 42, startIdentity: manifest.startIdentity },
		redactions: [token.toString("hex")],
	};
	const projection: VisibleSessionStateProjection = {
		publicRoot,
		privateRoot,
		session: manifest.name,
		workdir: manifest.worktree,
		branch: manifest.branch,
		createdAt: manifest.createdAt,
		gjcBin: manifest.executable,
		worktreeBaselineDirty: manifest.worktreeBaselineDirty,
		owner: { pid: 42, startedAt: manifest.createdAt },
		backend: "conpty",
	};
	const owner = new VisibleSessionStateOwner(projection, identity);
	await owner.initialize();
	const state = new VisibleSessionStateMonitor(projection, identity);
	const registry: VisibleSessionRegistryFile = {
		schemaVersion: 1,
		revision: 1,
		nextGenerationCounter: 1,
		managedPublicBases: [{ id: "default", path: path.join(root, "visible-sessions", "public"), claimedAt: "now" }],
		entries: [
			{
				name: { displayName: "Alpha", key: "alpha" },
				repository: manifest.repo,
				worktree: manifest.worktree,
				backend: "conpty",
				history: [],
				active: {
					generationId,
					counter: 1,
					status: "active",
					startIdentity: manifest.startIdentity,
					leaseId: manifest.leaseId,
					publicBaseId: "default",
					publicRoot,
					privateRoot,
					manifestFilePath: path.join(privateRoot, "manifest.json"),
					createdAt: "now",
					process: { pid: 42, startedAt: manifest.createdAt, hostname: os.hostname() },
					tokenFilePath: manifest.tokenFilePath,
					tokenSha256: createHash("sha256").update(token).digest("hex"),
				},
			},
		],
	};
	return {
		manifest,
		state,
		owner,
		deps: {
			registry: { read: async () => registry },
			readManifest: async () => manifest,
			readToken: async () => token,
			createState: () => state,
			processFromPid: () => ({
				args: () => [
					process.execPath,
					"visible-session",
					"owner-internal",
					"--manifest",
					path.join(privateRoot, "manifest.json"),
				],
				status: () => ProcessStatus.Running,
			}),
			sleep: async () => {},
			pollIntervalMs: 1,
			lossConfirmations: 2,
			maxPolls: 2,
		},
	};
}
async function commitFinal(
	owner: VisibleSessionStateOwner,
	generationId: string,
	ownerExitReason = "done",
): Promise<void> {
	const metadata = await owner.readMetadata();
	await owner.commitFinal({
		expectedRevision: metadata.revision,
		record: {
			schemaVersion: 2,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner: { pid: 42, startedAt: "now" },
			session: "Alpha",
			status: 0,
			startedAt: "now",
			finishedAt: "now",
			paneLog: "pane.log",
			runtimeState: "runtime-state.json",
			turnEvidencePresent: false,
			promptAccepted: false,
			ownerExitReason,
			severity: "normal",
			runtimeTerminal: true,
			runtimeTerminalState: "completed",
			runtimeTerminalSource: "test",
			worktreeBaselineDirty: false,
			observedRecoverableWorktreeChanges: false,
			worktreeChangedSinceBaseline: false,
			runtimeStateSummary: {
				summary: "",
				status: "completed",
				updatedAt: "now",
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
				ownerExitReason,
				severity: "normal",
			},
			committedAt: "now",
			runtimeSummary: "",
			worktreeSummary: "",
			evidenceSummary: "",
		},
	});
}
function liveStatus(generation: string): {
	ok: true;
	result: { generation: string; ready: boolean; running: boolean; cancelRequested: boolean };
} {
	return { ok: true, result: { generation, ready: true, running: true, cancelRequested: false } };
}

describe("visible-session monitor", () => {
	it("keeps an authenticated live owner nonterminal", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({ call: async () => liveStatus(value.manifest.generationId) }),
				processFromPid: () => ({
					status: () => ProcessStatus.Running,
					args: () => [
						process.execPath,
						"visible-session",
						"owner-internal",
						"--manifest",
						path.join(value.manifest.privateRoot, "manifest.json"),
					],
				}),
			});
			expect(await value.state.readTerminal()).toBeNull();
		}));
	it("does not treat a different status generation as owner proof", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({ call: async () => liveStatus("other-generation") }),
				processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
			});
			expect((await value.state.readTerminal())?.generationId).toBe(value.manifest.generationId);
		}));
	it("does not treat malformed status fields as owner proof", async () => {
		for (const result of [
			{ generation: "1-abcdef", ready: "true", running: true, cancelRequested: false },
			{ generation: "1-abcdef", ready: true, running: "true", cancelRequested: false },
			{ generation: "1-abcdef", ready: true, running: true, cancelRequested: "false" },
		]) {
			await temporary(async root => {
				const value = await fixture(root);
				await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					createControlClient: () => ({ call: async () => ({ ok: true, result }) }),
					processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
				});
				expect((await value.state.readTerminal())?.generationId).toBe(value.manifest.generationId);
			});
		}
	});
	it("rejects hex-text control token files", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await expect(
				runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					readToken: async () => Buffer.from(Buffer.alloc(32, 7).toString("hex")),
				}),
			).rejects.toThrow("token is invalid");
		}));

	it("accepts an exact readiness receipt restart and rejects a monitor PID mismatch", async () =>
		temporary(async root => {
			const file = path.join(root, "monitor-ready.json");
			const receipt = { schemaVersion: 1 as const, generationId: "generation", leaseId: "lease", monitorPid: 42 };
			await writeVisibleSessionMonitorReady(file, receipt);
			await writeVisibleSessionMonitorReady(file, receipt);
			await expect(writeVisibleSessionMonitorReady(file, { ...receipt, monitorPid: 43 })).rejects.toThrow(
				"belongs to another monitor",
			);
		}));
	it("waits for owner state initialization before publishing readiness", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let reads = 0;
			let readyAfterReads = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createState: () =>
					({
						readMetadata: async () => {
							reads += 1;
							if (reads === 1) throw Object.assign(new Error("metadata pending"), { code: "ENOENT" });
							return { revision: 0 };
						},
						readTerminal: async () => null,
					}) as never,
				writeMonitorReady: async () => {
					readyAfterReads = reads;
				},
				stateInitializationAttempts: 2,
				maxPolls: 1,
			});
			expect({ reads, readyAfterReads }).toEqual({ reads: 2, readyAfterReads: 2 });
		}));
	it("rejects a pre-aborted monitor before it publishes readiness", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const controller = new AbortController();
			controller.abort();
			let readyWrites = 0;
			await expect(
				runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					signal: controller.signal,
					writeMonitorReady: async () => {
						readyWrites += 1;
					},
				}),
			).rejects.toThrow("cancelled before readiness");
			expect(readyWrites).toBe(0);
		}));
	it("continues monitoring after readiness cancellation until it owns terminal cleanup", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const controller = new AbortController();
			let readyWrites = 0;
			let calls = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				signal: controller.signal,
				writeMonitorReady: async () => {
					readyWrites += 1;
					controller.abort();
				},
				createControlClient: () => ({
					call: async () => {
						calls += 1;
						throw new ControlClientError("connect_failed");
					},
				}),
				processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
				rm: async () => {},
			});
			expect({ readyWrites, calls }).toEqual({ readyWrites: 1, calls: 2 });
			expect((await value.state.readTerminal())?.generationId).toBe(value.manifest.generationId);
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
		}));
	it("fails explicitly when the owner exits before state initialization", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let readyWrites = 0;
			await expect(
				runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					createState: () =>
						({
							readMetadata: async () => {
								throw Object.assign(new Error("metadata pending"), { code: "ENOENT" });
							},
						}) as never,
					processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
					writeMonitorReady: async () => {
						readyWrites += 1;
					},
					stateInitializationAttempts: 2,
				}),
			).rejects.toThrow("exited before state initialization");
			expect(readyWrites).toBe(0);
		}));
	it("rejects an absent owner process at monitor startup", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await expect(
				runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					processFromPid: () => null,
				}),
			).rejects.toThrow("owner process is absent at startup");
		}));
	it("resumes terminal cleanup when the owner is already absent at startup", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			const removed: string[] = [];
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				processFromPid: () => null,
				rm: async file => {
					removed.push(file);
				},
			});
			expect(removed).toEqual(expect.arrayContaining([value.manifest.tokenFilePath]));
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
		}));
	it("requires unavailable control and repeated exact owner loss before publishing vanished", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
					},
				}),
				processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
			});
			const terminal = await value.state.readTerminal();
			expect(terminal?.generationId).toBe(value.manifest.generationId);
			expect(JSON.stringify(terminal)).not.toContain("070707");
		}));

	it("does not vanish an alive PID when control times out", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
					},
				}),
				processFromPid: () => ({
					status: () => ProcessStatus.Running,
					args: () => [
						process.execPath,
						"visible-session",
						"owner-internal",
						"--manifest",
						path.join(value.manifest.privateRoot, "manifest.json"),
					],
				}),
			});
			expect(await value.state.readTerminal()).toBeNull();
		}));
	it("retries an unknown owner observation until a later exact live observation", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let observations = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
					},
				}),
				processFromPid: () => ({
					status: () => ProcessStatus.Running,
					args: () => {
						observations += 1;
						return observations === 1 ? value.manifest.ownerRoleArgv.slice(0, -1) : value.manifest.ownerRoleArgv;
					},
				}),
			});
			expect(observations).toBe(2);
			expect(await value.state.readTerminal()).toBeNull();
		}));
	it("does not count an unknown observation toward repeated exact owner loss", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let observations = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				maxPolls: 3,
				createControlClient: () => ({
					call: async () => {
						throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
					},
				}),
				processFromPid: () => ({
					status: () => {
						observations += 1;
						return observations === 1 ? ProcessStatus.Running : ProcessStatus.Exited;
					},
					args: () => (observations === 1 ? value.manifest.ownerRoleArgv.slice(0, -1) : []),
				}),
			});
			expect(observations).toBe(3);
			expect((await value.state.readTerminal())?.generationId).toBe(value.manifest.generationId);
		}));
	it("records ControlClientError connect failures privately and keeps an exact live owner nonterminal", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw new ControlClientError("connect_failed");
					},
				}),
				processFromPid: () => ({
					status: () => ProcessStatus.Running,
					args: () => [
						process.execPath,
						"visible-session",
						"owner-internal",
						"--manifest",
						path.join(value.manifest.privateRoot, "manifest.json"),
					],
				}),
			});
			expect(await value.state.readTerminal()).toBeNull();
			const health = JSON.parse(
				await fs.readFile(visibleSessionMonitorHealthPath(value.manifest.privateRoot), "utf8"),
			) as { failureCode: string; message: string; observedAt: string; schemaVersion: number };
			expect(health).toEqual({
				failureCode: "connect_failed",
				message: "connect_failed",
				schemaVersion: 1,
				observedAt: expect.any(String),
			});
		}));
	it("does not retain a token split across the UTF-8 health bound", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const token = visibleSessionControlToken(Buffer.alloc(32, 7));
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw new Error(`${"雪".repeat(80)}${token}`);
					},
				}),
				processFromPid: () => ({
					status: () => ProcessStatus.Running,
					args: () => [
						process.execPath,
						"visible-session",
						"owner-internal",
						"--manifest",
						path.join(value.manifest.privateRoot, "manifest.json"),
					],
				}),
			});
			const health = JSON.parse(
				await fs.readFile(visibleSessionMonitorHealthPath(value.manifest.privateRoot), "utf8"),
			) as { message: string };
			expect(health.message).not.toContain(token);
			expect(Buffer.byteLength(health.message, "utf8")).toBeLessThanOrEqual(256);
		}));

	it("treats a reused PID with different argv as owner loss", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" });
					},
				}),
				processFromPid: () => ({ status: () => ProcessStatus.Running, args: () => ["other-program"] }),
			});
			expect((await value.state.readTerminal())?.generationId).toBe(value.manifest.generationId);
		}));
	it("treats a PID whose argv has trailing impersonation arguments as owner loss", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" });
					},
				}),
				processFromPid: () => ({
					status: () => ProcessStatus.Running,
					args: () => [
						process.execPath,
						"visible-session",
						"owner-internal",
						"--manifest",
						path.join(value.manifest.privateRoot, "manifest.json"),
						"--impersonation",
					],
				}),
			});
			expect((await value.state.readTerminal())?.generationId).toBe(value.manifest.generationId);
		}));
	it("lets final win and only acknowledges its pending cleanup", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			const removed: string[] = [];
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				rm: async file => {
					removed.push(file);
				},
				createControlClient: () => ({ call: async () => liveStatus(value.manifest.generationId) }),
				processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
			});
			expect(((await value.state.readTerminal()) as { ownerExitReason?: string }).ownerExitReason).toBe("done");
			expect(removed).toEqual(
				expect.arrayContaining([
					value.manifest.tokenFilePath,
					path.join(value.manifest.privateRoot, "manifest.json"),
					path.join(value.manifest.privateRoot, "monitor-ready.json"),
					value.manifest.runtimeStatePath,
				]),
			);
		}));
	it("rejects cleanup claimed by a different real actor without deleting files", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			await value.state.claimCleanup("other-actor");
			const removed: string[] = [];
			await expect(
				runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					rm: async file => {
						removed.push(file);
					},
				}),
			).rejects.toThrow("already claimed");
			expect(removed).toEqual([]);
		}));
	it("propagates private prompt-evidence read failures", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const failure = Object.assign(new Error("prompt evidence denied"), { code: "EACCES" });
			const promptAccepted = vi.spyOn(value.state, "hasPromptAccepted").mockRejectedValue(failure);
			try {
				await expect(
					runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
						...value.deps,
						createControlClient: () => ({
							call: async () => {
								throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" });
							},
						}),
						processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
					}),
				).rejects.toBe(failure);
			} finally {
				promptAccepted.mockRestore();
			}
			expect(await value.state.readTerminal()).toBeNull();
		}));
	it("propagates a vanished commit failure when no terminal was committed", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const failure = new Error("vanished CAS failed");
			const commit = vi.spyOn(value.state, "commitVanished").mockRejectedValue(failure);
			try {
				await expect(
					runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
						...value.deps,
						createControlClient: () => ({
							call: async () => {
								throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" });
							},
						}),
						processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
					}),
				).rejects.toBe(failure);
			} finally {
				commit.mockRestore();
			}
			expect(await value.state.readTerminal()).toBeNull();
		}));

	it("accepts a concurrently committed final after vanished commit failure", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const failure = new Error("vanished CAS lost");
			const commit = vi.spyOn(value.state, "commitVanished").mockImplementation(async () => {
				await commitFinal(value.owner, value.manifest.generationId, "concurrent final");
				throw failure;
			});
			try {
				await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					createControlClient: () => ({
						call: async () => {
							throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" });
						},
					}),
					processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
				});
			} finally {
				commit.mockRestore();
			}
			expect(((await value.state.readTerminal()) as { ownerExitReason?: string }).ownerExitReason).toBe(
				"concurrent final",
			);
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
		}));

	it("recovers cleanup after delayed transient removal failures", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			let attempts = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				rm: async () => {
					attempts++;
					if (attempts < 3) throw Object.assign(new Error("transient remove failure"), { code: "EBUSY" });
				},
			});
			expect(attempts).toBeGreaterThanOrEqual(6);
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
		}));
	it("retains cleanup ownership through repeated removal failures", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			const claim = vi.spyOn(value.state, "claimCleanup");
			let removals = 0;
			try {
				await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
					...value.deps,
					rm: async () => {
						removals += 1;
						if (removals <= 5) throw Object.assign(new Error("remove failed"), { code: "EBUSY" });
					},
				});
				expect(claim).toHaveBeenCalledTimes(1);
			} finally {
				claim.mockRestore();
			}
			expect(removals).toBeGreaterThan(5);
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
		}));
	it("keeps the manifest anchor until token cleanup succeeds and resumes after restart", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			const manifestFile = path.join(value.manifest.privateRoot, "manifest.json");
			const firstRemoved: string[] = [];
			await expect(
				runVisibleSessionMonitor(manifestFile, {
					...value.deps,
					rm: async file => {
						firstRemoved.push(file);
						if (file === value.manifest.tokenFilePath)
							throw Object.assign(new Error("token busy"), { code: "EACCES" });
					},
				}),
			).rejects.toThrow("token busy");
			expect(firstRemoved).toContain(value.manifest.tokenFilePath);
			expect(firstRemoved).not.toContain(manifestFile);
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");

			const resumedRemoved: string[] = [];
			await runVisibleSessionMonitor(manifestFile, {
				...value.deps,
				rm: async file => {
					resumedRemoved.push(file);
				},
			});
			expect(resumedRemoved.slice(-2)).toEqual([value.manifest.tokenFilePath, manifestFile]);
		}));

	it("resumes acknowledged bootstrap cleanup after token deletion succeeds and manifest deletion fails", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			const manifestFile = path.join(value.manifest.privateRoot, "manifest.json");
			await fs.writeFile(manifestFile, "{}");
			await fs.writeFile(value.manifest.tokenFilePath, Buffer.alloc(32, 7));
			await expect(
				runVisibleSessionMonitor(manifestFile, {
					...value.deps,
					readToken: file => fs.readFile(file),
					rm: async file => {
						if (file === manifestFile) throw Object.assign(new Error("manifest denied"), { code: "EACCES" });
						await fs.rm(file, { force: true });
					},
				}),
			).rejects.toThrow("manifest denied");
			await expect(fs.readFile(value.manifest.tokenFilePath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.readFile(manifestFile, "utf8")).resolves.toBe("{}");
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");

			await runVisibleSessionMonitor(manifestFile, {
				...value.deps,
				readToken: file => fs.readFile(file),
			});
			await expect(fs.readFile(manifestFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		}));
	it("resumes acknowledged bootstrap cleanup after token deletion, registry drift, and monitor restart", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const manifestFile = path.join(value.manifest.privateRoot, "manifest.json");
			await fs.writeFile(manifestFile, `${JSON.stringify(value.manifest)}\n`);
			await fs.writeFile(value.manifest.tokenFilePath, Buffer.alloc(32, 7));
			await commitFinal(value.owner, value.manifest.generationId);
			await expect(
				runVisibleSessionMonitor(manifestFile, {
					...value.deps,
					readManifest: undefined,
					readToken: file => fs.readFile(file),
					rm: async file => {
						if (file === value.manifest.tokenFilePath) {
							await fs.rm(file, { force: true });
							return;
						}
						if (file === manifestFile) throw Object.assign(new Error("manifest denied"), { code: "EACCES" });
						await fs.rm(file, { force: true });
					},
				}),
			).rejects.toThrow("manifest denied");
			const registry = value.deps.registry;
			if (!registry) throw new Error("Fixture registry is missing");
			const drifted = await registry.read();
			const entry = drifted.entries[0];
			if (!entry) throw new Error("Fixture entry is missing");
			const prior = entry.active;
			entry.history.push(prior);
			entry.active = {
				...prior,
				generationId: "2-abcdef",
				startIdentity: "different-owner",
				leaseId: "different-lease",
			};

			await runVisibleSessionMonitor(manifestFile, {
				...value.deps,
				readManifest: undefined,
				readToken: file => fs.readFile(file),
			});
			await expect(fs.readFile(manifestFile)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
		}));
	it("surfaces permanent cleanup acknowledgement failures", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			const acknowledge = vi.spyOn(value.state, "ackCleanup");
			acknowledge.mockRejectedValueOnce(new Error("ack failed"));
			try {
				await expect(
					runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), value.deps),
				).rejects.toThrow("ack failed");
				expect(acknowledge).toHaveBeenCalledTimes(1);
			} finally {
				acknowledge.mockRestore();
			}
			expect((await value.state.readMetadata()).cleanup?.status).toBe("claimed");
		}));
	it("caps control backoff and resets it after a successful status", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const sleeps: number[] = [];
			let calls = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				maxPolls: 9,
				pollIntervalMs: 1_000,
				sleep: async milliseconds => {
					sleeps.push(milliseconds);
				},
				createControlClient: () => ({
					call: async () => {
						calls += 1;
						if (calls === 8) return liveStatus(value.manifest.generationId);
						throw new ControlClientError("connect_failed");
					},
				}),
			});
			expect(sleeps).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000, 1_000]);
		}));
	it("retains terminal cleanup when final commit races registry drift", async () =>
		temporary(async root => {
			const value = await fixture(root);
			const removed: string[] = [];
			let reads = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				registry: {
					read: async () => {
						reads += 1;
						const registry = await value.deps.registry?.read();
						if (!registry) throw new Error("missing fixture registry");
						if (reads === 2) {
							registry.entries[0]!.active.leaseId = "different-lease";
							await commitFinal(value.owner, value.manifest.generationId, "registry drift");
						}
						return registry;
					},
				},
				rm: async file => {
					removed.push(file);
				},
			});
			expect(((await value.state.readTerminal()) as { ownerExitReason?: string }).ownerExitReason).toBe(
				"registry drift",
			);
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
			expect(removed).toEqual(expect.arrayContaining([value.manifest.tokenFilePath]));
		}));
	it("keeps endpoint readiness in vanished evidence after a later false status", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let calls = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				maxPolls: 3,
				lossConfirmations: 1,
				createControlClient: () => ({
					call: async () => {
						calls += 1;
						if (calls === 3) throw new ControlClientError("connect_failed");
						return {
							ok: true,
							result: {
								generation: value.manifest.generationId,
								ready: calls === 1,
								running: true,
								cancelRequested: false,
							},
						};
					},
				}),
				processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
			});
			const terminal = await value.state.readTerminal();
			expect((terminal as { tuiReady?: boolean } | null)?.tuiReady).toBe(true);
		}));
	it("retains launch readiness written between monitor status polls", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let calls = 0;
			let readinessWritten = false;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				maxPolls: 2,
				lossConfirmations: 1,
				sleep: async () => {
					if (readinessWritten) return;
					readinessWritten = true;
					await writeVisibleSessionOwnerReady(visibleSessionOwnerReadyPath(value.manifest.privateRoot), {
						schemaVersion: 1,
						generationId: value.manifest.generationId,
						leaseId: value.manifest.leaseId,
						ownerPid: 42,
					});
				},
				createControlClient: () => ({
					call: async () => {
						calls += 1;
						if (calls === 1) {
							return {
								ok: true,
								result: {
									generation: value.manifest.generationId,
									ready: false,
									running: true,
									cancelRequested: false,
								},
							};
						}
						throw new ControlClientError("connect_failed");
					},
				}),
				processFromPid: () => ({ status: () => ProcessStatus.Exited, args: () => [] }),
			});
			expect(readinessWritten).toBe(true);
			const terminal = await value.state.readTerminal();
			expect((terminal as { tuiReady?: boolean } | null)?.tuiReady).toBe(true);
			await expect(fs.readFile(visibleSessionOwnerReadyPath(value.manifest.privateRoot))).rejects.toMatchObject({
				code: "ENOENT",
			});
		}));
	it("continues monitoring when private health writes fail", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let writes = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				createControlClient: () => ({
					call: async () => {
						throw new ControlClientError("connect_failed");
					},
				}),
				writeMonitorHealth: async () => {
					writes += 1;
					throw new Error("private disk failure");
				},
			});
			expect(writes).toBe(2);
			expect(await value.state.readTerminal()).toBeNull();
		}));
	it("stops without terminalizing when the active generation identity drifts", async () =>
		temporary(async root => {
			const value = await fixture(root);
			let reads = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				registry: {
					read: async () => {
						reads += 1;
						const registry = await value.deps.registry?.read();
						if (!registry) throw new Error("missing fixture registry");
						if (reads > 1) registry.entries[0]!.active.leaseId = "different-lease";
						return registry;
					},
				},
				createControlClient: () => ({
					call: async () => {
						throw new ControlClientError("connect_failed");
					},
				}),
			});
			expect(await value.state.readTerminal()).toBeNull();
		}));
	it("caps cleanup retry sleeps while retaining the real claimant", async () =>
		temporary(async root => {
			const value = await fixture(root);
			await commitFinal(value.owner, value.manifest.generationId);
			const sleeps: number[] = [];
			let removals = 0;
			await runVisibleSessionMonitor(path.join(value.manifest.privateRoot, "manifest.json"), {
				...value.deps,
				sleep: async milliseconds => {
					sleeps.push(milliseconds);
				},
				rm: async () => {
					removals += 1;
					if (removals < 8) throw Object.assign(new Error("transient"), { code: "EBUSY" });
				},
			});
			expect(sleeps).toEqual([100, 200, 400, 800, 1_600, 3_200, 5_000]);
			expect((await value.state.readMetadata()).cleanup?.status).toBe("acknowledged");
		}));
});
