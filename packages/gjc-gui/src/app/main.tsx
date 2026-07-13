import {
	AppServerClient,
	type GjcCommandsListResult,
	type GjcProviderAddParams,
	type GjcProviderListResult,
	type GjcSessionListResult,
	type GjcSessionTreeResult,
	type GjcToolsListResult,
	type JsonValue,
	type RpcWorkflowGateResolution,
} from "@gajae-code/app-server-client";
import { invoke } from "@tauri-apps/api/core";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../design-tokens/index.ts";
import { CommandPalette } from "./command-palette.tsx";
import type { PaletteCommand, PaletteTool } from "./command-palette-logic";
import {
	type ConnectionState,
	describeFailure,
	errorMessage,
	failureCopy,
	failureTitle,
	redactDetail,
	safeEndpoint,
} from "./connection-state-logic";
import {
	basename,
	DEFAULT_CWD,
	normalizeDirectoryInput,
	readRecentDirectories,
	recentDirectoryDisplay,
	redactDirectoryPath,
	rememberDirectoryValue,
	writeRecentDirectories,
} from "./directory-logic";
import {
	type AppearancePreviewState,
	type AppearanceSettings,
	type AppearanceTheme,
	commitAppearancePreview,
	createAppearancePreviewState,
	type Extension,
	type Plugin,
	type PluginInspection,
	pluginSettingPayload,
	restoreAppearancePreview,
	type Skill,
	setEnabledPayload,
} from "./extensibility-logic";
import { ExtensibilityPanel } from "./extensibility-panel.tsx";
import { LoginFlowSheet } from "./login-flow-sheet.tsx";
import { Markdown } from "./markdown.tsx";
import { ModelPanel } from "./model-panel.tsx";
import { redactHostUri, safeToolText, safeWorkflowGateContext } from "./redaction-logic";
import { SessionActions } from "./session-actions.tsx";
import {
	flattenSessionTree,
	markThreadArchived,
	provenanceLabel,
	removeThread,
	validateRenameTitle,
} from "./session-actions-logic";
import {
	type ApprovalGate,
	appendLocalUserMessage,
	cleanAssistantText,
	emptyTranscriptState,
	foldNotification,
	markApproval,
	modelLabelFromStateRead,
	type TranscriptItem,
	type TranscriptState,
	upsertThread,
} from "./transcript";
import { lastAssistantText, serializeTranscript } from "./transcript-export-logic";
import "./session-browser.css";
import "./styles.css";
import { shouldStickToBottom } from "./scroll-follow-logic";

export type EndpointDescriptor = { url: string; token: string };
export type { ConnectionState } from "./connection-state-logic";

type PaletteData = {
	commands: PaletteCommand[];
	tools: PaletteTool[];
	loading: boolean;
	error?: string;
};

type ExtensibilityData = {
	skills: Skill[];
	extensions: Extension[];
	plugins: Plugin[];
	extensionInspection?: Extension;
	pluginInspection?: PluginInspection;
	appearance?: AppearancePreviewState;
	themes: AppearanceTheme[];
	loading: boolean;
	error?: string;
};
type SessionBrowserData = {
	sessions: GjcSessionListResult["sessions"];
	query: string;
	loading: boolean;
	tree?: GjcSessionTreeResult;
	error?: string;
	exportStatus?: string;
};

type ProviderData = {
	providers: GjcProviderListResult["providers"];
	loading: boolean;
	error?: string;
};

export type WorkspaceView = "chat" | "extensibility";

export type AppHostDeps = {
	resolveEndpoint(): Promise<EndpointDescriptor>;
	createClient(options: { webSocketFactory(url: string): WebSocket }): AppServerClient;
	createWebSocket(url: string): WebSocket;
	pickDirectory(): Promise<string | null>;
	clipboard: Pick<Clipboard, "writeText">;
	storage: Pick<Storage, "getItem" | "setItem">;
	timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout" | "requestAnimationFrame">;
	openExternal?(url: string): void;
};

export type AppInitialState = {
	connection?: ConnectionState;
	transcript?: TranscriptState;
	workspaceView?: WorkspaceView;
	recentDirectories?: string[];
	helpOpen?: boolean;
	workingDirectory?: string;
};

export function createAppHostDeps(overrides: Partial<AppHostDeps> = {}): AppHostDeps {
	return {
		resolveEndpoint,
		createClient: ({ webSocketFactory }) => new AppServerClient({ webSocketFactory }),
		createWebSocket: url => new WebSocket(url),
		pickDirectory: () => invoke<string | null>("pick_directory"),
		clipboard: typeof navigator === "undefined" ? { writeText: async () => undefined } : navigator.clipboard,
		storage: typeof localStorage === "undefined" ? { getItem: () => null, setItem: () => undefined } : localStorage,
		timers: globalThis,
		openExternal: url => window.open(url, "_blank", "noopener,noreferrer"),
		...overrides,
	};
}

export function createApp(options: { deps?: AppHostDeps; autoConnect?: boolean; initialState?: AppInitialState } = {}) {
	return <App deps={options.deps} autoConnect={options.autoConnect} initialState={options.initialState} />;
}

export function startChatDirectory(workingDirectory: string): string | undefined {
	const normalized = normalizeDirectoryInput(workingDirectory);
	return normalized || (workingDirectory.trim() ? undefined : DEFAULT_CWD);
}

const DEFERRED_EXEC_STATE_ROWS = [
	["todos", "Task progress will appear here when available."],
	["context", "Context usage will appear here when available."],
	["usage", "Provider and token usage will appear here when available."],
	["jobs", "Background job progress will appear here when available."],
	["agents", "Active agent status will appear here when available."],
	["monitors", "Monitor streams will appear here when available."],
	["retry", "Retry controls are coming later."],
] as const;

const root = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-gjc-app-root]");
if (root)
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);

