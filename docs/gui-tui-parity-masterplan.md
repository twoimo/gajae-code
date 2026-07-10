# GUI ⇄ TUI Parity Closure Masterplan

Status: DRAFT — synthesized from 4 architect validation audits (2026-07-07).
Source audits: PaletteParityAudit (G003), SessionModelAudit (G004/G005), ExtExecStateAudit (G006/G007), GuiEmbedUxReview (DESIGN.md/UX). A fifth audit (DeferredApiDesign) failed; its scope is covered by the deferred-row assessments inside the other three.
Supersedes nothing; complements `docs/gui-tui-parity-matrix.md`, which this plan amends (see §6).

## 0. Executive verdict

The matrix's G008-VERIFIED claim is **partially overclaimed**. All method plumbing (server.rs dispatch, schema.rs strict registration, generated client wrappers) is real and drift-free, but several "implemented" rows are functionally hollow, and the GUI is poll-based where the TUI is push-live. Counted across audits:

- **6 blocker-grade (P1) functional holes** on rows marked implemented.
- **~14 major (P2) depth gaps** on implemented rows.
- **~12 MISSING-FROM-MATRIX** TUI capabilities with no row at all.
- **At least 5 deferred rows have stale rationales** — their blockers no longer exist in code.
- GUI embedding: 3 surfaces rated **rough** (command palette, session browser drawer, exec-state/goal), 8 acceptable, 3 polished; 17 DESIGN.md findings.

## 1. P1 blockers — implemented-in-name-only (fix first)

| # | Gap | Evidence | Functional closure |
|---|---|---|---|
| 1.1 | **Resume is hollow.** `thread/resume` of a non-loaded id silently creates a brand-new empty session; historical sessions unreachable from GUI (session browser has no Resume). | `agent-session-host.ts:987-994` (`resumeThread==createThread`); `main.tsx:896-906` | New strict `gjc/session/open { sessionPath }` → `SessionManager.open(path)`, hydrated transcript; Resume button per session-browser row. |
| 1.2 | **Fork is hollow.** `forkThread==createThread`: no ancestry, no branch, no context copy. | `agent-session-host.ts:996-998` | Route fork through `AgentSession.branch`/`forkContextSeed` seeded from source thread + leaf entry; return `forkedFromId` in sessionMetadata. |
| 1.3 | **No live tool-output streaming.** GUI drops `tool_execution_update`; tool cards show args at start, output only at end. TUI streams partial output + nested subagent progress. | `transcript.ts:460-477`; `event_map.rs:276` | Fold `tool_execution_update` in GUI `foldRawEvent` (event already arrives losslessly as raw `gjc/event`); optionally map it in `event_map.rs` for typed clients. |
| 1.4 | **Exec-state is poll-only where TUI is push.** Cards refresh only on `transcript.items.length`; todo flips, background job/monitor transitions between turns are invisible. Server has NO event for job/monitor lifecycle at all. | `main.tsx:234-271`; `jobs-observer.ts:9-13` | (a) GUI subscribes to `todo_reminder`/`todo_auto_clear` raw events today; (b) NEW notification `gjc/jobs/changed { threadId, kind: job\|monitor\|agent, id, status }` emitted from the async-job snapshot owner; refresh on turn boundaries, not per-item. |
| 1.5 | **Command catalog omits skill/extension/file commands**, and the palette's stale local classification map disables 11 implemented commands (host never sets `CommandDescriptor.classification`). | `agent-session-host.ts:834-861`; `command-palette-logic.ts:7-43` | Host enumerates full registry (builtin + file + skill + extension); host sets `classification`; delete GUI stale map. |
| 1.6 | **Extension inspect result discarded** — GUI fetches `gjc/extensions/inspect` and throws the response away; no detail panel. | `main.tsx:375-382`; `extensibility-panel.tsx:4-21` | Store `extensionInspection` in state; render detail pane mirroring plugin inspect. |

Also blocker-grade on the UX side (GuiEmbedUxReview P1s): unstyled `.exec-card` goal surface (`main.tsx:845` — class has no CSS anywhere), undefined CSS vars `--gjc-accent-red`/`--gjc-font-mono` (`session-browser.css:4,19` — session rows get an off-white 3px rail instead of red-claw), no global Escape/interrupt, palette is insert-only (types text instead of executing), duplicated Threads-vs-Sessions IA.

## 2. P2 major depth gaps on "implemented" rows

