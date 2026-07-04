import type {
	AppServerError,
	GjcCompactParams,
	GjcCompactResult,
	GjcHostToolsResultParams,
	GjcHostToolsResultResult,
	GjcHostToolsSetParams,
	GjcHostToolsSetResult,
	GjcHostToolsUpdateParams,
	GjcHostToolsUpdateResult,
	GjcMessagesGetParams,
	GjcMessagesGetResult,
	GjcModelSetParams,
	GjcModelSetResult,
	GjcStateReadParams,
	GjcStateReadResult,
	GjcTodosSetParams,
	GjcTodosSetResult,
	InitializedParams,
	InitializeParams,
	InitializeResult,
	JsonValue,
	RequestId,
	Response,
	ServerNotificationEnvelope,
	ServerNotificationMap,
	ServerNotificationMethod,
	ThreadReadParams,
	ThreadReadResult,
	ThreadResult,
	ThreadResumeParams,
	ThreadResumeResult,
	ThreadStartParams,
	TurnInterruptParams,
	TurnInterruptResult,
	TurnStartParams,
	TurnStartResult,
	TurnSteerParams,
	TurnSteerResult,
} from "./generated/protocol";

export type AppServerRequestMap = {
	initialize: { params: InitializeParams; result: InitializeResult };
	"thread/start": { params: ThreadStartParams; result: ThreadResult };
	"thread/resume": { params: ThreadResumeParams; result: ThreadResumeResult };
	"thread/read": { params: ThreadReadParams; result: ThreadReadResult };
	"turn/start": { params: TurnStartParams; result: TurnStartResult };
	"turn/steer": { params: TurnSteerParams; result: TurnSteerResult };
	"turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResult };
	"gjc/state/read": { params: GjcStateReadParams; result: GjcStateReadResult };
	"gjc/messages/get": { params: GjcMessagesGetParams; result: GjcMessagesGetResult };
	"gjc/model/set": { params: GjcModelSetParams; result: GjcModelSetResult };
	"gjc/todos/set": { params: GjcTodosSetParams; result: GjcTodosSetResult };
	"gjc/compact": { params: GjcCompactParams; result: GjcCompactResult };
	"gjc/hostTools/set": { params: GjcHostToolsSetParams; result: GjcHostToolsSetResult };
	"gjc/hostTools/result": { params: GjcHostToolsResultParams; result: GjcHostToolsResultResult };
	"gjc/hostTools/update": { params: GjcHostToolsUpdateParams; result: GjcHostToolsUpdateResult };
};

export type AppServerMethod = keyof AppServerRequestMap;
export type AppServerParams<M extends AppServerMethod> = AppServerRequestMap[M]["params"];
export type AppServerResult<M extends AppServerMethod> = AppServerRequestMap[M]["result"];

export type ClientNotificationMap = {
	initialized: InitializedParams;
};

export type WebSocketLike = {
	readonly readyState?: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void;
	removeEventListener?(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type AppServerClientOptions = {
	webSocketFactory?: WebSocketFactory;
};

type PendingRequest = {
	resolve(value: JsonValue | undefined): void;
	reject(reason: unknown): void;
};

export class AppServerResponseError extends Error {
	readonly code: number;
	readonly data: JsonValue | undefined;
	readonly error: AppServerError;

	constructor(error: AppServerError) {
		super(error.message);
		this.name = "AppServerResponseError";
		this.code = error.code;
		this.data = error.data;
		this.error = error;
	}
}

export class AppServerConnectionError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AppServerConnectionError";
	}
}

export class AppServerClient {
	#socket: WebSocketLike | undefined;
	#nextId = 1;
	#pending = new Map<RequestId, PendingRequest>();
	#notificationListeners = new Set<(notification: ServerNotificationEnvelope) => void>();
	readonly #webSocketFactory: WebSocketFactory;

	constructor(options: AppServerClientOptions = {}) {
		this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
	}

