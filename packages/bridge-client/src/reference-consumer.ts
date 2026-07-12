import type { AgentWireEnvelope } from "@gajae-code/agent-wire";

/** @deprecated Use AgentWireEnvelope from @gajae-code/agent-wire. */
export type BridgeFrame<TPayload = unknown> = Omit<AgentWireEnvelope, "payload"> & { payload: TPayload };

export interface RenderedBridgeFrame {
	html: string;
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function payloadSummary(payload: unknown): string {
	return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

export function renderBridgeFrame(frame: BridgeFrame): RenderedBridgeFrame {
	const correlation = frame.correlation_id ? ` data-correlation="${escapeHtml(frame.correlation_id)}"` : "";
	return {
		html: `<article class="bridge-frame bridge-frame-${escapeHtml(frame.type)}"${correlation}><h2>${escapeHtml(frame.type)} #${frame.seq}</h2><pre>${escapeHtml(payloadSummary(frame.payload))}</pre></article>`,
	};
}

export class ReferenceBridgeConsumer {
	#frames: BridgeFrame[] = [];

	consume(frame: BridgeFrame): void {
		this.#frames.push(frame);
	}

	renderDocument(): string {
		return `<!doctype html><html><body>${this.#frames.map(frame => renderBridgeFrame(frame).html).join("\n")}</body></html>`;
	}
}
