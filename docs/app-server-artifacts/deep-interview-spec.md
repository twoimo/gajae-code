# Deep Interview Spec: gjc app-server (codex-compatible, Rust)

## Metadata
- Interview ID: 019f1c30-3754-7000-b634-75d54f2dc70c
- Rounds: 13 (+ Round 0 topology, + Restate gate)
- Final Ambiguity Score: 6%
- Type: brownfield
- Threshold: 0.05
- Threshold Source: default
- Status: PASSED (closure-accepted; residual is mechanical protocol mapping deferred to planning)
- Lateral Reviews: 1 (Round 8, progress→refined; researcher/contrarian/simplifier/architect)
- Restated Goal: see Goal

## Goal
Build a new Rust `crates/gjc-app-server` (rlib core + pi-natives N-API wrapper, embedded in-process in the Bun runtime) exposing a **codex-compatible JSON-RPC 2.0 app-server** that **hard-replaces** both gjc's RPC mode and the notifications SDK. It is multi-thread (a `threadId → AgentSession` map in one process), implements codex-core lifecycle (`initialize`/`thread/*`/`turn/*`/`item/*`) plus `command/exec`, and adds namespaced gjc extensions (workflow gates, host tools/URIs, notifications parity, and gjc management methods mirroring current RPC). It is driven today through an `AgentBackend` trait bridged to the TypeScript `AgentSession`, swappable for the native Rust core after the planned 1:1 coding-agent port — without breaking the current TS implementation.

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| Consolidation & migration strategy | active | Hard-replace RPC + notifications SDK | R1 hard-replace; R2 full in-repo migration scope; R7 conflict resolved |
| Rust↔TS integration bridge | active | In-process N-API embedding; AgentBackend seam | R3 model A; R4 seam mirrors AgentSession; native Rust impl later |
| Protocol fidelity & method surface | active | Codex-compatible core + gjc extensions | R5 fidelity C; R6/R7 surface; R9 trim; R12 multi-thread; R13 approvals |
| Transport, CLI entrypoint & lifecycle | active | stdio + WS + unix socket; `gjc app-server` | R10 all transports + entrypoint |
| Crate structure, schema-gen & build/dist | active | rlib + pi-natives wrapper; schema-gen | R11 TS+JSON Schema into existing schema CI |

## Established Facts
1. (R1) App-server **hard-replaces** RPC mode and the notifications SDK; no backward compatibility.
2. (R2) Single-effort scope = ship app-server + delete RPC and notifications SDK + rewrite the harness `GajaeCodeRpc` adapter, Python `gjc-rpc`, `robogjc`, and the notifications (Telegram/Discord/Slack) daemon.
3. (R3) Bridge = model **A**: in-process N-API embedding (core rlib `crates/gjc-app-server` + pi-natives wrapper), drives `AgentSession` via threadsafe callbacks + `AgentEvent` push. Mirrors the `gjc-notifications` rlib + `pi-natives/src/notifications.rs` precedent.
4. (R3) coding-agent is being fully refactored to Rust; app-server abstracts the agent backend behind a seam so the current TS bridge is swappable for a native Rust core later, without breaking the current TS coding-agent.
5. (R4) Seam = **C**: an `AgentBackend` trait that mirrors `AgentSession`'s method surface (not a codex-shaped or RPC-catalog contract). TS-callback impl now; native Rust impl after the 1:1 port. External wire protocol is a separate concern from this internal seam.
6. (R5) Wire protocol = **codex-compatible core** (mirror codex JSON-RPC names/schema for interop) **plus namespaced gjc extensions**.
7. (R7, supersedes R6) v1 surface = codex-core lifecycle (`initialize`, `thread/*`, `turn/*`, `item/*`, interrupt) + `command/exec` + gjc extensions: workflow gates, host tools + host URIs, notifications parity (idle/action_needed/context_update/turn_stream/activity), and namespaced gjc **management** methods mirroring current RPC (model set/cycle/list, compact + auto-compaction, state/read, thinking level, steering/follow-up/interrupt modes, handoff, login/providers, set_todos, get_messages). Codex's own management methods (`model/list`, `config`, `mcpServer*`, `review`, `compact`) are not adopted as codex methods.
8. (R9) Protocol scope trim: keep `command/exec` (bash parity); **defer `fs/*` and `process/*` to v2**.
9. (R10) Transports: stdio JSONL (default; replaces `gjc --mode rpc` spawn), loopback WebSocket + per-session discovery file + token (notifications-daemon parity), unix domain socket with disconnect/reconnect (RPC `--listen` parity). Entrypoint: `gjc app-server` (+ `gjc --mode app-server` alias). All carry JSON-RPC 2.0 frames.
10. (R11) Crate = `crates/gjc-app-server` (rlib core) + pi-natives napi wrapper, shipped via `packages/natives`. Generate **TS + JSON Schema** from the Rust protocol types, wired into gjc's existing `generate-schemas` / `check:schemas` CI drift check.
11. (R12) Thread mapping: v1 is **multi-thread**; app-server keeps a `threadId → AgentSession` map in one process; reuses gjc child-session (`new_session`/`parentSession`) machinery.
12. (R13, revises R8) gjc has **no permission/approval model** (auto-approves everything). v1 approvals = wire-compat no-op: accept codex `approvalPolicy`/approval fields but always auto-approve (effectively `never`); emit no exec/patch approval round-trips. Real human-in-the-loop stays gjc-native via workflow gates + ask tool + notifications `action_needed`.

