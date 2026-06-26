import type { GjcFrame } from "@gajae-code/rpc-sdk";

export type BridgeFrame<TPayload = unknown> = GjcFrame<TPayload>;

export interface RenderedBridgeFrame {
	seq: number;
	type: string;
	html: string;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function payloadSummary(payload: unknown): string {
	if (!payload || typeof payload !== "object") return String(payload ?? "");
	if ("eventType" in payload && typeof payload.eventType === "string") return payload.eventType;
	if ("event_type" in payload && typeof payload.event_type === "string") return payload.event_type;
	if ("kind" in payload && typeof payload.kind === "string") return payload.kind;
	if ("command" in payload && typeof payload.command === "string") return payload.command;
	return JSON.stringify(payload);
}

export function renderBridgeFrame(frame: BridgeFrame): RenderedBridgeFrame {
	const summary = escapeHtml(payloadSummary(frame.payload));
	const correlation = frame.correlationId ? ` data-correlation="${escapeHtml(frame.correlationId)}"` : "";
	return {
		seq: frame.seq,
		type: frame.type,
		html: `<article class="bridge-frame bridge-frame-${escapeHtml(frame.type)}" data-seq="${frame.seq}"${correlation}><h3>${escapeHtml(frame.type)}</h3><pre>${summary}</pre></article>`,
	};
}

export class ReferenceBridgeConsumer {
	#frames: RenderedBridgeFrame[] = [];

	consume(frame: BridgeFrame): RenderedBridgeFrame {
		const rendered = renderBridgeFrame(frame);
		this.#frames.push(rendered);
		return rendered;
	}

	renderDocument(): string {
		return `<!doctype html><html><body>${this.#frames.map(frame => frame.html).join("")}</body></html>`;
	}
}
