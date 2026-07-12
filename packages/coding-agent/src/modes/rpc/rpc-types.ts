/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@gajae-code/agent-core";
import type { CompactionResult } from "@gajae-code/agent-core/compaction";
import type {
	AgentWireActionDenied,
	AgentWireBudgetExceeded,
	AgentWireBudgetMetric,
	AgentWireCapability,
	AgentWireCommand,
	AgentWireCommandAdapters,
	AgentWireGetStateInclude,
	AgentWireHandoffResult,
	AgentWireHostToolCall,
	AgentWireHostToolCancel,
	AgentWireHostToolDefinition,
	AgentWireHostToolResult,
	AgentWireHostToolUpdate,
	AgentWireHostUriCancel,
	AgentWireHostUriRequest,
	AgentWireHostUriResult,
	AgentWireHostUriScheme,
	AgentWireJsonSchema,
	AgentWireResponse,
	AgentWireResponseAdapters,
	AgentWireScopeDenied,
	AgentWireUiRequest,
	AgentWireUiResponse,
	AgentWireUnattendedAccepted,
	AgentWireUnattendedActionClass,
	AgentWireUnattendedDeclaration,
	AgentWireUnattendedRefusalCode,
	AgentWireUnattendedRefused,
	AgentWireWorkflowGate,
	AgentWireWorkflowGateKind,
	AgentWireWorkflowGateResolution,
	AgentWireWorkflowGateResponse,
	AgentWireWorkflowGateValidationError,
	AgentWireWorkflowStage,
} from "@gajae-code/agent-wire";
import type { Effort, ImageContent, Model } from "@gajae-code/ai";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { SessionStats } from "../../session/agent-session";
import type { TodoPhase } from "../../tools/todo-write";

/** JSON grammar is defined by agent-wire; these retain the coding-agent domain adapters. */
export type RpcGetStateInclude = AgentWireGetStateInclude;
export type RpcCapability = AgentWireCapability;
type RpcCommandAdapters = Omit<
	AgentWireCommandAdapters,
	| "image"
	| "todoPhase"
	| "hostTool"
	| "hostUriScheme"
	| "unattendedDeclaration"
	| "workflowGateResponse"
	| "thinkingLevel"
> & {
	image: ImageContent;
	todoPhase: TodoPhase;
	hostTool: AgentWireHostToolDefinition;
	hostUriScheme: AgentWireHostUriScheme;
	unattendedDeclaration: AgentWireUnattendedDeclaration;
	workflowGateResponse: AgentWireWorkflowGateResponse;
	thinkingLevel: ThinkingLevel;
};
export type RpcCommand = AgentWireCommand<AgentWireCommand["type"], RpcCommandAdapters>;

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** Optional static system prompt blocks. Omitted by default; request with get_state include ["systemPrompt"]. */
	systemPrompt?: string[];
	/** Optional static tool schemas. Omitted by default; request with get_state include ["tools"]. */
	dumpTools?: Array<{ name: string; description: string; parameters: unknown }>;
	/** Current context window usage. Null tokens/percent when unknown (e.g. right after compaction). */
	contextUsage?: ContextUsage;
}

/** Coding-agent domain values substituted into agent-wire response DTOs. */
type RpcResponseAdapters = Omit<
	AgentWireResponseAdapters,
	| "sessionState"
	| "todoPhase"
	| "model"
	| "thinkingLevel"
	| "effort"
	| "compactionResult"
	| "bashResult"
	| "sessionStats"
	| "message"
> & {
	sessionState: RpcSessionState;
	todoPhase: TodoPhase;
	model: Model;
	thinkingLevel: ThinkingLevel;
	effort: Effort;
	compactionResult: CompactionResult;
	bashResult: BashResult;
	sessionStats: SessionStats;
	message: AgentMessage;
};

/** JSON response grammar is defined by agent-wire and specialized at the coding-agent boundary. */
export type RpcResponse = AgentWireResponse<RpcResponseAdapters>;

/** @deprecated Use AgentWireHandoffResult from @gajae-code/agent-wire. */
export type RpcHandoffResult = AgentWireHandoffResult;

// ============================================================================
// Shared wire DTO aliases
// ============================================================================

