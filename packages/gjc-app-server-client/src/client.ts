import type {
	AppServerError,
	EmptyResult,
	GjcAgentsListResult,
	GjcAppearanceReadParams,
	GjcAppearanceReadResult,
	GjcAppearanceSetParams,
	GjcAppearanceSetResult,
	GjcAppearanceThemesListParams,
	GjcAppearanceThemesListResult,
	GjcAuthLoginCancelParams,
	GjcAuthLoginCancelResult,
	GjcAuthLoginCompleteParams,
	GjcAuthLoginCompleteResult,
	GjcAuthLoginPollParams,
	GjcAuthLoginPollResult,
	GjcAuthLoginStartParams,
	GjcAuthLoginStartResult,
	GjcAuthLogoutParams,
	GjcAuthLogoutResult,
	GjcAuthStatusParams,
	GjcAuthStatusResult,
	GjcCommandsListParams,
	GjcCommandsListResult,
	GjcCompactParams,
	GjcCompactResult,
	GjcCompactSummaryResult,
	GjcContextReadParams,
	GjcContextReadResult,
	GjcExtensionsInspectParams,
	GjcExtensionsInspectResult,
	GjcExtensionsListParams,
	GjcExtensionsListResult,
	GjcExtensionsSetEnabledParams,
	GjcExtensionsSetEnabledResult,
	GjcFastReadResult,
	GjcFastSetParams,
	GjcFastSetResult,
	GjcGoalReadParams,
	GjcGoalReadResult,
	GjcHostToolsResultParams,
	GjcHostToolsResultResult,
	GjcHostToolsSetParams,
	GjcHostToolsSetResult,
	GjcHostToolsUpdateParams,
	GjcHostToolsUpdateResult,
	GjcJobsListResult,
	GjcMessagesGetParams,
	GjcMessagesGetResult,
	GjcModelAssignParams,
	GjcModelAssignResult,
	GjcModelCatalogResult,
	GjcModelSetParams,
	GjcModelSetResult,
	GjcMonitorsListResult,
	GjcPluginsInspectParams,
	GjcPluginsInspectResult,
	GjcPluginsListParams,
	GjcPluginsListResult,
	GjcPluginsSetEnabledParams,
	GjcPluginsSetEnabledResult,
	GjcPluginsSetFeatureParams,
	GjcPluginsSetFeatureResult,
	GjcPluginsSetSettingParams,
	GjcPluginsSetSettingResult,
	GjcProviderAddParams,
	GjcProviderAddResult,
	GjcProviderListParams,
	GjcProviderListResult,
	GjcRetryParams,
	GjcRetryResult,
	GjcSessionDeleteParams,
	GjcSessionDeleteResult,
	GjcSessionExportParams,
	GjcSessionExportResult,
	GjcSessionLabelParams,
	GjcSessionLabelResult,
	GjcSessionListParams,
	GjcSessionListResult,
	GjcSessionMoveParams,
	GjcSessionMoveResult,
	GjcSessionNavigateParams,
	GjcSessionNavigateResult,
	GjcSessionOpenParams,
	GjcSessionOpenResult,
	GjcSessionRenameParams,
	GjcSessionRenameResult,
	GjcSessionSearchParams,
	GjcSessionSearchResult,
	GjcSessionTreeParams,
	GjcSessionTreeResult,
	GjcSettingsReadParams,
	GjcSettingsReadResult,
	GjcSettingsSchemaParams,
	GjcSettingsSchemaResult,
	GjcSettingsUpdateParams,
	GjcSettingsUpdateResult,
	GjcSkillsListParams,
	GjcSkillsListResult,
	GjcSkillsSetEnabledParams,
	GjcSkillsSetEnabledResult,
	GjcStateReadParams,
	GjcStateReadResult,
	GjcThinkingReadResult,
	GjcThinkingSetParams,
	GjcThinkingSetResult,
	GjcThreadReadParams,
	GjcTodosReadResult,
	GjcTodosSetParams,
	GjcTodosSetResult,
	GjcToolsListParams,
	GjcToolsListResult,
	GjcUsageReadResult,
	HostUriResultParams,
	HostUriSchemesSetParams,
	HostUriSchemesSetResult,
	InitializedParams,
	InitializeParams,
	InitializeResult,
	JsonValue,
	RequestId,
	Response,
	RpcWorkflowGateResolution,
	ServerNotificationEnvelope,
	ServerNotificationMap,
	ServerNotificationMethod,
	ThreadForkParams,
	ThreadIdParams,
	ThreadLoadedListParams,
	ThreadLoadedListResult,
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
	WorkflowGateListParams,
	WorkflowGateListResult,
	WorkflowGateRespondParams,
} from "./generated/protocol";

