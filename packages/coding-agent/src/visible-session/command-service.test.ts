import { expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VisibleSessionCommandError } from "./command-service";
import { VisibleSessionCommandService } from "./command-service";
import { MAX_CONTROL_PROMPT_BYTES, MAX_CONTROL_STREAM_BYTES, parseControlRequest } from "./control-protocol";
import { VisibleSessionPublicStateError } from "./public-state-reader";
import { VisibleSessionRegistry, VisibleSessionRegistryConflictError } from "./registry";
import type { VisibleSessionGeneration } from "./types";

function registry(active: Partial<VisibleSessionGeneration> = {}): VisibleSessionRegistry {
	return {
		read: async () => ({
			schemaVersion: 1,
			revision: 7,
			nextGenerationCounter: 1,
			managedPublicBases: [],
			entries: [
				{
					name: { displayName: "alpha", key: "alpha" },
					repository: "C:\\repo",
					worktree: "C:\\worktree",
					backend: "conpty",
					active: {
						generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
						counter: 1,
						status: "active",
						startIdentity: "a".repeat(64),
						leaseId: "b".repeat(32),
						publicBaseId: "default",
						publicRoot: "C:\\public",
						privateRoot: "C:\\private",
						manifestFilePath: "C:\\private\\manifest.json",
						createdAt: new Date(0).toISOString(),
						process: { pid: 1, startedAt: new Date(0).toISOString(), hostname: "host" },
						tokenFilePath: "C:\\private\\control-token",
						tokenSha256: "c".repeat(64),
						...active,
					},
					history: [],
				},
			],
		}),
	} as unknown as VisibleSessionRegistry;
}
class Input extends EventEmitter {
	isTTY = true;
	pause(): this {
		return this;
	}
	resume(): this {
		return this;
	}
}

class Output extends EventEmitter {
	write(_chunk: Uint8Array): boolean {
		return true;
	}
}

async function withToken(callback: (token: Buffer, privateRoot: string) => Promise<void>): Promise<void> {
	const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "visible-session-attach-"));
	const token = Buffer.alloc(32, 7);
	await Bun.write(path.join(privateRoot, "control-token"), token);
	try {
		await callback(token, privateRoot);
	} finally {
		await fs.rm(privateRoot, { recursive: true, force: true });
	}
}
function privateFinal() {
	return {
		schemaVersion: 1 as const,
		generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
		committedAt: new Date(0).toISOString(),
		ownerExitReason: "done",
		severity: "info" as const,
		runtimeSummary: "done",
		worktreeSummary: "done",
		evidenceSummary: "done",
	};
}

