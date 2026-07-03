import { describe, expect, it } from "bun:test";
import { isRpcHostUriResult } from "../src/modes/shared/agent-wire/host-uri-bridge";
import type { RpcHostUriCancelRequest, RpcHostUriRequest } from "../src/modes/shared/agent-wire/host-uri-types";

describe("agent-wire host URI DTOs", () => {
	it("validates transport-neutral request/cancel/result shapes", () => {
		const request: RpcHostUriRequest = {
			type: "host_uri_request",
			id: "req_1",
			operation: "write",
			url: "db://rows/1",
			content: "body",
		};
		const cancel: RpcHostUriCancelRequest = {
			type: "host_uri_cancel",
			id: "cancel_1",
			targetId: request.id,
		};
		expect(request).toMatchObject({ operation: "write", url: "db://rows/1" });
		expect(cancel.targetId).toBe("req_1");
		expect(
			isRpcHostUriResult({
				type: "host_uri_result",
				id: "req_1",
				content: "ok",
				contentType: "text/plain",
				notes: ["fresh"],
				immutable: true,
			}),
		).toBe(true);
		expect(isRpcHostUriResult({ type: "host_uri_result", id: "req_1", contentType: "text/html" })).toBe(false);
	});

	it("owner observations can omit result content while retaining correlation", () => {
		const result = { type: "host_uri_result", id: "req_1", content: "secret", contentType: "text/plain" } as const;
		const observation = { type: result.type, id: result.id, contentType: result.contentType };
		expect(observation).toEqual({ type: "host_uri_result", id: "req_1", contentType: "text/plain" });
		expect("content" in observation).toBe(false);
	});
});
