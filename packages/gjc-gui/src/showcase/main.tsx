import type { ReactNode } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../design-tokens/index.ts";
import "./showcase.css";

type ToolStatus = "running" | "success" | "error";
type ThreadState = "selected" | "unread" | "error" | "default";
type MessageTone = "user" | "assistant" | "streaming" | "interrupted";
type ApprovalState = "pending" | "focused" | "approved" | "rejected";
type ComposerState = "idle" | "disabled" | "submitting";
type ModelState = "connected" | "reconnecting" | "disconnected" | "degraded" | "offline";

const threads: Array<{ title: string; meta: string; state: ThreadState }> = [
	{ title: "Thread 019f27…b61a", meta: "Claude Sonnet · 3 min ago", state: "selected" },
	{ title: "Origin matrix and token rejection", meta: "Grok Code · unread", state: "unread" },
	{ title: "Generated session id is truncated in chrome", meta: "Paused", state: "default" },
	{ title: "Stale discovery record recovery", meta: "Connection error", state: "error" },
];

const longOutput = `bun --cwd=packages/gjc-gui run check
$ tsc -p tsconfig.json --noEmit
src/showcase/main.tsx: message, tool-card, approval-gate, composer, thread-list, model-badge, connection-error, empty, loading, long-content, focus-states
✓ no protocol DTOs duplicated
✓ design tokens loaded from src/design-tokens
✓ responsive showcase route compiled`;

function App() {
	return (
		<main className="showcase-shell">
			<aside className="sidebar" aria-label="Thread list showcase">
				<div className="brand-lockup">
					<img className="brand-mark" src="/icon.png" alt="" aria-hidden="true" />
					<div>
						<strong>Gajae Code</strong>
						<span>terminal-native showcase</span>
					</div>
				</div>
				<button className="primary-action" type="button">
					New thread
				</button>
				<nav className="thread-list" aria-label="Threads">
					{threads.map(thread => (
						<button className={`thread-row thread-row--${thread.state}`} type="button" key={thread.title}>
							<span className="thread-title">{thread.title}</span>
							<span className="thread-meta">{thread.meta}</span>
						</button>
					))}
				</nav>
				<section className="loading-panel" aria-label="Thread loading state" aria-busy="true">
					<span className="skeleton skeleton-title" />
					<span className="skeleton" />
					<span className="skeleton skeleton-short" />
				</section>
				<ModelBadge state="connected" label="grok-code-fast" />
			</aside>

			<section className="workspace" aria-label="Component states">
				<header className="workspace-header">
					<div>
						<p className="eyebrow">OpenCode × Warp reference pass · component/state harness</p>
						<h1>Warm mono shell vocabulary</h1>
					</div>
					<div className="badge-row">
						<ModelBadge state="connected" label="Claude Sonnet" />
						<ModelBadge state="reconnecting" label="Sidecar reconnecting" />
						<ModelBadge state="disconnected" label="Origin rejected" />
						<ModelBadge state="degraded" label="Grok degraded" />
						<ModelBadge state="offline" label="Local models offline" />
					</div>
				</header>

				<div className="showcase-grid">
					<section className="transcript panel" aria-label="Message states">
						<Message author="You" tone="user">
							Make the GUI feel like a terminal-native GJC shell, not a rounded chat app.
						</Message>
						<Message author="GJC" tone="assistant">
							The shell is one continuous frame: sidebar, transcript, and composer divided by warm hairlines.
							Off-white buttons stay quiet; red-claw appears only as brand and focus signal.
						</Message>
						<Message author="GJC" tone="streaming">
							Streaming response with a stable line box and live caret. Mixed copy wraps safely: 실행 중인 도구
							output stays readable with English identifiers like GJC_APP_SERVER_ALLOWED_ORIGINS.
						</Message>
						<Message author="GJC" tone="interrupted">
							Interrupted stream state: generation stopped after transport closed. Partial output remains visible
							with a labeled recovery action.
						</Message>
						<pre className="code-block" aria-label="Long content state">
							{longOutput}
						</pre>
					</section>

					<section className="panel stack" aria-label="Tool card states">
						<ToolCard
							status="running"
							title="read discovery record"
							detail="Polling /readyz with token redacted"
						/>
						<ToolCard status="success" title="tsc package check" detail="Completed in 1.2s" />
						<ToolCard
							status="error"
							title="connect websocket"
							detail="Rejected unknown Origin with valid token"
						/>
					</section>

					<section className="panel stack" aria-label="Approval and connection states">
						<ApprovalGate state="pending" />
						<ApprovalGate state="focused" />
						<ApprovalGate state="approved" />
						<ApprovalGate state="rejected" />
						<ConnectionError />
					</section>

					<section className="panel stack" aria-label="Empty, loading, focus, and composer states">
						<EmptyState />
						<ThreadListEmpty />
						<Composer state="idle" />
						<Composer state="disabled" />
						<Composer state="submitting" />
						<div className="focus-strip" aria-label="Keyboard focus examples">
							<button type="button">Focused thread action</button>
							<button type="button">Copy tool output</button>
							<button type="button">Reject approval</button>
						</div>
					</section>
				</div>
			</section>
		</main>
	);
}

