import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MAX_VISIBLE_SESSION_PANE_TAIL_BYTES, VisibleSessionPublicStateReader } from "./public-state-reader";
import {
	type ProjectionFiles,
	VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
	VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
	type VisibleSessionRoleIdentity,
	VisibleSessionStateOwner,
	visibleSessionStatePaths,
} from "./state";

const generationId = "public-generation";
const secret = "private-cleanup-receipt-token";
const writerIdentity: VisibleSessionRoleIdentity = {
	generationId,
	leaseId: "reader-private-lease-token",
	owner: { pid: 41, startIdentity: "reader-private-start-identity" },
	redactions: ["reader-secret"],
};

function metadata(revision = 1) {
	return {
		schemaVersion: VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
		revision,
		generationId,
		authority: "private-authority",
		createdAt: "2026-01-01T00:00:00.000Z",
		normalSummary: "running",
		cleanup: {
			receipt: { kind: "cleanup-private-token", generationId, leaseId: secret },
			status: "pending",
			claimant: null,
		},
	};
}

async function withPublicState(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "gjc-public-reader-"));
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeJson(file: string, value: object): Promise<void> {
	await writeFile(file, JSON.stringify(value));
}

async function writeMetadata(root: string, revision = 1): Promise<void> {
	await writeJson(visibleSessionStatePaths(root).metadata, metadata(revision));
}
function projectedState(publicRoot: string, privateRoot: string) {
	return {
		publicRoot,
		privateRoot,
		session: "reader-session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
}

async function writerRevision(owner: VisibleSessionStateOwner): Promise<{ expectedRevision: number }> {
	return { expectedRevision: (await owner.readMetadata()).revision };
}

async function withSchema1Writer(fn: (owner: VisibleSessionStateOwner) => Promise<void>): Promise<void> {
	await withPublicState(async root => {
		const owner = new VisibleSessionStateOwner(root, writerIdentity);
		await owner.initialize();
		await fn(owner);
	});
}
async function writeMinimalProjectedSnapshot(root: string, backend: string): Promise<void> {
	const paths = visibleSessionStatePaths(root);
	const owner = { pid: 7, startedAt: "now" };
	await writeJson(paths.metadata, {
		schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
		session: "alpha",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "now",
		gjcBin: "gjc",
		stateDir: root,
		paneLog: paths.pane,
		eventsLog: paths.events,
		finalStatus: paths.final,
		runtimeState: paths.runtimeState,
		vanishedStatus: paths.vanished,
		promptAcceptedStatus: paths.promptAccepted,
		worktreeBaselineDirty: false,
		backend,
		generation: generationId,
		generationId,
		owner,
	});
	await writeJson(paths.runtimeState, {
		schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
		backend,
		generation: generationId,
		generationId,
		owner,
		summary: "working",
		status: "running",
		updatedAt: "now",
		present: true,
		valid: true,
		state: "running",
		source: null,
		event: null,
		reason: null,
		terminal: false,
		terminalState: null,
		terminalSource: null,
		finalResponsePresent: false,
		previousRuntimeState: null,
		sessionMatches: true,
		cwdMatches: true,
	});
	const files: ProjectionFiles = {
		metadata: createHash("sha256")
			.update(await readFile(paths.metadata))
			.digest("hex"),
		runtime: createHash("sha256")
			.update(await readFile(paths.runtimeState))
			.digest("hex"),
		prompt: null,
		pane: null,
		events: null,
		final: null,
		vanished: null,
	};
	await writeJson(paths.publication, {
		schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
		epoch: 1,
		generationId,
		owner,
		files,
	});
}
describe("VisibleSessionPublicStateReader", () => {
	it("projects every public recovery file while excluding authority and cleanup receipts", async () => {
		await withPublicState(async root => {
			const paths = visibleSessionStatePaths(root);
			await writeMetadata(root);
			await writeJson(paths.runtimeState, { summary: "working", status: "running", updatedAt: "now" });
			await writeJson(paths.promptAccepted, { acceptedAt: "now", summary: "accepted" });
			await writeJson(paths.final, {
				schemaVersion: 1,
				generationId,
				committedAt: "now",
				ownerExitReason: "done",
				severity: "info",
				runtimeSummary: "finished",
				worktreeSummary: "clean",
				evidenceSummary: "tested",
			});
			await writeFile(paths.pane, "\u001b[31mred\u001b[0m\nnext\n");

			const state = await new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 100, lines: 10 });
			expect(state.runtime?.status).toBe("running");
			expect(state.promptAccepted?.summary).toBe("accepted");
			expect(state.final?.severity).toBe("info");
			expect(state.vanished).toBeNull();
			expect(state.pane).toEqual({ text: "\u001b[31mred\u001b[0m\nnext\n", lines: 2, truncated: false });
			expect(JSON.stringify(state)).not.toContain("private-authority");
			expect(JSON.stringify(state)).not.toContain(secret);
		});
	});

	it("accepts missing optional recovery files and an empty or missing pane", async () => {
		await withPublicState(async root => {
			await writeMetadata(root);
			const reader = new VisibleSessionPublicStateReader(root, generationId);
			expect((await reader.read({ bytes: 1, lines: 1 })).pane).toEqual({ text: "", lines: 0, truncated: false });
			await writeFile(visibleSessionStatePaths(root).pane, "");
			expect((await reader.read({ bytes: 1, lines: 1 })).pane).toEqual({ text: "", lines: 0, truncated: false });
			expect((await reader.read({ bytes: 1, lines: 1 })).runtime).toBeNull();
		});
	});
	it("does not return a schema-1 snapshot while a mutation journal is pending", async () => {
		await withPublicState(async root => {
			const paths = visibleSessionStatePaths(root);
			await writeMetadata(root);
			await writeFile(paths.pane, "rejected target bytes");
			await writeFile(paths.mutationJournal, "{}");
			await expect(
				new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 64, lines: 10 }),
			).rejects.toMatchObject({ code: "unstable" });
		});
	});
	it("maps invalid pane UTF-8 to the typed corrupt public-state error", async () => {
		await withPublicState(async root => {
			await writeMetadata(root);
			await writeFile(visibleSessionStatePaths(root).pane, Buffer.from([0xc3, 0x28]));
			await expect(
				new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 8, lines: 1 }),
			).rejects.toMatchObject({
				code: "corrupt",
			});
		});
	});

	it("fails closed for corrupt or unknown metadata, runtime, prompt, and terminal schemas", async () => {
		await withPublicState(async root => {
			const paths = visibleSessionStatePaths(root);
			const reader = new VisibleSessionPublicStateReader(root, generationId);
			await writeFile(paths.metadata, "{not-json");
			await expect(reader.read({ bytes: 1, lines: 1 })).rejects.toMatchObject({ code: "corrupt" });
			await writeMetadata(root);
			await writeJson(paths.runtimeState, { summary: "x", status: "x", updatedAt: "x", extra: true });
			await expect(reader.read({ bytes: 1, lines: 1 })).rejects.toMatchObject({ code: "corrupt" });
			await writeFile(paths.runtimeState, JSON.stringify({ summary: "x", status: "x", updatedAt: "x" }));
			await writeJson(paths.promptAccepted, { acceptedAt: "x", summary: "x", extra: true });
			await expect(reader.read({ bytes: 1, lines: 1 })).rejects.toMatchObject({ code: "corrupt" });
			await writeFile(paths.promptAccepted, JSON.stringify({ acceptedAt: "x", summary: "x" }));
			await writeJson(paths.final, {
				schemaVersion: 2,
				generationId,
				committedAt: "x",
				ownerExitReason: "x",
				severity: "info",
				runtimeSummary: "x",
				worktreeSummary: "x",
				evidenceSummary: "x",
			});
			await expect(reader.read({ bytes: 1, lines: 1 })).rejects.toMatchObject({ code: "corrupt" });
		});
	});

	it("requires matching generations and mutually exclusive terminal records", async () => {
		await withPublicState(async root => {
			await writeMetadata(root);
			await expect(
				new VisibleSessionPublicStateReader(root, "other").read({ bytes: 1, lines: 1 }),
			).rejects.toMatchObject({
				code: "generation_mismatch",
			});
			const paths = visibleSessionStatePaths(root);
			const record = { schemaVersion: 1, generationId, committedAt: "x", reason: "gone", evidenceSummary: "none" };
			await writeJson(paths.vanished, record);
			await writeJson(paths.final, {
				schemaVersion: 1,
				generationId,
				committedAt: "x",
				ownerExitReason: "x",
				severity: "info",
				runtimeSummary: "x",
				worktreeSummary: "x",
				evidenceSummary: "x",
			});
			await expect(
				new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 1, lines: 1 }),
			).rejects.toMatchObject({ code: "corrupt" });
		});
	});

	it("preserves ANSI, honors UTF-8 boundaries, and reports byte and line truncation", async () => {
		await withPublicState(async root => {
			const paths = visibleSessionStatePaths(root);
			await writeMetadata(root);
			await writeFile(paths.pane, "first\n\u001b[32m😀漢字\u001b[0m\nlast\n");
			const reader = new VisibleSessionPublicStateReader(root, generationId);
			const lines = await reader.readPaneTail({ bytes: 100, lines: 2 });
			expect(lines.text).toBe("\u001b[32m😀漢字\u001b[0m\nlast\n");
			expect(lines.truncated).toBe(true);
			const utf8 = await reader.readPaneTail({ bytes: 11, lines: 10 });
			expect(utf8.text).not.toContain("�");
			expect(utf8.truncated).toBe(true);
			await expect(
				reader.readPaneTail({ bytes: MAX_VISIBLE_SESSION_PANE_TAIL_BYTES + 1, lines: 1 }),
			).rejects.toThrow("limits");
		});
	});
});
it("round-trips schema-1 writer output without exposing writer authority", async () => {
	await withSchema1Writer(async owner => {
		await owner.updateNormal(await writerRevision(owner), "running");
		await owner.updateRuntime(await writerRevision(owner), {
			summary: "working",
			status: "running",
			updatedAt: "now",
		});
		await owner.recordPromptAccepted(await writerRevision(owner), { acceptedAt: "now", summary: "accepted" });

		const state = await new VisibleSessionPublicStateReader(owner.paths.root, generationId).read({
			bytes: 64,
			lines: 10,
		});
		expect("normalSummary" in state.metadata && state.metadata.normalSummary).toBe("running");
		expect(state.runtime).toEqual({ summary: "working", status: "running", updatedAt: "now" });
		expect(state.promptAccepted).toEqual({ acceptedAt: "now", summary: "accepted" });
		expect(JSON.stringify(state)).not.toContain(writerIdentity.leaseId);
		expect(JSON.stringify(state)).not.toContain(writerIdentity.owner.startIdentity);
	});
});

