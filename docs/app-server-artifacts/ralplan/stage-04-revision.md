# Revision 4 execution plan: crates/gjc-app-server

## Summary
Build crates/gjc-app-server as a Rust rlib plus crates/pi-natives app_server N-API wrapper. It embeds a codex-compatible JSON-RPC 2.0 app-server in the current Bun process, drives TypeScript AgentSession through an AgentBackend trait, and hard-replaces old RPC mode plus notifications SDK only after every dependent is migrated and proven green. This revision adds blocking Phase 0 gates for multi-thread AgentSession isolation, command scheduling and TSFN flow control, identity semantics, Rust-derived schemas, Codex v1 field matrix, and a tested item lifecycle state machine.

## RALPLAN-DR
Principles: 1. Codex compatibility is a wire protocol boundary; AgentBackend mirrors AgentSession, not Codex internals. 2. Rust owns protocol, transports, registry, schemas, command scheduling, identity, and event normalization; TypeScript owns current agent behavior until the native Rust core exists. 3. Multi-thread support is not assumed safe until Phase 0 audits singleton process state and either scopes, serializes, or caps it. 4. Build side-by-side, migrate live dependents, prove named suites green, then delete legacy surfaces atomically. 5. Preserve GJC-only fidelity through namespaced gjc methods and notifications while emitting canonical Codex core lifecycle events.

Decision drivers: 1. Codex clients must pass a pinned v1 smoke for initialize, thread, turn, item, approvals no-op, and command/exec. 2. The TS/Rust bridge must be flow-controlled, generation-tokened, and stale-event-safe. 3. Migration must be rollback-safe until the final deletion gate.

Viable options and decisions:
| Decision | Option A | Option B | Decision |
|---|---|---|---|
| Protocol source of truth | Rust derives generate TS and JSON Schema. Pro: future Rust core ready and check:schemas detects drift. Con: generator setup. | TS/Python primary and hand-port Rust. Pro: faster sketch. Con: duplicate truth. | Rust protocol types are source of truth and Phase 0 blocks until wired. |
| Event mapping | Tested Rust state machine with accumulators. Pro: deterministic Codex item lifecycle. Con: more upfront work. | Ad hoc tables and raw forwarding. Pro: quick. Con: interop risk. | Rust item lifecycle state machine, plus gjc raw-detail preservation. |
| Multi-thread model | Audit and scope/serialize/cap unsafe globals. Pro: safe v1 semantics. Con: may reduce concurrency. | Assume AgentSession is isolated. Pro: fast. Con: hidden clobber bugs. | Phase 0 blocking isolation audit decides per resource. |
| Migration sequence | Side-by-side then atomic delete after named suites. Pro: rollback-safe. Con: temporary duplicate code. | Big bang. Pro: shorter. Con: high blast radius. | Side-by-side until all dependents pass; deletion is atomic. |
| Session ownership | Rust immutable threadId plus TS mutable session metadata. Pro: stable Codex identity. Con: token bookkeeping. | TS sessionId as threadId. Pro: simple. Con: switch/resume break identity. | Rust threadId is immutable; sessionId/sessionFile are metadata. |
| Callback threading | Tokio lanes plus N-API TSFN with bounded queues. Pro: non-blocking and cancellable. Con: boilerplate. | Synchronous JS callbacks. Pro: simple. Con: deadlocks. | Async TSFN with explicit failure handling and overload rejection. |

## In scope and out of scope
In scope: crates/gjc-app-server rlib; pi-natives AppServer wrapper; JSON-RPC handshake and framing; pinned Codex v1 subset; namespaced gjc management, workflow gates, host tools, host URIs, and notifications parity; Rust-owned multi-thread registry; per-thread scheduling lanes; stdio, WS, and Unix socket transports; Rust-derived TS and JSON Schema; migrations for harness, python/gjc-rpc, python/robogjc, and notifications daemon; final deletion of old RPC and notifications SDK.

