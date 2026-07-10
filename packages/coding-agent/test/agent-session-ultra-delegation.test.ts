import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { EAGER_TASK_DELEGATION_PROMPT, ULTRA_TASK_DELEGATION_PROMPT } from "@gajae-code/coding-agent/system-prompt";
import * as z from "zod/v4";

function fakeTaskTool(): AgentTool {
	return {
		name: "task",
		label: "Task",
		description: "Fake task tool",
		parameters: z.object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "unused" }] };
		},
	};
}

function joinedSystemPrompt(agent: Agent): string {
	return agent.state.systemPrompt.join("\n\n");
}

describe("AgentSession Ultra delegation", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("adds and removes the Ultra block from live thinking state without rebuilding the base prompt", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		const taskTool = fakeTaskTool();
		const mock = createMockModel({ responses: [{ content: ["one"] }, { content: ["two"] }, { content: ["three"] }] });
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Stable base", EAGER_TASK_DELEGATION_PROMPT],
				tools: [taskTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry: new Map([[taskTool.name, taskTool]]),
		});

		session.setThinkingLevel(ThinkingLevel.Ultra);
		await session.prompt("use ultra");
		expect(joinedSystemPrompt(agent)).toContain(ULTRA_TASK_DELEGATION_PROMPT);
		expect(joinedSystemPrompt(agent)).not.toContain(EAGER_TASK_DELEGATION_PROMPT);
		expect(agent.state.systemPrompt.filter(block => block === ULTRA_TASK_DELEGATION_PROMPT)).toHaveLength(1);

		session.setThinkingLevel(ThinkingLevel.Max);
		expect(joinedSystemPrompt(agent)).not.toContain(ULTRA_TASK_DELEGATION_PROMPT);
		expect(joinedSystemPrompt(agent)).not.toContain(EAGER_TASK_DELEGATION_PROMPT);
		await session.prompt("use max");
		expect(joinedSystemPrompt(agent)).not.toContain(ULTRA_TASK_DELEGATION_PROMPT);
		expect(joinedSystemPrompt(agent)).not.toContain(EAGER_TASK_DELEGATION_PROMPT);

		settings.set("task.eager", true);
		await session.prompt("use eager tasks");
		expect(joinedSystemPrompt(agent)).toContain(EAGER_TASK_DELEGATION_PROMPT);
		expect(joinedSystemPrompt(agent)).not.toContain(ULTRA_TASK_DELEGATION_PROMPT);
	});
});