it("keeps pending schema-1 writer journals unreadable", async () => {
	await withSchema1Writer(async owner => {
		const originalRename = fs.rename;
		let failed = false;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (destination === owner.paths.metadata && !failed) {
				failed = true;
				throw Object.assign(new Error("injected metadata mutation failure"), { code: "EIO" });
			}
			await originalRename(source, destination);
		});
		try {
			await expect(owner.appendOutput({ ...(await writerRevision(owner)), entry: "once" })).rejects.toThrow(
				"injected metadata mutation failure",
			);
		} finally {
			rename.mockRestore();
		}
		await expect(
			new VisibleSessionPublicStateReader(owner.paths.root, generationId).read({ bytes: 64, lines: 10 }),
		).rejects.toMatchObject({ code: "unstable" });
	});
});

it("recovers canonical projected writer publications without private-root leakage", async () => {
	await withPublicState(async root => {
		const publicRoot = join(root, "public");
		const privateRoot = join(root, "private");
		const owner = new VisibleSessionStateOwner(projectedState(publicRoot, privateRoot), writerIdentity);
		await owner.initialize();
		await owner.appendOutput({ ...(await writerRevision(owner)), entry: "recovery output" });

		const state = await new VisibleSessionPublicStateReader(publicRoot, generationId, {
			expectedSchemaVersion: 2,
		}).read({ bytes: 64, lines: 10 });
		expect(state.metadata).toMatchObject({
			schemaVersion: 2,
			backend: { kind: "supported", backend: "conpty", source: "canonical" },
		});
		expect(state.pane.text).toBe("recovery output");
		expect(JSON.stringify(state)).not.toContain(privateRoot);
		expect(JSON.stringify(state)).not.toContain(writerIdentity.leaseId);
		expect(JSON.stringify(state)).not.toContain(writerIdentity.owner.startIdentity);
	});
});

