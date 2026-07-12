import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runVisibleSessionDedicatedRoleMain } from "../cli";
import {
	classifyVisibleSessionInternalCommand,
	isVisibleSessionInternalFastPath,
	parseVisibleSessionInternalCommand,
	runVisibleSessionInternalCommand,
	runVisibleSessionInternalCommandIfReserved,
} from "./internal-command";

const manifestPath = path.join(path.parse(process.cwd()).root, "private manifests", "owner ;$()[]& manifest.json");
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const internalCommandEntry = path.join(
	repoRoot,
	"packages",
	"coding-agent",
	"src",
	"visible-session",
	"internal-command.ts",
);
const CHILD_TIMEOUT_MS = 5_000;

interface CliChildResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

let childFixtureRoot: string | undefined;
let childFixturePath: string | undefined;
let ordinaryChildFixturePath: string | undefined;

async function readChildStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function runCliChild(
	argv: readonly string[],
	options: { preload?: string; outcome?: "success" | "nonzero" | "throw" } = {},
): Promise<CliChildResult> {
	const child = Bun.spawn(
		[process.execPath, ...(options.preload ? ["--preload", options.preload] : []), cliEntry, ...argv],
		{
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_NO_TITLE: "1",
				...(options.outcome ? { GJC_VISIBLE_SESSION_CHILD_OUTCOME: options.outcome } : {}),
			},
		},
	);
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		child.kill();
		timeout.reject(new Error(`CLI child exceeded ${CHILD_TIMEOUT_MS}ms`));
	}, CHILD_TIMEOUT_MS);
	try {
		const [stdout, stderr, exitCode] = await Promise.race([
			Promise.all([
				readChildStream(child.stdout as ReadableStream<Uint8Array>),
				readChildStream(child.stderr as ReadableStream<Uint8Array>),
				child.exited,
			]),
			timeout.promise,
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

beforeAll(async () => {
	childFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-visible-session-cli-"));
	childFixturePath = path.join(childFixtureRoot, "dedicated-role-fixture.js");
	await fs.writeFile(
		childFixturePath,
		`import { mock } from "bun:test";

mock.module(${JSON.stringify(internalCommandEntry)}, () => ({
	isVisibleSessionInternalFastPath: argv =>
		argv[0] === "visible-session" && (argv[1] === "owner-internal" || argv[1] === "monitor-internal"),
	runVisibleSessionInternalCommandIfReserved: async argv => {
		if (argv[0] !== "visible-session" || (argv[1] !== "owner-internal" && argv[1] !== "monitor-internal"))
			return false;
		process.stdout.write("fixture:teardown:" + argv[1] + "\\n");
		const outcome = process.env.GJC_VISIBLE_SESSION_CHILD_OUTCOME ?? "success";
		if (outcome === "throw") throw new Error("fixture dedicated role failure");
		if (outcome === "nonzero") process.exitCode = 7;
		return true;
	},
}));

const exit = process.exit.bind(process);
process.exit = exitCode => {
	process.stdout.write("fixture:exit:" + String(exitCode ?? 0) + "\\n");
	return exit(exitCode);
};
`,
		"utf8",
	);
	ordinaryChildFixturePath = path.join(childFixtureRoot, "ordinary-entrypoint-fixture.js");
	await fs.writeFile(
		ordinaryChildFixturePath,
		`const exit = process.exit.bind(process);
process.exit = exitCode => {
	process.stdout.write("fixture:exit:" + String(exitCode ?? 0) + "\\n");
	return exit(exitCode);
};
`,
		"utf8",
	);
});

afterAll(async () => {
	if (childFixtureRoot) await fs.rm(childFixtureRoot, { recursive: true, force: true });
	childFixtureRoot = undefined;
	childFixturePath = undefined;
	ordinaryChildFixturePath = undefined;
});

describe("visible-session internal command", () => {
	it("dispatches the exact owner role once without changing its manifest path", async () => {
		let ownerCalls = 0;
		let monitorCalls = 0;
		let receivedManifestPath: string | undefined;
		const argv = ["visible-session", "owner-internal", "--manifest", manifestPath];

		expect(parseVisibleSessionInternalCommand(argv)).toEqual({ role: "owner-internal", manifestPath });
		expect(isVisibleSessionInternalFastPath(argv)).toBe(true);
		await runVisibleSessionInternalCommand(argv, {
			runOwner: async file => {
				ownerCalls += 1;
				receivedManifestPath = file;
			},
			runMonitor: async () => {
				monitorCalls += 1;
			},
		});

		expect(ownerCalls).toBe(1);
		expect(monitorCalls).toBe(0);
		expect(receivedManifestPath).toBe(manifestPath);
	});

	it("dispatches the exact monitor role once without changing its manifest path", async () => {
		let ownerCalls = 0;
		let monitorCalls = 0;
		let receivedManifestPath: string | undefined;
		const argv = ["visible-session", "monitor-internal", "--manifest", manifestPath];

		expect(parseVisibleSessionInternalCommand(argv)).toEqual({ role: "monitor-internal", manifestPath });
		expect(isVisibleSessionInternalFastPath(argv)).toBe(true);
		await runVisibleSessionInternalCommand(argv, {
			runOwner: async () => {
				ownerCalls += 1;
			},
			runMonitor: async file => {
				monitorCalls += 1;
				receivedManifestPath = file;
			},
		});

		expect(ownerCalls).toBe(0);
		expect(monitorCalls).toBe(1);
		expect(receivedManifestPath).toBe(manifestPath);
	});

	it("rejects malformed reserved intent before generic launch routing", async () => {
		const invalidArgv = [
			["visible-session", "owner-internal", "--manifest", "relative/manifest.json"],
			["visible-session", "owner-internal", "--manifest"],
			["visible-session", "monitor-internal", "--manifest", manifestPath, "--extra"],
			["visible-session", "owner-internal", "--manifest", manifestPath, "--"],
			["visible-session", "other-internal", "--manifest", manifestPath],
		] as const;
		let internalCalls = 0;

		for (const argv of invalidArgv) {
			expect(() => parseVisibleSessionInternalCommand(argv)).toThrow("Invalid visible-session internal command");
			expect(classifyVisibleSessionInternalCommand(argv)).toEqual({ kind: "malformed-reserved" });
			await expect(
				runVisibleSessionInternalCommandIfReserved(argv, async () => {
					internalCalls += 1;
				}),
			).rejects.toThrow("Invalid visible-session internal command");
		}

		expect(internalCalls).toBe(0);
	});

	it("leaves ordinary visible-session input outside the reserved route", async () => {
		const argv = ["visible-session", "owner", "--manifest", manifestPath];
		let internalCalls = 0;
		expect(classifyVisibleSessionInternalCommand(["visible-session"])).toEqual({ kind: "ordinary" });
		expect(classifyVisibleSessionInternalCommand(argv)).toEqual({ kind: "ordinary" });
		expect(isVisibleSessionInternalFastPath(argv)).toBe(false);
		expect(
			await runVisibleSessionInternalCommandIfReserved(argv, async () => {
				internalCalls += 1;
			}),
		).toBe(false);
		expect(internalCalls).toBe(0);
	});

	it("terminates successful dedicated roles only after their teardown", async () => {
		const events: string[] = [];
		const handled = await runVisibleSessionDedicatedRoleMain(
			["visible-session", "owner-internal", "--manifest", manifestPath],
			{
				runCli: async () => {
					events.push("teardown");
				},
				terminate: exitCode => {
					events.push(`exit:${exitCode}`);
				},
				getExitCode: () => 0,
			},
		);

		expect(handled).toBe(true);
		expect(events).toEqual(["teardown", "exit:0"]);
	});

	it("preserves a dedicated role nonzero exit code", async () => {
		const exitCodes: number[] = [];
		await runVisibleSessionDedicatedRoleMain(["visible-session", "monitor-internal", "--manifest", manifestPath], {
			runCli: async () => {},
			terminate: exitCode => {
				exitCodes.push(exitCode);
			},
			getExitCode: () => 7,
		});

		expect(exitCodes).toEqual([7]);
	});

	it("preserves a thrown dedicated role failure without a successful exit", async () => {
		const exitCodes: number[] = [];
		const assignedExitCodes: number[] = [];
		const failure = new Error("role failed");
		await expect(
			runVisibleSessionDedicatedRoleMain(["visible-session", "owner-internal", "--manifest", manifestPath], {
				runCli: async () => {
					throw failure;
				},
				terminate: exitCode => {
					exitCodes.push(exitCode);
				},
				getExitCode: () => 0,
				setExitCode: exitCode => {
					assignedExitCodes.push(exitCode);
				},
			}),
		).rejects.toBe(failure);

		expect(assignedExitCodes).toEqual([1]);
		expect(exitCodes).toEqual([]);
	});
	it("keeps implicit root fast help in parity while explicit commands retain command help", async () => {
		const [longHelp, shortHelp, helpCommand, launchOptionHelp, launchHelp, acpHelp] = await Promise.all([
			runCliChild(["--help"]),
			runCliChild(["-h"]),
			runCliChild(["help"]),
			runCliChild(["--tmux", "--help"]),
			runCliChild(["launch", "--help"]),
			runCliChild(["acp", "--help"]),
		]);

		for (const result of [longHelp, shortHelp, helpCommand, launchOptionHelp]) {
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(longHelp.stdout);
		}

		expect(launchHelp.exitCode, launchHelp.stderr).toBe(0);
		expect(launchHelp.stdout).toContain("$ gjc launch");
		expect(launchHelp.stdout).not.toContain("Environment Variables:");
		expect(acpHelp.exitCode, acpHelp.stderr).toBe(0);
		expect(acpHelp.stdout).toContain("$ gjc acp");
		expect(acpHelp.stdout).not.toContain("Environment Variables:");
	}, 15_000);

	it("terminates owner and monitor subprocess roles only after their fixture teardown", async () => {
		const preload = childFixturePath;
		if (!preload) throw new Error("dedicated role child fixture was not created");

		const owner = await runCliChild(["visible-session", "owner-internal", "--manifest", manifestPath], {
			preload,
		});
		expect(owner.exitCode, owner.stderr).toBe(0);
		expect(owner.stderr).toBe("");
		expect(owner.stdout).toContain("fixture:teardown:owner-internal\nfixture:exit:0\n");

		const monitor = await runCliChild(["visible-session", "monitor-internal", "--manifest", manifestPath], {
			preload,
			outcome: "nonzero",
		});
		expect(monitor.exitCode, monitor.stderr).toBe(7);
		expect(monitor.stderr).toBe("");
		expect(monitor.stdout).toContain("fixture:teardown:monitor-internal\nfixture:exit:7\n");
	}, 15_000);

	it("preserves a thrown dedicated-role subprocess failure without terminating successfully", async () => {
		const preload = childFixturePath;
		if (!preload) throw new Error("dedicated role child fixture was not created");

		const result = await runCliChild(["visible-session", "owner-internal", "--manifest", manifestPath], {
			preload,
			outcome: "throw",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("fixture:teardown:owner-internal\n");
		expect(result.stdout).not.toContain("fixture:exit:0");
		expect(`${result.stdout}\n${result.stderr}`).toContain("fixture dedicated role failure");
	}, 10_000);

	it("routes ordinary visible-session input through the public command without dedicated-role termination", async () => {
		const preload = ordinaryChildFixturePath;
		if (!preload) throw new Error("ordinary entrypoint child fixture was not created");

		const result = await runCliChild(["visible-session", "owner", "--manifest", manifestPath, "--version"], {
			preload,
		});

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe("INVALID_INPUT: Invalid command input.\n");
		expect(result.stdout).toBe("");
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("fixture:exit:");
	});
});
