import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { Broker } from "../src/sdk/broker/broker";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { runSdkSessionCli } from "../src/sdk/cli";
import { SdkClient } from "../src/sdk/client";
import { readSdkBrokerDiscovery } from "../src/sdk/client/discovery";
import { createSdkMcpServer } from "../src/sdk/mcp";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
const brokerDirs: string[] = [];

afterEach(async () => {
	for (const process of spawned.splice(0)) {
		if (process.exitCode === null) process.kill("SIGTERM");
		await process.exited;
	}
	for (const agentDir of brokerDirs.splice(0)) await brokerOwnerForTest(agentDir)?.stop();
});

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const result = await read();
		if (result !== undefined) return result;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function incarnation(pid: number): Promise<string> {
	if (process.platform === "linux") {
		const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
		return `linux:${
			stat
				.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/)[19]
		}`;
	}
	const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
	return `darwin:${new TextDecoder().decode(result.stdout).trim().replace(/\s+/g, " ")}`;
}

async function liveLifecycleSession(root: string, agentDir: string, sessionId: string) {
	const stateRoot = path.join(root, ".gjc", "state");
	const request = { operation: "session.create", sessionId, cwd: root, stateRoot } as const;
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "sdk", "session-host-internal"], {
		cwd: root,
		env: {
			...process.env,
			HOME: root,
			GJC_AGENT_DIR: agentDir,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_SESSION_ID: sessionId,
			GJC_LIFECYCLE_REQUEST_ID: "subprocess-proof",
			GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify(request),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	spawned.push(child);
	try {
		const endpoint = await waitFor(async () => {
			try {
				return JSON.parse(await fs.readFile(path.join(stateRoot, "sdk", `${sessionId}.json`), "utf8")) as {
					url: string;
					token: string;
				};
			} catch {
				return undefined;
			}
		}, "session endpoint");
		if (!child.pid) throw new Error("session host has no pid");
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
			JSON.stringify({
				pid: child.pid,
				effectMarker: "subprocess-proof",
				incarnation: await incarnation(child.pid),
			}),
		);
		return { child, endpoint };
	} catch (error) {
		if (child.exitCode === null) child.kill("SIGTERM");
		await child.exited;
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; child exit=${child.exitCode}; stdout=${await new Response(child.stdout).text()}; stderr=${await new Response(child.stderr).text()}`,
		);
	}
}

test("broker rejects an endpoint-only lifecycle child that never authenticates session_ready", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-life-"));
	const stateRoot = path.join(agentDir, "state");
	const fixture = path.join(agentDir, "fixture.js");
	await fs.writeFile(
		fixture,
		`
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=process.env.GJC_STATE_ROOT, id=process.env.GJC_SESSION_ID, agent=process.env.GJC_AGENT_DIR;
fs.mkdirSync(path.join(root,'sdk'),{recursive:true});
fs.writeFileSync(path.join(agent,'fixture.pid'),String(process.pid));
fs.writeFileSync(path.join(agent,'fixture.request.json'),process.env.GJC_SDK_LIFECYCLE_REQUEST);

fs.writeFileSync(path.join(root,'sdk',id+'.json'),JSON.stringify({sessionId:id,pid:process.pid,url:'ws://127.0.0.1:1',token:'fake'}));
const m=fs.statSync(path.join(root,'sdk',id+'.json')).mtimeMs;
const log=path.join(agent,'sdk','sessions','index.jsonl');fs.mkdirSync(path.dirname(log),{recursive:true});const indexSeq=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length+1:1;
const event={type:'host_registered',sessionId:id,locator:{repo:'fixture',stateRoot:root},endpointGeneration:1,pid:process.pid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
event.checksum=crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');fs.appendFileSync(log,JSON.stringify(event)+'\\n');
setInterval(()=>{},1000);
`,
	);
	const previous = process.env.GJC_SDK_SESSION_COMMAND;
	process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const started = Date.now();
		const [first, second] = await Promise.all([
			broker.handleRequest(
				"session.create",
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 100, body: "first", modelPreset: "codex-eco" },
				"create-1",
			),
			broker.handleRequest(
				"session.create",
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 100, body: "second", modelPreset: "codex-eco" },
				"create-2",
			),
		]);
		expect(first).toMatchObject({ ok: false, error: { code: "readiness_timeout" } });
		expect(second).toMatchObject({ ok: false, error: { code: "readiness_timeout" } });
		expect(Date.now() - started).toBeGreaterThanOrEqual(180);
		const fixturePid = Number(await fs.readFile(path.join(agentDir, "fixture.pid"), "utf8"));
		expect(() => process.kill(fixturePid, 0)).toThrow();
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "fixture.request.json"), "utf8"))).toMatchObject({
			cwd: agentDir,
			modelPreset: "codex-eco",
		});
		expect((await fs.readdir(path.join(stateRoot, "sdk"))).filter(name => name.endsWith(".json"))).toEqual([]);
		const listed = await broker.handleRequest("session.list", {});
		expect(listed.ok).toBe(true);
		if (!listed.ok) throw new Error(listed.error.message);
		expect(listed.result).toMatchObject({ sessions: [] });
	} finally {
		await broker.stop();
		process.env.GJC_SDK_SESSION_COMMAND = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 15_000);

test("broker refuses a stale registered PID when no durable effect marker proves ownership", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-stale-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "stale",
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
		});
		expect(await broker.handleRequest("session.close", { sessionId: "stale" }, "stale-close")).toEqual({
			ok: false,
			error: {
				code: "close_refused",
				message: "Session endpoint is unavailable and its durable process identity could not be verified.",
			},
		});
		expect(process.pid).toBeGreaterThan(0);
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker atomically reuses the indexed live owner for distinct resume keys", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-resume-live-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "already-live";
	const sessionPath = path.join(agentDir, "sessions", `${sessionId}.jsonl`);
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, JSON.stringify({ type: "session", id: sessionId }));
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "live-owner-token" }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: root, stateRoot },
			endpointGeneration: 17,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});

		const [first, second] = await Promise.all([
			broker.handleRequest("session.resume", { sessionId, sessionPath, cwd: root }, "resume-first"),
			broker.handleRequest("session.resume", { sessionId, sessionPath, cwd: root }, "resume-second"),
		]);

		for (const resumed of [first, second]) {
			expect(resumed).toMatchObject({
				ok: true,
				result: {
					sessionId,
					endpointGeneration: 17,
					reused: true,
					endpoint: { token: "live-owner-token" },
				},
			});
		}
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ sessionId, endpointGeneration: 17 })] },
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("broker never signals a PID reused after its lifecycle marker was written", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reused-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "reused";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const marker = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "stale" }),
		);
		await fs.writeFile(
			marker,
			JSON.stringify({ pid: process.pid, effectMarker: "old-effect", incarnation: "reused-process-incarnation" }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 7,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs,
		});
		expect(await broker.handleRequest("session.close", { sessionId }, "reused-close")).toEqual({
			ok: false,
			error: {
				code: "close_refused",
				message: "Session endpoint is unavailable and its durable process identity could not be verified.",
			},
		});
		expect(await fs.readFile(endpoint, "utf8")).toContain("stale");
		expect(await fs.readFile(marker, "utf8")).toContain("reused-process-incarnation");
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("broker preserves endpoint and marker when a durably identified child remains unkillable", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-uncertain-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "unkillable";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const marker = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const originalKill = process.kill;
	const broker = new Broker({ agentDir });
	try {
		if (!child.pid) throw new Error("fixture child has no pid");
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: child.pid, url: "ws://127.0.0.1:1", token: "unreachable" }),
		);
		await fs.writeFile(
			marker,
			JSON.stringify({ pid: child.pid, effectMarker: "fixture", incarnation: await incarnation(child.pid) }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 9,
			pid: child.pid,
			endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs,
		});
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) =>
			signal === 0 || signal === undefined ? originalKill(pid, signal) : undefined) as typeof process.kill;
		expect(await broker.handleRequest("session.close", { sessionId }, "unkillable-close")).toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		expect(await fs.readFile(endpoint, "utf8")).toContain("unreachable");
		expect(await fs.readFile(marker, "utf8")).toContain('"fixture"');
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ sessionId, terminalUncertain: true })] },
		});
	} finally {
		process.kill = originalKill;
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 10_000);

test("broker starts from the production broker entrypoint with no sessions", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-zero-"));
	const broker = new Broker({ agentDir });
	try {
		const discovery = await broker.start();
		expect(discovery.url).toStartWith("ws://127.0.0.1:");
		expect(await broker.handleRequest("session.list", {})).toEqual({
			ok: true,
			result: { indexSeq: 0, sessions: [], warnings: [] },
			indexSeq: 0,
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("shipped sdk session-host-internal stays alive only after a semantic ready event and serves real requests", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-subprocess-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "shipped-subprocess";
	brokerDirs.push(agentDir);
	try {
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, sessionId);
		const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
		try {
			const replay = await client.request({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 });
			expect(replay.events).toContainEqual(
				expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
			);
			expect(child.exitCode).toBeNull();
			expect(await client.query("session.metadata")).toMatchObject({
				ok: true,
				page: { items: [{ sessionId }] },
			});
			expect(await client.control("mode.plan.set", { on: true })).toMatchObject({ ok: true });
		} finally {
			await client.close();
		}
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		spawned.splice(spawned.indexOf(child), 1);
		const broker = await waitFor(
			async () => (await readSdkBrokerDiscovery(agentDir)) ?? undefined,
			"broker discovery",
		);
		expect(broker.url).toStartWith("ws://127.0.0.1:");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("broker close acknowledges before terminating the lifecycle child and records a terminal index", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-close-subprocess-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "close-subprocess";
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, sessionId);
		// The lifecycle child writes its endpoint file before the broker index records
		// its host_registered event; wait for the session to be indexed so session.close
		// does not race the registration (slow CI runners surfaced "session is not indexed").
		await waitFor(async () => {
			const listed = (await broker.handleRequest("session.list", {})) as {
				result?: { sessions?: Array<{ sessionId?: string }> };
			};
			return listed.result?.sessions?.some(session => session.sessionId === sessionId) ? true : undefined;
		}, "session indexed before close");
		const closed = await broker.handleRequest("session.close", { sessionId }, "close-1");
		expect(closed).toMatchObject({ ok: true, result: { sessionId } });
		expect(await child.exited).toBe(0);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId })).toMatchObject({
			ok: false,
			error: { code: "resource_gone" },
		});
		await expect(
			SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 250, reconnectAttempts: 0 }),
		).rejects.toThrow();
		expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true, result: { sessions: [] } });
		expect(
			(await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as { type?: string; sessionId?: string })
				.at(-1),
		).toMatchObject({ type: "session_closed", sessionId });
		expect(await broker.handleRequest("session.close", { sessionId }, "close-1")).toEqual(closed);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("ACP, MCP, and daemon global requests bootstrap a broker with zero sessions", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-zero-global-"));
	const agentDirs = ["acp", "mcp", "daemon"].map(name => path.join(root, name, "agent"));
	brokerDirs.push(...agentDirs);
	try {
		const acp = new AcpAgent({ signal: new AbortController().signal } as never, { agentDir: agentDirs[0] });
		expect(await acp.listSessions({})).toEqual({ sessions: [] });
		expect(await readSdkBrokerDiscovery(agentDirs[0])).not.toBeNull();

		const mcp = createSdkMcpServer({ repo: path.join(root, "mcp"), agentDir: agentDirs[1] });
		expect(await mcp.callTool("gjc_session_global", { operation: "session.list" })).toMatchObject({
			ok: true,
			result: { sessions: [] },
		});
		expect(await readSdkBrokerDiscovery(agentDirs[1])).not.toBeNull();

		const output: unknown[] = [];
		await runSdkSessionCli(
			{ action: "global", operation: "session.list", agentDir: agentDirs[2], repo: path.join(root, "daemon") },
			value => output.push(value),
		);
		expect(output).toMatchObject([{ ok: true, result: { sessions: [] } }]);
		expect(await readSdkBrokerDiscovery(agentDirs[2])).not.toBeNull();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
