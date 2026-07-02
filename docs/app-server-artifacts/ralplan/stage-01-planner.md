# Planner execution plan: crates/gjc-app-server

## Summary
Build crates/gjc-app-server as a Rust rlib plus crates/pi-natives/src/app_server.rs N-API wrapper. It embeds a codex-compatible JSON-RPC 2.0 app-server in the current Bun process, drives TypeScript AgentSession through an AgentBackend trait, and hard-replaces the old RPC mode plus notifications SDK after every dependent is migrated. Scope follows the deep-interview spec: codex core lifecycle plus namespaced gjc extensions, Rust-owned multi-thread map, stdio JSONL plus loopback WS plus Unix socket transports, generated TS and JSON Schema from Rust protocol types, no fs/process v1, no real approvals, no standalone binary, no legacy compatibility after deletion.

## RALPLAN-DR
Principles: 1. Codex compatibility is a wire protocol boundary; AgentBackend mirrors AgentSession, not Codex internals. 2. Rust owns protocol, transports, registry, schemas, and event normalization; TypeScript owns current agent behavior until the native Rust port. 3. Build side-by-side, migrate live dependents, then delete legacy surfaces atomically. 4. Preserve GJC-only fidelity through namespaced gjc methods and notifications. 5. Transport security mirrors gjc-notifications: loopback only, token auth, private discovery files, stale cleanup, deterministic teardown.

Decision drivers: 1. Basic Codex client interop for initialize, thread, turn, item, and command/exec. 2. Minimal bridge risk by using AgentSession-shaped callbacks with serde-validated DTOs. 3. Safe migration order for harness, Python, robogjc, and notifications before deletion.

Viable options and decisions:
| Decision | Option A | Option B | Decision |
|---|---|---|---|
| Protocol source of truth | Rust derives generate TS and JSON Schema. Pro: future native core ready and drift checked. Con: generator setup. | Keep TS/Python primary and hand-port Rust. Pro: fast first draft. Con: drift. | Rust protocol types are source of truth. |
| Event mapping | Rust maps AgentEvent to Codex ThreadItem lifecycle. Pro: testable interop. Con: more mapper work. | Forward legacy events only. Pro: fast. Con: Codex clients fail. | Canonical Codex notifications plus gjc raw/detail extensions. |
| Migration sequence | Side-by-side then delete. Pro: bisectable. Con: temporary duplicate surfaces. | Big bang. Pro: short. Con: high blast radius. | Side-by-side until all dependent suites pass; deletion is atomic. |
| Session map ownership | Rust owns threadId to backend handle. Pro: transport authority and future Rust backend. Con: TS factory needed. | TS owns map. Pro: simpler early. Con: Rust cannot own lifecycle. | Rust owns map; TS supplies backend factory and callbacks. |
| Callback threading | Tokio tasks plus N-API threadsafe functions. Pro: non-blocking and cancellable. Con: boilerplate. | Synchronous N-API calls. Pro: simple. Con: blocks and races. | Async TSFN callbacks with bounded queues. |

## In scope and out of scope
In scope: crates/gjc-app-server rlib; pi-natives AppServer wrapper; JSON-RPC handshake and framing; codex core methods thread/start, thread/resume, thread/fork, thread/list, thread/loaded/list, thread/read, thread/unsubscribe, thread/name/set, thread/archive, thread/delete, turn/start, turn/steer, turn/interrupt, thread/compact/start, thread/shellCommand, command/exec; namespaced gjc management, workflow gates, host tools, host URIs, notifications parity; multi-thread registry; stdio, WS, UDS transports; Rust-derived TS and JSON Schema; migrations for harness, python/gjc-rpc, python/robogjc, notifications daemon; final deletion of old RPC and notification SDK.

Out of scope: fs methods, process methods, real permission approval gates, standalone Rust binary independent of Bun, full Codex experimental parity, native Rust AgentBackend before the separate Rust core port, backward compatibility for old RPC or notifications SDK after deletion.

