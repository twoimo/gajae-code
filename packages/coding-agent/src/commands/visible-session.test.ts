import { describe, expect, it } from "bun:test";
import type { Settings } from "../config/settings";
import {
	VisibleSessionCommandError,
	type VisibleSessionCommandService,
	type VisibleSessionPromptSource,
	type VisibleSessionStatusReceipt,
} from "../visible-session/command-service";
import type { VisibleSessionRegistry } from "../visible-session/registry";
import type { VisibleSessionRegistryEntry } from "../visible-session/types";
import {
	runVisibleSessionCommand,
	type VisibleSessionCommandDependencies,
	type VisibleSessionCommandEnvironment,
	type VisibleSessionCommandIo,
} from "./visible-session";

interface Outputs {
	stdout: string[];
	stderr: string[];
}

interface Calls {
	create: number;
	prompt: number;
	tail: Array<{ bytes: number; lines: number }>;
	status: number;
	attach: number;
	monitor: number;
	cancel: number;
	recreate: number;
	sessionCommand: number;
	spawn: readonly string[][];
	resolveWorktree: number;
	registryRead: number;
	promptSource: VisibleSessionPromptSource | undefined;
}

interface FakeService {
	create(
		input: unknown,
	): Promise<{ generationId: string; backend: string; publicRoot: string; ownerPid: number; monitorPid: number }>;
	prompt(
		name: string,
		source: VisibleSessionPromptSource,
	): Promise<{ source: "literal" | "file"; byteLength: number }>;
	tail(
		name: string,
		options: { bytes: number; lines: number },
	): Promise<{ text: string; lines: number; truncated: boolean }>;
	status(name: string): Promise<VisibleSessionStatusReceipt>;
	attach(input: { name: string; readOnly?: boolean }): Promise<unknown>;
	monitor(name: string): Promise<VisibleSessionStatusReceipt>;
	cancel(name: string): Promise<{ cancelled: boolean; phase: "terminal" | "stale" | "live" }>;
	recreate(
		input: unknown,
	): Promise<{ generationId: string; backend: string; publicRoot: string; ownerPid: number; monitorPid: number }>;
	sessionCommand(name: string, options: { readOnly?: boolean }): Promise<readonly string[]>;
}

interface HarnessOptions {
	backend?: "conpty" | "tmux" | "wsl-tmux";
	entryName?: string;
	env?: VisibleSessionCommandEnvironment;
	platform?: NodeJS.Platform;
	settingBackend?: "auto" | "conpty" | "tmux";
	notFound?: boolean;
	registryFails?: boolean;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
}

interface Harness {
	dependencies: Partial<VisibleSessionCommandDependencies>;
	outputs: Outputs;
	calls: Calls;
	service: FakeService;
}

function entry(name = "alpha", backend: "conpty" | "tmux" | "wsl-tmux" = "conpty"): VisibleSessionRegistryEntry {
	return {
		name: { displayName: name, key: name.toLowerCase() },
		repository: "/repo",
		worktree: "/worktree",
		backend,
		active: {
			generationId: "1-0123456789abcdef01234567",
			counter: 1,
			status: "active",
			startIdentity: "start",
			leaseId: "a".repeat(32),
			publicBaseId: "default",
			publicRoot: "/public/alpha/1",
			privateRoot: "/private/alpha/1",
			manifestFilePath: "/private/alpha/1/manifest.json",
			createdAt: "2026-01-01T00:00:00.000Z",
			tokenFilePath: "/private/alpha/1/control-token",
			tokenSha256: "b".repeat(64),
			tmux:
				backend === "tmux"
					? {
							socketKey: "gjc-alpha",
							sessionName: "gjc-alpha",
							stateFilePath: "/private/alpha/1/tmux-state.json",
							ownerGeneration: "owner-1",
						}
					: undefined,
		},
		history: [],
	};
}

function statusReceipt(name = "alpha"): VisibleSessionStatusReceipt {
	return {
		name,
		revision: 7,
		generationId: "1-0123456789abcdef01234567",
		phase: "running",
		terminal: null,
		recreatable: false,
	};
}

