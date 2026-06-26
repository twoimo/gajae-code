import type { Cursor, GjcFrame } from "../protocol/types";
import type { UdsTransport } from "../transport/uds";

export type EventFilter = (frame: GjcFrame<unknown>) => boolean;
export interface EventSubscription { unsubscribe(): void; cursor(): Cursor | undefined }
export class EventStream {
	#cursor: Cursor | undefined;
	constructor(readonly transport: UdsTransport) {}
	subscribe(onFrame: (frame: GjcFrame<unknown>) => void, filter: EventFilter = () => true): EventSubscription { const handler = (frame: GjcFrame<unknown>) => { this.#cursor = { sessionId: frame.sessionId, seq: frame.seq }; if (filter(frame)) onFrame(frame); }; this.transport.on("frame", handler); return { unsubscribe: () => this.transport.off("frame", handler), cursor: () => this.#cursor }; }
	cursor(): Cursor | undefined { return this.#cursor; }
}