## File-level changes
New crate crates/gjc-app-server:
- Cargo.toml: workspace package, edition 2024, deps on serde, serde_json, tokio, tokio-util, futures-util, tokio-tungstenite, async-trait, parking_lot or dashmap, schemars or chosen TS generator, and neutral shared transport helpers if factored.
- src/lib.rs: public modules and rlib exports.
- src/jsonrpc.rs: request, response, notification, ids, error codes, init guard, overload error -32001.
- src/protocol/codex.rs: initialize, thread, turn, item, item notifications, status enums.
- src/protocol/gjc.rs: gjc management, workflow gate, host tool, host URI, notifications parity DTOs.
- src/backend.rs: AgentBackend and AgentBackendFactory traits with AgentSession-shaped methods.
- src/session_map.rs: AppServerState, ThreadRegistry, ThreadHandle, TurnHandle, subscriptions, item accumulators.
- src/dispatch.rs: method dispatch, init enforcement, codex routing, gjc routing, fast-lane cancellation and read policy.
- src/event_map.rs: backend events to codex item lifecycle and gjc notifications.
- src/transports/stdio.rs, ws.rs, unix.rs, framing.rs: stdio JSONL, loopback WS, websocket-over-UDS.
- src/discovery.rs: endpoint records, private atomic writes, token redaction, stale cleanup adapted from gjc-notifications.
- src/exec.rs: command/exec implementation without process v1.
- src/schema.rs or a generator entry: TS and JSON Schema output.
- tests: conformance, event mapping, approvals no-op, transports, discovery, registry teardown.

N-API and package:
- crates/pi-natives/src/lib.rs: add app_server module.
- crates/pi-natives/src/app_server.rs: AppServer class, AppServerEndpoint object, callback registration, start, stop, emitBackendEvent, sendFrame, error conversion. Mirror notifications.rs call order: construct, register callbacks, start.
- crates/pi-natives/Cargo.toml: depend on gjc-app-server.
- packages/natives/native/index.js and index.d.ts: generated AppServer exports.
- packages/natives/test: start/stop and callback smoke.

TypeScript integration:
- packages/coding-agent/src/main.ts, cli.ts, cli/args.ts, commands/launch.ts: add gjc app-server and --mode app-server alias; keep --mode rpc only until deletion.
- packages/coding-agent/src/modes/app-server/app-server-mode.ts: create native AppServer, initialize extensions and gates, own process lifecycle.
- packages/coding-agent/src/modes/app-server/agent-backend.ts: wrap AgentSession methods and event subscription for Rust callbacks.
- packages/coding-agent/src/modes/index.ts and src/index.ts: export app-server types during migration; remove RPC/notifications exports during deletion.
- packages/coding-agent/src/modes/shared/agent-wire: reuse intentionally or delete after migration.

Dependent migrations:
- packages/coding-agent/src/harness-control-plane/rpc-adapter.ts: speak app-server JSON-RPC while preserving HarnessRpc.
- python/gjc-rpc: replace legacy JSONL command/event client with app-server JSON-RPC client and generated protocol types.
- python/robogjc: spawn gjc app-server or --mode app-server, use thread/start and turn/start, register host tools through gjc/hostTools/set.
- Notifications daemon and docs: migrate Telegram, Discord, Slack to app-server WS discovery and gjc/notifications methods/events.
- docs/rpc.md, docs/notifications-sdk.md, docs/telegram-onboarding.md, schemas: update or delete as appropriate.

## Mechanical protocol mapping
Codex lifecycle and core methods:
| Codex surface | AgentBackend or AgentSession source | Handling and gaps |
|---|---|---|
| initialize | connection state | Return userAgent, codexHome-compatible gjc home, platformFamily, platformOs, capabilities. Reject pre-init and duplicate init. |
| initialized | connection state | Mark connection ready. |
| thread/start | backend factory create | Rust allocates threadId, TS creates AgentSession, Rust inserts map, emits thread/started. Accept sandbox and approval fields but project or ignore unsupported values. |
| thread/resume | backend factory resume | Recreate backend from stored session id or path, return loaded Thread. Unsupported Codex-only fields are nullable or gjc metadata. |
| thread/fork | backend fork or AgentSession.fork | Create new thread from copied history. Reject unsafe mid-turn lastTurnId cases if GJC cannot model them. |
| thread/list and thread/read | registry plus session manager | Loaded state from Rust, persisted data from TS session manager, minimal cursor pagination. |
| thread/loaded/list | Rust registry | Return loaded thread ids. |
| thread/unsubscribe | connection subscriptions | Remove subscriber; backend remains loaded unless explicit unload policy later. |
| thread/name/set | set_session_name | Call AgentSession.setSessionName name user and emit thread/name/updated. |
| turn/start | prompt | Synthesize userMessage item, call AgentSession.prompt, stream item and turn events. |
| turn/steer | steer | Add userMessage to active turn, call AgentSession.steer, return active turnId. |
| turn/interrupt | abort | Call AgentSession.abort and finish turn as interrupted on terminal event. |
| thread/compact/start | compact | Emit contextCompaction item around AgentSession.compact or auto compaction. |
| thread/shellCommand | execute_bash | Thread-bound commandExecution item with output streaming. |
| command/exec | execute_bash excludeFromContext or native shell | Utility command outside a turn context. No process methods. |

