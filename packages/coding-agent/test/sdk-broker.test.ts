import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { getSessionsDir } from "@gajae-code/utils";
import { lifecycleArgs } from "../src/commands/sdk";
import { Broker } from "../src/sdk/broker/broker";
import {
	brokerDiscoveryPath,
	readBrokerDiscovery,
	redactBrokerDiscovery,
	writeBrokerDiscovery,
} from "../src/sdk/broker/discovery";
import { ensureBroker } from "../src/sdk/broker/ensure";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { readSessionLifecycleLaunchRequest } from "../src/sdk/broker/lifecycle";
import { resolveSdkInternalSpawnCommand } from "../src/sdk/broker/runtime";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-"));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const brokerEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");

it("SDK internal commands self-spawn compiled binaries without source entrypoints", () => {
	const compiled = {
		execPath: "/opt/gjc/gjc",
		mode: "compiled" as const,
		argsPrefix: [],
		reloadPicksUpSourceEdits: false,
		warning: "Rebuild",
	};
	expect(resolveSdkInternalSpawnCommand("broker-internal", compiled)).toEqual({
		file: "/opt/gjc/gjc",
		args: ["sdk", "broker-internal"],
	});
	expect(resolveSdkInternalSpawnCommand("session-host-internal", compiled)).toEqual({
		file: "/opt/gjc/gjc",
		args: ["sdk", "session-host-internal"],
	});
});

it("SDK lifecycle model presets reach the session host parser", () => {
	const request = readSessionLifecycleLaunchRequest(
		JSON.stringify({
			operation: "session.create",
			sessionId: "session-1",
			stateRoot: "/state",
			modelPreset: "codex-eco",
		}),
	);
	expect(lifecycleArgs(request, "/repo", "/agent").mpreset).toBe("codex-eco");
});
async function waitForDiscovery(agentDir: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const discovery = await readBrokerDiscovery(agentDir);
		if (discovery) return discovery;
		await sleep(20);
	}
	throw new Error("Timed out waiting for broker discovery.");
}
describe("SDK broker identity and discovery", () => {
	it("persists identity and writes a redacted private discovery record", async () => {
		const dir = await temp();
		const a = await getBrokerIdentityKey(dir);
		expect(await getBrokerIdentityKey(dir)).toBe(a);
		const d = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "test",
			ownerId: "x",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: 1,
			heartbeatAt: Date.now(),
		};
		await writeBrokerDiscovery(dir, d);
		expect(redactBrokerDiscovery(d).token).toBe("[redacted]");
		if (process.platform !== "win32")
			expect((await fs.stat(path.join(dir, "sdk", "broker.json"))).mode & 0o777).toBe(0o600);
	});
	it("refreshes discovery heartbeat, removes it on stop, and can restart", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, heartbeatTtlMs: 45 });
		const first = await broker.start();
		await sleep(100);
		expect(await readBrokerDiscovery(dir, 45)).not.toBeNull();
		await broker.stop();
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		const restarted = await ensureBroker({ agentDir: dir, heartbeatTtlMs: 45 });
		expect(restarted.token).not.toBe(first.token);
		const owner = (await import("../src/sdk/broker/ensure")).brokerOwnerForTest(dir);
		await owner?.stop();
	});
	it("leaves exactly one live detached broker after concurrent process startup", async () => {
		const dir = await temp();
		const children = [0, 1].map(() =>
			Bun.spawn([process.execPath, "run", brokerEntrypoint, "sdk", "broker-internal", "--agent-dir", dir], {
				stdout: "ignore",
				stderr: "ignore",
			}),
		);
		try {
			const discovery = await waitForDiscovery(dir);
			await sleep(100);
			const exited = children.filter(child => child.exitCode !== null);
			expect(exited).toHaveLength(1);
			const owner = children.find(child => child.exitCode === null);
			expect(owner).toBeDefined();
			expect(discovery.pid).toBe(owner!.pid!);
			process.kill(discovery.pid, "SIGTERM");
			await Promise.all(children.map(child => child.exited));
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("returns only an endpoint bound to the indexed generation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, "state");
		const endpointPath = path.join(stateRoot, "sdk", "s.json");
		const broker = new Broker({ agentDir: dir });
		await broker.index.open();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "s", pid: process.pid, token: "session-secret" }));
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 3,
			pid: process.pid,
			endpointMtimeMs,
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 3 })).toEqual({
			ok: true,
			result: { sessionId: "s", pid: process.pid, token: "session-secret" },
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 2 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 4,
			pid: process.pid,
			endpointMtimeMs: endpointMtimeMs + 1,
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 4 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
	});
	it("replays only the same lifecycle body and conflicts when a caller reuses its key for the same target", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const input = { sessionId: "saved", sessionPath: path.join(dir, "missing.json"), trace: "first" };
			const first = await broker.handleRequest("session.delete", input, "caller-key");
			expect(await broker.handleRequest("session.delete", input, "caller-key")).toEqual(first);
			expect(await broker.handleRequest("session.delete", { ...input, trace: "changed" }, "caller-key")).toEqual({
				ok: false,
				error: { code: "idempotency_conflict", message: "idempotency key was used with a different request" },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("binds session.delete to the requested session header and configured storage root", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "repo");
		const sessions = path.join(getSessionsDir(dir), "project");
		const requested = path.join(sessions, "requested.jsonl");
		const other = path.join(sessions, "other.jsonl");
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(requested, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
		await fs.writeFile(other, `${JSON.stringify({ type: "session", id: "other" })}\n`);
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: other, cwd },
					"delete-cross-session",
				),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "session.delete path does not contain the requested session." },
			});
			expect(await fs.readFile(other, "utf8")).toContain('"other"');
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: path.join(dir, "outside.jsonl"), cwd },
					"delete-outside-root",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is outside the configured session storage root.",
				},
			});
			expect(await fs.readFile(requested, "utf8")).toContain('"requested"');
			const external = path.join(dir, "external.jsonl");
			const externalArtifacts = external.slice(0, -6);
			const linked = path.join(sessions, "linked.jsonl");
			await fs.writeFile(external, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
			await fs.mkdir(externalArtifacts);
			await fs.symlink(external, linked);
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: linked, cwd },
					"delete-symlink-escape",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path resolves outside the configured session storage root.",
				},
			});
			expect(await fs.readFile(external, "utf8")).toContain('"requested"');
			expect((await fs.stat(externalArtifacts)).isDirectory()).toBe(true);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