function Message({ author, children, tone }: { author: string; children: ReactNode; tone: MessageTone }) {
	return (
		<article className={`message message--${tone}`} aria-live={tone === "streaming" ? "polite" : undefined}>
			<header>
				<strong>{author}</strong>
				<span>{tone === "streaming" ? "streaming" : tone === "interrupted" ? "interrupted" : "now"}</span>
			</header>
			<p>{children}</p>
		</article>
	);
}

function ToolCard({ detail, status, title }: { detail: string; status: ToolStatus; title: string }) {
	return (
		<article className={`tool-card tool-card--${status}`} aria-busy={status === "running"}>
			<header>
				<div>
					<strong>{title}</strong>
					<span>{detail}</span>
				</div>
				<span className="status-chip">{status}</span>
			</header>
			<code>{status === "error" ? "JsonRpcError: forbidden Origin" : "gjc app-server --listen ws"}</code>
		</article>
	);
}

function ApprovalGate({ state }: { state: ApprovalState }) {
	const copy = {
		pending: {
			label: "Approval gate · pending",
			title: "Allow sidecar restart?",
			detail:
				"GJC needs to terminate a stale local sidecar process and start a fresh token-bound app-server session.",
			primary: "Approve restart",
			secondary: "Reject",
		},
		focused: {
			label: "Approval gate · focused",
			title: "Focused approval button",
			detail: "Keyboard focus is visible before any destructive restart can be approved.",
			primary: "Approve restart",
			secondary: "Reject",
		},
		approved: {
			label: "Approval gate · approved",
			title: "Restart approved",
			detail:
				"User approved the restart. The blocked transcript step can continue with an auditable decision label.",
			primary: "Approved",
			secondary: "View details",
		},
		rejected: {
			label: "Approval gate · rejected",
			title: "Restart rejected",
			detail: "User rejected the restart. The blocked step remains inline without looking like a transport failure.",
			primary: "Rejected",
			secondary: "Copy reason",
		},
	}[state];

	return (
		<article className={`approval-gate approval-gate--${state}`}>
			<p className="eyebrow">{copy.label}</p>
			<h2>{copy.title}</h2>
			<p>{copy.detail}</p>
			<div className="button-row">
				<button
					className="primary-action"
					type="button"
					autoFocus={state === "focused"}
					disabled={state === "approved" || state === "rejected"}
				>
					{copy.primary}
				</button>
				<button className="neutral-action" type="button">
					{copy.secondary}
				</button>
			</div>
		</article>
	);
}

function Composer({ state }: { state: ComposerState }) {
	const disabled = state === "disabled";
	const submitting = state === "submitting";

	return (
		<form className={`composer composer--${state}`} aria-label={`Composer state · ${state}`} aria-busy={submitting}>
			<label htmlFor={`showcase-composer-${state}`}>
				Composer · {disabled ? "disabled/disconnected" : submitting ? "submitting/stoppable" : "idle"}
			</label>
			<textarea
				id={`showcase-composer-${state}`}
				defaultValue={
					disabled
						? "Disconnected: reconnect the sidecar before sending."
						: submitting
							? "Stop the running response without submitting another prompt."
							: "Summarize the transport blocker and propose the next safe action."
				}
				disabled={disabled}
			/>
			<footer>
				<ModelBadge
					state={disabled ? "offline" : submitting ? "degraded" : "connected"}
					label={
						disabled
							? "Disconnected · send disabled"
							: submitting
								? "Submitting · stop available"
								: "grok-code-fast · 48k"
					}
				/>
				<button
					className={submitting ? "neutral-action" : "primary-action"}
					type={submitting ? "button" : "submit"}
					disabled={disabled}
				>
					{submitting ? "Stop" : "Send"}
				</button>
			</footer>
		</form>
	);
}

function ModelBadge({ label, state }: { label: string; state: ModelState }) {
	return (
		<span className={`model-badge model-badge--${state}`}>
			<span aria-hidden="true" />
			{label}
		</span>
	);
}

function ConnectionError() {
	return (
		<article className="connection-error" role="status">
			<strong>Connection error</strong>
			<p>
				WebView origin is not in the app-server allowlist. Token values are redacted; retry after sidecar readiness
				refresh.
			</p>
			<button className="neutral-action" type="button">
				Retry connection
			</button>
		</article>
	);
}

function EmptyState() {
	return (
		<article className="empty-state">
			<div aria-hidden="true">⌁</div>
			<h2>No messages yet</h2>
			<p>Start with a repository question, resume a thread, or inspect current session status.</p>
		</article>
	);
}

function ThreadListEmpty() {
	return (
		<article className="empty-state empty-state--thread-list" aria-label="Thread list empty state">
			<div aria-hidden="true">∅</div>
			<h2>Thread list empty</h2>
			<p>No local sessions are available yet. Create a thread or reconnect the sidecar to populate this list.</p>
		</article>
	);
}

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing #root element");
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
