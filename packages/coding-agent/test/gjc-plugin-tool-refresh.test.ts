import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { activeSnapshotPath, modeStatePath } from "../src/gjc-runtime/session-layout";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { syncSkillActiveState } from "../src/skill-state/active-state";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;
let sessionManager: SessionManager;

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: name }] }),
	};
}

async function writeCustomTool(fileName: string, toolName: string): Promise<string> {
	const toolsDir = path.join(tempDir.path(), "tools");
	await fs.mkdir(toolsDir, { recursive: true });
	const toolPath = path.join(toolsDir, fileName);
	await fs.writeFile(
		toolPath,
		`import type { CustomToolFactory } from "../src/extensibility/custom-tools/types";

const factory: CustomToolFactory = pi => ({
	name: ${JSON.stringify(toolName)},
	label: ${JSON.stringify(toolName)},
	description: "refresh fixture tool",
	parameters: pi.zod.object({}),
	async execute() {
		return { content: [{ type: "text", text: ${JSON.stringify(toolName)} }] };
	},
});

export default factory;
`,
	);
	return toolPath;
}

async function activateSubskill(toolPaths: string[], phase = "planner"): Promise<void> {
	await syncSkillActiveState({
		cwd: tempDir.path(),
		skill: "ralplan",
		active: true,
		phase,
		sessionId: sessionManager.getSessionId(),
		active_subskills: [
			{
				plugin: "refresh-plugin",
				subskillName: "design",
				parent: "ralplan",
				bindsTo: "ralplan",
				phase,
				activationArg: "design",
				filePath: path.join(tempDir.path(), "subskills", "design", "SKILL.md"),
				toolPaths,
			},
		],
	});
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@gjc-plugin-tool-refresh-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const readTool = makeTool("read");
	const bashTool = makeTool("bash");
	sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [readTool, bashTool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		toolRegistry: new Map([
			[readTool.name, readTool],
			[bashTool.name, bashTool],
		]),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

describe("AgentSession GJC plugin sub-skill tool refresh", () => {
	test("adds and removes sub-skill tools as the active phase changes", async () => {
		const toolPath = await writeCustomTool("domain-note.ts", "domain_note");
		await activateSubskill([toolPath], "planner");

		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).toContain("domain_note");
		expect(session.getActiveToolNames()).toContain("domain_note");

		await syncSkillActiveState({
			cwd: tempDir.path(),
			skill: "ralplan",
			active: true,
			phase: "critic",
			sessionId: sessionManager.getSessionId(),
			active_subskills: [],
		});

		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).not.toContain("domain_note");
		expect(session.getActiveToolNames()).not.toContain("domain_note");
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
	});

	test("revokes phase-bound tools when live and durable phase state conflict", async () => {
		const toolPath = await writeCustomTool("domain-note.ts", "domain_note");
		await activateSubskill([toolPath], "planner");
		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).toContain("domain_note");

		const statePath = modeStatePath(tempDir.path(), sessionManager.getSessionId(), "ralplan");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			JSON.stringify({
				skill: "ralplan",
				session_id: sessionManager.getSessionId(),
				current_phase: "critic",
				active: true,
				version: 2,
			}),
		);

		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).not.toContain("domain_note");
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
	});

	test("dispatcher-only prompt consumption does not seed workflow state or an initial phase", async () => {
		session.agent.emitExternalEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "dispatcher only",
				display: false,
				attribution: "user",
				timestamp: Date.now(),
				details: {
					name: "ralplan",
					path: "/bundled/ralplan/SKILL.md",
					lineCount: 1,
					workflowResolution: {
						skill: "ralplan",
						source: "dispatcher-only",
						fragmentKind: "dispatcher",
						diagnostics: ["workflow phase absent"],
						stateVersion: 2,
					},
				},
			},
		});
		await Bun.sleep(0);

		const sessionId = sessionManager.getSessionId();
		expect(session.getActiveSkillPhase()).toBeUndefined();
		await expect(fs.access(modeStatePath(tempDir.path(), sessionId, "ralplan"))).rejects.toThrow();
		await expect(fs.access(activeSnapshotPath(tempDir.path(), sessionId))).rejects.toThrow();
	});

	test("rejects sub-skill tools whose names conflict with existing tools", async () => {
		const toolPath = await writeCustomTool("read.ts", "read");
		await activateSubskill([toolPath], "planner");

		await session.refreshGjcSubskillTools();

		expect(session.getAllToolNames().filter(name => name === "read")).toHaveLength(1);
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
	});
});
