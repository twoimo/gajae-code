import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

async function withSessionOptions<T>(
	run: (options: Parameters<typeof createAgentSession>[0], registry: AgentRegistry) => Promise<T>,
): Promise<T> {
	const tempDir = TempDir.createSync("@gjc-sdk-registration-");
	let authStorage: AuthStorage | undefined;
	try {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const registry = new AgentRegistry();
		return await run(
			{
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false }),
				disableExtensionDiscovery: true,
				extensions: [],
				toolNames: [],
				workspaceTree: {
					rootPath: tempDir.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				agentRegistry: registry,
				agentId: "1-Worker",
				parentTaskPrefix: "test",
			},
			registry,
		);
	} finally {
		authStorage?.close();
		tempDir.removeSync();
	}
}

describe("createAgentSession registry handoff", () => {
	it("onAgentRegistered fires after registration and before attachment", async () => {
		await withSessionOptions(async (options, registry) => {
			const order: string[] = [];
			registry.onChange(event => {
				if (event.type === "registered") order.push("registered");
				if (event.type === "attached") order.push("attached");
			});

			const { session } = await createAgentSession({
				...options,
				onAgentRegistered: ({ id, ref }) => {
					order.push("callback");
					expect(registry.get(id)).toBe(ref);
					expect(ref.session).toBeNull();
				},
			});
			try {
				expect(order).toEqual(["registered", "callback", "attached"]);
			} finally {
				await session.dispose();
			}
		});
	});

	it("callback failure unregisters the pre-registered agent and propagates", async () => {
		await withSessionOptions(async (options, registry) => {
			await expect(
				createAgentSession({
					...options,
					onAgentRegistered: () => {
						throw new Error("binding failed");
					},
				}),
			).rejects.toThrow("binding failed");
			expect(registry.get("1-Worker")).toBeUndefined();
		});
	});
	it("allows the dashboard architect session to coexist with the live main session", async () => {
		await withSessionOptions(async (options, registry) => {
			const main = await createAgentSession({ ...options, agentId: "0-Main", parentTaskPrefix: undefined });
			try {
				const architect = await createAgentSession({
					...options,
					agentId: "0-Main:agent-creation-architect",
					parentTaskPrefix: undefined,
				});
				try {
					expect(registry.get("0-Main")?.session).toBe(main.session);
					expect(registry.get("0-Main:agent-creation-architect")?.session).toBe(architect.session);
				} finally {
					await architect.session.dispose();
				}
			} finally {
				await main.session.dispose();
			}
		});
	});
});