Out of scope: fs methods, process methods, real permission approval gates, standalone Rust binary independent of Bun, full Codex experimental parity, native Rust AgentBackend before the separate Rust core port, backward compatibility for old RPC or notifications SDK after deletion.

## Blocking Phase 0 design gates

### Multi-thread AgentSession isolation audit and binding contract
Phase 0 must enumerate every process-global or singleton touched by a top-level AgentSession and classify it before multi-thread execution is enabled. Required inventory includes AsyncJobManager.instance and ownership filters, MCPManager ownership and server lifetimes, modelRegistry and authStorage, settings storage mutations, active skills and visible skill state under .gjc session state, workflow gate registry and ask answer sources, provider session state and provider cache session ids, raw SSE interceptors, extension runner global handlers, TTSR manager and rules, resource GC registrations, browser tab and VM/kernel ownership, SSH or MCP tool reload state, discoverable tool indexes, selected MCP tool names, auto-retry and auto-compaction settings, environment variables used to suppress notifications or PTY behavior, logger and title/notification side effects, unattended audit paths, host tool and URI registries, foreground bash background handler, and any module-level caches discovered during implementation.

Binding contract per audited resource: choose one of per-session scoped, process-shared read-only, serialized global, or v1 concurrency cap. Per-session scoped resources must key by immutable codex threadId or TS sessionId plus backend generation. Serialized global resources must run through an app-server global lane with documented head-of-line behavior. If any unsafe singleton cannot be scoped or serialized safely, v1 must cap concurrently active running turns to one while still allowing multiple loaded threads and read operations. This cap must be explicit in protocol capabilities and tests.

Mandatory tests in named suite app-server-conformance: two threads start in one process; thread A runs a long turn or command while thread B reads state; disposing or deleting thread A does not dispose B resources; B can continue a turn after A disposal; stale events from A after disposal are rejected; process-global managers show no cross-thread ownership leak. Add a second test where two loaded threads use different model/thinking/session metadata and neither clobbers the other. This gate blocks Phase 1.

### Per-thread scheduling and TSFN flow control
Each ThreadHandle owns a scheduler mirroring the old RPC serial-chain plus fast-lane design. Mutating lane is serial and ordered: turn/start, turn/steer when it changes state, thread/name/set, model setters, thinking setters, queue mode setters, compact, handoff, login, host tool registration, host URI registration, todos set, session switch, branch, and destructive thread operations. Cancel fast lane bypasses the mutating queue: turn/interrupt, command/exec/terminate, bash abort, retry abort, backend dispose. Read fast lane bypasses the mutating queue but snapshots live state: thread/read, thread/loaded/list, gjc/state/read, gjc/messages/get, model list, session stats, branch messages, last assistant text, pending workflow gates. Cross-thread operations may run independently only after the isolation audit marks their resources scoped or safe.

Inbound request admission must check per-connection and per-thread bounded queues before accepting a turn. If capacity is unavailable, reject before calling TS with JSON-RPC error code -32001 and message Server overloaded; retry later. Once turn/start is accepted and a turn id is returned, core lifecycle events for that turn are non-droppable. Optional gjc debug/detail events may be coalesced or dropped only when documented and never before raw detail needed by migrated clients.

TSFN flow control: every callback includes threadId, backendGeneration, requestId, method, payload, and cancellation token. TSFN enqueue failure before TS accepts work returns a JSON-RPC error and does not mutate Rust state. TSFN failure after work acceptance marks the active turn failed, emits error and turn/completed failed, and schedules backend health teardown if the failure is fatal. Dropped JS promises, panic conversion, timeout, or malformed callback response are explicit error variants in app-server-conformance. Cancellation must call TS abort and resolve idempotently even if terminal events race.