| Gap | Evidence | Closure |
|---|---|---|
| Session search: substring over truncated title/firstMessage/id vs TUI fuzzy over id/title/cwd/path/allMessagesText | `agent-session-host.ts:1026-1034` vs `session-selector.ts:54-64` | Extend haystack (cwd/path/allMessagesText already computed); port `fuzzyFilter` scoring. |
| Session tree is a read-only `<pre>` dump; TUI /tree is interactive (navigate, labels, filter) | `main.tsx:908-909`; no server navigate method | New `gjc/session/navigate { threadId, entryId, summarize? }` → `AgentSession.navigateTree`; `gjc/session/label { threadId, entryId, label }` → `appendLabelChange`; interactive tree nodes. |
| GUI delete/archive are in-memory only; persisted JSONL survives and reappears in the browser (visibly inconsistent in one screen) | `server.rs:2171-2211`; `selector-controller.ts:1284-1319` | New `gjc/session/delete { sessionPath }` → `deleteSessionWithArtifacts` + confirm dialog; document archive as ephemeral or persist a flag. |
| `scope:"cwd"` uses app-server `process.cwd()`, not the thread's cwd; GUI forced to `scope:"all"` | `agent-session-host.ts:693-697` | Add `cwd?` to `GjcSessionList/SearchParams`; GUI scope toggle (this folder / all). |
| Per-role model assignment + model profiles have no write contract (TUI `/model <target> <model>`) | `builtin-registry.ts:376-458` | New `gjc/model/assign { role, provider, modelId, thinkingLevel? }`. |
| `/provider add` is token-safe by construction (env-var refs only, raw key rejected) but wrongly folded into the OAuth deferral | `builtin-registry.ts:800-840` | New `gjc/provider/add { preset? \| compat+providerId+baseUrl+apiKeyEnv+models[], force? }` with reject-raw-key validation. |
| Connection-level settings/auth/appearance methods bind to "first loaded thread" — Map-order nondeterminism across threads | `agent-session-host.ts:1000-1020` | Pin to process-global owners (`Settings.instance`, connection AuthStorage) or explicit threadId. |
| `gjc/workflowGate/list` + `gjc/hostUriSchemes/set` wrapped but never called → gates lost on reconnect | `client.ts:474-488` | Call `gjcWorkflowGateList` on connect/reconnect to resync pending gates. |
| Theme preview = 6 swatches vs TUI full-UI live preview | `extensibility-panel.tsx:84-109` | Extend `semanticPreview` to full semantic token set; render a sample transcript/tool-card block during preview (still GUI-local; chrome untouched per DESIGN SSOT). |
| Extension descriptor loses shadowed-state, disabled-reason, provider master switches (all read-only in TUI) | `extensions/types.ts:24-61` | Extend `ExtensionDescriptor` with `state`, `disabledReason`, `shadowedBy`, provider grouping. |
| Monitors card lacks cron rows, output tail, failure-ack latch (TUI JobsObserver has all three) | `jobs-observer.ts:118-193` | Read-only: map cron snapshots into jobs/monitors read models; add bounded `outputTail` field. Cancel/delete = new mutating methods (wave 3). |
| `/copy` `/dump` serialize local transcript, never `gjc/messages/get`; `/help` `/hotkeys` palette rows insert text that gets sent to the model as a prompt | `main.tsx:954-958`; palette insert path | Local Help/Hotkeys sheets (display-only); keep local serialization but re-document matrix rows honestly. |
| Lifecycle events unrendered: `auto_retry_*`, `ttsr_triggered`, `notice`, `auto_compaction_end` arrive as raw `gjc/event` and are dropped | `transcript.ts:452-478` | Fold into transcript as inline status blocks (retry countdown, notice line, compaction outcome). |
| Export is clipboard-only, always redacted; TUI HTML export unrepresented; >5MB just errors | `main.tsx:566-575` | Native save dialog (gjc-desktop OS seam); raw export behind explicit confirm; decide HTML in/out of matrix. |
| `/drop` lacks TUI delete-then-new composite; `gjc/auth/status` has zero GUI call sites | `builtin-registry.ts:979-985`; `main.tsx:735-743` | Composite drop action; call authStatus post-logout/reconnect. |

## 3. Stale deferrals — reclassify to in-scope-new

