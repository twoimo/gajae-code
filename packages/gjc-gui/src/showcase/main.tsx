import type { ReactNode } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../design-tokens/index.ts";
import { CommandPalette } from "../app/command-palette.tsx";
import type { PaletteCommand, PaletteTool } from "../app/command-palette-logic";
import type { Extension, Plugin, Skill } from "../app/extensibility-logic";
import { ExtensibilityPanel } from "../app/extensibility-panel.tsx";
import { Markdown } from "../app/markdown.tsx";
import { ModelPanel } from "../app/model-panel.tsx";
import { ConfirmDialog, SessionActions } from "../app/session-actions.tsx";
import type { ThreadView } from "../app/transcript";
import { cleanAssistantText } from "../app/transcript";
import "./showcase.css";

type ToolStatus = "running" | "success" | "error";
type ThreadState = "selected" | "unread" | "error" | "default";
type MessageTone = "user" | "assistant" | "streaming" | "interrupted";
type ApprovalState = "pending" | "focused" | "approved" | "rejected";
type ExecCardState = "pending" | "approved" | "responded" | "cancelled";
type ComposerState = "idle" | "disabled" | "submitting";
type ModelState = "connected" | "reconnecting" | "disconnected" | "degraded" | "offline";

const showcaseThread: ThreadView = {
	id: "thread-showcase-004",
	title: "Session lifecycle parity",
	status: "idle",
	lastActivity: "idle",
	cwd: "/workspace/gajae-code",
};
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

const paletteCommands: PaletteCommand[] = [
	{
		name: "help",
		source: "core",
		description: "Show command help in the composer.",
		classification: "prompt-display-only",
	},
	{
		name: "hotkeys",
		source: "core",
		description: "Display keyboard shortcuts.",
		classification: "prompt-display-only",
	},
	{
		name: "skill:ralplan",
		source: "skill",
		description: "Insert the planning workflow prompt.",
		classification: "prompt-display-only",
	},
	{
		name: "review-pr",
		source: "extension",
		description: "Needs a future GUI API before execution.",
		classification: "deferred-needs-new-api",
	},
	{
		name: "terminal-attach",
		source: "terminal",
		description: "Terminal-only command unavailable in GUI.",
		classification: "excluded-terminal-only",
	},
];

const paletteTools: PaletteTool[] = [
	{ name: "read", active: true, description: "Inspect files, documents, images, and URLs." },
	{ name: "edit", active: true, description: "Apply anchored text edits." },
	{ name: "browser", active: false, description: "Inactive until activated by tool discovery." },
];

const showcaseSkills: Skill[] = [
	{
		name: "deep-interview",
		source: "bundled",
		description: "Socratic requirements gathering and spec capture.",
		enabled: true,
	},
	{
		name: "ralplan",
		source: "bundled",
		description: "Consensus planning with planner/architect/critic lanes.",
		enabled: true,
	},
	{
		name: "legacy-home-skill",
		source: "user",
		description: "Disabled skill remains visible in read-only catalog.",
		enabled: false,
	},
];

const showcaseExtensions: Extension[] = [
	{ id: "ext.review-pr", name: "Review PR", kind: "workflow", source: "project", status: "active", state: "active" },
	{ id: "ext.ops", name: "Ops runbook", kind: "prompt", source: "user", status: "disabled", state: "disabled" },
];

