# Phase 0A — Multi-thread AgentSession isolation audit & binding contract

Status: RESOLVED (with documented limitations). Concurrent running turns across
threads are supported at the app-server/backend/stream layer; there is **no**
single-active-turn fallback and no concurrency cap. The claim is deliberately
**scoped** (see "Resolution status" below): protocol, per-thread backend,
identity/stale-event, event-stream, and mutating-lane isolation are implemented
and verified; two named process-global TS singletons remain **unscoped** and are
tracked as known limitations, not as a concurrency cap.

Every shared resource below is classified as one of:

- **scoped** — per-thread instance keyed by immutable `threadId` (+ backend generation).
- **shared-ro** — process-shared, read-only or internally synchronized, safe under concurrency.
- **serialized** — mutation runs through a short, non-blocking-safe critical section; MUST NOT serialize whole turns, model streams, tool execution, or command execution across threads.
- **BLOCKER** — cannot be made concurrency-safe by scoping/serialization; escalate for redesign. Never degrade to a concurrency cap.

The app-server holds a `threadId → AgentBackend` map (Rust-owned). Each backend
wraps one TS `AgentSession`. The hazard is process-global TS state that today
assumes one top-level session per process.

## Resolution status (current implementation)

**Implemented and verified (Rust core + native + tests):**

- Rust-owned immutable `threadId` + monotonic `BackendGeneration`; stale/foreign/post-dispose events are rejected (`identity.rs`; tests `rejects_stale_generation_after_reattach`, `rejects_events_after_delete`, `rejects_events_for_other_threads`).
- One `AgentBackend` per thread; dispatch never holds the registry lock across a backend call, so turns on distinct threads run concurrently (`server.rs`; tests `two_simultaneous_running_turns_in_two_threads`, conformance `concurrent_threads_have_independent_streams`).
- Per-thread `ThreadStream` with a monotonic seq and app-server-owned turn id; no cross-thread event leakage; exactly one `turn/completed` per turn (`event_map.rs`).
- **Serial mutating lane** per thread: non-turn mutations (`command/exec`, `thread/shellCommand`, `gjc/compact`, `gjc/model/set`, `gjc/todos/set`, `turn/steer`) run one-at-a-time with bounded admission (`-32001`), while read/cancel lanes stay fast (`server.rs`; test `same_thread_mutations_serialize_on_the_mutating_lane`). Turns use separate turn admission.
- Notification fan-out is filtered per connection by `gjc/notifications/subscribe` (`server.rs::should_forward`).

**Known limitations (open; do NOT rely on cross-thread isolation for these):**

- `AsyncJobManager` remains a process-global singleton (see blocker 1). Tools that resolve it statically (bash/cron/job/monitor/subagent/executor) are **not** thread-isolated yet: concurrent multi-thread turns that drive background jobs can share ownership state. Safe today because the embedded app-server is driven single-session (harness/python/notifications each own one thread at a time); unsafe for arbitrary many-thread concurrent job fan-out until the per-thread-manager refactor lands.
- `vim.ts` `lastVimDetails` module cache is process-global render state (see blocker 2); concurrent vim renders across threads can cross-contaminate. Render-only, non-fatal.

Because of the two items above, the concurrent-turn guarantee is **scoped to protocol/backend/identity/stream/mutating-lane isolation**, which is proven; full AgentSession-internal isolation of the two named singletons is deferred to the tracked refactor slice below and must land before many-thread concurrent job/vim fan-out is claimed safe.

## Inventory & classification