Codex item and event mapping:
| Codex output | GJC event source | Handling and gaps |
|---|---|---|
| thread/started | registry insertion | Include thread status and gjc session metadata under extension fields if needed. |
| thread/status/changed | agent_start, agent_end, compaction states | Running and idle transitions; background jobs may also emit gjc/activity. |
| turn/started | turn_start, or prompt acceptance fallback | Preferred acceptance signal for harness. |
| turn/completed | turn_end, message_end, agent_end | Status completed, failed, or interrupted. Fold multiple GJC terminal fragments into one Codex turn. |
| item/started userMessage | turn/start or turn/steer input | Synthesize content from text/images and echo client id. |
| item/started agentMessage | message_start assistant | Create agentMessage with empty text. |
| item/agentMessage/delta | message_update text_delta | Append deltas by itemId and content index. |
| item/completed agentMessage | message_end assistant | Final item is authoritative. |
| reasoning item and deltas | thinking_start, thinking_delta, thinking_end | Emit when GJC exposes thinking. Respect redaction; otherwise omit. |
| commandExecution item | tool_execution for bash, thread/shellCommand, command/exec | Stream outputDelta and final exit/status. If stdout/stderr split unavailable, document combined stream. |
| fileChange item | edit/apply_patch tool events | Emit structured diff when available, otherwise completed-only best effort. No declined status from approvals. |
| mcpToolCall item | MCP tool_execution events | Map server/tool/args/result when metadata is available; otherwise preserve as gjc/tool events. |
| turn/plan/updated or plan item | todo_reminder, plan-mode custom messages | Use only for Codex-compatible plan text; preserve richer todos in gjc/todos. |
| contextCompaction | auto_compaction_start/end and compact | Emit item lifecycle plus gjc autoCompaction detail. |
| error notification | terminal message error or backend error | Emit Codex error and failed turn when active. |
| warning/configWarning | notice | warning and error notices map to Codex warning; all notices also emit gjc/notice. |
| approval request events | no GJC permission model | Do not emit requestApproval; accept approval fields and auto-approve internally. |

GJC AgentEvent to app-server:
| GJC event | Codex output | gjc output |
|---|---|---|
| agent_start | thread/status/changed running | gjc/agent/start |
| agent_end | thread/status/changed idle and terminal fallback | gjc/agent/end with messages |
| turn_start | turn/started | gjc/turn/start |
| turn_end | turn/completed | gjc/turn/end |
| message_start | item/started | gjc/message/start |
| message_update | agentMessage deltas, reasoning deltas, tool deltas | gjc/message/update |
| message_end | item/completed and maybe turn terminal | gjc/message/end |
| tool_execution_start/update/end | commandExecution, fileChange, mcpToolCall when classifiable | gjc/tool/start, update, end |
| auto_compaction_start/end | contextCompaction item lifecycle | gjc/autoCompaction/start, end |
| auto_retry_start/end | terminal error only when final | gjc/autoRetry/start, end |
| retry_fallback_applied | model/rerouted | gjc/retryFallback/applied |
| retry_fallback_succeeded | none | gjc/retryFallback/succeeded |
| ttsr_triggered | none | gjc/ttsr/triggered |
| todo_reminder | optional turn/plan/updated | gjc/todo/reminder |
| todo_auto_clear | optional plan clear | gjc/todo/autoClear |
| irc_message | none | gjc/irc/message |
| subagent_steer_message | optional userMessage if active | gjc/subagent/steer |
| notice | warning for warning/error | gjc/notice |
| thinking_level_changed | none | gjc/thinkingLevel/changed |
| goal_updated | optional only if goal core adopted later | gjc/goal/updated |

