# RPC SDK — Locked Three-Boundary Topology (Phase 0)

Status: design-locked for execution (ralplan consensus APPROVE). Source spec:
`.gjc/_session-019efc72-b202-7000-9b82-c4dea60e4aee/specs/deep-interview-rpc-sdk-runtime-boundary.md`.

The unified Rust **RPC SDK** is GJC's complete runtime I/O boundary: all runtime
input (control) and output (events, incl. notifications as one stream) cross it.
The original BLOCK in review came from conflating three distinct boundaries. This
document locks them apart.

## The three boundaries

```text
Native TUI process                         Headless daemon process
------------------                         -----------------------
TUI UI code                                External / embedded clients
  | (C) typed in-memory, ZERO serialize      | (A) serialized GjcFrame over UDS
  v                                          v
Rust SDK core (in-process, N-API)          Rust daemon core
  | (C) typed in-memory RuntimePort          | (C) two-lane IPC RuntimePort
  v                                          v
TS agent runtime (same process)            Persistent TS worker (headless only)
(turn loop / providers / tools / skills)   (supervised by Rust daemon)
```

- **Boundary A — external client transport.** UDS, serialized `GjcFrame`,
  capability-authenticated, replayable, backpressured. The only network-facing edge.
- **Boundary B — Rust SDK/daemon core.** One scheduler, one envelope semantics,
  one authz model, one broker model, one replay/backpressure model — shared
  identically by the native and UDS paths.
- **Boundary C — internal Rust↔TS RuntimePort.** Typed **in-memory** for the
  native TUI (no serialization); **two-lane IPC** only for the headless daemon
  worker.

## Invariant

1. Every client-visible frame uses the same `GjcFrame` semantics and generated v1
   payload schemas.
2. Every command flows through the same Rust scheduler + broker logic regardless
   of transport.
3. **The native TUI path MUST NOT serialize runtime commands or events between the
   Rust core and the TS runtime.** If an implementation makes persistent-worker
   IPC mandatory for the native TUI, that is a spec violation requiring an explicit
   requirements change — not a silent acceptance.
4. Only Boundary A (external UDS) and the headless worker leg of Boundary C
   serialize. The native TUI does not serialize runtime I/O end to end.

## Adopted open-confirmation defaults (spec-aligned)

| # | Decision | Default |
|---|----------|---------|
| 1 | Native in-process mechanism | N-API/native binding (`crates/pi-natives` precedent) |
| 2 | Headless internal Rust↔TS port | May serialize (IPC); native path does not serialize |
| 3 | python/gjc-rpc | **Migrate** to a thin UDS reference consumer (not a maintained Python SDK) |
| 4 | Cross-platform | UDS-only; non-unix fails closed; Windows named-pipe out of scope |
| 5 | Capability grants | `.gjc/state/rpc-sdk/grants/<grantId>.json` (0700/0600), local CLI/TUI bootstrap, `all` via admin issuer |
| 6 | Consumer migration order | bridge-client → harness-control-plane → chat clients → python/gjc-rpc |
| 7 | `rpc-socket-security.ts` | Demote/delete after Rust authz reaches parity |

## What ships vs. stays TS

- **Rust core (this effort):** protocol envelope + generated v1 payload schemas,
  scheduler contract, transports (in-process native + UDS), daemon registry/routing,
  capability authz, broker routing, replay, backpressure, redaction, observability,
  daemon supervision.
- **Stays TS (behind the narrow RuntimePort):** turn loop, providers, tools, skills,
  and the current session/workflow-gate/unattended state machines. Moving those into
  Rust is explicit FUTURE work, not this effort.

## Phase 0 gate artifacts

- `docs/rpc-sdk/command-classification-manifest.json` — generated, 38 commands,
  zero unclassified, lanes derived from `rpc-mode.ts` (3 cancellation + 8 safe-read
  fast-lane, 27 ordered).
- `scripts/rpc-sdk/generate-command-manifest.ts` — inventory-extractor PoC; `--check`
  fails CI if the manifest drifts from the authoritative sources.
- `docs/rpc-sdk/runtime-port.md` — native vs headless RuntimePort architecture.