| Row | Stale rationale | Reality | New contract |
|---|---|---|---|
| `/move` workspace | "needs dry-run/rollback design" | Rollback already implemented in `SessionManager.moveTo` (`session-manager.ts:2926-3013`) | `gjc/session/move { threadId, targetCwd, dryRun? }`; dryRun returns `{ sourceSessionFile, targetSessionFile, artifactsDirs, crossDevice, conflicts[] }`; non-dry requires not-streaming, then `flush()+moveTo()`. |
| `/login` OAuth | "interactive callbacks not decoupled" | TUI's `onManualCodeInput` seam (`selector-controller.ts:1370`) is already a poll/complete slot | `gjc/auth/login/start {providerId}` → `{flowId, authUrl, state}`; `poll {flowId}` → redacted `{state, promptMessage?}`; `complete {flowId, redirectUrl}`; `cancel {flowId}`. onPrompt-secret providers return `state:"unsupported"` in v1. Matches `docs/app-server-provider-auth.md` state machine. |
| `/memory` | "no store owner found" | `memory-backend/resolve.ts` + `sdk.ts:1774,2334` exist; ACP handler already drives view/clear/enqueue (`builtin-registry.ts:1094-1157`) | Read + clear + enqueue lane: `gjc/memory/read`, `gjc/memory/clear`, `gjc/memory/enqueue` (redaction policy required; keep write-policy review). |
| skills/extensions enable | "supply-chain review required" | Actual TUI seam is a plain `disabledExtensions` Settings write (`extension-dashboard.ts:175-191`) — no code execution | Split the row: **toggle** = `gjc/extensions/setEnabled { extensionId, enabled }` (+skills equivalent) writing the settings key, catalog-validated, confirm-gated. **Install/marketplace** stays fully deferred pending supply-chain review. |
| plugin setEnabled/setFeature/setSetting | same blanket rationale | `PluginManager` runtime-config write (`manager.ts:382-403`), config-file-only | `gjc/plugins/setEnabled` etc. with secret-masked round-trip rejection + prev-value undo. Marketplace remains deferred. |

Still legitimately deferred: `/btw` (needs `runEphemeralTurn` seam, `agent-session.ts:9499`), goal mutation (no server method; needs confirmation-policy seam), `/contribute-pr` (SCM credential policy absent), plugin marketplace install/uninstall (supply chain).

## 4. Matrix amendments (MISSING-FROM-MATRIX rows to add)

1. Session open/resume-from-history (`gjc/session/open`) — P1.
2. Branch navigation mutation (`gjc/session/navigate`) + tree entry labels (`gjc/session/label`).
3. Persistent session delete (`gjc/session/delete`).
4. Per-role model assignment write + model profiles (`gjc/model/assign`).
5. `/provider add` env-var onboarding (`gjc/provider/add`) — separate from OAuth login row.
6. HTML export — implement or explicitly exclude.
7. Per-directory session scoping (`cwd?` param).
8. Live-update contract rows: `tool_execution_update` streaming, todo live updates, auto-retry progress, ttsr, notice, `auto_compaction_end`, jobs/monitors change notification.
9. Cron jobs in jobs/monitors read models; monitor output tail; failed-job ack latch; monitor cancel/cron delete (deferred-class mutation).
10. Extension shadowed/disabled-reason/provider metadata.
11. Workflow-gate resync-on-reconnect.
12. Extension slash surfaces: `/notify`, `/grok-build-usage`, `/autoresearch`, `/skill:*`, file-based custom commands + `/init`.
13. `/session delete` verb; `/agents` row corrected (TUI command is quarantined, `builtin-registry.ts:1234`).

## 5. Beautiful embedding — GUI blueprint (from GuiEmbedUxReview)

### 5.1 Layout: three-column continuous frame (DESIGN.md grammar)

```
┌────────────┬──────────────────────────────┬─────────────┐
│ Sidebar    │ Transcript (920px max)       │ Right rail  │
│ unified    │ approvals INLINE at blocked  │ 260px,      │
│ session/   │ point; /btw ephemeral strip  │ collapsible │
│ thread     │ above composer               │ ─ goal      │
│ list (tree │──────────────────────────────│ ─ todos     │
│ indent,    │ Composer (sticky, hints:     │ ─ context/  │
│ status     │ Shift+Enter newline, Esc     │   usage     │
│ rails),    │ interrupt)                   │ ─ jobs/     │
│ cwd setup, │                              │   agents/   │
│ connection │   Palette = Cmd/Ctrl+K       │   monitors  │
│ badge      │   overlay, EXECUTES          │ ─ compaction│
└────────────┴──────────────────────────────┴─────────────┘
```

- **Palette as the single command entry point**: rows carry an `action` discriminator — `navigate` (open Model panel, Appearance tab, session browser), `invoke` (compact, retry, new, copy, dump), `insert-prompt` (prompt-display-only rows). Never send `/model ` as chat text.
- **Merge Threads + Sessions** into one list where loaded state is a status dimension (rail/label); tree branches as indentation; all actions (resume/fork/rename/export/delete) per row. Kill the raw `<pre>` tree dump.
- **Exec-state → right rail**, refreshed on turn boundaries (activeTurnId transitions) + push events; never clear populated cards while refreshing (fixes 7-RPC-per-item flicker storm, `main.tsx:240-270`).
- **Model panel split**: catalog/thinking/fast → header model-chip popover; settings/provider-auth → palette-launched settings sheet.
- **ExtensibilityPanel → overlay/right-rail panel**, not a full workspace swap that hides the transcript.
- **Approvals interleaved** into the transcript at the blocked tool call, not appended at the bottom (`main.tsx:975-991`).

