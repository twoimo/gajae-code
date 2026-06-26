/**
 * NativeTuiRuntimeBoundary — the single native-TUI runtime I/O seam (G003).
 *
 * Every native-TUI runtime input/control/subscription call MUST go through this
 * adapter instead of touching `AgentSession` directly (enforced by
 * `scripts/rpc-sdk/verify-native-tui-boundary.ts`). The adapter routes native
 * control through the in-process Rust RPC SDK core via typed N-API before it
 * delegates the rich typed payload to the live `AgentSession`.
 *
 * Transport invariant for the native path (see docs/rpc-sdk/runtime-port.md):
 *   transport=in_process, runtime_port=native_typed, json_runtime_payload_bytes=0,
 *   json_helper_calls=0, uds_runtime_frames=0, worker_ipc=false.
 * Only small control metadata (principal JSON + command type) crosses N-API as
 * strings; runtime payloads remain typed in-memory and are passed directly to
 * `AgentSession`. N-API value marshaling is allowed conversion (not zero-copy);
 * JSON emit/replay helpers are headless/edge-only and MUST NOT be used on this path.
 */
import { RpcSdkPipeline } from "../../../natives/native/index.js";
import type { AgentSession } from "../session/agent-session";

/**
 * The native runtime-control surface, derived directly from `AgentSession` so the
 * boundary stays signature-exact with the real session (and any session-shaped
 * fake in tests). These are the seams the boundary gate forbids calling directly.
 */
export type NativeTuiRuntimeControlTarget = Pick<
	AgentSession,
	"prompt" | "promptCustomMessage" | "sendCustomMessage" | "steer" | "followUp" | "abort" | "subscribe" | "isStreaming"
>;

export interface NativeTuiRpcSdkPipeline {
	submit(principalJson: string, command: string): string;
	completeOrdered(): string | null;
	isZeroSerialization(): boolean;
}

export type NativeTuiRuntimeCommand = "prompt" | "steer" | "follow_up" | "abort" | "get_state";
export type NativeTuiRuntimeControlSessionTarget = NativeTuiRuntimeControlTarget & { readonly sessionId: string };

export interface NativeTuiRuntimeBoundaryOptions {
	readonly pipeline: NativeTuiRpcSdkPipeline;
	readonly principalJson: string;
}

/** Native-path transport markers asserted by the zero-serialization gate. */
export interface NativeTransportInfo {
	readonly transport: "in_process";
	readonly runtimePort: "native_typed";
	readonly jsonRuntimePayloadBytes: 0;
	readonly jsonHelperCalls: 0;
	readonly udsRuntimeFrames: 0;
	readonly workerIpc: false;
}

const NATIVE_TRANSPORT_INFO: NativeTransportInfo = {
	transport: "in_process",
	runtimePort: "native_typed",
	jsonRuntimePayloadBytes: 0,
	jsonHelperCalls: 0,
	udsRuntimeFrames: 0,
	workerIpc: false,
};

const NATIVE_TUI_PRINCIPAL_JSON = JSON.stringify({ kind: "native_tui_self" });
type QueuedInvocation = () => Promise<void>;

const ORDERED_COMMANDS = new Set<NativeTuiRuntimeCommand>(["prompt", "steer", "follow_up"]);

function nativeTuiSelfGrant(sessionId: string): string {
	return JSON.stringify([
		{
			version: 1,
			grantId: `native-tui-self:${sessionId}`,
			principalBinding: { kind: "native_tui_self" },
			issuedAt: "2026-01-01T00:00:00Z",
			expiresAt: "2099-01-01T00:00:00Z",
			renewableUntil: "2099-01-01T00:00:00Z",
			issuer: "native-tui",
			purpose: "native-tui-runtime-control",
			sessions: [sessionId],
			scopes: ["control", "read", "subscribe"],
			redactionPolicy: "full",
		},
	]);
}

function assertZeroSerializationPipeline(pipeline: NativeTuiRpcSdkPipeline): void {
	if (!pipeline.isZeroSerialization()) {
		throw new Error("native TUI runtime boundary requires an in-process zero-serialization RpcSdkPipeline");
	}
}

/**
 * Single seam for native-TUI runtime control + observation. All native-TUI code
 * receives one of these (injected) and never calls `AgentSession` control methods
 * directly. Method signatures mirror `AgentSession` exactly.
 */
export class NativeTuiRuntimeBoundary {
	readonly #target: NativeTuiRuntimeControlTarget;
	readonly #pipeline: NativeTuiRpcSdkPipeline;
	readonly #principalJson: string;

	constructor(target: NativeTuiRuntimeControlTarget, options: NativeTuiRuntimeBoundaryOptions) {
		assertZeroSerializationPipeline(options.pipeline);
		this.#target = target;
		this.#pipeline = options.pipeline;
		this.#principalJson = options.principalJson;
	}

	/** Native path never serializes runtime payloads (typed in-memory). */
	transportInfo(): NativeTransportInfo {
		return NATIVE_TRANSPORT_INFO;
	}

