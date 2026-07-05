import type {
	GjcEventParams,
	HostUriCancelParams,
	HostUriRequestParams,
	HostToolsCallParams,
	HostToolsCancelParams,
	ItemAgentMessageDeltaParams,
	ItemCompletedParams,
	ItemStartedParams,
	JsonValue,
	ServerNotificationEnvelope,
	ThreadSummary,
	TurnCompletedParams,
	TurnStartedParams,
	WorkflowGateOpenedParams,
} from "@gajae-code/app-server-client";

export type ChatRole = "user" | "assistant" | "reasoning" | "tool" | "event";
export type ChatItemStatus = "running" | "success" | "error" | "completed" | "interrupted";

export type TranscriptItem = {
	id: string;
	threadId: string;
	turnId?: string;
	role: ChatRole;
	status: ChatItemStatus;
	title?: string;
	content: string;
	raw?: JsonValue;
	tool?: { name: string; args?: string; output?: string; error?: string };
};

export type ApprovalGateStatus = "pending" | "approved" | "rejected" | "cancelled" | "failed";

export type ApprovalGate =
	| {
			kind: "host-tool";
			id: string;
			threadId: string;
			turnId: string;
			tool: string;
			args: JsonValue;
			status: ApprovalGateStatus;
			generation: number;
		}
	| {
			kind: "host-uri";
			id: string;
			threadId: string;
			turnId: string;
			operation: HostUriRequestParams["operation"];
			url: string;
			content?: string | null;
			status: ApprovalGateStatus;
			generation: number;
		}
	| {
			kind: "workflow-gate";
			id: string;
			threadId: string;
			gateKind: WorkflowGateOpenedParams["kind"];
			stage: WorkflowGateOpenedParams["stage"];
			required: boolean;
			schema: JsonValue;
			options?: WorkflowGateOpenedParams["options"];
			context: WorkflowGateOpenedParams["context"];
			status: ApprovalGateStatus;
			generation: number;
			error?: string;
		};

export type ThreadView = {
	id: string;
	title: string;
	status: ThreadSummary["status"] | "error";
	modelLabel?: string;
	lastActivity: string;
	cwd?: string;
};

export type TranscriptState = {
	activeThreadId?: string;
	activeTurnId?: string;
	threads: ThreadView[];
	items: TranscriptItem[];
	approvals: ApprovalGate[];
	seq: number;
	modelLabel: string;
};

export const emptyTranscriptState = (): TranscriptState => ({
	threads: [],
	items: [],
	approvals: [],
	seq: 0,
	modelLabel: "model pending",
});

export function upsertThread(state: TranscriptState, thread: ThreadSummary, cwd?: string): TranscriptState {
	const existing = state.threads.find(candidate => candidate.id === thread.id);
	const next: ThreadView = {
		id: thread.id,
		title: titleFromThread(thread),
		status: thread.status,
		modelLabel: modelLabelFromMetadata(thread),
		lastActivity: thread.status,
		cwd: cwd ?? existing?.cwd,
	};
	const threads = existing
		? state.threads.map(candidate => (candidate.id === thread.id ? { ...candidate, ...next } : candidate))
		: [next, ...state.threads];
	return { ...state, activeThreadId: thread.id, threads, modelLabel: next.modelLabel ?? state.modelLabel };
}

export function appendLocalUserMessage(state: TranscriptState, threadId: string, content: string): TranscriptState {
	return {
		...state,
		items: [
			...state.items,
			{
				id: `local-user-${Date.now()}`,
				threadId,
				role: "user",
				status: "completed",
				content,
			},
		],
	};
}