const showcasePlugins: Plugin[] = [
	{ id: "plugin.github", name: "GitHub", kind: "mcp", source: "project", status: "masked" },
	{ id: "plugin.notify", name: "Notifier", kind: "webhook", source: "user", status: "active" },
];

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
						<Message author="you" tone="user">
							Make the GUI render markdown with compact terminal-native cards.
						</Message>
						<Message author="gajae" tone="assistant" markdown>
							{
								'# Render pass\n\n> TUI parity keeps narrow rails, readable code, and transcript rhythm.\n\n---\n\nThe transcript now supports **bold with `code`**, ~~removed text~~, links like [docs](https://gaebal-gajae.dev), and lists:\n\n- clean assistant text\n- compact tool cards\n- fenced code that scrolls\n\n```ts\nconst status = "tui-parity";\nconsole.log(status);\n```'
							}
						</Message>
						<Message author="gajae" tone="streaming" markdown>
							{
								"Streaming response keeps a stable line box while `GJC_APP_SERVER_ALLOWED_ORIGINS` and Korean copy wrap safely."
							}
						</Message>
						<Message author="gajae" tone="interrupted" markdown>
							{"Interrupted stream state keeps partial **markdown** visible with a quiet recovery label."}
						</Message>
						<Message author="gajae" tone="assistant" markdown>
							{'{"_i":"Calling bash","args":{"command":"pwd"}}'}
						</Message>
						<ReasoningCard />
						<pre className="code-block" aria-label="Long content state">
							{longOutput}
						</pre>
					</section>

					<section className="panel stack" aria-label="Tool card states">
						<ToolCard
							status="running"
							title="read"
							detail="running…"
							args={'{"path":"packages/gjc-gui/src/app/main.tsx"}'}
							output="Reading…"
						/>
						<ToolCard
							status="success"
							title="bash"
							detail=""
							args={'{"command":"bun --cwd packages/gjc-gui test"}'}
							output={longOutput}
						/>
						<ToolCard
							status="error"
							title="connect websocket"
							detail="error"
							args={'{"url":"ws://127.0.0.1:3417"}'}
							error="JsonRpcError: rejected unknown Origin with valid token"
						/>
						<ToolCard
							status="success"
							title="apply_patch"
							detail=""
							args={'{"path":"packages/gjc-gui/src/app/styles.css"}'}
							diff={
								"@@ -1,3 +1,4 @@\n .message {\n-  border-radius: 999px;\n+  border-radius: var(--gjc-radius-sm);\n+  overflow-wrap: anywhere;\n }"
							}
						/>
					</section>

					<section className="panel stack session-actions-showcase" aria-label="Session action lifecycle states">
						<h2>Session lifecycle actions</h2>
						<div className="thread-row thread-row--selected">
							<span className="thread-title">{showcaseThread.title}</span>
							<span className="thread-meta">{showcaseThread.id} · default actions</span>
							<SessionActions
								thread={showcaseThread}
								onFork={() => undefined}
								onArchive={() => undefined}
								onDelete={() => undefined}
							/>
						</div>
						<ConfirmDialog
							state={{ kind: "delete", threadId: showcaseThread.id, title: showcaseThread.title }}
							onCancel={() => undefined}
							onConfirm={() => undefined}
						/>
						<ConfirmDialog
							state={{ kind: "archive", threadId: showcaseThread.id, title: showcaseThread.title }}
							onCancel={() => undefined}
							onConfirm={() => undefined}
						/>
					</section>

					<section className="panel stack model-panel-showcase" aria-label="Model panel states">
						<h2>Model set + deferred surfaces</h2>
						<ModelPanel currentModel="anthropic/claude-sonnet-4" disabled={false} onApply={() => undefined} />
						<ModelPanel currentModel="" disabled={false} onApply={() => undefined} />
						<ModelPanel currentModel="anthropic/" disabled={false} onApply={() => undefined} />
						<ModelPanel currentModel="grok/grok-code-fast" disabled={false} onApply={() => undefined} />
					</section>
					<section className="panel stack" aria-label="Approval and connection states">
						<ApprovalGate state="pending" />
						<ApprovalGate state="focused" />
						<ApprovalGate state="approved" />
						<ApprovalGate state="rejected" />
						<ConnectionError />
					</section>

					<section className="panel stack exec-state-showcase" aria-label="Execution state cards">
						<h2>Execution state cards</h2>
						<div className="button-row">
							<button className="neutral-action" type="button">
								Compact thread
							</button>
						</div>
						<HostUriCard state="pending" operation="read" url="file:///workspace/notes.md" />
						<HostUriCard state="approved" operation="write" url="file:///workspace/report.json" />
						<HostUriCard state="cancelled" operation="read" url="gajae://session/artifact/12" />
						<WorkflowGateCard state="pending" title="approval · ralplan" />
						<WorkflowGateCard state="responded" title="question · deep-interview" />
						<WorkflowGateCard state="cancelled" title="execution · ultragoal" />
						<DeferredExecStateList />
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

					<section className="palette-showcase panel" aria-label="Command palette states">
						<h2>Command palette</h2>
						<div className="palette-showcase__grid">
							<CommandPalette
								open={true}
								commands={paletteCommands}
								tools={paletteTools}
								loading={false}
								onClose={() => undefined}
								onInsert={() => undefined}
							/>
							<CommandPalette
								open={true}
								commands={[]}
								tools={[]}
								loading={true}
								onClose={() => undefined}
								onInsert={() => undefined}
							/>
							<CommandPalette
								open={true}
								commands={[]}
								tools={[]}
								loading={false}
								error="Command catalog unavailable: reconnect the app-server."
								onClose={() => undefined}
								onInsert={() => undefined}
							/>
							<CommandPalette
								open={true}
								commands={[]}
								tools={[]}
								loading={false}
								onClose={() => undefined}
								onInsert={() => undefined}
							/>
						</div>
					</section>

					<section className="extensibility-showcase panel" aria-label="Extensibility catalog states">
						<h2>Skills, extensions, plugins, and terminal appearance</h2>
						<div className="extensibility-showcase__grid">
							<ExtensibilityPanel
								skills={showcaseSkills}
								extensions={showcaseExtensions}
								plugins={showcasePlugins}
								loading={false}
								onRefresh={() => undefined}
								onInspectExtension={() => undefined}
								onInspectPlugin={() => undefined}
							/>
							<ExtensibilityPanel
								skills={[]}
								extensions={[]}
								plugins={[]}
								loading={false}
								onRefresh={() => undefined}
								onInspectExtension={() => undefined}
								onInspectPlugin={() => undefined}
							/>
							<ExtensibilityPanel
								skills={[]}
								extensions={[]}
								plugins={[]}
								loading={true}
								onRefresh={() => undefined}
								onInspectExtension={() => undefined}
								onInspectPlugin={() => undefined}
							/>
							<ExtensibilityPanel
								skills={showcaseSkills.slice(0, 1)}
								extensions={[]}
								plugins={[]}
								loading={false}
								error="Catalog read failed: reconnect the app-server."
								onRefresh={() => undefined}
								onInspectExtension={() => undefined}
								onInspectPlugin={() => undefined}
							/>
						</div>
					</section>
				</div>
			</section>
		</main>
	);
}

