# RPC SDK — Protocol Spec v1 (Phase 1)

Language-agnostic wire contract for the unified GJC runtime I/O boundary. Any
language can implement a client by following this document; the bundled Rust crate
and TS package are reference implementations of it.

## GjcFrame envelope

Every frame, in either direction, over either transport (in-process or UDS), is a
`GjcFrame`:

```jsonc
{
  "protocolVersion": 1,          // integer; negotiated in hello
  "frameId": "f_01J...",          // unique per frame (ULID/snowflake)
  "sessionId": "019ef...",        // target/source runtime session
  "seq": 1421,                    // per-session monotonic sequence (ordering + replay cursor)
  "direction": "server_to_client", // or "client_to_server"
  "kind": "event",                // top-level category (see Frame kinds)
  "type": "message_update",       // the v1 payload discriminator within kind
  "correlationId": "c_01J...",    // present for request/response + broker pairs
  "replay": false,                // true when this frame is a replayed (not live) frame
  "capabilityScope": "subscribe", // the scope the daemon authorized for this frame
  "payload": { /* generated v1 payload schema for (kind,type) */ }
}
```

- `seq` is per-session and monotonic. Clients order by `seq` and resume with a
  `seq` cursor. `replay: true` distinguishes replayed history from live frames.
- `correlationId` binds a response/broker-result frame to its originating request.
- `payload` is a **generated v1 payload schema** — never a free-form blob and never
  an indefinite legacy wrapper (see `runtime-io-inventory.json`).

## Frame kinds (`kind`)

Mirrors `AgentWireFrameType` plus the control/notification surfaces folded in:

| kind | direction | purpose |
|------|-----------|---------|
| `ready` | s→c | server accepted the connection / per-client readiness |
| `hello` | both | capability + version negotiation |
| `command` | c→s | a runtime control command (the 38 RpcCommand types) |
| `response` | s→c | direct response to a `command` (correlated) |
| `event` | s→c | an `AgentSessionEvent` (the 24 agent_events) |
| `ui_request` | s→c | extension-UI request (correlated) |
| `permission_request` | s→c | permission prompt (correlated) |
| `host_tool_call` | s→c | host-tool invocation (correlated) |
| `host_uri_request` | s→c | host-URI request (correlated) |
| `workflow_gate` | both | workflow-gate prompt (s→c) and reply (c→s) |
| `notification` | both | notification action lifecycle + threaded frames |
| `reset` | s→c | sequence reset / resubscribe required |
| `error` | s→c | parse/validation/transport error |

The exhaustive `type` set within each kind is enumerated in
`docs/rpc-sdk/runtime-io-inventory.json` (90 items v1) and is the conformance
inventory Phase 5 asserts coverage against.

## Negotiation (`hello`)

1. Client opens transport and sends `hello` with the same camelCase payload shape used by the Rust and TypeScript SDKs:
   `{ protocolVersion: 1, requested: [{ session, redaction }], grantId? }`.
   `requested` contains the session subscriptions and redaction policy requested for each session.
   Resume/replay is not a client command; reconnecting clients keep their last `{ sessionId, seq }` cursor and the daemon drives server-side replay when a subscription is resumed.
2. Server replies with a `ready` frame of type `hello_accepted`:
   `{ sessions: <accepted subscription count> }`.
3. Wrong-version, expired-grant, or denied-subscription handshakes fail with an error frame before any session side effects or event frames flow.

## Versioning & stability contract

- `protocolVersion` is a single integer for the whole boundary. v1 is the first
  stable surface.
- **Additive within a major:** new optional payload fields and new `type` values may
  be added in a minor revision; clients MUST ignore unknown `type`/fields
  (forward-compat, mirroring the existing `Unknown` tolerance in protocol.rs).
- **Breaking → new major:** removing a frame `type`, renaming a discriminator,
  changing scheduler/causality semantics, or weakening authz requires a major
  version bump and regenerated conformance fixtures.
- The v1 payload schemas are generated artifacts (see Phase 5 codegen); hand-editing
  generated payload types is prohibited.

## Transport binding (same contract, two transports)

- **In-process (native TUI):** `GjcFrame` values are passed as typed in-memory
  objects — no serialization. `frameId`/`seq`/`correlationId` and all semantics are
  identical to UDS.
- **UDS (external/headless):** length-delimited JSON `GjcFrame` frames over a private
  unix-domain socket. Authentication and authorization per `authz.md`.

The logical frame stream is identical across both; Phase 5 conformance replays the
same vectors over `in_process` and `uds` and asserts logical equality after
transport normalization (frame ids / timestamps normalized).
