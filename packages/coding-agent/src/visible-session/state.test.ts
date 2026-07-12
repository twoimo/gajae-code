import { describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	DEFAULT_PUBLIC_LOG_CAP_BYTES,
	MAX_PUBLIC_TEXT_BYTES,
	MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
	PUBLIC_LOG_TRUNCATION_MARKER,
	readVisibleSessionPrivateTerminal,
	redactVisibleSessionText,
	VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
	type VisibleSessionProjectedRuntime,
	type VisibleSessionRoleIdentity,
	VisibleSessionStateMonitor,
	VisibleSessionStateOwner,
	type VisibleSessionStateProjection,
	visibleSessionStatePaths,
} from "./state";

const secret = "token=real-secret; prompt=private; AUTH=not-public";
const identity: VisibleSessionRoleIdentity = {
	generationId: "generation-1",
	leaseId: "private-lease-token",
	owner: { pid: 41, startIdentity: "private-process-start" },
	redactions: [secret, "private-env-value", "private-auth-value"],
};
setDefaultTimeout(30_000);

async function withState<T>(
	fn: (owner: VisibleSessionStateOwner, monitor: VisibleSessionStateMonitor) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-state-"));
	try {
		const owner = new VisibleSessionStateOwner(directory, identity);
		const monitor = new VisibleSessionStateMonitor(directory, identity);
		await owner.initialize();
		return await fn(owner, monitor);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
async function withIdentity<T>(
	redactions: readonly string[],
	fn: (owner: VisibleSessionStateOwner, monitor: VisibleSessionStateMonitor) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-state-"));
	const privateIdentity: VisibleSessionRoleIdentity = { ...identity, redactions };
	try {
		const owner = new VisibleSessionStateOwner(directory, privateIdentity);
		const monitor = new VisibleSessionStateMonitor(directory, privateIdentity);
		await owner.initialize();
		return await fn(owner, monitor);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function write(owner: VisibleSessionStateOwner) {
	return { expectedRevision: (await owner.readMetadata()).revision };
}
async function fileSizeOrZero(file: string): Promise<number> {
	try {
		return (await stat(file)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

function finalRecord() {
	return {
		schemaVersion: VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
		generationId: "generation-1",
		committedAt: "2026-01-01T00:00:00.000Z",
		ownerExitReason: `completed ${secret}`,
		severity: "info" as const,
		runtimeSummary: secret,
		worktreeSummary: "clean private-env-value",
		evidenceSummary: "private-auth-value",
	};
}

function vanishedRecord() {
	return {
		schemaVersion: VISIBLE_SESSION_PUBLIC_STATE_SCHEMA_VERSION,
		generationId: "generation-1",
		committedAt: "2026-01-01T00:00:00.000Z",
		reason: secret,
		evidenceSummary: secret,
	};
}
function publicFinalRecord() {
	return {
		...finalRecord(),
		ownerExitReason: "completed",
		runtimeSummary: "finished",
		worktreeSummary: "clean",
		evidenceSummary: "evidence",
	};
}
function projectedFinalRecord() {
	return {
		schemaVersion: 2 as const,
		backend: "conpty" as const,
		generation: "untrusted",
		generationId: "untrusted",
		owner: { pid: 1, startedAt: "untrusted" },
		session: "untrusted",
		status: 0,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
		paneLog: "untrusted",
		runtimeState: "untrusted",
		turnEvidencePresent: true,
		promptAccepted: true,
		ownerExitReason: "completed",
		severity: "normal" as const,
		runtimeTerminal: true,
		runtimeTerminalState: "completed",
		runtimeTerminalSource: "coordinator",
		worktreeBaselineDirty: false,
		observedRecoverableWorktreeChanges: false,
		worktreeChangedSinceBaseline: false,
		runtimeStateSummary: {
			summary: "finished",
			status: "completed",
			updatedAt: "2026-01-01T00:00:01.000Z",
			present: true,
			valid: true,
			state: "completed",
			source: "coordinator",
			event: null,
			reason: null,
			terminal: true,
			terminalState: "completed",
			terminalSource: "coordinator",
			finalResponsePresent: true,
			previousRuntimeState: "running",
			sessionMatches: true,
			cwdMatches: true,
			ownerExitReason: "completed",
			severity: "normal" as const,
		},
		committedAt: "2026-01-01T00:00:01.000Z",
		runtimeSummary: "finished",
		worktreeSummary: "clean",
		evidenceSummary: "evidence",
	};
}
function projectedVanishedRecord() {
	return {
		schemaVersion: 2 as const,
		backend: "conpty" as const,
		generation: "untrusted",
		generationId: "untrusted",
		owner: { pid: 1, startedAt: "untrusted" },
		session: "untrusted",
		workdir: "untrusted",
		detectedAt: "2026-01-01T00:00:01.000Z",
		committedAt: "2026-01-01T00:00:01.000Z",
		reason: "owner vanished",
		phase: "running",
		severity: "failure" as const,
		promptAccepted: true,
		finalPresent: false as const,
		tuiReady: true,
		paneLog: "untrusted",
		eventsLog: "untrusted",
		finalStatus: "untrusted",
		runtimeState: "untrusted",
		promptAcceptedStatus: "untrusted",
		evidenceSummary: "evidence",
	};
}

describe("visible session public state", () => {
	it("separates owner and monitor writer contracts", async () => {
		await withState(async (owner, monitor) => {
			expect("commitVanished" in owner).toBe(false);
			expect("updateRuntime" in monitor).toBe(false);
			const stale = new VisibleSessionStateOwner(owner.paths.root, { ...identity, leaseId: "different-lease" });
			await expect(stale.updateNormal(await write(owner), "nope")).rejects.toThrow("authority mismatch");
		});
	});
	it("requires exact private authority before returning a terminal proof", async () => {
		await withState(async owner => {
			await owner.commitFinal({ ...(await write(owner)), record: finalRecord() });
			await expect(readVisibleSessionPrivateTerminal(owner.paths.root, identity)).resolves.toMatchObject({
				generationId: identity.generationId,
				ownerExitReason: expect.any(String),
			});
			await expect(
				readVisibleSessionPrivateTerminal(owner.paths.root, { ...identity, leaseId: "different-lease" }),
			).rejects.toThrow("authority mismatch");
		});
	});
	it("accepts only canonical bounded private prompt receipts", async () => {
		await withState(async (owner, monitor) => {
			expect(await monitor.hasPromptAccepted()).toBeFalse();
			await writeFile(owner.paths.promptAccepted, JSON.stringify({ acceptedAt: "now", summary: "accepted" }));
			expect(await monitor.hasPromptAccepted()).toBeTrue();
			for (const receipt of [
				{ acceptedAt: "now", summary: "accepted", extra: true },
				{ acceptedAt: "now", summary: "accepted\0" },
				{ acceptedAt: "now", summary: "x".repeat(4097) },
				[],
			]) {
				await writeFile(owner.paths.promptAccepted, JSON.stringify(receipt));
				await expect(monitor.hasPromptAccepted()).rejects.toThrow("prompt receipt is corrupt");
			}
			await writeFile(owner.paths.promptAccepted, "{");
			await expect(monitor.hasPromptAccepted()).rejects.toThrow();
		});
	});

	it("makes final and vanished mutually exclusive and immutable", async () => {
		await withState(async (owner, monitor) => {
			const token = await write(owner);
			const results = await Promise.allSettled([
				owner.commitFinal({ ...token, record: finalRecord() }),
				monitor.commitVanished({ ...token, record: vanishedRecord() }),
			]);
			expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
			const terminal = await monitor.readTerminal();
			expect(terminal).not.toBeNull();
			if (terminal && "ownerExitReason" in terminal)
				await expect(
					owner.commitFinal({
						expectedRevision: (await owner.readMetadata()).revision,
						record: { ...finalRecord(), evidenceSummary: "different" },
					}),
				).rejects.toThrow("immutable");
		});
	});
	it("fails closed when [redacted] reconstructs a protected value across field boundaries", async () => {
		const protectedValue = "[redacted]tail";
		expect(redactVisibleSessionText("secrettail", [protectedValue, "secret"])).toBe("");
		await withIdentity([protectedValue, "secret"], async owner => {
			let token = await write(owner);
			await owner.updateNormal(token, "secrettail");
			token = await write(owner);
			await owner.updateRuntime(token, { summary: "secrettail", status: "secrettail", updatedAt: "secrettail" });
			token = await write(owner);
			await owner.recordPromptAccepted(token, { acceptedAt: "secrettail", summary: "secrettail" });
			token = await write(owner);
			await owner.appendOutput({ ...token, entry: "secrettail" });
			token = await write(owner);
			await owner.appendEvent({ ...token, entry: "secrettail" });
			token = await write(owner);
			await owner.commitFinal({
				...token,
				record: { ...finalRecord(), ownerExitReason: "secrettail", runtimeSummary: "secrettail" },
			});
			for (const file of await readdir(owner.paths.root))
				expect(await readFile(join(owner.paths.root, file), "utf8")).not.toContain(protectedValue);
		});
	});

	it("redacts actual private values from every public writer and rejects malformed public input", async () => {
		await withState(async (owner, monitor) => {
			let token = await write(owner);
			await owner.updateNormal(token, secret);
			token = await write(owner);
			await owner.updateRuntime(token, { summary: secret, status: "private-env-value", updatedAt: "2026-01-01" });
			token = await write(owner);
			await owner.recordPromptAccepted(token, { acceptedAt: "2026-01-01", summary: secret });
			token = await write(owner);
			await owner.appendOutput({ ...token, entry: secret });
			token = await write(owner);
			await owner.appendEvent({ ...token, entry: secret });
			token = await write(owner);
			await owner.commitFinal({ ...token, record: finalRecord() });
			for (const file of (await readdir(owner.paths.root)).filter(file => !file.startsWith("."))) {
				const text = await readFile(join(owner.paths.root, file), "utf8");
				for (const value of [...identity.redactions, identity.leaseId, identity.owner.startIdentity])
					expect(text).not.toContain(value);
			}
			await expect(monitor.readTerminal()).resolves.not.toBeNull();
		});
	});

	it("uses a UTF-8-safe capped pane.log tail", async () => {
		await withState(async owner => {
			const cap = 128;
			await owner.appendOutput({ ...(await write(owner)), entry: "😀漢字".repeat(100), capBytes: cap });
			const content = await readFile(owner.paths.pane, "utf8");
			expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(cap);
			expect(content).not.toContain("�");
			expect((await stat(owner.paths.pane)).size).toBeLessThanOrEqual(cap);
		});
	});
	it("redacts split durable writes and chooses a collision-safe truncation marker", async () => {
		const paneSecret = "secret";
		const eventsSecret = "sec\nret";
		const markerSecret = `${PUBLIC_LOG_TRUNCATION_MARKER}tail`;
		await withIdentity([], async owner => {
			const cap = 48;
			await owner.appendOutput({ ...(await write(owner)), entry: "x".repeat(40), capBytes: cap });
			await owner.appendOutput({ ...(await write(owner)), entry: "sec", capBytes: cap });
			await owner.addRedactions([paneSecret, eventsSecret, markerSecret]);
			await owner.appendOutput({ ...(await write(owner)), entry: "ret", capBytes: cap });
			await owner.appendOutput({ ...(await write(owner)), entry: "y".repeat(40), capBytes: cap });
			await owner.appendEvent({ ...(await write(owner)), entry: "x".repeat(30), capBytes: cap });
			await owner.appendEvent({ ...(await write(owner)), entry: "sec", capBytes: cap });
			await owner.appendEvent({ ...(await write(owner)), entry: "ret", capBytes: cap });
			await owner.appendEvent({ ...(await write(owner)), entry: "y".repeat(40), capBytes: cap });
			for (const file of [owner.paths.pane, owner.paths.events]) {
				const content = await readFile(file, "utf8");
				for (const protectedValue of [paneSecret, eventsSecret, markerSecret])
					expect(content).not.toContain(protectedValue);
				expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(cap);
			}
		});
	});
	it("rejects redaction updates after terminal outcomes without changing logs", async () => {
		await withState(async owner => {
			await owner.appendOutput({ ...(await write(owner)), entry: "before" });
			const pane = await readFile(owner.paths.pane);
			await owner.commitFinal({ ...(await write(owner)), record: finalRecord() });
			await expect(owner.addRedactions(["before"])).rejects.toThrow("terminal outcome already committed");
			expect(await readFile(owner.paths.pane)).toEqual(pane);
		});
	});
	it("rejects stale authority and pending or committed terminal redaction updates without changing logs", async () => {
		for (const outcome of ["authority", "pending", "final", "vanished"] as const) {
			await withState(async (owner, monitor) => {
				await owner.appendOutput({ ...(await write(owner)), entry: "before" });
				await owner.appendEvent({ ...(await write(owner)), entry: "before" });
				const pane = await readFile(owner.paths.pane);
				const events = await readFile(owner.paths.events);
				if (outcome === "authority") {
					const stale = new VisibleSessionStateOwner(owner.paths.root, {
						...identity,
						leaseId: "different-lease",
					});
					await expect(stale.addRedactions(["before"])).rejects.toThrow("authority mismatch");
				} else if (outcome === "pending") {
					const receipt = {
						kind: "cleanup-private-token" as const,
						generationId: identity.generationId,
						leaseId: createHash("sha256")
							.update(`${identity.leaseId}\0${identity.owner.pid}\0${identity.owner.startIdentity}`)
							.digest("hex"),
					};
					await writeFile(
						owner.paths.journal,
						JSON.stringify({ kind: "final", record: finalRecord(), revision: 1, cleanup: receipt }),
					);
					await expect(owner.addRedactions(["before"])).rejects.toThrow("terminal outcome already committed");
				} else {
					if (outcome === "final") await owner.commitFinal({ ...(await write(owner)), record: finalRecord() });
					else await monitor.commitVanished({ ...(await write(owner)), record: vanishedRecord() });
					await expect(owner.addRedactions(["before"])).rejects.toThrow("terminal outcome already committed");
				}
				expect(await readFile(owner.paths.pane)).toEqual(pane);
				expect(await readFile(owner.paths.events)).toEqual(events);
			});
		}
	});
	it("appends pane bytes exactly while retaining newline-delimited event records", async () => {
		await withState(async owner => {
			const output = "\u001b[31mred\u001b[0m";
			const first = await owner.appendOutput({ ...(await write(owner)), entry: output });
			expect(first).toBe(1);
			expect(await owner.appendOutput({ ...(await write(owner)), entry: "" })).toBe(first);
			await owner.appendOutput({ ...(await write(owner)), entry: "😀" });
			await owner.appendEvent({ ...(await write(owner)), entry: "first" });
			await owner.appendEvent({ ...(await write(owner)), entry: "second" });
			expect(await readFile(owner.paths.pane, "utf8")).toBe(`${output}😀`);
			expect(await readFile(owner.paths.events, "utf8")).toBe("first\nsecond\n");
		});
	});

	it("claims cleanup exactly once and does not reissue after acknowledgement", async () => {
		await withState(async (owner, monitor) => {
			await owner.commitFinal({ ...(await write(owner)), record: finalRecord() });
			const [first, second] = await Promise.allSettled([
				monitor.claimCleanup("monitor-a"),
				monitor.claimCleanup("monitor-b"),
			]);
			expect([first, second].filter(result => result.status === "fulfilled" && result.value !== null)).toHaveLength(
				1,
			);
			const claimant = first.status === "fulfilled" && first.value ? "monitor-a" : "monitor-b";
			await monitor.ackCleanup(claimant);
			expect(await monitor.claimCleanup(claimant)).toBeNull();
		});
	});
	it("blocks nonterminal writes behind a durable terminal journal until reconciliation", async () => {
		await withState(async owner => {
			const record = publicFinalRecord();
			const receipt = {
				kind: "cleanup-private-token" as const,
				generationId: identity.generationId,
				leaseId: createHash("sha256")
					.update(`${identity.leaseId}\0${identity.owner.pid}\0${identity.owner.startIdentity}`)
					.digest("hex"),
			};
			await writeFile(owner.paths.journal, JSON.stringify({ kind: "final", record, revision: 1, cleanup: receipt }));
			const before = await readFile(owner.paths.metadata, "utf8");
			const input = { expectedRevision: 0 };
			await expect(owner.updateNormal(input, "normal")).rejects.toThrow("outcome already committed");
			await expect(
				owner.updateRuntime(input, { summary: "runtime", status: "running", updatedAt: "2026-01-01" }),
			).rejects.toThrow("outcome already committed");
			await expect(owner.appendOutput({ ...input, entry: "output" })).rejects.toThrow("outcome already committed");
			await expect(owner.appendEvent({ ...input, entry: "event" })).rejects.toThrow("outcome already committed");
			await expect(
				owner.recordPromptAccepted(input, { acceptedAt: "2026-01-01", summary: "prompt" }),
			).rejects.toThrow("outcome already committed");
			expect(await readFile(owner.paths.metadata, "utf8")).toBe(before);
			await expect(readFile(owner.paths.runtimeState, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(owner.paths.pane, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(owner.paths.events, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(owner.paths.promptAccepted, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
	it("recovers terminal publication journals only for the matching requested outcome", async () => {
		await withState(async (owner, monitor) => {
			const record = publicFinalRecord();
			const receipt = {
				kind: "cleanup-private-token" as const,
				generationId: identity.generationId,
				leaseId: createHash("sha256")
					.update(`${identity.leaseId}\0${identity.owner.pid}\0${identity.owner.startIdentity}`)
					.digest("hex"),
			};
			await writeFile(owner.paths.final, JSON.stringify(record));
			await writeFile(owner.paths.journal, JSON.stringify({ kind: "final", record, revision: 1, cleanup: receipt }));
			await expect(monitor.commitVanished({ expectedRevision: 0, record: vanishedRecord() })).rejects.toThrow(
				"outcome already committed",
			);
			await expect(
				owner.commitFinal({
					expectedRevision: 0,
					record: { ...record, evidenceSummary: "different" },
				}),
			).rejects.toThrow("immutable");
			expect(await monitor.claimCleanup("monitor-a")).toEqual(receipt);
			expect((await owner.readMetadata()).cleanup?.status).toBe("claimed");
		});
	});
	it("replays private terminal journals into sanitized public records without changing private identity", async () => {
		await withIdentity(["source-secret"], async (owner, monitor) => {
			const receipt = {
				kind: "cleanup-private-token" as const,
				generationId: identity.generationId,
				leaseId: createHash("sha256")
					.update(`${identity.leaseId}\0${identity.owner.pid}\0${identity.owner.startIdentity}`)
					.digest("hex"),
			};
			const privateRecord = {
				...publicFinalRecord(),
				ownerExitReason: "source-secret",
				runtimeSummary: "source-secret",
			};
			const record = {
				...privateRecord,
				ownerExitReason: "[redacted]",
				runtimeSummary: "[redacted]",
			};
			await writeFile(
				owner.paths.journal,
				JSON.stringify({ kind: "final", record: privateRecord, revision: 1, cleanup: receipt }),
			);
			await owner.commitFinal({
				expectedRevision: 0,
				record: privateRecord,
			});
			const published = JSON.parse(await readFile(owner.paths.final, "utf8")) as typeof record;
			expect(published).toEqual(record);
			expect(await monitor.claimCleanup("monitor-a")).toEqual(receipt);
			expect(await readdir(owner.paths.root)).not.toContain(".terminal-journal.json");
		});
	});
	it("rejects private identities that overlap the public generation ID", () => {
		expect(() => new VisibleSessionStateOwner("unused", { ...identity, leaseId: identity.generationId })).toThrow(
			"overlaps the public generation",
		);
		expect(
			() =>
				new VisibleSessionStateOwner("unused", {
					...identity,
					owner: { ...identity.owner, startIdentity: "generation" },
				}),
		).toThrow("overlaps the public generation");
		expect(
			() => new VisibleSessionStateMonitor("unused", { ...identity, redactions: ["generation", "private"] }),
		).not.toThrow();
	});
	it("keeps generation IDs public while redacting valid private identities", async () => {
		await withIdentity(["private-only"], async (owner, monitor) => {
			await owner.commitFinal({
				...(await write(owner)),
				record: {
					...publicFinalRecord(),
					ownerExitReason: "private-only",
					runtimeSummary: identity.leaseId,
					evidenceSummary: identity.owner.startIdentity,
				},
			});
			const terminal = await monitor.readTerminal();
			expect(terminal?.generationId).toBe(identity.generationId);
			expect(JSON.stringify(terminal)).not.toContain("private-only");
			expect(JSON.stringify(terminal)).not.toContain(identity.leaseId);
			expect(JSON.stringify(terminal)).not.toContain(identity.owner.startIdentity);
		});
	});
	it("rejects cleanup operations from a different generation or authority", async () => {
		await withState(async (owner, monitor) => {
			await owner.commitFinal({ ...(await write(owner)), record: finalRecord() });
			await monitor.claimCleanup("monitor-a");
			const wrongAuthority = new VisibleSessionStateMonitor(owner.paths.root, {
				...identity,
				leaseId: "wrong-lease",
			});
			const wrongGeneration = new VisibleSessionStateMonitor(owner.paths.root, {
				...identity,
				generationId: "wrong-generation",
			});
			await expect(wrongAuthority.claimCleanup("monitor-a")).rejects.toThrow("authority mismatch");
			await expect(wrongAuthority.ackCleanup("monitor-a")).rejects.toThrow("authority mismatch");
			await expect(wrongGeneration.revokeCleanup("monitor-a")).rejects.toThrow("authority mismatch");
			await expect(monitor.revokeCleanup("monitor-a")).resolves.toBeUndefined();
		});
	});
	it("redacts implicit private identities before truncation and caps replacement expansion", async () => {
		await withIdentity([], async owner => {
			await owner.updateNormal(
				await write(owner),
				`${"a".repeat(4090)}${identity.leaseId}${identity.owner.startIdentity}`,
			);
			const metadata = await owner.readMetadata();
			expect(metadata.normalSummary).not.toContain("private-lease-");
			expect(metadata.normalSummary).not.toContain(identity.owner.startIdentity);
			expect(Buffer.byteLength(metadata.normalSummary, "utf8")).toBeLessThanOrEqual(4096);
		});
		await withIdentity(["x"], async owner => {
			await owner.updateNormal(await write(owner), "x".repeat(4096));
			const metadata = await owner.readMetadata();
			expect(metadata.normalSummary).not.toContain("x");
			expect(Buffer.byteLength(metadata.normalSummary, "utf8")).toBeLessThanOrEqual(4096);
		});
	});
	it("reopens pending legacy redaction rebases before a different mutation", async () => {
		await withState(async owner => {
			await owner.appendOutput({ expectedRevision: 0, entry: "secret" });
			await owner.appendEvent({ expectedRevision: 1, entry: "secret" });
			const originalRename = fs.rename;
			let failed = false;
			const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (destination === owner.paths.events && !failed) {
					failed = true;
					throw Object.assign(new Error("injected events rebase failure"), { code: "EIO" });
				}
				await originalRename(source, destination);
			});
			try {
				await expect(owner.addRedactions(["secret"])).rejects.toThrow("injected events rebase failure");
			} finally {
				rename.mockRestore();
			}
			const reopened = new VisibleSessionStateOwner(owner.paths.root, identity);
			await reopened.initialize();
			await reopened.appendOutput({ ...(await write(reopened)), entry: "secret after reopen" });
			expect(await readFile(reopened.paths.pane, "utf8")).not.toContain("secret");
			expect(await readFile(reopened.paths.events, "utf8")).not.toContain("secret");
		});
	});
	it("keeps legacy target bytes unreadable until a pending mutation reopens and commits", async () => {
		await withState(async owner => {
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
				await expect(owner.appendOutput({ expectedRevision: 0, entry: "once" })).rejects.toThrow(
					"injected metadata mutation failure",
				);
			} finally {
				rename.mockRestore();
			}
			const reopened = new VisibleSessionStateOwner(owner.paths.root, identity);
			await reopened.initialize();
			await reopened.appendOutput({ ...(await write(reopened)), entry: "twice" });
			expect(await readFile(reopened.paths.pane, "utf8")).toBe("oncetwice");
		});
	});
	it("keeps general redactions when log-only redactions are configured", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gjc-visible-log-redaction-"));
		const configuredIdentity: VisibleSessionRoleIdentity = {
			...identity,
			redactions: ["general-secret"],
			logRedactions: ["log-secret"],
		};
		try {
			const owner = new VisibleSessionStateOwner(directory, configuredIdentity);
			await owner.initialize();
			await owner.appendOutput({ expectedRevision: 0, entry: "general-" });
			await owner.appendOutput({ expectedRevision: 1, entry: "secret" });
			expect(await readFile(owner.paths.pane, "utf8")).not.toContain("general-secret");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("rejects escape-heavy redaction state before creating an unrecoverable journal", async () => {
		await withState(async owner => {
			await expect(owner.addRedactions(["\b".repeat(64 * 1024)])).rejects.toThrow("redaction update is invalid");
			await expect(readFile(owner.paths.redactionRebaseJournal)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(owner.paths.redactionState)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
	it("reopens a fail-closed empty pane mutation", async () => {
		await withState(async owner => {
			await owner.addRedactions(["[redacted]"]);
			const originalRename = fs.rename;
			let failed = false;
			const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (destination === owner.paths.metadata && !failed) {
					failed = true;
					throw Object.assign(new Error("injected empty-pane metadata failure"), { code: "EIO" });
				}
				await originalRename(source, destination);
			});
			try {
				await expect(owner.appendOutput({ expectedRevision: 0, entry: "[redacted]" })).rejects.toThrow(
					"empty-pane metadata failure",
				);
			} finally {
				rename.mockRestore();
			}
			const reopened = new VisibleSessionStateOwner(owner.paths.root, identity);
			await expect(reopened.initialize()).resolves.toMatchObject({ revision: 1 });
			expect(await readFile(reopened.paths.pane, "utf8")).toBe("");
		});
	});
	it("fails closed for acknowledged cleanup authority corruption and terminal cleanup loss", async () => {
		await withState(async (owner, monitor) => {
			await owner.commitFinal({ expectedRevision: 0, record: finalRecord() });
			await monitor.claimCleanup("monitor-a");
			await monitor.ackCleanup("monitor-a");
			const stored = JSON.parse(await readFile(owner.paths.metadata, "utf8")) as Record<string, unknown>;
			await writeFile(
				owner.paths.metadata,
				JSON.stringify({
					...stored,
					cleanup: {
						...(stored.cleanup as Record<string, unknown>),
						receipt: {
							...(stored.cleanup as { receipt: Record<string, unknown> }).receipt,
							leaseId: "wrong-authority",
						},
					},
				}),
			);
			await expect(monitor.claimCleanup("monitor-a")).rejects.toThrow("cleanup authority mismatch");
			await writeFile(owner.paths.metadata, JSON.stringify({ ...stored, cleanup: null }));
			await expect(monitor.revokeCleanup("monitor-a")).rejects.toThrow("terminal cleanup is corrupt");
		});
	});
});
it("projects schema-2 metadata from public paths and keeps private CAS state private", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-state-"));
	const publicRoot = join(directory, "public");
	const projection = {
		publicRoot,
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "C:\\bin\\gjc.exe",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		const monitor = new VisibleSessionStateMonitor(projection, identity);
		await owner.initialize();
		await expect(owner.updateNormal({ expectedRevision: 0 }, "invalid\0summary")).rejects.toThrow(
			"public text is invalid",
		);
		await expect(readFile(join(projection.privateRoot, ".projection-journal.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const metadata = JSON.parse(await readFile(owner.paths.metadata, "utf8")) as Record<string, unknown>;
		expect(Object.keys(metadata).sort()).toEqual(
			[
				"backend",
				"branch",
				"createdAt",
				"eventsLog",
				"finalStatus",
				"generation",
				"generationId",
				"gjcBin",
				"owner",
				"paneLog",
				"promptAcceptedStatus",
				"runtimeState",
				"schemaVersion",
				"session",
				"stateDir",
				"vanishedStatus",
				"workdir",
				"worktreeBaselineDirty",
			].sort(),
		);
		expect(metadata.paneLog).toBe(owner.paths.pane);
		expect(metadata.eventsLog).toBe(owner.paths.events);
		expect(metadata.finalStatus).toBe(owner.paths.final);
		expect(metadata.runtimeState).toBe(owner.paths.runtimeState);
		expect(metadata.vanishedStatus).toBe(owner.paths.vanished);
		expect(metadata.promptAcceptedStatus).toBe(owner.paths.promptAccepted);
		const revision = (await owner.readMetadata()).revision;
		await owner.appendOutput({ expectedRevision: revision, entry: "safe output" });
		await owner.appendEvent({ expectedRevision: revision + 1, entry: "safe event" });
		const runtimeValue = {
			schemaVersion: 2 as const,
			backend: "conpty" as const,
			generation: "untrusted",
			generationId: "untrusted",
			owner: { pid: 1, startedAt: "untrusted" },
			summary: "safe runtime",
			status: "running",
			updatedAt: "2026-01-01T00:00:01.000Z",
			present: true,
			valid: true,
			state: "running",
			source: "coordinator",
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
		await owner.updateRuntime({ expectedRevision: revision + 2 }, runtimeValue);
		await owner.recordPromptAccepted(
			{ expectedRevision: revision + 3 },
			{
				schemaVersion: 2,
				backend: "conpty",
				generation: "untrusted",
				generationId: "untrusted",
				owner: { pid: 1, startedAt: "untrusted" },
				session: "untrusted",
				acceptedAt: "2026-01-01T00:00:02.000Z",
				summary: "prompt accepted",
				worktreeBaselineDirty: false,
			},
		);
		await expect(owner.updateRuntime({ expectedRevision: revision + 99 }, runtimeValue)).rejects.toThrow(
			"revision mismatch",
		);
		const originalRename = fs.rename;
		let metadataWrites = 0;
		const rename = vi.spyOn(fs, "rename").mockImplementation((async (source, destination) => {
			if (destination === join(projection.privateRoot, "metadata.json") && ++metadataWrites === 2)
				throw Object.assign(new Error("injected metadata bump failure"), { code: "EIO" });
			return originalRename(source, destination);
		}) as typeof fs.rename);
		try {
			expect(
				await owner.updateRuntime(
					{ expectedRevision: revision + 4 },
					{ ...runtimeValue, updatedAt: "2026-01-01T00:00:03.000Z" },
				),
			).toBe(revision + 5);
		} finally {
			rename.mockRestore();
		}
		const runtime = JSON.parse(await readFile(owner.paths.runtimeState, "utf8")) as Record<string, unknown>;
		const accepted = JSON.parse(await readFile(owner.paths.promptAccepted, "utf8")) as Record<string, unknown>;
		expect(accepted.session).toBe("session");
		expect(Object.keys(runtime).sort()).toEqual(
			[
				"backend",
				"cwdMatches",
				"event",
				"finalResponsePresent",
				"generation",
				"generationId",
				"owner",
				"present",
				"previousRuntimeState",
				"reason",
				"schemaVersion",
				"sessionMatches",
				"source",
				"state",
				"status",
				"summary",
				"terminal",
				"terminalSource",
				"terminalState",
				"updatedAt",
				"valid",
			].sort(),
		);
		expect(Object.keys(accepted).sort()).toEqual(
			[
				"acceptedAt",
				"backend",
				"generation",
				"generationId",
				"owner",
				"schemaVersion",
				"session",
				"summary",
				"worktreeBaselineDirty",
			].sort(),
		);
		expect(accepted.summary).toBe("prompt accepted");
		for (const file of [
			owner.paths.metadata,
			owner.paths.events,
			owner.paths.pane,
			owner.paths.runtimeState,
			owner.paths.promptAccepted,
		]) {
			const text = await readFile(file, "utf8");
			expect(text).not.toContain(identity.leaseId);
			expect(text).not.toContain(identity.owner.startIdentity);
		}
		expect(JSON.stringify(metadata)).not.toContain(identity.leaseId);
		expect(JSON.stringify(metadata)).not.toContain(identity.owner.startIdentity);
		expect(await readFile(join(projection.privateRoot, "metadata.json"), "utf8")).toContain('"authority"');
		expect(await monitor.readTerminal()).toBeNull();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("publishes projected redaction rebases coherently and recovers every public publication boundary", async () => {
	for (const boundary of ["pane.log", "events.log", ".publication.json"] as const) {
		const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-redaction-"));
		const projection = {
			publicRoot: join(directory, "public"),
			privateRoot: join(directory, "private"),
			session: "session",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
			gjcBin: "C:\\bin\\gjc.exe",
			worktreeBaselineDirty: false,
			owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
			backend: "conpty" as const,
		};
		try {
			const owner = new VisibleSessionStateOwner(projection, identity);
			await owner.initialize();
			await owner.appendOutput({ expectedRevision: 0, entry: "secret rotation-secret" });
			await owner.appendEvent({ expectedRevision: 1, entry: "secret rotation-secret" });
			const originalRename = fs.rename;
			let failures = 0;
			const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (destination === join(projection.publicRoot, boundary) && failures++ === 0)
					throw Object.assign(new Error(`injected ${boundary} publication failure`), { code: "EIO" });
				await originalRename(source, destination);
			});
			try {
				await expect(owner.addRedactions(["secret"])).rejects.toThrow(`injected ${boundary} publication failure`);
			} finally {
				rename.mockRestore();
			}
			const rotatedIdentity: VisibleSessionRoleIdentity = {
				...identity,
				logRedactions: ["rotation-secret"],
			};
			const reopened = new VisibleSessionStateOwner(projection, rotatedIdentity);
			await reopened.initialize();
			const reopenedRevision = (await reopened.readMetadata()).revision;
			await reopened.appendOutput({
				expectedRevision: reopenedRevision,
				entry: "secret rotation-secret after reopen",
			});
			expect(await readFile(reopened.paths.events, "utf8")).not.toContain("secret");
			expect(await readFile(reopened.paths.events, "utf8")).not.toContain("rotation-secret");
			const manifest = JSON.parse(await readFile(join(projection.publicRoot, ".publication.json"), "utf8")) as {
				files: { pane: string; events: string };
			};
			expect(manifest.files.pane).toBe(
				createHash("sha256")
					.update(await readFile(reopened.paths.pane))
					.digest("hex"),
			);
			expect(manifest.files.events).toBe(
				createHash("sha256")
					.update(await readFile(reopened.paths.events))
					.digest("hex"),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}, 15_000);
it("recovers a committed projection before publishing a redaction manifest", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projection-redaction-order-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		const originalRename = fs.rename;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (destination === join(projection.publicRoot, "pane.log"))
				throw Object.assign(new Error("injected pending projection publication failure"), { code: "EIO" });
			await originalRename(source, destination);
		});
		try {
			await expect(owner.appendOutput({ expectedRevision: 0, entry: "secret" })).rejects.toThrow(
				"injected pending projection publication failure",
			);
		} finally {
			rename.mockRestore();
		}
		await owner.addRedactions(["secret"]);
		const manifest = JSON.parse(await readFile(owner.paths.publication, "utf8")) as {
			files: { pane: string | null };
		};
		expect(manifest.files.pane).toBe(
			createHash("sha256")
				.update(await readFile(owner.paths.pane))
				.digest("hex"),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("makes a successful projected redaction rebase immediately readable as schema 2", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-redaction-reader-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "C:\\bin\\gjc.exe",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		await owner.appendOutput({ expectedRevision: 0, entry: "sec" });
		await owner.appendEvent({ expectedRevision: 1, entry: "sec" });
		await owner.addRedactions(["secret"]);
		expect(await readFile(owner.paths.events, "utf8")).not.toContain("secret");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("rejects a projected redaction aggregate before creating durable transaction state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-redaction-aggregate-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "C:\\bin\\gjc.exe",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		await expect(
			owner.addRedactions(Array.from({ length: 128 }, (_, index) => `aggregate-secret-${index}`)),
		).rejects.toThrow("redaction update is invalid");
		await expect(readFile(join(projection.privateRoot, ".log-redactions.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(projection.privateRoot, ".redaction-publication.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("merges current log-only redactions into a reopened projected publication", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-redaction-merge-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "C:\\bin\\gjc.exe",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	const rotationSecret = "rotation-log-secret";
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		await owner.appendOutput({ expectedRevision: 0, entry: rotationSecret });
		const rotatedIdentity: VisibleSessionRoleIdentity = {
			...identity,
			logRedactions: [rotationSecret],
		};
		const reopened = new VisibleSessionStateOwner(projection, rotatedIdentity);
		await reopened.initialize();
		await reopened.appendOutput({ ...(await write(reopened)), entry: rotationSecret });
		expect(await readFile(reopened.paths.pane, "utf8")).not.toContain(rotationSecret);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("recovers projected redactions when private logs are just over the 64 KiB cap", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-overcap-redaction-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		const privatePaths = visibleSessionStatePaths(projection.privateRoot);
		const secret = "rotation-secret";
		const filler = "x".repeat(MAX_PUBLIC_TEXT_BYTES - 1);

		while ((await fileSizeOrZero(privatePaths.pane)) <= DEFAULT_PUBLIC_LOG_CAP_BYTES) {
			await owner.appendOutput({
				...(await write(owner)),
				entry: filler,
				capBytes: MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
			});
		}
		await owner.appendOutput({
			...(await write(owner)),
			entry: secret,
			capBytes: MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
		});

		expect(await fileSizeOrZero(privatePaths.pane)).toBeGreaterThan(DEFAULT_PUBLIC_LOG_CAP_BYTES);

		await expect(owner.addRedactions([secret])).resolves.toBeUndefined();

		expect(await readFile(owner.paths.pane, "utf8")).not.toContain(secret);
		expect(await readFile(privatePaths.pane, "utf8")).not.toContain(secret);
		expect(await fileSizeOrZero(privatePaths.pane)).toBeLessThanOrEqual(DEFAULT_PUBLIC_LOG_CAP_BYTES);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("replays rotated log-redaction identities across projected reopen with oversized private logs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-redaction-rotation-reopen-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	const rotationSecret = "rotation-log-secret";
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		const privatePaths = visibleSessionStatePaths(projection.privateRoot);
		const filler = "x".repeat(MAX_PUBLIC_TEXT_BYTES - 1);
		while ((await fileSizeOrZero(privatePaths.pane)) <= DEFAULT_PUBLIC_LOG_CAP_BYTES) {
			await owner.appendOutput({
				...(await write(owner)),
				entry: filler,
				capBytes: MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
			});
		}
		await owner.appendEvent({
			...(await write(owner)),
			entry: rotationSecret,
			capBytes: MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
		});

		const rotated = new VisibleSessionStateOwner(projection, { ...identity, logRedactions: [rotationSecret] });
		await rotated.initialize();

		expect(await readFile(privatePaths.events, "utf8")).not.toContain(rotationSecret);

		await rotated.appendOutput({
			...(await write(rotated)),
			entry: rotationSecret,
			capBytes: MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
		});
		expect(await readFile(rotated.paths.pane, "utf8")).not.toContain(rotationSecret);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("keeps projected truncation markers UTF-8 safe under collision pressure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-truncation-marker-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	const markerSecret = `${PUBLIC_LOG_TRUNCATION_MARKER}tail`;
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		const privatePaths = visibleSessionStatePaths(projection.privateRoot);
		const filler = "😀".repeat(1024);

		while ((await fileSizeOrZero(privatePaths.pane)) <= DEFAULT_PUBLIC_LOG_CAP_BYTES) {
			await owner.appendOutput({
				...(await write(owner)),
				entry: filler,
				capBytes: MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES,
			});
		}
		await owner.addRedactions([markerSecret]);

		const pane = await readFile(privatePaths.pane, "utf8");
		expect(Buffer.byteLength(pane, "utf8")).toBeLessThanOrEqual(DEFAULT_PUBLIC_LOG_CAP_BYTES);
		expect(pane).not.toContain("�");
		expect(pane).not.toContain(markerSecret);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("fails closed for oversized projected private inputs before redaction", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-private-oversize-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();

		const privatePaths = visibleSessionStatePaths(projection.privateRoot);
		await writeFile(privatePaths.pane, Buffer.alloc(MAX_VISIBLE_SESSION_PUBLIC_FILE_BYTES + 1, "a"));
		await expect(new VisibleSessionStateOwner(projection, identity).initialize()).rejects.toThrow(
			"public file is invalid",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("recovers a projected redaction journal left after manifest advancement", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-redaction-manifest-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "C:\\bin\\gjc.exe",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		await owner.appendOutput({ expectedRevision: 0, entry: "sec" });
		const originalRm = fs.rm;
		let failures = 0;
		const remove = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (file === join(projection.privateRoot, ".redaction-publication.json") && failures++ === 0)
				throw Object.assign(new Error("injected post-manifest cleanup failure"), { code: "EIO" });
			await originalRm(file, options);
		});
		try {
			await expect(owner.addRedactions(["secret"])).rejects.toThrow("injected post-manifest cleanup failure");
		} finally {
			remove.mockRestore();
		}
		const reopened = new VisibleSessionStateOwner(projection, identity);
		await reopened.initialize();
		expect(await readFile(reopened.paths.pane, "utf8")).not.toContain("secret");
		await expect(stat(join(projection.privateRoot, ".redaction-publication.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("reopens a projected generation after a nonzero private revision", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-reopen-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const first = new VisibleSessionStateOwner(projection, identity);
		await first.initialize();
		const originalRename = fs.rename;
		let metadataWrites = 0;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (destination === join(projection.privateRoot, "metadata.json") && ++metadataWrites >= 2)
				throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
			await originalRename(source, destination);
		});
		try {
			await expect(first.updateNormal({ expectedRevision: 0 }, "running")).rejects.toThrow(
				"projection mutation recovery failed",
			);
		} finally {
			rename.mockRestore();
		}
		const reopened = new VisibleSessionStateOwner(projection, identity);
		await expect(reopened.initialize()).resolves.toMatchObject({ revision: 1 });
		await first.updateNormal({ expectedRevision: 1 }, "still running");
		await expect(reopened.updateNormal({ expectedRevision: 2 }, "recovered")).resolves.toBe(3);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("recovers final and vanished projections after the private commit marker write fails", async () => {
	for (const target of ["final", "vanished"] as const) {
		const directory = await mkdtemp(join(tmpdir(), `gjc-visible-projected-${target}-marker-`));
		const projection = {
			publicRoot: join(directory, "public"),
			privateRoot: join(directory, "private"),
			session: "session",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
			gjcBin: "gjc",
			worktreeBaselineDirty: false,
			owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
			backend: "conpty" as const,
		};
		try {
			const owner = new VisibleSessionStateOwner(projection, identity);
			const monitor = new VisibleSessionStateMonitor(projection, identity);
			await owner.initialize();
			const originalRename = fs.rename;
			let markerFailures = 0;
			const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (
					destination === join(projection.privateRoot, ".projection-journal.json") &&
					(JSON.parse(await readFile(source, "utf8")) as { committedRevision: number | null })
						.committedRevision === 1 &&
					markerFailures++ === 0
				)
					throw Object.assign(new Error("injected terminal projection commit-marker failure"), { code: "EIO" });
				await originalRename(source, destination);
			});
			try {
				if (target === "final")
					await expect(owner.commitFinal({ expectedRevision: 0, record: projectedFinalRecord() })).rejects.toThrow(
						"commit-marker failure",
					);
				else
					await expect(
						monitor.commitVanished({ expectedRevision: 0, record: projectedVanishedRecord() }),
					).rejects.toThrow("commit-marker failure");
			} finally {
				rename.mockRestore();
			}
			expect(markerFailures).toBe(1);
			expect(
				(
					JSON.parse(await readFile(join(projection.privateRoot, ".projection-journal.json"), "utf8")) as {
						committedRevision: number | null;
					}
				).committedRevision,
			).toBeNull();
			const reopened = new VisibleSessionStateOwner(projection, identity);
			await expect(reopened.initialize()).resolves.toMatchObject({ revision: 1 });
			expect((await reopened.readMetadata()).revision).toBe(1);
			const reopenedMonitor = new VisibleSessionStateMonitor(projection, identity);
			const terminal = await reopenedMonitor.readTerminal();
			expect(terminal).not.toBeNull();
			expect("ownerExitReason" in (terminal ?? {})).toBe(target === "final");
			expect(await reopenedMonitor.claimCleanup(`cleanup-${target}`)).not.toBeNull();
			await expect(reopenedMonitor.readTerminal()).resolves.not.toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});
it("retains terminal projection evidence after private terminal-record write failures", async () => {
	for (const target of ["final", "vanished"] as const) {
		const directory = await mkdtemp(join(tmpdir(), `gjc-visible-projected-${target}-record-`));
		const projection = {
			publicRoot: join(directory, "public"),
			privateRoot: join(directory, "private"),
			session: "session",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
			gjcBin: "gjc",
			worktreeBaselineDirty: false,
			owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
			backend: "conpty" as const,
		};
		try {
			const owner = new VisibleSessionStateOwner(projection, identity);
			const monitor = new VisibleSessionStateMonitor(projection, identity);
			await owner.initialize();
			const originalRename = fs.rename;
			let failures = 0;
			const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (destination === join(projection.privateRoot, `${target}.json`) && failures++ === 0)
					throw Object.assign(new Error("injected private terminal-record failure"), { code: "EIO" });
				await originalRename(source, destination);
			});
			try {
				if (target === "final")
					await expect(owner.commitFinal({ expectedRevision: 0, record: projectedFinalRecord() })).rejects.toThrow(
						"terminal-record failure",
					);
				else
					await expect(
						monitor.commitVanished({ expectedRevision: 0, record: projectedVanishedRecord() }),
					).rejects.toThrow("terminal-record failure");
			} finally {
				rename.mockRestore();
			}
			expect(failures).toBe(1);
			await expect(fs.stat(join(projection.privateRoot, ".projection-journal.json"))).resolves.toBeDefined();
			const reopened = new VisibleSessionStateOwner(projection, identity);
			await expect(reopened.initialize()).resolves.toMatchObject({ revision: 1 });
			const reopenedMonitor = new VisibleSessionStateMonitor(projection, identity);
			await expect(reopenedMonitor.readTerminal()).resolves.not.toBeNull();
			expect(await reopened.readMetadata()).toMatchObject({ revision: 1 });
			const receipt = await reopenedMonitor.claimCleanup(`cleanup-${target}`);
			expect(receipt).not.toBeNull();
			await reopenedMonitor.ackCleanup(`cleanup-${target}`);
			expect(await reopenedMonitor.claimCleanup(`cleanup-${target}`)).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});
describe("visible session projected state atomic writes", () => {
	it("retries transient Windows sharing violations using the same pane temporary file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-rename-"));
		const publicRoot = join(directory, "public");
		const projection = {
			publicRoot,
			privateRoot: join(directory, "private"),
			session: "session",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
			gjcBin: "C:\\bin\\gjc.exe",
			worktreeBaselineDirty: false,
			owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
			backend: "conpty" as const,
		};
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			const owner = new VisibleSessionStateOwner(projection, identity);
			await owner.initialize();
			const originalRename = fs.rename;
			const sources: string[] = [];
			let attempts = 0;
			const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (destination === owner.paths.pane) {
					attempts += 1;
					if (typeof source === "string") sources.push(source);
					if (attempts < 3) {
						const error = new Error("sharing violation") as NodeJS.ErrnoException;
						error.code = "EPERM";
						throw error;
					}
				}
				await originalRename(source, destination);
			});
			try {
				await owner.appendOutput({ expectedRevision: 0, entry: "safe output" });
				expect(attempts).toBe(3);
				expect(new Set(sources).size).toBe(1);
				expect(await readFile(owner.paths.pane, "utf8")).toBe("safe output");
				expect((await readdir(publicRoot)).some(file => file.startsWith(".pane.log-"))).toBe(false);
			} finally {
				rename.mockRestore();
			}
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("propagates persistent Windows sharing violations and removes the pane temporary file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projected-rename-"));
		const publicRoot = join(directory, "public");
		const projection = {
			publicRoot,
			privateRoot: join(directory, "private"),
			session: "session",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
			gjcBin: "C:\\bin\\gjc.exe",
			worktreeBaselineDirty: false,
			owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
			backend: "conpty" as const,
		};
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			const owner = new VisibleSessionStateOwner(projection, identity);
			await owner.initialize();
			await owner.appendOutput({ expectedRevision: 0, entry: "before" });
			const originalRename = fs.rename;
			let attempts = 0;
			const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
				if (destination === owner.paths.pane) {
					attempts += 1;
					const error = new Error("sharing violation") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				await originalRename(source, destination);
			});
			try {
				await expect(owner.appendOutput({ expectedRevision: 1, entry: "safe output" })).rejects.toMatchObject({
					code: "EACCES",
				});
				expect(attempts).toBe(5);
				expect((await readdir(publicRoot)).some(file => file.startsWith(".pane.log-"))).toBe(false);
				expect(await readFile(owner.paths.pane, "utf8")).toBe("before");
			} finally {
				rename.mockRestore();
			}
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
describe("visible session projection journal receipts", () => {
	it("requires exact private intent bytes in a projected journal", async () => {
		const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projection-journal-"));
		const projection = {
			publicRoot: join(directory, "public"),
			privateRoot: join(directory, "private"),
			session: "session",
			workdir: "C:\\worktree",
			branch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
			gjcBin: "gjc",
			worktreeBaselineDirty: false,
			owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
			backend: "conpty" as const,
		};
		try {
			const owner = new VisibleSessionStateOwner(projection, identity);
			await owner.initialize();
			const journal = {
				target: "runtime",
				content: Buffer.from("{}").toString("base64"),
				expectedRevision: 0,
				committedRevision: null,
				generationId: identity.generationId,
				authority: createHash("sha256")
					.update(`${identity.leaseId}\0${identity.owner.pid}\0${identity.owner.startIdentity}`)
					.digest("hex"),
				files: null,
				operationId: "operation",
				digest: createHash("sha256").update(Buffer.from("{}")).digest("hex"),
			};
			await writeFile(join(projection.privateRoot, ".projection-journal.json"), `${JSON.stringify(journal)}\n`);
			await expect(owner.readMetadata()).rejects.toThrow("projection journal is corrupt");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
it("assigns distinct operation identities to same-value projected normal, runtime, and prompt updates", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-projection-operation-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		const operations: { target: string; expectedRevision: number; operationId: string }[] = [];
		const originalRename = fs.rename;
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (destination === join(projection.privateRoot, ".projection-journal.json")) {
				const journal = JSON.parse(await readFile(source, "utf8")) as {
					target: string;
					expectedRevision: number;
					operationId: string;
				};
				operations.push(journal);
			}
			await originalRename(source, destination);
		});
		try {
			await owner.updateNormal({ expectedRevision: 0 }, "same");
			await owner.updateNormal({ expectedRevision: 1 }, "same");
			const runtime = {
				schemaVersion: 2 as const,
				backend: "conpty" as const,
				generation: identity.generationId,
				generationId: identity.generationId,
				owner: projection.owner,
				summary: "same",
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
			await owner.updateRuntime({ expectedRevision: 2 }, runtime);
			await owner.updateRuntime({ expectedRevision: 3 }, runtime);
			const prompt = {
				schemaVersion: 2 as const,
				backend: "conpty" as const,
				generation: identity.generationId,
				generationId: identity.generationId,
				owner: projection.owner,
				session: projection.session,
				acceptedAt: "now",
				summary: "prompt accepted" as const,
				worktreeBaselineDirty: false,
			};
			await owner.recordPromptAccepted({ expectedRevision: 4 }, prompt);
			await owner.recordPromptAccepted({ expectedRevision: 5 }, prompt);
		} finally {
			rename.mockRestore();
		}
		for (const target of ["metadata", "runtime", "prompt"]) {
			const ids = new Set(
				operations.filter(operation => operation.target === target).map(operation => operation.operationId),
			);
			expect(ids.size).toBe(2);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("keeps secret-bearing terminal retries idempotent against the persisted public record", async () => {
	await withState(async owner => {
		const first = await owner.commitFinal({ ...(await write(owner)), record: finalRecord() });
		const retry = await owner.commitFinal({ expectedRevision: first.revision, record: finalRecord() });
		expect(retry).toMatchObject({ revision: first.revision, idempotent: true });
	});
});
it("keeps secret-bearing vanished retries idempotent against the persisted public record", async () => {
	await withState(async (owner, monitor) => {
		const first = await monitor.commitVanished({ ...(await write(owner)), record: vanishedRecord() });
		const retry = await monitor.commitVanished({ expectedRevision: first.revision, record: vanishedRecord() });
		expect(retry).toMatchObject({ revision: first.revision, idempotent: true });
	});
});
it("rejects log caps above the public reader bound", async () => {
	await withState(async owner => {
		await expect(
			owner.appendOutput({
				...(await write(owner)),
				entry: "bounded",
				capBytes: 128 * 1024 + 1,
			}),
		).rejects.toThrow("log cap is invalid");
	});
});
it("canonicalizes relative projection roots and rejects overlapping aliases", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-relative-roots-"));
	const publicRoot = join(directory, "public");
	const privateRoot = join(directory, "private");
	const projection = {
		publicRoot: relative(process.cwd(), publicRoot),
		privateRoot: relative(process.cwd(), privateRoot),
		session: "session",
		workdir: "C:\\worktree",
		branch: "main",
		createdAt: "2026-01-01T00:00:00.000Z",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 41, startedAt: "2026-01-01T00:00:00.000Z" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		expect(
			() => new VisibleSessionStateOwner({ ...projection, publicRoot: privateRoot, privateRoot }, identity),
		).toThrow("must not overlap");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("rejects malformed projected baseline booleans before publication", () => {
	expect(
		() =>
			new VisibleSessionStateOwner(
				{
					publicRoot: "public",
					privateRoot: "private",
					session: "session",
					workdir: "workdir",
					branch: "main",
					createdAt: "now",
					gjcBin: "gjc",
					worktreeBaselineDirty: "false",
					owner: { pid: 1, startedAt: "now" },
					backend: "conpty",
				} as unknown as VisibleSessionStateProjection,
				identity,
			),
	).toThrow("projection is invalid");
});
it("rejects contradictory projected terminal facts before publication", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-terminal-invariants-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "workdir",
		branch: "main",
		createdAt: "now",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 1, startedAt: "now" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		await expect(
			owner.commitFinal({
				expectedRevision: 0,
				record: {
					...projectedFinalRecord(),
					runtimeTerminal: false,
				},
			}),
		).rejects.toThrow("terminal facts are inconsistent");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("rejects malformed projected runtime booleans before publication", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-runtime-invariants-"));
	const projection = {
		publicRoot: join(directory, "public"),
		privateRoot: join(directory, "private"),
		session: "session",
		workdir: "workdir",
		branch: "main",
		createdAt: "now",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 1, startedAt: "now" },
		backend: "conpty" as const,
	};
	try {
		const owner = new VisibleSessionStateOwner(projection, identity);
		await owner.initialize();
		await expect(
			owner.updateRuntime({ expectedRevision: 0 }, {
				schemaVersion: 2,
				backend: "conpty",
				generation: identity.generationId,
				generationId: identity.generationId,
				owner: projection.owner,
				summary: "running",
				status: "running",
				updatedAt: "now",
				present: "true",
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
			} as unknown as VisibleSessionProjectedRuntime),
		).rejects.toThrow("projected runtime is invalid");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("rejects projection roots that alias through a filesystem reparse point", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gjc-visible-root-alias-"));
	const publicRoot = join(directory, "public");
	const privateRoot = join(directory, "private-alias");
	const projection = {
		publicRoot,
		privateRoot,
		session: "session",
		workdir: "workdir",
		branch: "main",
		createdAt: "now",
		gjcBin: "gjc",
		worktreeBaselineDirty: false,
		owner: { pid: 1, startedAt: "now" },
		backend: "conpty" as const,
	};
	try {
		await fs.mkdir(publicRoot);
		await fs.symlink(publicRoot, privateRoot, process.platform === "win32" ? "junction" : "dir");
		const owner = new VisibleSessionStateOwner(projection, identity);
		await expect(owner.initialize()).rejects.toThrow("must not overlap");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
