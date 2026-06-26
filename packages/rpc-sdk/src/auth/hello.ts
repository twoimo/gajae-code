import { PROTOCOL_VERSION, type RedactionPolicy } from "../protocol/generated";
import type { GjcFrame, HelloAcceptedPayload, HelloRequest, HelloSessionRequest } from "../protocol/types";
import type { UdsTransport } from "../transport/uds";

export interface BuildHelloOptions { sessions: string[]; redaction?: RedactionPolicy; grantId?: string; frameId?: string }

export function buildHelloPayload(options: BuildHelloOptions): HelloRequest {
	const requested: HelloSessionRequest[] = options.sessions.map((session) => ({ session, redaction: options.redaction ?? "redacted" }));
	return { protocolVersion: PROTOCOL_VERSION, requested, ...(options.grantId ? { grantId: options.grantId } : {}) };
}

export function buildHelloFrame(options: BuildHelloOptions): GjcFrame<HelloRequest> {
	return { protocolVersion: PROTOCOL_VERSION, frameId: options.frameId ?? "c_hello", sessionId: "", seq: 0, direction: "client_to_server", kind: "hello", type: "hello", replay: false, payload: buildHelloPayload(options) };
}

function isHelloAcceptedPayload(payload: unknown): payload is HelloAcceptedPayload {
	return typeof payload === "object" && payload !== null && typeof (payload as { sessions?: unknown }).sessions === "number";
}

export async function performHello(transport: UdsTransport, options: BuildHelloOptions): Promise<GjcFrame<HelloAcceptedPayload>> {
	const { promise, resolve, reject } = Promise.withResolvers<GjcFrame<HelloAcceptedPayload>>();
	const onFrame = (frame: GjcFrame<unknown>) => {
		cleanup();
		if (frame.kind === "error") {
			reject(new Error(JSON.stringify(frame.payload)));
			return;
		}
		if (frame.kind !== "ready" || frame.type !== "hello_accepted" || frame.protocolVersion !== PROTOCOL_VERSION || !isHelloAcceptedPayload(frame.payload)) {
			reject(new Error(`invalid hello response: ${JSON.stringify(frame)}`));
			return;
		}
		resolve(frame as GjcFrame<HelloAcceptedPayload>);
	};
	const onError = (error: Error) => { cleanup(); reject(error); };
	const cleanup = () => { transport.off("frame", onFrame); transport.off("error", onError); };
	transport.on("frame", onFrame);
	transport.on("error", onError);
	try {
		await transport.write(buildHelloFrame(options));
	} catch (error) {
		cleanup();
		reject(error);
	}
	return promise;
}