### 5.2 Interaction spec (keyboard-first, TUI-parity)

- **Layered global Escape**: overlay → btw strip → queued steer → interrupt running turn (`stopTurn()`); mirrors TUI `app.interrupt`.
- Cmd/Ctrl+K palette (executes), Cmd/Ctrl+N new thread; Enter-while-busy queues via `turn/steer`.
- Roving tabindex on lists/tabs; palette rows get `onClick` activation + `scrollIntoView` on arrow nav; theme preview on activate, not hover/focus.
- Composer hint: "Enter to send · Shift+Enter for newline" (drop Ctrl+Enter-only phrasing).
- Motion: 120ms color/border only; streaming = opacity-only caret.

### 5.3 New components for remaining parity

- **GoalControls** (right rail + header chip) — mutation buttons gated until the goal-mutation seam ships.
- **LoginFlowSheet** — the start/poll/complete/cancel OAuth state machine; browser-open via gjc-desktop; never renders credentials.
- **SkillExtensionToggles** — confirm-gated settings-key toggles (wave 2 contract in §3).
- **BtwSideTurn strip** — dashed, Esc-dismissable, never persisted (gated on the `runEphemeralTurn` seam).
- **HotkeysSheet / HelpSheet** — local static display surfaces (fixes /help //hotkeys prompt-leak).
- **PromptRenameDialog** — replaces `window.prompt`/`window.confirm` with the existing `ConfirmDialog` grammar.

### 5.4 DESIGN.md conformance fixes (mechanical)

- Style `.exec-card` (or reuse `.exec-state-card`); define/repair `--gjc-accent-red`→`--gjc-red-claw` (2px rail) and `--gjc-font-mono`→`--gjc-font-ui`.
- Square `.status-badge` (999px → 4px per radius-pill rule); define `--gjc-success-border/text` tokens; replace `.jump-to-latest` box-shadow with a border.
- Hit targets ≥32px (`.session-actions__button`, model-panel inputs, recent-dir chips).
- Reconcile `--gjc-text-dim` (#a89f93 vs DESIGN's #948b80); remove hardcoded `#2a211c` in palette background.
- Markdown: add pipe-table rendering (monospace-aligned block minimum) + nested lists.
- Thread rows: status as label/dot/rail (not raw string), `[new]` unread state, loading skeleton.
- Drop dead `void restoreAppearancePreview`; split workspace-switcher into real tabs vs action buttons.

## 6. Execution waves

**Wave 1 — Truth & blockers (P1)**
1.1 session/open + Resume; 1.2 real fork; 1.3 tool_execution_update folding; 1.4 event-driven exec-state (+`gjc/jobs/changed`); 1.5 full command catalog + palette dispatcher; 1.6 extension inspect panel; mechanical CSS fixes (§5.4 first two bullets); global Escape; unified session list. Update matrix rows from "implemented" to honest status until fixed.

**Wave 2 — Depth parity (P2) + stale-deferral closures**
All §2 items; `gjc/session/move`, `gjc/auth/login/*`, `gjc/provider/add`, skills/extensions/plugins toggles, `gjc/model/assign`, `gjc/session/delete|navigate|label`, cwd scoping, gate resync, lifecycle-event rendering, settings-owner pinning. Embedding blueprint §5.1–5.3 lands here (right rail, palette dispatcher UX, merged list, approval interleaving, new components except BtwSideTurn/GoalControls mutations).

**Wave 3 — Remaining deferred + polish (P3)**
`/btw` ephemeral seam + strip; goal mutation seam + GoalControls; `/memory` lane; monitor cancel/cron delete; `/contribute-pr`; export save-dialog/HTML decision; affectedRoles real roles; remaining §5.4 polish; marketplace stays deferred.

**Gates per wave (run once at wave end, not per task):** `cargo test -p gjc-app-server`, `cargo clippy`, `bun run check:schemas`, client check+test, GUI check+build+test; matrix updated with per-row evidence; every new method native strict schema-registered `gjc/*` with generated wrapper + unknown-field rejection (banned paths remain banned).

## 7. Invariants (unchanged from matrix scope freeze)

- No raw secrets in GUI state/logs/exports; provider auth = env-var refs + redacted OAuth state machine only.
- Every new backend-affecting method: native Rust, strict-field, schema-registered `gjc/*`; no `gjc/commands/execute`, no TUI-handler replay, no raw request strings.
- DESIGN.md remains the visual SSOT; terminal themes never take over app chrome.
- app-server owns all session/runtime/config state; gjc-desktop is OS integration only.