export function foldNotification(state: TranscriptState, notification: ServerNotificationEnvelope): TranscriptState {
	if (
		notification.method !== "turn/started" &&
		"params" in notification &&
		hasThreadId(notification.params) &&
		!isKnownThread(state, notification.params.threadId)
	) {
		return state;
	}
	switch (notification.method) {
		case "turn/started":
			return foldTurnStarted(state, notification.params);
		case "turn/completed":
			return foldTurnCompleted(state, notification.params);
		case "item/started":
			return foldItemStarted(state, notification.params);
		case "item/agentMessage/delta":
			return foldItemDelta(state, notification.params);
		case "item/completed":
			return foldItemCompleted(state, notification.params);
		case "gjc/hostTools/call":
			return foldHostToolCall(state, notification.params);
		case "gjc/hostTools/cancel":
			return foldHostToolCancel(state, notification.params);
		case "gjc/hostUris/request":
			return foldHostUriRequest(state, notification.params);
		case "gjc/hostUris/cancel":
			return foldHostUriCancel(state, notification.params);
		case "gjc/workflowGate/opened":
			return foldWorkflowGateOpened(state, notification.params);
		case "gjc/event":
			return foldRawEvent(state, notification.params);
		default:
			return state;
	}
}

export function markApproval(state: TranscriptState, callId: string, status: "approved" | "rejected" | "cancelled"): TranscriptState {
	return {
		...state,
		approvals: state.approvals.map(approval => (approval.id === callId ? { ...approval, status } : approval)),
	};
}

function hasThreadId(params: unknown): params is { threadId: string } {
	return Boolean(params && typeof params === "object" && typeof (params as { threadId?: unknown }).threadId === "string");
}

function isKnownThread(state: TranscriptState, threadId: string): boolean {
	return state.activeThreadId === threadId || state.threads.some(thread => thread.id === threadId);
}

function isKnownInactiveThread(state: TranscriptState, threadId: string): boolean {
	return state.activeThreadId !== undefined && state.activeThreadId !== threadId && state.threads.some(thread => thread.id === threadId);
}

function isFinalized(status: ChatItemStatus): boolean {
	return status !== "running";
}

export function cleanAssistantText(text: string): string {
	return stripToolCallJson(text)
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function stripToolCallJson(text: string): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const start = text.indexOf("{", index);
		if (start < 0) return output + text.slice(index);
		output += text.slice(index, start);
		const end = matchingJsonObjectEnd(text, start);
		if (end < 0) {
			output += text.slice(start);
			return output;
		}
		const candidate = text.slice(start, end + 1);
		if (candidate.includes('"_i"')) {
			try {
				const parsed = JSON.parse(candidate) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "_i" in parsed) {
					index = end + 1;
					continue;
				}
			} catch {
				// Keep malformed prose intact.
			}
		}
		output += candidate;
		index = end + 1;
	}
	return output;
}

function matchingJsonObjectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function foldTurnStarted(state: TranscriptState, params: TurnStartedParams): TranscriptState {
	if (isKnownInactiveThread(state, params.threadId)) return { ...state, seq: Math.max(state.seq, params.seq) };
	return {
		...state,
		activeThreadId: params.threadId,
		activeTurnId: params.turnId,
		seq: Math.max(state.seq, params.seq),
	};
}

function foldTurnCompleted(state: TranscriptState, params: TurnCompletedParams): TranscriptState {
	if (isKnownInactiveThread(state, params.threadId)) return { ...state, seq: Math.max(state.seq, params.seq) };
	const status = normalizeStatus(params.status);
	return {
		...state,
		activeTurnId: state.activeTurnId === params.turnId ? undefined : state.activeTurnId,
		seq: Math.max(state.seq, params.seq),
		items: state.items.map(item =>
			item.threadId === params.threadId &&
			(!params.turnId || item.turnId === params.turnId) &&
			item.status === "running"
				? { ...item, status }
				: item,
		),
	};
}

function foldItemStarted(state: TranscriptState, params: ItemStartedParams): TranscriptState {
	if (isKnownInactiveThread(state, params.threadId)) return { ...state, seq: Math.max(state.seq, params.seq) };
	const existing = state.items.find(item => item.id === params.itemId);
	if (existing && isFinalized(existing.status)) return { ...state, seq: Math.max(state.seq, params.seq) };
	const role = roleFromItemType(params.itemType);
	const initialContent = role === "assistant" && params.content === undefined ? "" : contentFromJson(params.content);
	const nextItem: TranscriptItem = {
		id: params.itemId,
		threadId: params.threadId,
		turnId: state.activeTurnId,
		role,
		status: "running",
		title: params.toolName ?? titleFromItemType(params.itemType),
		content: initialContent,
		raw: params.content,
	};
	return {
		...state,
		seq: Math.max(state.seq, params.seq),
		items: existing
			? state.items.map(item =>
					item.id === params.itemId
						? { ...item, ...nextItem, content: item.content || nextItem.content, raw: item.raw ?? nextItem.raw }
						: item,
				)
			: [...state.items, nextItem],
	};
}