export type AppServerRequestMap = {
	initialize: { params: InitializeParams; result: InitializeResult };
	"thread/start": { params: ThreadStartParams; result: ThreadResult };
	"thread/resume": { params: ThreadResumeParams; result: ThreadResumeResult };
	"thread/fork": { params: ThreadForkParams; result: ThreadResult };
	"thread/delete": { params: ThreadIdParams; result: EmptyResult };
	"thread/archive": { params: ThreadIdParams; result: EmptyResult };
	"thread/read": { params: ThreadReadParams; result: ThreadReadResult };
	"thread/loaded/list": { params: ThreadLoadedListParams; result: ThreadLoadedListResult };
	"turn/start": { params: TurnStartParams; result: TurnStartResult };
	"turn/steer": { params: TurnSteerParams; result: TurnSteerResult };
	"turn/interrupt": { params: TurnInterruptParams; result: TurnInterruptResult };
	"gjc/retry": { params: GjcRetryParams; result: GjcRetryResult };
	"gjc/state/read": { params: GjcStateReadParams; result: GjcStateReadResult };
	"gjc/context/read": { params: GjcContextReadParams; result: GjcContextReadResult };
	"gjc/goal/read": { params: GjcGoalReadParams; result: GjcGoalReadResult };
	"gjc/model/catalog": { params: GjcThreadReadParams; result: GjcModelCatalogResult };
	"gjc/thinking/read": { params: GjcThreadReadParams; result: GjcThinkingReadResult };
	"gjc/thinking/set": { params: GjcThinkingSetParams; result: GjcThinkingSetResult };
	"gjc/fast/read": { params: GjcThreadReadParams; result: GjcFastReadResult };
	"gjc/fast/set": { params: GjcFastSetParams; result: GjcFastSetResult };
	"gjc/settings/schema": { params: GjcSettingsSchemaParams; result: GjcSettingsSchemaResult };
	"gjc/settings/read": { params: GjcSettingsReadParams; result: GjcSettingsReadResult };
	"gjc/settings/update": { params: GjcSettingsUpdateParams; result: GjcSettingsUpdateResult };
	"gjc/appearance/themes/list": { params: GjcAppearanceThemesListParams; result: GjcAppearanceThemesListResult };
	"gjc/appearance/read": { params: GjcAppearanceReadParams; result: GjcAppearanceReadResult };
	"gjc/appearance/set": { params: GjcAppearanceSetParams; result: GjcAppearanceSetResult };
	"gjc/provider/list": { params: GjcProviderListParams; result: GjcProviderListResult };
	"gjc/auth/status": { params: GjcAuthStatusParams; result: GjcAuthStatusResult };
	"gjc/auth/logout": { params: GjcAuthLogoutParams; result: GjcAuthLogoutResult };
	"gjc/provider/add": { params: GjcProviderAddParams; result: GjcProviderAddResult };
	"gjc/auth/login/start": { params: GjcAuthLoginStartParams; result: GjcAuthLoginStartResult };
	"gjc/auth/login/poll": { params: GjcAuthLoginPollParams; result: GjcAuthLoginPollResult };
	"gjc/auth/login/complete": { params: GjcAuthLoginCompleteParams; result: GjcAuthLoginCompleteResult };
	"gjc/auth/login/cancel": { params: GjcAuthLoginCancelParams; result: GjcAuthLoginCancelResult };
	"gjc/todos/read": { params: GjcThreadReadParams; result: GjcTodosReadResult };
	"gjc/usage/read": { params: GjcThreadReadParams; result: GjcUsageReadResult };
	"gjc/jobs/list": { params: GjcThreadReadParams; result: GjcJobsListResult };
	"gjc/agents/list": { params: GjcThreadReadParams; result: GjcAgentsListResult };
	"gjc/monitors/list": { params: GjcThreadReadParams; result: GjcMonitorsListResult };
	"gjc/compact/summary": { params: GjcThreadReadParams; result: GjcCompactSummaryResult };
	"gjc/session/list": { params: GjcSessionListParams; result: GjcSessionListResult };
	"gjc/session/search": { params: GjcSessionSearchParams; result: GjcSessionSearchResult };
	"gjc/session/rename": { params: GjcSessionRenameParams; result: GjcSessionRenameResult };
	"gjc/session/open": { params: GjcSessionOpenParams; result: GjcSessionOpenResult };
	"gjc/session/delete": { params: GjcSessionDeleteParams; result: GjcSessionDeleteResult };
	"gjc/session/export": { params: GjcSessionExportParams; result: GjcSessionExportResult };
	"gjc/session/tree": { params: GjcSessionTreeParams; result: GjcSessionTreeResult };
	"gjc/session/navigate": { params: GjcSessionNavigateParams; result: GjcSessionNavigateResult };
	"gjc/session/move": { params: GjcSessionMoveParams; result: GjcSessionMoveResult };
	"gjc/session/label": { params: GjcSessionLabelParams; result: GjcSessionLabelResult };
	"gjc/tools/list": { params: GjcToolsListParams; result: GjcToolsListResult };
	"gjc/commands/list": { params: GjcCommandsListParams; result: GjcCommandsListResult };
	"gjc/skills/list": { params: GjcSkillsListParams; result: GjcSkillsListResult };
	"gjc/skills/setEnabled": { params: GjcSkillsSetEnabledParams; result: GjcSkillsSetEnabledResult };
	"gjc/extensions/list": { params: GjcExtensionsListParams; result: GjcExtensionsListResult };
	"gjc/extensions/inspect": { params: GjcExtensionsInspectParams; result: GjcExtensionsInspectResult };
	"gjc/extensions/setEnabled": { params: GjcExtensionsSetEnabledParams; result: GjcExtensionsSetEnabledResult };
	"gjc/plugins/list": { params: GjcPluginsListParams; result: GjcPluginsListResult };
	"gjc/plugins/inspect": { params: GjcPluginsInspectParams; result: GjcPluginsInspectResult };
	"gjc/plugins/setEnabled": { params: GjcPluginsSetEnabledParams; result: GjcPluginsSetEnabledResult };
	"gjc/plugins/setFeature": { params: GjcPluginsSetFeatureParams; result: GjcPluginsSetFeatureResult };
	"gjc/plugins/setSetting": { params: GjcPluginsSetSettingParams; result: GjcPluginsSetSettingResult };
	"gjc/messages/get": { params: GjcMessagesGetParams; result: GjcMessagesGetResult };
	"gjc/model/set": { params: GjcModelSetParams; result: GjcModelSetResult };
	"gjc/model/assign": { params: GjcModelAssignParams; result: GjcModelAssignResult };
	"gjc/todos/set": { params: GjcTodosSetParams; result: GjcTodosSetResult };
	"gjc/compact": { params: GjcCompactParams; result: GjcCompactResult };
	"gjc/hostTools/set": { params: GjcHostToolsSetParams; result: GjcHostToolsSetResult };
	"gjc/hostTools/result": { params: GjcHostToolsResultParams; result: GjcHostToolsResultResult };
	"gjc/hostTools/update": { params: GjcHostToolsUpdateParams; result: GjcHostToolsUpdateResult };
	"gjc/hostUriSchemes/set": { params: HostUriSchemesSetParams; result: HostUriSchemesSetResult };
	"gjc/hostUris/result": { params: HostUriResultParams; result: EmptyResult };
	"gjc/workflowGate/list": { params: WorkflowGateListParams; result: WorkflowGateListResult };
	"gjc/workflowGate/respond": { params: WorkflowGateRespondParams; result: RpcWorkflowGateResolution };
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

	threadFork(params: ThreadForkParams): Promise<ThreadResult> {
		return this.request("thread/fork", params);
	}

	threadDelete(params: ThreadIdParams): Promise<EmptyResult> {
		return this.request("thread/delete", params);
	}

	threadArchive(params: ThreadIdParams): Promise<EmptyResult> {
		return this.request("thread/archive", params);
	}

	threadRead(params: ThreadReadParams): Promise<ThreadReadResult> {
		return this.request("thread/read", params);
	}

	threadLoadedList(params: ThreadLoadedListParams = {}): Promise<ThreadLoadedListResult> {
		return this.request("thread/loaded/list", params);
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

	gjcRetry(params: GjcRetryParams): Promise<GjcRetryResult> {
		return this.request("gjc/retry", params);
	}

	gjcStateRead(params: GjcStateReadParams): Promise<GjcStateReadResult> {
		return this.request("gjc/state/read", params);
	}

	gjcContextRead(params: GjcContextReadParams): Promise<GjcContextReadResult> {
		return this.request("gjc/context/read", params);
	}

	gjcGoalRead(params: GjcGoalReadParams): Promise<GjcGoalReadResult> {
		return this.request("gjc/goal/read", params);
	}

	gjcModelCatalog(params: GjcThreadReadParams): Promise<GjcModelCatalogResult> {
		return this.request("gjc/model/catalog", params);
	}
	gjcThinkingRead(params: GjcThreadReadParams): Promise<GjcThinkingReadResult> {
		return this.request("gjc/thinking/read", params);
	}
	gjcThinkingSet(params: GjcThinkingSetParams): Promise<GjcThinkingSetResult> {
		return this.request("gjc/thinking/set", params);
	}
	gjcFastRead(params: GjcThreadReadParams): Promise<GjcFastReadResult> {
		return this.request("gjc/fast/read", params);
	}
	gjcFastSet(params: GjcFastSetParams): Promise<GjcFastSetResult> {
		return this.request("gjc/fast/set", params);
	}
	gjcSettingsSchema(params: GjcSettingsSchemaParams = {}): Promise<GjcSettingsSchemaResult> {
		return this.request("gjc/settings/schema", params);
	}
	gjcSettingsRead(params: GjcSettingsReadParams = {}): Promise<GjcSettingsReadResult> {
		return this.request("gjc/settings/read", params);
	}
	gjcSettingsUpdate(params: GjcSettingsUpdateParams): Promise<GjcSettingsUpdateResult> {
		return this.request("gjc/settings/update", params);
	}
	gjcAppearanceThemesList(params: GjcAppearanceThemesListParams = {}): Promise<GjcAppearanceThemesListResult> {
		return this.request("gjc/appearance/themes/list", params);
	}
	gjcAppearanceRead(params: GjcAppearanceReadParams = {}): Promise<GjcAppearanceReadResult> {
		return this.request("gjc/appearance/read", params);
	}
	gjcAppearanceSet(params: GjcAppearanceSetParams): Promise<GjcAppearanceSetResult> {
		return this.request("gjc/appearance/set", params);
	}
	gjcProviderList(params: GjcProviderListParams = {}): Promise<GjcProviderListResult> {
		return this.request("gjc/provider/list", params);
	}
	gjcAuthStatus(params: GjcAuthStatusParams = {}): Promise<GjcAuthStatusResult> {
		return this.request("gjc/auth/status", params);
	}
	gjcAuthLogout(params: GjcAuthLogoutParams): Promise<GjcAuthLogoutResult> {
		return this.request("gjc/auth/logout", params);
	}
	gjcProviderAdd(params: GjcProviderAddParams): Promise<GjcProviderAddResult> {
		return this.request("gjc/provider/add", params);
	}
	gjcAuthLoginStart(params: GjcAuthLoginStartParams): Promise<GjcAuthLoginStartResult> {
		return this.request("gjc/auth/login/start", params);
	}
	gjcAuthLoginPoll(params: GjcAuthLoginPollParams): Promise<GjcAuthLoginPollResult> {
		return this.request("gjc/auth/login/poll", params);
	}
	gjcAuthLoginComplete(params: GjcAuthLoginCompleteParams): Promise<GjcAuthLoginCompleteResult> {
		return this.request("gjc/auth/login/complete", params);
	}
	gjcAuthLoginCancel(params: GjcAuthLoginCancelParams): Promise<GjcAuthLoginCancelResult> {
		return this.request("gjc/auth/login/cancel", params);
	}
	gjcTodosRead(params: GjcThreadReadParams): Promise<GjcTodosReadResult> {
		return this.request("gjc/todos/read", params);
	}
	gjcUsageRead(params: GjcThreadReadParams): Promise<GjcUsageReadResult> {
		return this.request("gjc/usage/read", params);
	}
	gjcJobsList(params: GjcThreadReadParams): Promise<GjcJobsListResult> {
		return this.request("gjc/jobs/list", params);
	}
	gjcAgentsList(params: GjcThreadReadParams): Promise<GjcAgentsListResult> {
		return this.request("gjc/agents/list", params);
	}
	gjcMonitorsList(params: GjcThreadReadParams): Promise<GjcMonitorsListResult> {
		return this.request("gjc/monitors/list", params);
	}
	gjcCompactSummary(params: GjcThreadReadParams): Promise<GjcCompactSummaryResult> {
		return this.request("gjc/compact/summary", params);
	}

	gjcSessionList(params: GjcSessionListParams = {}): Promise<GjcSessionListResult> {
		return this.request("gjc/session/list", params);
	}

	gjcSessionSearch(params: GjcSessionSearchParams): Promise<GjcSessionSearchResult> {
		return this.request("gjc/session/search", params);
	}

	gjcSessionRename(params: GjcSessionRenameParams): Promise<GjcSessionRenameResult> {
		return this.request("gjc/session/rename", params);
	}

	gjcSessionOpen(params: GjcSessionOpenParams): Promise<GjcSessionOpenResult> {
		return this.request("gjc/session/open", params);
	}

	gjcSessionDelete(params: GjcSessionDeleteParams): Promise<GjcSessionDeleteResult> {
		return this.request("gjc/session/delete", params);
	}

	gjcSessionExport(params: GjcSessionExportParams): Promise<GjcSessionExportResult> {
		return this.request("gjc/session/export", params);
	}

	gjcSessionTree(params: GjcSessionTreeParams): Promise<GjcSessionTreeResult> {
		return this.request("gjc/session/tree", params);
	}

	gjcSessionNavigate(params: GjcSessionNavigateParams): Promise<GjcSessionNavigateResult> {
		return this.request("gjc/session/navigate", params);
	}

	gjcSessionMove(params: GjcSessionMoveParams): Promise<GjcSessionMoveResult> {
		return this.request("gjc/session/move", params);
	}

	gjcSessionLabel(params: GjcSessionLabelParams): Promise<GjcSessionLabelResult> {
		return this.request("gjc/session/label", params);
	}

	gjcToolsList(params: GjcToolsListParams): Promise<GjcToolsListResult> {
		return this.request("gjc/tools/list", params);
	}

	gjcCommandsList(params: GjcCommandsListParams): Promise<GjcCommandsListResult> {
		return this.request("gjc/commands/list", params);
	}

	gjcSkillsList(params: GjcSkillsListParams): Promise<GjcSkillsListResult> {
		return this.request("gjc/skills/list", params);
	}

	gjcSkillsSetEnabled(params: GjcSkillsSetEnabledParams): Promise<GjcSkillsSetEnabledResult> {
		return this.request("gjc/skills/setEnabled", params);
	}

	gjcExtensionsList(params: GjcExtensionsListParams): Promise<GjcExtensionsListResult> {
		return this.request("gjc/extensions/list", params);
	}

	gjcExtensionsInspect(params: GjcExtensionsInspectParams): Promise<GjcExtensionsInspectResult> {
		return this.request("gjc/extensions/inspect", params);
	}

	gjcExtensionsSetEnabled(params: GjcExtensionsSetEnabledParams): Promise<GjcExtensionsSetEnabledResult> {
		return this.request("gjc/extensions/setEnabled", params);
	}

	gjcPluginsList(params: GjcPluginsListParams): Promise<GjcPluginsListResult> {
		return this.request("gjc/plugins/list", params);
	}

	gjcPluginsInspect(params: GjcPluginsInspectParams): Promise<GjcPluginsInspectResult> {
		return this.request("gjc/plugins/inspect", params);
	}

	gjcPluginsSetEnabled(params: GjcPluginsSetEnabledParams): Promise<GjcPluginsSetEnabledResult> {
		return this.request("gjc/plugins/setEnabled", params);
	}

	gjcPluginsSetFeature(params: GjcPluginsSetFeatureParams): Promise<GjcPluginsSetFeatureResult> {
		return this.request("gjc/plugins/setFeature", params);
	}

	gjcPluginsSetSetting(params: GjcPluginsSetSettingParams): Promise<GjcPluginsSetSettingResult> {
		return this.request("gjc/plugins/setSetting", params);
	}

	gjcMessagesGet(params: GjcMessagesGetParams): Promise<GjcMessagesGetResult> {
		return this.request("gjc/messages/get", params);
	}

	gjcModelSet(params: GjcModelSetParams): Promise<GjcModelSetResult> {
		return this.request("gjc/model/set", params);
	}

	gjcModelAssign(params: GjcModelAssignParams): Promise<GjcModelAssignResult> {
		return this.request("gjc/model/assign", params);
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

	gjcHostUriSchemesSet(params: HostUriSchemesSetParams): Promise<HostUriSchemesSetResult> {
		return this.request("gjc/hostUriSchemes/set", params);
	}

	gjcHostUrisResult(params: HostUriResultParams): Promise<EmptyResult> {
		return this.request("gjc/hostUris/result", params);
	}

	gjcWorkflowGateList(params: WorkflowGateListParams): Promise<WorkflowGateListResult> {
		return this.request("gjc/workflowGate/list", params);
	}

	gjcWorkflowGateRespond(params: WorkflowGateRespondParams): Promise<RpcWorkflowGateResolution> {
		return this.request("gjc/workflowGate/respond", params);
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
