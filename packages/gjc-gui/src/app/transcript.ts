import type {
	GjcEventParams,
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
};

export type ApprovalGate = {
	id: string;
	threadId: string;
	turnId: string;
	tool: string;
	args: JsonValue;
	status: "pending" | "approved" | "rejected" | "cancelled";
	generation: number;
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
		case "gjc/event":
			return foldRawEvent(state, notification.params);
		default:
			return state;
	}
}

export function markApproval(state: TranscriptState, callId: string, status: "approved" | "rejected"): TranscriptState {
	return {
		...state,
		approvals: state.approvals.map(approval => (approval.id === callId ? { ...approval, status } : approval)),
	};
}

function foldTurnStarted(state: TranscriptState, params: TurnStartedParams): TranscriptState {
	return {
		...state,
		activeThreadId: params.threadId,
		activeTurnId: params.turnId,
		seq: Math.max(state.seq, params.seq),
	};
}

function foldTurnCompleted(state: TranscriptState, params: TurnCompletedParams): TranscriptState {
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
	const existing = state.items.find(item => item.id === params.itemId);
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
	let found = false;
	const items = state.items.map(item => {
		if (item.id !== params.itemId) return item;
		found = true;
		return {
			...item,
			role: "assistant" as const,
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
						role: "assistant",
						status: "running",
						content: params.delta,
					},
				],
	};
}

function foldItemCompleted(state: TranscriptState, params: ItemCompletedParams): TranscriptState {
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
		id: params.callId,
		threadId: params.threadId,
		turnId: params.turnId,
		tool: params.tool,
		args: params.args,
		status: "pending",
		generation: params.generation,
	};
	const item: TranscriptItem = {
		id: `tool-${params.callId}`,
		threadId: params.threadId,
		turnId: params.turnId,
		role: "tool",
		status: "running",
		title: params.tool,
		content: contentFromJson(params.args),
		raw: params.args,
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

function foldRawEvent(state: TranscriptState, params: GjcEventParams): TranscriptState {
	const modelLabel = modelFromEvent(params.event) ?? state.modelLabel;
	let next: TranscriptState = { ...state, seq: Math.max(state.seq, params.seq), modelLabel };
	// The server maps every message_start (user AND assistant) to an
	// `agentMessage` item. The user's own message is already rendered from the
	// local echo, so when message_start reveals a user-role message, drop the
	// most recent empty assistant item that was created for it.
	if (params.eventType === "message_start" && messageRoleFromEvent(params.event) === "user") {
		for (let index = next.items.length - 1; index >= 0; index--) {
			const item = next.items[index];
			if (item && item.threadId === params.threadId && item.role === "assistant" && item.content.length === 0) {
				next = { ...next, items: next.items.filter((_, i) => i !== index) };
				break;
			}
		}
	}
	return next;
}

function messageRoleFromEvent(event: JsonValue): string | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const message = (event as Record<string, JsonValue | undefined>).message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
	const role = (message as Record<string, JsonValue | undefined>).role;
	return typeof role === "string" ? role : undefined;
}

function roleFromItemType(itemType: string): ChatRole {
	const normalized = itemType.toLowerCase();
	if (normalized === "agentmessage" || normalized.includes("agent_message") || normalized.includes("assistant"))
		return "assistant";
	if (normalized.includes("tool") || normalized.includes("bash") || normalized.includes("edit")) return "tool";
	if (normalized.includes("reason") || normalized.includes("thinking")) return "reasoning";
	return "event";
}

function titleFromItemType(itemType: string): string {
	const normalized = itemType.toLowerCase();
	if (normalized === "agentmessage" || normalized.includes("agent_message")) return "GJC";
	if (normalized.includes("reason")) return "Reasoning";
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