### Identity model and lifecycle semantics
Rust owns immutable codex threadId. TS sessionId and sessionFile are mutable metadata on ThreadHandle. Every backend attachment has a monotonically increasing backendGeneration. All callbacks from Rust to TS and all emitBackendEvent calls from TS to Rust include threadId and backendGeneration. Rust rejects stale events when threadId is unknown, generation mismatches, thread is deleted, or event seq is older than the current backend attachment. Rejected stale events are counted and optionally emitted as gjc/internal/staleEvent in debug mode, never as Codex lifecycle.

Semantics: thread/start creates a new immutable threadId and generation 1. thread/resume creates or reattaches a backend for a stored TS session while preserving the requested codex threadId only if it is a resume of the same app-server thread; otherwise it returns a new threadId with session metadata pointing to the resumed session. thread/fork always returns a new threadId and generation 1 with forkedFromId. thread/switch through gjc/session/switch changes TS sessionId/sessionFile metadata and increments backendGeneration but does not change codex threadId. thread/delete marks terminal deleted, aborts active work, increments generation, disposes backend, removes registry entry after terminal events flush, and rejects further requests except idempotent delete/read tombstone if implemented. thread/unload disposes backend and increments generation while preserving persisted metadata; later resume attaches a new generation. thread/archive requires no active turn and marks persisted state archived. thread/unsubscribe affects only the connection subscription and never changes identity.

### Rust-derived TS and JSON Schema gate
Phase 0 blocks until Rust protocol types derive JSON Schema and generate TypeScript declarations, and root generate-schemas plus check:schemas invoke the generator. The generator must cover JSON-RPC envelopes, errors, initialize, thread methods, turn methods, item union, command/exec, approvals no-op fields, and gjc extension DTOs. Sample-frame schema validation is part of app-server-conformance: initialize request/response, thread/start, turn/start with accepted and rejected fields, item agentMessage delta, command/exec streaming output, gjc state read, notifications action_needed, and error -32001. check:schemas is a named acceptance suite in every phase after Phase 0.

## Pinned Codex v1 method and field matrix
The implementation pins a v1 subset. Fields not listed as accepted or projected are rejected with invalid params for v1, not silently ignored, except unknown initialize opt-out method names which Codex accepts and ignores.