function App({
	deps,
	autoConnect = true,
	initialState,
}: {
	deps?: AppHostDeps;
	autoConnect?: boolean;
	initialState?: AppInitialState;
}) {
	const host = useMemo(() => createAppHostDeps(deps), [deps]);
	const [connection, setConnection] = useState<ConnectionState>(initialState?.connection ?? { kind: "booting" });
	const [transcript, setTranscript] = useState<TranscriptState>(
		() => initialState?.transcript ?? emptyTranscriptState(),
	);
	const [client, setClient] = useState<AppServerClient>();
	const [composer, setComposer] = useState("");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [paletteData, setPaletteData] = useState<PaletteData>({ commands: [], tools: [], loading: false });
	const [extData, setExtData] = useState<ExtensibilityData>({
		skills: [],
		extensions: [],
		plugins: [],
		themes: [],
		loading: initialState?.workspaceView === "extensibility",
	});
	const [sessionBrowser, setSessionBrowser] = useState<SessionBrowserData>({
		sessions: [],
		query: "",
		loading: false,
	});
	const [providerData, setProviderData] = useState<ProviderData>({ providers: [], loading: false });
	const [providerAddOpen, setProviderAddOpen] = useState(false);
	const [loginProviderId, setLoginProviderId] = useState<string>();
	const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(initialState?.workspaceView ?? "chat");
	const [helpOpen, setHelpOpen] = useState(initialState?.helpOpen ?? false);
	const [workingDirectory, setWorkingDirectory] = useState(initialState?.workingDirectory ?? "");
	const [recentDirectories, setRecentDirectories] = useState<string[]>(
		() => initialState?.recentDirectories ?? readRecentDirectories(host.storage),
	);
	const [isPickingDirectory, setPickingDirectory] = useState(false);
	const [isSubmitting, setSubmitting] = useState(false);
	const [setupError, setSetupError] = useState<string>();
	const [operationError, setOperationError] = useState<string>();
	const [completionStatus, setCompletionStatus] = useState("");
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
	const copyStatusTimeoutRef = useRef<number | undefined>(undefined);
	const stopRef = useRef<(() => void) | undefined>(undefined);
	const connectionGenerationRef = useRef(0);
	const sessionRequestGenerationRef = useRef(0);
	const searchDebounceRef = useRef<NodeJS.Timeout | undefined>(undefined);
	const retryTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
	const mountedRef = useRef(true);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const helpTriggerRef = useRef<HTMLButtonElement>(null);
	const transcriptRef = useRef<HTMLElement>(null);
	const transcriptBottomRef = useRef<HTMLDivElement>(null);
	const observedTurnRef = useRef(transcript.activeTurnId);
	const stickToBottomRef = useRef(true);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);

	const restoreComposerFocus = useCallback(() => {
		host.timers.requestAnimationFrame(() => composerRef.current?.focus());
	}, [host.timers]);

	const closeHelp = useCallback(() => {
		setHelpOpen(false);
		host.timers.requestAnimationFrame(() => helpTriggerRef.current?.focus());
	}, [host.timers]);

	const connect = useCallback(async (): Promise<ConnectionState> => {
		const generation = ++connectionGenerationRef.current;
		setConnection(current => ({ kind: current.kind === "connected" ? "reconnecting" : "connecting" }));
		try {
			const endpoint = await host.resolveEndpoint();
			const nextClient = host.createClient({ webSocketFactory: host.createWebSocket });
			await nextClient.connect(websocketUrl(endpoint));
			if (generation !== connectionGenerationRef.current || !mountedRef.current) {
				nextClient.close(1000, "GJC GUI stale reconnect");
				return { kind: "disconnected" };
			}
			const unsubscribe = nextClient.onNotification(notification => {
				if (generation === connectionGenerationRef.current && mountedRef.current)
					setTranscript(current => foldNotification(current, notification));
			});
			await nextClient.initialize();
			if (generation !== connectionGenerationRef.current || !mountedRef.current) {
				unsubscribe();
				nextClient.close(1000, "GJC GUI stale reconnect");
				return { kind: "disconnected" };
			}
			stopRef.current?.();
			stopRef.current = () => {
				unsubscribe();
				nextClient.close(1000, "GJC GUI reconnect");
			};
			nextClient.notify("initialized", {});
			setClient(nextClient);
			const nextConnection: ConnectionState = { kind: "connected", endpointUrl: endpoint.url };
			setConnection(nextConnection);
			restoreComposerFocus();
			void refreshSessions(nextClient);
			return nextConnection;
		} catch (error) {
			if (generation !== connectionGenerationRef.current || !mountedRef.current) return { kind: "disconnected" };
			setClient(undefined);
			const nextConnection = describeFailure(error);
			setConnection(nextConnection);
			return nextConnection;
		}
	}, [host, restoreComposerFocus]);

	useEffect(() => {
		if (!autoConnect) return;
		// Cold desktop launch spawns a bundled sidecar that can take a few
		// seconds to pass readiness; auto-retry a bounded number of times before
		// surfacing a manual Reconnect so the happy path connects unattended.
		let cancelled = false;
		let attempt = 0;
		const maxAttempts = 5;
		const run = async () => {
			while (!cancelled) {
				const state = await connect();
				attempt += 1;
				if (cancelled) return;
				if (state.kind === "connected" || attempt >= maxAttempts) return;
				const retriable =
					state.failure === "stale-discovery" ||
					state.failure === "server-unavailable" ||
					state.failure === "sidecar-crash";
				if (!retriable) return;
				await new Promise<void>(resolve => {
					retryTimeoutRef.current = host.timers.setTimeout(resolve, 1500);
				});
			}
		};
		void run();
		return () => {
			cancelled = true;
			connectionGenerationRef.current += 1;
			host.timers.clearTimeout(retryTimeoutRef.current);
			stopRef.current?.();
		};
	}, [connect]);

	const handleTranscriptScroll = useCallback(() => {
		const element = transcriptRef.current;
		if (!element) return;
		const sticky = shouldStickToBottom(element.scrollTop, element.clientHeight, element.scrollHeight);
		stickToBottomRef.current = sticky;
		setShowJumpToLatest(!sticky);
	}, []);

	const jumpToLatest = useCallback(() => {
		stickToBottomRef.current = true;
		setShowJumpToLatest(false);
		transcriptBottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
		restoreComposerFocus();
	}, [restoreComposerFocus]);

	const activeThread = useMemo(
		() => transcript.threads.find(thread => thread.id === transcript.activeThreadId) ?? transcript.threads[0],
		[transcript.activeThreadId, transcript.threads],
	);
	const activeThreadId = activeThread?.id;
	const visibleItems = (
		activeThreadId ? transcript.items.filter(item => item.threadId === activeThreadId) : transcript.items
	).filter(item => {
		if (item.role === "tool") return true;
		if (item.status === "running") return true;
		const text =
			item.role === "assistant" || item.role === "reasoning"
				? cleanAssistantText(item.content ?? "")
				: (item.content ?? "").trim();
		return text.length > 0;
	});
	// Group each response into one card: all consecutive thinking / tool /
	// assistant items (which may span several internal agent turns per user
	// message) collapse into a single card, with thinking and tools as nested
	// dropdowns and only the assistant reply text always-visible. A user (or
	// other) item breaks the run.
	const renderEntries: Array<
		{ kind: "turn"; key: string; items: TranscriptItem[] } | { kind: "item"; item: TranscriptItem }
	> = [];
	let currentTurn: { kind: "turn"; key: string; items: TranscriptItem[] } | null = null;
	for (const item of visibleItems) {
		const grouped = item.role === "reasoning" || item.role === "tool" || item.role === "assistant";
		if (grouped) {
			if (!currentTurn) {
				currentTurn = { kind: "turn", key: item.id, items: [] };
				renderEntries.push(currentTurn);
			}
			currentTurn.items.push(item);
		} else {
			currentTurn = null;
			renderEntries.push({ kind: "item", item });
		}
	}
	const visibleApprovals = activeThreadId
		? transcript.approvals.filter(approval => approval.threadId === activeThreadId)
		: transcript.approvals;
	const lastAssistantCopy = lastAssistantText(visibleItems);
	const transcriptDump = serializeTranscript(visibleItems);
	const canCopyAssistant = Boolean(lastAssistantCopy);
	const canDumpTranscript = transcriptDump.length > 0;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			host.timers.clearTimeout(copyStatusTimeoutRef.current);
			host.timers.clearTimeout(searchDebounceRef.current);
			sessionRequestGenerationRef.current++;
		};
	}, [host.timers]);

	useEffect(() => {
		if (stickToBottomRef.current) {
			transcriptBottomRef.current?.scrollIntoView({ block: "end" });
		}
	}, [visibleItems.length, visibleApprovals.length]);
	const connected = connection.kind === "connected";
	const serverReady = connected && client !== undefined;

	useEffect(() => {
		if (observedTurnRef.current && !transcript.activeTurnId) setCompletionStatus("Response complete.");
		observedTurnRef.current = transcript.activeTurnId;
	}, [transcript.activeTurnId]);

	const loadPaletteData = useCallback(async () => {
		if (!serverReady || !client || !activeThreadId) return;
		setPaletteData(current => ({ ...current, loading: true, error: undefined }));
		try {
			const [commandsResult, toolsResult]: [GjcCommandsListResult, GjcToolsListResult] = await Promise.all([
				client.gjcCommandsList({ threadId: activeThreadId, includeDisabled: true }),
				client.gjcToolsList({ threadId: activeThreadId }),
			]);
			setPaletteData({
				commands: commandsResult.commands,
				tools: toolsResult.tools,
				loading: false,
			});
		} catch (error) {
			setPaletteData(current => ({ ...current, loading: false, error: errorMessage(error) }));
		}
	}, [activeThreadId, client, serverReady]);

	const loadExtensibilityData = useCallback(async () => {
		if (!serverReady || !client || !activeThreadId) return;
		setExtData(current => ({ ...current, loading: true, error: undefined }));
		try {
			const [skillsResult, extensionsResult, pluginsResult, themesResult, appearanceResult] = await Promise.all([
				client.gjcSkillsList({ threadId: activeThreadId }),
				client.gjcExtensionsList({ threadId: activeThreadId }),
				client.gjcPluginsList({ threadId: activeThreadId }),
				client.gjcAppearanceThemesList({}),
				client.gjcAppearanceRead({}),
			]);
			setExtData(current => ({
				...current,
				skills: skillsResult.skills,
				extensions: extensionsResult.extensions,
				plugins: pluginsResult.plugins,
				extensionInspection: undefined,
				themes: themesResult.themes,
				appearance: createAppearancePreviewState(normalizeAppearanceSettings(appearanceResult)),
				loading: false,
			}));
		} catch (error) {
			setExtData(current => ({
				...current,
				appearance: current.appearance ? restoreAppearancePreview(current.appearance) : undefined,
				loading: false,
				error: errorMessage(error),
			}));
		}
	}, [activeThreadId, client, serverReady]);

	const inspectExtension = useCallback(
		async (extensionId: string) => {
			if (!serverReady || !client || !activeThreadId) return;
			try {
				const result = await client.gjcExtensionsInspect({ extensionId, threadId: activeThreadId });
				setExtData(current => ({
					...current,
					extensionInspection: result.extension ?? undefined,
					error: undefined,
				}));
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[activeThreadId, client, serverReady],
	);

	const inspectPlugin = useCallback(
		async (pluginId: string) => {
			if (!serverReady || !client || !activeThreadId) return;
			try {
				const result = await client.gjcPluginsInspect({ pluginId, threadId: activeThreadId });
				setExtData(current => ({ ...current, pluginInspection: result.plugin ?? undefined, error: undefined }));
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[activeThreadId, client, serverReady],
	);
	const previewAppearanceSettings = useCallback((next: AppearanceSettings) => {
		setExtData(current =>
			current.appearance
				? { ...current, appearance: { ...current.appearance, candidate: next, previewActive: true } }
				: current,
		);
	}, []);
	const restoreAppearanceSettings = useCallback(() => {
		setExtData(current =>
			current.appearance ? { ...current, appearance: restoreAppearancePreview(current.appearance) } : current,
		);
	}, []);
	const applyAppearanceSettings = useCallback(
		async (next: AppearanceSettings) => {
			if (!serverReady || !client) return;
			try {
				const applied = await client.gjcAppearanceSet(next);
				setExtData(current =>
					current.appearance
						? {
								...current,
								appearance: commitAppearancePreview(current.appearance, normalizeAppearanceSettings(applied)),
								error: undefined,
							}
						: current,
				);
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[client, serverReady],
	);
	const setSkillEnabled = useCallback(
		async (skillId: string, enabled: boolean) => {
			if (!serverReady || !client) return;
			try {
				await client.gjcSkillsSetEnabled(
					setEnabledPayload("skillId", skillId, enabled) as { skillId: string; enabled: boolean },
				);
				setExtData(current => ({
					...current,
					skills: current.skills.map(skill =>
						((skill as Skill & { id?: string; skillId?: string }).id ??
							(skill as Skill & { skillId?: string }).skillId ??
							skill.name) === skillId
							? { ...skill, enabled }
							: skill,
					),
					error: undefined,
				}));
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[client, serverReady],
	);
	const setExtensionEnabled = useCallback(
		async (extensionId: string, enabled: boolean) => {
			if (!serverReady || !client) return;
			try {
				await client.gjcExtensionsSetEnabled(
					setEnabledPayload("extensionId", extensionId, enabled) as { extensionId: string; enabled: boolean },
				);
				await loadExtensibilityData();
				setExtData(current => ({ ...current, error: undefined }));
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[client, loadExtensibilityData, serverReady],
	);
	const setPluginEnabled = useCallback(
		async (pluginId: string, enabled: boolean) => {
			if (!serverReady || !client) return;
			try {
				await client.gjcPluginsSetEnabled(
					setEnabledPayload("pluginId", pluginId, enabled) as { pluginId: string; enabled: boolean },
				);
				await loadExtensibilityData();
				setExtData(current => ({ ...current, error: undefined }));
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[client, loadExtensibilityData, serverReady],
	);
	const setPluginSetting = useCallback(
		async (pluginId: string, key: string, value: unknown) => {
			if (!serverReady || !client) return;
			try {
				await client.gjcPluginsSetSetting(
					pluginSettingPayload(pluginId, key, value) as { pluginId: string; key: string; value: JsonValue },
				);
				await inspectPlugin(pluginId);
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[client, inspectPlugin, serverReady],
	);
	const loadProviders = useCallback(async () => {
		if (!serverReady || !client) return;
		setProviderData(current => ({ ...current, loading: true, error: undefined }));
		try {
			const [providers, status] = await Promise.all([client.gjcProviderList({}), client.gjcAuthStatus({})]);
			const states = new Map(status.providers.map(entry => [entry.providerId, entry.state]));
			setProviderData({
				providers: providers.providers.map(provider => ({
					...provider,
					authenticated: states.get(provider.id) === "authenticated",
				})),
				loading: false,
			});
		} catch (error) {
			setProviderData(current => ({ ...current, loading: false, error: errorMessage(error) }));
		}
	}, [client, serverReady]);
	const logoutProvider = useCallback(
		async (providerId: string) => {
			if (!serverReady || !client) return;
			try {
				await client.gjcAuthLogout({ providerId });
				await loadProviders();
			} catch (error) {
				setProviderData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[client, loadProviders, serverReady],
	);
	const addProvider = useCallback(
		async (params: GjcProviderAddParams) => {
			if (!serverReady || !client) return;
			try {
				await client.gjcProviderAdd(params);
				setProviderAddOpen(false);
				await loadProviders();
			} catch (error) {
				setProviderData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[client, loadProviders, serverReady],
	);
	const loginClient = useMemo(
		() =>
			serverReady && client
				? {
						start: async (providerId: string) => {
							const result = await client.gjcAuthLoginStart({ providerId });
							return {
								flowId: result.flowId,
								state: result.state,
								authUrl: result.authUrl ?? undefined,
								instructions: result.instructions ?? undefined,
							};
						},
						poll: async (flowId: string) => {
							const result = await client.gjcAuthLoginPoll({ flowId });
							return { state: result.state, promptMessage: result.promptMessage ?? undefined };
						},
						complete: (flowId: string, redirectUrl: string) =>
							client.gjcAuthLoginComplete({ flowId, redirectUrl }),
						cancel: (flowId: string) => client.gjcAuthLoginCancel({ flowId }),
					}
				: undefined,
		[client, serverReady],
	);
	useEffect(() => {
		if (serverReady) void loadProviders();
	}, [loadProviders, serverReady]);

	useEffect(() => {
		if (workspaceView === "extensibility") void loadExtensibilityData();
	}, [loadExtensibilityData, workspaceView]);

	useEffect(() => {
		function handleGlobalKeyDown(event: KeyboardEvent) {
			if (!serverReady || !activeThreadId || event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey))
				return;
			event.preventDefault();
			setPaletteOpen(current => {
				const next = !current;
				if (next) void loadPaletteData();
				return next;
			});
		}
		window.addEventListener("keydown", handleGlobalKeyDown);
		return () => window.removeEventListener("keydown", handleGlobalKeyDown);
	}, [activeThreadId, loadPaletteData, serverReady]);

	const closePalette = useCallback(() => {
		setPaletteOpen(false);
		restoreComposerFocus();
	}, [restoreComposerFocus]);

	const insertPaletteText = useCallback((text: string) => {
		setComposer(current => current + text);
		restoreComposerFocus();
	}, []);

	async function createNewThread(): Promise<string | undefined> {
		if (!serverReady || !client) return undefined;
		const cwd = startChatDirectory(workingDirectory);
		if (!cwd) {
			setSetupError("Enter an absolute path or choose a folder.");
			return undefined;
		}
		const result = await client.threadStart({ source: "gjc-gui", cwd });
		rememberDirectory(cwd, setRecentDirectories, host.storage);
		setWorkingDirectory(cwd);
		setSetupError(undefined);
		setTranscript(current => upsertThread(current, result.thread, cwd));
		void refreshModelLabel(result.thread.id);
		return result.thread.id;
	}

	// Return the active thread id, creating one only for the first submitted message.
	async function ensureActiveThread(): Promise<string | undefined> {
		return activeThreadId ?? createNewThread();
	}

	// The active model isn't carried on ThreadSummary; read it from session state.
	async function refreshModelLabel(threadId: string): Promise<void> {
		if (!serverReady || !client) return;
		try {
			const state = await client.gjcStateRead({ threadId });
			const label = modelLabelFromStateRead(state);
			if (label) setTranscript(current => ({ ...current, modelLabel: label }));
		} catch (error) {
			setOperationError(`Could not refresh the active model: ${errorMessage(error)}`);
		}
	}

	async function startThread() {
		try {
			const id = await createNewThread();
			if (id) {
				setCompletionStatus("New chat started.");
				restoreComposerFocus();
			}
		} catch (error) {
			setSetupError(errorMessage(error));
		}
	}

	async function pickDirectory() {
		if (!serverReady) return;
		setPickingDirectory(true);
		try {
			const selected = await host.pickDirectory();
			if (selected) {
				setWorkingDirectory(selected);
				setSetupError(undefined);
			}
		} catch (error) {
			setSetupError(errorMessage(error));
		} finally {
			setPickingDirectory(false);
		}
	}

	async function resumeThread(threadId: string) {
		if (!serverReady || !client) return;
		try {
			const result = await client.threadResume({ threadId });
			setTranscript(current => upsertThread(current, result.thread));
			void refreshModelLabel(threadId);
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not resume this chat: ${errorMessage(error)}`);
		}
	}

	async function refreshSessionBrowser(sessionClient = client, query = sessionBrowser.query) {
		if (!sessionClient || (sessionClient === client && !serverReady)) return;
		const generation = ++sessionRequestGenerationRef.current;
		setSessionBrowser(current => ({ ...current, loading: true, error: undefined }));
		try {
			const params = { scope: "all" as const, limit: 100 };
			const result = query.trim()
				? await sessionClient.gjcSessionSearch({ ...params, query: query.trim() })
				: await sessionClient.gjcSessionList(params);
			if (generation !== sessionRequestGenerationRef.current || !mountedRef.current) return;
			setSessionBrowser(current => ({ ...current, sessions: result.sessions, loading: false }));
		} catch (error) {
			if (generation !== sessionRequestGenerationRef.current || !mountedRef.current) return;
			const message = errorMessage(error);
			setSessionBrowser(current => ({ ...current, loading: false, error: message }));
			setOperationError(`Could not load saved chats: ${message}`);
		}
	}

	async function openSession(sessionPath: string) {
		if (!serverReady || !client) return;
		try {
			const result = await client.gjcSessionOpen({ sessionPath });
			const readResult = await client.threadRead({ threadId: result.threadId });
			setTranscript(current => upsertThread(current, readResult.thread));
			await refreshSessionTree(result.threadId);
			void refreshModelLabel(result.threadId);
			setOperationError(undefined);
		} catch (error) {
			const message = errorMessage(error);
			setSessionBrowser(current => ({ ...current, error: message }));
			setOperationError(`Could not open this saved chat: ${message}`);
		}
	}

	async function renameSession(sessionPath: string) {
		if (!serverReady || !client) return;
		const title = window.prompt("Rename session") ?? "";
		const validation = validateRenameTitle(title);
		if (validation) {
			setSessionBrowser(current => ({ ...current, error: validation }));
			setOperationError(validation);
			return;
		}
		try {
			await client.gjcSessionRename({ sessionPath, title: title.trim() });
			await refreshSessionBrowser();
			setOperationError(undefined);
		} catch (error) {
			const message = errorMessage(error);
			setSessionBrowser(current => ({ ...current, error: message }));
			setOperationError(`Could not rename this saved chat: ${message}`);
		}
	}

	async function exportSession(sessionPath: string) {
		if (!serverReady || !client) return;
		try {
			const result = await client.gjcSessionExport({ sessionPath, format: "markdown", redact: true });
			await host.clipboard.writeText(result.content);
			setSessionBrowser(current => ({
				...current,
				exportStatus: `Copied markdown export · ${provenanceLabel(result.provenance)}`,
			}));
			setOperationError(undefined);
		} catch (error) {
			const message = errorMessage(error);
			setSessionBrowser(current => ({ ...current, exportStatus: `Export failed: ${message}` }));
			setOperationError(`Could not export this saved chat: ${message}`);
		}
	}

	async function deleteSession(sessionPath: string) {
		if (!serverReady || !client || !window.confirm("Delete this persisted session?")) return;
		try {
			await client.gjcSessionDelete({ sessionPath });
			setSessionBrowser(current => ({
				...current,
				sessions: current.sessions.filter(session => session.path !== sessionPath),
			}));
			setOperationError(undefined);
		} catch (error) {
			const message = errorMessage(error);
			setSessionBrowser(current => ({ ...current, error: message }));
			setOperationError(`Could not delete this saved chat: ${message}`);
		}
	}

	async function refreshSessionTree(threadId = activeThreadId) {
		if (!serverReady || !client || !threadId) return;
		try {
			const tree = await client.gjcSessionTree({ threadId });
			setSessionBrowser(current => ({ ...current, tree }));
		} catch (error) {
			const message = errorMessage(error);
			setSessionBrowser(current => ({ ...current, error: message }));
			setOperationError(`Could not refresh the session tree: ${message}`);
		}
	}

	async function moveThread(threadId: string) {
		if (!serverReady || !client) return;
		const targetCwd = window.prompt("Move session to absolute directory");
		if (!targetCwd) return;
		try {
			await client.gjcSessionMove({ threadId, targetCwd });
			let canonicalThread: object | undefined;
			try {
				canonicalThread = (await client.threadRead({ threadId })).thread;
			} catch {
				// The move succeeded; retain the locally known thread with its new directory when a canonical read is unavailable.
			}
			setTranscript(current => ({
				...current,
				threads: current.threads.map(thread =>
					thread.id === threadId
						? canonicalThread
							? { ...thread, ...canonicalThread }
							: { ...thread, cwd: targetCwd }
						: thread,
				),
			}));
			await refreshSessionBrowser(client);
			await refreshSessions(client, threadId);
			setOperationError(undefined);
		} catch (error) {
			const message = errorMessage(error);
			setSessionBrowser(current => ({ ...current, error: `Move failed: ${message}` }));
			setOperationError(`Could not move this chat: ${message}`);
		}
	}
	useEffect(() => {
		const query = sessionBrowser.query;
		sessionRequestGenerationRef.current++;
		if (!serverReady || !client) return;
		host.timers.clearTimeout(searchDebounceRef.current);
		sessionRequestGenerationRef.current++;
		searchDebounceRef.current = host.timers.setTimeout(() => void refreshSessionBrowser(client, query), 200);
		return () => {
			host.timers.clearTimeout(searchDebounceRef.current);
			sessionRequestGenerationRef.current++;
		};
	}, [client, host.timers, serverReady, sessionBrowser.query]);

	async function refreshSessions(sessionClient = client, forceThreadId?: string) {
		if (!sessionClient || (sessionClient === client && !serverReady)) return;
		try {
			const result = await sessionClient.threadLoadedList({});
			for (const threadId of result.data) {
				if (threadId !== forceThreadId && transcript.threads.some(thread => thread.id === threadId)) continue;
				try {
					const readResult = await sessionClient.threadRead({ threadId });
					setTranscript(current =>
						current.threads.some(thread => thread.id === threadId)
							? current
							: upsertThread(current, readResult.thread),
					);
				} catch (error) {
					setOperationError(`Could not load a saved chat: ${errorMessage(error)}`);
				}
			}
		} catch (error) {
			setOperationError(`Could not refresh saved chats: ${errorMessage(error)}`);
		}
	}

	async function forkThread(threadId: string) {
		if (!serverReady || !client) return;
		try {
			const result = await client.threadFork({ threadId });
			setTranscript(current => upsertThread(current, result.thread));
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not fork this chat: ${errorMessage(error)}`);
		}
	}

	async function archiveThread(threadId: string) {
		if (!serverReady || !client) return;
		try {
			await client.threadArchive({ threadId });
			setTranscript(current => ({ ...current, threads: markThreadArchived(current.threads, threadId) }));
			await refreshSessions();
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not archive this chat: ${errorMessage(error)}`);
		}
	}

	async function deleteThread(threadId: string) {
		if (!serverReady || !client) return;
		try {
			await client.threadDelete({ threadId });
			setTranscript(current => ({
				...current,
				activeThreadId: current.activeThreadId === threadId ? undefined : current.activeThreadId,
				threads: removeThread(current.threads, threadId),
				items: current.items.filter(item => item.threadId !== threadId),
				approvals: current.approvals.filter(approval => approval.threadId !== threadId),
			}));
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not delete this chat: ${errorMessage(error)}`);
		}
	}

	async function submitComposer() {
		if (!serverReady || !client || composer.trim().length === 0 || isSubmitting) return;
		const prompt = composer.trim();
		setSubmitting(true);
		try {
			const threadId = await ensureActiveThread();
			if (!threadId) {
				setOperationError("Could not start a chat for this message.");
				return;
			}
			setComposer("");
			setTranscript(current => appendLocalUserMessage(current, threadId, prompt));
			await client.turnStart({ threadId, text: prompt });
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not send this message: ${errorMessage(error)}`);
		} finally {
			setSubmitting(false);
		}
		restoreComposerFocus();
	}

	async function submitPrompt(event: FormEvent) {
		event.preventDefault();
		await submitComposer();
	}

	function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
		if (event.key !== "Enter") return;
		// Never submit mid-IME-composition.
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		// Ctrl/Cmd/Shift+Enter inserts a newline (default textarea behavior).
		if (event.ctrlKey || event.metaKey || event.shiftKey) return;
		// Plain Enter submits.
		event.preventDefault();
		void submitComposer();
	}

	async function stopTurn() {
		if (!serverReady || !client || !activeThreadId || !transcript.activeTurnId) return;
		try {
			await client.turnInterrupt({ threadId: activeThreadId, turnId: transcript.activeTurnId });
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not stop this response: ${errorMessage(error)}`);
		}
	}

	async function applyModel(provider: string, modelId: string) {
		if (!serverReady || !client || !activeThreadId) return;
		try {
			await client.gjcModelSet({ threadId: activeThreadId, provider, modelId });
			setTranscript(current => ({
				...current,
				modelLabel: `${provider}/${modelId}`,
				threads: current.threads.map(thread =>
					thread.id === activeThreadId ? { ...thread, modelLabel: `${provider}/${modelId}` } : thread,
				),
			}));
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not change the model: ${errorMessage(error)}`);
		}
	}

	async function resolveApproval(approval: ApprovalGate, approved: boolean) {
		if (!serverReady || !client || approval.kind !== "host-tool") return;
		setTranscript(current => markApproval(current, approval.id, approved ? "approved" : "rejected"));
		try {
			await client.gjcHostToolsResult({
				threadId: approval.threadId,
				callId: approval.id,
				ok: approved,
				result: approved ? { approved: true } : undefined,
				error: approved ? undefined : { rejected: true, reason: "Rejected in GJC GUI" },
			});
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not send this approval: ${errorMessage(error)}`);
		}
		restoreComposerFocus();
	}

	async function resolveHostUri(
		approval: ApprovalGate,
		ok: boolean,
		payload?: { content?: string; contentType?: string },
	) {
		if (!serverReady || !client || approval.kind !== "host-uri") return;
		try {
			await client.gjcHostUrisResult({
				threadId: approval.threadId,
				requestId: approval.id,
				content: ok ? (payload?.content ?? approval.content ?? "") : undefined,
				contentType: ok ? (payload?.contentType ?? "text/plain") : undefined,
				error: ok ? undefined : "Rejected in GJC GUI",
				isError: ok ? undefined : true,
			});
			setTranscript(current => markApproval(current, approval.id, ok ? "approved" : "rejected"));
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not send this approval: ${errorMessage(error)}`);
		}
		restoreComposerFocus();
	}

	async function respondWorkflowGate(approval: ApprovalGate, selectedValue: JsonValue) {
		if (!serverReady || !client || approval.kind !== "workflow-gate") return;
		const answer = workflowGateAnswer(approval, selectedValue);
		if (!answer) {
			setTranscript(current =>
				markWorkflowGateFailed(
					current,
					approval.id,
					"Unsupported workflow gate schema; answer manually outside the GUI.",
				),
			);
			return;
		}
		try {
			const resolution = await client.gjcWorkflowGateRespond({
				threadId: approval.threadId,
				gate_id: approval.id,
				answer,
			});
			if (resolution.status === "accepted") {
				setTranscript(current => markApproval(current, approval.id, "approved"));
				setOperationError(undefined);
			} else {
				setTranscript(current =>
					markWorkflowGateFailed(current, approval.id, workflowGateResolutionError(resolution)),
				);
			}
		} catch (error) {
			const message = errorMessage(error);
			setTranscript(current => markWorkflowGateFailed(current, approval.id, message));
			setOperationError(`Could not send this approval: ${message}`);
		}
		restoreComposerFocus();
	}

	async function compactThread() {
		if (!serverReady || !client || !activeThreadId) return;
		try {
			await client.gjcCompact({ threadId: activeThreadId });
			setOperationError(undefined);
		} catch (error) {
			setOperationError(`Could not compact this chat: ${errorMessage(error)}`);
		}
		restoreComposerFocus();
	}

	async function copyTranscriptText(text: string | undefined) {
		if (!text) return;
		try {
			await host.clipboard.writeText(text);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("failed");
		} finally {
			host.timers.clearTimeout(copyStatusTimeoutRef.current);
			copyStatusTimeoutRef.current = host.timers.setTimeout(() => setCopyStatus("idle"), 1400) as unknown as number;
			restoreComposerFocus();
		}
	}

	return (
		<main className="app-shell">
			<aside className="app-sidebar" aria-label="Chats">
				<div className="brand-lockup">
					<img className="brand-mark" src="/icon.png" alt="" aria-hidden="true" />
					<div>
						<strong>Gajae Code</strong>
						<span>Desktop chat</span>
					</div>
				</div>
				<SessionSetupPanel
					serverReady={serverReady}
					workingDirectory={workingDirectory}
					recentDirectories={recentDirectories}
					isPickingDirectory={isPickingDirectory}
					error={setupError}
					onWorkingDirectoryChange={setWorkingDirectory}
					onPickDirectory={() => void pickDirectory()}
					onStart={() => void startThread()}
				/>
				<nav className="workspace-switcher" aria-label="Workspace sections">
					<button
						className={
							workspaceView === "chat"
								? "workspace-switcher__button workspace-switcher__button--selected"
								: "workspace-switcher__button"
						}
						type="button"
						onClick={() => setWorkspaceView("chat")}
					>
						Chat
					</button>
					<button
						className={
							workspaceView === "extensibility"
								? "workspace-switcher__button workspace-switcher__button--selected"
								: "workspace-switcher__button"
						}
						type="button"
						onClick={() => setWorkspaceView("extensibility")}
						disabled={!serverReady || !activeThreadId}
					>
						Skills & extensions
					</button>
				</nav>
				<section className="session-browser" aria-label="Persisted sessions">
					<input
						className="session-browser__search"
						value={sessionBrowser.query}
						onChange={event => setSessionBrowser(current => ({ ...current, query: event.target.value }))}
						placeholder="Search sessions"
						aria-label="Search sessions"
						disabled={!serverReady}
					/>
					{sessionBrowser.loading ? <div className="empty-inline">Loading sessions…</div> : null}
					{sessionBrowser.error ? <div className="empty-inline">{sessionBrowser.error}</div> : null}
					{sessionBrowser.sessions.map(session => (
						<article className="session-browser__row" key={session.path}>
							<strong className="session-browser__title">{persistedSessionLabel(session)}</strong>
							<span className="session-browser__meta">
								{redactDirectoryPath(session.cwd)} · {session.modifiedAt}
							</span>
							<div className="session-browser__actions">
								<button
									type="button"
									className="neutral-action"
									onClick={() => void openSession(session.path)}
									disabled={!serverReady}
								>
									Open
								</button>
								<button
									type="button"
									className="neutral-action"
									onClick={() => void renameSession(session.path)}
									disabled={!serverReady}
								>
									Rename
								</button>
								<button
									type="button"
									className="neutral-action"
									onClick={() => void exportSession(session.path)}
									disabled={!serverReady}
								>
									Export
								</button>
								<button
									type="button"
									className="neutral-action session-actions__button--danger"
									onClick={() => void deleteSession(session.path)}
									disabled={!serverReady}
								>
									Delete
								</button>
							</div>
						</article>
					))}
					{sessionBrowser.exportStatus ? <div className="empty-inline">{sessionBrowser.exportStatus}</div> : null}
					<button
						type="button"
						className="neutral-action"
						disabled={!serverReady || !activeThreadId}
						onClick={() => void refreshSessionTree()}
					>
						Refresh session tree
					</button>
					{sessionBrowser.tree ? (
						<div className="session-browser__tree" role="tree">
							{flattenSessionTree(sessionBrowser.tree.nodes).map(node => (
								<div
									className="session-browser__tree-row"
									role="treeitem"
									aria-selected={node.active}
									key={node.id}
								>
									<span className="session-browser__tree-node">{node.text}</span>
								</div>
							))}
						</div>
					) : null}
				</section>
				<nav className="thread-list" aria-label="Chat list">
					{transcript.threads.length === 0 ? (
						<div className="empty-inline">No chats yet. Connect, then start a chat.</div>
					) : (
						transcript.threads.map(thread => (
							<div
								className={`thread-row ${thread.id === activeThreadId ? "thread-row--selected" : ""} ${thread.status === "error" ? "thread-row--error" : ""}`}
								key={thread.id}
							>
								<button
									className="thread-row__resume"
									type="button"
									onClick={() => void resumeThread(thread.id)}
									title={thread.cwd ? redactDirectoryPath(thread.cwd) : undefined}
									disabled={!serverReady}
								>
									<span className="thread-title">{threadPrimaryLabel(thread)}</span>
									<span className="thread-meta">
										{threadSuffix(thread.id)} · {thread.status}
									</span>
								</button>
								<SessionActions
									key={`${thread.id}-${serverReady}`}
									thread={thread}
									disabled={!serverReady}
									onFork={id => void forkThread(id)}
									onMove={id => void moveThread(id)}
									onArchive={id => void archiveThread(id)}
									onDelete={id => void deleteThread(id)}
								/>
							</div>
						))
					)}
				</nav>
				<details className="sidebar-drawer">
					<summary>Model &amp; settings</summary>
					<ModelPanel
						currentModel={transcript.modelLabel}
						disabled={!serverReady || !activeThreadId}
						onApply={applyModel}
					/>
				</details>
				<details className="sidebar-drawer">
					<summary>Providers</summary>
					<button
						type="button"
						className="neutral-action"
						onClick={() => void loadProviders()}
						disabled={!serverReady || providerData.loading}
					>
						Refresh providers
					</button>
					<button
						type="button"
						className="neutral-action"
						onClick={() => setProviderAddOpen(current => !current)}
						disabled={!serverReady}
					>
						{providerAddOpen ? "Cancel provider" : "Add provider"}
					</button>
					{providerAddOpen ? <ProviderAddForm disabled={!serverReady} onSubmit={addProvider} /> : null}
					{providerData.error ? (
						<p className="model-panel__hint model-panel__hint--error">{providerData.error}</p>
					) : null}
					{providerData.providers.map(provider => (
						<div key={provider.id} className="session-browser__actions">
							<span>
								{provider.name} · {provider.authenticated ? "authenticated" : "unauthenticated"}
							</span>
							{provider.authKind === "oauth" && !provider.authenticated ? (
								<button type="button" onClick={() => setLoginProviderId(provider.id)} disabled={!serverReady}>
									Log in
								</button>
							) : null}
							{provider.authenticated ? (
								<button type="button" onClick={() => void logoutProvider(provider.id)} disabled={!serverReady}>
									Log out
								</button>
							) : null}
						</div>
					))}
				</details>
				<details className="sidebar-drawer">
					<summary>Execution-state (deferred)</summary>
					<DeferredExecStateList />
				</details>
				<ConnectionBadge connection={connection} modelLabel={transcript.modelLabel} />
			</aside>

			{workspaceView === "extensibility" ? (
				<section className="chat-workspace" aria-label="Skills and extensions catalog">
					{connected ? (
						<ExtensibilityPanel
							skills={extData.skills}
							extensions={extData.extensions}
							plugins={extData.plugins}
							extensionInspection={extData.extensionInspection}
							pluginInspection={extData.pluginInspection}
							appearanceThemes={extData.themes}
							appearance={extData.appearance?.candidate}
							loading={extData.loading}
							error={extData.error}
							onRefresh={() => void loadExtensibilityData()}
							onInspectExtension={id => void inspectExtension(id)}
							onInspectPlugin={id => void inspectPlugin(id)}
							onPreviewAppearance={previewAppearanceSettings}
							onRestoreAppearance={restoreAppearanceSettings}
							onApplyAppearance={next => void applyAppearanceSettings(next)}
							onSkillEnabled={(id, enabled) => void setSkillEnabled(id, enabled)}
							onExtensionEnabled={(id, enabled) => void setExtensionEnabled(id, enabled)}
							onPluginEnabled={(id, enabled) => void setPluginEnabled(id, enabled)}
							onPluginSetting={(id, key, value) => void setPluginSetting(id, key, value)}
						/>
					) : (
						<div className="empty-state">Reconnect to browse skills and extensions.</div>
					)}
				</section>
			) : (
				<section className="chat-workspace" aria-label="Chat transcript">
					<header className="chat-header">
						<div>
							<p className="eyebrow">Chat</p>
							<h1>{activeThread ? threadPrimaryLabel(activeThread) : "New chat"}</h1>
						</div>
						<button
							className="neutral-action"
							type="button"
							ref={helpTriggerRef}
							onClick={() => setHelpOpen(true)}
						>
							Help
						</button>
						<div className="header-actions">
							<button
								className="neutral-action"
								type="button"
								disabled={!serverReady || !activeThreadId}
								onClick={() => void compactThread()}
							>
								Compact
							</button>
							<button
								className="neutral-action"
								type="button"
								aria-describedby="copy-export-hint"
								disabled={!canCopyAssistant}
								onClick={() => void copyTranscriptText(lastAssistantCopy)}
							>
								Copy
							</button>
							<button
								className="neutral-action"
								type="button"
								aria-describedby="copy-export-hint"
								disabled={!canDumpTranscript}
								onClick={() => void copyTranscriptText(transcriptDump)}
							>
								Dump
							</button>
							<span className="copy-status" role="status" aria-live="polite">
								{copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Could not copy" : ""}
							</span>
							<span className="completion-status" role="status" aria-live="polite">
								{operationError ?? completionStatus}
							</span>
							<span className="model-chip" title="Active model (change under Model & settings in the sidebar)">
								{transcript.modelLabel || "no model"}
							</span>
							<p id="copy-export-hint" className="copy-export-hint">
								Copy and Dump export visible conversation content; the app adds no credentials.
							</p>
						</div>
					</header>
					{connection.kind === "booting" ||
					connection.kind === "connecting" ||
					connection.kind === "reconnecting" ? (
						<ConnectionBusyPanel reconnecting={connection.kind === "reconnecting"} />
					) : connection.kind !== "connected" ? (
						<ConnectionErrorPanel connection={connection} onReconnect={() => void connect()} />
					) : null}
					{operationError ? <p className="operation-status">{operationError}</p> : null}
					<section className="transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>
						{visibleItems.length === 0 && visibleApprovals.length === 0 ? (
							<EmptyTranscript connected={connected} />
						) : null}
						{renderEntries.map(entry =>
							entry.kind === "turn" ? (
								<TurnCard items={entry.items} key={entry.key} />
							) : (
								<TranscriptCard item={entry.item} key={entry.item.id} />
							),
						)}
						{visibleApprovals.map(approval => (
							<ApprovalCard
								approval={approval}
								key={approval.id}
								disabled={!serverReady}
								onResolve={resolveApproval}
								onResolveHostUri={resolveHostUri}
								onRespondWorkflowGate={respondWorkflowGate}
							/>
						))}
						<div className="transcript__bottom" ref={transcriptBottomRef} aria-hidden="true" />
					</section>
					{showJumpToLatest ? (
						<button className="jump-to-latest neutral-action" type="button" onClick={jumpToLatest}>
							Jump to latest
						</button>
					) : null}
					<form className="composer" onSubmit={submitPrompt} aria-busy={isSubmitting}>
						<label htmlFor="gjc-composer">Message gajae</label>
						<textarea
							id="gjc-composer"
							ref={composerRef}
							value={composer}
							onChange={event => setComposer(event.target.value)}
							onKeyDown={handleComposerKeyDown}
							disabled={!serverReady || isSubmitting}
							placeholder={
								serverReady
									? "Ask gajae to edit, inspect, or explain…  (Enter to send · Ctrl+Enter for newline)"
									: "Reconnect to start chatting."
							}
						/>
						<footer>
							<span className="composer-status">{serverReady ? "" : failureCopy(connection.failure)}</span>
							{isSubmitting || transcript.activeTurnId ? (
								<button
									className="neutral-action"
									type="button"
									onClick={() => void stopTurn()}
									disabled={!serverReady || !transcript.activeTurnId}
								>
									Stop
								</button>
							) : (
								<button
									className="primary-action"
									type="submit"
									disabled={!serverReady || composer.trim().length === 0}
								>
									Submit
								</button>
							)}
						</footer>
					</form>
				</section>
			)}
			<CommandPalette
				open={paletteOpen && serverReady && Boolean(activeThreadId)}
				commands={paletteData.commands}
				tools={paletteData.tools}
				loading={paletteData.loading}
				error={paletteData.error}
				onClose={closePalette}
				onInsert={insertPaletteText}
			/>
			{helpOpen ? <HelpGlossary onClose={closeHelp} /> : null}
			{loginProviderId && loginClient && serverReady ? (
				<LoginFlowSheet
					providerId={loginProviderId}
					client={loginClient}
					openExternal={host.openExternal}
					onClose={() => {
						setLoginProviderId(undefined);
						void loadProviders();
					}}
				/>
			) : null}
		</main>
	);
}

function ProviderAddForm({
	disabled,
	onSubmit,
}: {
	disabled: boolean;
	onSubmit(params: GjcProviderAddParams): Promise<void>;
}) {
	const [mode, setMode] = useState<"preset" | "custom">("preset");
	const [preset, setPreset] = useState("");
	const [compatibility, setCompatibility] = useState("");
	const [providerId, setProviderId] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKeyEnv, setApiKeyEnv] = useState("");
	const [models, setModels] = useState("");
	const [force, setForce] = useState(false);
	const [error, setError] = useState("");
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (disabled) return;
		const modelList = models
			.split(",")
			.map(model => model.trim())
			.filter(Boolean);
		const params: GjcProviderAddParams =
			mode === "preset"
				? { preset: preset.trim(), ...(force ? { force } : {}) }
				: {
						compatibility: compatibility.trim(),
						providerId: providerId.trim(),
						baseUrl: baseUrl.trim(),
						apiKeyEnv: apiKeyEnv.trim(),
						models: modelList,
						...(force ? { force } : {}),
					};
		if (
			(mode === "preset" && !params.preset) ||
			(mode === "custom" &&
				(!params.compatibility ||
					!params.providerId ||
					!params.baseUrl ||
					!params.apiKeyEnv ||
					!params.models?.length))
		) {
			setError(
				mode === "preset"
					? "Preset is required."
					: "Compatibility, provider ID, base URL, API key environment variable, and at least one model are required.",
			);
			return;
		}
		setError("");
		await onSubmit(params);
	};
	return (
		<form className="model-panel" onSubmit={submit}>
			<label>
				Mode
				<select
					value={mode}
					onChange={event => setMode(event.currentTarget.value as "preset" | "custom")}
					disabled={disabled}
				>
					<option value="preset">Preset</option>
					<option value="custom">Custom compatible provider</option>
				</select>
			</label>
			{mode === "preset" ? (
				<label>
					Preset
					<input value={preset} onChange={event => setPreset(event.currentTarget.value)} disabled={disabled} />
				</label>
			) : (
				<>
					<label>
						Compatibility
						<input
							value={compatibility}
							onChange={event => setCompatibility(event.currentTarget.value)}
							disabled={disabled}
						/>
					</label>
					<label>
						Provider ID
						<input
							value={providerId}
							onChange={event => setProviderId(event.currentTarget.value)}
							disabled={disabled}
						/>
					</label>
					<label>
						Base URL
						<input
							type="url"
							value={baseUrl}
							onChange={event => setBaseUrl(event.currentTarget.value)}
							disabled={disabled}
						/>
					</label>
					<label>
						API key environment variable
						<input
							value={apiKeyEnv}
							onChange={event => setApiKeyEnv(event.currentTarget.value)}
							placeholder="OPENAI_API_KEY"
							disabled={disabled}
						/>
					</label>
					<label>
						Models (comma-separated)
						<input value={models} onChange={event => setModels(event.currentTarget.value)} disabled={disabled} />
					</label>
				</>
			)}
			<label>
				<input
					type="checkbox"
					checked={force}
					onChange={event => setForce(event.currentTarget.checked)}
					disabled={disabled}
				/>{" "}
				Replace existing provider
			</label>
			{error ? <p className="model-panel__hint model-panel__hint--error">{error}</p> : null}
			<button type="submit" className="primary-action" disabled={disabled}>
				Add provider
			</button>
		</form>
	);
}

function normalizeAppearanceSettings(value: {
	dark: string;
	light: string;
	symbolPreset?: string | null;
	colorBlindMode?: boolean | null;
}): AppearanceSettings {
	return {
		dark: value.dark,
		light: value.light,
		...(value.symbolPreset === null || value.symbolPreset === undefined ? {} : { symbolPreset: value.symbolPreset }),
		...(value.colorBlindMode === null || value.colorBlindMode === undefined
			? {}
			: { colorBlindMode: value.colorBlindMode }),
	};
}

async function resolveEndpoint(): Promise<EndpointDescriptor> {
	const devUrl = import.meta.env.VITE_APP_SERVER_URL;
	const devToken = import.meta.env.VITE_APP_SERVER_TOKEN;
	if (typeof devUrl === "string" && devUrl.length > 0 && typeof devToken === "string" && devToken.length > 0) {
		return { url: devUrl, token: devToken };
	}
	return invoke<EndpointDescriptor>("get_app_server_endpoint");
}

function websocketUrl(endpoint: EndpointDescriptor): string {
	const url = new URL(endpoint.url);
	url.searchParams.set("token", endpoint.token);
	return url.toString();
}

function ConnectionBadge({ connection, modelLabel }: { connection: ConnectionState; modelLabel: string }) {
	const state =
		connection.kind === "connected"
			? "connected"
			: connection.kind === "booting" || connection.kind === "connecting" || connection.kind === "reconnecting"
				? "reconnecting"
				: "disconnected";
	return (
		<span className={`model-badge model-badge--${state}`}>
			<span className="dot" />
			{modelLabel} · {state}
		</span>
	);
}

function ConnectionBusyPanel({ reconnecting = false }: { reconnecting?: boolean }) {
	return (
		<section className="connection-error connection-error--booting" role="status" aria-live="polite">
			<p className="eyebrow">{reconnecting ? "Reconnecting desktop chat" : "Opening desktop chat"}</p>
			<h2>
				{reconnecting
					? "Gajae Code is reconnecting to the local chat connection."
					: "Gajae Code is opening the local chat connection."}
			</h2>
			<p>This normally takes only a moment.</p>
		</section>
	);
}

function HelpGlossary({ onClose }: { onClose(): void }) {
	const closeButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		closeButtonRef.current?.focus();
	}, []);

	function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = Array.from(
			event.currentTarget.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			),
		).filter(element => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true");
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
			event.preventDefault();
			first.focus();
		}
	}

	return (
		<section
			className="sheet-backdrop"
			role="dialog"
			aria-modal="true"
			aria-labelledby="desktop-chat-help-title"
			onKeyDown={trapFocus}
		>
			<div className="login-flow-sheet">
				<header>
					<strong id="desktop-chat-help-title">Desktop chat help</strong>
					<button type="button" ref={closeButtonRef} onClick={onClose}>
						Close
					</button>
				</header>
				<dl>
					<dt>Chat / session</dt>
					<dd>A conversation and its saved history.</dd>
					<dt>Scratch chat</dt>
					<dd>A chat that starts without choosing a project folder.</dd>
					<dt>Project folder / working directory</dt>
					<dd>The folder gajae uses for project-scoped work.</dd>
					<dt>Compact</dt>
					<dd>Shortens older context while keeping the current conversation usable.</dd>
					<dt>Copy / Dump</dt>
					<dd>Copies the latest answer or the visible conversation.</dd>
					<dt>Approvals</dt>
					<dd>Requests that need your decision before work continues.</dd>
					<dt>Coming later</dt>
					<dd>Disabled controls are visible previews and do not change settings.</dd>
				</dl>
			</div>
		</section>
	);
}

function ConnectionErrorPanel({ connection, onReconnect }: { connection: ConnectionState; onReconnect(): void }) {
	const detail = connection.detail
		? redactDetail(connection.detail)
		: "The desktop shell has not provided a usable local chat connection.";
	return (
		<section className={`connection-error connection-error--${connection.failure ?? "unknown"}`} role="alert">
			<p className="eyebrow">{failureTitle(connection.failure)}</p>
			<h2>{failureCopy(connection.failure)}</h2>
			<p>{detail}</p>
			<div className="button-row">
				<button className="primary-action" type="button" onClick={onReconnect}>
					Reconnect
				</button>
				<code>{connection.endpointUrl ? safeEndpoint(connection.endpointUrl) : "endpoint unavailable"}</code>
			</div>
		</section>
	);
}

function EmptyTranscript({ connected }: { connected: boolean }) {
	return (
		<section className="empty-state">
			<p className="eyebrow">gajae</p>
			<h2>{connected ? "Start with a scratch chat." : "Message gajae to start chatting."}</h2>
			<p>
				{connected
					? "Just type below and press Enter — a chat starts automatically in a scratch directory. Pick a working directory on the left first if you want a project-scoped chat."
					: "Reconnect to start chatting."}
			</p>
		</section>
	);
}

function SessionSetupPanel({
	serverReady,
	workingDirectory,
	recentDirectories,
	isPickingDirectory,
	error,
	onWorkingDirectoryChange,
	onPickDirectory,
	onStart,
}: {
	serverReady: boolean;
	workingDirectory: string;
	recentDirectories: string[];
	isPickingDirectory: boolean;
	error?: string;
	onWorkingDirectoryChange(value: string): void;
	onPickDirectory(): void;
	onStart(): void;
}) {
	const normalized = normalizeDirectoryInput(workingDirectory);
	const hasInput = workingDirectory.trim().length > 0;
	const startDirectory = startChatDirectory(workingDirectory);
	return (
		<section className="session-setup" aria-label="Session setup">
			<label htmlFor="gjc-session-cwd">Working directory</label>
			<div className="cwd-picker-row">
				<input
					id="gjc-session-cwd"
					type="text"
					value={workingDirectory}
					onChange={event => onWorkingDirectoryChange(event.target.value)}
					placeholder="/path/to/project"
					spellCheck={false}
				/>
				<button
					className="neutral-action"
					type="button"
					onClick={onPickDirectory}
					disabled={!serverReady || isPickingDirectory}
				>
					{isPickingDirectory ? "Picking" : "Browse"}
				</button>
			</div>
			<p className={`cwd-hint ${hasInput && !normalized ? "cwd-hint--error" : ""}`}>
				{hasInput && !normalized
					? "Enter an absolute path or choose a folder."
					: "Optional — leave blank to chat in a scratch directory, or pick a folder for a project-scoped chat."}
			</p>
			{error ? <p className="model-panel__hint model-panel__hint--error">{error}</p> : null}
			{recentDirectories.length > 0 ? (
				<div className="recent-directories" aria-label="Recent directories">
					{recentDirectories.map(directory => (
						<button
							className="recent-directory"
							type="button"
							key={directory}
							onClick={() => onWorkingDirectoryChange(directory)}
							title={redactDirectoryPath(directory)}
						>
							{recentDirectoryDisplay(directory)}
						</button>
					))}
				</div>
			) : null}
			<button className="primary-action" type="button" onClick={onStart} disabled={!serverReady || !startDirectory}>
				Start chat
			</button>
		</section>
	);
}

// gjc's tool calls are emitted inline in the assistant text stream as JSON
// objects carrying the internal "_i" marker; clean them before rendering.

// Only surface a status pill when it carries signal — a sea of "completed"
// labels is just noise.
function statusPill(status: TranscriptItem["status"]): string | undefined {
	if (status === "error") return "error";
	if (status === "interrupted") return "interrupted";
	return undefined;
}

function toolHint(status: TranscriptItem["status"]): string | undefined {
	if (status === "running") return "Running…";
	if (status === "completed" || status === "success") return "Done";
	if (status === "error") return "Failed";
	if (status === "interrupted") return "Stopped";
	return undefined;
}

function ReasoningDetails({ item, nested }: { item: TranscriptItem; nested?: boolean }) {
	const running = item.status === "running";
	const reasoning = cleanAssistantText(item.content ?? "");
	return (
		<details
			className={`message--reasoning message--${item.status}${nested ? " message__reasoning" : " message"}`}
			open={running}
		>
			<summary>
				<span className="message__role">{itemLabel(item)}</span>
				<span className="message__hint">{running ? "thinking…" : "reasoning"}</span>
			</summary>
			<div className="markdown markdown--reasoning">
				{reasoning ? <Markdown text={reasoning} /> : running ? "Thinking…" : "No reasoning captured."}
			</div>
		</details>
	);
}

function TranscriptCard({ item }: { item: TranscriptItem }) {
	const running = item.status === "running";
	const isBlock = item.role === "tool" || item.role === "event";

	if (item.role === "reasoning") return <ReasoningDetails item={item} />;

	if (isBlock) return <ToolCard item={item} />;

	const pill = statusPill(item.status);
	const text = cleanAssistantText(item.content ?? "");
	const placeholder = item.role === "assistant" ? "Writing…" : "Working…";
	return (
		<article className={`message message--${item.role} message--${item.status}`} aria-busy={running}>
			<header>
				<span className="message__role">{itemLabel(item)}</span>
				{pill ? <span className="message__pill">{pill}</span> : null}
			</header>
			{text ? (
				<div className="markdown">
					<Markdown text={text} />
				</div>
			) : running ? (
				<p className="message-status">{placeholder}</p>
			) : null}
		</article>
	);
}

// One consolidated card per assistant turn: thinking and tool calls render as
// collapsed dropdowns nested in chronological order, and only the assistant
// reply text stays always-visible.
function TurnCard({ items }: { items: TranscriptItem[] }) {
	const running = items.some(entry => entry.status === "running");
	const hasVisibleText = items.some(
		entry => entry.role === "assistant" && cleanAssistantText(entry.content ?? "").length > 0,
	);
	const pill = items.some(entry => entry.status === "error")
		? "error"
		: items.some(entry => entry.status === "interrupted")
			? "interrupted"
			: undefined;
	return (
		<article
			className={`message message--assistant message--${running ? "running" : "completed"}`}
			aria-busy={running}
		>
			<header>
				<span className="message__role">gajae</span>
				{pill ? <span className="message__pill">{pill}</span> : null}
			</header>
			{items.map(entry => {
				if (entry.role === "reasoning") return <ReasoningDetails item={entry} nested key={entry.id} />;
				if (entry.role === "tool") return <ToolCard item={entry} nested key={entry.id} />;
				const text = cleanAssistantText(entry.content ?? "");
				return text ? (
					<div className="markdown" key={entry.id}>
						<Markdown text={text} />
					</div>
				) : null;
			})}
			{running && !hasVisibleText ? <p className="message-status">Writing…</p> : null}
		</article>
	);
}

function ToolCard({ item, nested }: { item: TranscriptItem; nested?: boolean }) {
	const running = item.status === "running";
	const hint = toolHint(item.status);
	const tool = item.tool ?? { name: item.title || itemLabel(item), output: (item.content ?? "").trim() };
	const safeArgs = tool.args ? safeToolText(tool.args) : undefined;
	const safeOutput = tool.output ? safeToolText(tool.output) : undefined;
	const safeError = tool.error ? safeToolText(tool.error) : undefined;
	const diff = isEditTool(tool.name, item.title)
		? parseDiff(safeOutput ?? safeToolText(item.content ?? ""))
		: undefined;
	return (
		<details
			className={`message message--${item.role} message--${item.status} tool-card${nested ? " tool-card--nested" : ""}`}
			open={running}
		>
			<summary>
				<span className="tool-card__icon" aria-hidden="true" />
				<span className="tool-card__title">{safeToolText(tool.name, 160)}</span>
				{hint ? <span className="message__hint tool-card__status">{hint}</span> : null}
			</summary>
			<div className="tool-card__sections">
				{safeArgs ? <ToolSection label="args" text={safeArgs} collapsed /> : null}
				{diff && diff.lines.length > 0 ? (
					<DiffBlock diff={diff} />
				) : safeOutput ? (
					<ToolSection label="output" text={safeOutput} />
				) : null}
				{safeError ? <ToolSection label="error" text={safeError} tone="danger" /> : null}
				{!safeArgs && !safeOutput && !safeError ? (
					<p className="message-status">{running ? "Running…" : "No output"}</p>
				) : null}
			</div>
		</details>
	);
}

function ToolSection({
	collapsed,
	label,
	text,
	tone,
}: {
	collapsed?: boolean;
	label: string;
	text: string;
	tone?: "danger";
}) {
	const pretty = prettyToolText(text);
	const summary = pretty.split("\n")[0] || label;
	if (collapsed) {
		return (
			<details className={`tool-section ${tone === "danger" ? "tool-section--danger" : ""}`}>
				<summary>
					<span>{label}</span>
					<code>{summary}</code>
				</summary>
				<pre>{pretty}</pre>
			</details>
		);
	}
	return (
		<section className={`tool-section ${tone === "danger" ? "tool-section--danger" : ""}`}>
			<header>{label}</header>
			<pre>{pretty}</pre>
		</section>
	);
}

type DiffLine = { kind: "add" | "remove" | "context"; text: string };
type ParsedDiff = { adds: number; removes: number; lines: DiffLine[]; truncated: boolean };

function DiffBlock({ diff }: { diff: ParsedDiff }) {
	const body = (
		<div className="diff-block__body">
			{diff.lines.map((line, index) => (
				<div className={`diff-line diff-line--${line.kind}`} key={`${index}-${line.text}`}>
					<span>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>
					<code>{line.text}</code>
				</div>
			))}
		</div>
	);
	return (
		<section className="diff-block">
			<header>
				diff{" "}
				<span>
					+{diff.adds} / -{diff.removes}
				</span>
			</header>
			{diff.truncated ? (
				<details>
					<summary>Show {diff.lines.length} diff lines</summary>
					{body}
				</details>
			) : (
				body
			)}
		</section>
	);
}

function isEditTool(name?: string, title?: string): boolean {
	return /(?:^|[-_\s])(edit|write|apply_patch|filechange|file-change)(?:$|[-_\s])/i.test(
		`${name ?? ""} ${title ?? ""}`,
	);
}

function parseDiff(text: string): ParsedDiff | undefined {
	const raw = text.split("\n").filter(line => /^(?:\+\+\+|---|@@|\+|-|\s|[+-]\d+\|)/.test(line));
	if (raw.length === 0) return undefined;
	let adds = 0;
	let removes = 0;
	const lines = raw.map(line => {
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@"))
			return { kind: "context" as const, text: line };
		if (/^\+\d+\|/.test(line)) {
			adds += 1;
			return { kind: "add" as const, text: line.replace(/^\+\d+\|/, "") };
		}
		if (/^-\d+\|/.test(line)) {
			removes += 1;
			return { kind: "remove" as const, text: line.replace(/^-\d+\|/, "") };
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			adds += 1;
			return { kind: "add" as const, text: line.slice(1) };
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			removes += 1;
			return { kind: "remove" as const, text: line.slice(1) };
		}
		return { kind: "context" as const, text: line.startsWith(" ") ? line.slice(1) : line };
	});
	return { adds, removes, lines: lines.slice(0, 180), truncated: lines.length > 180 };
}

function prettyToolText(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function ApprovalCard({
	approval,
	disabled,
	onResolve,
	onResolveHostUri,
	onRespondWorkflowGate,
}: {
	approval: ApprovalGate;
	disabled: boolean;
	onResolve(approval: ApprovalGate, approved: boolean): Promise<void>;
	onResolveHostUri(
		approval: ApprovalGate,
		ok: boolean,
		payload?: { content?: string; contentType?: string },
	): Promise<void>;
	onRespondWorkflowGate(approval: ApprovalGate, answer: JsonValue): Promise<void>;
}) {
	if (approval.kind === "host-uri") {
		return (
			<article className={`hosturi-card hosturi-card--${approval.status}`}>
				<p className="eyebrow">Host URI · {approvalStatusLabel(approval.status)}</p>
				<h2>
					{approval.operation.toUpperCase()} {redactHostUri(approval.url)}
				</h2>
				<p>gajae requested host access to this URI.</p>
				{approval.contentPreview || approval.content ? (
					<pre>{safeToolText(approval.contentPreview ?? approval.content ?? "")}</pre>
				) : null}
				<div className="button-row">
					<button
						className="primary-action"
						type="button"
						disabled={disabled || approval.status !== "pending"}
						onClick={() => void onResolveHostUri(approval, true)}
					>
						Approve
					</button>
					<button
						className="neutral-action"
						type="button"
						disabled={disabled || approval.status !== "pending"}
						onClick={() => void onResolveHostUri(approval, false)}
					>
						Reject
					</button>
				</div>
			</article>
		);
	}

	if (approval.kind === "workflow-gate") {
		const options = approval.options?.length ? approval.options : undefined;
		const question = approval.context.title ?? approval.context.prompt ?? approval.context.summary;
		const supported = isSupportedWorkflowGate(approval);
		const gateStatus = supported ? approvalStatusLabel(approval.status) : "Respond in terminal app";
		return (
			<article className={`workflow-gate-card workflow-gate-card--${supported ? approval.status : "unsupported"}`}>
				<p className="eyebrow">Workflow gate · {gateStatus}</p>
				<h2>
					{approval.gateKind} · {approval.stage}
				</h2>
				<p>{approval.required ? "Required" : "Optional"} gate awaiting an answer.</p>
				{question ? <p>{safeToolText(question, 1200)}</p> : null}
				{approval.error ? <p className="message-status">{safeToolText(approval.error, 1200)}</p> : null}
				{supported && options ? (
					<div className="button-row">
						{options.map(option => (
							<button
								className="neutral-action"
								type="button"
								key={option.label}
								disabled={disabled || approval.status !== "pending"}
								onClick={() => void onRespondWorkflowGate(approval, option.value)}
							>
								{safeToolText(option.label, 160)}
							</button>
						))}
					</div>
				) : (
					<p className="message-status">
						This answer shape is not supported here; respond in the terminal app to continue.
					</p>
				)}
				<pre>{safeWorkflowGateContext(approval.schema)}</pre>
			</article>
		);
	}

	return (
		<article className={`approval-gate approval-gate--${approval.status}`}>
			<p className="eyebrow">Host tool approval · {approvalStatusLabel(approval.status)}</p>
			<h2>{safeToolText(approval.tool, 160)}</h2>
			<p>gajae requested permission to continue this blocked tool action.</p>
			<pre>{safeWorkflowGateContext(approval.args)}</pre>
			<div className="button-row">
				<button
					className="primary-action"
					type="button"
					disabled={disabled || approval.status !== "pending"}
					onClick={() => void onResolve(approval, true)}
				>
					Approve
				</button>
				<button
					className="neutral-action"
					type="button"
					disabled={disabled || approval.status !== "pending"}
					onClick={() => void onResolve(approval, false)}
				>
					Reject
				</button>
			</div>
		</article>
	);
}

function DeferredExecStateList() {
	return (
		<section className="exec-state-deferred" aria-label="Deferred execution-state surfaces">
			<strong>Execution state coming soon</strong>
			<ul>
				{DEFERRED_EXEC_STATE_ROWS.map(([name, rationale]) => (
					<li key={name}>
						<button type="button" disabled>
							<span>{name}</span>
							<em>{rationale}</em>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

function approvalStatusLabel(status: ApprovalGate["status"]): string {
	switch (status) {
		case "pending":
			return "Waiting";
		case "approved":
			return "Approved";
		case "rejected":
			return "Rejected";
		case "cancelled":
			return "Cancelled";
		case "failed":
			return "Failed";
	}
}

function isSupportedWorkflowGate(approval: ApprovalGate): boolean {
	if (approval.kind !== "workflow-gate" || !approval.options?.length) return false;
	if (approval.gateKind === "approval" || approval.gateKind === "execution")
		return schemaHasAnswerProperty(approval.schema, "decision");
	if (approval.gateKind === "question") return schemaHasAnswerProperty(approval.schema, "selected");
	return false;
}

function workflowGateAnswer(approval: ApprovalGate, selectedValue: JsonValue): JsonValue | undefined {
	if (approval.kind !== "workflow-gate" || !isSupportedWorkflowGate(approval)) return undefined;
	if (approval.gateKind === "question") return { selected: [selectedValue] };
	if (approval.gateKind === "approval" || approval.gateKind === "execution") return { decision: selectedValue };
	return undefined;
}

function workflowGateResolutionError(resolution: RpcWorkflowGateResolution): string {
	const issues = resolution.error?.errors.map(issue => `${issue.path}: ${issue.message}`).join("; ");
	return issues || resolution.error?.code || `Workflow gate response ${resolution.status}`;
}

function markWorkflowGateFailed(state: TranscriptState, gateId: string, error: string): TranscriptState {
	return {
		...state,
		approvals: state.approvals.map(approval =>
			approval.kind === "workflow-gate" && approval.id === gateId
				? { ...approval, status: "failed", error }
				: approval,
		),
	};
}

function schemaHasAnswerProperty(schema: JsonValue, property: "decision" | "selected"): boolean {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const record = schema as Record<string, JsonValue | undefined>;
	const properties = record.properties;
	if (properties && typeof properties === "object" && !Array.isArray(properties) && property in properties)
		return true;
	for (const key of ["oneOf", "anyOf", "allOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(variant => schemaHasAnswerProperty(variant, property))) return true;
	}
	return false;
}

function itemLabel(item: TranscriptItem): string {
	if (item.role === "user") return "You";
	if (item.role === "assistant") return "gajae";
	if (item.role === "reasoning") return "Thinking";
	return item.title ?? (item.role === "tool" ? "Tool" : "Event");
}

function threadPrimaryLabel(thread: { cwd?: string; title?: string; id: string }): string {
	return thread.cwd ? basename(redactDirectoryPath(thread.cwd)) : threadLabel(thread.title, thread.id);
}

function threadSuffix(id: string): string {
	return id.length > 8 ? id.slice(-8) : id;
}

function rememberDirectory(
	directory: string,
	setRecentDirectories: (directories: string[]) => void,
	storage: Pick<Storage, "getItem" | "setItem">,
): void {
	const next = rememberDirectoryValue(readRecentDirectories(storage), directory);
	writeRecentDirectories(storage, next);
	setRecentDirectories(next);
}

export function persistedSessionLabel({
	title,
	firstMessage,
	id,
}: {
	title?: string | null;
	firstMessage?: string | null;
	id: string;
}): string {
	return redactDirectoryPath(title || firstMessage || id);
}

function threadLabel(title: string | undefined, id: string): string {
	const normalized = redactDirectoryPath(title?.trim() ?? "");
	if (normalized && !looksGeneratedThreadTitle(normalized))
		return normalized.length > 64 ? `${normalized.slice(0, 61)}…` : normalized;
	const compactId = id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
	return `Chat ${compactId}`;
}

function looksGeneratedThreadTitle(title: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(title) || title.startsWith("thread-") || title.length > 80;
}
