import { afterEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../src/internal-urls";
import { AgentSessionHost } from "../src/modes/app-server/agent-session-host";
import { type AppServerHost, type CreatedThread, startAppServer } from "../src/modes/app-server/host";
import type { AgentSessionEvent } from "../src/session/agent-session";

class FakeSession {
	readonly sessionId: string;
	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}
	subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	async steer(): Promise<void> {}
	async abort(): Promise<void> {}
	async executeBash(): Promise<unknown> {
		return { exitCode: 0 };
	}
	async dispose(): Promise<void> {}
}

class WireHost implements AppServerHost {
	readonly frames: unknown[];
	threadId = "thr_wire";
	generation = 1;
	server: { readHostUri(threadId: string, urlJson: string): Promise<string> } | undefined;
	pendingCancel: Promise<string> | undefined;
	constructor(frames: unknown[]) {
		this.frames = frames;
	}
	async createThread(): Promise<CreatedThread> {
		return { threadId: this.threadId };
	}
	async resumeThread(): Promise<CreatedThread> {
		return { threadId: this.threadId, resumed: true };
	}
	async forkThread(): Promise<CreatedThread> {
		return { threadId: this.threadId };
	}
	setAppServer(server: { readHostUri(threadId: string, urlJson: string): Promise<string> }): void {
		this.server = server;
	}

	async backendCall(_threadId: string, method: string): Promise<unknown> {
		if (method === "prompt") {
			this.pendingCancel = this.server?.readHostUri(this.threadId, JSON.stringify({ url: "wire://row/2" }));
			await new Promise(resolve => setTimeout(resolve, 200));
			return { id: "turn_wire" };
		}
		if (method === "getMessages") return [];
		if (method === "getState") return {};
		if (method === "abort") return {};
		return {};
	}
	async notificationCall(): Promise<unknown> {
		return {};
	}
	setHostUriSchemes(
		_threadId: string,
		schemes: Array<{ scheme: string; writable?: boolean; immutable?: boolean }>,
	): string[] {
		return schemes.map(scheme => scheme.scheme).sort();
	}
}

const router = InternalUrlRouter.instance();

afterEach(() => {
	router.unregister("db");
	router.unregister("notes");
	router.unregister("wire");
});

