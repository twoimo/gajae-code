import { describe, expect, test } from "bun:test";
import { RpcSdkPipeline } from "../../natives/native/index.js";
import {
	createNativeTuiRuntimeBoundary,
	type NativeTuiRpcSdkPipeline,
	type NativeTuiRuntimeControlTarget,
} from "../src/modes/native-tui-runtime-boundary";

// The boundary centralizes the native-TUI runtime-control surface (G003). These
// tests prove every control method is gated by the injected Rust RPC SDK pipeline
// before delegating to the injected target, and that runtime payloads remain typed
// in memory while only principal JSON + command type cross N-API.

interface Call {
	method: string;
	args: unknown[];
}

interface SubmitCall {
	principalJson: string;
	command: string;
}

class RecordingPipeline implements NativeTuiRpcSdkPipeline {
	readonly submitCalls: SubmitCall[] = [];
	readonly completions: Array<string | null> = [];
	constructor(readonly deniedCommand?: string) {}

	submit(principalJson: string, command: string): string {
		this.submitCalls.push({ principalJson, command });
		if (command === this.deniedCommand) throw new Error(`denied: ${command}`);
		return "immediate";
	}

	completeOrdered(): string | null {
		this.completions.push(null);
		return null;
	}

	isZeroSerialization(): boolean {
		return true;
	}
}

class QueueingPipeline implements NativeTuiRpcSdkPipeline {
	readonly submitCalls: SubmitCall[] = [];
	readonly completions: Array<string | null> = [];
	#completionResults: Array<string | null>;

	constructor(completionResults: Array<string | null>) {
		this.#completionResults = [...completionResults];
	}

	submit(principalJson: string, command: string): string {
		this.submitCalls.push({ principalJson, command });
		return this.submitCalls.length === 1 ? "immediate" : `queued:${this.submitCalls.length - 1}`;
	}

	completeOrdered(): string | null {
		const next = this.#completionResults.shift() ?? null;
		this.completions.push(next);
		return next;
	}

	isZeroSerialization(): boolean {
		return true;
	}
}