| Method | Accepted fields | Projected fields | Rejected or deferred fields | Result and status semantics |
|---|---|---|---|---|
| initialize | clientInfo name/title/version, capabilities experimentalApi, optOutNotificationMethods, mcpServerOpenaiFormElicitation | client metadata stored for logs; opt-out suppresses exact notifications | duplicate initialize; non-object params | returns userAgent, codexHome-compatible path, platformFamily, platformOs, capabilities; requires initialized before other calls |
| initialized | no params | connection ready | before initialize or duplicate weirdness follows conformance decision | notification only |
| thread/start | cwd, model, approvalPolicy, sandbox legacy field, permissions, ephemeral, sessionStartSource, client metadata, runtimeWorkspaceRoots if absolute | cwd/model to TS session options; approvalPolicy accepted as no-op never; sandbox/permissions projected to metadata only | fs/process permissions, environments, selectedCapabilityRoots, MCP/plugin experimental fields unless later explicitly supported | returns Thread with id, status idle or running, path null when ephemeral, turns empty initially; emits thread/started |
| thread/resume | threadId or session metadata, cwd/model overrides allowed as in start | attach backend generation to stored session | unknown persisted Codex-only rollout fields | returns loaded Thread; emits thread/started or status/changed |
| thread/fork | threadId, lastTurnId optional, ephemeral, cwd/model overrides | forkedFromId and copied GJC history | in-progress lastTurnId, excludeTurns until pagination implemented | new Thread id, forkedFromId set, emits thread/started |
| thread/list | cursor, limit, archived, cwd, searchTerm minimal | filters where session manager supports | unsupported experimental filters return invalid params | page of Threads with nextCursor nullable |
| thread/loaded/list | none | Rust registry | params rejected | loaded thread ids |
| thread/read | threadId, includeTurns | messages converted to items where possible | unsupported item pagination | Thread with current metadata and optional turns |
| thread/unsubscribe | threadId | remove connection subscription | unknown thread returns not found | empty result |
| thread/name/set | threadId, name | AgentSession.setSessionName | empty name invalid | empty result plus thread/name/updated |
| thread/archive/delete | threadId | persisted session archive/delete where implemented | active turn delete first aborts or rejects per conformance; archive active rejects | empty result and lifecycle notification |
| turn/start | threadId, input text/images, clientUserMessageId, model/cwd overrides, approvalPolicy, sandboxPolicy, permissions, expectedTurnId optional | prompt input; model/cwd projected if supported; approval fields no-op | realtime, environments, selectedCapabilityRoots, unsupported collaboration fields | if expectedTurnId is present and active turn differs, reject conflict; returns Turn id/status inProgress after admission; emits user item then turn/started |
| turn/steer | threadId, input, clientUserMessageId, expectedTurnId optional | AgentSession.steer | no active turn, non-steerable active turn, expectedTurnId mismatch | returns active turnId |
| turn/interrupt | threadId, turnId | AgentSession.abort | mismatched turn id not found or conflict | empty result; terminal turn status interrupted |
| thread/compact/start | threadId, customInstructions | AgentSession.compact | active incompatible operation rejects | returns empty immediately or accepted operation; streams contextCompaction |
| thread/shellCommand | threadId, command, cwd optional | AgentSession.executeBash with thread context | process-style tty/write/resize fields | commandExecution item with inProgress then completed/failed |
| command/exec | command array or shell command string per chosen schema, cwd absolute, env, timeoutMs, outputBytesCap, streamStdoutStderr, tty if supported | native or AgentSession executeBash excludeFromContext | process/spawn, arbitrary process lifecycle, fs operations | if streaming, outputDelta uses base64 and stream stdout/stderr when available, otherwise combined stdout; final result has exitCode, stdout, stderr or aggregatedOutput and cap flags |
| approvals | approvalPolicy, approval fields on turn/start and thread/start | accepted and stored as metadata; always auto-approved | server-initiated requestApproval round trips not emitted | no blocking approval requests; request response to unknown approval id is already resolved or not found |

Codex interop smoke definition: over stdio first, then WS or UDS where available, a client sends initialize, receives response, sends initialized, sends thread/start with cwd and approvalPolicy never, receives thread/started, sends turn/start with a simple text prompt and optional expectedTurnId absent, observes item/started userMessage, turn/started, item/started agentMessage, zero or more item/agentMessage/delta, item/completed agentMessage, turn/completed status completed, then command/exec echo-style command with base64 output or final stdout. Smoke asserts no approval request is emitted and schemas validate every frame.

## Rust item lifecycle state machine
Replace table-only mapping with a tested Rust ItemLifecycleStateMachine in event_map.rs. Inputs are BackendEvent, BackendToolEvent, direct command/exec chunks, and synthetic user input. Outputs are ordered JSON-RPC notifications plus final Turn state.

State per ThreadHandle: activeTurn optional, turn status, item accumulators by itemId, contentIndex map for assistant text/thinking/tool blocks, sequence number, pending terminal events, raw gjc detail ring buffer, and opt-out set per connection. Item states: New, Started, Streaming, Completing, Completed, Failed, Interrupted. Turn states: Idle, Accepted, Started, Completing, Completed, Failed, Interrupted. Terminal coalescing rule: only one turn/completed per turn; message_end, turn_end, agent_end, abort, and backend errors race into a terminal latch. The first terminal cause wins by priority failed over interrupted over completed unless a later backend error arrives before terminal flush.

