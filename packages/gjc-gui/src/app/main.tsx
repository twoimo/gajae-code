import {
	AppServerClient,
	AppServerConnectionError,
	AppServerResponseError,
	type GjcCommandsListResult,
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
import type { Extension, Plugin, PluginInspection, Skill } from "./extensibility-logic";
import { ExtensibilityPanel } from "./extensibility-panel.tsx";
import { Markdown } from "./markdown.tsx";
import { ModelPanel } from "./model-panel.tsx";
import { SessionActions } from "./session-actions.tsx";
import { markThreadArchived, removeThread } from "./session-actions-logic";
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
import "./styles.css";
import { shouldStickToBottom } from "./scroll-follow-logic";

export type EndpointDescriptor = { url: string; token: string };
type ConnectionKind = "booting" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
type FailureKind =
	| "origin-rejected"
	| "token-rejected"
	| "stale-discovery"
	| "sidecar-crash"
	| "server-unavailable"
	| "unknown";

export type ConnectionState = {
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

type ExtensibilityData = {
	skills: Skill[];
	extensions: Extension[];
	plugins: Plugin[];
	pluginInspection?: PluginInspection;
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
		clipboard: navigator.clipboard,
		storage: localStorage,
		timers: globalThis,
		...overrides,
	};
}

export function createApp(
	_options: { deps?: AppHostDeps; autoConnect?: boolean; initialState?: AppInitialState } = {},
) {
	return <App />;
}

const RECENT_DIRECTORIES_KEY = "gjc-gui.recentDirectories";
const DEFERRED_EXEC_STATE_ROWS = [
	["todos", "Read surface needs a typed app-server API before GUI rendering."],
	["context", "Context usage is not exposed on the GUI seam yet."],
	["usage", "Provider/token usage needs a new typed notification or read API."],
	["jobs", "Job lifecycle cards need new app-server notifications."],
	["agents", "Agent roster/state needs a typed GUI API."],
	["monitors", "Monitor streams need new app-server notifications."],
	["retry", "gjc/retry is not on the current GUI seam."],
] as const;
const MAX_RECENT_DIRECTORIES = 8;
// Default working directory for a scratch/default session when the user has not
// picked one, matching the TUI's tmp-rooted default session.
const DEFAULT_CWD = "/tmp";

const root = typeof document === "undefined" ? null : document.getElementById("root");
if (root)
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
	const [paletteData, setPaletteData] = useState<PaletteData>({ commands: [], tools: [], loading: false });
	const [extData, setExtData] = useState<ExtensibilityData>({
		skills: [],
		extensions: [],
		plugins: [],
		loading: false,
	});
	const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
	const [workingDirectory, setWorkingDirectory] = useState("");
	const [recentDirectories, setRecentDirectories] = useState<string[]>(() => readRecentDirectories());
	const [isPickingDirectory, setPickingDirectory] = useState(false);
	const [isSubmitting, setSubmitting] = useState(false);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
	const copyStatusTimeoutRef = useRef<number | undefined>(undefined);
	const stopRef = useRef<(() => void) | undefined>(undefined);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const transcriptRef = useRef<HTMLElement>(null);
	const transcriptBottomRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);

	const restoreComposerFocus = useCallback(() => {
		requestAnimationFrame(() => composerRef.current?.focus());
	}, []);

	const connect = useCallback(async (): Promise<ConnectionState> => {
		setConnection(current => ({ kind: current.kind === "connected" ? "reconnecting" : "connecting" }));
		try {
			const endpoint = await resolveEndpoint();
			const wsUrl = websocketUrl(endpoint);
			const nextClient = new AppServerClient({ webSocketFactory: url => new WebSocket(url) });
			await nextClient.connect(wsUrl);
			const unsubscribe = nextClient.onNotification(notification => {
				setTranscript(current => foldNotification(current, notification));
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
			return nextConnection;
		} catch (error) {
			setClient(undefined);
			const nextConnection = describeFailure(error);
			setConnection(nextConnection);
			return nextConnection;
		}
	}, [restoreComposerFocus]);

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
		return () => window.clearTimeout(copyStatusTimeoutRef.current);
	}, []);

	useEffect(() => {
		if (stickToBottomRef.current) {
			transcriptBottomRef.current?.scrollIntoView({ block: "end" });
		}
	}, [visibleItems.length, visibleApprovals.length]);
	const connected = connection.kind === "connected";

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
			const [skillsResult, extensionsResult, pluginsResult] = await Promise.all([
				client.gjcSkillsList({ threadId: activeThreadId }),
				client.gjcExtensionsList({ threadId: activeThreadId }),
				client.gjcPluginsList({ threadId: activeThreadId }),
			]);
			setExtData(current => ({
				...current,
				skills: skillsResult.skills,
				extensions: extensionsResult.extensions,
				plugins: pluginsResult.plugins,
				loading: false,
			}));
		} catch (error) {
			setExtData(current => ({ ...current, loading: false, error: errorMessage(error) }));
		}
	}, [activeThreadId, client, connected]);

	const inspectExtension = useCallback(
		async (extensionId: string) => {
			if (!client || !connected || !activeThreadId) return;
			try {
				await client.gjcExtensionsInspect({ extensionId, threadId: activeThreadId });
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[activeThreadId, client, connected],
	);

	const inspectPlugin = useCallback(
		async (pluginId: string) => {
			if (!client || !connected || !activeThreadId) return;
			try {
				const result = await client.gjcPluginsInspect({ pluginId, threadId: activeThreadId });
				setExtData(current => ({ ...current, pluginInspection: result.plugin ?? undefined, error: undefined }));
			} catch (error) {
				setExtData(current => ({ ...current, error: errorMessage(error) }));
			}
		},
		[activeThreadId, client, connected],
	);

	useEffect(() => {
		if (workspaceView === "extensibility") void loadExtensibilityData();
	}, [loadExtensibilityData, workspaceView]);

	useEffect(() => {
		function handleGlobalKeyDown(event: KeyboardEvent) {
			if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
			event.preventDefault();
			setPaletteOpen(current => {
				const next = !current;
				if (next) void loadPaletteData();
				return next;
			});
		}
		window.addEventListener("keydown", handleGlobalKeyDown);
		return () => window.removeEventListener("keydown", handleGlobalKeyDown);
	}, [loadPaletteData]);

	const closePalette = useCallback(() => {
		setPaletteOpen(false);
		restoreComposerFocus();
	}, [restoreComposerFocus]);

	const insertPaletteText = useCallback((text: string) => {
		setComposer(current => current + text);
		restoreComposerFocus();
	}, []);

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
		return result.thread.id;
	}

	// The active model isn't carried on ThreadSummary; read it from session state.
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

	async function refreshSessions(sessionClient = client) {
		if (!sessionClient) return;
		try {
			const result = await sessionClient.threadLoadedList({});
			for (const threadId of result.data) {
				if (transcript.threads.some(thread => thread.id === threadId)) continue;
				try {
					const readResult = await sessionClient.threadRead({ threadId });
					setTranscript(current =>
						current.threads.some(thread => thread.id === threadId)
							? current
							: upsertThread(current, readResult.thread),
					);
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

	async function deleteThread(threadId: string) {
		if (!client) return;
		try {
			await client.threadDelete({ threadId });
			setTranscript(current => ({
				...current,
				activeThreadId: current.activeThreadId === threadId ? undefined : current.activeThreadId,
				threads: removeThread(current.threads, threadId),
				items: current.items.filter(item => item.threadId !== threadId),
				approvals: current.approvals.filter(approval => approval.threadId !== threadId),
			}));
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function submitComposer() {
		if (!client || composer.trim().length === 0 || isSubmitting) return;
		const prompt = composer.trim();
		setSubmitting(true);
		try {
			// ChatGPT-style: auto-create a thread (in the default home dir) on the
			// first message if none is active.
			const threadId = activeThreadId ?? (await ensureActiveThread());
			if (!threadId) {
				setConnection(describeFailure(new Error("Could not resolve a working directory to start a thread.")));
				return;
			}
			setComposer("");
			setTranscript(current => appendLocalUserMessage(current, threadId, prompt));
			await client.turnStart({ threadId, text: prompt });
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
				threads: current.threads.map(thread =>
					thread.id === activeThreadId ? { ...thread, modelLabel: `${provider}/${modelId}` } : thread,
				),
			}));
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

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

	async function resolveHostUri(
		approval: ApprovalGate,
		ok: boolean,
		payload?: { content?: string; contentType?: string },
	) {
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
			} else {
				setTranscript(current =>
					markWorkflowGateFailed(current, approval.id, workflowGateResolutionError(resolution)),
				);
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
		<main className="app-shell">
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
						disabled={!connected || !activeThreadId}
					>
						Skills & extensions
					</button>
				</nav>
				<nav className="thread-list" aria-label="Thread list">
					{transcript.threads.length === 0 ? (
						<div className="empty-inline">No threads yet. Connect, then start a thread.</div>
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
								>
									<span className="thread-title">{threadPrimaryLabel(thread)}</span>
									<span className="thread-meta">
										{threadSuffix(thread.id)} · {thread.status}
									</span>
								</button>
								<SessionActions
									thread={thread}
									disabled={!connected}
									onFork={id => void forkThread(id)}
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
						disabled={!connected || !activeThreadId}
						onApply={applyModel}
					/>
				</details>
				<details className="sidebar-drawer">
					<summary>Execution-state (deferred)</summary>
					<DeferredExecStateList />
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
						loading={extData.loading}
						error={extData.error}
						onRefresh={() => void loadExtensibilityData()}
						onInspectExtension={id => void inspectExtension(id)}
						onInspectPlugin={id => void inspectPlugin(id)}
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
							<button
								className="neutral-action"
								type="button"
								disabled={!connected || !activeThreadId}
								onClick={() => void compactThread()}
							>
								Compact
							</button>
							<button
								className="neutral-action"
								type="button"
								disabled={!canCopyAssistant}
								onClick={() => void copyTranscriptText(lastAssistantCopy)}
							>
								Copy
							</button>
							<button
								className="neutral-action"
								type="button"
								disabled={!canDumpTranscript}
								onClick={() => void copyTranscriptText(transcriptDump)}
							>
								Dump
							</button>
							<span className="copy-status" role="status" aria-live="polite">
								{copyStatus === "copied" ? "Copied" : ""}
							</span>
							<span className="model-chip" title="Active model (change under Model & settings in the sidebar)">
								{transcript.modelLabel || "no model"}
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
							disabled={!connected || isSubmitting}
							placeholder={
								connected
									? "Ask gajae to edit, inspect, or explain…  (Enter to send · Ctrl+Enter for newline)"
									: "Reconnect to start chatting."
							}
						/>
						<footer>
							<span className="composer-status">{connected ? "" : failureCopy(connection.failure)}</span>
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
			<CommandPalette
				open={paletteOpen}
				commands={paletteData.commands}
				tools={paletteData.tools}
				loading={paletteData.loading}
				error={paletteData.error}
				onClose={closePalette}
				onInsert={insertPaletteText}
			/>
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
	const placeholder = item.role === "assistant" ? "gajae is responding…" : "Working…";
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
		<details
			className={`message message--${item.role} message--${item.status} tool-card${nested ? " tool-card--nested" : ""}`}
			open={running}
		>
			<summary>
				<span className="tool-card__icon" aria-hidden="true" />
				<span className="tool-card__title">{tool.name}</span>
				{hint ? <span className="message__hint tool-card__status">{hint}</span> : null}
			</summary>
			<div className="tool-card__sections">
				{tool.args ? <ToolSection label="args" text={tool.args} collapsed /> : null}
				{diff && diff.lines.length > 0 ? (
					<DiffBlock diff={diff} />
				) : tool.output ? (
					<ToolSection label="output" text={tool.output} />
				) : null}
				{tool.error ? <ToolSection label="error" text={tool.error} tone="danger" /> : null}
				{!tool.args && !tool.output && !tool.error ? (
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
	onResolve,
	onResolveHostUri,
	onRespondWorkflowGate,
}: {
	approval: ApprovalGate;
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
				<p className="eyebrow">Host URI · {approval.status}</p>
				<h2>
					{approval.operation.toUpperCase()} {approval.url}
				</h2>
				<p>gajae requested host access to this URI.</p>
				{approval.content ? <pre>{approval.content}</pre> : null}
				<div className="button-row">
					<button
						className="primary-action"
						type="button"
						disabled={approval.status !== "pending"}
						onClick={() => void onResolveHostUri(approval, true)}
					>
						Approve
					</button>
					<button
						className="neutral-action"
						type="button"
						disabled={approval.status !== "pending"}
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
		return (
			<article className={`workflow-gate-card workflow-gate-card--${supported ? approval.status : "unsupported"}`}>
				<p className="eyebrow">Workflow gate · {supported ? approval.status : "manual/unsupported"}</p>
				<h2>
					{approval.gateKind} · {approval.stage}
				</h2>
				<p>{approval.required ? "Required" : "Optional"} gate awaiting an answer.</p>
				{question ? <p>{question}</p> : null}
				{approval.error ? <p className="message-status">{approval.error}</p> : null}
				{supported && options ? (
					<div className="button-row">
						{options.map(option => (
							<button
								className="neutral-action"
								type="button"
								key={option.label}
								disabled={approval.status !== "pending"}
								onClick={() => void onRespondWorkflowGate(approval, option.value)}
							>
								{option.label}
							</button>
						))}
					</div>
				) : (
					<p className="message-status">
						This workflow gate schema is not one of the GUI-supported answer shapes. Answer it manually outside
						the GUI.
					</p>
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

function jsonPreview(value: JsonValue): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