test("terminal status is public and recursively secret-free", async () => {
	const service = new VisibleSessionCommandService({
		registry: registry(),
		createReader: () =>
			({
				read: async () => ({
					metadata: {
						schemaVersion: 1,
						revision: 1,
						generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
						createdAt: new Date(0).toISOString(),
						normalSummary: "done",
					},
					runtime: null,
					promptAccepted: null,
					final: privateFinal(),
					vanished: null,
					pane: { text: "", lines: 0, truncated: false },
				}),
				readPaneTail: async () => ({ text: "", lines: 0, truncated: false }),
			}) as never,
		readPrivateTerminal: async () => privateFinal(),
	});
	const receipt = await service.status("alpha");
	const serialized = JSON.stringify(receipt);
	expect(receipt).toEqual({
		name: "alpha",
		revision: 7,
		generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
		phase: "terminal",
		terminal: "final",
		recreatable: true,
	});
	for (const secret of ["C:\\private", "control-token", "a".repeat(64), "b".repeat(32), "c".repeat(64)])
		expect(serialized).not.toContain(secret);
});
test("attach verifies the active token and wires read-only bounded streaming to its generation", async () => {
	await withToken(async (token, privateRoot) => {
		const generationId = "2-bbbbbbbbbbbbbbbbbbbbbbbb";
		const clientOptions: { endpoint: string; generation: string; token: string }[] = [];
		const readerGenerations: { publicRoot: string; generationId: string }[] = [];
		let attachOptions:
			| {
					readOnly?: boolean;
					replayBytes?: number;
					pollBytes?: number;
					pollIntervalMs?: number;
					columns?: number;
					rows?: number;
			  }
			| undefined;
		const service = new VisibleSessionCommandService({
			registry: registry({
				generationId,
				privateRoot,
				publicRoot: "C:\\public-active",
				manifestFilePath: path.join(privateRoot, "manifest.json"),
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createClient: options => {
				clientOptions.push(options);
				return {} as never;
			},
			createReader: (publicRoot, activeGenerationId) => {
				readerGenerations.push({ publicRoot, generationId: activeGenerationId });
				return {} as never;
			},
			attach: async options => {
				attachOptions = options;
				return {
					reason: "detached",
					bytesReplayed: 3,
					bytesFollowed: 5,
					initialReplayTruncated: false,
					liveTruncationCount: 0,
				};
			},
		});
		await expect(
			service.attach({
				name: "alpha",
				readOnly: true,
				replayBytes: 64,
				pollBytes: 32,
				pollIntervalMs: 25,
				columns: 100,
				rows: 40,
			}),
		).resolves.toEqual({
			reason: "detached",
			bytesReplayed: 3,
			bytesFollowed: 5,
			initialReplayTruncated: false,
			liveTruncationCount: 0,
		});
		expect(clientOptions).toEqual([
			expect.objectContaining({ generation: generationId, token: token.toString("hex") }),
		]);
		expect(readerGenerations).toEqual([{ publicRoot: "C:\\public-active", generationId }]);
		expect(attachOptions).toMatchObject({
			readOnly: true,
			replayBytes: 64,
			pollBytes: 32,
			pollIntervalMs: 25,
			columns: 100,
			rows: 40,
		});
	});
});

test("attach rejects an invalid active token before creating control access", async () => {
	let createClientCalls = 0;
	let attachCalls = 0;
	const service = new VisibleSessionCommandService({
		registry: registry({ tokenFilePath: "C:\\different\\control-token" }),
		createClient: () => {
			createClientCalls += 1;
			return {} as never;
		},
		attach: async () => {
			attachCalls += 1;
			return {
				reason: "detached",
				bytesReplayed: 0,
				bytesFollowed: 0,
				initialReplayTruncated: false,
				liveTruncationCount: 0,
			};
		},
	});
	await expect(service.attach({ name: "alpha" })).rejects.toMatchObject({
		code: "invalid_token",
	} satisfies Partial<VisibleSessionCommandError>);
	expect({ createClientCalls, attachCalls }).toEqual({ createClientCalls: 0, attachCalls: 0 });
});
test("attach detaches without canceling the active generation", async () => {
	await withToken(async (token, privateRoot) => {
		let cancelCalls = 0;
		const input = new Input();
		const attached = Promise.withResolvers<void>();
		const service = new VisibleSessionCommandService({
			registry: registry({
				privateRoot,
				manifestFilePath: path.join(privateRoot, "manifest.json"),
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createClient: () =>
				({
					stream: async () => ({
						startCursor: 0,
						endCursor: 0,
						bytes: Uint8Array.of(),
						truncated: false,
						running: true,
					}),
					write: async () => ({}),
					resize: async () => ({}),
					cancel: () => {
						cancelCalls += 1;
					},
				}) as never,
			createReader: () => ({}) as never,
		});
		const attaching = service.attach({
			name: "alpha",
			dependencies: {
				stdin: input,
				stdout: new Output(),
				terminal: new EventEmitter(),
				createRawTerminalLease: () => {
					attached.resolve();
					return { close() {} };
				},
			},
		});
		await attached.promise;
		input.emit("data", Uint8Array.of(0x1d));
		await expect(attaching).resolves.toMatchObject({ reason: "detached" });
		expect(cancelCalls).toBe(0);
	});
});

test("attach preserves a control disconnect without sending cancel", async () => {
	await withToken(async (token, privateRoot) => {
		let cancelCalls = 0;
		const service = new VisibleSessionCommandService({
			registry: registry({
				privateRoot,
				manifestFilePath: path.join(privateRoot, "manifest.json"),
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createClient: () =>
				({
					stream: async () => Promise.reject(new Error("endpoint lost")),
					write: async () => ({}),
					resize: async () => ({}),
					cancel: () => {
						cancelCalls += 1;
					},
				}) as never,
			createReader: () =>
				({
					read: async () => ({ final: null, vanished: null }),
				}) as never,
		});
		await expect(
			service.attach({
				name: "alpha",
				dependencies: {
					stdin: new Input(),
					stdout: new Output(),
					terminal: new EventEmitter(),
					createRawTerminalLease: () => ({ close() {} }),
				},
			}),
		).resolves.toMatchObject({ reason: "control-disconnected" });
		expect(cancelCalls).toBe(0);
	});
});
test("attach classifies a disconnected terminal generation as session-ended", async () => {
	await withToken(async (token, privateRoot) => {
		const service = new VisibleSessionCommandService({
			registry: registry({
				privateRoot,
				manifestFilePath: path.join(privateRoot, "manifest.json"),
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createClient: () =>
				({
					stream: async () => Promise.reject(new Error("endpoint lost")),
					write: async () => ({}),
					resize: async () => ({}),
				}) as never,
			createReader: () =>
				({
					read: async () => ({ final: {}, vanished: null }),
				}) as never,
		});
		await expect(
			service.attach({
				name: "alpha",
				dependencies: {
					stdin: new Input(),
					stdout: new Output(),
					terminal: new EventEmitter(),
					createRawTerminalLease: () => ({ close() {} }),
				},
			}),
		).resolves.toMatchObject({ reason: "session-ended" });
	});
});
test("status permits legacy schema-1 state only with matching control-generation evidence", async () => {
	await withToken(async (token, privateRoot) => {
		const active = {
			privateRoot,
			tokenFilePath: path.join(privateRoot, "control-token"),
			tokenSha256: createHash("sha256").update(token).digest("hex"),
		};
		const publicState = {
			metadata: {
				schemaVersion: 1,
				revision: 1,
				generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
				createdAt: "now",
				normalSummary: "running",
			},
			runtime: null,
			promptAccepted: null,
			final: null,
			vanished: null,
			pane: { text: "", lines: 0, truncated: false },
		};
		const schemaVersions: Array<1 | 2 | undefined> = [];
		const createLegacyReader = (_publicRoot: string, _generationId: string, expectedSchemaVersion?: 1 | 2) => {
			schemaVersions.push(expectedSchemaVersion);
			return {
				read: async () => {
					if (expectedSchemaVersion !== 1) throw new VisibleSessionPublicStateError("corrupt");
					return publicState;
				},
			} as never;
		};
		const service = new VisibleSessionCommandService({
			registry: registry(active),
			createReader: createLegacyReader,
			createClient: () =>
				({
					call: async () => ({
						ok: true,
						result: {
							generation: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
							ready: true,
							running: true,
							cancelRequested: false,
						},
					}),
				}) as never,
		});
		await expect(service.status("alpha")).resolves.toMatchObject({ phase: "ready" });
		const cancelling = new VisibleSessionCommandService({
			registry: registry(active),
			createReader: createLegacyReader,
			createClient: () =>
				({
					call: async () => ({
						ok: true,
						result: {
							generation: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
							ready: true,
							running: true,
							cancelRequested: true,
						},
					}),
				}) as never,
		});
		await expect(cancelling.status("alpha")).resolves.toMatchObject({ phase: "running" });
		expect(schemaVersions).toEqual([undefined, 1, undefined, 1]);
	});
});
test("status rejects a mismatched owner generation without treating it as stale", async () => {
	await withToken(async (token, privateRoot) => {
		const service = new VisibleSessionCommandService({
			registry: registry({
				privateRoot,
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createReader: () =>
				({
					read: async () => ({
						metadata: {
							schemaVersion: 1,
							revision: 1,
							generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
							createdAt: "now",
							normalSummary: "running",
						},
						runtime: null,
						promptAccepted: null,
						final: null,
						vanished: null,
						pane: { text: "", lines: 0, truncated: false },
					}),
				}) as never,
			createClient: () =>
				({
					call: async () => ({
						ok: true,
						result: { generation: "other", ready: true, running: true, cancelRequested: false },
					}),
				}) as never,
		});
		await expect(service.status("alpha")).rejects.toMatchObject({
			code: "generation_mismatch",
		} satisfies Partial<VisibleSessionCommandError>);
	});
});
test("status binds schema-2 public owner identity to the registry process", async () => {
	await withToken(async (token, privateRoot) => {
		const startedAt = new Date(0).toISOString();
		const active = {
			privateRoot,
			tokenFilePath: path.join(privateRoot, "control-token"),
			tokenSha256: createHash("sha256").update(token).digest("hex"),
			process: { pid: 71, startedAt, hostname: "host" },
		};
		const state = {
			metadata: {
				schemaVersion: 2,
				revision: 1,
				generationId: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
				createdAt: startedAt,
				owner: { pid: 71, startedAt },
				normalSummary: "running",
			},
			runtime: null,
			promptAccepted: null,
			final: null,
			vanished: null,
			pane: { text: "", lines: 0, truncated: false },
		};
		const service = new VisibleSessionCommandService({
			registry: registry(active),
			createReader: () => ({ read: async () => state }) as never,
			createClient: () =>
				({
					call: async () => ({
						ok: true,
						result: {
							generation: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
							ready: true,
							running: true,
							cancelRequested: false,
						},
					}),
				}) as never,
		});
		await expect(service.status("alpha")).resolves.toMatchObject({ phase: "ready" });

		state.metadata.owner.startedAt = "2026-01-01T00:00:00.000Z";
		state.final = {} as never;
		await expect(service.status("alpha")).rejects.toMatchObject({
			code: "liveness_uncertain",
		} satisfies Partial<VisibleSessionCommandError>);
	});
});
test("status fails closed on unsupported public-state schemas before control access", async () => {
	let controlCalls = 0;
	const service = new VisibleSessionCommandService({
		registry: registry(),
		createReader: () =>
			({
				read: async () =>
					({
						metadata: { schemaVersion: 3 },
						runtime: null,
						promptAccepted: null,
						final: null,
						vanished: null,
						pane: { text: "", lines: 0, truncated: false },
					}) as never,
			}) as never,
		readPrivateTerminal: async () => null,
		createClient: () =>
			({
				call: async () => {
					controlCalls += 1;
					return {
						ok: true,
						result: {
							generation: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
							ready: true,
							running: true,
							cancelRequested: false,
						},
					};
				},
			}) as never,
	});
	await expect(service.status("alpha")).rejects.toMatchObject({
		code: "liveness_uncertain",
	} satisfies Partial<VisibleSessionCommandError>);
	expect(controlCalls).toBe(0);
});
test("does not authorize recreation from a forged public terminal without private proof", async () => {
	const service = new VisibleSessionCommandService({
		registry: registry(),
		createReader: () =>
			({
				read: async () => ({
					metadata: { schemaVersion: 1 },
					runtime: null,
					promptAccepted: null,
					final: privateFinal(),
					vanished: null,
					pane: { text: "", lines: 0, truncated: false },
				}),
			}) as never,
		readPrivateTerminal: async () => null,
	});
	await expect(service.status("alpha")).rejects.toMatchObject({
		code: "public_state_corrupt",
	} satisfies Partial<VisibleSessionCommandError>);
});

test("cancel surfaces a transient control failure instead of mislabeling a live generation stale", async () => {
	await withToken(async (token, privateRoot) => {
		const generationId = "3-cccccccccccccccccccccccc";
		const service = new VisibleSessionCommandService({
			registry: registry({
				generationId,
				privateRoot,
				publicRoot: "C:\\public-active",
				manifestFilePath: path.join(privateRoot, "manifest.json"),
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createReader: () =>
				({
					read: async () => ({
						metadata: {
							schemaVersion: 1,
							revision: 1,
							generationId,
							createdAt: new Date(0).toISOString(),
							normalSummary: "running",
						},
						runtime: null,
						promptAccepted: null,
						final: null,
						vanished: null,
						pane: { text: "", lines: 0, truncated: false },
					}),
				}) as never,
			createClient: () =>
				({
					call: async (request: { action: string }) => {
						if (request.action === "status") {
							return {
								ok: true,
								result: {
									ready: true,
									running: true,
									generation: generationId,
									cancelRequested: false,
								},
							};
						}
						throw new Error("transient named-pipe failure");
					},
				}) as never,
		});

		await expect(service.cancel("alpha")).rejects.toMatchObject({
			code: "control_unavailable",
		} satisfies Partial<VisibleSessionCommandError>);
	});
});
test("monitor bounds stale probes by attempts", async () => {
	let reads = 0;
	let sleeps = 0;
	const service = new VisibleSessionCommandService({
		registry: registry({ status: "prepared" }),
		createReader: () =>
			({
				read: async () => {
					reads += 1;
					throw new VisibleSessionPublicStateError("partial_initialization");
				},
			}) as never,
		sleep: async () => {
			sleeps += 1;
		},
	});

	await expect(service.monitor("alpha", { attempts: 2, intervalMs: 1 })).resolves.toMatchObject({
		phase: "stale",
	});
	expect({ reads, sleeps }).toEqual({ reads: 2, sleeps: 1 });
});

test("monitor stops an in-flight wait when its caller aborts", async () => {
	const waiting = Promise.withResolvers<void>();
	const waitStarted = Promise.withResolvers<void>();
	const controller = new AbortController();
	const service = new VisibleSessionCommandService({
		registry: registry({ status: "prepared" }),
		createReader: () =>
			({
				read: async () => {
					throw new VisibleSessionPublicStateError("partial_initialization");
				},
			}) as never,
		sleep: async () => {
			waitStarted.resolve();
			await waiting.promise;
		},
	});

	const monitoring = service.monitor("alpha", { attempts: 2, intervalMs: 1, signal: controller.signal });
	await waitStarted.promise;
	controller.abort();
	await expect(monitoring).resolves.toMatchObject({ phase: "stale" });
});

test("concurrent monitors retain independent budgets and abort policies", async () => {
	const waiting = Promise.withResolvers<void>();
	let reads = 0;
	const longController = new AbortController();
	const service = new VisibleSessionCommandService({
		registry: registry({ status: "prepared" }),
		createReader: () =>
			({
				read: async () => {
					reads += 1;
					throw new VisibleSessionPublicStateError("partial_initialization");
				},
			}) as never,
		sleep: async () => waiting.promise,
	});

	const long = service.monitor("alpha", { attempts: 2, intervalMs: 1, signal: longController.signal });
	const short = service.monitor("alpha", { attempts: 1, intervalMs: 1 });
	await expect(short).resolves.toMatchObject({ phase: "stale" });
	longController.abort();
	await expect(long).resolves.toMatchObject({ phase: "stale" });
	expect(reads).toBe(2);
});
test("monitor retries while private terminal proof waits for public publication", async () => {
	let reads = 0;
	const service = new VisibleSessionCommandService({
		registry: registry(),
		createReader: () =>
			({
				read: async () => {
					reads += 1;
					if (reads === 1) throw new VisibleSessionPublicStateError("partial_initialization");
					return {
						metadata: { schemaVersion: 1 },
						runtime: null,
						promptAccepted: null,
						final: privateFinal(),
						vanished: null,
						pane: { text: "", lines: 0, truncated: false },
					};
				},
			}) as never,
		readPrivateTerminal: async () => privateFinal(),
		sleep: async () => {},
	});
	await expect(service.monitor("alpha", { attempts: 2, intervalMs: 1 })).resolves.toMatchObject({
		phase: "terminal",
		terminal: "final",
	});
	expect(reads).toBe(2);
});

test("cancel fences a recreated successor after checking live status", async () => {
	await withToken(async (token, privateRoot) => {
		const generationId = "4-dddddddddddddddddddddddd";
		const successorGenerationId = "5-eeeeeeeeeeeeeeeeeeeeeeee";
		const initial = await registry({
			generationId,
			privateRoot,
			tokenFilePath: path.join(privateRoot, "control-token"),
			tokenSha256: createHash("sha256").update(token).digest("hex"),
		}).read();
		const successor = structuredClone(initial);
		successor.revision += 1;
		successor.entries[0]!.active = {
			...successor.entries[0]!.active,
			generationId: successorGenerationId,
		};
		let reads = 0;
		const actions: string[] = [];
		const service = new VisibleSessionCommandService({
			registry: {
				read: async () => {
					reads += 1;
					return reads === 1 ? initial : successor;
				},
			} as VisibleSessionRegistry,
			createReader: () =>
				({
					read: async () => ({
						metadata: {
							schemaVersion: 1,
							revision: 1,
							generationId,
							createdAt: new Date(0).toISOString(),
							normalSummary: "running",
						},
						runtime: null,
						promptAccepted: null,
						final: null,
						vanished: null,
						pane: { text: "", lines: 0, truncated: false },
					}),
				}) as never,
			createClient: () =>
				({
					call: async (request: { action: string }) => {
						actions.push(request.action);
						return {
							ok: true,
							result: { generation: generationId, ready: true, running: true, cancelRequested: false },
						};
					},
				}) as never,
		});

		await expect(service.cancel("alpha")).rejects.toMatchObject({
			code: "generation_mismatch",
		} satisfies Partial<VisibleSessionCommandError>);
		expect(actions).toEqual(["status"]);
	});
});
test("cancel ignores unrelated registry revision churn when the target owner is unchanged", async () => {
	await withToken(async (token, privateRoot) => {
		const generationId = "6-ffffffffffffffffffffffff";
		const initial = await registry({
			generationId,
			privateRoot,
			tokenFilePath: path.join(privateRoot, "control-token"),
			tokenSha256: createHash("sha256").update(token).digest("hex"),
		}).read();
		const churned = structuredClone(initial);
		churned.revision += 1;
		churned.entries.push({
			...structuredClone(churned.entries[0]!),
			name: { displayName: "beta", key: "beta" },
			active: {
				...structuredClone(churned.entries[0]!.active),
				generationId: "7-111111111111111111111111",
				startIdentity: "d".repeat(64),
				leaseId: "e".repeat(32),
			},
		});
		let reads = 0;
		const actions: string[] = [];
		const service = new VisibleSessionCommandService({
			registry: {
				read: async () => {
					reads += 1;
					return reads === 1 ? initial : churned;
				},
			} as VisibleSessionRegistry,
			createReader: () =>
				({
					read: async () => ({
						metadata: {
							schemaVersion: 2,
							owner: { pid: 1, startedAt: new Date(0).toISOString() },
						},
						runtime: null,
						promptAccepted: null,
						final: null,
						vanished: null,
						pane: { text: "", lines: 0, truncated: false },
					}),
				}) as never,
			readPrivateTerminal: async () => null,
			createClient: () =>
				({
					call: async (request: { action: string }) => {
						actions.push(request.action);
						return {
							ok: true,
							result:
								request.action === "status"
									? { generation: generationId, ready: true, running: true, cancelRequested: false }
									: {},
						};
					},
				}) as never,
		});

		await expect(service.cancel("alpha")).resolves.toEqual({ cancelled: true, phase: "live" });
		expect(actions).toEqual(["status", "cancel"]);
		expect(reads).toBe(2);
	});
});
test("create isolates launch input and maps typed conflicts without exposing startup diagnostics", async () => {
	let received: unknown;
	const request = {
		name: "alpha",
		repository: "C:\\repo",
		worktree: "C:\\worktree",
		backend: "conpty" as const,
		executable: {} as never,
		env: { SECRET: "must-not-forward" },
	};
	const conflict = new VisibleSessionCommandService({
		registry: registry(),
		launch: async launchRequest => {
			received = launchRequest.input;
			throw new VisibleSessionRegistryConflictError("duplicate_name");
		},
	});
	await expect(conflict.create(request)).rejects.toMatchObject({
		code: "conflict",
	} satisfies Partial<VisibleSessionCommandError>);
	expect(received).toEqual({
		name: "alpha",
		repository: "C:\\repo",
		worktree: "C:\\worktree",
		backend: "conpty",
		publicBase: undefined,
	});

	const startup = new VisibleSessionCommandService({
		registry: registry(),
		launch: async () => {
			throw new Error("SECRET=must-not-forward");
		},
	});
	await expect(startup.create(request)).rejects.toMatchObject({
		code: "startup_failed",
	} satisfies Partial<VisibleSessionCommandError>);
});

test("registry read failures are not reported as missing sessions", async () => {
	const service = new VisibleSessionCommandService({
		registry: { read: async () => Promise.reject(new Error("corrupt registry")) } as VisibleSessionRegistry,
	});
	await expect(service.status("alpha")).rejects.toMatchObject({
		code: "registry_unavailable",
	} satisfies Partial<VisibleSessionCommandError>);
});

test("tail rejects invalid public-state limits before reading", async () => {
	const service = new VisibleSessionCommandService({ registry: registry() });
	await expect(service.tail("alpha", { bytes: 0, lines: 1 })).rejects.toMatchObject({
		code: "invalid_input",
	} satisfies Partial<VisibleSessionCommandError>);
});
test("maps a non-ok control generation mismatch without weakening its typed evidence", async () => {
	await withToken(async (token, privateRoot) => {
		const service = new VisibleSessionCommandService({
			registry: registry({
				privateRoot,
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: createHash("sha256").update(token).digest("hex"),
			}),
			createReader: () =>
				({
					read: async () => {
						throw new VisibleSessionPublicStateError("partial_initialization");
					},
				}) as never,
			createClient: () => ({ call: async () => ({ ok: false, error: "generation_mismatch" }) }) as never,
		});
		await expect(service.status("alpha")).rejects.toMatchObject({
			code: "generation_mismatch",
		} satisfies Partial<VisibleSessionCommandError>);
	});
});
test("tail preserves public-state generation, corruption, transient, and unavailable evidence", async () => {
	const cases: Array<[VisibleSessionPublicStateError | Error, VisibleSessionCommandError["code"]]> = [
		[new VisibleSessionPublicStateError("generation_mismatch"), "generation_mismatch"],
		[new VisibleSessionPublicStateError("corrupt"), "public_state_corrupt"],
		[new VisibleSessionPublicStateError("unstable"), "public_state_transient"],
		[new Error("I/O failure"), "public_state_unavailable"],
	];
	for (const [failure, code] of cases) {
		const service = new VisibleSessionCommandService({
			registry: registry(),
			createReader: () =>
				({
					readPaneTail: async () => {
						throw failure;
					},
				}) as never,
		});
		await expect(service.tail("alpha")).rejects.toMatchObject({
			code,
		} satisfies Partial<VisibleSessionCommandError>);
	}
});
test("recreate fails closed for a non-conpty backend", async () => {
	const value = await registry().read();
	value.entries[0]!.backend = "tmux";
	let readers = 0;
	let launches = 0;
	const service = new VisibleSessionCommandService({
		registry: { read: async () => value } as VisibleSessionRegistry,
		createReader: () => {
			readers += 1;
			return {} as never;
		},
		launch: async () => {
			launches += 1;
			return {} as never;
		},
	});
	await expect(
		service.recreate({
			name: "alpha",
			expectedRevision: value.revision,
			expectedActiveGeneration: value.entries[0]!.active.generationId,
			executable: {} as never,
		}),
	).rejects.toMatchObject({
		code: "not_recreatable",
	} satisfies Partial<VisibleSessionCommandError>);
	expect({ readers, launches }).toEqual({ readers: 0, launches: 0 });
});
test("recreate fences a successor and maps registry conflicts", async () => {
	const terminalReader = () =>
		({
			read: async () => ({
				metadata: { schemaVersion: 1 },
				final: privateFinal(),
				vanished: null,
			}),
		}) as never;
	const request = {
		name: "alpha",
		expectedRevision: 7,
		expectedActiveGeneration: "1-aaaaaaaaaaaaaaaaaaaaaaaa",
		executable: {} as never,
	};
	const initial = await registry().read();
	const successor = structuredClone(initial);
	successor.revision += 1;
	successor.entries[0]!.active = {
		...successor.entries[0]!.active,
		generationId: "2-bbbbbbbbbbbbbbbbbbbbbbbb",
	};
	let reads = 0;
	const successorService = new VisibleSessionCommandService({
		registry: {
			read: async () => {
				reads += 1;
				return reads === 1 ? initial : successor;
			},
		} as VisibleSessionRegistry,
		createReader: terminalReader,
		readPrivateTerminal: async () => privateFinal(),
		launch: async () => {
			throw new Error("launch must not run for a successor");
		},
	});
	await expect(successorService.recreate(request)).rejects.toMatchObject({
		code: "generation_mismatch",
	} satisfies Partial<VisibleSessionCommandError>);

	const conflict = new VisibleSessionCommandService({
		registry: registry(),
		createReader: terminalReader,
		readPrivateTerminal: async () => privateFinal(),
		launch: async () => {
			throw new VisibleSessionRegistryConflictError("recreate_compare_and_swap");
		},
	});
	await expect(conflict.recreate(request)).rejects.toMatchObject({
		code: "conflict",
	} satisfies Partial<VisibleSessionCommandError>);
});
test("recreate refreshes its registry CAS revision after unrelated session churn", async () => {
	const initial = await registry().read();
	const churned = structuredClone(initial);
	churned.revision += 1;
	churned.entries.push({
		...structuredClone(churned.entries[0]!),
		name: { displayName: "beta", key: "beta" },
		active: {
			...structuredClone(churned.entries[0]!.active),
			generationId: "2-bbbbbbbbbbbbbbbbbbbbbbbb",
			startIdentity: "d".repeat(64),
			leaseId: "e".repeat(32),
		},
	});
	let reads = 0;
	let received: unknown;
	const service = new VisibleSessionCommandService({
		registry: {
			read: async () => {
				reads += 1;
				return reads === 1 ? initial : churned;
			},
		} as VisibleSessionRegistry,
		createReader: () =>
			({
				read: async () => ({
					metadata: { schemaVersion: 1 },
					final: privateFinal(),
					vanished: null,
				}),
			}) as never,
		readPrivateTerminal: async () => privateFinal(),
		launch: async launchRequest => {
			received = launchRequest;
			return {} as never;
		},
	});

	await service.recreate({
		name: "alpha",
		expectedRevision: initial.revision,
		expectedActiveGeneration: initial.entries[0]!.active.generationId,
		executable: {} as never,
	});
	expect(received).toMatchObject({
		recreate: true,
		input: {
			expectedRevision: churned.revision,
			expectedActiveGeneration: initial.entries[0]!.active.generationId,
		},
	});
	expect(reads).toBe(2);
});
test("prompt rejects NUL and malformed UTF-8 input before control access", async () => {
	let calls = 0;
	const service = new VisibleSessionCommandService({
		registry: registry(),
		createClient: () => {
			calls += 1;
			return {} as never;
		},
	});
	await expect(service.prompt("alpha", { kind: "literal", text: "\0" })).rejects.toMatchObject({
		code: "invalid_prompt",
	} satisfies Partial<VisibleSessionCommandError>);
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "visible-session-invalid-prompt-"));
	const invalid = path.join(directory, "invalid.txt");
	try {
		await Bun.write(invalid, Uint8Array.of(0xff));
		await expect(service.prompt("alpha", { kind: "file", path: invalid })).rejects.toMatchObject({
			code: "invalid_prompt",
		} satisfies Partial<VisibleSessionCommandError>);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
	expect(calls).toBe(0);
});
test("shares bounded canonical prompt forms across protocol and command service", async () => {
	const token = "a".repeat(64);
	for (const text of ["\n".repeat(MAX_CONTROL_PROMPT_BYTES + 1), "\0", "\ud800"]) {
		expect(() =>
			parseControlRequest({
				version: 1,
				id: "request",
				action: "prompt",
				generation: "generation",
				token,
				data: { text },
			}),
		).toThrow();
	}
	expect(
		parseControlRequest({
			version: 1,
			id: "request",
			action: "prompt",
			generation: "generation",
			token,
			data: { text: "\r" },
		}),
	).toMatchObject({ data: { text: "\r" } });
	const accepted = "\n".repeat(Math.floor(MAX_CONTROL_PROMPT_BYTES / 3));
	expect(
		parseControlRequest({
			version: 1,
			id: "request",
			action: "prompt",
			generation: "generation",
			token,
			data: { text: accepted },
		}),
	).toMatchObject({ data: { text: accepted } });
});
test("prompt file reads reject short, appended, replaced, and symlinked files", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "visible-session-prompt-"));
	const file = path.join(directory, "prompt.txt");
	const replacement = path.join(directory, "replacement.txt");
	await Bun.write(file, "prompt");
	await Bun.write(replacement, "replacement");
	const service = new VisibleSessionCommandService({
		registry: registry(),
		createClient: () => ({ call: async () => ({ ok: true, result: {} }) }) as never,
	});
	const originalOpen = fs.open;
	let shortReadCalls = 0;
	const shortOpen = vi.spyOn(fs, "open").mockImplementation((async (target, flags) => {
		const handle = await originalOpen(target, flags);
		if (target !== file) return handle;
		handle.read = (async () => {
			shortReadCalls += 1;
			return { bytesRead: 0, buffer: Buffer.alloc(0) };
		}) as typeof handle.read;
		return handle;
	}) as typeof fs.open);
	try {
		await expect(service.prompt("alpha", { kind: "file", path: file })).rejects.toMatchObject({
			code: "invalid_prompt",
		} satisfies Partial<VisibleSessionCommandError>);
	} finally {
		shortOpen.mockRestore();
	}
	expect(shortReadCalls).toBe(1);
	const appendOpen = vi.spyOn(fs, "open").mockImplementation((async (target, flags) => {
		const handle = await originalOpen(target, flags);
		if (target !== file) return handle;
		const read = handle.read.bind(handle) as (
			buffer: Uint8Array,
			offset?: number,
			length?: number,
			position?: number | null,
		) => Promise<{ bytesRead: number; buffer: Uint8Array }>;
		let appended = false;
		handle.read = (async (
			buffer: Uint8Array,
			offset: number = 0,
			length: number = buffer.byteLength,
			position: number | null = null,
		) => {
			const result = await read(buffer, offset, length, position);
			if (!appended) {
				appended = true;
				await fs.appendFile(file, "!");
			}
			return result;
		}) as typeof handle.read;
		return handle;
	}) as typeof fs.open);
	try {
		await expect(service.prompt("alpha", { kind: "file", path: file })).rejects.toMatchObject({
			code: "invalid_prompt",
		} satisfies Partial<VisibleSessionCommandError>);
	} finally {
		appendOpen.mockRestore();
	}
	await Bun.write(file, "prompt");
	const replaceOpen = vi.spyOn(fs, "open").mockImplementation((async (target, flags) => {
		const handle = await originalOpen(target, flags);
		if (target === file) await fs.rename(replacement, file);
		return handle;
	}) as typeof fs.open);
	try {
		await expect(service.prompt("alpha", { kind: "file", path: file })).rejects.toMatchObject({
			code: "invalid_prompt",
		} satisfies Partial<VisibleSessionCommandError>);
	} finally {
		replaceOpen.mockRestore();
	}
	if (process.platform !== "win32") {
		const linked = path.join(directory, "linked.txt");
		await fs.symlink(file, linked);
		await expect(service.prompt("alpha", { kind: "file", path: linked })).rejects.toMatchObject({
			code: "invalid_prompt",
		} satisfies Partial<VisibleSessionCommandError>);
	}
	await fs.rm(directory, { recursive: true, force: true });
});
test("attach rejects a token digest mismatch before creating control access", async () => {
	await withToken(async (_token, privateRoot) => {
		let createClientCalls = 0;
		const service = new VisibleSessionCommandService({
			registry: registry({
				privateRoot,
				tokenFilePath: path.join(privateRoot, "control-token"),
				tokenSha256: "0".repeat(64),
			}),
			createClient: () => {
				createClientCalls += 1;
				return {} as never;
			},
		});
		await expect(service.attach({ name: "alpha" })).rejects.toMatchObject({
			code: "invalid_token",
		} satisfies Partial<VisibleSessionCommandError>);
		expect(createClientCalls).toBe(0);
	});
});
test("attach validates public bounds before private token or client access", async () => {
	let reads = 0;
	let clients = 0;
	const service = new VisibleSessionCommandService({
		registry: {
			read: async () => {
				reads += 1;
				throw new Error("registry must not be read");
			},
		} as unknown as VisibleSessionRegistry,
		createClient: () => {
			clients += 1;
			return {} as never;
		},
	});
	for (const request of [
		{ replayBytes: 0 },
		{ pollBytes: MAX_CONTROL_STREAM_BYTES + 1 },
		{ pollIntervalMs: 0 },
		{ columns: 0 },
		{ rows: 10_001 },
	]) {
		await expect(service.attach({ name: "alpha", ...request })).rejects.toMatchObject({
			code: "invalid_input",
		} satisfies Partial<VisibleSessionCommandError>);
	}
	expect({ reads, clients }).toEqual({ reads: 0, clients: 0 });
});
test("registry rejects malformed UTF-8 without replacement-character normalization", async () => {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "visible-session-registry-"));
	const concrete = new VisibleSessionRegistry({ agentDir });
	try {
		await concrete.initialize();
		await Bun.write(path.join(agentDir, "visible-sessions", "registry.json"), Uint8Array.of(0xff));
		await expect(concrete.read()).rejects.toThrow("invalid JSON");
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
