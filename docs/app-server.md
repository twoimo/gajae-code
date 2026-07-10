# GJC app-server

The GJC app-server is the in-progress, codex-compatible JSON-RPC 2.0 control surface for embedding and driving `gjc` from external apps. It is the replacement path for the deleted legacy external-control surfaces and the notifications SDK once migration is complete: clients should converge on one app-server protocol instead of separately integrating command execution, notification events, and GJC-specific extension hooks.

Status: the Rust protocol core, N-API bridge, TypeScript host seam, JSON Schema generation, and focused conformance tests are implemented. The public `gjc app-server` entrypoint, production transports, and client migrations are still in progress.

## Architecture

The app-server is split into three layers:

1. **Rust core (`crates/gjc-app-server`)** owns the protocol state machine, JSON-RPC framing, connection initialization, thread registry, request dispatch, scheduler/admission checks, event mapping, identity/generation checks, field policy, and schema generation. It is independently testable and does not depend on a JavaScript runtime.
2. **N-API bridge (`crates/pi-natives/src/app_server.rs`)** exposes the Rust core to the Bun/TypeScript runtime through `@gajae-code/natives`. It wires callbacks for backend calls, resolves async calls back into Rust, emits backend events, and exposes connection/dispatch helpers.
3. **TypeScript host (`packages/coding-agent/src/modes/app-server/host.ts`)** adapts the app-server to current `AgentSession` behavior. The host creates, resumes, and forks sessions, routes per-thread backend calls, and sends AgentSession events back through the Rust mapper.

The important seam is `AgentBackend` in the Rust crate. Today the backend is implemented by the TypeScript host driving `AgentSession`; later, the same seam can be satisfied by a native Rust core after the 1:1 port without changing the wire protocol.

## Wire protocol

The wire shape follows codex app-server conventions:

- JSON-RPC 2.0 request/response/notification semantics are used, but the `jsonrpc: "2.0"` header is omitted on the wire.
- A connection must complete `initialize` followed by the client `initialized` notification before normal requests are accepted. `initialize` is the only request allowed before initialization.
- Thread lifecycle is explicit: clients start, resume, fork, read, list loaded, archive, and delete threads. Rust owns the immutable codex thread identity; TypeScript session metadata remains mutable behind the backend seam.
- Turn lifecycle is explicit: clients start a turn, can steer or interrupt it, and receive mapped item/turn frames as backend events stream back into Rust.
- Item lifecycle events are mapped through `ThreadStream`, which coalesces terminal frames and rejects stale events after a backend generation changes.
- Field policy matches the compatibility boundary: codex-core methods are lenient and ignore unknown fields, while namespaced `gjc/*` extension methods are strict and reject unknown fields.
- Approval gates are wire no-ops for GJC because GJC auto-approves; they remain in the protocol surface for compatibility and migration parity, not as a real permission system.
- Backpressure uses JSON-RPC error code `-32001` for overload. Clients should retry with exponential backoff and jitter.

## Method surface

Implemented core lifecycle methods currently include:

- `initialize` and `initialized` for the connection handshake.
- `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/loaded/list`, `thread/delete`, and `thread/archive`.
- `turn/start`, `turn/steer`, and `turn/interrupt`.
- `gjc/state/read`, `gjc/messages/get`, `gjc/model/set`, and `gjc/compact`.

The intended complete surface is broader than the currently wired core:

- **Codex-core lifecycle and streaming:** thread, turn, item, and command/exec-style interaction needed by codex-compatible app clients.
- **GJC extensions:** `gjc/model`, `gjc/compact`, `gjc/state/read`, workflow gate compatibility, host tools, host URI schemes, and notifications parity.
- **Migration parity:** enough method/event coverage to retire legacy control surfaces and the notifications SDK without losing host tools, URI reads, workflow gates, UI responses, cancellation, or state/message queries.

Treat methods listed as implemented above as the current foundation. Treat the remaining command/exec, workflow-gate, host-tool/URI, notifications-parity, and migration coverage as active development until backed by the schema and conformance tests.

## Transports and entrypoint

The target public entrypoint is:

```sh
gjc app-server
```

Planned transports are:

- **stdio JSONL** as the default subprocess transport for local embedded clients.
- **Loopback WebSocket** with discovery metadata and an authentication token for local apps that need a socket transport without exposing a remote service.
- **Unix domain socket** for local platform integrations that prefer filesystem-scoped socket ownership.

These production transports and migrations are in progress. The implemented foundation today is the in-process Rust core plus N-API/TypeScript host wiring used by tests and future entrypoint work.

## Schema generation

The protocol schema is generated from Rust with `schemars`. The `gjc-app-server-schema` binary writes the committed bundle at `schemas/app-server.schema.json`, and the repository `generate-schemas` / `check:schemas` tasks include that binary so schema drift fails the normal schema gate.

The Rust DTOs are the schema source of truth. New protocol methods and events should land in the Rust types first, update `schemas/app-server.schema.json`, and add focused conformance coverage before being documented as implemented.

## Adding a new strict `gjc/*` method

Use `gjc/context/read` as the template for deferred GUI rows that need a new backend API:

1. Define Rust DTOs first in `crates/gjc-app-server/src/protocol.rs`; params use `#[serde(rename_all = "camelCase", deny_unknown_fields)]` and contain only capability-specific fields such as `threadId`.
2. Register every DTO plus a `methodCatalog` row in `crates/gjc-app-server/src/schema.rs`; `schemas/app-server.schema.json` is generated only.
3. Add a dispatch arm and strict handler in `crates/gjc-app-server/src/server.rs`; call `field_policy::enforce`, resolve `BackendCallContext`, and return typed DTOs.
4. Add a capability-specific method to `AgentBackend` in `crates/gjc-app-server/src/backend.rs`; do not route new features through generic command execution, raw request strings, or TUI-handler replay.
5. Classify admission in `crates/gjc-app-server/src/scheduler.rs`; read-only snapshots such as `gjc/context/read` use `Lane::Read`, not the turn/mutating lane.
6. Bridge the backend call in `crates/pi-natives/src/app_server.rs` with a named call such as `readContext` and deserialize into the Rust DTO.
7. Implement the TypeScript host in `packages/coding-agent/src/modes/app-server/agent-session-host.ts` against real `AgentSession` state owners; expose only token-safe/status-safe values and never provider keys, API keys, prompts, or raw logs.
8. Regenerate schema (`cargo run -p gjc-app-server --bin gjc-app-server-schema` or the repo schema task) and regenerate the client (`bun --cwd=packages/gjc-app-server-client run generate`).
9. Update `packages/gjc-app-server-client/src/client.ts` with the request-map entry and wrapper if the generator does not emit wrappers.
10. Add focused tests: Rust conformance for unknown-field rejection, lane classification, catalog/schema registration; client wrapper/drift coverage; and a TypeScript host test with a fake session.
11. Update the parity matrix row with method name, DTO owner, wrapper status, tests, and evidence after the checks pass.
