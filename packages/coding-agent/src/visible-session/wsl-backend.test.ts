import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { VisibleSessionBackendContext } from "./backend";
import type { VisibleSessionGeneration, VisibleSessionTmuxOwnership, VisibleSessionWslTmuxOwnership } from "./types";
import { VisibleSessionWslBackend, type VisibleSessionWslRun, type VisibleSessionWslRunResult } from "./wsl-backend";

const SUCCESS: VisibleSessionWslRunResult = { exitCode: 0, stdout: "", stderr: "" };
const HOST_ROOT = "C:\\Users\\Rémi\\Visible Sessions\\generation-a";
const LINUX_STATE_FILE = "/mnt/c/Users/Rémi/Visible Sessions/generation-a/runtime-state.json";

function missingFile(): Error & { code: string } {
	return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function absentReceipt(): Promise<string> {
	return Promise.reject(missingFile());
}

function context(
	overrides: Partial<VisibleSessionWslTmuxOwnership> = {},
	privateRoot = HOST_ROOT,
	tmuxOverrides: Partial<VisibleSessionTmuxOwnership> = {},
): VisibleSessionBackendContext {
	const generation: VisibleSessionGeneration = {
		generationId: "generation-a",
		counter: 1,
		status: "active",
		startIdentity: "start-a",
		leaseId: "lease-a",
		publicBaseId: "public-a",
		publicRoot: "C:\\Users\\Rémi\\Visible Sessions\\public\\generation-a",
		privateRoot,
		manifestFilePath: path.win32.join(privateRoot, "manifest.json"),
		createdAt: "2026-01-01T00:00:00.000Z",
		tokenFilePath: path.win32.join(privateRoot, "token"),
		tokenSha256: "hash",
		tmux: {
			socketKey: "socket ünicode",
			sessionName: "owner session ünicode",
			stateFilePath: path.win32.join(privateRoot, "runtime-state.json"),
			ownerGeneration: "generation-a",
			...tmuxOverrides,
		},
		wslTmux: {
			distro: "Ubuntu 24.04",
			linuxStateFilePath: LINUX_STATE_FILE,
			hostVersion: "0.10.1",
			distroVersion: "0.10.99",
			schemaVersion: 1,
			...overrides,
		},
	};
	return {
		entry: {
			name: { displayName: "owner session ünicode", key: "owner-session-unicode" },
			repository: "C:\\repo",
			worktree: "C:\\worktree",
			backend: "wsl-tmux",
			active: generation,
			history: [],
		},
		generation,
	};
}

function ownedRunner(value: VisibleSessionBackendContext, calls: string[][]): VisibleSessionWslRun {
	const wsl = value.generation.wslTmux;
	const tmux = value.generation.tmux;
	if (!wsl || !tmux) throw new Error("test ownership missing");
	const tagValues = new Map<string, string>([
		["@gjc-profile", "1"],
		["@gjc-backend", "wsl-tmux"],
		["@gjc-schema-version", String(wsl.schemaVersion)],
		["@gjc-session-id", tmux.sessionName],
		["@gjc-session-state-file", wsl.linuxStateFilePath],
		["@gjc-owner-generation", tmux.ownerGeneration],
		["@gjc-owner-server-key", tmux.socketKey],
	]);
	return async argv => {
		calls.push([...argv]);
		const tag = argv.at(-1);
		if (argv[4] === "gjc") return { ...SUCCESS, stdout: `gjc/${wsl.distroVersion}\r\n` };
		if (argv[4] === "wslpath") return { ...SUCCESS, stdout: `${wsl.linuxStateFilePath}\n` };
		if (tag && tagValues.has(tag)) return { ...SUCCESS, stdout: `${tagValues.get(tag)}\n` };
		return SUCCESS;
	};
}

function expectedPreparation(value: VisibleSessionBackendContext): string[][] {
	const wsl = value.generation.wslTmux;
	const tmux = value.generation.tmux;
	if (!wsl || !tmux) throw new Error("test ownership missing");
	return [
		["wsl.exe", "-d", wsl.distro, "--exec", "true"],
		["wsl.exe", "-d", wsl.distro, "--exec", "gjc", "--version"],
		["wsl.exe", "-d", wsl.distro, "--exec", "wslpath", "-a", "-u", tmux.stateFilePath],
	];
}

describe("VisibleSessionWslBackend", () => {
	it("uses direct WSL argv with Unicode and spaces, proves exact generation tags, and returns exact attach argv", async () => {
		const value = context();
		const calls: string[][] = [];
		const backend = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			readFile: absentReceipt,
			run: ownedRunner(value, calls),
		});

		expect(await backend.sessionCommand({ context: value, readOnly: true })).toEqual([
			"wsl.exe",
			"-d",
			"Ubuntu 24.04",
			"--exec",
			"tmux",
			"-L",
			"socket ünicode",
			"attach-session",
			"-r",
			"-t",
			"=owner session ünicode:",
		]);
		expect(calls).toEqual([
			...expectedPreparation(value),
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"has-session",
				"-t",
				"=owner session ünicode:",
			],
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"show-options",
				"-t",
				"=owner session ünicode:",
				"-v",
				"@gjc-profile",
			],
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"show-options",
				"-t",
				"=owner session ünicode:",
				"-v",
				"@gjc-backend",
			],
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"show-options",
				"-t",
				"=owner session ünicode:",
				"-v",
				"@gjc-schema-version",
			],
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"show-options",
				"-t",
				"=owner session ünicode:",
				"-v",
				"@gjc-session-id",
			],
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"show-options",
				"-t",
				"=owner session ünicode:",
				"-v",
				"@gjc-session-state-file",
			],
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"show-options",
				"-t",
				"=owner session ünicode:",
				"-v",
				"@gjc-owner-generation",
			],
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"show-options",
				"-t",
				"=owner session ünicode:",
				"-v",
				"@gjc-owner-server-key",
			],
		]);
		expect(calls.every(argv => argv[0] === "wsl.exe" && argv[1] === "-d" && argv[3] === "--exec")).toBe(true);
	});

	it("rejects NUL, newline, and UNC ownership inputs before any WSL fallback can run", async () => {
		const invalidContexts = [
			context({ distro: "Ubuntu\0evil" }),
			context({}, HOST_ROOT, { socketKey: "socket\nnext" }),
			context({}, "\\\\server\\share\\generation-a"),
		];
		for (const value of invalidContexts) {
			const calls: string[][] = [];
			const backend = new VisibleSessionWslBackend({ hostVersion: "0.10.3", run: ownedRunner(value, calls) });
			expect(await backend.probe(value)).toEqual({
				kind: "unavailable",
				backend: "wsl-tmux",
				reason: "wsl_ownership_invalid",
			});
			expect(calls).toEqual([]);
		}
	});

	it("fails closed for untranslatable host paths without invoking tmux or exposing command output", async () => {
		const value = context();
		const calls: string[][] = [];
		const backend = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			readFile: absentReceipt,
			run: async argv => {
				calls.push([...argv]);
				if (argv[4] === "gjc") return { ...SUCCESS, stdout: "gjc/0.10.99\n" };
				return argv[4] === "wslpath"
					? { exitCode: 1, stdout: "private stdout", stderr: "private stderr" }
					: SUCCESS;
			},
		});

		expect(await backend.probe(value)).toEqual({
			kind: "unavailable",
			backend: "wsl-tmux",
			reason: "wsl_path_mismatch",
		});
		expect(calls).toEqual(expectedPreparation(value));
	});

	it("rejects schema and major/minor version mismatches without WSL I/O", async () => {
		for (const [value, reason] of [
			[context({ schemaVersion: 2 }), "wsl_schema_mismatch"],
			[context({ distroVersion: "0.11.0" }), "wsl_version_mismatch"],
			[context({ hostVersion: "0.9.99" }), "wsl_version_mismatch"],
		] as const) {
			const backend = new VisibleSessionWslBackend({
				hostVersion: "0.10.3",
				run: async () => {
					throw new Error("unexpected WSL invocation");
				},
			});
			expect(await backend.probe(value)).toEqual({ kind: "unavailable", backend: "wsl-tmux", reason });
		}
	});
	it("requires an exact compatible distro gjc version handshake before path or tmux proof", async () => {
		const failures: readonly VisibleSessionWslRunResult[] = [
			{ exitCode: 0, stdout: "gjc/0.10\n", stderr: "" },
			{ exitCode: 1, stdout: "gjc/0.10.99\n", stderr: "private error" },
			{ exitCode: 0, stdout: "gjc/0.11.0\n", stderr: "" },
		];
		for (const versionResult of failures) {
			const value = context();
			const calls: string[][] = [];
			const backend = new VisibleSessionWslBackend({
				hostVersion: "0.10.3",
				readFile: absentReceipt,
				run: async argv => {
					calls.push([...argv]);
					return argv[4] === "gjc" ? versionResult : SUCCESS;
				},
			});

			expect(await backend.probe(value)).toEqual({
				kind: "unavailable",
				backend: "wsl-tmux",
				reason: "wsl_version_mismatch",
			});
			expect(calls).toEqual(expectedPreparation(value).slice(0, 2));
		}
	});

	it("does not fall back when the exact tmux target is absent or a tag value differs", async () => {
		const missing = context();
		const missingCalls: string[][] = [];
		const noFallback = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			run: async argv => {
				missingCalls.push([...argv]);
				if (argv.includes("has-session")) return { exitCode: 1, stdout: "secret", stderr: "secret" };
				return ownedRunner(missing, [])(argv);
			},
		});
		expect(await noFallback.sessionCommand({ context: missing })).toEqual({
			kind: "unavailable",
			backend: "wsl-tmux",
			reason: "wsl_tmux_unavailable",
		});
		expect(missingCalls).toEqual([
			...expectedPreparation(missing),
			[
				"wsl.exe",
				"-d",
				"Ubuntu 24.04",
				"--exec",
				"tmux",
				"-L",
				"socket ünicode",
				"has-session",
				"-t",
				"=owner session ünicode:",
			],
		]);

		const tagged = context();
		const tagCalls: string[][] = [];
		const wrongTag = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			readFile: absentReceipt,
			run: async argv => {
				tagCalls.push([...argv]);
				if (argv.at(-1) === "@gjc-schema-version") return { ...SUCCESS, stdout: "2\n" };
				return ownedRunner(tagged, [])(argv);
			},
		});
		expect(await wrongTag.probe(tagged)).toEqual({
			kind: "unavailable",
			backend: "wsl-tmux",
			reason: "wsl_tags_invalid",
		});
		expect(tagCalls.at(-1)).toEqual([
			"wsl.exe",
			"-d",
			"Ubuntu 24.04",
			"--exec",
			"tmux",
			"-L",
			"socket ünicode",
			"show-options",
			"-t",
			"=owner session ünicode:",
			"-v",
			"@gjc-schema-version",
		]);
	});

	it("preserves V5 final and vanished terminal receipts and fails closed on conflicts", async () => {
		for (const [exitCode, status] of [
			[0, "completed"],
			[37, "failed"],
		] as const) {
			const value = context();
			const calls: string[][] = [];
			const backend = new VisibleSessionWslBackend({
				hostVersion: "0.10.3",
				run: ownedRunner(value, calls),
				readFile: async file =>
					path.win32.basename(file) === "final.json"
						? JSON.stringify({ session: "owner session ünicode", exit_code: exitCode })
						: absentReceipt(),
			});
			expect(await backend.probe(value)).toEqual({ kind: "terminal", backend: "wsl-tmux", status });
			expect(calls).toEqual([]);
		}

		const vanishedValue = context();
		const vanishedCalls: string[][] = [];
		const vanished = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			run: ownedRunner(vanishedValue, vanishedCalls),
			readFile: async file =>
				path.win32.basename(file) === "vanished.json"
					? JSON.stringify({ session: "owner session ünicode" })
					: absentReceipt(),
		});
		expect(await vanished.probe(vanishedValue)).toEqual({
			kind: "terminal",
			backend: "wsl-tmux",
			status: "vanished",
		});
		expect(vanishedCalls).toEqual([]);
		const conflictValue = context();
		const conflictCalls: string[][] = [];
		const conflict = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			run: ownedRunner(conflictValue, conflictCalls),
			readFile: async file =>
				path.win32.basename(file) === "final.json"
					? JSON.stringify({ session: "owner session ünicode", exit_code: 0 })
					: JSON.stringify({ session: "owner session ünicode" }),
		});
		expect(await conflict.probe(conflictValue)).toEqual({
			kind: "unavailable",
			backend: "wsl-tmux",
			reason: "wsl_terminal_conflict",
		});
		expect(conflictCalls).toEqual([]);
		const invalidValue = context();
		const invalidCalls: string[][] = [];
		const invalid = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			run: ownedRunner(invalidValue, invalidCalls),
			readFile: async file =>
				path.win32.basename(file) === "final.json"
					? JSON.stringify({ session: "other session", exit_code: 0 })
					: absentReceipt(),
		});
		expect(await invalid.probe(invalidValue)).toEqual({
			kind: "unavailable",
			backend: "wsl-tmux",
			reason: "wsl_terminal_receipt_invalid",
		});
		expect(invalidCalls).toEqual([]);
	});

	it("caps captured output and keeps unsupported cancellation at zero I/O", async () => {
		const value = context();
		const overflowCalls: string[][] = [];
		const overflow = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			readFile: absentReceipt,
			run: async argv => {
				overflowCalls.push([...argv]);
				return { exitCode: 0, stdout: "x".repeat(64 * 1024 + 1), stderr: "" };
			},
		});
		expect(await overflow.probe(value)).toEqual({
			kind: "unavailable",
			backend: "wsl-tmux",
			reason: "wsl_unavailable",
		});
		expect(overflowCalls).toEqual([["wsl.exe", "-d", "Ubuntu 24.04", "--exec", "true"]]);

		let runCalls = 0;
		let readCalls = 0;
		const cancel = new VisibleSessionWslBackend({
			hostVersion: "0.10.3",
			run: async () => {
				runCalls += 1;
				return SUCCESS;
			},
			readFile: async () => {
				readCalls += 1;
				return "";
			},
		});
		expect(await cancel.cancel(value)).toEqual({
			kind: "unavailable",
			backend: "wsl-tmux",
			reason: "cancel_unsupported",
		});
		expect(runCalls).toBe(0);
		expect(readCalls).toBe(0);
	});
});
