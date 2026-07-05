export const DEFAULT_SCROLL_FOLLOW_THRESHOLD = 72;

export function shouldStickToBottom(
	scrollTop: number,
	clientHeight: number,
	scrollHeight: number,
	threshold = DEFAULT_SCROLL_FOLLOW_THRESHOLD,
): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold;
}