function Message({
	author,
	children,
	markdown,
	tone,
}: {
	author: string;
	children: ReactNode;
	markdown?: boolean;
	tone: MessageTone;
}) {
	const text = typeof children === "string" ? cleanAssistantText(children) : undefined;
	if (markdown && text === "") return null;
	return (
		<article className={`message message--${tone}`} aria-live={tone === "streaming" ? "polite" : undefined}>
			<header>
				<strong className="message__role">{author}</strong>
				<span>{tone === "streaming" ? "streaming" : tone === "interrupted" ? "interrupted" : ""}</span>
			</header>
			{markdown && text !== undefined ? (
				<div className="markdown">
					<Markdown text={text} />
				</div>
			) : (
				<p>{children}</p>
			)}
		</article>
	);
}

function ReasoningCard() {
	return (
		<details className="message message--reasoning" open>
			<summary>
				<span className="message__role">thinking</span>
				<span className="message__hint">reasoning</span>
			</summary>
			<div className="markdown markdown--reasoning">
				<Markdown
					text={
						"I checked the transcript stream, then folded tool args and output into one compact card before rendering."
					}
				/>
			</div>
		</details>
	);
}

function ToolCard({
	args,
	detail,
	diff,
	error,
	output,
	status,
	title,
}: {
	args?: string;
	detail: string;
	diff?: string;
	error?: string;
	output?: string;
	status: ToolStatus;
	title: string;
}) {
	return (
		<details
			className={`tool-card tool-card--${status}`}
			aria-busy={status === "running"}
			open={status === "running"}
		>
			<summary>
				<span className="tool-card__icon" aria-hidden="true" />
				<strong>{title}</strong>
				{detail ? <span className="status-chip">{detail}</span> : null}
			</summary>
			<div className="tool-card__sections">
				{args ? <ToolSection label="args" text={args} collapsed /> : null}
				{diff ? <DiffPreview text={diff} /> : output ? <ToolSection label="output" text={output} /> : null}
				{error ? <ToolSection label="error" text={error} danger /> : null}
			</div>
		</details>
	);
}

