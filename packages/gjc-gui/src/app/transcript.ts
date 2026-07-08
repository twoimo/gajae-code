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
	modelLabel: "",
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

export function mergeWorkflowGateApprovals(approvals: ApprovalGate[], threadId: string, gates: Array<Record<string, JsonValue | undefined>>): ApprovalGate[] {
	let next = approvals;
	for (const gate of gates) {
		if (typeof gate.gate_id !== "string") continue;
		const approval: Extract<ApprovalGate, { kind: "workflow-gate" }> = {
			kind: "workflow-gate",
			id: gate.gate_id,
			threadId,
			gateKind: gate.kind === "question" || gate.kind === "execution" ? gate.kind : "approval",
			stage: gate.stage === "deep-interview" || gate.stage === "ultragoal" ? gate.stage : "ralplan",
			required: gate.required !== false,
			schema: gate.schema ?? {},
			options: Array.isArray(gate.options) ? gate.options as Extract<ApprovalGate, { kind: "workflow-gate" }>["options"] : undefined,
			context: gate.context && typeof gate.context === "object" && !Array.isArray(gate.context) ? gate.context : {},
			status: "pending",
			generation: 0,
		};
		next = next.some(existing => existing.kind === "workflow-gate" && existing.id === approval.id)
			? next.map(existing => existing.kind === "workflow-gate" && existing.id === approval.id && existing.status === "pending" ? { ...existing, ...approval, generation: existing.generation } : existing)
			: [...next, approval];
	}
	return next;
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
	if (params.eventType === "tool_execution_update") {
		next = foldToolDetail(next, params.event, "update");
	}
	if (params.eventType === "tool_execution_end") {
		next = foldToolDetail(next, params.event, "end");
	}
	const lifecycle = lifecycleStatusText(params.eventType, params.event);
	if (lifecycle) {
		next = appendStatusItem(next, params.threadId, params.eventType, lifecycle);
	}
	return next;
}

function appendStatusItem(state: TranscriptState, threadId: string, eventType: string, content: string): TranscriptState {
	return {
		...state,
		items: [
			...state.items,
			{
				id: `event-${eventType}-${state.seq}`,
				threadId,
				turnId: state.activeTurnId,
				role: "event",
				status: "completed",
				title: lifecycleTitle(eventType),
				content,
			},
		],
	};
}

function lifecycleTitle(eventType: string): string {
	switch (eventType) {
		case "auto_retry_start":
		case "auto_retry_end":
			return "Retry";
		case "ttsr_triggered":
			return "Recovery";
		case "notice":
			return "Notice";
		case "auto_compaction_end":
			return "Compaction";
		case "todo_reminder":
			return "Todo reminder";
		case "todo_auto_clear":
			return "Todo auto-clear";
		default:
			return eventType.replaceAll("_", " ");
	}
}

function lifecycleStatusText(eventType: string, event: JsonValue): string | undefined {
	if (!["auto_retry_start", "auto_retry_end", "ttsr_triggered", "notice", "auto_compaction_end", "todo_reminder", "todo_auto_clear"].includes(eventType)) return undefined;
	const payload = eventRecord(event);
	const label = lifecycleTitle(eventType);
	const message = firstEventString(payload, "message", "description", "notice", "reason", "summary", "status") ?? toolText(event);
	const countdown = firstEventString(payload, "countdown", "delay", "retryIn", "retry_in", "seconds");
	const suffix = countdown ? `${message} (${countdown})` : message;
	return `${label}: ${suffix}`;
}

function firstEventString(payload: Record<string, JsonValue | undefined>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = payload[key];
		if (typeof value === "string" && value.length > 0) return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
	}
	return undefined;
}

function eventRecord(event: JsonValue): Record<string, JsonValue | undefined> {
	return event && typeof event === "object" && !Array.isArray(event) ? event as Record<string, JsonValue | undefined> : {};
}


const TOOL_OUTPUT_TAIL_CAP = 8000;

