## Summary
The revised plan is adequate for plan-level approval. It preserves the source spec scope and turns all nine prior must-fix concerns into blocking Phase 0 gates, concrete protocol matrices, state-machine fixtures, migration gates, and named acceptance suites.

## Analysis
Source-spec alignment is intact. The source spec requires a Rust crates/gjc-app-server rlib plus pi-natives N-API wrapper, in-process TS AgentSession bridge, codex-compatible JSON-RPC app-server, hard replacement of RPC plus notifications SDK, multi-thread threadId -> AgentSession mapping, command/exec, namespaced gjc extensions, transports, schema generation, and dependent migrations (deep-interview-gjc-app-server.md lines 14-15, 27-38, 56-63). The revised plan keeps those boundaries in summary and scope (stage-04-revision.md lines 3-24).

Prior must-fix verification:
1. Multi-thread AgentSession isolation audit and binding contract: RESOLVED. The plan adds a blocking audit that enumerates process globals and singletons, requires classification as per-session scoped, process-shared read-only, serialized global, or v1 concurrency cap, and gates Phase 1 on two-thread disposal and no cross-thread leak tests (stage-04-revision.md lines 28-33, 113-116).
2. Per-thread scheduling and TSFN flow control: RESOLVED. It defines serial mutating, cancel fast, and read fast lanes; bounded per-connection and per-thread admission; -32001 overload rejection before TS mutation; non-droppable accepted lifecycle events; and explicit TSFN failure handling before and after work acceptance (stage-04-revision.md lines 35-40, 113-116).
3. Identity model: RESOLVED. Rust owns immutable codex threadId, TS sessionId/sessionFile become metadata, backendGeneration is required on callbacks/events, stale events are rejected, and lifecycle semantics cover start, resume, fork, switch, delete, unload, and archive (stage-04-revision.md lines 42-45, 85-92).
4. Event-mapping state machine with fixtures: RESOLVED. The plan replaces table-only mapping with a Rust ItemLifecycleStateMachine, tracks item and turn states, terminal coalescing, content ordering, raw detail preservation, and mandatory fixture coverage for key races and interleavings (stage-04-revision.md lines 76-82).
5. Codex v1 method and field matrix plus command/exec shape and interop smoke: RESOLVED. The plan pins accepted/projected/rejected fields for initialize, thread, turn, compact, shellCommand, command/exec, and approvals, and defines an interop smoke covering initialize through turn completion and command/exec without approval requests (stage-04-revision.md lines 50-74).
6. Schema-generation blocking gate: RESOLVED. Phase 0 blocks until Rust protocol types generate JSON Schema and TypeScript declarations, root generate-schemas and check:schemas invoke the generator, sample frames validate, and check:schemas runs at every phase gate (stage-04-revision.md lines 47-48, 103-104, 113-116).
7. Per-phase testable acceptance criteria tied to named suites: RESOLVED. Phases 0A through 9 now have named acceptance gates, and the overall verification matrix names app-server-conformance, harness M10 e2e, python gjc-rpc tests, robogjc tests, notifications e2e, codex interop smoke, check:schemas, build:native, and final check/test gates (stage-04-revision.md lines 111-169).
8. Rollback-safe migration and deletion sequencing with reference-search gates: RESOLVED. Legacy RPC and NotificationServer remain until dependents pass, Phase 9 is explicitly the only non-rollback-compatible step, and deletion includes reference-search gates for legacy symbols and docs with explicit keep rationales for any survivors (stage-04-revision.md lines 106-109, 157-162).
9. Notifications parity acceptance: RESOLVED. The plan lists parity frames, inbound user_message with images, config_command, pending ask replay, first-valid-reply-wins, idempotency, duplicate/stale reply rejection, reconnect replay, WS discovery/token, and Telegram/Discord/Slack e2e coverage (stage-04-revision.md lines 100-101, 145-150, 166).

## Root Cause
The earlier plan named the right destination but left concurrency safety, scheduler behavior, identity ownership, Codex field compatibility, schema drift prevention, and migration deletion gates too implicit. The revision moves those mechanics into explicit blocking gates and named suites, which is sufficient for a plan artifact.

## Findings
No blocking findings remain.

LOW / stage-04-revision.md lines 28-116 / Execution risk remains high because Phase 0 carries multiple deep design gates at once. Impact: executors may over-scope Phase 0 or blur audit artifacts with implementation. Fix suggestion: keep Phase 0A as a hard checkpoint and require the planned architect review after Phase 0 before dependent migrations begin.

## Recommendations
1. Approve the revised plan for execution planning handoff.
2. Enforce Phase 0A as non-negotiable: no harness, Python, robogjc, or notifications migration starts before app-server-conformance Phase 0, check:schemas, and build:native are green.
3. Re-review after Phase 0A and before Phase 9 deletion, exactly as the plan already calls out.

## Architectural Status
CLEAR

## Code Review Recommendation
APPROVE

## Trade-offs
| Option | Benefit | Cost | Verdict |
|---|---|---|---|
| Approve this revision | Unblocks execution with all prior plan-level blockers covered by gates and tests | Still requires disciplined Phase 0 delivery | Preferred |
| Demand more plan detail now | Could reduce some execution ambiguity | Risks perfectionism beyond plan-level needs and repeats implementation design inside the plan | Not needed |
| Start migration before Phase 0A | Faster visible progress | Reintroduces concurrency and protocol safety risks that prior feedback targeted | Reject |
