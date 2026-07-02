type Reply = { id: string; answerJson: string; idempotencyKey?: string };

type ReplyCallback = (err: unknown, reply: Reply | null) => void;

type Inbound =
	| { kind: "user_message"; text?: string; images?: { data: string; mime?: string }[]; updateId?: number }
	| { kind: "config_command"; verbosity?: "lean" | "verbose"; redact?: boolean };

type InboundCallback = (err: unknown, inbound: Inbound | null) => void;

type PendingAction = {
	frame: Record<string, unknown>;
	repliable: boolean;
	/** Latched at the first valid reply (before the async resolver runs) so
	 * duplicate replies are rejected/acked, not forwarded twice. */
	accepted: boolean;
	resolved: boolean;
	idempotency?: { key: string; answerJson: string };
};

export interface AppServerNotificationEndpointOptions {
	sessionId: string;
	pushNotification: (frame: unknown) => void;
}

export class AppServerNotificationEndpoint {
	private readonly sessionId: string;
	private readonly pushNotification: (frame: unknown) => void;
	private readonly pending = new Map<string, PendingAction>();
	private readonly replayFrames: unknown[] = [];
	private readonly replyCallbacks = new Set<ReplyCallback>();
	private readonly inboundCallbacks = new Set<InboundCallback>();
	private stopped = false;

	constructor(opts: AppServerNotificationEndpointOptions) {
		this.sessionId = opts.sessionId;
		this.pushNotification = opts.pushNotification;
	}

	async start(): Promise<{ url: string }> {
		return { url: this.endpointUrl() };
	}

	endpointUrl(): string {
		return `app-server://gjc/notifications/${encodeURIComponent(this.sessionId)}`;
	}

	registerAsk(payloadJson: string, repliable: boolean): void {
		if (this.stopped) return;
		const parsed = parseObject(payloadJson);
		const id = typeof parsed.id === "string" ? parsed.id : undefined;
		if (!id) throw new Error("notification action is missing string id");
		const frame = { type: "action_needed", ...parsed };
		this.pending.set(id, { frame, repliable, resolved: false, accepted: false });
		this.emit(frame, true);
	}

	/** Notify-only ephemeral idle ping: pushed to subscribers but not retained
	 * for replay (idle actions are not replayed to clients that connect later). */
	noteIdle(payloadJson: string): void {
		if (this.stopped) return;
		const parsed = parseObject(payloadJson);
		this.emit({ type: "action_needed", ...parsed }, false);
	}

	resolveLocal(id: string, _answerJson?: string): void {
		this.resolveAction(id, "local");
	}

	resolveClient(id: string, answerJson: string, idempotencyKey?: string): void {
		const pending = this.pending.get(id);
		if (pending?.resolved) {
			this.ackIdempotentOrReject(id, answerJson, idempotencyKey);
			return;
		}
		this.resolveAction(id, "client", { key: idempotencyKey, answerJson });
	}

	reject(id: string, reason: string): void {
		this.emit({ type: "reply_rejected", id, reason });
	}

	pushFrame(json: string): void {
		if (this.stopped) return;
		this.emit(JSON.parse(json));
	}

	onReply(cb: ReplyCallback): void {
		this.replyCallbacks.add(cb);
	}

	onInbound(cb: InboundCallback): void {
		this.inboundCallbacks.add(cb);
	}

	stop(): void {
		this.stopped = true;
		this.pending.clear();
		this.replyCallbacks.clear();
		this.inboundCallbacks.clear();
	}

	handleNotificationCall(method: string, params: unknown): unknown {
		const suffix = method.startsWith("gjc/notifications/") ? method.slice("gjc/notifications/".length) : method;
		switch (suffix) {
			case "subscribe":
				return [...this.replayFrames];
			case "reply":
				return this.handleReply(params);
			case "userMessage":
				this.emitInbound(userMessagePayload(params));
				return { ok: true };
			case "configCommand":
				this.emitInbound(configCommandPayload(params));
				return { ok: true };
			case "ping":
				return { pong: true };
			default:
				return { rejected: "unknown_method" };
		}
	}

