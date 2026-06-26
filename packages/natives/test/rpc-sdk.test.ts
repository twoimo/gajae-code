import { describe, expect, it } from "bun:test";
import { RpcSdkPipeline, rpcSdkClassifyCommand, rpcSdkCommandCount, rpcSdkProtocolVersion } from "../native/index.js";

// Runtime cross-language proof of the RPC SDK native binding: these call the
// compiled .node (the same in-process path the native TUI uses), exercising the
// embedded generated command manifest and the in-process RuntimePort handle with
// no serialization of the runtime core logic.

describe("rpc-sdk native binding", () => {
	it("exposes the unified protocol version", () => {
		expect(rpcSdkProtocolVersion()).toBe(1);
	});

	it("reports the embedded manifest command count", () => {
		expect(rpcSdkCommandCount()).toBe(38);
	});

	it("classifies commands by lane (preserving rpc-mode.ts split)", () => {
		expect(rpcSdkClassifyCommand("abort")).toBe("fast_lane_cancellation");
		expect(rpcSdkClassifyCommand("abort_bash")).toBe("fast_lane_cancellation");
		expect(rpcSdkClassifyCommand("get_state")).toBe("fast_lane_safe_read");
		expect(rpcSdkClassifyCommand("get_pending_workflow_gates")).toBe("fast_lane_safe_read");
		expect(rpcSdkClassifyCommand("prompt")).toBe("ordered");
		expect(rpcSdkClassifyCommand("bash")).toBe("ordered");
	});

	it("fails closed (null) for unknown commands", () => {
		expect(rpcSdkClassifyCommand("definitely_not_a_command")).toBeNull();
	});

	describe("RpcSdkPipeline RuntimePort handle", () => {
		const principal = JSON.stringify({ kind: "unix", uid: 501, gid: 20, pid: 7 });
		const grants = JSON.stringify([
			{
				version: 1,
				grantId: "g1",
				principalBinding: { kind: "unix", uid: 501, gid: 20 },
				issuedAt: "2026-01-01T00:00:00Z",
				expiresAt: "2026-12-31T00:00:00Z",
				renewableUntil: "2027-01-01T00:00:00Z",
				issuer: "cli",
				purpose: "test",
				sessions: ["s1"],
				scopes: ["control", "read"],
				redactionPolicy: "redacted",
			},
		]);

		function pipeline(): RpcSdkPipeline {
			return new RpcSdkPipeline("s1", grants, "2026-06-01T00:00:00Z", 16, "redacted");
		}

		it("is zero-serialization (in-process)", () => {
			expect(pipeline().isZeroSerialization()).toBe(true);
		});

		it("dispatches ordered vs fast-lane correctly", () => {
			const p = pipeline();
			expect(p.submit(principal, "prompt")).toBe("immediate");
			expect(p.submit(principal, "bash")).toBe("queued:1");
			// Fast-lane bypasses the in-flight ordered command.
			expect(p.submit(principal, "abort_bash")).toBe("immediate");
			expect(p.submit(principal, "get_state")).toBe("immediate");
		});

		it("fails closed on authorization denial and unknown commands", () => {
			// A principal with no matching grant is denied control.
			const stranger = JSON.stringify({ kind: "unix", uid: 0, gid: 0 });
			expect(() => pipeline().submit(stranger, "prompt")).toThrow(/denied/);
			expect(() => pipeline().submit(principal, "bogus")).toThrow(/unknown command/);
		});

		it("emit redacts streamed content and replay re-delivers redacted+replay-marked frames", () => {
			const p = pipeline();
			const contentFrame = (seq: number) =>
				JSON.stringify({
					protocolVersion: 1,
					frameId: `f${seq}`,
					sessionId: "s1",
					seq,
					direction: "server_to_client",
					kind: "notification",
					type: "turn_stream",
					replay: false,
					payload: { text: "secret" },
				});

			// Live fanout of streamed content is redacted.
			const fanned = JSON.parse(p.emit(contentFrame(1)));
			expect(fanned.payload).toEqual({ redacted: true });
			p.emit(contentFrame(2));

			// Replay from cursor 0 returns both frames, redacted and replay-marked.
			const replay = JSON.parse(p.replayFrom(0));
			expect(replay.kind).toBe("frames");
			expect(replay.frames).toHaveLength(2);
			expect(replay.frames.every((f: { replay: boolean }) => f.replay)).toBe(true);
			expect(replay.frames.every((f: { payload: unknown }) => JSON.stringify(f.payload) === '{"redacted":true}')).toBe(
				true,
			);
		});
	});
});