function foldItemDelta(state: TranscriptState, params: ItemAgentMessageDeltaParams): TranscriptState {
	if (isKnownInactiveThread(state, params.threadId)) return { ...state, seq: Math.max(state.seq, params.seq) };
	let found = false;
	const items = state.items.map(item => {
		if (item.id !== params.itemId) return item;
		found = true;
		if (isFinalized(item.status)) return item;
		return {
			...item,
			// Preserve the item's role (e.g. reasoning) instead of forcing
			// assistant — thinking deltas target a separate reasoning item.
			status: "running" as const,
			content: `${item.content}${params.delta}`,
		};
	});
	return {
		...state,
		seq: Math.max(state.seq, params.seq),
		items: found
			? items
			: [
					...items,
					{
						id: params.itemId,
						threadId: params.threadId,
						turnId: state.activeTurnId,
						role: "assistant",
						status: "running",
						content: params.delta,
					},
				],
	};
}

function foldItemCompleted(state: TranscriptState, params: ItemCompletedParams): TranscriptState {
	if (isKnownInactiveThread(state, params.threadId)) return { ...state, seq: Math.max(state.seq, params.seq) };
	return {
		...state,
		seq: Math.max(state.seq, params.seq),
		items: state.items.map(item =>
			item.id === params.itemId ? { ...item, status: item.status === "error" ? item.status : "completed" } : item,
		),
	};
}

function foldHostToolCall(state: TranscriptState, params: HostToolsCallParams): TranscriptState {
	const approval: ApprovalGate = {
		kind: "host-tool",
		id: params.callId,
		threadId: params.threadId,
		turnId: params.turnId,
		tool: params.tool,
		args: params.args,
		status: "pending",
		generation: params.generation,
	};
	const args = toolText(params.args);
	const item: TranscriptItem = {
		id: `tool-${params.callId}`,
		threadId: params.threadId,
		turnId: params.turnId,
		role: "tool",
		status: "running",
		title: params.tool,
		content: labeledToolText("args", params.args),
		raw: params.args,
		tool: { name: params.tool, args },
	};
	return {
		...state,
		approvals: state.approvals.some(existing => existing.id === params.callId)
			? state.approvals.map(existing => (existing.id === params.callId ? approval : existing))
			: [...state.approvals, approval],
		items: state.items.some(existing => existing.id === item.id)
			? state.items.map(existing => (existing.id === item.id ? item : existing))
			: [...state.items, item],
	};
}

function foldHostToolCancel(state: TranscriptState, params: HostToolsCancelParams): TranscriptState {
	return {
		...state,
		approvals: state.approvals.map(approval =>
			approval.id === params.callId ? { ...approval, status: "cancelled" } : approval,
		),
		items: state.items.map(item => (item.id === `tool-${params.callId}` ? { ...item, status: "interrupted" } : item)),
	};
}

function foldHostUriRequest(state: TranscriptState, params: HostUriRequestParams): TranscriptState {
	const existing = state.approvals.find(approval => approval.kind === "host-uri" && approval.id === params.requestId);
	if (existing && params.generation < existing.generation) return state;
	const approval: ApprovalGate = {
		kind: "host-uri",
		id: params.requestId,
		threadId: params.threadId,
		turnId: params.turnId,
		operation: params.operation,
		url: params.url,
		content: params.content,
		status: "pending",
		generation: params.generation,
	};
	return {
		...state,
		approvals: state.approvals.some(existing => existing.id === params.requestId)
			? state.approvals.map(existing => (existing.id === params.requestId ? approval : existing))
			: [...state.approvals, approval],
	};
}