	private handleReply(params: unknown): unknown {
		const obj = objectOrEmpty(params);
		const id = typeof obj.id === "string" ? obj.id : undefined;
		if (!id) return { rejected: "invalid_request" };
		const answerJson = serializeAnswer(obj.answer);
		const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : undefined;
		const pending = this.pending.get(id);
		if (!pending || pending.resolved || pending.accepted) {
			return this.ackIdempotentOrReject(id, answerJson, idempotencyKey);
		}
		if (!pending.repliable) {
			this.reject(id, "not_repliable");
			return { rejected: "not_repliable" };
		}
		// Latch acceptance now: the async consumer resolves the gate later, but a
		// second reply arriving in the meantime must not be forwarded again.
		pending.accepted = true;
		if (idempotencyKey) pending.idempotency = { key: idempotencyKey, answerJson };
		for (const cb of this.replyCallbacks) cb(null, { id, answerJson, idempotencyKey });
		return { ok: true };
	}

	private ackIdempotentOrReject(id: string, answerJson: string, idempotencyKey?: string): unknown {
		const pending = this.pending.get(id);
		if (idempotencyKey && pending?.idempotency?.key === idempotencyKey) {
			if (pending.idempotency.answerJson === answerJson) return { ok: true };
			this.reject(id, "idempotency_conflict");
			return { rejected: "idempotency_conflict" };
		}
		this.reject(id, "already_answered");
		return { rejected: "already_answered" };
	}

	private resolveAction(
		id: string,
		resolvedBy: "local" | "client" | "timeout",
		idempotency?: { key?: string; answerJson: string },
	): void {
		const pending = this.pending.get(id);
		if (!pending || pending.resolved) return;
		pending.resolved = true;
		if (idempotency?.key) pending.idempotency = { key: idempotency.key, answerJson: idempotency.answerJson };
		// Tombstone the replayed action_needed so a reconnect does not replay a
		// now-resolved ask.
		const frameIndex = this.replayFrames.indexOf(pending.frame);
		if (frameIndex >= 0) this.replayFrames.splice(frameIndex, 1);
		this.emit({ type: "action_resolved", id, resolvedBy });
	}

	private emit(frame: unknown, sticky = false): void {
		this.pushNotification(frame);
		if (sticky) this.replayFrames.push(frame);
	}

	private emitInbound(inbound: Inbound): void {
		for (const cb of this.inboundCallbacks) cb(null, inbound);
	}
}

function parseObject(json: string): Record<string, unknown> {
	const parsed = JSON.parse(json);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("notification frame must be an object");
	return parsed as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function serializeAnswer(answer: unknown): string {
	return typeof answer === "string" ? answer : JSON.stringify(answer);
}

function userMessagePayload(params: unknown): Inbound {
	const obj = objectOrEmpty(params);
	const images = Array.isArray(obj.images)
		? obj.images
				.map(image => {
					const img = objectOrEmpty(image);
					return typeof img.data === "string"
						? { data: img.data, mime: typeof img.mime === "string" ? img.mime : undefined }
						: undefined;
				})
				.filter((image): image is { data: string; mime: string | undefined } => image !== undefined)
		: undefined;
	return {
		kind: "user_message",
		text: typeof obj.text === "string" ? obj.text : undefined,
		images,
		updateId: typeof obj.updateId === "number" ? obj.updateId : undefined,
	};
}

function configCommandPayload(params: unknown): Inbound {
	const obj = objectOrEmpty(params);
	const command = objectOrEmpty(obj.command ?? obj);
	return {
		kind: "config_command",
		verbosity: command.verbosity === "lean" || command.verbosity === "verbose" ? command.verbosity : undefined,
		redact: typeof command.redact === "boolean" ? command.redact : undefined,
	};
}
