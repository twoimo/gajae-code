import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { AppendOnlyContextManager } from "@gajae-code/agent-core/append-only-context";
import { getBundledModel } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { RetainedMemoryRegistry } from "@gajae-code/utils/retained-memory";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode, TUI_RETAINED_MEMORY_CACHE_CLASSES } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";

import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const memoryUsage = (): NodeJS.MemoryUsage => ({
	rss: 900,
	heapTotal: 800,
	heapUsed: 700,
	external: 600,
	arrayBuffers: 500,
});

describe("AgentSession retained-memory integration", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		resetSettingsForTest();
	});

	it("registers agent-loop and session index/history accounting in an injected registry", async () => {
		tempDir = TempDir.createSync("@gjc-retained-memory-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const registry = new RetainedMemoryRegistry({ now: () => 123, memoryUsage });
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: "four", timestamp: 1 }],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			retainedMemoryRegistry: registry,
		});

		const snapshot = session.getRetainedMemorySnapshot();
		expect(snapshot.sampledAt).toBe(123);
		expect(snapshot.gauges).toEqual({ rssBytes: 900, heapUsedBytes: 700, externalBytes: 600, nativeBytes: 500 });
		expect(snapshot.registrations).toHaveLength(1);
		expect(snapshot.registrations[0]?.id).toContain("session-index-history:");
		expect(snapshot.registrations[0]?.bytes).toBe(128);
		expect(snapshot.pools).toHaveLength(1);
		expect(snapshot.pools[0]?.id).toContain("agent-loop:");
		expect(snapshot.pools[0]?.bytes).toBe(0);
		expect(snapshot.totalRetainedBytes).toBe(128);

		await session.dispose();
		session = undefined;
		expect(registry.sample().registrations).toEqual([]);
		expect(registry.sample().pools).toEqual([]);
	});

	it("registers and unregisters all interactive TUI pools in an injected registry", async () => {
		initTheme();
		tempDir = TempDir.createSync("@gjc-retained-memory-tui-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const registry = new RetainedMemoryRegistry({ now: () => 456, memoryUsage });
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			retainedMemoryRegistry: registry,
		});
		const mode = new InteractiveMode(session, "test");

		const pools = new Map(session.getRetainedMemorySnapshot().pools.map(pool => [pool.id, pool]));
		for (const expected of TUI_RETAINED_MEMORY_CACHE_CLASSES) {
			expect(pools.get(expected.id)?.buckets).toEqual(
				Object.fromEntries(expected.buckets.map(bucket => [bucket, 0])),
			);
		}

		mode.stop();
		for (const expected of TUI_RETAINED_MEMORY_CACHE_CLASSES)
			expect(registry.sample().pools.map(pool => pool.id)).not.toContain(expected.id);
		await session.dispose();
		session = undefined;
		expect(registry.sample().registrations).toEqual([]);
		expect(registry.sample().pools).toEqual([]);
	});

	it("samples real append-only retained bytes without traversing history", async () => {
		for (const cardinality of [1_000, 100_000, 1_000_000]) {
			const manager = new AppendOnlyContextManager();
			const message = { role: "user" as const, content: "12345678", timestamp: 1 };
			for (let index = 0; index < cardinality; index++) manager.log.append(message);
			expect(manager.log.retainedContentBytes).toBe(cardinality * 8);
			const entriesSpy = vi.spyOn(manager.log, "entries").mockImplementation(() => {
				throw new Error("sampling traversed append-only history");
			});

			tempDir = TempDir.createSync("@gjc-retained-memory-stress-");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled anthropic model to exist");
			const registry = new RetainedMemoryRegistry({ now: () => cardinality, memoryUsage });
			const agent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			});
			agent.setAppendOnlyContext(manager);
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				modelRegistry,
				retainedMemoryRegistry: registry,
			});
			expect(session.getRetainedMemorySnapshot().pools[0]?.bytes).toBe(cardinality * 8);
			entriesSpy.mockRestore();
			await session.dispose();
			session = undefined;
			authStorage.close();
			authStorage = undefined;
			tempDir.removeSync();
			tempDir = undefined;
		}
	});
});
