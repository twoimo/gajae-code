import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { validateVisibleSessionName } from "./paths";
import { VisibleSessionRegistry, type VisibleSessionRegistryConflictError } from "./registry";
import type { CreateVisibleSessionInput } from "./types";

async function withTempDir<T>(fn: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-registry-"));
	try {
		return await fn(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
async function setup(directory: string) {
	const agentDir = join(directory, "agent");
	const repository = join(directory, "repo");
	const worktree = join(directory, "worktree");
	await Promise.all([mkdir(agentDir), mkdir(repository), mkdir(worktree)]);
	return { agentDir, repository, worktree };
}
function input(name: string, repository: string, worktree: string, publicBase?: string): CreateVisibleSessionInput {
	return { name, repository, worktree, backend: "conpty", publicBase };
}
const processIdentity = { pid: 42, startedAt: "2026-01-01T00:00:00.000Z", hostname: "test" };

describe("visible session registry", () => {
	it("prepares allocation before activating its child owner", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const prepared = await registry.create(input("Alpha", context.repository, context.worktree));
			expect(prepared.generation.status).toBe("prepared");
			expect((await readFile(prepared.generation.tokenFilePath)).byteLength).toBe(32);
			expect(prepared.generation.leaseId).toMatch(/^[a-f0-9]{32}$/);
			await expect(registry.create(input("Alpha", context.repository, context.worktree))).rejects.toMatchObject({
				code: "duplicate_name",
			} satisfies Partial<VisibleSessionRegistryConflictError>);
			await expect(
				registry.activateOwner({
					expectedRevision: prepared.revision,
					generationId: "wrong",
					startIdentity: prepared.generation.startIdentity,
					process: processIdentity,
				}),
			).rejects.toThrow("compare-and-swap");
			await expect(
				registry.activateOwner({
					expectedRevision: prepared.revision,
					generationId: prepared.generation.generationId,
					startIdentity: "wrong",
					process: processIdentity,
				}),
			).rejects.toThrow("compare-and-swap");
			const active = await registry.activateOwner({
				expectedRevision: prepared.revision,
				generationId: prepared.generation.generationId,
				startIdentity: prepared.generation.startIdentity,
				process: processIdentity,
			});
			expect(active.generation.status).toBe("active");
			expect(active.generation.process).toEqual(processIdentity);
		});
	});
	it("rolls back only the exact active owner activation", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const prepared = await registry.create(input("Alpha", context.repository, context.worktree));
			const activation = {
				expectedRevision: prepared.revision,
				generationId: prepared.generation.generationId,
				startIdentity: prepared.generation.startIdentity,
				process: processIdentity,
			};
			const active = await registry.activateOwner(activation);
			const rolledBack = await registry.rollbackOwnerActivation({
				...activation,
				expectedRevision: active.revision,
			});
			expect(rolledBack.revision).toBe(active.revision + 1);
			expect(rolledBack.generation).toMatchObject({ status: "prepared" });
			expect(rolledBack.generation.process).toBeUndefined();
			expect((await registry.read()).entries[0]!.active).toEqual(rolledBack.generation);
		});
	});
	it("leaves active state unchanged when owner rollback identity does not match", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const prepared = await registry.create(input("Alpha", context.repository, context.worktree));
			const active = await registry.activateOwner({
				expectedRevision: prepared.revision,
				generationId: prepared.generation.generationId,
				startIdentity: prepared.generation.startIdentity,
				process: processIdentity,
			});
			await expect(
				registry.rollbackOwnerActivation({
					expectedRevision: active.revision,
					generationId: active.generation.generationId,
					startIdentity: active.generation.startIdentity,
					process: { ...processIdentity, hostname: "other-host" },
				}),
			).rejects.toThrow("compare-and-swap");
			expect(await registry.read()).toMatchObject({
				revision: active.revision,
				entries: [{ active: { status: "active", process: processIdentity } }],
			});
		});
	});
	it("rejects owner rollback after a newer registry revision", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const prepared = await registry.create(input("Alpha", context.repository, context.worktree));
			const active = await registry.activateOwner({
				expectedRevision: prepared.revision,
				generationId: prepared.generation.generationId,
				startIdentity: prepared.generation.startIdentity,
				process: processIdentity,
			});
			const recreated = await registry.recreate({
				...input("Alpha", context.repository, context.worktree),
				expectedRevision: active.revision,
				expectedActiveGeneration: active.generation.generationId,
			});
			await expect(
				registry.rollbackOwnerActivation({
					expectedRevision: active.revision,
					generationId: active.generation.generationId,
					startIdentity: active.generation.startIdentity,
					process: processIdentity,
				}),
			).rejects.toThrow("compare-and-swap");
			expect((await registry.read()).entries[0]!.active.generationId).toBe(recreated.generation.generationId);
		});
	});
	it("serializes activation CAS and stale prepared reservations", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const prepared = await registry.create(input("one", context.repository, context.worktree));
			const activation = {
				expectedRevision: prepared.revision,
				generationId: prepared.generation.generationId,
				startIdentity: prepared.generation.startIdentity,
				process: processIdentity,
			};
			const results = await Promise.allSettled([
				registry.activateOwner(activation),
				registry.activateOwner(activation),
			]);
			expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
			await expect(
				registry.recreate({
					...input("one", context.repository, context.worktree),
					expectedRevision: prepared.revision,
					expectedActiveGeneration: prepared.generation.generationId,
				}),
			).rejects.toMatchObject({
				code: "recreate_compare_and_swap",
			} satisfies Partial<VisibleSessionRegistryConflictError>);
		});
	});
	it("fails closed for corrupt and secret-bearing registry records", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			await registry.initialize();
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			await writeFile(
				file,
				'{"schemaVersion":1,"revision":0,"nextGenerationCounter":0,"managedPublicBases":[],"entries":[],"token":"secret"}',
			);
			await expect(registry.read()).rejects.toThrow("schema");
		});
	});
	it("writes only canonical backend IDs", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const backendIds = ["conpty", "tmux", "wsl-tmux"] as const;
			for (const backend of backendIds) {
				await registry.create({
					name: backend,
					repository: context.repository,
					worktree: context.worktree,
					backend,
				});
			}
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			const persisted = JSON.parse(await readFile(file, "utf8")) as {
				entries: Array<{ backend: string }>;
			};
			expect(persisted.entries.map(entry => entry.backend)).toEqual(backendIds);
			await expect(
				registry.create({
					...input("legacy", context.repository, context.worktree),
					backend: "native",
				} as unknown as CreateVisibleSessionInput),
			).rejects.toThrow("supported canonical writer backend");
		});
	});
	it("normalizes legacy backend records to conpty before writing", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const created = await registry.create(input("alpha", context.repository, context.worktree));
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			const persisted = JSON.parse(await readFile(file, "utf8")) as {
				entries: Array<{ backend: string }>;
			};
			persisted.entries[0]!.backend = "native";
			await writeFile(file, JSON.stringify(persisted));
			const legacy = await registry.read();
			expect(legacy.entries[0]!.backend).toBe("conpty");
			await registry.recreate({
				...input("alpha", context.repository, context.worktree),
				expectedRevision: created.revision,
				expectedActiveGeneration: created.generation.generationId,
			});
			const rewritten = JSON.parse(await readFile(file, "utf8")) as {
				entries: Array<{ backend: string }>;
			};
			expect(rewritten.entries[0]!.backend).toBe("conpty");
		});
	});
	it("preserves unknown backend records for reads and rejects every mutation", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const created = await registry.create(input("alpha", context.repository, context.worktree));
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			const persisted = JSON.parse(await readFile(file, "utf8")) as {
				entries: Array<{ backend: string }>;
			};
			persisted.entries[0]!.backend = "future-backend";
			await writeFile(file, JSON.stringify(persisted));
			expect((await registry.read()).entries[0]!.backend).toEqual({
				kind: "unsupported",
				rawId: "future-backend",
			});
			const before = await readFile(file);
			await expect(registry.create(input("beta", context.repository, context.worktree))).rejects.toThrow(
				"unsupported backend record",
			);
			await expect(
				registry.recreate({
					...input("alpha", context.repository, context.worktree),
					expectedRevision: created.revision,
					expectedActiveGeneration: created.generation.generationId,
				}),
			).rejects.toThrow("unsupported backend record");
			await expect(
				registry.activateOwner({
					expectedRevision: created.revision,
					generationId: created.generation.generationId,
					startIdentity: created.generation.startIdentity,
					process: processIdentity,
				}),
			).rejects.toThrow("unsupported backend record");
			await expect(
				registry.rollbackOwnerActivation({
					expectedRevision: created.revision,
					generationId: created.generation.generationId,
					startIdentity: created.generation.startIdentity,
					process: processIdentity,
				}),
			).rejects.toThrow("unsupported backend record");
			expect(await readFile(file)).toEqual(before);
		});
	});
	it("preserves the registry when an unrelated read ENOENT occurs during initialization", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			await registry.initialize();
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			const before = await readFile(file);
			const originalOpen = fs.open;
			const open = vi.spyOn(fs, "open").mockImplementation((async (target, flags, mode) => {
				const handle = await originalOpen(target, flags, mode);
				if (target === file && flags === "r") {
					return new Proxy(handle, {
						get(handleTarget, property) {
							if (property === "stat")
								return async () => {
									const error = new Error(
										"simulated unrelated registry read failure",
									) as NodeJS.ErrnoException;
									error.code = "ENOENT";
									throw error;
								};
							const value = Reflect.get(handleTarget, property, handleTarget);
							return typeof value === "function" ? value.bind(handleTarget) : value;
						},
					});
				}
				return handle;
			}) as typeof fs.open);
			try {
				await expect(registry.initialize()).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				open.mockRestore();
			}
			expect(await readFile(file)).toEqual(before);
		});
	});
	it("reuses an exact managed custom base while rejecting recreate identity changes", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const publicBase = join(directory, "public");
			await mkdir(publicBase);
			const created = await registry.create(input("Alpha", context.repository, context.worktree, publicBase));
			await expect(
				registry.recreate({
					...input("Alpha", context.repository, context.worktree, publicBase),
					expectedRevision: created.revision,
					expectedActiveGeneration: created.generation.generationId,
				}),
			).resolves.toMatchObject({
				entry: { name: { key: process.platform === "win32" ? "alpha" : "Alpha" } },
			});
			const current = await registry.read();
			const otherWorktree = join(directory, "other-worktree");
			await mkdir(otherWorktree);
			await expect(
				registry.recreate({
					...input("Alpha", context.repository, otherWorktree, publicBase),
					expectedRevision: current.revision,
					expectedActiveGeneration: current.entries[0]!.active.generationId,
				}),
			).rejects.toThrow("identity mismatch");
		});
	});
	it("rejects recreate when persisted repository and worktree identities diverge from proposal identity", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const created = await registry.create(input("alpha", context.repository, context.worktree));
			const originalLstat = fs.lstat;
			let repositoryCalls = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
				const stats = await originalLstat(target, options);
				if (typeof target === "string" && target === context.repository) {
					repositoryCalls += 1;
					if (repositoryCalls > 1) {
						return new Proxy(stats, {
							get(targetStats, property) {
								if (property === "ino") return (targetStats.ino as bigint) + 1n;
								const value = Reflect.get(targetStats, property, targetStats);
								return typeof value === "function" ? value.bind(targetStats) : value;
							},
						});
					}
				}
				return stats;
			}) as typeof fs.lstat);
			try {
				await expect(
					registry.recreate({
						...input("alpha", context.repository, context.worktree),
						expectedRevision: created.revision,
						expectedActiveGeneration: created.generation.generationId,
					}),
				).rejects.toThrow("identity mismatch");
				expect(repositoryCalls).toBeGreaterThan(1);
			} finally {
				lstat.mockRestore();
			}
		});
	});
	it("rejects commit when proposal paths change identity after validation", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			await registry.initialize();
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			const before = await readFile(file);
			const originalLstat = fs.lstat;
			let worktreeCalls = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
				const stats = await originalLstat(target, options);
				if (typeof target === "string" && target === context.worktree) {
					worktreeCalls += 1;
					if (worktreeCalls > 2) {
						return new Proxy(stats, {
							get(targetStats, property) {
								if (property === "ino") return (targetStats.ino as bigint) + 1n;
								const value = Reflect.get(targetStats, property, targetStats);
								return typeof value === "function" ? value.bind(targetStats) : value;
							},
						});
					}
				}
				return stats;
			}) as typeof fs.lstat);
			try {
				await expect(registry.create(input("alpha", context.repository, context.worktree))).rejects.toThrow(
					"worktree path changed during commit",
				);
				expect(worktreeCalls).toBeGreaterThan(2);
				expect(await readFile(file)).toEqual(before);
			} finally {
				lstat.mockRestore();
			}
		});
	});
	it("rejects commit when proposal paths are swapped to a reparse point", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			await registry.initialize();
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			const before = await readFile(file);
			const originalLstat = fs.lstat;
			let repositoryCalls = 0;
			const lstat = vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
				const stats = await originalLstat(target, options);
				if (typeof target === "string" && target === context.repository) {
					repositoryCalls += 1;
					if (repositoryCalls > 2) {
						return new Proxy(stats, {
							get(targetStats, property) {
								if (property === "isSymbolicLink") return () => true;
								const value = Reflect.get(targetStats, property, targetStats);
								return typeof value === "function" ? value.bind(targetStats) : value;
							},
						});
					}
				}
				return stats;
			}) as typeof fs.lstat);
			try {
				await expect(registry.create(input("alpha", context.repository, context.worktree))).rejects.toThrow(
					"repository path changed during commit",
				);
				expect(repositoryCalls).toBeGreaterThan(2);
				expect(await readFile(file)).toEqual(before);
			} finally {
				lstat.mockRestore();
			}
		});
	});
	it("accepts canonical-alias proposals that resolve to unchanged identity", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			await registry.create(input("alpha", context.repository, context.worktree));
			const aliasRepository = join(context.repository, "..", "repo");
			const aliasWorktree = join(context.worktree, "..", "worktree");
			const current = await registry.read();
			const recreated = await registry.recreate({
				...input("alpha", aliasRepository, aliasWorktree),
				expectedRevision: current.revision,
				expectedActiveGeneration: current.entries[0]!.active.generationId,
			});
			expect(recreated.entry.repository).toBe(context.repository);
			expect(recreated.entry.worktree).toBe(context.worktree);
			const final = await registry.read();
			expect(final.entries[0]!.repository).toBe(context.repository);
			expect(final.entries[0]!.worktree).toBe(context.worktree);
		});
	});
	it("succeeds when proposal repository and worktree identities stay unchanged", async () => {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const created = await registry.create(input("alpha", context.repository, context.worktree));
			const recreated = await registry.recreate({
				...input("alpha", context.repository, context.worktree),
				expectedRevision: created.revision,
				expectedActiveGeneration: created.generation.generationId,
			});
			expect(recreated.revision).toBe(created.revision + 1);
		});
	});
});
it("rejects corrupt generation roots and identifiers", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		await registry.create(input("Alpha", context.repository, context.worktree));
		const file = join(context.agentDir, "visible-sessions", "registry.json");
		const corrupted = JSON.parse(await readFile(file, "utf8")) as {
			entries: Array<{ active: { tokenFilePath: string; generationId: string } }>;
		};
		corrupted.entries[0]!.active.tokenFilePath = join(directory, "token");
		await writeFile(file, JSON.stringify(corrupted));
		await expect(registry.read()).rejects.toThrow("corrupt");
	});
});
it("surfaces private token cleanup failure after allocation fails", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const publicBase = join(directory, "existing-public-base");
		await mkdir(publicBase);
		const originalWriteFile = fs.writeFile;
		const originalRm = fs.rm;
		const cleanupFailure = new Error("private generation cleanup failed");
		let tokenFilePath: string | undefined;
		const write = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
			await originalWriteFile(file, data, options);
			if (typeof file === "string" && file.endsWith("control-token")) {
				tokenFilePath = file;
				throw new Error("post-token allocation failure");
			}
		});
		const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
			if (typeof target === "string" && tokenFilePath && target === dirname(tokenFilePath)) throw cleanupFailure;
			return originalRm(target, options);
		});
		try {
			let allocationFailure: unknown;
			try {
				await registry.create(input("Alpha", context.repository, context.worktree, publicBase));
			} catch (error) {
				allocationFailure = error;
			}
			expect(allocationFailure).toBeInstanceOf(AggregateError);
			expect((allocationFailure as AggregateError).errors).toContain(cleanupFailure);
			expect(tokenFilePath).toBeDefined();
		} finally {
			write.mockRestore();
			remove.mockRestore();
		}
		expect((await readFile(tokenFilePath!)).byteLength).toBe(32);
		expect((await fs.stat(publicBase)).isDirectory()).toBe(true);
	});
});
it("rejects a custom managed base corrupted to a protected root", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const publicBase = join(directory, "custom-public");
		await mkdir(publicBase);
		await registry.create(input("Alpha", context.repository, context.worktree, publicBase));
		const file = join(context.agentDir, "visible-sessions", "registry.json");
		const corrupted = JSON.parse(await readFile(file, "utf8")) as {
			managedPublicBases: Array<{ path: string }>;
		};
		corrupted.managedPublicBases[1]!.path = context.repository;
		await writeFile(file, JSON.stringify(corrupted));
		await expect(registry.read()).rejects.toThrow("corrupt entries");
	});
});
it("snapshots mutable create, recreate, and activation inputs before awaiting", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const createRequest = input("Alpha", context.repository, context.worktree);
		const creation = registry.create(createRequest);
		createRequest.repository = context.worktree;
		const created = await creation;
		expect(created.entry.repository).toBe(context.repository);
		const recreateRequest = {
			...input("Alpha", context.repository, context.worktree),
			expectedRevision: created.revision,
			expectedActiveGeneration: created.generation.generationId,
		};
		const recreation = registry.recreate(recreateRequest);
		recreateRequest.expectedRevision = 0;
		recreateRequest.expectedActiveGeneration = "changed";
		const recreated = await recreation;
		const activation = {
			expectedRevision: recreated.revision,
			generationId: recreated.generation.generationId,
			startIdentity: recreated.generation.startIdentity,
			process: { ...processIdentity },
		};
		const activated = registry.activateOwner(activation);
		activation.process.hostname = "changed";
		expect((await activated).generation.process).toEqual(processIdentity);
	});
});
it("rejects a mocked reparse point substituted after creating a generation root", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const publicBase = join(directory, "public");
		const name = "Alpha";
		const key = validateVisibleSessionName(name).key;
		const publicNameRoot = join(publicBase, key);
		await mkdir(publicBase);
		const originalLstat = fs.lstat;
		let substitutionObserved = false;
		const lstat = vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
			const stats = await originalLstat(target, options);
			if (typeof target === "string" && target.startsWith(`${publicNameRoot}${sep}`) && target !== publicNameRoot) {
				substitutionObserved = true;
				return new Proxy(stats, {
					get(targetStats, property) {
						if (property === "isSymbolicLink") return () => true;
						const value = Reflect.get(targetStats, property, targetStats);
						return typeof value === "function" ? value.bind(targetStats) : value;
					},
				});
			}
			return stats;
		}) as typeof fs.lstat);
		try {
			await expect(registry.create(input(name, context.repository, context.worktree, publicBase))).rejects.toThrow(
				"Visible session allocation encountered unsafe directory",
			);
		} finally {
			lstat.mockRestore();
		}
		expect(substitutionObserved).toBe(true);
	});
});
it.skip("integration: rejects a real reparse-point substitution after creating a generation root (requires symlink or junction privileges)", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const publicBase = join(directory, "public");
		const name = "Alpha";
		const key = validateVisibleSessionName(name).key;
		const publicNameRoot = join(publicBase, key);
		await mkdir(publicBase);
		const originalMkdir = fs.mkdir;
		const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation((async (target, options) => {
			const made = await originalMkdir(target, options);
			if (typeof target === "string" && target.startsWith(`${publicNameRoot}${sep}`) && target !== publicNameRoot) {
				await fs.rm(target, { recursive: true, force: true });
				await symlink(context.repository, target, process.platform === "win32" ? "junction" : "dir");
			}
			return made;
		}) as typeof fs.mkdir);
		try {
			let failure: unknown;
			try {
				await registry.create(input(name, context.repository, context.worktree, publicBase));
			} catch (error) {
				failure = error;
			}
			const errors = failure instanceof AggregateError ? failure.errors : [failure];
			expect(errors[0]).toMatchObject({
				message: "Visible session allocation encountered unsafe directory",
			});
		} finally {
			mkdirSpy.mockRestore();
		}
	});
});
it("rejects exhausted revisions and generation counters without replacing the registry", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const prepared = await registry.create(input("Alpha", context.repository, context.worktree));
		const file = join(context.agentDir, "visible-sessions", "registry.json");
		const revisionBoundary = JSON.parse(await readFile(file, "utf8")) as {
			revision: number;
			nextGenerationCounter: number;
		};
		revisionBoundary.revision = Number.MAX_SAFE_INTEGER;
		await writeFile(file, JSON.stringify(revisionBoundary));
		const revisionBytes = await readFile(file);
		await expect(
			registry.activateOwner({
				expectedRevision: Number.MAX_SAFE_INTEGER,
				generationId: prepared.generation.generationId,
				startIdentity: prepared.generation.startIdentity,
				process: processIdentity,
			}),
		).rejects.toThrow("revision is exhausted");
		expect(await readFile(file)).toEqual(revisionBytes);
		expect((await registry.read()).revision).toBe(Number.MAX_SAFE_INTEGER);

		revisionBoundary.revision = prepared.revision;
		revisionBoundary.nextGenerationCounter = Number.MAX_SAFE_INTEGER;
		await writeFile(file, JSON.stringify(revisionBoundary));
		const counterBytes = await readFile(file);
		await expect(
			registry.recreate({
				...input("Alpha", context.repository, context.worktree),
				expectedRevision: prepared.revision,
				expectedActiveGeneration: prepared.generation.generationId,
			}),
		).rejects.toThrow("generation counter is exhausted");
		expect(await readFile(file)).toEqual(counterBytes);
		expect((await registry.read()).nextGenerationCounter).toBe(Number.MAX_SAFE_INTEGER);
	});
});
it("rejects oversized serialized owner state without replacing the registry", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const prepared = await registry.create(input("Alpha", context.repository, context.worktree));
		const file = join(context.agentDir, "visible-sessions", "registry.json");
		const before = await readFile(file);
		await expect(
			registry.activateOwner({
				expectedRevision: prepared.revision,
				generationId: prepared.generation.generationId,
				startIdentity: prepared.generation.startIdentity,
				process: { ...processIdentity, hostname: "😀".repeat(2_100_000) },
			}),
		).rejects.toThrow("maximum size");
		expect(await readFile(file)).toEqual(before);
		expect((await registry.read()).revision).toBe(prepared.revision);
	});
});
it("fails closed when the registry file is a symlink or changes a lossless bigint identity while opening", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		await registry.create(input("alpha", context.repository, context.worktree));
		const file = join(context.agentDir, "visible-sessions", "registry.json");
		const originalLstat = fs.lstat;
		const lstat = vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
			const stats = await originalLstat(target, options);
			if (target !== file) return stats;
			return new Proxy(stats, {
				get(targetStats, property) {
					if (property === "isSymbolicLink") return () => true;
					const value = Reflect.get(targetStats, property, targetStats);
					return typeof value === "function" ? value.bind(targetStats) : value;
				},
			});
		}) as typeof fs.lstat);
		try {
			await expect(registry.read()).rejects.toThrow("registry file is invalid");
		} finally {
			lstat.mockRestore();
		}
		const unsafeInode = 9_007_199_254_740_992n;
		const identityLstat = vi.spyOn(fs, "lstat").mockImplementation((async (target, options) => {
			const stats = await originalLstat(target, options);
			if (target !== file) return stats;
			return new Proxy(stats, {
				get(targetStats, property) {
					if (property === "ino") return unsafeInode;
					const value = Reflect.get(targetStats, property, targetStats);
					return typeof value === "function" ? value.bind(targetStats) : value;
				},
			});
		}) as typeof fs.lstat);

		const originalOpen = fs.open;
		const open = vi.spyOn(fs, "open").mockImplementation((async (target, flags, mode) => {
			const handle = await originalOpen(target, flags, mode);
			if (target.toString().toLowerCase() !== file.toLowerCase()) return handle;
			return new Proxy(handle, {
				get(targetHandle, property) {
					if (property === "stat")
						return async () => {
							const stats = await targetHandle.stat({ bigint: true });
							return new Proxy(stats, {
								get(targetStats, statsProperty) {
									if (statsProperty === "ino") return unsafeInode + 1n;
									const value = Reflect.get(targetStats, statsProperty, targetStats);
									return typeof value === "function" ? value.bind(targetStats) : value;
								},
							});
						};
					const value = Reflect.get(targetHandle, property, targetHandle);
					return typeof value === "function" ? value.bind(targetHandle) : value;
				},
			});
		}) as typeof fs.open);
		try {
			await expect(registry.read()).rejects.toThrow("registry file is invalid");
		} finally {
			open.mockRestore();
			identityLstat.mockRestore();
		}
	});
});
it("fails closed when persisted managed or protected paths resolve to substituted identities", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		const publicBase = join(directory, "public");
		await mkdir(publicBase);
		await registry.create(input("alpha", context.repository, context.worktree, publicBase));
		for (const [target, substitute] of [
			[publicBase, context.repository],
			[context.repository, publicBase],
		]) {
			const originalRealpath = fs.realpath;
			const realpath = vi.spyOn(fs, "realpath").mockImplementation((async value => {
				if (value === target) return substitute;
				return originalRealpath(value);
			}) as typeof fs.realpath);
			try {
				await expect(registry.read()).rejects.toThrow("unsafe managed or protected paths");
			} finally {
				realpath.mockRestore();
			}
		}
	});
});
it("enforces exact and over-limit registry collection cardinalities before deep scans", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		await registry.initialize();
		const file = join(context.agentDir, "visible-sessions", "registry.json");
		const decoded = JSON.parse(await readFile(file, "utf8")) as {
			managedPublicBases: Array<{ id: string; path: string; claimedAt: string }>;
			entries: unknown[];
		};
		for (let index = 1; index < 64; index++) {
			const base = join(directory, `public-${index}`);
			await mkdir(base);
			decoded.managedPublicBases.push({
				id: `base-${index}`,
				path: base,
				claimedAt: new Date(0).toISOString(),
			});
		}
		await writeFile(file, JSON.stringify(decoded));
		const bounded = await registry.read();
		expect(bounded.managedPublicBases).toHaveLength(64);

		decoded.managedPublicBases.push({
			id: "over-limit",
			path: join(directory, "over-limit"),
			claimedAt: new Date(0).toISOString(),
		});
		await writeFile(file, JSON.stringify(decoded));
		await expect(registry.read()).rejects.toThrow("collection limits");

		decoded.managedPublicBases = decoded.managedPublicBases.slice(0, 1);
		decoded.entries = Array.from({ length: 1_024 }, () => ({}));
		await writeFile(file, JSON.stringify(decoded));
		await expect(registry.read()).rejects.toThrow("corrupt entries");

		decoded.entries = Array.from({ length: 1_025 }, () => ({}));
		await writeFile(file, JSON.stringify(decoded));
		await expect(registry.read()).rejects.toThrow("collection limits");

		decoded.entries = [{ history: Array.from({ length: 4_095 }, () => ({})) }];
		await writeFile(file, JSON.stringify(decoded));
		await expect(registry.read()).rejects.toThrow("corrupt entries");

		decoded.entries = [{ history: Array.from({ length: 4_096 }, () => ({})) }];
		await writeFile(file, JSON.stringify(decoded));
		await expect(registry.read()).rejects.toThrow("collection limits");
	});
});
it("bounds aggregate path comparison work for a long-path registry adversary", async () => {
	await withTempDir(async directory => {
		const context = await setup(directory);
		const registry = new VisibleSessionRegistry(context);
		await registry.initialize();
		const file = join(context.agentDir, "visible-sessions", "registry.json");
		const decoded = JSON.parse(await readFile(file, "utf8")) as {
			managedPublicBases: Array<{ id: string; path: string; claimedAt: string }>;
			entries: unknown[];
		};
		const claimedAt = new Date(0).toISOString();
		const longSegment = "x".repeat(512);
		for (let index = 1; index < 64; index++) {
			decoded.managedPublicBases.push({
				id: `base-${index}`,
				path: join(directory, `unused-${index}-${longSegment}`),
				claimedAt,
			});
		}
		decoded.entries = Array.from({ length: 1_024 }, (_, index) => {
			const counter = index + 1;
			const name = `entry-${index}`;
			const generationId = `${counter}-${index.toString(16).padStart(24, "0")}`;
			const privateRoot = join(context.agentDir, "visible-sessions", "private", name, generationId);
			return {
				name: { displayName: name, key: name },
				repository: context.repository,
				worktree: context.worktree,
				backend: "conpty",
				active: {
					generationId,
					counter,
					status: "prepared",
					startIdentity: "a".repeat(64),
					leaseId: "b".repeat(32),
					publicBaseId: "default",
					publicRoot: join(context.agentDir, "visible-sessions", "public", name, generationId),
					privateRoot,
					manifestFilePath: join(privateRoot, "manifest.json"),
					createdAt: claimedAt,
					tokenFilePath: join(privateRoot, "control-token"),
					tokenSha256: "c".repeat(64),
				},
				history: [],
			};
		});
		await writeFile(file, JSON.stringify(decoded));
		expect((await readFile(file)).byteLength).toBeLessThan(8 * 1024 * 1024);
		await expect(registry.read()).rejects.toThrow("path comparison work limit");
	});
});
it("preserves bytes, revision, and allocation cleanup through commit-stage failures", async () => {
	for (const stage of ["write", "close", "rename", "cleanup"] as const) {
		await withTempDir(async directory => {
			const context = await setup(directory);
			const registry = new VisibleSessionRegistry(context);
			const prepared = await registry.create(input("alpha", context.repository, context.worktree));
			const file = join(context.agentDir, "visible-sessions", "registry.json");
			const before = await readFile(file);
			const primaryFailure = new Error(`${stage} failure`);
			const cleanupFailure = new Error("temporary cleanup failure");
			const originalOpen = fs.open;
			const originalRename = fs.rename;
			const originalRemove = fs.rm;
			let temporary: string | undefined;
			const open = vi.spyOn(fs, "open").mockImplementation((async (target, flags, mode) => {
				const handle = await originalOpen(target, flags, mode);
				if (typeof target !== "string" || flags !== "wx" || !target.includes(`${sep}.registry-`)) return handle;
				temporary = target;
				return new Proxy(handle, {
					get(targetHandle, property) {
						if (property === "writeFile" && stage === "write")
							return async () => {
								throw primaryFailure;
							};
						if (property === "close" && stage === "close")
							return async () => {
								await targetHandle.close();
								throw primaryFailure;
							};
						const value = Reflect.get(targetHandle, property, targetHandle);
						return typeof value === "function" ? value.bind(targetHandle) : value;
					},
				});
			}) as typeof fs.open);
			const rename = vi.spyOn(fs, "rename").mockImplementation((async (source, destination) => {
				if (
					(source === temporary && destination === file && stage === "rename") ||
					(source === temporary && destination === file && stage === "cleanup")
				)
					throw primaryFailure;
				return originalRename(source, destination);
			}) as typeof fs.rename);
			const remove = vi.spyOn(fs, "rm").mockImplementation((async (target, options) => {
				if (stage === "cleanup" && target === temporary) throw cleanupFailure;
				return originalRemove(target, options);
			}) as typeof fs.rm);
			let failure: unknown;
			try {
				await registry.create(input("beta", context.repository, context.worktree));
			} catch (error) {
				failure = error;
			} finally {
				remove.mockRestore();
				rename.mockRestore();
				open.mockRestore();
			}
			expect(temporary).toBeDefined();
			if (stage === "cleanup") {
				expect(failure).toBeInstanceOf(AggregateError);
				expect((failure as AggregateError).errors).toEqual([primaryFailure, cleanupFailure]);
			} else {
				expect(failure).toBe(primaryFailure);
			}
			expect(await readFile(file)).toEqual(before);
			expect((await registry.read()).revision).toBe(prepared.revision);
			const root = join(context.agentDir, "visible-sessions");
			await expect(fs.lstat(join(root, "public", "beta"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.lstat(join(root, "private", "beta"))).rejects.toMatchObject({ code: "ENOENT" });
		});
	}
});
