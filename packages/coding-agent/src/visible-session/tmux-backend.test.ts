import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { VisibleSessionBackendContext } from "./backend";
import {
	VisibleSessionTmuxBackend,
	type VisibleSessionTmuxSpawn,
	type VisibleSessionTmuxSpawnResult,
} from "./tmux-backend";
import type { VisibleSessionTmuxOwnership } from "./types";

const SUCCESS: VisibleSessionTmuxSpawnResult = { exitCode: 0, stdout: "", stderr: "" };

function missingFile(): Error & { code: string } {
	return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function context(overrides: Partial<VisibleSessionTmuxOwnership> = {}): VisibleSessionBackendContext {
	const privateRoot = path.join(process.cwd(), "tmux-backend-tests", "generation-a");
	const generation = {
		generationId: "generation-a",
		counter: 1,
		status: "active" as const,
		startIdentity: "start-a",
		leaseId: "lease-a",
		publicBaseId: "public-a",
		publicRoot: path.join(process.cwd(), "tmux-backend-tests", "public", "generation-a"),
		privateRoot,
		manifestFilePath: path.join(privateRoot, "manifest.json"),
		createdAt: "2026-01-01T00:00:00.000Z",
		tokenFilePath: path.join(privateRoot, "token"),
		tokenSha256: "hash",
		tmux: {
			socketKey: "socket-a",
			sessionName: "owner-session-a",
			stateFilePath: path.join(privateRoot, "runtime-state.json"),
			ownerGeneration: "generation-a",
			...overrides,
		},
	};
	return {
		entry: {
			name: { displayName: "owner-session-a", key: "owner-session-a" },
			repository: path.join(process.cwd(), "repo"),
			worktree: path.join(process.cwd(), "worktree"),
			backend: "tmux",
			active: generation,
			history: [],
		},
		generation,
	};
}

function ownedSpawn(context: VisibleSessionBackendContext, calls: string[][]): VisibleSessionTmuxSpawn {
	const ownership = context.generation.tmux;
	if (!ownership) throw new Error("test ownership missing");
	const values = new Map<string, string>([
		["@gjc-profile", "1"],
		["@gjc-session-id", ownership.sessionName],
		["@gjc-session-state-file", ownership.stateFilePath],
		["@gjc-owner-generation", ownership.ownerGeneration],
		["@gjc-owner-server-key", ownership.socketKey],
	]);
	return async argv => {
		calls.push([...argv]);
		const tag = argv.at(-1);
		return tag && values.has(tag) ? { ...SUCCESS, stdout: `${values.get(tag)}\n` } : SUCCESS;
	};
}

function noTerminalReceipts(): Promise<string> {
	return Promise.reject(missingFile());
}

describe("VisibleSessionTmuxBackend", () => {
	it("uses injected direct argv spawning to prove all five tags and returns an exact read-only attach argv", async () => {
		const value = context();
		const calls: string[][] = [];
		const backend = new VisibleSessionTmuxBackend({ spawn: ownedSpawn(value, calls) });

		expect(await backend.sessionCommand({ context: value, readOnly: true })).toEqual([
			"tmux",
			"-L",
			"socket-a",
			"attach-session",
			"-r",
			"-t",
			"=owner-session-a:",
		]);
		expect(calls).toEqual([
			["tmux", "-L", "socket-a", "has-session", "-t", "=owner-session-a:"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-profile"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-session-id"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-session-state-file"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-owner-generation"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-owner-server-key"],
		]);
	});

	it("fails closed for local generation/path ownership and remote tag conflicts without a fallback", async () => {
		const invalid = context({ ownerGeneration: "other-generation" });
		const localCalls: string[][] = [];
		const local = new VisibleSessionTmuxBackend({ spawn: ownedSpawn(invalid, localCalls) });
		expect(await local.probe(invalid)).toEqual({
			kind: "unavailable",
			backend: "tmux",
			reason: "tmux_ownership_invalid",
		});
		expect(localCalls).toEqual([]);

		const value = context();
		const tagCalls: string[][] = [];
		const mismatch = new VisibleSessionTmuxBackend({
			spawn: async argv => {
				tagCalls.push([...argv]);
				return argv.includes("@gjc-profile") ? { ...SUCCESS, stdout: "not-gjc\n" } : SUCCESS;
			},
		});
		expect(await mismatch.probe(value)).toEqual({
			kind: "unavailable",
			backend: "tmux",
			reason: "tmux_tags_invalid",
		});
		expect(tagCalls).toEqual([
			["tmux", "-L", "socket-a", "has-session", "-t", "=owner-session-a:"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-profile"],
		]);
	});

	it("returns a stable unavailable result for a missing tmux session without exposing subprocess output", async () => {
		const value = context();
		const calls: string[][] = [];
		const backend = new VisibleSessionTmuxBackend({
			spawn: async argv => {
				calls.push([...argv]);
				return { exitCode: 1, stdout: "secret-output", stderr: "secret-error" };
			},
		});

		expect(await backend.probe(value)).toEqual({
			kind: "unavailable",
			backend: "tmux",
			reason: "tmux_session_unavailable",
		});
		expect(calls).toEqual([["tmux", "-L", "socket-a", "has-session", "-t", "=owner-session-a:"]]);
	});

	it("maps validated final and vanished receipts before reporting the owned tmux session as running", async () => {
		for (const [exitCode, status] of [
			[0, "completed"],
			[37, "failed"],
		] as const) {
			const value = context();
			const reads: string[] = [];
			const calls: string[][] = [];
			const backend = new VisibleSessionTmuxBackend({
				spawn: ownedSpawn(value, calls),
				readFile: async file => {
					reads.push(file);
					if (path.basename(file) === "final.json")
						return JSON.stringify({ session: "owner-session-a", exit_code: exitCode });
					return noTerminalReceipts();
				},
			});

			expect(await backend.probe(value)).toEqual({ kind: "terminal", backend: "tmux", status });
			expect(reads).toEqual([
				path.join(value.generation.privateRoot, "final.json"),
				path.join(value.generation.privateRoot, "vanished.json"),
			]);
			expect(calls).toEqual([]);
		}
		const value = context();
		const vanishedCalls: string[][] = [];
		const vanished = new VisibleSessionTmuxBackend({
			spawn: ownedSpawn(value, vanishedCalls),
			readFile: async file =>
				path.basename(file) === "vanished.json"
					? JSON.stringify({ session: "owner-session-a" })
					: noTerminalReceipts(),
		});
		expect(await vanished.probe(value)).toEqual({ kind: "terminal", backend: "tmux", status: "vanished" });
		expect(vanishedCalls).toEqual([]);

		const runningCalls: string[][] = [];
		const running = new VisibleSessionTmuxBackend({
			spawn: ownedSpawn(value, runningCalls),
			readFile: noTerminalReceipts,
		});
		expect(await running.probe(value)).toEqual({ kind: "running", backend: "tmux" });
		expect(runningCalls).toEqual([
			["tmux", "-L", "socket-a", "has-session", "-t", "=owner-session-a:"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-profile"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-session-id"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-session-state-file"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-owner-generation"],
			["tmux", "-L", "socket-a", "show-options", "-t", "=owner-session-a:", "-v", "@gjc-owner-server-key"],
		]);
	});

	it("rejects cross-session terminal receipts and conflicting final and vanished markers", async () => {
		const value = context();
		const crossSessionCalls: string[][] = [];
		const crossSession = new VisibleSessionTmuxBackend({
			spawn: ownedSpawn(value, crossSessionCalls),
			readFile: async file =>
				path.basename(file) === "final.json"
					? JSON.stringify({ session: "other-session", exit_code: 0 })
					: noTerminalReceipts(),
		});
		expect(await crossSession.probe(value)).toEqual({
			kind: "unavailable",
			backend: "tmux",
			reason: "tmux_terminal_receipt_invalid",
		});
		expect(crossSessionCalls).toEqual([]);

		const conflictCalls: string[][] = [];
		const conflict = new VisibleSessionTmuxBackend({
			spawn: ownedSpawn(value, conflictCalls),
			readFile: async file =>
				path.basename(file) === "final.json"
					? JSON.stringify({ session: "owner-session-a", exit_code: 0 })
					: JSON.stringify({ session: "owner-session-a" }),
		});
		expect(await conflict.probe(value)).toEqual({
			kind: "unavailable",
			backend: "tmux",
			reason: "tmux_terminal_conflict",
		});
		expect(conflictCalls).toEqual([]);
	});

	it("does not spawn or read files when cancellation is unsupported", async () => {
		const value = context();
		const backend = new VisibleSessionTmuxBackend({
			spawn: async () => {
				throw new Error("unexpected subprocess");
			},
			readFile: async () => {
				throw new Error("unexpected file read");
			},
		});

		expect(await backend.cancel(value)).toEqual({
			kind: "unavailable",
			backend: "tmux",
			reason: "cancel_unsupported",
		});
	});
});
