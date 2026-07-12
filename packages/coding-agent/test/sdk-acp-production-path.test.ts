import type { AgentSideConnection } from "@agentclientprotocol/sdk";

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpAgent } from "../src/modes/acp/acp-agent";

type TestServer = {
	port: number | undefined;
	upgrade(request: Request): boolean;
	stop(closeActiveConnections?: boolean): void;
};

const directories: string[] = [];
const servers: TestServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("production ACP routes zero-session SDK globals through the broker adapter", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "gjc-sdk-acp-production-"));
	directories.push(directory);
	const agentDir = path.join(directory, ".gjc", "agent");
	const token = "acp-broker-token";
	const requests: Array<Record<string, unknown>> = [];
	let server!: TestServer;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token) return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request)) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "broker_hello", protocolVersion: 3 }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				requests.push(frame);
				socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: { sessions: [] } }));
			},
		},
	});
	servers.push(server);
	await mkdir(path.join(agentDir, "sdk"), { recursive: true });
	await writeFile(
		path.join(agentDir, "sdk", "broker.json"),
		JSON.stringify({
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "test-owner",
			pid: process.pid,
			host: "127.0.0.1",
			port: server.port!,
			url: `ws://127.0.0.1:${server.port!}`,
			token,
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}),
	);

	const abort = new AbortController();
	const agent = new AcpAgent({ signal: abort.signal } as unknown as AgentSideConnection, { agentDir });
	const result = await agent.extMethod("_gjc/sdk/global", { operation: "session.list" });

	expect(result).toMatchObject({ ok: true, result: { sessions: [] } });
	expect(requests).toEqual([
		expect.objectContaining({ type: "broker_request", operation: "session.list", input: {} }),
	]);
	expect(requests[0]).not.toHaveProperty("sessionId");
	abort.abort();
});
