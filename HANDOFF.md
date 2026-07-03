# Handoff — codex-compatible app-server port (`feat/codex-app-server-port`)

Worktree: `/Users/bellman/Documents/Workspace/gjc-app-server`
Branch: `feat/codex-app-server-port` (branched from `dev` @ `a2d306e7`)
Committed: `e54842c8` (43 files, ~6.4k insertions). All app-server work lives here — `dev` is clean.

## Goal
Port openai/codex's **app-server** into gjc as a codex-compatible JSON-RPC 2.0 server, in Rust, embedded in the Bun runtime, driving the current TS `AgentSession` behind an `AgentBackend` seam that is later swappable for a native Rust core. It is intended to **hard-replace** gjc's RPC mode + notifications SDK once all dependents are migrated (Phase 9). Everything so far is **side-by-side**; nothing legacy is deleted yet.

## Architecture (as built)
```
gjc app-server (CLI, --mode app-server)
  └─ TS  packages/coding-agent/src/modes/app-server/
        app-server-mode.ts  → runAppServerMode(): stdin NDJSON ↔ stdout; opt-in WS via GJC_APP_SERVER_WS=1
        host.ts             → startAppServer(host): wires native AppServer ↔ AppServerHost, onCall→resolveCall
        agent-session-host.ts → AgentSessionHost implements AppServerHost; createThread→createAgentSession,
                                 subscribe(events)→emitEvent, backendCall→AgentSession methods
  └─ N-API crates/pi-natives/src/app_server.rs  → napi `AppServer` class:
        constructor(onFrame, onCall), dispatch(conn,line), resolveCall(callId,ok,json),
        emitBackendEvent(threadId,gen,type,payload), listenWs(host,port,token,sessionId,stateRoot)
        (inverted-control: backend/factory calls forwarded to TS via onCall TSFN, resolved via tokio oneshot)
  └─ Rust core crates/gjc-app-server/  (rlib, 78 tests)
        jsonrpc.rs (codex framing, jsonrpc header omitted) · error.rs (codes incl -32001)
        identity.rs (immutable ThreadId + monotonic BackendGeneration + stale-event rejection)
        scheduler.rs (per-thread lanes + Admission overload) · field_policy.rs (lenient codex-core / strict gjc/*)
        item_state.rs (terminal coalescing) · event_map.rs (gjc AgentEvent → codex item/turn frames)
        backend.rs (AgentBackend trait = the seam) · server.rs (dispatcher, thread/turn lifecycle, emit)
        schema.rs + bin/schema.rs (schemars → schemas/app-server.schema.json, wired into check:schemas)
        transport_ws.rs (loopback WS + token handshake + discovery) · discovery.rs
```
Side-by-side clients: harness `app-server-adapter.ts` + `adapter-factory.ts` (`GJC_HARNESS_ADAPTER=app-server`),
`python/gjc-rpc/src/gjc_rpc/app_server.py`, `python/robogjc/src/app_server_worker.py`.

## Verified (green) — commands to reproduce
- `cargo test -p gjc-app-server` → 69 unit + 9 conformance = **78**; `cargo clippy -p gjc-app-server --all-targets` → 0 errors.
- `bun --cwd=packages/natives run build` (regenerates native bindings incl. `AppServer`/`listenWs`).
- `cd packages/coding-agent && bun test test/app-server-host.test.ts` (3), `test/app-server-agent-host.test.ts` (3),
  `test/harness-app-server-adapter.test.ts` (4), `test/harness-adapter-factory.test.ts` (3), `test/app-server-ws-smoke.test.ts` (2).
  NOTE: run these test files **individually** — running several together in one `bun test` invocation hits a bun
  ESM module-cache quirk (`execFile` export error) unrelated to app-server code.
- `cd packages/natives && bun test test/app-server-bridge.test.ts` (6, drives the real native addon).
- `python/gjc-rpc`: `uv run python -m unittest tests.test_app_server` (5). `python/robogjc`: `uv run python -m unittest tests.test_app_server_worker` (1).
- **LIVE turns verified** earlier against a real model (provider creds at `~/.gjc/agent/models.yml`, default `claude-opus-4-8`):
  TS/stdio and Python client both produced `turn/started → item/agentMessage/delta="PONG" → turn/completed`.
  (Verified pre-migration; see "Known issue" — re-verify in this worktree after fixing startup.)

