import {
	AGENT_WIRE_CURRENT_VERSION,
	AGENT_WIRE_SUPPORTED_VERSIONS,
	type AgentWireEnvelope,
	type AgentWireVersion,
} from "@gajae-code/agent-wire";
import { AgentWireFrameSequencer } from "../shared/agent-wire/event-envelope";

const encoder = new TextEncoder();
const DEFAULT_REPLAY_LIMIT = 1_000;

function encodeSseFrame(frame: AgentWireEnvelope): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
}

export class BridgeEventStream {
	#sequencers: Map<AgentWireVersion, AgentWireFrameSequencer>;
	#framesByVersion = new Map<AgentWireVersion, AgentWireEnvelope[]>(
		AGENT_WIRE_SUPPORTED_VERSIONS.map(version => [version, []]),
	);
	#subscribersByVersion = new Map<AgentWireVersion, Set<ReadableStreamDefaultController<Uint8Array>>>(
		AGENT_WIRE_SUPPORTED_VERSIONS.map(version => [version, new Set()]),
	);
	#replayLimit: number;

	constructor(sessionIdOrReplayLimit: string | number = "unknown", replayLimit = DEFAULT_REPLAY_LIMIT) {
		const sessionId = typeof sessionIdOrReplayLimit === "string" ? sessionIdOrReplayLimit : "unknown";
		this.#sequencers = new Map(
			AGENT_WIRE_SUPPORTED_VERSIONS.map(version => [version, new AgentWireFrameSequencer(sessionId, version)]),
		);
		this.#replayLimit = typeof sessionIdOrReplayLimit === "number" ? sessionIdOrReplayLimit : replayLimit;
	}
	get frameCount(): number {
		return this.#framesByVersion.get(AGENT_WIRE_CURRENT_VERSION)?.length ?? 0;
	}

	emit<TType extends AgentWireEnvelope["type"], TPayload>(
		type: TType,
		payload: TPayload,
		correlationId?: string,
	): void {
		for (const version of AGENT_WIRE_SUPPORTED_VERSIONS) {
			const sequencer = this.#sequencers.get(version);
			if (!sequencer) continue;
			this.publishVersioned(version, sequencer.next(type, payload, correlationId));
		}
	}

	publish(frame: AgentWireEnvelope): void {
		this.publishVersioned(frame.protocol_version, frame);
	}

	publishVersioned(version: AgentWireVersion, frame: AgentWireEnvelope): void {
		const frames = this.#framesByVersion.get(version);
		if (!frames) throw new Error(`Unsupported agent-wire version: ${version}`);
		frames.push(frame);
		if (frames.length > this.#replayLimit) frames.splice(0, frames.length - this.#replayLimit);
		const encoded = encodeSseFrame(frame);
		for (const controller of this.#subscribersByVersion.get(version) ?? []) {
			try {
				controller.enqueue(encoded);
			} catch {
				this.#subscribersByVersion.get(version)?.delete(controller);
			}
		}
	}

	response(lastSeq = 0, version: AgentWireVersion = AGENT_WIRE_CURRENT_VERSION): Response {
		const frames = this.#framesByVersion.get(version);
		const subscribers = this.#subscribersByVersion.get(version);
		if (!frames || !subscribers) throw new Error(`Unsupported agent-wire version: ${version}`);
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: controller => {
				streamController = controller;
				const first = frames[0];
				if (first && lastSeq > 0 && first.seq > lastSeq + 1) {
					controller.enqueue(
						encodeSseFrame({
							protocol_version: version,
							session_id: first.session_id,
							seq: first.seq - 1,
							frame_id: `reset-${first.seq}`,
							type: "reset",
							payload: { reason: "replay_window_exceeded", first_seq: first.seq },
						}),
					);
				}
				for (const frame of frames) {
					if (frame.seq > lastSeq) controller.enqueue(encodeSseFrame(frame));
				}
				subscribers.add(controller);
			},
			cancel: () => {
				if (streamController) subscribers.delete(streamController);
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}
}