describe("app-server host URI routing", () => {
	it("drives host URI registration, read, write, result, cancel, and reserved rejection on the JSON-RPC wire", async () => {
		const frames: unknown[] = [];
		const host = new WireHost(frames);
		const handle = startAppServer(host, { onFrame: frame => frames.push(JSON.parse(frame)) });
		const conn = handle.openConnection();
		await handle.dispatch(conn, JSON.stringify({ id: 0, method: "initialize", params: {} }));
		await handle.dispatch(conn, JSON.stringify({ method: "initialized" }));
		const start = JSON.parse(
			(await handle.dispatch(conn, JSON.stringify({ id: 1, method: "thread/start", params: {} }))) ?? "{}",
		);
		const threadId = start.result.thread.id;

		const reserved = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({
					id: 2,
					method: "gjc/hostUriSchemes/set",
					params: { threadId, schemes: [{ scheme: "agent" }] },
				}),
			)) ?? "{}",
		);
		expect(reserved.error?.message).toContain("reserved");

		const set = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({
					id: 3,
					method: "gjc/hostUriSchemes/set",
					params: { threadId, schemes: [{ scheme: "wire", writable: true }] },
				}),
			)) ?? "{}",
		);
		expect(set.error).toBeUndefined();
		expect(set.result.schemes).toEqual([{ scheme: "wire", writable: true, immutable: false }]);

		const readPromise = handle.server.readHostUri(threadId, JSON.stringify({ url: "wire://row/1" }));
		await new Promise(resolve => setTimeout(resolve, 10));
		const readFrame = frames.find(
			(frame): frame is { method: string; params: { requestId: string; operation: string; url: string } } =>
				typeof frame === "object" &&
				frame !== null &&
				(frame as { method?: string }).method === "gjc/hostUris/request",
		);
		expect(readFrame?.params.operation).toBe("read");
		expect(readFrame?.params.url).toBe("wire://row/1");
		const readResult = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({
					id: 4,
					method: "gjc/hostUris/result",
					params: {
						threadId,
						requestId: readFrame?.params.requestId,
						content: "hello",
						contentType: "text/plain",
						notes: ["wire"],
					},
				}),
			)) ?? "{}",
		);
		expect(readResult.error).toBeUndefined();
		expect(await readPromise).toContain('"content":"hello"');

		const writePromise = handle.server.writeHostUri(threadId, JSON.stringify({ url: "wire://row/1" }), "updated");
		await new Promise(resolve => setTimeout(resolve, 10));
		const writeFrame = frames
			.filter(
				(frame): frame is { method: string; params: { requestId: string; operation: string; content: string } } =>
					typeof frame === "object" &&
					frame !== null &&
					(frame as { method?: string }).method === "gjc/hostUris/request",
			)
			.find(frame => frame.params.operation === "write");
		expect(writeFrame?.params.content).toBe("updated");
		await handle.dispatch(
			conn,
			JSON.stringify({
				id: 5,
				method: "gjc/hostUris/result",
				params: { threadId, requestId: writeFrame?.params.requestId },
			}),
		);
		await expect(writePromise).resolves.toBeUndefined();

		const startTurn = JSON.parse(
			(await handle.dispatch(
				conn,
				JSON.stringify({ id: 6, method: "turn/start", params: { threadId, input: "run" } }),
			)) ?? "{}",
		);
		const turnId = startTurn.result.turn.id;
		let cancelFrame: { method: string; params: { requestId: string; operation: string; url: string } } | undefined;
		for (let i = 0; i < 20; i += 1) {
			cancelFrame = frames
				.filter(
					(frame): frame is { method: string; params: { requestId: string; operation: string; url: string } } =>
						typeof frame === "object" &&
						frame !== null &&
						(frame as { method?: string }).method === "gjc/hostUris/request",
				)
				.find(frame => frame.params.url === "wire://row/2");
			if (cancelFrame) break;
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		expect(cancelFrame).toBeDefined();
		void host.pendingCancel?.catch(() => undefined);
		void handle.dispatch(
			conn,
			JSON.stringify({
				id: 7,
				method: "turn/interrupt",
				params: { threadId, turnId },
			}),
		);
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(
			frames.some(
				frame =>
					typeof frame === "object" &&
					frame !== null &&
					(frame as { method?: string; params?: { requestId?: string } }).method === "gjc/hostUris/cancel" &&
					(frame as { params?: { requestId?: string } }).params?.requestId === cancelFrame?.params.requestId,
			),
		).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 20));
	});

	it("routes the same scheme by thread context without cross-thread leakage", async () => {
		let next = 0;
		const host = new AgentSessionHost({
			appServer: {
				hostToolNames: () => [],
				activeTurnId: () => null,
				callHostTool: async () => "{}",
				readHostUri: async (threadId, urlJson) => {
					const { url } = JSON.parse(urlJson);
					return JSON.stringify({
						url,
						content: `content:${threadId}`,
						contentType: "text/plain",
						notes: [threadId],
						immutable: threadId === "thr_b",
					});
				},
				writeHostUri: async () => {},
			},
			sessionFactory: async () => ({ session: new FakeSession(next++ === 0 ? "thr_a" : "thr_b") }),
		});
		await host.createThread({});
		await host.createThread({});
		expect(host.setHostUriSchemes("thr_a", [{ scheme: "db", writable: true }])).toEqual(["db"]);
		expect(host.setHostUriSchemes("thr_b", [{ scheme: "db", immutable: true }])).toEqual(["db"]);

		const a = await router.resolve("db://row/1", { threadId: "thr_a" });
		const b = await router.resolve("db://row/1", { threadId: "thr_b" });
		expect(a.content).toBe("content:thr_a");
		expect(a.immutable).toBe(false);
		expect(b.content).toBe("content:thr_b");
		expect(b.immutable).toBe(true);
	});

	it("rejects non-writable schemes before emitting write", async () => {
		let writes = 0;
		const host = new AgentSessionHost({
			appServer: {
				hostToolNames: () => [],
				activeTurnId: () => null,
				callHostTool: async () => "{}",
				readHostUri: async () => JSON.stringify({ content: "", contentType: "text/plain" }),
				writeHostUri: async () => {
					writes += 1;
				},
			},
			sessionFactory: async () => ({ session: new FakeSession("thr_a") }),
		});
		await host.createThread({});
		host.setHostUriSchemes("thr_a", [{ scheme: "notes", writable: false }]);
		const handler = router.getHandler("notes");
		await expect(handler?.write?.(new URL("notes://x") as never, "body", { threadId: "thr_a" })).rejects.toThrow(
			"not writable",
		);
		expect(writes).toBe(0);
	});
});
