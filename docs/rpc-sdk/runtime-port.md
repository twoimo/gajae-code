# RPC SDK — RuntimePort Architecture (Phase 0)

The **RuntimePort** (Boundary C) is the narrow seam through which the Rust SDK core
drives and observes the TS agent runtime. It is a *behavioral contract*, not an
implementation detail, and it has two bindings that MUST share identical scheduling
and broker semantics.

## Two bindings

### Native in-process binding (zero serialization)
- The native TUI process loads the Rust SDK core in-process via a native binding
  (N-API, following `crates/pi-natives` precedent).
- The Rust core calls the TS runtime through **typed in-memory APIs**. Commands and
  events are passed as typed objects — never serialized to bytes.
- TS→Rust event callbacks deliver typed objects; the Rust core then applies the same
  envelope semantics, `seq`, replay, broker routing, redaction, and fanout it uses
  for UDS clients.
- No persistent TS worker, no IPC mailbox on this path.

### Headless worker binding (serialized IPC, headless only)
- The Rust daemon supervises a **persistent TS worker** over a two-lane IPC port.
- Serialization is acceptable here because headless is not the locked
  zero-serialization native path.
- Supervision: sanitized env; stdout/stderr separated from the protocol channel;
  health pings; bounded restart policy; graceful drain; **unsafe in-flight,
  non-idempotent work fails the session rather than blind-replaying**.

## Two-lane scheduling contract (both bindings)

Lanes are derived from one generated manifest
(`docs/rpc-sdk/command-classification-manifest.json`):

- **Ordered command lane** — per-session serial chain. All mutating/async commands
  (27 commands: `prompt`, `steer`, `follow_up`, `abort_and_prompt`, `new_session`,
  `set_*`, `cycle_*`, `compact`, `bash`, `export_html`, `switch_session`, `branch`,
  `set_session_name`, `handoff`, `login`, `negotiate_unattended`,
  `workflow_gate_response`, …).
- **Fast-lane control/read lane** — bypasses the ordered chain and MUST be serviced
  while an ordered command awaits:
  - cancellation (3): `abort`, `abort_bash`, `abort_retry`
  - safe synchronous reads (8): `get_state`, `get_session_stats`,
    `get_available_models`, `get_branch_messages`, `get_last_assistant_text`,
    `get_messages`, `get_login_providers`, `get_pending_workflow_gates`

### Rules (preserve `rpc-mode.ts:83-169` exactly)
1. Rust owns scheduling. The ordered lane is a per-session serial chain.
2. The TS RuntimePort MUST service fast-lane messages while ordered work awaits. A
   single FIFO worker mailbox that blocks the fast lane behind ordered work is
   **forbidden** (it would recreate head-of-line blocking the current scheduler
   deliberately avoids).
3. Classification is generated from ONE manifest derived from `RpcCommand` +
   `scopes.ts`. Rust and TS consume the same manifest. CI fails on any command
   missing a scope or lane.
4. The current TS defensive scheduler (`createRpcCommandScheduler`) becomes a
   **divergence-assertion layer only** — it logs and fails tests if scheduling
   violates the manifest; it is never a second behavioral authority.
5. Cancellations and pure synchronous snapshot reads bypass the ordered chain;
   mutating setters stay ordered to prevent arrival-order regressions.

## Why a single manifest

The current repo already shows drift risk: fast-lane membership lives in
`rpc-mode.ts` while scopes live in `scopes.ts`, and tests use separate local command
arrays. Generating one `command-classification-manifest.json` from both sources and
diffing it in CI (`generate-command-manifest.ts --check`) makes the classification a
single source of truth that the Rust scheduler, the TS assertion layer, and the
conformance suite all consume.

## Open items deferred to later phases
- Exact N-API surface for the in-process binding (Phase 2).
- IPC framing/codec for the headless worker port (Phase 3).
- Mapping each lane onto Rust async primitives + backpressure (Phase 2/4).