	connect(url: string): Promise<void> {
		if (this.#socket) this.close();
		const socket = this.#webSocketFactory(url);
		this.#socket = socket;
		socket.addEventListener("message", this.#handleMessage);
		socket.addEventListener("close", this.#handleClose);
		socket.addEventListener("error", this.#handleError);

		if (socket.readyState === 1) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const onOpen = () => {
				socket.removeEventListener?.("open", onOpen);
				socket.removeEventListener?.("error", onError);
				resolve();
			};
			const onError = (event: unknown) => {
				socket.removeEventListener?.("open", onOpen);
				socket.removeEventListener?.("error", onError);
				reject(new AppServerConnectionError("Failed to connect to app server", { cause: event }));
			};
			socket.addEventListener("open", onOpen);
			socket.addEventListener("error", onError);
		});
	}

	close(code?: number, reason?: string): void {
		const socket = this.#socket;
		if (!socket) return;
		this.#socket = undefined;
		socket.removeEventListener?.("message", this.#handleMessage);
		socket.removeEventListener?.("close", this.#handleClose);
		socket.removeEventListener?.("error", this.#handleError);
		socket.close(code, reason);
		this.#rejectAll(new AppServerConnectionError("App server connection closed"));
	}

	request<M extends AppServerMethod>(method: M, params: AppServerParams<M>): Promise<AppServerResult<M>> {
		const socket = this.#socket;
		if (!socket) return Promise.reject(new AppServerConnectionError("App server client is not connected"));
		const id = this.#nextId++;
		const payload = JSON.stringify({ id, method, params });
		return new Promise((resolve, reject) => {
			this.#pending.set(id, {
				resolve: value => resolve(value as AppServerResult<M>),
				reject,
			});
			try {
				socket.send(payload);
			} catch (error) {
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	notify<M extends keyof ClientNotificationMap>(method: M, params: ClientNotificationMap[M]): void {
		const socket = this.#socket;
		if (!socket) throw new AppServerConnectionError("App server client is not connected");
		socket.send(JSON.stringify({ method, params }));
	}

	onNotification(listener: (notification: ServerNotificationEnvelope) => void): () => void;
	onNotification<M extends ServerNotificationMethod>(
		method: M,
		listener: (params: ServerNotificationMap[M]) => void,
	): () => void;
	onNotification<M extends ServerNotificationMethod>(
		methodOrListener: M | ((notification: ServerNotificationEnvelope) => void),
		listener?: (params: ServerNotificationMap[M]) => void,
	): () => void {
		const wrapped =
			typeof methodOrListener === "function"
				? methodOrListener
				: (notification: ServerNotificationEnvelope) => {
						if (notification.method === methodOrListener)
							listener?.(notification.params as ServerNotificationMap[M]);
					};
		this.#notificationListeners.add(wrapped);
		return () => this.#notificationListeners.delete(wrapped);
	}

	initialize(params: InitializeParams = {}): Promise<InitializeResult> {
		return this.request("initialize", params);
	}

	threadStart(params: ThreadStartParams): Promise<ThreadResult> {
		return this.request("thread/start", params);
	}

	threadResume(params: ThreadResumeParams): Promise<ThreadResumeResult> {
		return this.request("thread/resume", params);
	}

	threadRead(params: ThreadReadParams): Promise<ThreadReadResult> {
		return this.request("thread/read", params);
	}

	turnStart(params: TurnStartParams): Promise<TurnStartResult> {
		return this.request("turn/start", params);
	}

	turnSteer(params: TurnSteerParams): Promise<TurnSteerResult> {
		return this.request("turn/steer", params);
	}

	turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResult> {
		return this.request("turn/interrupt", params);
	}

	gjcStateRead(params: GjcStateReadParams): Promise<GjcStateReadResult> {
		return this.request("gjc/state/read", params);
	}

	gjcMessagesGet(params: GjcMessagesGetParams): Promise<GjcMessagesGetResult> {
		return this.request("gjc/messages/get", params);
	}

	gjcModelSet(params: GjcModelSetParams): Promise<GjcModelSetResult> {
		return this.request("gjc/model/set", params);
	}

	gjcTodosSet(params: GjcTodosSetParams): Promise<GjcTodosSetResult> {
		return this.request("gjc/todos/set", params);
	}

	gjcCompact(params: GjcCompactParams): Promise<GjcCompactResult> {
		return this.request("gjc/compact", params);
	}

	gjcHostToolsSet(params: GjcHostToolsSetParams): Promise<GjcHostToolsSetResult> {
		return this.request("gjc/hostTools/set", params);
	}

	gjcHostToolsResult(params: GjcHostToolsResultParams): Promise<GjcHostToolsResultResult> {
		return this.request("gjc/hostTools/result", params);
	}

	gjcHostToolsUpdate(params: GjcHostToolsUpdateParams): Promise<GjcHostToolsUpdateResult> {
		return this.request("gjc/hostTools/update", params);
	}

	#handleMessage = (event: { data: unknown }): void => {
		const payload = parsePayload(event.data);
		if (isResponse(payload)) {
			this.#handleResponse(payload);
			return;
		}
		if (isNotification(payload)) {
			for (const listener of this.#notificationListeners) listener(payload);
		}
	};

	#handleResponse(response: Response): void {
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		if (response.error) {
			pending.reject(new AppServerResponseError(response.error));
			return;
		}
		pending.resolve(response.result);
	}

	#handleClose = (event: unknown): void => {
		this.#socket = undefined;
		this.#rejectAll(new AppServerConnectionError("App server connection closed", { cause: event }));
	};

	#handleError = (event: unknown): void => {
		this.#rejectAll(new AppServerConnectionError("App server connection failed", { cause: event }));
	};

	#rejectAll(reason: unknown): void {
		for (const pending of this.#pending.values()) pending.reject(reason);
		this.#pending.clear();
	}
}

function defaultWebSocketFactory(url: string): WebSocketLike {
	if (typeof WebSocket === "undefined")
		throw new AppServerConnectionError("No global WebSocket implementation is available");
	return new WebSocket(url);
}

function parsePayload(data: unknown): unknown {
	if (typeof data === "string") return JSON.parse(data);
	if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
	return data;
}

function isResponse(payload: unknown): payload is Response {
	return typeof payload === "object" && payload !== null && "id" in payload;
}

function isNotification(payload: unknown): payload is ServerNotificationEnvelope {
	return typeof payload === "object" && payload !== null && "method" in payload && !("id" in payload);
}
