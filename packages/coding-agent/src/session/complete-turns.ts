import type { SessionEntry } from "./session-manager";

function assistantToolCallIds(entry: SessionEntry): Set<string> | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;

	const toolCallIds = entry.message.content.filter(content => content.type === "toolCall").map(content => content.id);
	return new Set(toolCallIds);
}

function isConversationInput(entry: SessionEntry): boolean {
	return (
		entry.type === "message" &&
		(entry.message.role === "user" || entry.message.role === "developer" || entry.message.role === "fileMention")
	);
}

export interface CompleteTurnPrefixOptions {
	/** ACP forks may preserve one idle, persisted user input after a completed turn. */
	includeTrailingUserInput?: boolean;
}

function isUserInput(entry: SessionEntry | undefined): boolean {
	return entry?.type === "message" && entry.message.role === "user";
}

/**
 * Select the longest history prefix that does not end in an incomplete conversation turn.
 * Session metadata preceding or attached to a completed turn remains in the prefix.
 */
export function selectCompleteTurnPrefix(
	entries: SessionEntry[],
	options: CompleteTurnPrefixOptions = {},
): SessionEntry[] {
	let completePrefixEnd = 0;
	let hasIncompleteTurn = false;
	let outstandingToolCallIds: Set<string> | undefined;

	for (const [index, entry] of entries.entries()) {
		if (isConversationInput(entry)) {
			hasIncompleteTurn = true;
			outstandingToolCallIds = undefined;
			continue;
		}

		const toolCallIds = assistantToolCallIds(entry);
		if (toolCallIds) {
			hasIncompleteTurn = toolCallIds.size > 0;
			outstandingToolCallIds = toolCallIds.size > 0 ? toolCallIds : undefined;
			if (!hasIncompleteTurn) completePrefixEnd = index + 1;
			continue;
		}

		if (entry.type === "message" && entry.message.role === "toolResult" && outstandingToolCallIds) {
			outstandingToolCallIds.delete(entry.message.toolCallId);
			if (outstandingToolCallIds.size === 0) {
				hasIncompleteTurn = false;
				outstandingToolCallIds = undefined;
				completePrefixEnd = index + 1;
			}
			continue;
		}

		if (!hasIncompleteTurn) completePrefixEnd = index + 1;
	}

	if (options.includeTrailingUserInput && entries.length === completePrefixEnd + 1 && isUserInput(entries.at(-1))) {
		return entries;
	}
	return entries.slice(0, completePrefixEnd);
}