## Constraints
- Must keep working against the **current TypeScript** `AgentSession` while designed for a future native Rust core.
- `AgentBackend` trait must mirror `AgentSession`'s surface; no hard-coupling to TS-only internals beyond the threadsafe-callback shims.
- Codex-core method names/schema must match codex closely enough for the interop smoke.
- gjc-only methods must be clearly namespaced (e.g. `gjc/model/set`, `gjc/compact`, `gjc/state/read`).
- Reuse existing infra: `pi-natives` N-API + `packages/natives` dist; `generate-schemas`/`check:schemas` CI.

## Non-Goals
- Backward compatibility with existing RPC / notifications SDK contracts (they are deleted).
- `fs/*` and `process/*` methods (deferred to v2).
- Codex management methods as codex-named methods (`model/list`, `config`, `mcpServer*`, `review`, `compact`).
- A real approval/permission gate (gjc auto-approves).
- A standalone Rust binary independent of the Bun runtime (in-process embedding for v1).
- Full codex-client feature parity (interop = basic initialize + thread/turn).
- Realtime, remote-control, marketplace/plugin codex surfaces.

## Acceptance Criteria
- [ ] New app-server passes its own protocol conformance tests (initialize handshake, thread/turn/item lifecycle, approvals-as-no-op).
- [ ] Harness M10 e2e suite passes against the app-server (`GajaeCodeRpc` adapter rewritten).
- [ ] Python `gjc-rpc` + `robogjc` test suites pass against the app-server.
- [ ] Notifications daemon (Telegram/Discord/Slack) works against the app-server end-to-end.
- [ ] Old RPC mode + notifications SDK code fully deleted; no dangling references; `check`/build green.
- [ ] A codex client (e.g. Codex VS Code extension) can drive gjc through the codex-core methods (basic initialize + thread/turn interop smoke).
- [ ] TS + JSON Schema generated from Rust protocol types and green under `check:schemas`.

## Deferrals
- `fs/*` and `process/*` protocol families → v2.
- Native Rust `AgentBackend` implementor → after the 1:1 coding-agent Rust port.
- Convergence Pacing: no min-round floor / score-drop cap / dampening; bidirectional scoring is the pacing mechanism.

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "gjc app-server" already exists | Repo scan | It does not; RPC/notifications/ACP/Coordinator/Bridge are the existing surfaces |
| RPC is vestigial | User question | RPC is live & dogfooded (Python clients, harness, SDK) → valid proxy/replace target |
| Rust binary should be standalone (codex-style) | Bridge analysis | gjc core is TS; standalone would re-invent deleted RPC → in-process N-API embedding |
| TS is the permanent core | User input | coding-agent is being ported to Rust 1:1 → AgentBackend seam mirrors AgentSession |
| Exclude codex mgmt methods | Conflict vs hard-replace | Fold gjc mgmt methods as namespaced extensions so dependents keep function |
| Keep fs/*/process/* for parity | Simplifier panel vs acceptance bar | Deferred to v2; keep command/exec |
| Map codex approvals to gjc permissions | User: gjc has no permissions | Approvals are wire-compat no-ops; HITL = gates/ask/notifications |

## Technical Context
- gjc is a TypeScript/Bun monorepo (Claude Code fork). Agent core: `packages/coding-agent` (`AgentSession`, `AgentEvent`, `runRpcMode`).
- Existing external-control surfaces (all TS): Coordinator MCP, RPC stdio, ACP, Bridge HTTPS.
- Existing Rust: `crates/{pi-natives,pi-shell,pi-ast,pi-iso,gjc-notifications}`; `gjc-notifications` (rlib) is embedded via `crates/pi-natives/src/notifications.rs` (napi `NotificationServer`), shipped through `packages/natives`.
- RPC catalog: `packages/coding-agent/src/modes/rpc/rpc-types.ts` (`RpcCommand`/`RpcResponse`, workflow gates, host tools/URIs, unattended negotiation).
- Dependents to migrate: `packages/coding-agent/src/harness-control-plane/rpc-adapter.ts` (`GajaeCodeRpc`), `python/gjc-rpc`, `python/robogjc`, notifications daemon.
- Reference: openai/codex `codex-rs/app-server` (JSON-RPC 2.0, thread/turn/item, initialize handshake, generate-ts/generate-json-schema).

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| AppServer | core domain | transports, threadMap | hosts many Thread |
| Thread | core domain | id, status, cwd, model | 1:1 AgentSession; has many Turn |
| Turn | core domain | id, threadId, status | has many Item |
| Item | core domain | type (userMessage/agentMessage/reasoning/shellCommand…) | maps from AgentEvent |
| AgentBackend | seam | trait mirroring AgentSession | impl: TS-bridge now, Rust later |
| AgentSession | external (TS) | prompt/steer/bash/getState/events | driven by AgentBackend |
| gjc extension methods | supporting | workflow gates, host tools/URIs, notifications, mgmt | namespaced `gjc/*` |

## Next Step
Recommended: refine with **ralplan** consensus (Planner/Architect/Critic) to resolve the mechanical protocol mapping (codex `item/*` ↔ gjc `AgentEvent`, per-method field shapes, migration sequencing) and produce a phased execution plan. Execution is a separate, explicitly-approved step.
