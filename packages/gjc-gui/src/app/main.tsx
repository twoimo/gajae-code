import {
	AppServerClient,
	AppServerConnectionError,
	AppServerResponseError,
	type GjcCommandsListResult,
	type GjcToolsListResult,
	type GjcExtensionsInspectResult,
	type GjcSessionListResult,
	type GjcSessionTreeResult,
	type GjcGoalReadResult,
	type JsonValue,
	type RpcWorkflowGateResolution,
} from "@gajae-code/app-server-client";
import { invoke } from "@tauri-apps/api/core";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../design-tokens/index.ts";
import {
	cleanAssistantText,
	type ApprovalGate,
	appendLocalUserMessage,
	emptyTranscriptState,
	foldNotification,
	mergeWorkflowGateApprovals,
	markApproval,
	modelLabelFromStateRead,
	type TranscriptItem,
	type TranscriptState,
	upsertThread,
} from "./transcript";
import { Markdown } from "./markdown.tsx";
import { lastAssistantText, serializeTranscript } from "./transcript-export-logic";
import { buildSessionBrowserParams, clampRovingIndex, composerSubmitMode, deriveUnifiedSessionRows, dryRunSessionMove, escapeAction, executeSessionMove, flattenSessionTree, interleaveApprovals, markThreadArchived, nextRightRailCollapsed, nextRovingIndex, provenanceLabel, removeThread, retryLastTurnAction, sessionDeletePayload, sessionLabelPayload, sessionNavigatePayload, sessionOpenPayload, sessionRowStatusPresentation, validateRenameTitle, validateSessionLabel, type SessionMoveConfirmState, type SessionScope } from "./session-actions-logic";
import { ConfirmDialog, PromptDialog, type PromptState, SessionActions } from "./session-actions.tsx";
import { CommandPalette } from "./command-palette.tsx";
import type { PaletteCommand, PaletteCommandAction, PaletteTool } from "./command-palette-logic";
import { ExtensibilityPanel } from "./extensibility-panel.tsx";
import { commitAppearancePreview, createAppearancePreviewState, pluginFeaturePayload, pluginSettingPayload, restoreAppearancePreview, restoreAppearancePreviewOnConnectionLoss, setEnabledPayload, type AppearancePreviewState, type AppearanceSettings, type AppearanceTheme, type Extension, type Plugin, type PluginInspection, type Skill } from "./extensibility-logic";
import { HelpSheet, HotkeysSheet, type LocalCommandSheet } from "./local-command-sheets.tsx";
import { ModelPanel } from "./model-panel.tsx";
import { cardFromRows, errorCard, mergeExecCards, monitorsCardFromResult, notificationRefreshCause, shouldRefreshOnTurnBoundary, type ExecStateCard } from "./exec-state-logic";
import "./styles.css";
import "./session-browser.css";
import { shouldStickToBottom } from "./scroll-follow-logic";

type EndpointDescriptor = { url: string; token: string };
type ConnectionKind = "booting" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
type FailureKind =
	| "origin-rejected"
	| "token-rejected"
	| "stale-discovery"
	| "sidecar-crash"
	| "server-unavailable"
	| "unknown";

type ConnectionState = {
	kind: ConnectionKind;
	failure?: FailureKind;
	detail?: string;
	endpointUrl?: string;
};

type PaletteData = {
	commands: PaletteCommand[];
	tools: PaletteTool[];
	loading: boolean;
	error?: string;
};

type SessionBrowserData = {
	sessions: GjcSessionListResult["sessions"];
	query: string;
	loading: boolean;
	error?: string;
	tree?: GjcSessionTreeResult;
	exportStatus?: string;
};

type SessionBrowserClient = Omit<AppServerClient, "gjcSessionOpen" | "gjcSessionDelete" | "gjcSessionNavigate" | "gjcSessionLabel"> & {
	gjcSessionOpen(params: { sessionPath: string }): Promise<{ threadId: string; sessionMetadata?: { cwd?: string | null }; resumed: boolean }>;
	gjcSessionDelete(params: { sessionPath: string }): Promise<{ ok: boolean }>;
	gjcSessionNavigate(params: { threadId: string; entryId: string; summarize?: boolean }): Promise<{ ok: boolean; activeLeafId?: string }>;
	gjcSessionLabel(params: { threadId: string; entryId: string; label: string }): Promise<{ ok: boolean }>;
};

type FrozenContractClient = AppServerClient & {
	gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun?: boolean }): Promise<unknown>;
	gjcProviderAdd(params: unknown): Promise<{ ok: true; providerId: string; models: string[] }>;
	gjcAuthLoginStart(params: { providerId: string }): Promise<{ flowId: string; state: "idle" | "pending-browser" | "needs-input" | "authenticated" | "failed" | "cancelled" | "unsupported"; authUrl?: string; instructions?: string }>;
	gjcAuthLoginPoll(params: { flowId: string }): Promise<{ state: "idle" | "pending-browser" | "needs-input" | "authenticated" | "failed" | "cancelled" | "unsupported"; promptMessage?: string }>;
	gjcAuthLoginComplete(params: { flowId: string; redirectUrl: string }): Promise<{ state: "idle" | "pending-browser" | "needs-input" | "authenticated" | "failed" | "cancelled" | "unsupported" }>;
	gjcAuthLoginCancel(params: { flowId: string }): Promise<{ state: "idle" | "pending-browser" | "needs-input" | "authenticated" | "failed" | "cancelled" | "unsupported" }>;
	gjcModelAssign(params: { threadId: string; role: string; provider: string; modelId: string; thinkingLevel?: string }): Promise<{ ok: true; role: string; modelId: string }>;
	gjcSkillsSetEnabled(params: Record<string, string | boolean>): Promise<{ ok: true; enabled: boolean }>;
	gjcExtensionsSetEnabled(params: Record<string, string | boolean>): Promise<{ ok: true; enabled: boolean }>;
	gjcPluginsSetEnabled(params: Record<string, string | boolean>): Promise<{ ok: true; enabled: boolean }>;
	gjcPluginsSetFeature(params: { pluginId: string; feature: string; enabled: boolean }): Promise<{ ok: true }>;
	gjcPluginsSetSetting(params: { pluginId: string; key: string; value: JsonValue }): Promise<{ ok: true }>;
};
type ExtensionInspection = NonNullable<GjcExtensionsInspectResult["extension"]>;

type ExtensibilityData = {
	skills: Skill[];
	extensions: Extension[];
	plugins: Plugin[];
	extensionInspection?: ExtensionInspection;
	pluginInspection?: PluginInspection;
	appearanceThemes: AppearanceTheme[];
	appearancePreview?: AppearancePreviewState;
	loading: boolean;
	error?: string;
};

type OpenDrawer = "model" | "theme" | "session" | "settings" | "provider" | "tools" | "skills" | "extensions" | "plugins";
type ExtensibilityTab = "skills" | "extensions" | "plugins" | "appearance";
type WorkspaceView = "chat" | "extensibility";

const RECENT_DIRECTORIES_KEY = "gjc-gui.recentDirectories";
const MAX_RECENT_DIRECTORIES = 8;
// Default working directory for a scratch/default session when the user has not
// picked one, matching the TUI's tmp-rooted default session.
const DEFAULT_CWD = "/tmp";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

