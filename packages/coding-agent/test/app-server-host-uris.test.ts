import { afterEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../src/internal-urls";
import { AgentSessionHost } from "../src/modes/app-server/agent-session-host";
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

const router = InternalUrlRouter.instance();

afterEach(() => {
	router.unregister("db");
	router.unregister("notes");
});

describe("app-server host URI routing", () => {
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