Core method to AgentBackend calls:
| App-server method | Backend method | TS AgentSession implementation |
|---|---|---|
| thread/start | create_thread | construct and wire AgentSession |
| thread/resume | resume_thread | create AgentSession for existing session |
| thread/fork | fork_thread or fork | AgentSession.fork or branch mechanics |
| thread/read | get_state, get_messages | buildDisplaySessionContext and messages |
| thread/name/set | set_session_name | setSessionName |
| turn/start | prompt | prompt with images and streamingBehavior |
| turn/steer | steer | steer |
| turn/interrupt | abort | abort |
| thread/compact/start | compact | compact |
| thread/shellCommand | execute_bash | executeBash with context behavior |
| command/exec | execute_bash | executeBash with excludeFromContext |
| gjc/model/set | set_model | getAvailableModels then setModel |
| gjc/model/cycle | cycle_model | cycleModel |
| gjc/model/list | get_available_models | getAvailableModels |
| gjc/thinking/set, cycle | set_thinking_level, cycle_thinking_level | setThinkingLevel, cycleThinkingLevel |
| gjc/state/read | get_state | old RpcSessionState equivalent |
| gjc/todos/set | set_todos | setTodoPhases |
| gjc/messages/get | get_messages | snapshot messages |
| gjc queue mode setters | set_steering_mode, set_follow_up_mode, set_interrupt_mode | AgentSession setters |
| gjc/compact and gjc/autoCompaction/set | compact, set_auto_compaction | compact and setAutoCompactionEnabled |
| gjc/autoRetry/set and gjc/retry/abort | set_auto_retry, abort_retry | setAutoRetryEnabled and abortRetry |
| gjc/bash/abort | abort_bash | abortBash |
| gjc/session stats/export/switch/branch/name/handoff | matching backend methods | existing AgentSession methods |
| gjc/login/providers and gjc/login | get_login_providers, login | OAuth provider storage and auth flow |
| gjc/workflowGate/respond/listPending | resolve or list gates | existing unattended control plane and gate store |
| gjc/unattended/negotiate | negotiate_unattended | existing unattended negotiation |
| gjc/hostTools/set | set_host_tools | refreshRpcHostTools renamed or generalized |
| gjc/hostUriSchemes/set | set_host_uri_schemes | host URI bridge registry |
| gjc/notifications methods | notification parity backend | action lifecycle and daemon bridge |

## AgentBackend trait design and TS callback wiring
Trait surface should be async, Send, Sync, and AgentSession-shaped. Required groups: identity and metadata; prompt, steer, follow_up, abort, new_session, fork; get_state, get_messages, get_session_stats; set_todos, host tools, host URI schemes; model and thinking methods; steering, follow-up, interrupt mode setters; compact, auto-compaction, auto-retry, bash exec and abort; export_html, switch_session, branch, branch messages, last assistant text, set session name, handoff; login providers and login; subscribe to backend events; dispose. AgentBackendFactory supplies create, resume, and fork and returns Arc dyn AgentBackend.

Rust owns AppServerState, ThreadRegistry, ConnectionRegistry, JSON-RPC ids, thread ids, turn ids, item ids, subscription sets, active turn state, and transport backpressure. TS owns actual AgentSession objects. Rust stores threadId to ThreadHandle, where each handle contains Arc AgentBackend, active-turn state, item accumulator, and subscribers. Deletion, unload, or server stop calls backend.dispose and removes the map entry.

N-API wiring: AppServer exposes constructor, callback registration, start, stop, emitBackendEvent, and optional sendFrame. TS registers onCreateThread, onResumeThread, onForkThread, and onBackendCall before start. Rust invokes JS only through ThreadsafeFunction callbacks from Tokio tasks. Every call has request id, serde-validated payload, timeout or cancellation token where relevant, and typed error conversion. TS pushes AgentSession events back through emitBackendEvent threadId eventJson. Bounded queues reject saturated ingress with -32001 Server overloaded; retry later. Core lifecycle events are non-droppable; optional debug gjc events may be droppable only if documented.

## Crate/module layout and transports
Layout: lib.rs, error.rs, ids.rs, jsonrpc.rs, backend.rs, server.rs, session_map.rs, dispatch.rs, event_map.rs, exec.rs, schema.rs, protocol/mod.rs, protocol/codex.rs, protocol/gjc.rs, protocol/notifications.rs, transports/mod.rs, transports/framing.rs, transports/stdio.rs, transports/ws.rs, transports/unix.rs, discovery.rs, tests.