Ordering rules: text_start creates or validates an agentMessage item; text_delta requires a started item and monotonically ordered contentIndex stream; out-of-order delta becomes gjc/raw detail plus warning and either buffers until gap fills or fails conformance-defined strict mode. thinking_start creates reasoning item unless redacted; redacted thinking creates a reasoning item with summary placeholder only when safe, otherwise raw detail only. tool_execution_start creates commandExecution/fileChange/mcpToolCall or gjc/tool item based on classifier. steer interleaving during active turn synthesizes a userMessage item tied to the same turn and does not complete the turn. compaction interleaving creates contextCompaction item and does not swallow the active assistant terminal. abort interleaving marks active items interrupted or failed according to stopReason and emits turn/completed interrupted once.

Mandatory fixtures in app-server-conformance: assistant text content-index ordering; redacted thinking omitted from raw content; command output before tool start is buffered or rejected deterministically; abort during tool execution; auto-compaction during idle and during turn; steer while assistant is streaming; message_end then agent_end coalesces one turn/completed; backend error after message_start fails item and turn; raw gjc detail preserved for every consumed AgentEvent under gjc/event or debug frame; opt-out suppresses only exact matching Codex notifications, not internal state transitions.

## AgentBackend trait design and TS callback wiring
Trait surface remains AgentSession-shaped and async. Required groups: identity metadata; prompt, steer, follow_up, abort, new_session, fork; get_state, get_messages, get_session_stats; set_todos, host tools, host URI schemes; model and thinking methods; steering, follow-up, interrupt mode setters; compact, auto-compaction, auto-retry, bash exec and abort; export_html, switch_session, branch, branch messages, last assistant text, set_session_name, handoff; login providers and login; workflow gate operations; notification parity operations; subscribe to events; dispose.

Factory methods: create_thread, resume_thread, fork_thread return a backend handle plus TS session metadata. Every method receives BackendCallContext with threadId, backendGeneration, requestId, deadline, cancellation token, and call lane. Every response includes generation echo. A mismatch is fatal to the call and triggers stale callback handling.

Rust owns AppServerState, ThreadRegistry, ConnectionRegistry, SchedulerRegistry, identity, active-turn state, item state machine, subscription sets, and transport backpressure. TS owns AgentSession objects and converts callbacks to method calls. TS must not maintain authoritative thread identity; it may maintain a map keyed by Rust threadId and generation to AgentSession.

N-API AppServer exposes constructor, onCreateThread, onResumeThread, onForkThread, onBackendCall, start, stop, emitBackendEvent, and test hooks for queue saturation. Callback registration before start is mandatory. TSFN enqueue failure before acceptance returns an error without mutating state. TSFN failure after acceptance finalizes the turn as failed. stop is idempotent and drains non-droppable lifecycle events before resolving or timing out.

## Crate and module layout
crates/gjc-app-server contains lib.rs, error.rs, ids.rs, jsonrpc.rs, protocol/codex.rs, protocol/gjc.rs, protocol/notifications.rs, backend.rs, server.rs, session_map.rs, scheduler.rs, identity.rs, dispatch.rs, item_state.rs, event_map.rs, exec.rs, schema.rs, transports/framing.rs, transports/stdio.rs, transports/ws.rs, transports/unix.rs, discovery.rs, and tests. pi-natives adds app_server.rs and exports AppServer types through packages/natives generated files. TypeScript adds modes/app-server/app-server-mode.ts and agent-backend.ts. Shared old agent-wire code may be reused only if renamed or factored away from RPC semantics before deletion.

## Transports
Stdio JSONL is default for app-server and must keep stdout protocol-pure. Loopback WS writes a private discovery file under .gjc/state/app-server with host, port, token, pid, protocol version, stale flag, createdAt, and capabilities; token handshake is required on connect; stale records are cleaned by pid liveness and TTL; logs use redacted tokens only. Unix socket uses websocket upgrade over a local socket and supports disconnect/reconnect. Reconnect clients resync through thread/read, thread/loaded/list, and gjc/messages/get. All transports share the same JSON-RPC dispatcher and scheduling lanes.