function createHarness(options: HarnessOptions = {}): Harness {
	const outputs: Outputs = { stdout: [], stderr: [] };
	const calls: Calls = {
		create: 0,
		prompt: 0,
		tail: [],
		status: 0,
		attach: 0,
		monitor: 0,
		cancel: 0,
		recreate: 0,
		sessionCommand: 0,
		spawn: [],
		resolveWorktree: 0,
		registryRead: 0,
		promptSource: undefined,
	};
	const io: VisibleSessionCommandIo = {
		stdout: bytes => outputs.stdout.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)),
		stderr: text => outputs.stderr.push(text),
		stdinIsTTY: () => options.stdinIsTTY ?? true,
		stdoutIsTTY: () => options.stdoutIsTTY ?? true,
	};
	const service: FakeService = {
		create: async () => {
			calls.create += 1;
			return {
				generationId: "2-fedcba9876543210fedcba98",
				backend: "conpty",
				publicRoot: "/public/alpha/2",
				ownerPid: 10,
				monitorPid: 11,
			};
		},
		prompt: async (_name, source) => {
			calls.prompt += 1;
			calls.promptSource = source;
			return { source: source.kind, byteLength: source.kind === "literal" ? Buffer.byteLength(source.text) : 1 };
		},
		tail: async (_name, tailOptions) => {
			calls.tail.push(tailOptions);
			return { text: "tail\n", lines: 1, truncated: false };
		},
		status: async name => {
			calls.status += 1;
			return statusReceipt(name);
		},
		attach: async () => {
			calls.attach += 1;
			return {};
		},
		monitor: async name => {
			calls.monitor += 1;
			return statusReceipt(name);
		},
		cancel: async () => {
			calls.cancel += 1;
			return { cancelled: true, phase: "live" };
		},
		recreate: async () => {
			calls.recreate += 1;
			return {
				generationId: "2-fedcba9876543210fedcba98",
				backend: "conpty",
				publicRoot: "/public/alpha/2",
				ownerPid: 10,
				monitorPid: 11,
			};
		},
		sessionCommand: async () => {
			calls.sessionCommand += 1;
			return ["tmux", "-L", "gjc-alpha", "attach-session", "-t", "=gjc-alpha:"];
		},
	};
	const record = entry(options.entryName, options.backend);
	const registry = {
		read: async () => {
			calls.registryRead += 1;
			if (options.registryFails) throw new Error("secret registry /private/visible-sessions");
			return {
				schemaVersion: 1,
				revision: 7,
				nextGenerationCounter: 2,
				managedPublicBases: [],
				entries: options.notFound ? [] : [record],
			};
		},
	} as unknown as VisibleSessionRegistry;
	const settings = {
		get: () => options.settingBackend ?? "auto",
		getAgentDir: () => "/agent",
	} as unknown as Pick<Settings, "get" | "getAgentDir">;
	const dependencies: Partial<VisibleSessionCommandDependencies> = {
		env: options.env ?? {},
		platform: options.platform ?? "win32",
		settings,
		service: service as unknown as VisibleSessionCommandService,
		registry,
		io,
		spawnAttached: async argv => {
			calls.spawn = [...calls.spawn, [...argv]];
			return 0;
		},
		resolveWorktree: async () => {
			calls.resolveWorktree += 1;
			return { repository: "/repo", worktree: "/worktree" };
		},
		executableFor: worktree => ({ executable: "gjc", args: [], cwd: worktree, env: {} }),
		canonicalizeStateDir: async candidate => candidate,
	};
	return { dependencies, outputs, calls, service };
}

async function run(argv: readonly string[], harness: Harness) {
	return runVisibleSessionCommand(argv, harness.dependencies);
}

function errorText(code: string, message: string): string {
	return `${code}: ${message}\n`;
}