function foldHostUriCancel(state: TranscriptState, params: HostUriCancelParams): TranscriptState {
	const existing = state.approvals.find(approval => approval.kind === "host-uri" && approval.id === params.requestId);
	if (existing && params.generation < existing.generation) return state;
	return {
		...state,
		approvals: state.approvals.map(approval =>
			approval.kind === "host-uri" && approval.id === params.requestId ? { ...approval, status: "cancelled" } : approval,
		),
	};
}

function foldWorkflowGateOpened(state: TranscriptState, params: WorkflowGateOpenedParams): TranscriptState {
	const existing = state.approvals.find(approval => approval.kind === "workflow-gate" && approval.id === params.gate_id);
	if (existing && params.generation < existing.generation) return state;
	const approval: ApprovalGate = {
		kind: "workflow-gate",
		id: params.gate_id,
		threadId: params.threadId,
		gateKind: params.kind,
		stage: params.stage,
		required: params.required,
		schema: params.schema,
		options: params.options,
		context: params.context,
		status: "pending",
		generation: params.generation,
	};
	return {
		...state,
		approvals: state.approvals.some(existing => existing.id === params.gate_id)
			? state.approvals.map(existing => (existing.id === params.gate_id ? approval : existing))
			: [...state.approvals, approval],
	};
}

function foldRawEvent(state: TranscriptState, params: GjcEventParams): TranscriptState {
	if (isKnownInactiveThread(state, params.threadId)) return { ...state, seq: Math.max(state.seq, params.seq) };
	const modelLabel = modelFromEvent(params.event) ?? state.modelLabel;
	let next: TranscriptState = { ...state, seq: Math.max(state.seq, params.seq), modelLabel };
	// The server maps every message_start (user AND assistant) to an
	// `agentMessage` item. The user's own message is already rendered from the
	// local echo, so when message_start reveals a user-role message, drop only
	// the matching empty assistant echo in the active/known thread.
	if (params.eventType === "message_start" && messageRoleFromEvent(params.event) === "user") {
		const messageText = messageTextFromEvent(params.event);
		const hasMatchingLocalUser = next.items.some(
			item => item.threadId === params.threadId && item.role === "user" && item.content === messageText,
		);
		if (messageText && hasMatchingLocalUser) {
			const index = next.items.findIndex(
				item => item.threadId === params.threadId && item.role === "assistant" && item.content.length === 0,
			);
			if (index >= 0) next = { ...next, items: next.items.filter((_, i) => i !== index) };
		}
	}
	if (params.eventType === "tool_execution_start") {
		next = foldToolDetail(next, params.event, "start");
	}
	if (params.eventType === "tool_execution_end") {
		next = foldToolDetail(next, params.event, "end");
	}
	return next;
}

function foldToolDetail(state: TranscriptState, event: JsonValue, phase: "start" | "end"): TranscriptState {
	if (!event || typeof event !== "object" || Array.isArray(event)) return state;
	const payload = event as Record<string, JsonValue | undefined>;
	const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
	if (!callId) return state;
	const name = typeof payload.toolName === "string" ? payload.toolName : undefined;
	const args = phase === "start" ? toolText(payload.args ?? payload.arguments ?? payload.input) : undefined;
	const output = phase === "end" ? toolText(payload.result ?? payload.output) : undefined;
	const error = phase === "end" ? toolText(payload.error) : undefined;
	const detail = phase === "start" ? (args ? `args:\n${args}` : "") : toolEndText(payload);
	if (!detail && !name) return state;
	const isError = payload.isError === true || payload.error !== undefined;
	return {
		...state,
		items: state.items.map(item =>
			item.id === callId || item.id === `tool-${callId}`
				? {
						...item,
						content: detail ? (phase === "start" ? detail : item.content ? `${item.content}\n${detail}` : detail) : item.content,
						status: phase === "end" ? (isError ? "error" : "completed") : item.status,
						tool: {
							name: item.tool?.name ?? name ?? item.title ?? "tool",
							args: args ?? item.tool?.args,
							output: output ?? item.tool?.output,
							error: error ?? item.tool?.error,
						},
					}
				: item,
		),
	};
}