Stdio JSONL is default for gjc app-server and replaces gjc --mode rpc spawning. It must never write non-protocol bytes to stdout. Loopback WS binds 127.0.0.1, authenticates by per-session token, writes discovery under .gjc/state/app-server, redacts tokens in logs, rejects Origin-bearing health requests, and uses private permissions and stale cleanup. Unix socket uses websocket upgrade over UDS and supports disconnect/reconnect; clients resync through thread/read and gjc/messages/get. Reuse from gjc-notifications should be by factoring neutral helpers for endpoint records, atomic private writes, redaction, token match, accept-loop cancellation, and idempotent stop handles rather than coupling to notifications enums.

## Schema generation approach
Rust protocol structs and enums use serde tags and camelCase fields and derive JsonSchema. TS generation should be direct from Rust if the chosen generator handles tagged unions; otherwise generate JSON Schema from Rust and generate TS declarations from schema. Extend scripts/generate-json-schemas.ts so bun run generate-schemas emits app-server schemas and TS declarations, and bun run check:schemas fails on drift. Generated artifacts cover codex requests, responses, notifications, ThreadItem union, JSON-RPC error shape, and gjc extension methods. Conformance tests validate sample frames against generated schemas.

## Sequencing and dependencies
Phase 0: protocol audit and scaffolding. Create crate skeleton, JSON-RPC envelope, minimal protocol DTOs, in-memory fake backend, pi-natives skeleton, conformance fixtures for initialize and approvals fields, schema proof. Verification: cargo test -p gjc-app-server, bun run check:schemas, bun run build:native. Maps to AC1 partial and AC7 partial.

Phase 1: core runtime and TS AgentBackend. Implement backend trait, factory, Rust registry, app-server TS mode, CLI entrypoint, initialize, thread/start, thread/resume, thread/loaded/list, thread/read, turn/start, turn/steer, turn/interrupt, opt-out, and basic event mapper. Verification: conformance tests, focused coding-agent tests, JSONL smoke initialize to turn completed, build:native. Maps to AC1 partial and AC6 partial.

Phase 2: gjc extensions, command exec, workflow gates, host tools and URIs. Implement gjc management methods mirroring current RpcCommand catalog, unattended and workflow gate validation/audit, host tool and URI bridges, command/exec, thread/shellCommand, commandExecution streaming, no-op approval behavior, and remaining event mapping. Verification: cargo tests for event_map approvals command_exec, check:schemas, focused TS tests, host tool/URI round trip. Maps to AC1 complete, AC2/AC3 prerequisites, AC7 complete.

Phase 3: transports and discovery. Finish stdio, loopback WS discovery/token, UDS reconnect, stop/drop lifecycle, stale cleanup, private permissions, token redaction, health readiness. Verification: cargo transport/discovery tests, build:native, WS token smoke, UDS reconnect smoke. Maps to AC1 transport complete, AC4 prerequisite, AC6 partial.

Phase 4: harness migration. Rewrite GajaeCodeRpc to spawn app-server and speak JSON-RPC, preserve HarnessRpc, map single-flight acceptance to turn/start response plus turn/started or gjc/agent/start after cursor, replace legacy ready with initialize handshake. Verification: harness adapter unit tests and M10 e2e. Maps to AC2 complete.

Phase 5: Python gjc-rpc migration. Replace legacy client with JSON-RPC app-server client, update generated protocol dataclasses or TypedDicts, parse codex and gjc notifications, rewrite tests. Verification: python3 -m pytest -x python/gjc-rpc/tests. Maps to AC3 partial and validates AC7.

Phase 6: robogjc migration. Update worker to spawn app-server, initialize and start/resume threads, drive turns, register GitHub host tools through gjc/hostTools/set, preserve session_dir resume, credential redaction, audits, and synchronous worker.run_task threading model. Verification: python3 -m pytest -x python/robogjc/tests, bun run test:py, robogjc integration when env exists. Maps to AC3 complete.

Phase 7: notifications daemon migration. Define gjc/notifications parity for idle, action_needed, context_update, turn_stream, activity, inbound user messages, config commands, action resolution, and lifecycle control. Move Telegram/Discord/Slack to app-server WS discovery and JSON-RPC. Preserve ActionRegistry semantics: replay pending ask, first-valid-reply-wins, idempotency, non-repliable terminal resolution. Update docs and e2e tests. Maps to AC4 complete.

