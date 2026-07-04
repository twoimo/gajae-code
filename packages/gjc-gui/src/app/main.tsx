import {
	AppServerClient,
	AppServerConnectionError,
	AppServerResponseError,
	type JsonValue,
} from "@gajae-code/app-server-client";
import { invoke } from "@tauri-apps/api/core";
import type { FormEvent } from "react";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../design-tokens/index.ts";
import {
	type ApprovalGate,
	appendLocalUserMessage,
	emptyTranscriptState,
	foldNotification,
	markApproval,
	type TranscriptItem,
	type TranscriptState,
	upsertThread,
} from "./transcript";
import "./styles.css";

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

const RECENT_DIRECTORIES_KEY = "gjc-gui.recentDirectories";
const MAX_RECENT_DIRECTORIES = 8;

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
	const [workingDirectory, setWorkingDirectory] = useState("");
	const [recentDirectories, setRecentDirectories] = useState<string[]>(() => readRecentDirectories());
	const [isPickingDirectory, setPickingDirectory] = useState(false);
	const [isSubmitting, setSubmitting] = useState(false);
	const stopRef = useRef<(() => void) | undefined>(undefined);
	const connectionRef = useRef<ConnectionState>(connection);
	connectionRef.current = connection;

	const connect = useCallback(async () => {
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
			setConnection({ kind: "connected", endpointUrl: endpoint.url });
		} catch (error) {
			setClient(undefined);
			setConnection(describeFailure(error));
		}
	}, []);

	useEffect(() => {
		// Cold desktop launch spawns a bundled sidecar that can take a few
		// seconds to pass readiness; auto-retry a bounded number of times before
		// surfacing a manual Reconnect so the happy path connects unattended.
		let cancelled = false;
		let attempt = 0;
		const maxAttempts = 5;
		const run = async () => {
			while (!cancelled) {
				await connect();
				attempt += 1;
				if (cancelled) return;
				const state = connectionRef.current;
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

	const activeThread = useMemo(
		() => transcript.threads.find(thread => thread.id === transcript.activeThreadId) ?? transcript.threads[0],
		[transcript.activeThreadId, transcript.threads],
	);
	const activeThreadId = activeThread?.id;
	const visibleItems = activeThreadId
		? transcript.items.filter(item => item.threadId === activeThreadId)
		: transcript.items;
	const visibleApprovals = activeThreadId
		? transcript.approvals.filter(approval => approval.threadId === activeThreadId)
		: transcript.approvals;
	const connected = connection.kind === "connected";

	async function startThread() {
		const cwd = normalizeDirectoryInput(workingDirectory);
		if (!client || !cwd) return;
		try {
			const result = await client.threadStart({ source: "gjc-gui", cwd });
			rememberDirectory(cwd, setRecentDirectories);
			setWorkingDirectory(cwd);
			setTranscript(current => upsertThread(current, result.thread, cwd));
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
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function submitPrompt(event: FormEvent) {
		event.preventDefault();
		if (!client || !activeThreadId || composer.trim().length === 0) return;
		const prompt = composer.trim();
		setComposer("");
		setSubmitting(true);
		setTranscript(current => appendLocalUserMessage(current, activeThreadId, prompt));
		try {
			await client.turnStart({ threadId: activeThreadId, text: prompt });
		} catch (error) {
			setConnection(describeFailure(error));
		} finally {
			setSubmitting(false);
		}
	}

	async function stopTurn() {
		if (!client || !activeThreadId || !transcript.activeTurnId) return;
		try {
			await client.turnInterrupt({ threadId: activeThreadId, turnId: transcript.activeTurnId });
		} catch (error) {
			setConnection(describeFailure(error));
		}
	}

	async function resolveApproval(approval: ApprovalGate, approved: boolean) {
		if (!client) return;
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
				<nav className="thread-list" aria-label="Thread list">
					{transcript.threads.length === 0 ? (
						<div className="empty-inline">No threads yet. Connect, then start a thread.</div>
					) : (
						transcript.threads.map(thread => (
							<button
								className={`thread-row ${thread.id === activeThreadId ? "thread-row--selected" : ""} ${thread.status === "error" ? "thread-row--error" : ""}`}
								type="button"
								key={thread.id}
								onClick={() => void resumeThread(thread.id)}
							>
								<span className="thread-title">{threadPrimaryLabel(thread)}</span>
								<span className="thread-meta">
									{threadSuffix(thread.id)} · {thread.status}
								</span>
							</button>
						))
					)}
				</nav>
				<ConnectionBadge connection={connection} modelLabel={transcript.modelLabel} />
			</aside>

			<section className="chat-workspace" aria-label="Chat transcript">
				<header className="chat-header">
					<div>
						<p className="eyebrow">Core chat v1</p>
						<h1>{activeThread ? threadPrimaryLabel(activeThread) : "Connect to GJC app-server"}</h1>
					</div>
					<ConnectionBadge connection={connection} modelLabel={transcript.modelLabel} />
				</header>
				{connection.kind !== "connected" ? (
					<ConnectionErrorPanel connection={connection} onReconnect={() => void connect()} />
				) : null}
				<section className="transcript" aria-live="polite">
					{visibleItems.length === 0 && visibleApprovals.length === 0 ? (
						<EmptyTranscript connected={connected} />
					) : null}
					{visibleItems.map(item => (
						<TranscriptCard item={item} key={item.id} />
					))}
					{visibleApprovals.map(approval => (
						<ApprovalCard approval={approval} key={approval.id} onResolve={resolveApproval} />
					))}
				</section>
				<form className="composer" onSubmit={submitPrompt} aria-busy={isSubmitting}>
					<label htmlFor="gjc-composer">Message GJC</label>
					<textarea
						id="gjc-composer"
						value={composer}
						onChange={event => setComposer(event.target.value)}
						disabled={!connected || !activeThreadId || isSubmitting}
						placeholder={
							connected ? "Ask GJC to edit, inspect, or explain…" : "Reconnect the sidecar before sending."
						}
					/>
					<footer>
						<span className="composer-status">
							{connected ? "Connected over token-bound WebSocket" : failureCopy(connection.failure)}
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
								disabled={!connected || !activeThreadId || composer.trim().length === 0}
							>
								Submit
							</button>
						)}
					</footer>
				</form>
			</section>
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
			<p className="eyebrow">Empty transcript</p>
			<h2>Start a cwd-scoped thread to chat with GJC.</h2>
			<p>
				{connected
					? "Choose a working directory in the session panel to start. Streaming assistant text, tool calls, results, and approvals appear inline here."
					: "Reconnect before starting a cwd-scoped thread."}
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
					: "Manual paths work in browser dev; desktop Browse uses the native picker."}
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

function TranscriptCard({ item }: { item: TranscriptItem }) {
	return (
		<article
			className={`message message--${item.role} message--${item.status}`}
			aria-busy={item.status === "running"}
		>
			<header>
				<strong>{itemLabel(item)}</strong>
				<span>{item.status}</span>
			</header>
			{item.role === "tool" || item.role === "event" ? (
				<pre>{item.content || "Awaiting output…"}</pre>
			) : (
				<p>{item.content || "Streaming…"}</p>
			)}
		</article>
	);
}

function ApprovalCard({
	approval,
	onResolve,
}: {
	approval: ApprovalGate;
	onResolve(approval: ApprovalGate, approved: boolean): Promise<void>;
}) {
	return (
		<article className={`approval-gate approval-gate--${approval.status}`}>
			<p className="eyebrow">Approval gate · {approval.status}</p>
			<h2>{approval.tool}</h2>
			<p>GJC requested permission to continue this blocked tool action.</p>
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

function jsonPreview(value: JsonValue): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function itemLabel(item: TranscriptItem): string {
	if (item.role === "user") return "You";
	if (item.role === "assistant") return "GJC";
	if (item.role === "reasoning") return "Reasoning";
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
