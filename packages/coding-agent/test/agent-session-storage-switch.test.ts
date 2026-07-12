import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { Snowflake } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

interface TestSession {
	session: AgentSession;
	manager: SessionManager;
	authStorage: AuthStorage;
}

async function createSession(directory: string, extensionRunner?: ExtensionRunner): Promise<TestSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const manager = SessionManager.create(directory, directory);
	const authStorage = await AuthStorage.create(path.join(directory, `auth-${Snowflake.next()}.db`));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage, path.join(directory, `models-${Snowflake.next()}.yml`)),
		extensionRunner,
	});
	return { session, manager, authStorage };
}

describe("AgentSession storage switch", () => {
	const disposers: TestSession[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const testSession of disposers.splice(0)) {
			await testSession.session.dispose();
			testSession.authStorage.close();
		}
		for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	});

	it("switch failure before commit restores the prior session transactionally", async () => {
		const directory = path.join(os.tmpdir(), `gjc-storage-switch-${Snowflake.next()}`);
		directories.push(directory);
		fs.mkdirSync(directory, { recursive: true });
		const current = await createSession(directory);
		disposers.push(current);
		const currentFile = current.manager.getSessionFile();
		expect(currentFile).toBeString();
		await current.session.steer("keep queued steering");

		const invalidTarget = path.join(directory, "invalid.jsonl");
		fs.writeFileSync(invalidTarget, '{"type":"session","id":42}\n');
		await expect(current.session.switchSession(invalidTarget)).rejects.toThrow("Invalid session header");

		expect(current.manager.getSessionFile()).toBe(currentFile);
		expect(current.session.getQueuedMessages().steering).toEqual(["keep queued steering"]);
	});

	it("switch failure after target validation restores manager and runtime state", async () => {
		const directory = path.join(os.tmpdir(), `gjc-storage-switch-${Snowflake.next()}`);
		directories.push(directory);
		fs.mkdirSync(directory, { recursive: true });
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async (event: { type: string }) => {
				if (event.type === "session_switch") throw new Error("hook failure");
			},
		} as unknown as ExtensionRunner;
		const current = await createSession(directory, extensionRunner);
		disposers.push(current);
		const target = SessionManager.create(directory, directory);
		const targetFile = target.getSessionFile();
		await target.ensureOnDisk();
		await target.close();
		expect(targetFile).toBeString();
		const currentFile = current.manager.getSessionFile();
		const model = current.session.model;
		await current.session.steer("restore steering");

		await expect(current.session.switchSession(targetFile!)).rejects.toThrow("hook failure");

		expect(current.manager.getSessionFile()).toBe(currentFile);
		expect(current.session.model).toBe(model);
		expect(current.session.getQueuedMessages().steering).toEqual(["restore steering"]);
	});

	it("reload preserves switch-hook queue semantics", async () => {
		const directory = path.join(os.tmpdir(), `gjc-storage-switch-${Snowflake.next()}`);
		directories.push(directory);
		fs.mkdirSync(directory, { recursive: true });
		let session: AgentSession;
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async (event: { type: string }) => {
				if (event.type === "session_switch") await session.sendUserMessage("reload hook", { deliverAs: "steer" });
			},
		} as unknown as ExtensionRunner;
		const current = await createSession(directory, extensionRunner);
		disposers.push(current);
		session = current.session;
		await current.manager.ensureOnDisk();
		await current.session.steer("pre-reload steering");

		await current.session.reload();

		expect(current.session.getQueuedMessages().steering).toEqual(["reload hook"]);
		expect(current.session.agent.snapshotSteering()).toHaveLength(1);
	});
});