/** @deprecated Use AgentWireUiRequest from @gajae-code/agent-wire. */
export type RpcExtensionUIRequest = AgentWireUiRequest;
/** @deprecated Use AgentWireUiResponse from @gajae-code/agent-wire. */
export type RpcExtensionUIResponse = AgentWireUiResponse;
/** @deprecated Use AgentWireHostToolDefinition from @gajae-code/agent-wire. */
export type RpcHostToolDefinition = AgentWireHostToolDefinition;
/** @deprecated Use AgentWireHostToolCall from @gajae-code/agent-wire. */
export type RpcHostToolCallRequest = AgentWireHostToolCall;
/** @deprecated Use AgentWireHostToolCancel from @gajae-code/agent-wire. */
export type RpcHostToolCancelRequest = AgentWireHostToolCancel;
/** JSON wire DTO adapted to the agent-core tool-result domain at the RPC boundary. */
export type RpcHostToolUpdate = Omit<AgentWireHostToolUpdate, "partialResult"> & {
	partialResult: AgentToolResult<unknown>;
};
/** JSON wire DTO adapted to the agent-core tool-result domain at the RPC boundary. */
export type RpcHostToolResult = Omit<AgentWireHostToolResult, "result"> & { result: AgentToolResult<unknown> };
/** @deprecated Use AgentWireHostUriScheme from @gajae-code/agent-wire. */
export type RpcHostUriSchemeDefinition = AgentWireHostUriScheme;
/** @deprecated Use AgentWireHostUriRequest from @gajae-code/agent-wire. */
export type RpcHostUriRequest = AgentWireHostUriRequest;
/** @deprecated Use AgentWireHostUriCancel from @gajae-code/agent-wire. */
export type RpcHostUriCancelRequest = AgentWireHostUriCancel;
/** @deprecated Use AgentWireHostUriResult from @gajae-code/agent-wire. */
export type RpcHostUriResult = AgentWireHostUriResult;

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// Workflow Gate Contract (#315)
// ============================================================================

/** @deprecated Use AgentWireWorkflowStage from @gajae-code/agent-wire. */
export type RpcWorkflowStage = AgentWireWorkflowStage;

/** Reserved stage names that are explicitly not part of the v1 contract. */
export const RESERVED_WORKFLOW_STAGES: readonly string[] = ["team"];

/** @deprecated Use AgentWireWorkflowGateKind from @gajae-code/agent-wire. */
export type RpcWorkflowGateKind = AgentWireWorkflowGateKind;
/** @deprecated Use AgentWireJsonSchema from @gajae-code/agent-wire. */
export type RpcJsonSchema = AgentWireJsonSchema;
export type RpcWorkflowGateOption = NonNullable<AgentWireWorkflowGate["options"]>[number];
/** @deprecated The workflow-gate context is a JSON object on the wire. */
export type RpcWorkflowGateContext = AgentWireWorkflowGate["context"];
/** @deprecated Use AgentWireWorkflowGate from @gajae-code/agent-wire. */
export type RpcWorkflowGate = AgentWireWorkflowGate;
/** @deprecated Use AgentWireWorkflowGateResponse from @gajae-code/agent-wire. */
export type RpcWorkflowGateResponse = AgentWireWorkflowGateResponse;

/** @deprecated Use AgentWireWorkflowGateResolution from @gajae-code/agent-wire. */
export type RpcWorkflowGateResolution = AgentWireWorkflowGateResolution;

/** @deprecated Use AgentWireWorkflowGateValidationError from @gajae-code/agent-wire. */
export type RpcWorkflowGateValidationError = AgentWireWorkflowGateValidationError;

// ============================================================================
// Unattended Declaration Contract
// ============================================================================

/** @deprecated Use AgentWireUnattendedDeclaration from @gajae-code/agent-wire. */
export type RpcUnattendedDeclaration = AgentWireUnattendedDeclaration;
export type RpcUnattendedBudget = AgentWireUnattendedDeclaration["budget"];

/** @deprecated Use AgentWireUnattendedAccepted from @gajae-code/agent-wire. */
export type RpcUnattendedAccepted = AgentWireUnattendedAccepted;

/** @deprecated Use AgentWireBudgetMetric from @gajae-code/agent-wire. */
export type RpcBudgetMetric = AgentWireBudgetMetric;
/** @deprecated Use AgentWireBudgetExceeded from @gajae-code/agent-wire. */
export type RpcBudgetExceeded = AgentWireBudgetExceeded;
/** @deprecated Use AgentWireUnattendedRefusalCode from @gajae-code/agent-wire. */
export type RpcUnattendedRefusalCode = AgentWireUnattendedRefusalCode;
/** @deprecated Use AgentWireUnattendedRefused from @gajae-code/agent-wire. */
export type RpcUnattendedRefused = AgentWireUnattendedRefused;
/** @deprecated Use AgentWireUnattendedActionClass from @gajae-code/agent-wire. */
export type RpcUnattendedActionClass = AgentWireUnattendedActionClass;
/** @deprecated Use AgentWireScopeDenied from @gajae-code/agent-wire. */
export type RpcScopeDenied = AgentWireScopeDenied;
/** @deprecated Use AgentWireActionDenied from @gajae-code/agent-wire. */
export type RpcActionDenied = AgentWireActionDenied;
