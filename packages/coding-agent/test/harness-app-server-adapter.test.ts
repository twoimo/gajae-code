import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { GajaeCodeAppServerRpc, type AppServerTransport } from "../src/harness-control-plane/app-server-adapter";
import { singleFlightAccept } from "../src/harness-control-plane/rpc-adapter";

class FakeStdout extends EventEmitter {
	setEncoding(_encoding: BufferEncoding): void {}
}

class FakeAppServerTransport extends EventEmitter implements AppServerTransport {
	readonly stdout = new FakeStdout();
	readonly writes: Record<string, unknown>[] = [];
	readonly stdin = {
		write: (chunk: string, callback?: (error?: Error | null) => void): boolean => {
			const frame = JSON.parse(chunk.trim()) as Record<string, unknown>;
			this.writes.push(frame);
			queueMicrotask(() => {
				this.respondTo(frame);
				callback?.(null);
			});
			return true;
		},
		end: (): void => {},
	};
	killed = false;
	state: Record<string, unknown> = { status: "idle", queuedMessageCount: 0, followupQueueDepth: 0 };
	autoAgentStart = true;
	threadId = "thr_fake_app_server";

	start(): void {
		queueMicrotask(() => this.send({ type: "ready" }));
	}

	kill(): void {
		this.killed = true;
		this.emit("exit", 0);
	}

	send(frame: Record<string, unknown>): void {
		this.stdout.emit("data", `${JSON.stringify(frame)}\n`);
	}

	private respondTo(frame: Record<string, unknown>): void {
		const method = frame.method;
		if (!frame.id) return;
		if (method === "initialize") {
			this.send({ jsonrpc: "2.0", id: frame.id, result: { userAgent: "fake" } });
			return;
		}
		if (method === "thread/start") {
			this.send({ jsonrpc: "2.0", id: frame.id, result: { thread: { id: this.threadId } } });
			return;
		}
		if (method === "gjc/state/read") {
			this.send({ jsonrpc: "2.0", id: frame.id, result: this.state });
			return;
		}
		if (method === "turn/start") {
			this.send({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "turn_fake", status: "inProgress" } } });
			if (this.autoAgentStart) {
				queueMicrotask(() => this.send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: this.threadId, turnId: "turn_fake" } }));
			}
			return;
		}
		if (method === "gjc/messages/get") {
			this.send({ jsonrpc: "2.0", id: frame.id, result: { messages: [{ role: "assistant", content: "done" }] } });
			return;
		}
		this.send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `unknown method ${String(method)}` } });
	}
}

async function createRpc(fake = new FakeAppServerTransport()): Promise<{ rpc: GajaeCodeAppServerRpc; fake: FakeAppServerTransport }> {
	const rpc = new GajaeCodeAppServerRpc({ transport: fake, cwd: "/repo" });
	fake.start();
	await rpc.ready();
	return { rpc, fake };
}

describe("GajaeCodeAppServerRpc", () => {
	it("performs the app-server handshake in initialize, initialized, thread/start order", async () => {
		const { rpc, fake } = await createRpc();
		const methods = fake.writes.map(frame => frame.method);
		expect(methods).toEqual(["initialize", "initialized", "thread/start"]);
		expect(fake.writes[0]).toMatchObject({ jsonrpc: "2.0", method: "initialize" });
		expect(fake.writes[1]).toMatchObject({ jsonrpc: "2.0", method: "initialized" });
		expect(fake.writes[1]).not.toHaveProperty("id");
		expect(fake.writes[2]).toMatchObject({ jsonrpc: "2.0", method: "thread/start", params: { cwd: "/repo" } });
		await rpc.close();
	});

	it("accepts a prompt only after turn/start ack and a post-cursor turn/started notification", async () => {
		const { rpc, fake } = await createRpc();
		const result = await singleFlightAccept(rpc, "implement this", 100);
		expect(result.accepted).toBe(true);
		expect(result.reason).toBe("protocol-ack-single-flight");
		expect(result.preSubmitCursor).toBe(0);
		expect(result.agentStartCursor).toBeGreaterThan(result.preSubmitCursor);
		const turnStart = fake.writes.find(frame => frame.method === "turn/start");
		expect(turnStart).toMatchObject({ params: { threadId: fake.threadId, input: "implement this" } });
		await rpc.close();
	});

	it("does not accept ack-only prompts without a post-cursor agent-start signal", async () => {
		const fake = new FakeAppServerTransport();
		fake.autoAgentStart = false;
		const { rpc } = await createRpc(fake);
		const result = await singleFlightAccept(rpc, "ack only", 20);
		expect(result.accepted).toBe(false);
		expect(result.reason).toBe("no-agent-start-within-timeout");
		expect(result.commandId).toBeTruthy();
		expect(result.agentStartCursor).toBeNull();
		await rpc.close();
	});

	it("also treats gjc/event agent_start notifications as acceptance signals", async () => {
		const fake = new FakeAppServerTransport();
		fake.autoAgentStart = false;
		const { rpc } = await createRpc(fake);
		const accept = singleFlightAccept(rpc, "event-style start", 100);
		await Bun.sleep(0);
		fake.send({
			jsonrpc: "2.0",
			method: "gjc/event",
			params: { threadId: fake.threadId, eventType: "agent_start", event: { type: "agent_start" } },
		});
		const result = await accept;
		expect(result.accepted).toBe(true);
		expect(result.agentStartCursor).toBeGreaterThan(result.preSubmitCursor);
		await rpc.close();
	});
});
