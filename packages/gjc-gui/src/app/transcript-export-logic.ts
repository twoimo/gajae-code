import { cleanAssistantText, type TranscriptItem } from "./transcript";

function exportContent(item: TranscriptItem): string {
	return item.role === "assistant" || item.role === "reasoning" ? cleanAssistantText(item.content) : item.content;
}

export function lastAssistantText(items: TranscriptItem[]): string | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item.role !== "assistant") continue;
		const content = cleanAssistantText(item.content);
		if (content.trim().length > 0) return content;
	}
	return undefined;
}

export function serializeTranscript(items: TranscriptItem[]): string {
	return items
		.map(item => {
			const content = exportContent(item);
			if (content.trim().length === 0) return undefined;
			return `${item.role.toUpperCase()}[/${item.status}]: ${content}`;
		})
		.filter((block): block is string => block !== undefined)
		.join("\n\n");
}