it("returns redacted projected writer output", async () => {
	await withPublicState(async root => {
		const publicRoot = join(root, "public");
		const owner = new VisibleSessionStateOwner(projectedState(publicRoot, join(root, "private")), writerIdentity);
		await owner.initialize();
		await owner.appendOutput({ ...(await writerRevision(owner)), entry: "reader-secret" });

		const state = await new VisibleSessionPublicStateReader(publicRoot, generationId, {
			expectedSchemaVersion: 2,
		}).read({ bytes: 64, lines: 10 });
		expect(state.pane.text).not.toContain("reader-secret");
	});
});

it("reads a relative-root schema-2 publication", async () => {
	await withPublicState(async root => {
		const publicRoot = join(root, "public");
		const privateRoot = join(root, "private");
		const owner = new VisibleSessionStateOwner(
			projectedState(relative(process.cwd(), publicRoot), relative(process.cwd(), privateRoot)),
			writerIdentity,
		);
		await owner.initialize();

		const state = await new VisibleSessionPublicStateReader(publicRoot, generationId, {
			expectedSchemaVersion: 2,
		}).read({ bytes: 64, lines: 10 });
		expect(state.metadata).toMatchObject({ schemaVersion: 2 });
		expect(await readFile(owner.paths.publication, "utf8")).toContain('"epoch":');
	});
});
it("requires trusted schema selection instead of trusting mutable public metadata", async () => {
	await withPublicState(async root => {
		await writeMetadata(root);
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "corrupt" });
	});
});
it("rejects minimum epochs unless schema 2 is selected", async () => {
	await withPublicState(async root => {
		expect(() => new VisibleSessionPublicStateReader(root, generationId, { minimumEpoch: 1 } as never)).toThrow(
			"minimum epoch requires schema 2",
		);
		expect(
			() =>
				new VisibleSessionPublicStateReader(root, generationId, {
					expectedSchemaVersion: 1,
					minimumEpoch: 1,
				} as never),
		).toThrow("minimum epoch requires schema 2");
	});
});
it("normalizes final metadata stability races into the unstable reader contract", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		await writeMetadata(root);
		const originalLstat = fs.lstat;
		let metadataReads = 0;
		const lstat = vi.spyOn(fs, "lstat").mockImplementation((async file => {
			if (file === paths.metadata && ++metadataReads % 2 === 0) {
				const error = new Error("injected final metadata race") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return originalLstat(file);
		}) as typeof fs.lstat);
		try {
			await expect(
				new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 1, lines: 1 }),
			).rejects.toMatchObject({
				code: "unstable",
			});
		} finally {
			lstat.mockRestore();
		}
	});
});
it("normalizes final schema-2 manifest stability races into the unstable reader contract", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		const owner = { pid: 7, startedAt: "now" };
		const projectedMetadata = {
			schemaVersion: 2,
			session: "alpha",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "now",
			gjcBin: "gjc",
			stateDir: root,
			paneLog: paths.pane,
			eventsLog: paths.events,
			finalStatus: paths.final,
			runtimeState: paths.runtimeState,
			vanishedStatus: paths.vanished,
			promptAcceptedStatus: paths.promptAccepted,
			worktreeBaselineDirty: false,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner,
		};
		await writeJson(paths.metadata, projectedMetadata);
		const files: ProjectionFiles = {
			metadata: createHash("sha256")
				.update(await readFile(paths.metadata))
				.digest("hex"),
			runtime: null,
			prompt: null,
			pane: null,
			events: null,
			final: null,
			vanished: null,
		};
		await writeJson(paths.publication, { schemaVersion: 2, epoch: 1, generationId, owner, files });
		const originalLstat = fs.lstat;
		let manifestReads = 0;
		const lstat = vi.spyOn(fs, "lstat").mockImplementation((async file => {
			if (file === paths.publication && ++manifestReads % 2 === 0) {
				const error = new Error("injected final manifest race") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return originalLstat(file);
		}) as typeof fs.lstat);
		try {
			await expect(
				new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
					bytes: 1,
					lines: 1,
				}),
			).rejects.toMatchObject({ code: "unstable" });
		} finally {
			lstat.mockRestore();
		}
	});
});
it("normalizes legacy native and preserves unknown projected backends as read-only recovery status", async () => {
	await withPublicState(async root => {
		await writeMinimalProjectedSnapshot(root, "native");
		const legacy = await new VisibleSessionPublicStateReader(root, generationId, {
			expectedSchemaVersion: 2,
		}).read({ bytes: 1, lines: 1 });
		expect(legacy.metadata).toMatchObject({
			schemaVersion: 2,
			backend: { kind: "supported", backend: "conpty", source: "legacy" },
		});
		expect(legacy.runtime).toMatchObject({
			backend: { kind: "supported", backend: "conpty", source: "legacy" },
		});

		await writeMinimalProjectedSnapshot(root, "future-backend");
		const unsupported = await new VisibleSessionPublicStateReader(root, generationId, {
			expectedSchemaVersion: 2,
		}).read({ bytes: 1, lines: 1 });
		expect(unsupported.metadata).toMatchObject({
			schemaVersion: 2,
			backend: { kind: "unsupported", rawId: "future-backend" },
		});
		expect(unsupported.runtime).toMatchObject({
			backend: { kind: "unsupported", rawId: "future-backend" },
		});
	});
});