## ⚠️ Known issue to fix FIRST (regression, appeared during the WS-bridge lane)
`bun packages/coding-agent/src/cli.ts --mode app-server` **hangs before printing `{"type":"ready"}`** (process
alive, no stdout/stderr, >100s). Bisection so far:
- `bun cli.ts --version` → instant (global startup fine).
- `bun cli.ts --mode rpc` → emits `{"type":"ready"}` fast (legacy mode fine).
- Minimal in-process `new AgentSessionHost()` + `startAppServer()` + `openConnection()` → instant ("CONSTRUCT_OK").
- So the mode core + native addon load fine; the hang is on the **main.ts path reaching `runAppServerMode`**
  (mode dispatch is in `main.ts` in the `if(mode==="acp"){…} else if(mode==="app-server"){ runAppServerMode() } else {…}`
  chain, which SKIPS `createSession`). `ready` prints before any stdin read, so it should be immediate.
- Appeared after the WS-bridge lane rebuilt the native addon + edited `app-server-mode.ts`/`pi-natives`.
  Suspects to check: whether `main.ts` early init (model-registry/discovery) now blocks for app-server mode;
  whether the rebuilt native addon changed an early-startup native call; whether `app-server-mode.ts` imports
  (`node:crypto` randomBytes) or the WS-opt-in block affect the default (non-WS) path. The live stdio turn
  worked BEFORE this lane, so `git log -p` / diffing `app-server-mode.ts` + `pi-natives/src/app_server.rs`
  against the pre-WS state is the fastest lead.
- Repro: `printf '{"id":1,"method":"initialize","params":{}}\n'; sleep` piped into the mode; expect a `ready`
  line then an initialize response.

## Remaining plan (source of truth: the ralplan plan + ultragoal ledger)
Phases 2–3 largely implemented; Phase 1 core proven live. Outstanding:
- Fix the startup hang above; re-run the live stdio + Python turns in this worktree.
- Phase 4 harness: flip harness to the app-server adapter (`createHarnessRpc`/`GJC_HARNESS_ADAPTER=app-server`) and run the **M10 e2e** (needs a live provider — available).
- Phase 5 python: run the full `gjc-rpc` turn tests against the app-server (live provider).
- Phase 6 robogjc: live e2e — **needs GitHub credentials**.
- Phase 7 notifications daemon: migrate Telegram/Discord/Slack to app-server WS + `gjc/notifications` parity — the generic WS-parity contract can be tested locally (no tokens), but the bundled daemon e2e **needs real Telegram/Discord/Slack bot tokens + a paired chat**.
- Phase 8 codex interop hardening: full smoke **needs the Codex VS Code extension** (protocol-level interop already demonstrated).
- Phase 9 atomic deletion of RPC mode + notifications SDK — only after Phases 4–8 are green; reference-search gated.

## Planning artifacts (bundled in this branch)
`docs/app-server-artifacts/` (see its `README.md`) is self-contained:
- `deep-interview-spec.md` — crystallized spec.
- `ralplan/` — consensus plan (authoritative body `stage-07-revision.md`; final w/ ADR `stage-10-final.md` / `pending-approval.md`) + every planner/architect/critic stage.
- `ultragoal-brief.md` / `ultragoal-goals.json` / `ultragoal-ledger.jsonl` — 10-phase plan, story states, full audit trail.

## Durable state (in the ORIGINAL repo, session 019f1c30)
`/Users/bellman/Documents/Workspace/gajae-code/.gjc/_session-019f1c30-3754-7000-b634-75d54f2dc70c/`:
- `ultragoal/goals.json` (G001 review_blocked, G002–G011 blocked with per-story evidence)
- `ultragoal/ledger.jsonl` (full slice-by-slice audit trail incl. live-turn milestones + this migration)
- `specs/deep-interview-gjc-app-server.md` (crystallized spec)
- `plans/ralplan/.../pending-approval.md` (consensus plan)

## Non-goals (do not do)
`fs/*` and `process/*` protocol families (v2); a real approval/permission gate (gjc auto-approves — approvals are
wire no-ops); a standalone Rust binary independent of Bun; full codex-client feature parity.
