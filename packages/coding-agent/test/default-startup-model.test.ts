import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

function isBusyFsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		["EBUSY", "ENOTEMPTY", "EPERM"].includes(String(error.code))
	);
}

async function removeTempDirWithRetry(tempDir: TempDir | undefined): Promise<void> {
	if (!tempDir) return;
	for (let attempt = 0; attempt < 13; attempt++) {
		try {
			tempDir.removeSync();
			return;
		} catch (error) {
			if (!isBusyFsError(error) || attempt === 12) throw error;
			await Bun.sleep(50 * (attempt + 1));
		}
	}
}

describe("default startup model", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		await removeTempDirWithRetry(tempDir);
		tempDir = undefined;
	});

	it("prefers GPT-5.5 with xhigh reasoning when no model is specified", async () => {
		tempDir = TempDir.createSync("@gjc-default-startup-model-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-codex-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;

		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe("gpt-5.5");
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});
});