describe("visible-session public command", () => {
	it("rejects unknown verbs, misplaced flags, extra positionals, and WSL-only input before service calls", async () => {
		const cases = [
			["unknown"],
			["status", "alpha", "extra"],
			["prompt", "alpha", "text", "--backend", "conpty"],
			["create", "alpha", "/worktree", "--wsl-distro", "Ubuntu"],
			["attach", "alpha", "--json"],
			["tail", "alpha", "--read-only"],
		] as const;
		for (const argv of cases) {
			const harness = createHarness();
			expect(await run(argv, harness)).toEqual({ exitCode: 2 });
			expect(harness.outputs.stderr).toEqual([errorText("INVALID_INPUT", "Invalid command input.")]);
			expect(harness.calls.create + harness.calls.prompt + harness.calls.status + harness.calls.attach).toBe(0);
		}
	});

	it("uses CLI, nonempty environment, settings, then auto backend precedence without fallback", async () => {
		const cases = [
			{
				argv: ["create", "alpha", "/worktree", "--backend", "conpty"],
				env: { GJC_SESSION_BACKEND: "tmux" },
				settingBackend: "tmux" as const,
				platform: "win32" as const,
				exitCode: 0,
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_BACKEND: "conpty" },
				settingBackend: "tmux" as const,
				platform: "win32" as const,
				exitCode: 0,
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_BACKEND: "" },
				settingBackend: "conpty" as const,
				platform: "win32" as const,
				exitCode: 0,
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: {},
				settingBackend: "auto" as const,
				platform: "win32" as const,
				exitCode: 0,
			},
			{
				argv: ["create", "alpha", "/worktree", "--backend", "tmux"],
				env: {},
				settingBackend: "conpty" as const,
				platform: "win32" as const,
				exitCode: 2,
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: {},
				settingBackend: "auto" as const,
				platform: "linux" as const,
				exitCode: 2,
			},
		] as const;
		for (const testCase of cases) {
			const harness = createHarness(testCase);
			expect(await run(testCase.argv, harness)).toEqual({ exitCode: testCase.exitCode });
			expect(harness.calls.create).toBe(testCase.exitCode === 0 ? 1 : 0);
			if (testCase.exitCode === 2) {
				expect(harness.outputs.stderr).toEqual([
					errorText("BACKEND_UNAVAILABLE", "Selected backend is unavailable."),
				]);
				expect(harness.calls.registryRead).toBe(0);
			}
		}
	});

	it("rejects invalid backend input rather than silently selecting a fallback", async () => {
		const harness = createHarness({ env: { GJC_SESSION_BACKEND: "wsl-tmux" } });
		expect(await run(["create", "alpha", "/worktree"], harness)).toEqual({ exitCode: 2 });
		expect(harness.outputs.stderr).toEqual([errorText("INVALID_INPUT", "Invalid command input.")]);
		expect(harness.calls.create).toBe(0);
	});

	it("uses router source groups atomically and enforces router bounds and conflicts before allocation", async () => {
		const cases = [
			{
				argv: ["create", "alpha", "/worktree", "--stale-minutes", "60"],
				env: { GJC_SESSION_STALE_MINUTES: "0" },
				code: "ROUTER_WATCH_UNSUPPORTED",
				message: "Router watch is unsupported for the selected backend.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_ROUTER: "/router" },
				code: "ROUTER_WATCH_UNSUPPORTED",
				message: "Router watch is unsupported for the selected backend.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_SKIP_ROUTER: "false" },
				code: "ROUTER_WATCH_UNSUPPORTED",
				message: "Router watch is unsupported for the selected backend.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_STALE_MINUTES: "60" },
				code: "ROUTER_WATCH_UNSUPPORTED",
				message: "Router watch is unsupported for the selected backend.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_KEYWORDS: "one,two" },
				code: "ROUTER_WATCH_UNSUPPORTED",
				message: "Router watch is unsupported for the selected backend.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_CHANNEL: "ops" },
				code: "ROUTER_WATCH_UNSUPPORTED",
				message: "Router watch is unsupported for the selected backend.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_MENTION: "@oncall" },
				code: "ROUTER_WATCH_UNSUPPORTED",
				message: "Router watch is unsupported for the selected backend.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_SKIP_ROUTER: "maybe" },
				code: "INVALID_ROUTER_OPTION",
				message: "Invalid router option.",
			},
			{
				argv: ["create", "alpha", "/worktree"],
				env: { GJC_SESSION_SKIP_ROUTER: "YES", GJC_SESSION_CHANNEL: "ops" },
				code: "ROUTER_OPTION_CONFLICT",
				message: "Router options conflict.",
			},
			{
				argv: ["create", "alpha", "/worktree", "--keywords", Array.from({ length: 65 }, () => "k").join(",")],
				env: {},
				code: "INVALID_ROUTER_OPTION",
				message: "Invalid router option.",
			},
			{
				argv: ["create", "alpha", "/worktree", "--stale-minutes", "10081"],
				env: {},
				code: "INVALID_ROUTER_OPTION",
				message: "Invalid router option.",
			},
		] as const;
		for (const testCase of cases) {
			const harness = createHarness({ env: testCase.env });
			expect(await run(testCase.argv, harness)).toEqual({ exitCode: 2 });
			expect(harness.outputs.stderr).toEqual([errorText(testCase.code, testCase.message)]);
			expect(harness.calls.create).toBe(0);
			expect(harness.calls.registryRead).toBe(0);
		}

		const unsupportedRouter = createHarness();
		expect(await run(["create", "alpha", "/worktree", "--router", "/missing/router"], unsupportedRouter)).toEqual({
			exitCode: 2,
		});
		expect(unsupportedRouter.outputs.stderr).toEqual([
			errorText("ROUTER_WATCH_UNSUPPORTED", "Router watch is unsupported for the selected backend."),
		]);
		expect(unsupportedRouter.calls.create).toBe(0);
		expect(unsupportedRouter.calls.resolveWorktree).toBe(0);
		expect(unsupportedRouter.calls.registryRead).toBe(0);
	});

	it("parses prompt literals and file forms without sending invalid prompt values", async () => {
		const escaped = createHarness();
		expect(await run(["prompt", "alpha", "@@hello", "--json"], escaped)).toEqual({ exitCode: 0 });
		expect(escaped.calls.promptSource).toEqual({ kind: "literal", text: "@hello" });
		expect(escaped.outputs.stdout).toEqual([
			'{"schemaVersion":1,"ok":true,"command":"prompt","name":"alpha","generationId":"1-0123456789abcdef01234567","backend":"conpty","result":{"accepted":true}}\n',
		]);

		const file = createHarness();
		expect(await run(["prompt", "alpha", "@prompt.txt"], file)).toEqual({ exitCode: 0 });
		expect(file.calls.promptSource).toEqual({ kind: "file", path: "prompt.txt" });

		for (const value of ["@", "bad\0prompt", "\ud800", "x".repeat(21_846)]) {
			const harness = createHarness();
			expect(await run(["prompt", "alpha", value], harness)).toEqual({ exitCode: 2 });
			expect(harness.outputs.stderr).toEqual([errorText("INVALID_INPUT", "Invalid command input.")]);
			expect(harness.calls.prompt).toBe(0);
		}
	});

	it("enforces tail defaults and 1..1000 bounds before public-state reads", async () => {
		for (const [requested, expected] of [
			[undefined, 200],
			["1", 1],
			["1000", 1000],
		] as const) {
			const harness = createHarness();
			const argv = requested === undefined ? ["tail", "alpha"] : ["tail", "alpha", requested];
			expect(await run(argv, harness)).toEqual({ exitCode: 0 });
			expect(harness.calls.tail).toEqual([{ bytes: 16 * 1024, lines: expected }]);
			expect(harness.outputs.stdout).toEqual(["tail\n"]);
		}
		for (const requested of ["0", "1001", "1.0"]) {
			const harness = createHarness();
			expect(await run(["tail", "alpha", requested], harness)).toEqual({ exitCode: 2 });
			expect(harness.outputs.stderr).toEqual([errorText("INVALID_INPUT", "Invalid command input.")]);
			expect(harness.calls.tail).toEqual([]);
		}
	});

	it("emits compact success envelopes and exact text bytes for every non-attach verb", async () => {
		const cases = [
			{
				argv: ["create", "alpha", "/worktree"],
				text: "alpha 2-fedcba9876543210fedcba98 conpty\n",
				command: "create",
			},
			{ argv: ["prompt", "alpha", "hello"], text: "accepted alpha 1-0123456789abcdef01234567\n", command: "prompt" },
			{ argv: ["tail", "alpha"], text: "tail\n", command: "tail" },
			{ argv: ["status", "alpha"], text: "alpha running -\n", command: "status" },
			{ argv: ["monitor", "alpha"], text: "alpha running -\n", command: "monitor" },
			{ argv: ["cancel", "alpha"], text: "cancelled alpha 1-0123456789abcdef01234567\n", command: "cancel" },
			{ argv: ["recreate", "alpha"], text: "alpha 2-fedcba9876543210fedcba98 conpty\n", command: "recreate" },
		] as const;
		for (const testCase of cases) {
			const textHarness = createHarness();
			expect(await run(testCase.argv, textHarness)).toEqual({ exitCode: 0 });
			expect(textHarness.outputs.stdout).toEqual([testCase.text]);
			const jsonHarness = createHarness();
			expect(await run([...testCase.argv, "--json"], jsonHarness)).toEqual({ exitCode: 0 });
			const bytes = jsonHarness.outputs.stdout[0];
			expect(bytes?.endsWith("\n")).toBe(true);
			const envelope = JSON.parse(bytes ?? "") as {
				schemaVersion: number;
				ok: boolean;
				command: string;
				result: unknown;
			};
			expect(envelope.schemaVersion).toBe(1);
			expect(envelope.ok).toBe(true);
			expect(envelope.command).toBe(testCase.command);
		}
	});

	it("maps typed service failures to static, secret-free error envelopes", async () => {
		const cases = [
			{
				command: ["status", "missing", "--json"],
				setup: (harness: Harness) =>
					(harness.dependencies.registry = {
						read: async () => ({
							schemaVersion: 1,
							revision: 1,
							nextGenerationCounter: 0,
							managedPublicBases: [],
							entries: [],
						}),
					} as unknown as VisibleSessionRegistry),
				code: "not_found",
			},
			{
				command: ["create", "alpha", "/worktree", "--json"],
				setup: (harness: Harness) =>
					(harness.service.create = async () => {
						throw new VisibleSessionCommandError("startup_failed");
					}),
				code: "launch_failed",
			},
			{
				command: ["prompt", "alpha", "hello", "--json"],
				setup: (harness: Harness) =>
					(harness.service.prompt = async () => {
						throw new VisibleSessionCommandError("invalid_token");
					}),
				code: "control_failed",
			},
			{
				command: ["prompt", "alpha", "hello", "--json"],
				setup: (harness: Harness) =>
					(harness.service.prompt = async () => {
						throw new Error("secret /private/control-token");
					}),
				code: "control_failed",
			},
			{
				command: ["recreate", "alpha", "--json"],
				setup: (harness: Harness) =>
					(harness.service.recreate = async () => {
						throw new VisibleSessionCommandError("not_recreatable");
					}),
				code: "session_nonterminal",
			},
			{
				command: ["status", "alpha", "--json"],
				setup: (harness: Harness) =>
					(harness.service.status = async () => {
						throw new VisibleSessionCommandError("public_state_unavailable");
					}),
				code: "liveness_uncertain",
			},
		] as const;
		for (const testCase of cases) {
			const harness = createHarness();
			testCase.setup(harness);
			expect(await run(testCase.command, harness)).toEqual({
				exitCode:
					testCase.code === "launch_failed" ||
					testCase.code === "control_failed" ||
					testCase.code === "liveness_uncertain"
						? 1
						: 2,
			});
			const envelope = JSON.parse(harness.outputs.stdout[0] ?? "") as {
				ok: boolean;
				code: string;
				message: string;
				retryable: boolean;
			};
			expect(envelope).toMatchObject({ ok: false, code: testCase.code, retryable: false });
			expect(envelope.message).not.toContain("secret");
			expect(envelope.message).not.toContain("/private");
		}
	});

	it("fails closed for tmux writers but preserves truthful tmux reads and direct argv attach", async () => {
		const create = createHarness({ platform: "win32" });
		expect(await run(["create", "alpha", "/worktree", "--backend", "tmux"], create)).toEqual({ exitCode: 2 });
		expect(create.calls.create).toBe(0);
		expect(create.calls.registryRead).toBe(0);

		const status = createHarness({ backend: "tmux" });
		expect(await run(["status", "alpha"], status)).toEqual({ exitCode: 0 });
		expect(status.outputs.stdout).toEqual(["alpha running -\n"]);
		const tail = createHarness({ backend: "tmux" });
		expect(await run(["tail", "alpha"], tail)).toEqual({ exitCode: 0 });
		expect(tail.outputs.stdout).toEqual(["tail\n"]);
		const monitor = createHarness({ backend: "tmux" });
		expect(await run(["monitor", "alpha"], monitor)).toEqual({ exitCode: 0 });
		expect(monitor.outputs.stdout).toEqual(["alpha running -\n"]);

		const attach = createHarness({ backend: "tmux" });
		expect(await run(["attach", "alpha", "--read-only"], attach)).toEqual({ exitCode: 0 });
		expect(attach.calls.sessionCommand).toBe(1);
		expect(attach.calls.spawn).toEqual([["tmux", "-L", "gjc-alpha", "attach-session", "-t", "=gjc-alpha:"]]);
		expect(attach.outputs.stdout).toEqual([]);
		expect(attach.outputs.stderr).toEqual([]);

		for (const argv of [
			["prompt", "alpha", "hello"],
			["cancel", "alpha"],
			["recreate", "alpha"],
		] as const) {
			const harness = createHarness({ backend: "tmux" });
			expect(await run(argv, harness)).toEqual({ exitCode: 2 });
			expect(harness.outputs.stderr).toEqual([errorText("BACKEND_UNAVAILABLE", "Selected backend is unavailable.")]);
			expect(harness.calls.prompt + harness.calls.cancel + harness.calls.recreate).toBe(0);
		}
	});

	it("guards attach TTYs, leaves successful attach metadata-free, and rejects unavailable stored backends", async () => {
		const noTty = createHarness({ stdinIsTTY: false });
		expect(await run(["attach", "alpha"], noTty)).toEqual({ exitCode: 2 });
		expect(noTty.outputs.stderr).toEqual([errorText("INVALID_INPUT", "Invalid command input.")]);
		expect(noTty.calls.registryRead).toBe(0);

		const conpty = createHarness();
		expect(await run(["attach", "alpha"], conpty)).toEqual({ exitCode: 0 });
		expect(conpty.calls.attach).toBe(1);
		expect(conpty.outputs.stdout).toEqual([]);
		expect(conpty.outputs.stderr).toEqual([]);

		const unavailable = createHarness({ backend: "wsl-tmux" });
		expect(await run(["status", "alpha"], unavailable)).toEqual({ exitCode: 2 });
		expect(unavailable.outputs.stderr).toEqual([
			errorText("BACKEND_UNAVAILABLE", "Selected backend is unavailable."),
		]);
	});

	it("accepts a custom state directory only for create", async () => {
		const harness = createHarness();
		let publicBase: string | undefined;
		harness.dependencies.canonicalizeStateDir = async () => "/canonical/public";
		harness.service.create = async input => {
			publicBase = (input as { publicBase?: string }).publicBase;
			return {
				generationId: "2-fedcba9876543210fedcba98",
				backend: "conpty",
				publicRoot: "/public/alpha/2",
				ownerPid: 10,
				monitorPid: 11,
			};
		};
		expect(await run(["create", "alpha", "/worktree", "--state-dir", "/custom/public"], harness)).toEqual({
			exitCode: 0,
		});
		expect(publicBase).toBe("/canonical/public");
	});
	it("rejects recreate state directories before registry or launch work", async () => {
		const harness = createHarness();
		expect(await run(["recreate", "alpha", "--state-dir", "/custom/public"], harness)).toEqual({ exitCode: 2 });
		expect(harness.outputs.stderr).toEqual([errorText("INVALID_INPUT", "Invalid command input.")]);
		expect(harness.calls.registryRead).toBe(0);
		expect(harness.calls.recreate).toBe(0);
	});
});
