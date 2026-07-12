import { describe, expect, it } from "bun:test";
import {
	boundedRuntimePromptAckTimeoutMs,
	COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS,
} from "../src/coordinator-mcp/server";

describe("Coordinator MCP runtime readiness", () => {
	it("bounds runtime acknowledgement waits independently of caller input", () => {
		expect(boundedRuntimePromptAckTimeoutMs(250)).toBe(250);
		expect(boundedRuntimePromptAckTimeoutMs(3_600_000)).toBe(COORDINATOR_RUNTIME_PROMPT_ACK_TIMEOUT_MAX_MS);
	});
});