function ToolSection({
	collapsed,
	danger,
	label,
	text,
}: {
	collapsed?: boolean;
	danger?: boolean;
	label: string;
	text: string;
}) {
	const body = label === "args" ? JSON.stringify(JSON.parse(text), null, 2) : text;
	return collapsed ? (
		<details className={`tool-section ${danger ? "tool-section--danger" : ""}`}>
			<summary>
				<span>{label}</span>
				<code>{body.split("\n")[0]}</code>
			</summary>
			<pre>{body}</pre>
		</details>
	) : (
		<section className={`tool-section ${danger ? "tool-section--danger" : ""}`}>
			<header>{label}</header>
			<pre>{body}</pre>
		</section>
	);
}

function DiffPreview({ text }: { text: string }) {
	const lines = text.split("\n");
	const adds = lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
	const removes = lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
	return (
		<section className="diff-block">
			<header>
				diff{" "}
				<span>
					+{adds} / -{removes}
				</span>
			</header>
			<div className="diff-block__body">
				{lines.map((line, index) => {
					const kind =
						line.startsWith("+") && !line.startsWith("+++")
							? "add"
							: line.startsWith("-") && !line.startsWith("---")
								? "remove"
								: "context";
					return (
						<div className={`diff-line diff-line--${kind}`} key={`${index}-${line}`}>
							<span>{kind === "add" ? "+" : kind === "remove" ? "-" : " "}</span>
							<code>{line.replace(/^[+-]/, "")}</code>
						</div>
					);
				})}
			</div>
		</section>
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

function HostUriCard({ operation, state, url }: { operation: "read" | "write"; state: ExecCardState; url: string }) {
	return (
		<article className={`hosturi-card hosturi-card--${state === "responded" ? "approved" : state}`}>
			<p className="eyebrow">Host URI · {state}</p>
			<h2>
				{operation.toUpperCase()} {url}
			</h2>
			<p>Typed gjc/hostUris request rendered inline with explicit approve/reject state.</p>
			<div className="button-row">
				<button className="primary-action" type="button" disabled={state !== "pending"}>
					Approve
				</button>
				<button className="neutral-action" type="button" disabled={state !== "pending"}>
					Reject
				</button>
			</div>
		</article>
	);
}

function WorkflowGateCard({ state, title }: { state: ExecCardState; title: string }) {
	return (
		<article className={`workflow-gate-card workflow-gate-card--${state === "responded" ? "approved" : state}`}>
			<p className="eyebrow">Workflow gate · {state}</p>
			<h2>{title}</h2>
			<p>Gate answer options stay visible after response/cancel so the transcript remains auditable.</p>
			<div className="button-row">
				<button className="primary-action" type="button" disabled={state !== "pending"}>
					Proceed
				</button>
				<button className="neutral-action" type="button" disabled={state !== "pending"}>
					Revise plan
				</button>
			</div>
		</article>
	);
}

function DeferredExecStateList() {
	const rows = ["todos", "context", "usage", "jobs", "agents", "monitors", "retry"] as const;
	return (
		<section className="exec-state-deferred" aria-label="Deferred execution-state list">
			<strong>Deferred until new API support</strong>
			<ul>
				{rows.map(row => (
					<li key={row}>
						<button type="button" disabled>
							<span>{row}</span>
							<em>
								{row === "retry"
									? "gjc/retry is not on the current seam."
									: "Needs typed app-server API/notification before GUI rendering."}
							</em>
						</button>
					</li>
				))}
			</ul>
		</section>
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

const root = document.querySelector<HTMLElement>("[data-gjc-showcase-root]");

if (!root) {
	throw new Error("Missing showcase root element");
}

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
