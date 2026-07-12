import { describe, expect, test } from "bun:test";
import {
	AGENT_WIRE_CURRENT_VERSION,
	AGENT_WIRE_PREVIOUS_VERSION,
	type AgentWireHandshakeServer,
	isAgentWireCommand,
	isAgentWireEnvelope,
	negotiateAgentWireHandshake,
	parseAgentWireEnvelope,
	selectAgentWireVersion,
} from "../src";

const server: AgentWireHandshakeServer = {
	sessionId: "session-1",
	capabilities: ["events", "compact_message_update"],
	scopes: ["prompt"],
	endpoints: {
		events: "/events",
		commands: "/commands",
		uiResponses: "/ui",
		claimControl: "/claim",
		disconnectControl: "/disconnect",
		hostToolResults: "/tools",
		hostUriResults: "/uris",
	},
	frameTypes: ["event"],
};

describe("agent-wire versions", () => {
	test("selects the highest mutually supported version", () => {
		expect(selectAgentWireVersion({ min: 1, max: 1 })).toBe(AGENT_WIRE_PREVIOUS_VERSION);
		expect(selectAgentWireVersion({ min: 1, max: 2 })).toBe(AGENT_WIRE_CURRENT_VERSION);
		expect(selectAgentWireVersion({ min: 2, max: 2 })).toBe(AGENT_WIRE_CURRENT_VERSION);
		expect(selectAgentWireVersion({ min: 3, max: 4 })).toBeUndefined();
	});
	test("negotiates v1 without v2-only capabilities and rejects unsupported ranges", () => {
		const v1 = negotiateAgentWireHandshake(
			{
				protocol_version_range: { min: 1, max: 1 },
				capabilities: ["events", "compact_message_update"],
				requested_scopes: ["prompt"],
			},
			server,
		);
		expect(v1).toMatchObject({
			status: "accepted",
			protocol_version: 1,
			accepted_capabilities: ["events"],
			unsupported: ["compact_message_update"],
		});
		expect(
			negotiateAgentWireHandshake(
				{ protocol_version_range: { min: 3, max: 4 }, capabilities: [], requested_scopes: [] },
				server,
			),
		).toMatchObject({ status: "rejected", reason: "incompatible_version" });
	});
	test("round-trips bounded v1 and v2 compact envelopes", () => {
		const v1 = {
			protocol_version: 1,
			session_id: "s",
			seq: 1,
			frame_id: "f1",
			type: "event",
			payload: { event_type: "message_update", event: { type: "message_update", text: "full" } },
		} as const;
		const v2 = {
			protocol_version: 2,
			session_id: "s",
			seq: 2,
			frame_id: "f2",
			type: "event",
			payload: {
				event_type: "message_update",
				compact: true,
				message_id: "m",
				content_index: 0,
				assistantMessageEvent: { type: "text_delta", delta: "x" },
			},
		} as const;
		expect(parseAgentWireEnvelope(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
		expect(parseAgentWireEnvelope(JSON.parse(JSON.stringify(v2)))).toEqual(v2);
	});
	test("rejects malformed versions and version/payload combinations", () => {
		const base = { session_id: "s", seq: 1, frame_id: "f", type: "event" };
		expect(
			isAgentWireEnvelope({ ...base, protocol_version: 3, payload: { event_type: "agent_start", event: {} } }),
		).toBeFalse();
		expect(
			isAgentWireEnvelope({
				...base,
				protocol_version: 1,
				payload: {
					event_type: "message_update",
					compact: true,
					message_id: null,
					content_index: null,
					assistantMessageEvent: {},
				},
			}),
		).toBeFalse();
		expect(() =>
			parseAgentWireEnvelope({ ...base, protocol_version: 2, payload: { event_type: "message_update" } }),
		).toThrow("Invalid or unsupported agent-wire envelope");
	});
	test("rejects malformed image command content", () => {
		expect(
			isAgentWireCommand({
				type: "prompt",
				message: "describe this",
				images: [{ type: "image", data: "base64", mimeType: "image/png" }],
			}),
		).toBeTrue();
		for (const images of [[{ type: "text", data: "base64", mimeType: "image/png" }], ["not-an-image"], [{}]]) {
			expect(isAgentWireCommand({ type: "prompt", message: "describe this", images })).toBeFalse();
		}
	});
});