it("fails closed for invalid projected backends", async () => {
	await withPublicState(async root => {
		await writeMinimalProjectedSnapshot(root, "");
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "corrupt" });
	});
});
it("reads the exact schema-2 projected recovery records", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		const owner = { pid: 7, startedAt: "now" };
		const runtime = {
			schemaVersion: VISIBLE_SESSION_PROJECTED_STATE_SCHEMA_VERSION,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner,
			summary: "working",
			status: "running",
			updatedAt: "now",
			present: true,
			valid: true,
			state: "running",
			source: null,
			event: null,
			reason: null,
			terminal: false,
			terminalState: null,
			terminalSource: null,
			finalResponsePresent: false,
			previousRuntimeState: null,
			sessionMatches: true,
			cwdMatches: true,
		};
		await writeJson(paths.metadata, {
			schemaVersion: 2,
			session: "alpha",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "now",
			gjcBin: "gjc",
			stateDir: root,
			paneLog: paths.pane,
			eventsLog: paths.events,
			finalStatus: paths.final,
			runtimeState: paths.runtimeState,
			vanishedStatus: paths.vanished,
			promptAcceptedStatus: paths.promptAccepted,
			worktreeBaselineDirty: false,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner,
		});
		await writeJson(paths.runtimeState, runtime);
		await writeJson(paths.promptAccepted, {
			schemaVersion: 2,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner,
			session: "alpha",
			acceptedAt: "now",
			summary: "prompt accepted",
			worktreeBaselineDirty: false,
		});
		await writeJson(paths.vanished, {
			schemaVersion: 2,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner,
			session: "alpha",
			workdir: "C:\\worktree",
			detectedAt: "now",
			committedAt: "now",
			reason: "gone",
			phase: "running",
			severity: "failure",
			promptAccepted: true,
			finalPresent: false,
			tuiReady: true,
			paneLog: paths.pane,
			eventsLog: paths.events,
			finalStatus: paths.final,
			runtimeState: paths.runtimeState,
			promptAcceptedStatus: paths.promptAccepted,
			evidenceSummary: "none",
		});
		await writeJson(paths.publication, {
			schemaVersion: 2,
			epoch: 1,
			generationId,
			owner,
			files: {
				metadata: createHash("sha256")
					.update(await readFile(paths.metadata))
					.digest("hex"),
				runtime: createHash("sha256")
					.update(await readFile(paths.runtimeState))
					.digest("hex"),
				prompt: createHash("sha256")
					.update(await readFile(paths.promptAccepted))
					.digest("hex"),
				pane: null,
				events: null,
				final: null,
				vanished: createHash("sha256")
					.update(await readFile(paths.vanished))
					.digest("hex"),
			},
		});
		const state = await new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
			bytes: 1,
			lines: 1,
		});
		expect(state.metadata.schemaVersion).toBe(2);
		expect(state.runtime && "schemaVersion" in state.runtime && state.runtime.schemaVersion).toBe(2);
		expect(
			state.promptAccepted && "schemaVersion" in state.promptAccepted && state.promptAccepted.schemaVersion,
		).toBe(2);
		expect(state.vanished && "schemaVersion" in state.vanished && state.vanished.schemaVersion).toBe(2);
		const originalRuntime = await readFile(paths.runtimeState);
		await writeJson(paths.runtimeState, { ...runtime, status: "tampered" });
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "unstable" });
		await writeFile(paths.runtimeState, originalRuntime);

		const prompt = JSON.parse(await readFile(paths.promptAccepted, "utf8")) as Record<string, unknown>;
		await writeJson(paths.promptAccepted, { ...prompt, session: "other-session" });
		const coherentManifest = JSON.parse(await readFile(paths.publication, "utf8")) as {
			files: Record<string, string | null>;
		};
		coherentManifest.files.prompt = createHash("sha256")
			.update(await readFile(paths.promptAccepted))
			.digest("hex");
		await writeJson(paths.publication, coherentManifest);
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "corrupt" });
		await writeJson(paths.publication, {
			schemaVersion: 2,
			epoch: 2,
			generationId,
			owner,
			files: {
				metadata: createHash("sha256")
					.update(await readFile(paths.metadata))
					.digest("hex"),
			},
		});
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({
			code: "corrupt",
		});
	});
});
it("treats a schema-2 projection without a publication epoch as partial initialization", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		await writeJson(paths.metadata, {
			schemaVersion: 2,
			session: "alpha",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "now",
			gjcBin: "gjc",
			stateDir: root,
			paneLog: paths.pane,
			eventsLog: paths.events,
			finalStatus: paths.final,
			runtimeState: paths.runtimeState,
			vanishedStatus: paths.vanished,
			promptAcceptedStatus: paths.promptAccepted,
			worktreeBaselineDirty: false,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner: { pid: 7, startedAt: "now" },
		});
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "partial_initialization" });
	});
});
it("reports corrupt and generation-mismatched public state distinctly", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		await writeFile(paths.metadata, "{bad");
		await expect(
			new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 1, lines: 1 }),
		).rejects.toMatchObject({ code: "corrupt" });
		await writeMetadata(root);
		await expect(
			new VisibleSessionPublicStateReader(root, "other").read({ bytes: 1, lines: 1 }),
		).rejects.toMatchObject({ code: "generation_mismatch" });
	});
});
it("rejects trusted schema downgrade, mixed projections, and stale or rewritten manifests", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		await writeMetadata(root);
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "corrupt" });

		const owner = { pid: 7, startedAt: "now" };
		const projectedMetadata = {
			schemaVersion: 2,
			session: "alpha",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "now",
			gjcBin: "gjc",
			stateDir: root,
			paneLog: paths.pane,
			eventsLog: paths.events,
			finalStatus: paths.final,
			runtimeState: paths.runtimeState,
			vanishedStatus: paths.vanished,
			promptAcceptedStatus: paths.promptAccepted,
			worktreeBaselineDirty: false,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner,
		};
		await writeJson(paths.metadata, projectedMetadata);
		await writeJson(paths.publication, {
			schemaVersion: 2,
			epoch: 3,
			generationId,
			owner,
			files: {
				metadata: createHash("sha256")
					.update(await readFile(paths.metadata))
					.digest("hex"),
				runtime: null,
				prompt: null,
				pane: null,
				events: null,
				final: null,
				vanished: null,
			},
		});
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 1 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "corrupt" });
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2, minimumEpoch: 4 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "corrupt" });

		const manifest = JSON.parse(await readFile(paths.publication, "utf8")) as {
			epoch: number;
			files: Record<string, string | null>;
		};
		manifest.epoch = 4;
		manifest.files.metadata = "0".repeat(64);
		await writeJson(paths.publication, manifest);
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2, minimumEpoch: 4 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "unstable" });

		manifest.files.metadata = createHash("sha256")
			.update(await readFile(paths.metadata))
			.digest("hex");
		await writeJson(paths.publication, manifest);
		const recovered = await new VisibleSessionPublicStateReader(root, generationId, {
			expectedSchemaVersion: 2,
			minimumEpoch: 4,
		}).read({ bytes: 1, lines: 1 });
		expect(recovered.metadata.schemaVersion).toBe(2);
	});
});
it("fails closed for missing, oversized, and hash-mismatched schema-2 recovery files", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		const owner = { pid: 7, startedAt: "now" };
		const metadata = {
			schemaVersion: 2,
			session: "alpha",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "now",
			gjcBin: "gjc",
			stateDir: root,
			paneLog: paths.pane,
			eventsLog: paths.events,
			finalStatus: paths.final,
			runtimeState: paths.runtimeState,
			vanishedStatus: paths.vanished,
			promptAcceptedStatus: paths.promptAccepted,
			worktreeBaselineDirty: false,
			backend: "conpty",
			generation: generationId,
			generationId,
			owner,
		};
		await writeJson(paths.metadata, metadata);
		const files: ProjectionFiles = {
			metadata: createHash("sha256")
				.update(await readFile(paths.metadata))
				.digest("hex"),
			runtime: null,
			prompt: null,
			pane: null,
			events: null,
			final: null,
			vanished: null,
		};
		await writeJson(paths.publication, { schemaVersion: 2, epoch: 1, generationId, owner, files });
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).resolves.toMatchObject({ metadata: { schemaVersion: 2 } });
		await writeFile(paths.pane, "replacement");
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "unstable" });
		files.pane = createHash("sha256")
			.update(await readFile(paths.pane))
			.digest("hex");
		await writeJson(paths.publication, { schemaVersion: 2, epoch: 2, generationId, owner, files });
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 64,
				lines: 1,
			}),
		).resolves.toMatchObject({ pane: { text: "replacement", lines: 1 } });
		await writeFile(paths.pane, "x".repeat(128 * 1024 + 1));
		files.pane = createHash("sha256")
			.update(await readFile(paths.pane))
			.digest("hex");
		await writeJson(paths.publication, { schemaVersion: 2, epoch: 3, generationId, owner, files });
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).read({
				bytes: 1,
				lines: 1,
			}),
		).rejects.toMatchObject({ code: "corrupt" });
	});
});
it("enforces schema-1 metadata trust for direct pane tails", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		await writeMetadata(root);
		await writeFile(paths.pane, "trusted\n");
		const reader = new VisibleSessionPublicStateReader(root, generationId);
		await writeJson(paths.metadata, { ...metadata(), generationId: "other-generation" });
		await expect(reader.readPaneTail({ bytes: 64, lines: 10 })).rejects.toMatchObject({
			code: "generation_mismatch",
		});
		await writeFile(paths.metadata, "{invalid");
		await expect(reader.readPaneTail({ bytes: 64, lines: 10 })).rejects.toMatchObject({ code: "corrupt" });
		await rm(paths.metadata);
		await expect(reader.readPaneTail({ bytes: 64, lines: 10 })).rejects.toMatchObject({
			code: "partial_initialization",
		});
	});
});
it("rejects schema downgrades through direct pane tails", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		await writeMetadata(root);
		await writeFile(paths.pane, "stale\n");
		await expect(
			new VisibleSessionPublicStateReader(root, generationId, { expectedSchemaVersion: 2 }).readPaneTail({
				bytes: 64,
				lines: 10,
			}),
		).rejects.toMatchObject({ code: "corrupt" });
	});
});
it("bounds oversized public files and preserves operational read causes", async () => {
	await withPublicState(async root => {
		const paths = visibleSessionStatePaths(root);
		await writeFile(paths.metadata, "x".repeat(128 * 1024 + 1));
		await expect(
			new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 1, lines: 1 }),
		).rejects.toMatchObject({
			code: "corrupt",
		});
		await writeMetadata(root);
		const failure = Object.assign(new Error("injected read failure"), { code: "EIO" });
		const lstat = vi.spyOn(fs, "lstat").mockRejectedValueOnce(failure);
		try {
			await expect(
				new VisibleSessionPublicStateReader(root, generationId).read({ bytes: 1, lines: 1 }),
			).rejects.toMatchObject({
				code: "corrupt",
				cause: failure,
			});
		} finally {
			lstat.mockRestore();
		}
	});
});