function foldToolDetail(state: TranscriptState, event: JsonValue, phase: "start" | "update" | "end"): TranscriptState {
	if (!event || typeof event !== "object" || Array.isArray(event)) return state;
	const payload = event as Record<string, JsonValue | undefined>;
	const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
	if (!callId) return state;
	const name = typeof payload.toolName === "string" ? payload.toolName : undefined;
	const args = phase === "start" ? toolText(payload.args ?? payload.arguments ?? payload.input) : undefined;
	const outputMode = isToolResultSnapshot(payload.partialResult) ? "snapshot" : "append";
	const output = phase !== "start" ? toolResultText(payload.partialResult) || toolText(payload.result ?? payload.output ?? payload.delta ?? payload.content ?? payload.progress) : undefined;
	const error = phase === "end" ? toolText(payload.error) : undefined;
	const detail = phase === "start" ? (args ? `args:\n${args}` : "") : toolUpdateText(payload, phase);
	if (!detail && !name) return state;
	const isError = payload.isError === true || payload.error !== undefined;
	return {
		...state,
		items: state.items.map(item =>
			item.id === callId || item.id === `tool-${callId}`
				? {
						...item,
						content: detail ? mergeToolContent(item.content, detail, phase, outputMode) : item.content,
						status: phase === "end" ? (isError ? "error" : "completed") : item.status,
						tool: {
							name: item.tool?.name ?? name ?? item.title ?? "tool",
							args: args ?? item.tool?.args,
							output: output ? mergeToolOutput(item.tool?.output, output, outputMode) : item.tool?.output,
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

function toolResultText(value: JsonValue | undefined): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const content = (value as Record<string, JsonValue | undefined>).content;
	if (!Array.isArray(content)) return toolText(value);
	return content
		.map(part => {
			if (!part || typeof part !== "object" || Array.isArray(part)) return "";
			const record = part as Record<string, JsonValue | undefined>;
			if (typeof record.text === "string") return record.text;
			return toolText(part);
		})
		.filter(text => text.length > 0)
		.join("");
}

function isToolResultSnapshot(value: JsonValue | undefined): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Array.isArray((value as Record<string, JsonValue | undefined>).content);
}

function tailToolOutput(text: string): string {
	return text.length > TOOL_OUTPUT_TAIL_CAP ? text.slice(-TOOL_OUTPUT_TAIL_CAP) : text;
}

function mergeToolOutput(existing: string | undefined, next: string, mode: "snapshot" | "append"): string {
	if (!existing || mode === "snapshot") return tailToolOutput(next);
	return tailToolOutput(`${existing}\n${next}`);
}

function labeledToolText(label: string, value: JsonValue | undefined): string {
	const text = toolText(value);
	return text ? `${label}:\n${text}` : "";
}


function toolUpdateText(payload: Record<string, JsonValue | undefined>, phase: "update" | "end"): string {
	const resultText = toolResultText(payload.partialResult) || toolText(payload.result ?? payload.output ?? payload.delta ?? payload.content ?? payload.progress);
	const chunks = [
		resultText ? `${phase === "update" ? "update" : "output"}:\n${resultText}` : "",
		labeledToolText("status", payload.status),
		labeledToolText("subagent", payload.agent ?? payload.subagent ?? payload.description),
		phase === "end" ? labeledToolText("error", payload.error) : "",
	].filter(chunk => chunk.length > 0);
	return Array.from(new Set(chunks)).join("\n");
}

function mergeToolContent(content: string, detail: string, phase: "start" | "update" | "end", mode: "snapshot" | "append"): string {
	if (phase === "start") return tailToolOutput(detail);
	if (!content) return tailToolOutput(detail);
	if (mode === "snapshot") {
		const outputIndex = firstToolOutputBlockIndex(content);
		const prefix = outputIndex === undefined ? "" : content.slice(0, outputIndex).trimEnd();
		return tailToolOutput(prefix ? `${prefix}\n${detail}` : detail);
	}
	return tailToolOutput(`${content}\n${detail}`);
}

function firstToolOutputBlockIndex(content: string): number | undefined {
	if (content.startsWith("update:\n") || content.startsWith("output:\n")) return 0;
	const updateIndex = content.indexOf("\nupdate:\n");
	const outputIndex = content.indexOf("\noutput:\n");
	if (updateIndex === -1) return outputIndex === -1 ? undefined : outputIndex;
	if (outputIndex === -1) return updateIndex;
	return Math.min(updateIndex, outputIndex);
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
	const record = state as Record<string, JsonValue | undefined>;
	const model = record.model;
	if (typeof model === "string" && model.length > 0) return model;
	if (model && typeof model === "object" && !Array.isArray(model)) {
		const m = model as Record<string, JsonValue | undefined>;
		const id = m.id ?? m.modelId;
		const provider = m.provider;
		if (typeof id === "string" && id.length > 0) {
			return typeof provider === "string" && provider.length > 0 ? `${provider}/${id}` : id;
		}
		const name = m.name;
		if (typeof name === "string" && name.length > 0) return name;
	}
	// Fall back to the catalog-style activeProvider/activeModelId fields.
	const activeProvider = record.activeProvider;
	const activeModelId = record.activeModelId;
	if (typeof activeModelId === "string" && activeModelId.length > 0) {
		return typeof activeProvider === "string" && activeProvider.length > 0
			? `${activeProvider}/${activeModelId}`
			: activeModelId;
	}
	return undefined;
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