## Notifications parity acceptance
Notifications migration is accepted only when app-server WS discovery and token handshake work, and the daemon receives parity frames for idle, action_needed, context_update, turn_stream, and activity. Inbound client frames must support user_message with images and config_command. Pending ask replay is required for late or reconnected clients. Reply handling must preserve first-valid-reply-wins, idempotency keys, rejected duplicate or stale replies, and terminal action_resolved only after real TS gate resolution. Reconnect must replay session_ready, identity/context as needed, and pending ask if unresolved. Telegram, Discord, and Slack e2e each must cover connect, action_needed, valid reply, duplicate reply, turn_stream, activity, context_update, inbound user_message, config command, disconnect, reconnect, and stale endpoint cleanup.

## Schema generation approach
Phase 0 implements Rust-derived JSON Schema and TypeScript generation and wires root generate-schemas and check:schemas. Generated artifacts are checked in under schemas and package type outputs as selected by implementation. Sample-frame validation lives in app-server-conformance and must validate initialize, initialized, thread/start, turn/start, item delta, command/exec outputDelta and final, gjc state read, gjc notifications action_needed, and -32001 overload error. check:schemas is run at every phase gate and before deletion.

## Rollback-safe migration and deletion sequencing
Build side-by-side first. Existing --mode rpc and NotificationServer remain until migrated dependents are green. Each dependent migration lands with an app-server path and tests proving parity. Rollback before Phase 9 is reverting the dependent to old RPC/notifications path because legacy code still exists. Phase 9 is the only non-rollback-compatible step and is gated by named green suites.

Deletion set in Phase 9: CLI rpc and rpc-ui modes or legacy aliases, runRpcMode dispatch, packages/coding-agent/src/modes/rpc, RpcClient exports and SDK types, old docs/rpc references, Python legacy client protocol code, robogjc references to --mode rpc, native NotificationServer and NotificationControlServer exports, crates/gjc-notifications SDK protocol/server/lifecycle/discovery/control/actions when no longer factored, notifications SDK docs, old tests, old env names unless intentionally retained as app-server aliases, and dead shared agent-wire compatibility names. Each deletion substep has a reference-search gate for dangling refs: runRpcMode, RpcCommand, RpcResponse, rpc-client, --mode rpc, rpc-ui, GJC_HARNESS_RPC_COMMAND if renamed, NotificationServer, NotificationControlServer, gjc-notifications, notifications-sdk, docs/rpc, python gjc_rpc legacy frame names. Reference-search results must be empty or have an explicit keep rationale in the deletion PR.

## Phased execution plan and named acceptance gates

### Phase 0A blocking: isolation, identity, scheduler, schema, and Codex matrix
Deliverables: singleton isolation audit document in repo docs or crate design tests; binding contract implemented in types; scheduler design with serial mutating lane, cancel fast lane, read fast lane; identity model with immutable threadId, mutable session metadata, backendGeneration tokens; Rust schema and TS generation wired to generate-schemas/check:schemas; pinned Codex v1 method/field matrix encoded as tests; item lifecycle state machine skeleton with fixtures.

Acceptance: app-server-conformance passes Phase 0 fixtures for schema validation, initialize errors, overload pre-admission, stale event rejection, two-thread dispose-one-continue, and item state machine fixture set. check:schemas passes. build:native compiles N-API skeleton. No product dependent migration starts until this phase is green.

### Phase 1: core runtime and TS AgentBackend
Dependencies: Phase 0A green. Implement backend trait and factory, ThreadRegistry, TS app-server mode, CLI app-server entrypoint, initialize, initialized, thread/start, thread/resume, thread/fork minimal, thread/read, thread/loaded/list, turn/start, turn/steer, turn/interrupt, subscription opt-out, and core event state machine for userMessage, agentMessage, reasoning, terminal turns.