function toolText(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function labeledToolText(label: string, value: JsonValue | undefined): string {
	const text = toolText(value);
	return text ? `${label}:\n${text}` : "";
}


function toolEndText(payload: Record<string, JsonValue | undefined>): string {
	const chunks = [
		labeledToolText("output", payload.result ?? payload.output),
		labeledToolText("error", payload.error),
	].filter(chunk => chunk.length > 0);
	return Array.from(new Set(chunks)).join("\n");
}

function messageRoleFromEvent(event: JsonValue): string | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const message = (event as Record<string, JsonValue | undefined>).message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const role = (message as Record<string, JsonValue | undefined>).role;
	return typeof role === "string" ? role : undefined;
}

function messageTextFromEvent(event: JsonValue): string {
	if (!event || typeof event !== "object" || Array.isArray(event)) return "";
	const message = (event as Record<string, JsonValue | undefined>).message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return "";
	const content = (message as Record<string, JsonValue | undefined>).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (!part || typeof part !== "object" || Array.isArray(part)) return "";
			const text = (part as Record<string, JsonValue | undefined>).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function roleFromItemType(itemType: string): ChatRole {
	const normalized = itemType.toLowerCase();
	if (normalized === "agentmessage" || normalized.includes("agent_message") || normalized.includes("assistant"))
		return "assistant";
	if (normalized.includes("reason") || normalized.includes("thinking")) return "reasoning";
	// App-server tool item kinds: commandExecution, fileChange, mcpToolCall, toolCall.
	if (
		normalized.includes("tool") ||
		normalized.includes("command") ||
		normalized.includes("bash") ||
		normalized.includes("exec") ||
		normalized.includes("file") ||
		normalized.includes("edit") ||
		normalized.includes("mcp")
	)
		return "tool";
	return "event";
}

function titleFromItemType(itemType: string): string {
	const normalized = itemType.toLowerCase();
	if (normalized === "agentmessage" || normalized.includes("agent_message") || normalized.includes("assistant"))
		return "gajae";
	if (normalized.includes("reason") || normalized.includes("thinking")) return "Thinking";
	if (normalized === "commandexecution") return "Shell";
	if (normalized === "filechange") return "File change";
	if (normalized === "mcptoolcall") return "MCP tool";
	if (normalized === "toolcall") return "Tool";
	return itemType.replaceAll("_", " ");
}

function normalizeStatus(status: string): ChatItemStatus {
	if (status === "failed") return "error";
	if (status === "interrupted") return "interrupted";
	return "completed";
}

function contentFromJson(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function titleFromThread(thread: ThreadSummary): string {
	const sessionId = metadataString(thread, "sessionId");
	return sessionId ? `Session ${sessionId}` : `Thread ${thread.id}`;
}

/**
 * Derive a compact model label from a `gjc/state/read` result, whose `model`
 * is an object like `{ id, name, provider, ... }`.
 */
export function modelLabelFromStateRead(state: JsonValue): string | undefined {
	if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
	const model = (state as Record<string, JsonValue | undefined>).model;
	if (typeof model === "string" && model.length > 0) return model;
	if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
	const record = model as Record<string, JsonValue | undefined>;
	const id = record.id ?? record.modelId;
	if (typeof id === "string" && id.length > 0) return id;
	const name = record.name;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

function modelLabelFromMetadata(thread: ThreadSummary): string | undefined {
	const model = thread.turns?.length ? undefined : undefined;
	return metadataString(thread, "model") ?? model;
}

function metadataString(thread: ThreadSummary, key: string): string | undefined {
	const metadata = (thread as { metadata?: Record<string, JsonValue | undefined> }).metadata;
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function modelFromEvent(event: JsonValue): string | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const record = event as Record<string, JsonValue | undefined>;
	const model = record.model ?? record.modelId ?? record.provider;
	return typeof model === "string" ? model : undefined;
}
