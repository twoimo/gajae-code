import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import { AgentWireFrameSequencer, toAgentWireEventFrame } from "../../src/modes/shared/agent-wire/event-envelope";
import { EVENT_FIXTURES } from "../agent-wire/fixtures";

let root: string;

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "rpc-fallback-cancel-"));
});

describe("RPC managed fallback cancellation settlement", () => {
	it("settles waitForIdle once from the cancelled agent_end without timing out", async () => {
		const socketPath = path.join(root, "rpc.sock");
		const sequencer = new AgentWireFrameSequencer("fallback-cancel-rpc");
		let socket: import("bun").Socket | undefined;
		const server = Bun.listen({
			unix: socketPath,
			socket: {
				open(client) {
					socket = client;
					client.write(`${JSON.stringify({ type: "ready" })}\n`);
				},
				data() {},
			},
		});
		const client = new RpcClient({ transport: "uds", socketPath });
		try {
			await client.start();
			let resolutions = 0;
			const idle = client.waitForIdle(100);
			void idle.then(() => {
				resolutions++;
			});

			const cancelledEnd = {
				...EVENT_FIXTURES.agent_end,
				stopReason: "cancelled" as const,
			};
			socket!.write(`${JSON.stringify(toAgentWireEventFrame(cancelledEnd, sequencer))}\n`);
			await expect(idle).resolves.toBeUndefined();
			await Bun.sleep(0);
			expect(resolutions).toBe(1);
			// A duplicate completion frame must not resolve the already-settled waiter again.
			socket!.write(`${JSON.stringify(toAgentWireEventFrame(cancelledEnd, sequencer))}\n`);
			await Bun.sleep(0);
			expect(resolutions).toBe(1);
		} finally {
			client.stop();
			socket?.end();
			server.stop(true);
		}
	});
});