Acceptance: app-server-conformance core lifecycle suite passes; codex interop smoke minimal passes over stdio; check:schemas passes; build:native passes; focused coding-agent app-server tests pass. Two concurrent loaded threads obey the Phase 0 isolation decision.

### Phase 2: gjc extensions, command execution, workflow gates, host tools and URIs
Implement gjc management methods mirroring old RPC catalog, unattended negotiation, workflow gate list/respond with validation/audit, host tool and URI registration plus request/update/result/cancel frames, command/exec, thread/shellCommand, commandExecution item streaming with base64/multiplexing policy, approvals no-op, compaction, retry, todo, notice, thinking, and goal gjc events.

Acceptance: app-server-conformance extension suite passes; command/exec suite passes; host tool/URI round-trip suite passes; workflow gate suite passes; check:schemas passes; build:native passes. No harness migration until state read, messages get, host tools, and turn lifecycle are green.

### Phase 3: transports and discovery
Implement production stdio, loopback WS discovery/token/private file/stale cleanup/health checks, Unix socket reconnect, transport-level backpressure, reconnect resync, and token redaction.

Acceptance: app-server-conformance transport suite passes over stdio, WS, and UDS where supported; notifications-discovery suite passes WS discovery and token handshake; codex interop smoke passes over stdio and one local socket transport; check:schemas and build:native pass.

### Phase 4: harness migration
Rewrite harness-control-plane adapter to spawn app-server and speak JSON-RPC while preserving HarnessRpc. Single-flight acceptance becomes turn/start response plus turn/started or gjc/agent/start after cursor, with idle and empty-queue pre-state from gjc/state/read.

Acceptance: harness adapter unit suite passes; harness M10 e2e passes against app-server; app-server-conformance regression passes; check:schemas passes. Old RPC remains available for rollback until Phase 9.

### Phase 5: Python gjc-rpc migration
Replace legacy Python client with app-server JSON-RPC client and generated protocol types. Parse codex turn/item notifications and gjc detail notifications. Preserve high-level Python API names where useful but not legacy wire compatibility.

Acceptance: python gjc-rpc tests pass; app-server-conformance regression passes; check:schemas passes. Add tests for initialize, thread/start, turn/start, command/exec, state read, workflow gates, host tools, reconnect, and unknown notification fallback.

### Phase 6: robogjc migration
Update robogjc worker to spawn app-server, initialize, start or resume threads from session_dir metadata, register GitHub host tools through gjc/hostTools/set, drive tasks with turn/start and turn/steer, preserve sync worker.run_task model, credential redaction, audit writes, and per-issue serialization.

Acceptance: robogjc tests pass; bun run test:py passes python/gjc-rpc and robogjc together; robogjc integration smoke passes when env is available; host tool audit tests cover validation failure and happy path; check:schemas passes. Old RPC remains for rollback.

### Phase 7: notifications daemon migration
Move Telegram, Discord, and Slack clients to app-server WS discovery and gjc/notifications parity. Implement action lifecycle semantics, inbound user_message and config commands, reconnect replay, and lifecycle control.

Acceptance: notifications e2e passes for Telegram, Discord, and Slack with WS discovery file plus token handshake, idle, action_needed, context_update, turn_stream, activity, inbound user_message, config command, pending ask replay, first-valid-reply-wins, idempotent terminal resolution, duplicate reply rejection, reconnect, and stale cleanup. app-server-conformance notification suite and check:schemas pass.

### Phase 8: Codex interop hardening
Run the pinned Codex interop smoke and expand negative tests for pre-init, duplicate init, unknown methods, malformed params, expectedTurnId mismatch, unsupported fields rejection, overload, opt-out, no approvals request, abort races, and command/exec streaming. Validate sample frames against schema.

Acceptance: codex interop smoke passes; app-server-conformance full suite passes; check:schemas passes; build:native passes. Architect review should re-check the method matrix and state machine fixtures before deletion.

