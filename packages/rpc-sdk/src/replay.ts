import type { Cursor, GjcFrame } from "./protocol/types";
import type { UdsTransport } from "./transport/uds";

export interface ReplaySubscription { cursor: Cursor; limit?: number }

export function cursorAfter(frame: GjcFrame<unknown>): Cursor { return { sessionId: frame.sessionId, seq: frame.seq }; }

export function rememberReplayCursor(previous: Cursor | undefined, frame: GjcFrame<unknown>): Cursor {
	const next = cursorAfter(frame);
	if (!previous || previous.sessionId !== next.sessionId || next.seq >= previous.seq) return next;
	return previous;
}

export async function reconnectFromCursor(transport: UdsTransport, cursor: Cursor | undefined): Promise<void> {
	transport.setCursor(cursor);
	await transport.reconnect();
}
