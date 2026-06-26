import { describe, expect, it } from "bun:test";
import { ReferenceBridgeConsumer, renderBridgeFrame, type BridgeFrame } from "../src/reference-consumer";

function frame(fields: Pick<BridgeFrame, "seq" | "frameId" | "type" | "payload"> & Partial<BridgeFrame>): BridgeFrame {
	return {
		protocolVersion: 1,
		sessionId: "sess-1",
		direction: "server_to_client",
		kind: "event",
		replay: false,
		...fields,
	};
}

describe("reference bridge consumer", () => {
	it("renders event, permission, and response frames as semantic HTML", () => {
		const consumer = new ReferenceBridgeConsumer();
		consumer.consume(
			frame({
				seq: 1,
				frameId: "frame-1",
				type: "event",
				payload: { eventType: "message_update", event: { type: "message_update" } },
			}),
		);
		consumer.consume(
			frame({
				seq: 2,
				frameId: "frame-2",
				kind: "permission_request",
				correlationId: "tool-1",
				type: "permission_request",
				payload: { kind: "permission", toolCall: { toolName: "bash" } },
			}),
		);
		consumer.consume(
			frame({
				seq: 3,
				frameId: "frame-3",
				kind: "response",
				type: "response",
				payload: { command: "prompt", success: true },
			}),
		);
		const html = consumer.renderDocument();
		expect(html).toContain("message_update");
		expect(html).toContain("permission");
		expect(html).toContain('data-correlation="tool-1"');
		expect(html).toContain("prompt");
	});

	it("escapes payload summaries", () => {
		const rendered = renderBridgeFrame(
			frame({ seq: 1, frameId: "frame-1", type: "event<script>", payload: { eventType: "message_update<script>" } }),
		);
		expect(rendered.html).toContain("message_update&lt;script&gt;");
		expect(rendered.html).not.toContain("message_update<script>");
	});
});