### Phase 9: atomic legacy deletion
Only after Phases 4 through 8 are green, delete old RPC mode, RPC SDK exports, RpcClient, legacy Python protocol code, robogjc RPC references, notifications SDK, native NotificationServer exports, gjc-notifications SDK crate or unfactored modules, obsolete docs and tests. Apply reference-search gates after each deletion chunk.

Acceptance: reference-search deletion gate has no dangling refs or explicit keep rationales; harness M10 e2e passes; python gjc-rpc tests pass; robogjc tests pass; notifications e2e passes; codex interop smoke passes; app-server-conformance passes; check:schemas passes; final bun run check, bun run test, bun run build:native, and bun run test:py pass.

## Overall acceptance criteria
1. app-server-conformance passes initialize handshake, pinned field matrix, thread/turn/item lifecycle state machine, approvals-as-no-op, scheduler, overload, stale events, two-thread isolation, transports, and notifications parity fixtures.
2. harness M10 e2e passes against app-server.
3. python gjc-rpc tests and robogjc tests pass against app-server.
4. notifications e2e passes for Telegram, Discord, and Slack with concrete parity semantics listed above.
5. Old RPC mode and notifications SDK are deleted, reference-search gates are clean, and final check/test/build gates pass.
6. codex interop smoke passes for initialize plus thread/turn/item and command/exec with no approval round trip.
7. Rust-derived TS and JSON Schema are generated and check:schemas is green.

## Verification matrix
Named suites: app-server-conformance; harness M10 e2e; python gjc-rpc tests; robogjc tests; notifications e2e; codex interop smoke; check:schemas; build:native; final check and test. Phase 0 requires app-server-conformance Phase 0 plus check:schemas plus build:native. Phase 1 requires conformance core plus codex smoke minimal plus check:schemas plus build:native. Phase 2 requires conformance extensions plus check:schemas plus build:native. Phase 3 requires conformance transports plus codex smoke transport plus check:schemas. Phase 4 requires harness M10 e2e. Phase 5 requires python gjc-rpc tests. Phase 6 requires robogjc tests and bun run test:py. Phase 7 requires notifications e2e. Phase 8 requires codex interop smoke and full conformance. Phase 9 requires every named suite plus final bun run check, bun run test, bun run build:native, and bun run test:py.

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| AgentSession singleton state is unsafe for true concurrency | Cross-thread clobbering | Blocking Phase 0 audit; scope, serialize, or cap concurrency; two-thread disposal test. |
| Scheduler accepts turns before capacity | Lost lifecycle or hung turns | Admission checks bounded queues first; -32001 overload before TS call. |
| TS stale events corrupt new sessions | Wrong turn/item output | backendGeneration tokens on all callbacks and stale-event rejection. |
| Ad hoc event mapping misses interleavings | Codex UI inconsistency | Rust state machine with abort, compaction, tool, steer, and terminal coalescing fixtures. |
| Codex field behavior ambiguous | Client incompatibility | Pinned v1 accept/project/reject matrix and interop smoke. |
| Schema generation drifts | Broken clients | Phase 0 generator gate and check:schemas every phase. |
| Notifications parity under-specified | Telegram/Discord/Slack regressions | Concrete e2e criteria for discovery, token, frames, replies, replay, idempotency, reconnect. |
| Deletion leaves dangling refs | Broken imports or docs | Reference-search gates after each deletion chunk. |

## Handoff guidance
Use executor for bounded implementation slices after plan approval: Phase 0 audit and schema gate, scheduler and identity, Rust state machine, TS N-API backend, transports, harness, Python, robogjc, notifications, deletion cleanup. Use architect after Phase 0 and before Phase 9 to review isolation, identity, transport security, and deletion readiness. Use critic for the pinned Codex matrix and state-machine fixture completeness. Use team only after approval when multiple implementation lanes run concurrently. Use ultragoal if execution spans sessions and needs durable checkpoint tracking.