	#submit(command: NativeTuiRuntimeCommand): "immediate" | "queued" {
		const dispatch = this.#pipeline.submit(this.#principalJson, command);
		if (dispatch === "immediate") return "immediate";
		if (/^queued:\d+$/.test(dispatch)) return "queued";
		throw new Error(`unexpected native TUI scheduler dispatch for ${command}: ${dispatch}`);
	}

	#completeOrdered(command: NativeTuiRuntimeCommand): void {
		if (!ORDERED_COMMANDS.has(command)) return;
		const promoted = this.#pipeline.completeOrdered();
		if (!promoted) return;
		const commandQueue = this.#queuedInvocations.get(promoted as NativeTuiRuntimeCommand);
		const next = commandQueue?.shift();
		if (commandQueue?.length === 0) this.#queuedInvocations.delete(promoted as NativeTuiRuntimeCommand);
		if (!next) {
			throw new Error(`native TUI scheduler promoted ${promoted} with no deferred invocation`);
		}
		void next();
	}

	#queuedInvocations = new Map<NativeTuiRuntimeCommand, QueuedInvocation[]>();

	#invokeOrdered(command: NativeTuiRuntimeCommand, invoke: () => Promise<void>): Promise<void> {
		const dispatch = this.#submit(command);
		if (dispatch === "queued") {
			return new Promise<void>((resolve, reject) => {
				const queue = this.#queuedInvocations.get(command) ?? [];
				queue.push(() =>
					invoke()
						.then(resolve, reject)
						.finally(() => this.#completeOrdered(command)),
				);
				this.#queuedInvocations.set(command, queue);
			});
		}
		return invoke().finally(() => this.#completeOrdered(command));
	}

	prompt(...args: Parameters<NativeTuiRuntimeControlTarget["prompt"]>): Promise<void> {
		return this.#invokeOrdered("prompt", () => this.#target.prompt(...args));
	}

	promptCustomMessage(...args: Parameters<NativeTuiRuntimeControlTarget["promptCustomMessage"]>): Promise<void> {
		return this.#invokeOrdered("prompt", () => this.#target.promptCustomMessage(...args));
	}

	sendCustomMessage(...args: Parameters<NativeTuiRuntimeControlTarget["sendCustomMessage"]>): Promise<void> {
		return this.#invokeOrdered("prompt", () => this.#target.sendCustomMessage(...args));
	}

	steer(...args: Parameters<NativeTuiRuntimeControlTarget["steer"]>): Promise<void> {
		return this.#invokeOrdered("steer", () => this.#target.steer(...args));
	}

	followUp(...args: Parameters<NativeTuiRuntimeControlTarget["followUp"]>): Promise<void> {
		return this.#invokeOrdered("follow_up", () => this.#target.followUp(...args));
	}

	sendUserMessage(...args: Parameters<AgentSession["sendUserMessage"]>): Promise<void> {
		const [content, options] = args;
		if (options?.deliverAs === "followUp") {
			return this.followUpContent(content);
		}
		if (options?.deliverAs === "steer" || this.#target.isStreaming) {
			return this.steerContent(content);
		}
		return this.promptContent(content);
	}

	promptContent(content: Parameters<AgentSession["sendUserMessage"]>[0]): Promise<void> {
		const { text, images } = this.#normalizeUserContent(content);
		return this.prompt(text, { expandPromptTemplates: false, images });
	}

	steerContent(content: Parameters<AgentSession["sendUserMessage"]>[0]): Promise<void> {
		const { text, images } = this.#normalizeUserContent(content);
		return this.steer(text, images);
	}

	followUpContent(content: Parameters<AgentSession["sendUserMessage"]>[0]): Promise<void> {
		const { text, images } = this.#normalizeUserContent(content);
		return this.followUp(text, images);
	}

	#normalizeUserContent(content: Parameters<AgentSession["sendUserMessage"]>[0]): {
		text: string;
		images?: Parameters<NativeTuiRuntimeControlTarget["steer"]>[1];
	} {
		if (typeof content === "string") return { text: content };
		const textParts: string[] = [];
		const images: Parameters<NativeTuiRuntimeControlTarget["steer"]>[1] = [];
		for (const part of content) {
			if (part.type === "text") {
				textParts.push(part.text);
			} else {
				images.push(part);
			}
		}
		return { text: textParts.join("\n"), images: images.length === 0 ? undefined : images };
	}

	abort(...args: Parameters<NativeTuiRuntimeControlTarget["abort"]>): Promise<void> {
		this.#submit("abort");
		return this.#target.abort(...args);
	}

	subscribe(...args: Parameters<NativeTuiRuntimeControlTarget["subscribe"]>): () => void {
		this.#submit("get_state");
		return this.#target.subscribe(...args);
	}
}

/** Build the production boundary over a live runtime-control target (AgentSession). */
export function createNativeTuiRuntimeBoundary(
	target: NativeTuiRuntimeControlSessionTarget,
	options?: NativeTuiRuntimeBoundaryOptions,
): NativeTuiRuntimeBoundary;
export function createNativeTuiRuntimeBoundary(
	target: NativeTuiRuntimeControlTarget,
	options: NativeTuiRuntimeBoundaryOptions,
): NativeTuiRuntimeBoundary;
export function createNativeTuiRuntimeBoundary(
	target: NativeTuiRuntimeControlTarget | NativeTuiRuntimeControlSessionTarget,
	options?: NativeTuiRuntimeBoundaryOptions,
): NativeTuiRuntimeBoundary {
	if (options) return new NativeTuiRuntimeBoundary(target, options);
	const sessionId = (target as NativeTuiRuntimeControlSessionTarget).sessionId;
	const pipeline = new RpcSdkPipeline(sessionId, nativeTuiSelfGrant(sessionId), new Date().toISOString(), 64, "full");
	return new NativeTuiRuntimeBoundary(target, { pipeline, principalJson: NATIVE_TUI_PRINCIPAL_JSON });
}
