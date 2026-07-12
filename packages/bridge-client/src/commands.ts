import { AGENT_WIRE_COMMAND_TYPES, type AgentWireCommand, type AgentWireCommandType } from "@gajae-code/agent-wire";

/** @deprecated Use AGENT_WIRE_COMMAND_TYPES from @gajae-code/agent-wire. */
export const BRIDGE_CLIENT_COMMAND_TYPES = AGENT_WIRE_COMMAND_TYPES;
/** @deprecated Use AgentWireCommandType from @gajae-code/agent-wire. */
export type BridgeClientCommandType = AgentWireCommandType;
/** @deprecated Use AgentWireCommand from @gajae-code/agent-wire. */
export type BridgeClientCommand<TType extends BridgeClientCommandType = BridgeClientCommandType> =
	AgentWireCommand<TType>;

export interface BridgeCommandOptions {
	id?: string;
	idempotencyKey?: string;
}

export interface BridgeImageCommandOptions extends BridgeCommandOptions {
	images?: unknown[];
}

export interface BridgeCommandHelpers {
	prompt(
		sessionId: string,
		message: string,
		options?: BridgeImageCommandOptions & { streamingBehavior?: "steer" | "followUp" },
	): Promise<unknown>;
	steer(sessionId: string, message: string, options?: BridgeImageCommandOptions): Promise<unknown>;
	followUp(sessionId: string, message: string, options?: BridgeImageCommandOptions): Promise<unknown>;
	abort(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	abortAndPrompt(sessionId: string, message: string, options?: BridgeImageCommandOptions): Promise<unknown>;
	newSession(sessionId: string, options?: BridgeCommandOptions & { parentSession?: string }): Promise<unknown>;
	getState(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setTodos(sessionId: string, phases: unknown[], options?: BridgeCommandOptions): Promise<unknown>;
	setHostTools(sessionId: string, tools: unknown[], options?: BridgeCommandOptions): Promise<unknown>;
	setHostUriSchemes(sessionId: string, schemes: unknown[], options?: BridgeCommandOptions): Promise<unknown>;
	getPendingWorkflowGates(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setModel(sessionId: string, provider: string, modelId: string, options?: BridgeCommandOptions): Promise<unknown>;
	cycleModel(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getAvailableModels(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setThinkingLevel(sessionId: string, level: string, options?: BridgeCommandOptions): Promise<unknown>;
	cycleThinkingLevel(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setSteeringMode(sessionId: string, mode: "all" | "one-at-a-time", options?: BridgeCommandOptions): Promise<unknown>;
	setFollowUpMode(sessionId: string, mode: "all" | "one-at-a-time", options?: BridgeCommandOptions): Promise<unknown>;
	setInterruptMode(sessionId: string, mode: "immediate" | "wait", options?: BridgeCommandOptions): Promise<unknown>;
	compact(sessionId: string, options?: BridgeCommandOptions & { customInstructions?: string }): Promise<unknown>;
	setAutoCompaction(sessionId: string, enabled: boolean, options?: BridgeCommandOptions): Promise<unknown>;
	setAutoRetry(sessionId: string, enabled: boolean, options?: BridgeCommandOptions): Promise<unknown>;
	abortRetry(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	bash(sessionId: string, command: string, options?: BridgeCommandOptions): Promise<unknown>;
	abortBash(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getSessionStats(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	exportHtml(sessionId: string, options?: BridgeCommandOptions & { outputPath?: string }): Promise<unknown>;
	switchSession(sessionId: string, sessionPath: string, options?: BridgeCommandOptions): Promise<unknown>;
	branch(sessionId: string, entryId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getBranchMessages(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getLastAssistantText(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	setSessionName(sessionId: string, name: string, options?: BridgeCommandOptions): Promise<unknown>;
	handoff(sessionId: string, options?: BridgeCommandOptions & { customInstructions?: string }): Promise<unknown>;
	getMessages(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	getLoginProviders(sessionId: string, options?: BridgeCommandOptions): Promise<unknown>;
	login(sessionId: string, providerId: string, options?: BridgeCommandOptions): Promise<unknown>;
	respondGate(
		sessionId: string,
		gateId: string,
		ownerToken: string,
		answer: unknown,
		options?: BridgeCommandOptions,
	): Promise<unknown>;
}