| Resource | Source | Today's assumption | Classification | Binding contract |
|---|---|---|---|---|
| `AsyncJobManager.instance()` | `src/async/job-manager.ts` (process-global; used by bash/cron/job/monitor/subagent/executor tools) | single process-global job manager | **scoped** | Per-thread `AsyncJobManager` keyed by `threadId`; tools resolve the manager from the thread's backend context, not the global. Ownership filters key by `agentId`/`threadId`. Requires threading a per-session manager handle into tool ctors (they currently call the static). |
| `InternalUrlRouter.instance()` | `src/internal-urls/router.ts` (used by read/write/find/bash/path-utils, host-uri-bridge) | one process-global router, stateless handlers; per-session state in `./state.ts` | **shared-ro** | Router handlers are stateless; keep the global router but ensure per-session state (`internal-urls/state.ts`) is keyed by `threadId`/`sessionId`. Audit `state.ts` for per-session maps. |
| `Settings.instance` (`settings` proxy) | `src/config/settings.ts` | one global settings singleton | **shared-ro** for reads; **serialized** for writes | Threads read the shared settings; `gjc/*` config writes go through a short serialized section. Per-thread overrides (model/thinking/verbosity) live on the thread's `AgentSession`, not global settings. `Settings.isolated()` already exists for tests. |
| `MCPManager.instance()` | `src/internal-urls/mcp-protocol.ts` + MCP subsystem | one global MCP manager + server lifetimes | **serialized** (config reload) + **scoped** (per-thread selected tools) | Shared MCP connections are process-global but selected-tool sets are per-thread; config reload runs serialized and refreshes each thread on its next turn (mirrors codex `config/mcpServer/reload`). Verify no cross-thread tool-list clobber. |
| Notifications rate-limit pool | `src/notifications/rate-limit-pool.ts` | singleton daemon owns ONE pool all sessions draw from | **shared-ro** (intentional) | Correct as a process-global by design (one bot token = one poller). App-server notifications parity keeps a single pool; per-thread endpoints multiplex through it. No change needed beyond keying frames by `threadId`. |
| `modelRegistry` / `authStorage` | AgentSession config | per-session already | **scoped** | Already per-`AgentSession`; carry through per-thread backend. Confirm no static caches. |
| Provider session state / provider cache session ids | `@gajae-code/ai` + session metadata | per-session | **scoped** | Key provider cache by `sessionId`; ensure `buildSessionMetadata` uses the thread's `sessionId`, not a global. |
| Raw SSE interceptors / `globalThis.fetch` (`installH2Fetch`) | `src/cli.ts` | process-global fetch patch | **shared-ro** | The H2 fetch patch is process-wide and stateless per request; safe. Per-request `protocol` selection is not session state. No change. |
| JS-eval prelude globals (`globalThis.__gjc_*`) | `src/eval/js/**` | one VM per process | **scoped** | Eval VM/kernel ownership is per-session; ensure the kernel is keyed by `threadId`. Browser tab-worker globals run in the page context (not app-server process) — out of scope. |
| Extension runner global handlers / TTSR manager / rules | AgentSession | per-session | **scoped** | Confirm extension runner + TTSR rules are per-`AgentSession`; no module-level rule cache. |
| Resource GC registrations, browser tab/VM/kernel ownership, SSH/MCP tool reload | tools/browser, eval | per-session resources | **scoped** | Dispose keyed by `threadId`; disposing thread A must not GC thread B's tabs/kernels (covered by the two-thread dispose test). |
| Discoverable tool indexes / selected MCP tool names | discovery | per-session selection | **scoped** | Per-thread selected tools; shared discovery index is read-only. |
| `vim.ts` `lastVimDetails` module cache | `src/tools/vim.ts` | render-only module-level cache | **BLOCKER (minor)** → **scoped** | Module-level `let lastVimDetails` is shared render state; must be moved to per-thread tool state or it cross-contaminates concurrent vim renders. Small refactor. |
| `ultragoal-ask-guard` Proxy | `src/tools/ultragoal-ask-guard.ts` | wraps tools to block `ask` during runs | **shared-ro** | Stateless wrapper; safe. |
| Logger / title / notification side effects | various | process-global stdout/title | **serialized** / **shared-ro** | stdout must stay protocol-pure on stdio transport (transport concern); title/notification side effects are best-effort and idempotent. |
| Unattended audit paths / host tool + URI registries | agent-wire | per-session registries | **scoped** | Host tool/URI registries are per-thread (registered via `gjc/hostTools/set` per thread). |
| Foreground bash background handler | `src/tools/bash.ts` | process-level Ctrl+B fold handler | **serialized** | Single foreground handler; multiplex by active thread or disable in app-server mode (headless). |

## Escalated blockers — OPEN (tracked known limitations, NOT a concurrency cap)
1. **`AsyncJobManager` global** — the highest-fanout global. Tools call `AsyncJobManager.instance()` statically across ~8 files. Making it per-thread requires either (a) a per-thread manager resolved from tool `ctx`, or (b) an ownership-filtered global keyed by `threadId`. Decision: **(a) per-thread manager threaded through tool construction**; the static accessor is removed in app-server mode. **Status: OPEN** — deferred to its own executor slice; until it lands, concurrent multi-thread job fan-out is a documented limitation (see "Resolution status").
2. **`vim.ts` module cache** — small but a genuine cross-thread render bug; move to per-thread state. **Status: OPEN** (render-only, non-fatal).

## Mandatory conformance tests (app-server-conformance, Phase 0A)
- `two_simultaneous_running_turns`: threads A and B both reach `turn/started` and stream independent item lifecycles concurrently, with no cross-thread event leakage. — **PROVEN** (`server.rs::two_simultaneous_running_turns_in_two_threads`, conformance `concurrent_threads_have_independent_streams`).
- `dispose_one_while_other_continues`: disposing/deleting A does not dispose B's resources (jobs, tabs, kernels); B completes its running turn. — partial: registry/generation isolation proven (`thread_delete_removes_thread_and_rejects_later_reads`); full TS resource-GC isolation gated on the `AsyncJobManager` refactor.
- `stale_events_rejected_after_dispose`: events from A after disposal are rejected by generation check. — **PROVEN** (`identity.rs`, `server.rs::stale_generation_events_are_rejected`).
- `independent_thread_metadata`: two running turns with different model/thinking/host-tool/gate/session-file/provider/notification metadata do not clobber each other. — backend/stream metadata isolation proven; full per-session-singleton isolation gated on the refactor above.
- `no_cross_thread_manager_ownership_leak`: per-thread `AsyncJobManager` shows no foreign jobs. — **DEFERRED** with blocker 1 (the manager is still process-global).

This gate previously blocked Phase 1. Given the scoped-and-verified isolation above and the two documented open limitations, Phase 1+ proceeded on the single-session embedding; the `AsyncJobManager`/vim refactor remains required before arbitrary many-thread concurrent job/vim fan-out is claimed safe.