function fakeTarget(): { target: NativeTuiRuntimeControlTarget; calls: Call[]; listenerCount: () => number } {
	const calls: Call[] = [];
	const listeners = new Set<unknown>();
	const target: NativeTuiRuntimeControlTarget = {
		isStreaming: false,
		async prompt(...args) {
			calls.push({ method: "prompt", args });
		},
		async promptCustomMessage(...args) {
			calls.push({ method: "promptCustomMessage", args });
		},
		async sendCustomMessage(...args) {
			calls.push({ method: "sendCustomMessage", args });
		},
		async steer(...args) {
			calls.push({ method: "steer", args });
		},
		async followUp(...args) {
			calls.push({ method: "followUp", args });
		},
		async abort(...args) {
			calls.push({ method: "abort", args });
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return { target, calls, listenerCount: () => listeners.size };
}

function boundaryWithRecordingPipeline(deniedCommand?: string) {
	const { target, calls, listenerCount } = fakeTarget();
	const pipeline = new RecordingPipeline(deniedCommand);
	const principalJson = JSON.stringify({ kind: "native_tui_self" });
	const boundary = createNativeTuiRuntimeBoundary(target, { pipeline, principalJson });
	return { boundary, calls, listenerCount, pipeline, principalJson };
}

function grants(sessionId: string): string {
	return JSON.stringify([
		{
			version: 1,
			grantId: "g1",
			principalBinding: { kind: "native_tui_self" },
			issuedAt: "2026-01-01T00:00:00Z",
			expiresAt: "2026-12-31T00:00:00Z",
			renewableUntil: "2027-01-01T00:00:00Z",
			issuer: "native-tui-test",
			purpose: "native-tui-runtime-control",
			sessions: [sessionId],
			scopes: ["control", "read", "subscribe"],
			redactionPolicy: "full",
		},
	]);
}

describe("NativeTuiRuntimeBoundary", () => {
	test("routes every control method through RpcSdkPipeline before delegating typed payloads", async () => {
		const { boundary, calls, pipeline, principalJson } = boundaryWithRecordingPipeline();
		const promptPayload = { streamingBehavior: "followUp" as const };
		const customPayload = { customType: "skill", content: "x", display: true } as const;
		await boundary.prompt("hi", promptPayload);
		await boundary.promptCustomMessage(customPayload);
		await boundary.sendCustomMessage({ customType: "skill", content: "y", display: true }, { triggerTurn: true });
		await boundary.steer("s");
		await boundary.followUp("f");
		await boundary.abort({ timeoutMs: 10, cause: "user_interrupt" });
		expect(pipeline.submitCalls.map(c => c.command)).toEqual([
			"prompt",
			"prompt",
			"prompt",
			"steer",
			"follow_up",
			"abort",
		]);
		expect(pipeline.submitCalls.every(c => c.principalJson === principalJson)).toBe(true);
		expect(calls.map(c => c.method)).toEqual([
			"prompt",
			"promptCustomMessage",
			"sendCustomMessage",
			"steer",
			"followUp",
			"abort",
		]);
		expect(calls[0].args[0]).toBe("hi");
		expect(calls[0].args[1]).toBe(promptPayload);
		expect(calls[1].args[0]).toBe(customPayload);
		expect(calls[5].args[0]).toEqual({ timeoutMs: 10, cause: "user_interrupt" });
	});

	test("fails closed when the Rust pipeline denies a native control command", () => {
		const { boundary, calls, pipeline } = boundaryWithRecordingPipeline("steer");
		expect(() => boundary.steer("blocked")).toThrow(/denied: steer/);

		expect(pipeline.submitCalls).toEqual([
			{ principalJson: JSON.stringify({ kind: "native_tui_self" }), command: "steer" },
		]);
		expect(calls).toEqual([]);
	});

	test("queued ordered commands are deferred until Rust promotes them", async () => {
		const { target, calls } = fakeTarget();
		const pipeline = new QueueingPipeline(["prompt", null]);
		const principalJson = JSON.stringify({ kind: "native_tui_self" });
		const boundary = createNativeTuiRuntimeBoundary(target, { pipeline, principalJson });
		let secondResolved = false;

		const first = boundary.prompt("first");
		const second = boundary.prompt("second").then(() => {
			secondResolved = true;
		});

		expect(calls.map(c => c.args[0])).toEqual(["first"]);
		expect(secondResolved).toBe(false);
		await first;
		expect(calls.map(c => c.args[0])).toEqual(["first", "second"]);
		await second;
		expect(secondResolved).toBe(true);
		expect(pipeline.submitCalls.map(c => c.command)).toEqual(["prompt", "prompt"]);
		expect(pipeline.completions).toEqual(["prompt", null]);
	});

	test("sendUserMessage maps through prompt, steer, and follow-up boundary lanes", async () => {
		const { boundary, calls, pipeline } = boundaryWithRecordingPipeline();
		await boundary.sendUserMessage("idle");
		await boundary.sendUserMessage("queued steer", { deliverAs: "steer" });
		await boundary.sendUserMessage("queued follow-up", { deliverAs: "followUp" });

		expect(pipeline.submitCalls.map(c => c.command)).toEqual(["prompt", "steer", "follow_up"]);
		expect(calls.map(c => c.method)).toEqual(["prompt", "steer", "followUp"]);
	});

	test("subscribe is still routed through the in-process pipeline and unsubscribe removes the listener", () => {
		const { boundary, listenerCount, pipeline } = boundaryWithRecordingPipeline();
		const unsub = boundary.subscribe(() => {});
		expect(pipeline.submitCalls.map(c => c.command)).toEqual(["get_state"]);
		expect(listenerCount()).toBe(1);
		unsub();
		expect(listenerCount()).toBe(0);
	});

	test("native transport markers satisfy the zero-serialization invariant", () => {
		const { boundary } = boundaryWithRecordingPipeline();
		expect(boundary.transportInfo()).toEqual({
			transport: "in_process",
			runtimePort: "native_typed",
			jsonRuntimePayloadBytes: 0,
			jsonHelperCalls: 0,
			udsRuntimeFrames: 0,
			workerIpc: false,
		});
	});

	test("native TUI e2e vector uses real RpcSdkPipeline with zero runtime-payload serialization", async () => {
		const sessionId = "native-tui-e2e";
		const principalJson = JSON.stringify({ kind: "native_tui_self" });
		const nativePipeline = new RpcSdkPipeline(sessionId, grants(sessionId), "2026-06-01T00:00:00Z", 64, "full");
		const { target, calls } = fakeTarget();
		const boundary = createNativeTuiRuntimeBoundary(target, { pipeline: nativePipeline, principalJson });
		const runtimePayload = { streamingBehavior: "followUp" as const };

		expect(nativePipeline.isZeroSerialization()).toBe(true);
		await boundary.prompt("typed payload stays in memory", runtimePayload);
		expect(calls).toHaveLength(1);
		expect(calls[0].args[0]).toBe("typed payload stays in memory");
		expect(calls[0].args[1]).toBe(runtimePayload);
		expect(boundary.transportInfo()).toMatchObject({
			jsonRuntimePayloadBytes: 0,
			udsRuntimeFrames: 0,
			workerIpc: false,
		});

		const surrogateFrame = {
			protocolVersion: 1,
			frameId: "f1",
			sessionId,
			seq: 1,
			direction: "server_to_client",
			kind: "event",
			type: "native_tui_surrogate",
			replay: false,
			capabilityScope: "control",
			payload: { surface: "crates/pi-natives/src/rpc_sdk.rs", pipeline: "in_process" },
		};
		const fanned = JSON.parse(nativePipeline.emit(JSON.stringify(surrogateFrame)));
		expect(fanned).toEqual(surrogateFrame);
	});

	test("real RpcSdkPipeline denial blocks the native target", () => {
		const sessionId = "native-tui-denied";
		const stranger = JSON.stringify({ kind: "native_tui_self" });
		const nativePipeline = new RpcSdkPipeline(sessionId, "[]", "2026-06-01T00:00:00Z", 64, "full");
		const { target, calls } = fakeTarget();
		const boundary = createNativeTuiRuntimeBoundary(target, { pipeline: nativePipeline, principalJson: stranger });

		expect(() => boundary.prompt("blocked")).toThrow(/denied/);
		expect(calls).toEqual([]);
	});
});