function App() {
	const [connection, setConnection] = useState<ConnectionState>({ kind: "booting" });
	const [transcript, setTranscript] = useState<TranscriptState>(() => emptyTranscriptState());
	const [client, setClient] = useState<AppServerClient>();
	const [composer, setComposer] = useState("");
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [localSheet, setLocalSheet] = useState<LocalCommandSheet>();
	const [openDrawer, setOpenDrawer] = useState<OpenDrawer>();
	const [extensibilityTab, setExtensibilityTab] = useState<ExtensibilityTab>("skills");
	const [paletteData, setPaletteData] = useState<PaletteData>({ commands: [], tools: [], loading: false });
	const [extData, setExtData] = useState<ExtensibilityData>({ skills: [], extensions: [], plugins: [], appearanceThemes: [], loading: false });
	const [sessionBrowser, setSessionBrowser] = useState<SessionBrowserData>({ sessions: [], query: "", loading: false });
	const [sessionScope, setSessionScope] = useState<SessionScope>("all");
	const [sessionDeleteConfirm, setSessionDeleteConfirm] = useState<{ kind: "delete"; threadId: string; title: string; sessionPath: string } | null>(null);
	const [sessionMoveConfirm, setSessionMoveConfirm] = useState<SessionMoveConfirmState>(null);
	const [labelPrompt, setLabelPrompt] = useState<PromptState>(null);
	const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
	const [workingDirectory, setWorkingDirectory] = useState("");
	const [recentDirectories, setRecentDirectories] = useState<string[]>(() => readRecentDirectories());
	const [isPickingDirectory, setPickingDirectory] = useState(false);
	const [isSubmitting, setSubmitting] = useState(false);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
	const [execCards, setExecCards] = useState<ExecStateCard[]>([]);
	const [execRefreshNonce, setExecRefreshNonce] = useState(0);
	const [goalStatus, setGoalStatus] = useState<GjcGoalReadResult | undefined>();
	const [rightRailCollapsed, setRightRailCollapsed] = useState(() => window.innerWidth < 1180);
	const [queuedSteer, setQueuedSteer] = useState("");
	const [sessionRovingIndex, setSessionRovingIndex] = useState(0);
	const copyStatusTimeoutRef = useRef<number | undefined>(undefined);
	const stopRef = useRef<(() => void) | undefined>(undefined);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const transcriptRef = useRef<HTMLElement>(null);
	const transcriptBottomRef = useRef<HTMLDivElement>(null);
	const sessionRowRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const stickToBottomRef = useRef(true);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);

	const lastActiveTurnIdRef = useRef<string | undefined>(undefined);
	const restoreComposerFocus = useCallback(() => {
		requestAnimationFrame(() => composerRef.current?.focus());
	}, []);

	const restoreAppearanceAfterConnectionLoss = useCallback(() => {
		setExtData(current => ({ ...current, appearancePreview: restoreAppearancePreviewOnConnectionLoss(current.appearancePreview) }));
	}, []);


	useEffect(() => {
		if (shouldRefreshOnTurnBoundary(lastActiveTurnIdRef.current, transcript.activeTurnId)) {
			lastActiveTurnIdRef.current = transcript.activeTurnId;
			setExecRefreshNonce(nonce => nonce + 1);
		}
	}, [transcript.activeTurnId]);

	const connect = useCallback(async (): Promise<ConnectionState> => {
		setConnection(current => ({ kind: current.kind === "connected" ? "reconnecting" : "connecting" }));
		try {
			const endpoint = await resolveEndpoint();
			const wsUrl = websocketUrl(endpoint);
			const nextClient = new AppServerClient({
				webSocketFactory: url => {
					const socket = new WebSocket(url);
					const handleConnectionLoss = () => {
						restoreAppearanceAfterConnectionLoss();
						setClient(undefined);
						setConnection(describeFailure(new Error("App server connection closed")));
					};
					socket.addEventListener("close", handleConnectionLoss);
					socket.addEventListener("error", handleConnectionLoss);
					return socket;
				},
			});
			await nextClient.connect(wsUrl);
			const unsubscribe = nextClient.onNotification(notification => {
				setTranscript(current => foldNotification(current, notification));
				if (notificationRefreshCause(notification)) setExecRefreshNonce(nonce => nonce + 1);
			});
			stopRef.current?.();
			stopRef.current = () => {
				unsubscribe();
				nextClient.close(1000, "GJC GUI reconnect");
			};
			await nextClient.initialize();
			nextClient.notify("initialized", {});
			setClient(nextClient);
			const nextConnection: ConnectionState = { kind: "connected", endpointUrl: endpoint.url };
			setConnection(nextConnection);
			restoreComposerFocus();
			void refreshSessions(nextClient);
			void nextClient.gjcAuthStatus().catch(() => undefined);
			if (transcript.activeThreadId) void resyncWorkflowGates(nextClient, transcript.activeThreadId, setTranscript);
			return nextConnection;
		} catch (error) {
			restoreAppearanceAfterConnectionLoss();
			setClient(undefined);
			const nextConnection = describeFailure(error);
			setConnection(nextConnection);
			return nextConnection;
		}
	}, [restoreAppearanceAfterConnectionLoss, restoreComposerFocus, transcript.activeThreadId]);

	useEffect(() => {
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
				await new Promise(resolve => setTimeout(resolve, 1500));
			}
		};
		void run();
		return () => {
			cancelled = true;
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

	useEffect(() => {
		if (!client || !activeThreadId) {
			setExecCards([]);
			return;
		}
		let cancelled = false;
		const timer = window.setTimeout(() => {
			setExecCards(current => current.length > 0 ? current : [
				cardFromRows("todos", "Todos", undefined),
				cardFromRows("context", "Context", undefined),
				cardFromRows("usage", "Usage", undefined),
				cardFromRows("jobs", "Jobs", undefined),
				cardFromRows("agents", "Agents", undefined),
				cardFromRows("monitors", "Monitors", undefined),
				cardFromRows("compact", "Compaction", undefined),
			]);
			const params = { threadId: activeThreadId };
			Promise.allSettled([
				client.gjcTodosRead(params),
				client.gjcContextRead(params),
				client.gjcUsageRead(params),
				client.gjcJobsList(params),
				client.gjcAgentsList(params),
				client.gjcMonitorsList(params),
				client.gjcCompactSummary(params),
			]).then(results => {
				if (cancelled) return;
				const names = [["todos", "Todos"], ["context", "Context"], ["usage", "Usage"], ["jobs", "Jobs"], ["agents", "Agents"], ["monitors", "Monitors"], ["compact", "Compaction"]] as const;
				const nextCards = results.map((result, index) => {
					const [key, title] = names[index];
					if (result.status === "rejected") return errorCard(key, title, result.reason);
					const value = result.value as Record<string, unknown>;
					const rows = key === "context" ? [value] : (value.todos ?? value.perModel ?? value.jobs ?? value.agents ?? value.monitors ?? value.summaries) as unknown[];
					return key === "monitors" ? monitorsCardFromResult(value) : cardFromRows(key, title, rows);
				});
				setExecCards(current => mergeExecCards(current, nextCards));
			});
		}, 150);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [client, activeThreadId, transcript.activeTurnId, execRefreshNonce]);
	const visibleItems = (activeThreadId ? transcript.items.filter(item => item.threadId === activeThreadId) : transcript.items).filter(
		item => {
			if (item.role === "tool") return true;
			if (item.status === "running") return true;
			const text =
				item.role === "assistant" || item.role === "reasoning"
					? cleanAssistantText(item.content ?? "")
					: (item.content ?? "").trim();
			return text.length > 0;
		},
	);
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
			if (!currentTurn || currentTurn.items.at(-1)?.turnId !== item.turnId) {
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
	const interleavedTranscript = interleaveApprovals(
		renderEntries.map(entry => ({ id: entry.kind === "turn" ? entry.key : entry.item.id, turnId: entry.kind === "turn" ? entry.items.at(-1)?.turnId : entry.item.turnId, entry })),
		visibleApprovals.map(approval => ({ id: approval.id, turnId: "turnId" in approval ? approval.turnId : undefined, approval })),
	);
	const lastAssistantCopy = lastAssistantText(visibleItems);
	const transcriptDump = serializeTranscript(visibleItems);
	const canCopyAssistant = Boolean(lastAssistantCopy);
	const canDumpTranscript = transcriptDump.length > 0;

	useEffect(() => {
		return () => window.clearTimeout(copyStatusTimeoutRef.current);
	}, []);

	useEffect(() => {
		if (stickToBottomRef.current) {
			transcriptBottomRef.current?.scrollIntoView({ block: "end" });
		}
	}, [visibleItems.length, visibleApprovals.length]);
	const connected = connection.kind === "connected";
	const flatTree = sessionBrowser.tree ? flattenSessionTree(sessionBrowser.tree.nodes) : [];
	const unifiedSessions = deriveUnifiedSessionRows({ threads: transcript.threads, sessions: sessionBrowser.sessions, tree: flatTree, activeThreadId });
	const sessionScopeCwd = (activeThread?.cwd ?? normalizeDirectoryInput(workingDirectory)) || undefined;

	useEffect(() => {
		setSessionRovingIndex(current => clampRovingIndex(current, unifiedSessions.length));
		sessionRowRefs.current.length = unifiedSessions.length;
	}, [unifiedSessions.length]);

	useEffect(() => {
		if (sessionRovingIndex < 0) return;
		const activeElement = document.activeElement;
		if (activeElement instanceof HTMLElement && activeElement.closest(".thread-list")) {
			sessionRowRefs.current[sessionRovingIndex]?.focus();
		}
	}, [sessionRovingIndex]);


	useEffect(() => {
		if (!client || !connected) return;
		const timer = window.setTimeout(() => void refreshSessionBrowser(client, sessionBrowser.query, sessionScope), 250);
		return () => window.clearTimeout(timer);
	}, [client, connected, sessionBrowser.query, sessionScope, sessionScopeCwd]);

	const loadPaletteData = useCallback(async () => {
		if (!client || !activeThreadId) return;
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
	}, [activeThreadId, client]);

	const loadExtensibilityData = useCallback(async () => {
		if (!client || !connected || !activeThreadId) return;
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
				appearanceThemes: themesResult.themes,
				appearancePreview: createAppearancePreviewState(appearanceResult),
				loading: false,
			}));
		} catch (error) {
			restoreAppearanceAfterConnectionLoss();
			setExtData(current => ({ ...current, loading: false, error: errorMessage(error) }));
		}
	}, [activeThreadId, client, connected, restoreAppearanceAfterConnectionLoss]);

	const inspectExtension = useCallback(async (extensionId: string) => {
		if (!client || !connected || !activeThreadId) return;
		try {
			const result = await client.gjcExtensionsInspect({ extensionId, threadId: activeThreadId });
			setExtData(current => ({ ...current, extensionInspection: result.extension ?? undefined, error: undefined }));
		} catch (error) {
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [activeThreadId, client, connected]);

	const inspectPlugin = useCallback(async (pluginId: string) => {
		if (!client || !connected || !activeThreadId) return;
		try {
			const result = await client.gjcPluginsInspect({ pluginId, threadId: activeThreadId });
			setExtData(current => ({ ...current, pluginInspection: result.plugin ?? undefined, error: undefined }));
		} catch (error) {
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [activeThreadId, client, connected]);

	const previewAppearanceSettings = useCallback((next: AppearanceSettings) => {
		setExtData(current => current.appearancePreview ? { ...current, appearancePreview: { ...current.appearancePreview, candidate: next, previewActive: true } } : current);
	}, []);

	const restoreAppearanceSettings = useCallback(() => {
		setExtData(current => current.appearancePreview ? { ...current, appearancePreview: restoreAppearancePreview(current.appearancePreview) } : current);
	}, []);

	const applyAppearanceSettings = useCallback(async (next: AppearanceSettings) => {
		if (!client) return;
		try {
			const applied = await client.gjcAppearanceSet(next);
			setExtData(current => current.appearancePreview ? { ...current, appearancePreview: commitAppearancePreview(current.appearancePreview, applied), error: undefined } : current);
		} catch (error) {
			restoreAppearanceAfterConnectionLoss();
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [client, restoreAppearanceAfterConnectionLoss]);

	const setSkillEnabled = useCallback(async (skillId: string, enabled: boolean) => {
		if (!client) return;
		try {
			await (client as FrozenContractClient).gjcSkillsSetEnabled(setEnabledPayload("skillId", skillId, enabled));
			setExtData(current => ({ ...current, skills: current.skills.map(skill => ((skill as { id?: string; skillId?: string }).id ?? (skill as { skillId?: string }).skillId ?? skill.name) === skillId ? { ...skill, enabled } : skill), error: undefined }));
		} catch (error) {
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [client]);

	const setExtensionEnabled = useCallback(async (extensionId: string, enabled: boolean) => {
		if (!client) return;
		try {
			await (client as FrozenContractClient).gjcExtensionsSetEnabled(setEnabledPayload("extensionId", extensionId, enabled));
			setExtData(current => ({ ...current, extensions: current.extensions.map(extension => extension.id === extensionId ? { ...extension, enabled } : extension), error: undefined }));
		} catch (error) {
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [client]);

	const setPluginEnabled = useCallback(async (pluginId: string, enabled: boolean) => {
		if (!client) return;
		try {
			await (client as FrozenContractClient).gjcPluginsSetEnabled(setEnabledPayload("pluginId", pluginId, enabled));
			setExtData(current => ({ ...current, plugins: current.plugins.map(plugin => plugin.id === pluginId ? { ...plugin, enabled } : plugin), error: undefined }));
		} catch (error) {
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [client]);

	const setPluginFeature = useCallback(async (pluginId: string, feature: string, enabled: boolean) => {
		if (!client) return;
		try {
			await (client as FrozenContractClient).gjcPluginsSetFeature(pluginFeaturePayload(pluginId, feature, enabled));
			setExtData(current => ({ ...current, error: undefined }));
		} catch (error) {
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [client]);

	const setPluginSetting = useCallback(async (pluginId: string, key: string, value: unknown) => {
		if (!client) return;
		try {
			const payload = pluginSettingPayload(pluginId, key, value);
			await (client as FrozenContractClient).gjcPluginsSetSetting({ ...payload, value: payload.value as JsonValue });
			setExtData(current => ({ ...current, error: undefined }));
		} catch (error) {
			setExtData(current => ({ ...current, error: errorMessage(error) }));
		}
	}, [client]);

	useEffect(() => {
		if (workspaceView === "extensibility") void loadExtensibilityData();
	}, [loadExtensibilityData, workspaceView]);

	useEffect(() => {
		function handleGlobalKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				const action = escapeAction({ overlayOpen: paletteOpen || Boolean(localSheet) || Boolean(labelPrompt) || Boolean(sessionDeleteConfirm) || Boolean(sessionMoveConfirm), transientOpen: showJumpToLatest, queuedText: queuedSteer, running: Boolean(transcript.activeTurnId) });
				if (action === "none") return;
				event.preventDefault();
				if (action === "close-overlay") {
					setPaletteOpen(false);
					setLocalSheet(undefined);
					setLabelPrompt(null);
					setSessionDeleteConfirm(null);
					setSessionMoveConfirm(null);
				} else if (action === "dismiss-transient") {
					setShowJumpToLatest(false);
				} else if (action === "clear-queued") {
					setQueuedSteer("");
				} else {
					void stopTurn();
				}
				return;
			}
			if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				setPaletteOpen(current => {
					const next = !current;
					if (next) void loadPaletteData();
					return next;
				});
				return;
			}
			if (event.key.toLowerCase() === "n" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void startNewThreadFromActions();
			}
		}
		window.addEventListener("keydown", handleGlobalKeyDown);
		return () => window.removeEventListener("keydown", handleGlobalKeyDown);
	}, [labelPrompt, loadPaletteData, localSheet, paletteOpen, queuedSteer, sessionDeleteConfirm, sessionMoveConfirm, showJumpToLatest, transcript.activeTurnId]);

	useEffect(() => {
		function handleResize() {
			setRightRailCollapsed(current => nextRightRailCollapsed(current, window.innerWidth < 1180 ? "collapse" : "expand", window.innerWidth));
		}
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	const closePalette = useCallback(() => {
		setPaletteOpen(false);
		restoreComposerFocus();
	}, [restoreComposerFocus]);

	const insertPaletteText = useCallback((text: string) => {
		setComposer(current => current + text);
		restoreComposerFocus();
	}, []);

	const handlePaletteAction = useCallback((action: PaletteCommandAction, _command: PaletteCommand) => {
		if (action.kind === "local-sheet") {
			setLocalSheet(action.target);
			return;
		}
		if (action.kind === "navigate") {
			setOpenDrawer(action.target);
			const extensibilityTabs: Partial<Record<OpenDrawer, ExtensibilityTab>> = { theme: "appearance", skills: "skills", extensions: "extensions", plugins: "plugins" };
			const targetTab = extensibilityTabs[action.target];
			if (targetTab) {
				setExtensibilityTab(targetTab);
				setWorkspaceView("extensibility");
				void loadExtensibilityData();
			} else {
				setWorkspaceView("chat");
			}
			return;
		}
		if (action.kind !== "invoke") return;
		const run = async () => {
			switch (action.target) {
				case "compact": await compactThread(); break;
				case "retry": await retryLastTurn(); break;
				case "new": await startNewThreadFromActions(); break;
				case "copy": await copyTranscriptText(lastAssistantCopy); break;
				case "dump": await copyTranscriptText(transcriptDump); break;
				case "drop":
					if (activeThreadId && !(await deleteThread(activeThreadId))) break;
					await startNewThreadFromActions();
					break;
				case "resume": await startThread(); break;
				case "move": if (activeThreadId) await dryRunMoveThread(activeThreadId); break;
			}
		};
		void run();
	}, [activeThreadId, lastAssistantCopy, loadExtensibilityData, transcriptDump]);

	// Return the active thread id, creating one on demand so the first message
	// just works. Uses the chosen working directory, or the default scratch
	// directory (/tmp) when none is picked — matching the TUI's default session.
	async function ensureActiveThread(): Promise<string | undefined> {
		if (activeThreadId) return activeThreadId;
		if (!client) return undefined;
		const cwd = normalizeDirectoryInput(workingDirectory) || DEFAULT_CWD;
		const result = await client.threadStart({ source: "gjc-gui", cwd });
		rememberDirectory(cwd, setRecentDirectories);
		setWorkingDirectory(cwd);
		setTranscript(current => upsertThread(current, result.thread, cwd));
		void refreshModelLabel(result.thread.id);
		void refreshGoalStatus(result.thread.id);
		return result.thread.id;
	}

	// The active model isn't carried on ThreadSummary; read it from session state.
	async function refreshGoalStatus(threadId: string): Promise<void> {
		if (!client) return;
		try {
			setGoalStatus(await client.gjcGoalRead({ threadId }));
		} catch {
			setGoalStatus(undefined);
		}
	}

	async function refreshModelLabel(threadId: string): Promise<void> {
		if (!client) return;
		try {
			const state = await client.gjcStateRead({ threadId });
			const label = modelLabelFromStateRead(state);
			if (label) setTranscript(current => ({ ...current, modelLabel: label }));
		} catch {
			// Non-fatal: leave the previous label.
		}
	}

	async function startNewThreadFromActions() {
		if (!client) return;
		try {
			const cwd = normalizeDirectoryInput(workingDirectory) || DEFAULT_CWD;
			const result = await client.threadStart({ source: "gjc-gui", cwd });
			setTranscript(current => upsertThread(current, result.thread, cwd));
			void refreshModelLabel(result.thread.id);
			void refreshGoalStatus(result.thread.id);
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function retryLastTurn() {
		if (!client) return;
		try {
			await retryLastTurnAction(client, activeThreadId);
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function startThread() {
		try {
			const id = await ensureActiveThread();
			if (id) restoreComposerFocus();
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function pickDirectory() {
		setPickingDirectory(true);
		try {
			const selected = await invoke<string | null>("pick_directory");
			if (selected) setWorkingDirectory(selected);
		} catch (error) {
			setConnection(describeFailure(error));
		} finally {
			setPickingDirectory(false);
		}
	}

	async function resumeThread(threadId: string) {
		if (!client) return;
		try {
			const result = await client.threadResume({ threadId });
			setTranscript(current => upsertThread(current, result.thread));
			void refreshModelLabel(threadId);
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function refreshSessionBrowser(sessionClient = client, query = sessionBrowser.query, scope = sessionScope) {
		if (!sessionClient) return;
		setSessionBrowser(current => ({ ...current, loading: true, error: undefined }));
		try {
			const params = buildSessionBrowserParams(query, scope, sessionScopeCwd);
			const result = params.query ? await sessionClient.gjcSessionSearch({ ...params, query: params.query }) : await sessionClient.gjcSessionList(params);
			setSessionBrowser(current => ({ ...current, sessions: result.sessions, loading: false }));
		} catch (error) {
			setSessionBrowser(current => ({ ...current, loading: false, error: describeFailure(error).detail ?? String(error) }));
		}
	}

	async function refreshSessionTree() {
		if (!activeThreadId) return;
		await refreshSessionTreeFor(activeThreadId);
	}

	async function openSession(sessionPath: string) {
		if (!client) return;
		try {
			const result = await (client as unknown as SessionBrowserClient).gjcSessionOpen(sessionOpenPayload(sessionPath));
			const readResult = await client.threadRead({ threadId: result.threadId });
			setTranscript(current => upsertThread(current, readResult.thread, result.sessionMetadata?.cwd ?? undefined));
			void refreshModelLabel(result.threadId);
			void refreshGoalStatus(result.threadId);
			await refreshSessionTreeFor(result.threadId);
		} catch (error) {
			setSessionBrowser(current => ({ ...current, error: describeFailure(error).detail ?? String(error) }));
		}
	}

	async function deleteSession(sessionPath: string) {
		if (!client) return;
		try {
			await (client as unknown as SessionBrowserClient).gjcSessionDelete(sessionDeletePayload(sessionPath));
			setSessionBrowser(current => ({ ...current, sessions: current.sessions.filter(session => session.path !== sessionPath), error: undefined }));
		} catch (error) {
			setSessionBrowser(current => ({ ...current, error: describeFailure(error).detail ?? String(error) }));
		}
	}

	async function refreshSessionTreeFor(threadId: string) {
		if (!client) return;
		try {
			const tree = await client.gjcSessionTree({ threadId });
			setSessionBrowser(current => ({ ...current, tree }));
		} catch (error) {
			setSessionBrowser(current => ({ ...current, error: describeFailure(error).detail ?? String(error) }));
		}
	}

	async function navigateSessionTree(entryId: string) {
		if (!client || !activeThreadId) return;
		try {
			await (client as unknown as SessionBrowserClient).gjcSessionNavigate(sessionNavigatePayload(activeThreadId, entryId));
			await refreshSessionTreeFor(activeThreadId);
		} catch (error) {
			setSessionBrowser(current => ({ ...current, error: describeFailure(error).detail ?? String(error) }));
		}
	}

	async function labelSessionTree(entryId: string, label: string) {
		if (!client || !activeThreadId) return;
		const validation = validateSessionLabel(label);
		if (validation) {
			setSessionBrowser(current => ({ ...current, error: validation }));
			return;
		}
		try {
			await (client as unknown as SessionBrowserClient).gjcSessionLabel(sessionLabelPayload(activeThreadId, entryId, label));
			await refreshSessionTreeFor(activeThreadId);
		} catch (error) {
			setSessionBrowser(current => ({ ...current, error: describeFailure(error).detail ?? String(error) }));
		}
	}

	async function renameSession(sessionPath: string, title: string) {
		if (!client) return;
		const validation = validateRenameTitle(title);
		if (validation) {
			setSessionBrowser(current => ({ ...current, error: validation }));
			return;
		}
		await client.gjcSessionRename({ sessionPath, title: title.trim() });
		await refreshSessionBrowser(client);
	}

	async function exportSession(sessionPath: string, format: "markdown" | "json") {
		if (!client) return;
		try {
			const result = await client.gjcSessionExport({ sessionPath, format, redact: true });
			await navigator.clipboard.writeText(result.content);
			setSessionBrowser(current => ({ ...current, exportStatus: `Copied ${format} export · ${provenanceLabel(result.provenance)}` }));
		} catch (error) {
			setSessionBrowser(current => ({ ...current, exportStatus: `Export failed: ${describeFailure(error).detail ?? String(error)}` }));
		}
	}

	async function refreshSessions(sessionClient = client) {
		if (!sessionClient) return;
		void refreshSessionBrowser(sessionClient);
		try {
			const result = await sessionClient.threadLoadedList({});
			for (const threadId of result.data) {
				if (transcript.threads.some(thread => thread.id === threadId)) continue;
				try {
					const readResult = await sessionClient.threadRead({ threadId });
					setTranscript(current => (current.threads.some(thread => thread.id === threadId) ? current : upsertThread(current, readResult.thread)));
				} catch (readError) {
					// Do NOT fabricate a placeholder row on a read/hydration failure — that
					// would hide a real contract failure. Skip the id (it can be resumed
					// explicitly) and surface the failure for diagnostics.
					setConnection(describeFailure(readError));
				}
			}
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function forkThread(threadId: string) {
		if (!client) return;
		try {
			const result = await client.threadFork({ threadId });
			setTranscript(current => upsertThread(current, result.thread));
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function dryRunMoveThread(threadId: string) {
		if (!client) return;
		const targetCwd = window.prompt("Move session to absolute existing directory", activeThread?.cwd ?? workingDirectory);
		if (!targetCwd) return;
		try {
			const state = await dryRunSessionMove(client as unknown as { gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun: true }): Promise<NonNullable<SessionMoveConfirmState>["plan"]> }, threadId, targetCwd);
			setSessionMoveConfirm(state);
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function confirmMoveThread() {
		if (!client || !sessionMoveConfirm) return;
		try {
			const result = await executeSessionMove(client as unknown as { gjcSessionMove(params: { threadId: string; targetCwd: string; dryRun?: false }): Promise<{ dryRun: false; movedTo: string; sessionPath: string }> }, sessionMoveConfirm);
			if (result) {
				setTranscript(current => ({ ...current, threads: current.threads.map(thread => thread.id === sessionMoveConfirm.threadId ? { ...thread, cwd: result.movedTo } : thread) }));
				await refreshSessions();
			}
			setSessionMoveConfirm(null);
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function archiveThread(threadId: string) {
		if (!client) return;
		try {
			await client.threadArchive({ threadId });
			setTranscript(current => ({ ...current, threads: markThreadArchived(current.threads, threadId) }));
			await refreshSessions();
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function deleteThread(threadId: string): Promise<boolean> {
		if (!client) return false;
		try {
			await client.threadDelete({ threadId });
			setTranscript(current => ({
				...current,
				activeThreadId: current.activeThreadId === threadId ? undefined : current.activeThreadId,
				threads: removeThread(current.threads, threadId),
				items: current.items.filter(item => item.threadId !== threadId),
				approvals: current.approvals.filter(approval => approval.threadId !== threadId),
			}));
			return true;
		} catch (error) {
			setConnection(describeFailure(error));
			return false;
		}
	}

	async function submitComposer() {
		const mode = composerSubmitMode({ connected, busy: isSubmitting || Boolean(transcript.activeTurnId), text: composer });
		if (!client || mode === "ignore") return;
		const prompt = composer.trim();
		try {
			const threadId = activeThreadId ?? (await ensureActiveThread());
			if (!threadId) {
				setConnection(describeFailure(new Error("Could not resolve a working directory to start a thread.")));
				return;
			}
			setComposer("");
			setTranscript(current => appendLocalUserMessage(current, threadId, prompt));
			if (mode === "queue") {
				setQueuedSteer(prompt);
				await client.turnSteer({ threadId, text: prompt });
			} else {
				setSubmitting(true);
				await client.turnStart({ threadId, text: prompt });
			}
		} catch (error) {
			setConnection(describeFailure(error));
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
		if (!client || !activeThreadId || !transcript.activeTurnId) return;
		try {
			await client.turnInterrupt({ threadId: activeThreadId, turnId: transcript.activeTurnId });
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function applyModel(provider: string, modelId: string) {
		if (!client || !activeThreadId) return;
		try {
			await client.gjcModelSet({ threadId: activeThreadId, provider, modelId });
			setTranscript(current => ({
				...current,
				modelLabel: `${provider}/${modelId}`,
				threads: current.threads.map(thread => (thread.id === activeThreadId ? { ...thread, modelLabel: `${provider}/${modelId}` } : thread)),
			}));
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	const loadModelCatalog = useCallback(async () => {
		if (!client || !activeThreadId) return { models: [] };
		return client.gjcModelCatalog({ threadId: activeThreadId });
	}, [client, activeThreadId]);

	const loadThinking = useCallback(async () => {
		if (!client || !activeThreadId) return { level: "off", levels: ["off"] };
		return client.gjcThinkingRead({ threadId: activeThreadId });
	}, [client, activeThreadId]);

	const setThinkingLevel = useCallback(async (level: string) => {
		if (!client || !activeThreadId) return;
		await client.gjcThinkingSet({ threadId: activeThreadId, level });
	}, [client, activeThreadId]);

	const loadFastMode = useCallback(async () => {
		if (!client || !activeThreadId) return { enabled: false };
		return client.gjcFastRead({ threadId: activeThreadId });
	}, [client, activeThreadId]);

	const setFastMode = useCallback(async (enabled: boolean) => {
		if (!client || !activeThreadId) return;
		await client.gjcFastSet({ threadId: activeThreadId, enabled });
	}, [client, activeThreadId]);

	const loadSafeSettings = useCallback(async () => {
		if (!client) return { schema: [], values: {} };
		const [schema, read] = await Promise.all([client.gjcSettingsSchema(), client.gjcSettingsRead()]);
		return { schema: schema.settings, values: read.values };
	}, [client]);

	const updateSafeSetting = useCallback(async (key: string, value: unknown) => {
		if (!client) return {};
		const result = await client.gjcSettingsUpdate({ key, value: value as JsonValue });
		return result.values;
	}, [client]);

	const loadProviders = useCallback(async () => {
		if (!client) return { providers: [] };
		return client.gjcProviderList();
	}, [client]);

	const logoutProvider = useCallback(async (providerId: string) => {
		if (!client) return;
		await client.gjcAuthLogout({ providerId });
		await client.gjcAuthStatus();
	}, [client]);

	const providerAdd = useCallback(async (payload: unknown) => {
		if (!client) return { ok: true as const, providerId: "", models: [] };
		return (client as FrozenContractClient).gjcProviderAdd(payload);
	}, [client]);

	const loginClient = useMemo(() => client ? {
		start: async (providerId: string) => {
			const result = await (client as FrozenContractClient).gjcAuthLoginStart({ providerId });
			return { flowId: result.flowId, state: result.state, ...(result.authUrl ? { authUrl: result.authUrl } : {}), ...(result.instructions ? { instructions: result.instructions } : {}) };
		},
		poll: async (flowId: string) => {
			const result = await (client as FrozenContractClient).gjcAuthLoginPoll({ flowId });
			return { state: result.state, ...(result.promptMessage ? { promptMessage: result.promptMessage } : {}) };
		},
		complete: (flowId: string, redirectUrl: string) => (client as FrozenContractClient).gjcAuthLoginComplete({ flowId, redirectUrl }),
		cancel: (flowId: string) => (client as FrozenContractClient).gjcAuthLoginCancel({ flowId }),
	} : undefined, [client]);

	const assignModelRole = useCallback(async (payload: { threadId: string; role: string; provider: string; modelId: string; thinkingLevel?: string }) => {
		if (!client || !activeThreadId || payload.threadId !== activeThreadId) return;
		await (client as FrozenContractClient).gjcModelAssign(payload);
	}, [client, activeThreadId]);


	async function resolveApproval(approval: ApprovalGate, approved: boolean) {
		if (!client || approval.kind !== "host-tool") return;
		setTranscript(current => markApproval(current, approval.id, approved ? "approved" : "rejected"));
		try {
			await client.gjcHostToolsResult({
				threadId: approval.threadId,
				callId: approval.id,
				ok: approved,
				result: approved ? { approved: true } : undefined,
				error: approved ? undefined : { rejected: true, reason: "Rejected in GJC GUI" },
			});
		} catch (error) {
			setConnection(describeFailure(error));
		}
		restoreComposerFocus();
	}

async function resolveHostUri(approval: ApprovalGate, ok: boolean, payload?: { content?: string; contentType?: string }) {
	if (!client || approval.kind !== "host-uri") return;
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
	} catch (error) {
		setConnection(describeFailure(error));
	}
	restoreComposerFocus();
}


async function respondWorkflowGate(approval: ApprovalGate, selectedValue: JsonValue) {
	if (!client || approval.kind !== "workflow-gate") return;
	const answer = workflowGateAnswer(approval, selectedValue);
	if (!answer) {
		setTranscript(current => markWorkflowGateFailed(current, approval.id, "Unsupported workflow gate schema; answer manually outside the GUI."));
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
		} else {
			setTranscript(current => markWorkflowGateFailed(current, approval.id, workflowGateResolutionError(resolution)));
		}
	} catch (error) {
		setTranscript(current => markWorkflowGateFailed(current, approval.id, errorMessage(error)));
		setConnection(describeFailure(error));
	}
	restoreComposerFocus();
}

	async function compactThread() {
		if (!client || !activeThreadId) return;
		try {
			await client.gjcCompact({ threadId: activeThreadId });
		} catch (error) {
			setConnection(describeFailure(error));
		}
		restoreComposerFocus();
	}

	async function copyTranscriptText(text: string | undefined) {
		if (!text) return;
		await navigator.clipboard.writeText(text);
		setCopyStatus("copied");
		window.clearTimeout(copyStatusTimeoutRef.current);
		copyStatusTimeoutRef.current = window.setTimeout(() => setCopyStatus("idle"), 1400);
		restoreComposerFocus();
	}

	return (
		<main className={`app-shell ${rightRailCollapsed ? "app-shell--rail-collapsed" : ""}`}>
			<aside className="app-sidebar" aria-label="Threads">
				<div className="brand-lockup">
					<img className="brand-mark" src="/icon.png" alt="" aria-hidden="true" />
					<div>
						<strong>Gajae Code</strong>
						<span>Desktop chat</span>
					</div>
				</div>
				<SessionSetupPanel
					connected={connected}
					workingDirectory={workingDirectory}
					recentDirectories={recentDirectories}
					isPickingDirectory={isPickingDirectory}
					onWorkingDirectoryChange={setWorkingDirectory}
					onPickDirectory={() => void pickDirectory()}
					onStart={() => void startThread()}
				/>
				<nav className="workspace-switcher" role="tablist" aria-label="Workspace sections">
					<button role="tab" aria-selected={workspaceView === "chat"} className={workspaceView === "chat" ? "workspace-switcher__button workspace-switcher__button--selected" : "workspace-switcher__button"} type="button" onClick={() => setWorkspaceView("chat")}>
						Chat
					</button>
					<button role="tab" aria-selected={workspaceView === "extensibility"} className={workspaceView === "extensibility" ? "workspace-switcher__button workspace-switcher__button--selected" : "workspace-switcher__button"} type="button" onClick={() => setWorkspaceView("extensibility")} disabled={!connected || !activeThreadId}>
						Skills & extensions
					</button>
				</nav>
				<div className="session-browser session-browser--unified">
					<div className="session-browser__scope" role="group" aria-label="Session scope">
						<button className={sessionScope === "cwd" ? "neutral-action session-browser__scope-button--selected" : "neutral-action"} type="button" onClick={() => setSessionScope("cwd")} disabled={!sessionScopeCwd}>This folder</button>
						<button className={sessionScope === "all" ? "neutral-action session-browser__scope-button--selected" : "neutral-action"} type="button" onClick={() => setSessionScope("all")}>All</button>
					</div>
					<input className="session-browser__search" value={sessionBrowser.query} onChange={event => setSessionBrowser(current => ({ ...current, query: event.target.value }))} placeholder="Search sessions" aria-label="Search sessions" />
					{sessionBrowser.loading ? <div className="skeleton-list" aria-label="Loading sessions"><span /><span /><span /></div> : null}
					{sessionBrowser.error ? <div className="empty-inline">{sessionBrowser.error}</div> : null}
					{!sessionBrowser.loading && unifiedSessions.length === 0 ? <div className="empty-inline">No sessions found. Start a thread or change scope.</div> : null}
					<nav className="thread-list" aria-label="Unified sessions" onKeyDown={event => {
						const next = nextRovingIndex(sessionRovingIndex, event.key, unifiedSessions.length);
						if (next !== sessionRovingIndex) {
							event.preventDefault();
							setSessionRovingIndex(next);
							sessionRowRefs.current[next]?.focus();
						}
					}}>
						{unifiedSessions.map((row, index) => {
							const loadedThread = transcript.threads.find(thread => thread.id === row.id);
							const status = sessionRowStatusPresentation(row.status);
							return (
								<div className={`thread-row thread-row--${row.status} thread-row--${status.tone} ${row.active ? "thread-row--selected" : ""}`} key={row.path ?? row.id} style={{ paddingLeft: `calc(var(--gjc-space-8) + ${row.depth} * var(--gjc-space-12))` }}>
									<button ref={element => { sessionRowRefs.current[index] = element; }} className="thread-row__resume" type="button" tabIndex={index === sessionRovingIndex ? 0 : -1} onFocus={() => setSessionRovingIndex(index)} onClick={() => row.path ? void openSession(row.path) : void resumeThread(row.id)}>
										<span className="thread-title">{row.title}</span>
										<span className="thread-meta"><span className={`status-dot status-dot--${status.tone}`} />{status.label} · {row.meta || threadSuffix(row.id)}</span>
									</button>
									<div className="session-browser__actions">
										<button type="button" className="neutral-action session-actions__button" disabled={!connected} onClick={() => row.path ? void openSession(row.path) : void resumeThread(row.id)}>Resume</button>
										<button type="button" className="neutral-action session-actions__button" disabled={!connected || !row.loaded} onClick={() => void forkThread(row.id)}>Fork</button>
										<button type="button" className="neutral-action session-actions__button" disabled={!row.path} onClick={() => row.path ? setLabelPrompt({ title: "Rename session", message: row.path, value: row.title, confirmLabel: "Rename", onConfirm: value => void renameSession(row.path ?? "", value) }) : undefined}>Rename</button>
										<button type="button" className="neutral-action session-actions__button" disabled={!row.path} onClick={() => row.path ? void exportSession(row.path, "markdown") : undefined}>Export</button>
										<button type="button" className="neutral-action session-actions__button session-actions__button--danger" disabled={!row.path && !row.loaded} onClick={() => row.path ? setSessionDeleteConfirm({ kind: "delete", threadId: row.id, title: row.title, sessionPath: row.path }) : void deleteThread(row.id)}>Delete</button>
									</div>
									{loadedThread ? <SessionActions thread={loadedThread} disabled={!connected} onFork={id => void forkThread(id)} onArchive={id => void archiveThread(id)} onDelete={id => void deleteThread(id)} onMove={id => void dryRunMoveThread(id)} /> : null}
								</div>
							);
						})}
					</nav>
					{sessionBrowser.exportStatus ? <div className="empty-inline">{sessionBrowser.exportStatus}</div> : null}
					<div className="button-row"><button type="button" className="neutral-action" disabled={!activeThreadId} onClick={() => void refreshSessionTree()}>Refresh tree</button></div>
					{flatTree.length ? <div className="session-browser__tree" role="tree" aria-label="Session tree controls">{flatTree.map((node, index) => <div className="session-browser__tree-row" role="treeitem" aria-selected={node.active} key={node.id}><button className="session-browser__tree-node" type="button" tabIndex={index === 0 ? 0 : -1} onClick={() => void navigateSessionTree(node.id)}><span aria-hidden="true">{"  ".repeat(node.depth)}{node.marker} </span>{node.label ?? (node.preview || node.type)}</button><button className="session-browser__tree-label" type="button" onClick={() => setLabelPrompt({ title: "Label tree node", message: node.text, value: node.label ?? "", confirmLabel: "Save label", onConfirm: value => void labelSessionTree(node.id, value) })}>label</button></div>)}</div> : null}
				</div>
				<details className="sidebar-drawer" open={openDrawer === "model" || openDrawer === "settings" || openDrawer === "provider"}>
					<summary>Model &amp; settings</summary>
					<ModelPanel currentModel={transcript.modelLabel} activeThreadId={activeThreadId} disabled={!connected || !activeThreadId} onApply={applyModel} loadCatalog={loadModelCatalog} loadThinking={loadThinking} onSetThinking={setThinkingLevel} loadFast={loadFastMode} onSetFast={setFastMode} loadSettings={loadSafeSettings} onUpdateSetting={updateSafeSetting} loadProviders={loadProviders} onLogoutProvider={logoutProvider} onProviderAdd={providerAdd} loginClient={loginClient} onModelAssign={assignModelRole} />
				</details>
				<ConnectionBadge connection={connection} modelLabel={transcript.modelLabel} />
			</aside>

			{workspaceView === "extensibility" ? (
				<section className="chat-workspace" aria-label="Skills and extensions catalog">
					<ExtensibilityPanel
						skills={extData.skills}
						extensions={extData.extensions}
						plugins={extData.plugins}
						pluginInspection={extData.pluginInspection}
						extensionInspection={extData.extensionInspection}
						appearanceThemes={extData.appearanceThemes}
						appearance={extData.appearancePreview?.candidate}
						appearancePreviewActive={extData.appearancePreview?.previewActive}
						activeTab={extensibilityTab}
						onTabChange={setExtensibilityTab}
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
						onPluginFeature={(id, feature, enabled) => void setPluginFeature(id, feature, enabled)}
						onPluginSetting={(id, key, value) => void setPluginSetting(id, key, value)}
					/>
				</section>
			) : (
				<section className="chat-workspace" aria-label="Chat transcript">
					<header className="chat-header">
						<div>
							<p className="eyebrow">Chat</p>
							<h1>{activeThread ? threadPrimaryLabel(activeThread) : "New chat"}</h1>
						</div>
						<div className="header-actions">
							<button className="neutral-action" type="button" onClick={() => void startNewThreadFromActions()} disabled={!connected}>
								New thread
							</button>
							<button className="neutral-action" type="button" onClick={() => void retryLastTurn()} disabled={!connected || !activeThreadId}>
								Retry
							</button>
							<button className="neutral-action" type="button" disabled={!connected || !activeThreadId} onClick={() => void compactThread()}>
								Compact
							</button>
							<button className="neutral-action" type="button" disabled={!canCopyAssistant} onClick={() => void copyTranscriptText(lastAssistantCopy)}>
								Copy
							</button>
							<button className="neutral-action" type="button" disabled={!canDumpTranscript} onClick={() => void copyTranscriptText(transcriptDump)}>
								Dump
							</button>
							<span className="copy-status" role="status" aria-live="polite">
								{copyStatus === "copied" ? "Copied" : ""}
							</span>
							<span className="model-chip" title="Active model (change under Model & settings in the sidebar)">
							{transcript.modelLabel || "—"}
							</span>
						</div>
					</header>
					{connection.kind !== "connected" ? (
						<ConnectionErrorPanel connection={connection} onReconnect={() => void connect()} />
					) : null}
					<section className="transcript" aria-live="polite" ref={transcriptRef} onScroll={handleTranscriptScroll}>
						{visibleItems.length === 0 && visibleApprovals.length === 0 ? (
							<EmptyTranscript connected={connected} />
						) : null}
						{interleavedTranscript.map(entry => {
							if (entry.kind === "approval") {
								const approval = entry.approval.approval;
								return <ApprovalCard approval={approval} key={approval.id} onResolve={resolveApproval} onResolveHostUri={resolveHostUri} onRespondWorkflowGate={respondWorkflowGate} />;
							}
							const transcriptEntry = entry.item.entry;
							return transcriptEntry.kind === "turn" ? (
								<TurnCard items={transcriptEntry.items} key={transcriptEntry.key} />
							) : (
								<TranscriptCard item={transcriptEntry.item} key={transcriptEntry.item.id} />
							);
						})}
						<div className="transcript__bottom" ref={transcriptBottomRef} aria-hidden="true" />
					</section>
					{showJumpToLatest ? (
						<button className="jump-to-latest neutral-action" type="button" onClick={jumpToLatest}>
							Jump to latest
						</button>
					) : null}
					<form className="composer" onSubmit={submitPrompt} aria-busy={isSubmitting}>
					<label htmlFor="gjc-composer" className="sr-only">Message gajae</label>
						<textarea
							id="gjc-composer"
							ref={composerRef}
							value={composer}
							onChange={event => setComposer(event.target.value)}
							onKeyDown={handleComposerKeyDown}
							disabled={!connected}
							placeholder={
								connected
									? "Ask gajae to edit, inspect, or explain…  (Enter to send · Shift+Enter for newline)"
									: "Reconnect to start chatting."
							}
						/>
						<footer>
							<span className="composer-status">
								{connected ? "" : failureCopy(connection.failure)}
							</span>
							{isSubmitting || transcript.activeTurnId ? (
								<button
									className="neutral-action"
									type="button"
									onClick={() => void stopTurn()}
									disabled={!transcript.activeTurnId}
								>
									Stop
								</button>
							) : (
								<button
									className="primary-action"
									type="submit"
									disabled={!connected || composer.trim().length === 0}
								>
									Submit
								</button>
							)}
						</footer>
					</form>
				</section>
			)}
			<aside className={`app-right-rail ${rightRailCollapsed ? "app-right-rail--collapsed" : ""}`} aria-label="Execution state">
				<button className="right-rail-toggle" type="button" onClick={() => setRightRailCollapsed(current => nextRightRailCollapsed(current, "toggle", window.innerWidth))} aria-expanded={!rightRailCollapsed}>
					{rightRailCollapsed ? "state" : "collapse state"}
				</button>
				{!rightRailCollapsed ? (
					<div className="right-rail__content">
						{goalStatus?.active ? (
							<div className="exec-card" aria-label="Active goal status">
								<strong>Goal</strong>
								<span>{goalStatus.objective ?? "Active goal"}</span>
								<code>{goalStatus.status ?? "active"}</code>
							</div>
						) : null}
						<ExecStateList cards={execCards} />
					</div>
				) : null}
			</aside>
			<CommandPalette
				open={paletteOpen}
				commands={paletteData.commands}
				tools={paletteData.tools}
				loading={paletteData.loading}
				error={paletteData.error}
				onClose={closePalette}
				onInsert={insertPaletteText}
				onAction={handlePaletteAction}
			/>
			{sessionDeleteConfirm ? (
				<ConfirmDialog
					state={sessionDeleteConfirm}
					onCancel={() => setSessionDeleteConfirm(null)}
					onConfirm={() => {
						const sessionPath = sessionDeleteConfirm.sessionPath;
						setSessionDeleteConfirm(null);
						void deleteSession(sessionPath);
					}}
				/>
			) : null}
			{sessionMoveConfirm ? (
				<ConfirmDialog
					state={{ kind: "move", threadId: sessionMoveConfirm.threadId, title: sessionMoveConfirm.plan.targetSessionFile }}
					onCancel={() => setSessionMoveConfirm(null)}
					onConfirm={() => void confirmMoveThread()}
					confirmDisabled={sessionMoveConfirm.plan.conflicts.length > 0}
				>
					<p>Source: {sessionMoveConfirm.plan.sourceSessionFile}</p>
					<p>Target: {sessionMoveConfirm.plan.targetSessionFile}</p>
					<p>Cross device: {sessionMoveConfirm.plan.crossDevice ? "yes" : "no"}</p>
					<p>Artifacts: {sessionMoveConfirm.plan.artifactsDirs.join(", ") || "none"}</p>
					{sessionMoveConfirm.plan.conflicts.length ? <p>Conflicts: {sessionMoveConfirm.plan.conflicts.join(", ")}</p> : null}
				</ConfirmDialog>
			) : null}
			{labelPrompt ? <PromptDialog state={labelPrompt} onCancel={() => setLabelPrompt(null)} onConfirm={value => {
				setLabelPrompt(null);
				labelPrompt.onConfirm(value);
			}} /> : null}
			{localSheet === "help" ? <HelpSheet onClose={() => setLocalSheet(undefined)} /> : null}
			{localSheet === "hotkeys" ? <HotkeysSheet onClose={() => setLocalSheet(undefined)} /> : null}
		</main>
	);
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

function describeFailure(error: unknown): ConnectionState {
	const message = errorMessage(error);
	return { kind: "error", failure: classifyFailure(message), detail: message };
}

function classifyFailure(message: string): FailureKind {
	const lower = message.toLowerCase();
	if (lower.includes("origin") || lower.includes("forbidden")) return "origin-rejected";
	if (lower.includes("token") || lower.includes("unauthorized")) return "token-rejected";
	if (lower.includes("stale")) return "stale-discovery";
	if (lower.includes("crash") || lower.includes("closed") || lower.includes("disconnect")) return "sidecar-crash";
	if (lower.includes("connect") || lower.includes("unavailable") || lower.includes("readyz"))
		return "server-unavailable";
	return "unknown";
}

function errorMessage(error: unknown): string {
	if (error instanceof AppServerResponseError || error instanceof AppServerConnectionError || error instanceof Error)
		return error.message;
	if (typeof error === "string") return error;
	return "Unknown app-server failure";
}

function ConnectionBadge({ connection, modelLabel }: { connection: ConnectionState; modelLabel: string }) {
	const state =
		connection.kind === "connected"
			? "connected"
			: connection.kind === "connecting" || connection.kind === "reconnecting"
				? "reconnecting"
				: "disconnected";
	return (
		<span className={`model-badge model-badge--${state}`}>
			<span className="dot" />
			{modelLabel} · {state}
		</span>
	);
}

function ConnectionErrorPanel({ connection, onReconnect }: { connection: ConnectionState; onReconnect(): void }) {
	return (
		<section className={`connection-error connection-error--${connection.failure ?? "unknown"}`} role="alert">
			<p className="eyebrow">{failureTitle(connection.failure)}</p>
			<h2>{failureCopy(connection.failure)}</h2>
			<p>{connection.detail ?? "The desktop shell has not provided a usable app-server endpoint."}</p>
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
			<h2>Message gajae to start chatting.</h2>
			<p>
				{connected
					? "Just type below and press Enter — a chat starts automatically in a scratch directory. Pick a working directory on the left first if you want a project-scoped chat."
					: "Reconnect to start chatting."}
			</p>
		</section>
	);
}

function SessionSetupPanel({
	connected,
	workingDirectory,
	recentDirectories,
	isPickingDirectory,
	onWorkingDirectoryChange,
	onPickDirectory,
	onStart,
}: {
	connected: boolean;
	workingDirectory: string;
	recentDirectories: string[];
	isPickingDirectory: boolean;
	onWorkingDirectoryChange(value: string): void;
	onPickDirectory(): void;
	onStart(): void;
}) {
	const normalized = normalizeDirectoryInput(workingDirectory);
	const hasInput = workingDirectory.trim().length > 0;
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
					disabled={!connected || isPickingDirectory}
				>
					{isPickingDirectory ? "Picking" : "Browse"}
				</button>
			</div>
			<p className={`cwd-hint ${hasInput && !normalized ? "cwd-hint--error" : ""}`}>
				{hasInput && !normalized
					? "Enter an absolute path or choose a folder."
					: "Optional — leave blank to chat in a scratch directory, or pick a folder for a project-scoped chat."}
			</p>
			{recentDirectories.length > 0 ? (
				<div className="recent-directories" aria-label="Recent directories">
					{recentDirectories.map(directory => (
						<button
							className="recent-directory"
							type="button"
							key={directory}
							onClick={() => onWorkingDirectoryChange(directory)}
						>
							{basename(directory)}
						</button>
					))}
				</div>
			) : null}
			<button className="primary-action" type="button" onClick={onStart} disabled={!connected || !normalized}>
				Start thread
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
	if (status === "running") return "running…";
	if (status === "error") return "error";
	if (status === "interrupted") return "interrupted";
	return undefined;
}

function ReasoningDetails({ item, nested }: { item: TranscriptItem; nested?: boolean }) {
	const running = item.status === "running";
	const reasoning = cleanAssistantText(item.content ?? "");
	return (
		<details className={`message--reasoning message--${item.status}${nested ? " message__reasoning" : " message"}`} open={running}>
			<summary>
				<span className="message__role">{itemLabel(item)}</span>
				<span className="message__hint">{running ? "thinking…" : "reasoning"}</span>
			</summary>
			<div className="markdown markdown--reasoning">{reasoning ? <Markdown text={reasoning} /> : running ? "Thinking…" : "No reasoning captured."}</div>
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
	const placeholder = item.role === "assistant" ? "gajae is responding…" : "Working…";
	return (
		<article className={`message message--${item.role} message--${item.status}`} aria-busy={running}>
			<header>
				<span className="message__role">{itemLabel(item)}</span>
				{pill ? <span className="message__pill">{pill}</span> : null}
			</header>
			{text ? <div className="markdown"><Markdown text={text} /></div> : running ? <p className="message-status">{placeholder}</p> : null}
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
		<article className={`message message--assistant message--${running ? "running" : "completed"}`} aria-busy={running}>
			<header>
				<span className="message__role">gajae</span>
				{pill ? <span className="message__pill">{pill}</span> : null}
			</header>
			{items.map(entry => {
				if (entry.role === "reasoning") return <ReasoningDetails item={entry} nested key={entry.id} />;
				if (entry.role === "tool") return <ToolCard item={entry} nested key={entry.id} />;
				const text = cleanAssistantText(entry.content ?? "");
				return text ? <div className="markdown" key={entry.id}><Markdown text={text} /></div> : null;
			})}
			{running && !hasVisibleText ? <p className="message-status">gajae is responding…</p> : null}
		</article>
	);
}

function ToolCard({ item, nested }: { item: TranscriptItem; nested?: boolean }) {
	const running = item.status === "running";
	const hint = toolHint(item.status);
	const tool = item.tool ?? { name: item.title || itemLabel(item), output: (item.content ?? "").trim() };
	const diff = isEditTool(tool.name, item.title) ? parseDiff(tool.output ?? item.content ?? "") : undefined;
	return (
		<details className={`message message--${item.role} message--${item.status} tool-card${nested ? " tool-card--nested" : ""}`} open={running}>
			<summary>
				<span className="tool-card__icon" aria-hidden="true" />
				<span className="tool-card__title">{tool.name}</span>
				{hint ? <span className="message__hint tool-card__status">{hint}</span> : null}
			</summary>
			<div className="tool-card__sections">
				{tool.args ? <ToolSection label="args" text={tool.args} collapsed /> : null}
				{diff && diff.lines.length > 0 ? <DiffBlock diff={diff} /> : tool.output ? <ToolSection label="output" text={tool.output} /> : null}
				{tool.error ? <ToolSection label="error" text={tool.error} tone="danger" /> : null}
				{!tool.args && !tool.output && !tool.error ? <p className="message-status">{running ? "Running…" : "No output"}</p> : null}
			</div>
		</details>
	);
}

function ToolSection({ collapsed, label, text, tone }: { collapsed?: boolean; label: string; text: string; tone?: "danger" }) {
	const pretty = prettyToolText(text);
	const summary = pretty.split("\n")[0] || label;
	if (collapsed) {
		return (
			<details className={`tool-section ${tone === "danger" ? "tool-section--danger" : ""}`}>
				<summary><span>{label}</span><code>{summary}</code></summary>
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
			<header>diff <span>+{diff.adds} / -{diff.removes}</span></header>
			{diff.truncated ? <details><summary>Show {diff.lines.length} diff lines</summary>{body}</details> : body}
		</section>
	);
}

function isEditTool(name?: string, title?: string): boolean {
	return /(?:^|[-_\s])(edit|write|apply_patch|filechange|file-change)(?:$|[-_\s])/i.test(`${name ?? ""} ${title ?? ""}`);
}

function parseDiff(text: string): ParsedDiff | undefined {
	const raw = text.split("\n").filter(line => /^(?:\+\+\+|---|@@|\+|-|\s|[+-]\d+\|)/.test(line));
	if (raw.length === 0) return undefined;
	let adds = 0;
	let removes = 0;
	const lines = raw.map(line => {
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) return { kind: "context" as const, text: line };
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
	onResolve,
	onResolveHostUri,
	onRespondWorkflowGate,
}: {
	approval: ApprovalGate;
	onResolve(approval: ApprovalGate, approved: boolean): Promise<void>;
	onResolveHostUri(approval: ApprovalGate, ok: boolean, payload?: { content?: string; contentType?: string }): Promise<void>;
	onRespondWorkflowGate(approval: ApprovalGate, answer: JsonValue): Promise<void>;
}) {
	if (approval.kind === "host-uri") {
		return (
			<article className={`hosturi-card hosturi-card--${approval.status}`}>
				<p className="eyebrow">Host URI · {approval.status}</p>
				<h2>{approval.operation.toUpperCase()} {approval.url}</h2>
				<p>gajae requested host access to this URI.</p>
				{approval.content ? <pre>{approval.content}</pre> : null}
				<div className="button-row">
					<button className="primary-action" type="button" disabled={approval.status !== "pending"} onClick={() => void onResolveHostUri(approval, true)}>
						Approve
					</button>
					<button className="neutral-action" type="button" disabled={approval.status !== "pending"} onClick={() => void onResolveHostUri(approval, false)}>
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
		return (
			<article className={`workflow-gate-card workflow-gate-card--${supported ? approval.status : "unsupported"}`}>
				<p className="eyebrow">Workflow gate · {supported ? approval.status : "manual/unsupported"}</p>
				<h2>{approval.gateKind} · {approval.stage}</h2>
				<p>{approval.required ? "Required" : "Optional"} gate awaiting an answer.</p>
				{question ? <p>{question}</p> : null}
				{approval.error ? <p className="message-status">{approval.error}</p> : null}
				{supported && options ? (
					<div className="button-row">
						{options.map(option => (
							<button className="neutral-action" type="button" key={option.label} disabled={approval.status !== "pending"} onClick={() => void onRespondWorkflowGate(approval, option.value)}>
								{option.label}
							</button>
						))}
					</div>
				) : (
					<p className="message-status">This workflow gate schema is not one of the GUI-supported answer shapes. Answer it manually outside the GUI.</p>
				)}
				<pre>{jsonPreview(approval.schema)}</pre>
			</article>
		);
	}

	return (
		<article className={`approval-gate approval-gate--${approval.status}`}>
			<p className="eyebrow">Approval gate · {approval.status}</p>
			<h2>{approval.tool}</h2>
			<p>gajae requested permission to continue this blocked tool action.</p>
			<pre>{jsonPreview(approval.args)}</pre>
			<div className="button-row">
				<button
					className="primary-action"
					type="button"
					disabled={approval.status !== "pending"}
					onClick={() => void onResolve(approval, true)}
				>
					Approve
				</button>
				<button
					className="neutral-action"
					type="button"
					disabled={approval.status !== "pending"}
					onClick={() => void onResolve(approval, false)}
				>
					Reject
				</button>
			</div>
		</article>
	);
}

function ExecStateList({ cards }: { cards: ExecStateCard[] }) {
	const visible = cards.length ? cards : [cardFromRows("exec", "Execution", [], "Open a thread for live state")];
	return (
		<section className="exec-state-deferred" aria-label="Live execution-state surfaces">
			{visible.map(card => (
				<article className={`exec-state-card exec-state-card--${card.status}`} key={card.key}>
					<strong><span className="status-dot" />{card.title}</strong>
					{card.error ? <em>{card.error}</em> : card.lines.map((line, index) => <code key={`${card.key}-${index}`}>{line}</code>)}
				</article>
			))}
		</section>
	);
}

function jsonPreview(value: JsonValue): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function isSupportedWorkflowGate(approval: ApprovalGate): boolean {
	if (approval.kind !== "workflow-gate" || !approval.options?.length) return false;
	if (approval.gateKind === "approval" || approval.gateKind === "execution") return schemaHasAnswerProperty(approval.schema, "decision");
	if (approval.gateKind === "question") return schemaHasAnswerProperty(approval.schema, "selected");
	return false;
}

async function resyncWorkflowGates(client: AppServerClient, threadId: string, setTranscript: (updater: (state: TranscriptState) => TranscriptState) => void): Promise<void> {
	try {
		const result = await client.gjcWorkflowGateList({ threadId });
		setTranscript(state => ({
			...state,
			approvals: mergeWorkflowGateApprovals(state.approvals, threadId, result.gates as Array<Record<string, JsonValue | undefined>>),
		}));
	} catch {
		// Reconnect should still succeed when a pre-contract server lacks gate listing.
	}
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
			approval.kind === "workflow-gate" && approval.id === gateId ? { ...approval, status: "failed", error } : approval,
		),
	};
}

function schemaHasAnswerProperty(schema: JsonValue, property: "decision" | "selected"): boolean {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const record = schema as Record<string, JsonValue | undefined>;
	const properties = record.properties;
	if (properties && typeof properties === "object" && !Array.isArray(properties) && property in properties) return true;
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
	return thread.cwd ? basename(thread.cwd) : threadLabel(thread.title, thread.id);
}

function threadSuffix(id: string): string {
	return id.length > 8 ? id.slice(-8) : id;
}

function normalizeDirectoryInput(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) ? trimmed : "";
}

function basename(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).pop() || normalized || path;
}

function readRecentDirectories(): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(RECENT_DIRECTORIES_KEY) ?? "[]");
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === "string").slice(0, MAX_RECENT_DIRECTORIES)
			: [];
	} catch {
		return [];
	}
}

function rememberDirectory(directory: string, setRecentDirectories: (directories: string[]) => void): void {
	const next = [directory, ...readRecentDirectories().filter(existing => existing !== directory)].slice(
		0,
		MAX_RECENT_DIRECTORIES,
	);
	localStorage.setItem(RECENT_DIRECTORIES_KEY, JSON.stringify(next));
	setRecentDirectories(next);
}

function threadLabel(title: string | undefined, id: string): string {
	const normalized = title?.trim();
	if (normalized && !looksGeneratedThreadTitle(normalized))
		return normalized.length > 64 ? `${normalized.slice(0, 61)}…` : normalized;
	const compactId = id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
	return `Thread ${compactId}`;
}

function looksGeneratedThreadTitle(title: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(title) || title.startsWith("thread-") || title.length > 80;
}

function failureTitle(failure: FailureKind | undefined): string {
	return failure ? failure.replaceAll("-", " ") : "Connection unavailable";
}

function failureCopy(failure: FailureKind | undefined): string {
	switch (failure) {
		case "origin-rejected":
			return "Origin was rejected by the app-server allowlist.";
		case "token-rejected":
			return "The endpoint token was rejected.";
		case "stale-discovery":
			return "The discovery record is stale.";
		case "sidecar-crash":
			return "The sidecar disconnected or crashed.";
		case "server-unavailable":
			return "The app-server is unavailable.";
		default:
			return "The app-server connection is not ready.";
	}
}

function safeEndpoint(endpointUrl: string): string {
	const url = new URL(endpointUrl);
	url.searchParams.delete("token");
	return url.toString();
}
