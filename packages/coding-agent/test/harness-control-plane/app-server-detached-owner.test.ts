import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readLease } from "../../src/harness-control-plane/session-lease";
import { createHarnessCliEnv, type HarnessCliEnv } from "./cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const fakeAppServer = path.join(import.meta.dir, "fixtures", "fake-app-server.ts");
const SID = "m10-app-server-owner";

let root: string;
let workspace: string;
let tmuxCommand: string;
let tracePath: string;
let cliEnv: HarnessCliEnv;

async function createFakeTmuxBin(rootDir: string): Promise<string> {
	const binDir = path.join(rootDir, ".test-bin");
	const tmuxPath = path.join(binDir, "tmux");
	await mkdir(binDir, { recursive: true });
	await writeFile(
		tmuxPath,
		`#!/usr/bin/env bash
case "$1" in
  new-session)
    cwd="$PWD"
    for ((i=1; i<=$#; i++)); do
      if [ "\${!i}" = "-c" ]; then
        next=$((i + 1))
        cwd="\${!next}"
      fi
    done
    cmd="\${@: -1}"
    (cd "$cwd" && bash -lc "$cmd") >/dev/null 2>&1 &
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
		"utf8",
	);
	await chmod(tmuxPath, 0o755);
	return tmuxPath;
}

async function runHarness(
	args: string[],
): Promise<{ code: number; json: Record<string, unknown> | null; out: string }> {
	const proc = Bun.spawn(["bun", cliEntry, "harness", ...args], {
		cwd: workspace,
		env: {
			...cliEnv.env,
			GJC_HARNESS_STATE_ROOT: root,
			GJC_HARNESS_ADAPTER: "app-server",
			GJC_HARNESS_APP_SERVER_COMMAND: JSON.stringify([
				"/usr/bin/env",
				`GJC_FAKE_APP_SERVER_TRACE=${tracePath}`,
				"bun",
				fakeAppServer,
			]),
			GJC_TMUX_COMMAND: tmuxCommand,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(out.trim()) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { code, json, out };
}

async function traceFrames(): Promise<Array<{ direction: string; frame: Record<string, unknown> }>> {
	const text = await readFile(tracePath, "utf8").catch(() => "");
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { direction: string; frame: Record<string, unknown> });
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "hm10"));
	workspace = await mkdtemp(path.join(tmpdir(), "hm10w"));
	tracePath = path.join(root, "fake-app-server-trace.jsonl");
	cliEnv = createHarnessCliEnv(repoRoot);
	tmuxCommand = await createFakeTmuxBin(root);
});

afterEach(async () => {
	try {
		const lease = await readLease(root, SID);
		if (lease?.pid) {
			try {
				process.kill(lease.pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
	} catch {
		// no lease
	}
	cliEnv.cleanup();
	await rm(root, { recursive: true, force: true });
	await rm(workspace, { recursive: true, force: true });
});

describe("app-server detached owner M10", () => {
	it("routes start/submit/observe/events through a real CLI owner using a deterministic app-server", async () => {
		const started = await runHarness([
			"start",
			"--input",
			JSON.stringify({ sessionId: SID, harness: "gajae-code", workspace, detach: true, goal: "M10 deterministic" }),
		]);
		expect(started.code).toBe(0);
		expect((started.json?.state as Record<string, unknown>).ownerLive).toBe(true);

		let frames = await traceFrames();
		expect(frames.some(f => f.direction === "out" && f.frame.type === "ready")).toBe(true);
		expect(frames.some(f => f.direction === "in" && f.frame.method === "initialize")).toBe(true);
		expect(frames.some(f => f.direction === "in" && f.frame.method === "initialized")).toBe(true);
		expect(frames.some(f => f.direction === "in" && f.frame.method === "thread/start")).toBe(true);
		expect(frames.some(f => f.direction === "out" && Boolean(f.frame.result))).toBe(true);

		const before = await runHarness(["observe", "--session", SID]);
		expect(before.code).toBe(0);
		const beforeObservation = (before.json?.evidence as Record<string, unknown>).observation as Record<
			string,
			unknown
		>;
		expect(beforeObservation.transportLastFrameAt ?? null).toBeNull();
		const beforeEventDump = await runHarness(["events", "--session", SID, "--cursor", "0"]);
		expect(beforeEventDump.code).toBe(0);
		const beforeCursor = (
			((beforeEventDump.json?.evidence as Record<string, unknown>).events as Array<Record<string, unknown>>) ?? []
		)
			.map(row => Number(row.cursor ?? 0))
			.reduce((max, cursor) => Math.max(max, cursor), 0);

		const submitted = await runHarness([
			"submit",
			"--session",
			SID,
			"--input",
			JSON.stringify({ prompt: "M10: emit start, a tool observation, and completion" }),
		]);
		expect(submitted.code).toBe(0);
		expect((submitted.json?.evidence as Record<string, unknown>).accepted).toBe(true);

		let observedSignals: string[] = [];
		let afterObservation: Record<string, unknown> = {};
		for (let i = 0; i < 40; i++) {
			const observed = await runHarness(["observe", "--session", SID]);
			expect(observed.code).toBe(0);
			afterObservation = (observed.json?.evidence as Record<string, unknown>).observation as Record<string, unknown>;
			observedSignals = (afterObservation.observedSignals as string[]) ?? [];
			if (observedSignals.includes("tool-call") && observedSignals.includes("completed")) break;
			await sleep(50);
		}

		frames = await traceFrames();
		expect(frames.some(f => f.direction === "in" && f.frame.method === "turn/start")).toBe(true);
		expect(frames.some(f => f.direction === "out" && f.frame.method === "turn/started")).toBe(true);
		expect(frames.some(f => f.direction === "out" && f.frame.method === "gjc/event")).toBe(true);
		expect(frames.some(f => f.direction === "out" && f.frame.method === "item/started")).toBe(true);
		expect(frames.some(f => f.direction === "out" && f.frame.method === "turn/completed")).toBe(true);

		// Cursor advancement is asserted on durable owner events below.
		expect(afterObservation.transportLastFrameAt).toEqual(expect.any(String));
		expect(observedSignals).toContain("prompt-accepted");
		expect(observedSignals).toContain("tool-call");
		expect(observedSignals).toContain("completed");

		const events = await runHarness(["events", "--session", SID, "--cursor", "0"]);
		expect(events.code).toBe(0);
		const eventRows =
			((events.json?.evidence as Record<string, unknown>).events as Array<Record<string, unknown>>) ?? [];
		const afterCursor = eventRows
			.map(row => Number(row.cursor ?? 0))
			.reduce((max, cursor) => Math.max(max, cursor), 0);
		expect(afterCursor).toBeGreaterThan(beforeCursor);
		const kinds = eventRows.map(row => row.kind);
		expect(kinds).toContain("prompt_accepted");
		expect(kinds).toContain("agent_wire_turn_started");
		expect(kinds).toContain("agent_wire_agent_started");
		expect(kinds).toContain("agent_wire_tool_started");
		expect(kinds).toContain("agent_wire_tool_ended");
		expect(kinds).toContain("agent_wire_agent_completed");
		expect(JSON.stringify(events.json)).not.toContain("SECRET_COMMAND");
		expect(JSON.stringify(events.json)).not.toContain("SECRET_OUTPUT");
		expect(JSON.stringify(events.json)).not.toContain("SECRET_ITEM");

		const retired = await runHarness(["retire", "--session", SID]);
		expect(retired.code).toBe(0);
		expect((retired.json?.evidence as Record<string, unknown>).retired).toBe(true);
	}, 60_000);
});