Phase 8: codex interop and conformance hardening. Build codex-client smoke for initialize, initialized, thread/start, turn/start, item lifecycle, turn/completed. Add negative tests for pre-init, duplicate init, unknown method, malformed params, overload, opt-out, and approvals no-op. Verify against Codex reference subset and VS Code extension or equivalent when available. Maps to AC1 complete and AC6 complete.

Phase 9: atomic legacy deletion. Remove packages/coding-agent/src/modes/rpc, legacy exports, mode rpc dispatch, rpc-client SDK, obsolete shared agent-wire pieces not reused, crates/gjc-notifications and pi-natives notifications wrapper after parity migration, NotificationServer exports, obsolete docs/tests/env names. Search for runRpcMode, RpcCommand, --mode rpc, NotificationServer, gjc-notifications, notifications SDK. Verification: bun run check, bun run test, bun run build:native, bun run test:py, targeted reference search, Rust workspace tests. Maps to AC5 complete and regression coverage for AC1-AC4, AC6, AC7.

## Acceptance criteria
Overall: 1. App-server conformance passes for initialize, thread/turn/item lifecycle, approvals-as-no-op. 2. Harness M10 e2e passes via app-server adapter. 3. Python gjc-rpc and robogjc tests pass. 4. Telegram/Discord/Slack notifications daemon works end-to-end. 5. Old RPC mode and notifications SDK are deleted with no dangling references and check/build green. 6. Codex client can drive basic initialize plus thread/turn. 7. TS and JSON Schema are generated from Rust types and check:schemas is green.

Phase map: Phase 0 covers AC1 and AC7 partially. Phase 1 covers AC1 and AC6 partially. Phase 2 completes AC1 protocol and AC7 and prepares AC2/AC3/AC4. Phase 3 completes transport conformance and prepares AC4/AC6. Phase 4 completes AC2. Phases 5 and 6 complete AC3. Phase 7 completes AC4. Phase 8 completes AC1 and AC6. Phase 9 completes AC5 and reruns regression verification for all criteria.

## Verification
Use these concrete suites and commands as they become available: cargo test -p gjc-app-server; bun scripts/run-rs-task.ts test:rs or bun run test:rs after workspace integration; bun run build:native; bun run generate-schemas and bun run check:schemas; focused packages/coding-agent tests and bun run check:ts; harness M10 e2e through the existing harness command path; python3 -m pytest -x python/gjc-rpc/tests; python3 -m pytest -x python/robogjc/tests; bun run test:py; bun run robogjc:test:integration when prerequisites exist; notifications daemon e2e for WS discovery, action_needed, reply, turn_stream, activity, reconnect; full bun run check and bun run test before deletion completion; codex interop smoke over stdio and WS or UDS.

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Codex protocol drift | Interop breakage | Pin v1 to inspected reference subset, generate schemas, error clearly for unsupported methods. |
| Event mapper loses GJC detail | Python or daemon regression | Emit codex core plus namespaced gjc detail events. |
| TSFN deadlock or blocking | Hung server | Async TSFN only, bounded queues, no sync JS from transport tasks, concurrent cancel tests. |
| Rust registry and TS sessions diverge | leaks or stale callbacks | Single ThreadHandle lifecycle, idempotent dispose, stop/delete/reconnect tests. |
| Required lifecycle events dropped under pressure | missed terminal state | Non-droppable core events and overload rejection before work acceptance. |
| Notification helper deletion too early | transport regressions | Factor or copy tested neutral helpers before deleting SDK-specific code. |
| Old RPC references remain | broken user paths | Deletion phase includes explicit reference search and docs cleanup. |
| Approval no-op surprises clients | blocked UI expectations | Never emit approval requests; accept fields and proceed; conformance asserts no blocking. |
| command/exec pollutes context | conversation corruption | Always excludeFromContext for command/exec; tests assert message count. |
| Schema generator limitations | bad generated TS/Python | Phase 0 generator spike; fallback to JSON Schema bundle plus TS-from-schema. |

## Handoff guidance
Use executor for bounded implementation slices: Rust protocol, TS N-API backend, transports, harness, Python, robogjc, notifications, deletion cleanup. Use architect after Phase 1 and before Phase 9 for ownership, transport security, and deletion readiness. Use critic for the Phase 8 conformance matrix. Use team only after execution approval when parallel lanes are active. Use ultragoal if execution spans multiple sessions and needs durable checkpoint tracking.
