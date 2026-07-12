## Required Lifecycle (Operator Contract)

Follow this exact lifecycle when running `$team`:

1. Start team and verify startup evidence (team line, tmux target, worker pane id, state dir, `worker_lifecycle_by_id.<worker>.lifecycle_state=ready` after startup ACK).
2. Monitor task progress with runtime/state tools first (`gjc team status <team>`, `gjc team resume <team>`, task files).
3. Wait for terminal task state and integration settlement before shutdown:
   - `pending=0`
   - `in_progress=0`
   - `failed=0` (or explicitly acknowledged failure path)
   - no pending integration request/conflict (`status` / `resume` must not report `phase=awaiting_integration`)
4. Only then run `gjc team shutdown <team>`.
5. Verify shutdown evidence and preserved state (`phase=complete`, worker runtime status `stopped`, lifecycle `stopped` with a matching graceful shutdown request id). If shutdown is forced before evidence-backed task completion, expect `phase=cancelled` or `phase=failed`; if tasks are complete but integration is still pending or conflicted, expect `phase=awaiting_integration`, not `complete`.

Do not run `shutdown` while the worker is actively writing updates unless user explicitly requested abort/cancel. Do not treat ad-hoc pane typing as primary control flow when runtime/state evidence is available.

### Active leader monitoring rule

While a team is running, keep checking live team state until terminal completion.

Minimum acceptable loop:

```bash
sleep 30 && gjc team monitor <team-name>
```
The mutating monitor path also performs bounded liveness recovery: expired task claims, stale heartbeat claims, and missing recorded worker panes are requeued instead of leaving work permanently `in_progress`.

## Operational Commands

```bash
gjc team status <team-name>
gjc team monitor <team-name>
gjc team resume <team-name>
gjc team shutdown <team-name>
```

Semantics:

- `status`: read-only snapshot path; it does not recover claims, replay notifications, integrate worker commits, or sync HUD state.
- `monitor`: mutating monitor path; reads team snapshot, recovers expired/stale worker claims, applies pending worker worktree integration, replays notifications, syncs HUD state, and returns task counts, worker state, tmux target/pane evidence, `worker_lifecycle_by_id`, and `integration_by_worker`.
- `resume`: mutating monitor path; performs the same liveness-recovery and integration-aware live snapshot for reconnect/inspection flows.
- `list`: pure read path; lists known teams without integrating worker commits.
- API/read-only snapshot operations are pure unless explicitly documented as a monitor path.
- `claim-task`: mutating task path; before granting a new claim, it recovers expired claims and rejects claims from workers already classified as not live.
- `shutdown`: writes per-worker graceful `shutdown-request.json`, moves lifecycle through `draining` to `stopped`, kills the recorded worker pane when it still belongs to the stored tmux target, removes clean created worktrees, marks worker runtime status stopped, and sets phase from task, lifecycle, and integration state: `complete` only when all tasks have verified `completion_evidence`, every worker has matching graceful shutdown lifecycle evidence, and no integration request/conflict is pending; `awaiting_integration` when tasks and lifecycle are complete but leader integration still requires action; `failed` when tasks failed/blocked or completed tasks lack valid evidence; and `cancelled` when work remains pending or in progress. It preserves `.gjc/_session-{sessionid}/state/team/<team>` as evidence.

## Data Plane and Control Plane

### Control Plane

- Current tmux leader window and one or more worker panes.
- `gjc team` lifecycle commands.
- `gjc team api claim-task` and `gjc team api transition-task-status`.

### Data Plane

- `.gjc/_session-{sessionid}/state/team/<team>/config.json`
- `.gjc/_session-{sessionid}/state/team/<team>/manifest.v2.json`
- `.gjc/_session-{sessionid}/state/team/<team>/phase.json`
- `.gjc/_session-{sessionid}/state/team/<team>/events.jsonl`
- `.gjc/_session-{sessionid}/state/team/<team>/trace.jsonl`
- `.gjc/_session-{sessionid}/state/team/<team>/trace-errors.jsonl`
- `.gjc/_session-{sessionid}/state/team/<team>/telemetry.jsonl`
- `.gjc/_session-{sessionid}/state/team/<team>/monitor-snapshot.json`
- `.gjc/_session-{sessionid}/state/team/<team>/integration-report.md`
- `.gjc/_session-{sessionid}/state/team/<team>/tasks/task-1.json` (includes structured `completion_evidence` after completed transitions)
- `.gjc/_session-{sessionid}/state/team/<team>/mailbox/worker-1/<message-id>.json`
- `.gjc/_session-{sessionid}/state/team/<team>/mailbox/worker-1.json` (legacy compatibility view)
- `.gjc/_session-{sessionid}/state/team/<team>/notifications/<notification-id>.json`
- `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/startup-ack.json`
- `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/status.json`
- `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/lifecycle.json`
- `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/heartbeat.json`
- `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/shutdown-request.json`
- `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/nudges/<fingerprint>.json`
- `.gjc/_session-{sessionid}/reports/team-commit-hygiene/<team>.ledger.json`

## Team Mutation Interop (CLI-first)

Use `gjc team api` for machine-readable task lifecycle operations.

```bash
gjc team api worker-startup-ack --input '{"team_name":"my-team","worker_id":"worker-1","protocol_version":"1"}' --json
gjc team api claim-task --input '{"team_name":"my-team","worker_id":"worker-1"}' --json
gjc team api transition-task-status --input '{"team_name":"my-team","task_id":"task-1","to":"completed","worker_id":"worker-1","claim_token":"<claim-token>","completion_evidence":{"summary":"Completed requested work and verified it locally.","items":[{"kind":"command","status":"passed","summary":"Focused test passed","command":"bun test packages/coding-agent/test/gjc-runtime/team-runtime.test.ts"}],"files":["packages/coding-agent/test/gjc-runtime/team-runtime.test.ts"],"notes":"Include at least one passed command or verified inspection/artifact item."}}' --json
gjc team api update-worker-status --input '{"team_name":"my-team","worker_id":"worker-1","status":"working","current_task_id":"task-1"}' --json
gjc team api recover-stale-claims --input '{"team_name":"my-team"}' --json
gjc team api read-traces --input '{"team_name":"my-team"}' --json
gjc team api create-task --input '{"team_name":"my-team","subject":"Verify delivery","description":"Run verification","owner":"worker-1","lane":"verification","required_role":"executor","depends_on":["task-1"]}' --json
```

Canonical worker lifecycle operations:

- `worker-startup-ack` before task work; this records startup ACK and moves `workers/<worker>/lifecycle.json` to `ready`
- `claim-task`
- `update-worker-status` when the worker starts/stops a task-local activity; this updates worker-reported `status.json` without replacing the runtime lifecycle source of truth
- `recover-stale-claims` is leader/runtime-owned; it clears expired claim files, requeues in-progress tasks claimed by stale workers, and records `task_claim_recovered` events without modifying terminal task records or completion evidence
- `transition-task-status` with the claim token, worker id, and structured `completion_evidence` object
- `release-task-claim`
Claim eligibility is ordered and must not be bypassed: explicit task id selection, task status/terminal checks, owner/assignee checks, lane/role checks, dependency/blocked checks, then active lease creation. `lane` is descriptive metadata; `required_role` and `allowed_roles` are the enforced worker role gates.

Completion evidence is stored inline on the task record as `completion_evidence`. It must include a non-empty `summary`, an `items` array, and at least one item with `status: "passed"` or `status: "verified"`. Valid item kinds are `command`, `inspection`, and `artifact`; command items require `command`. The camel-case alias `completionEvidence` is accepted by the API input, but legacy string `evidence` and separate evidence files are not part of the public completion contract.

GJC-team interop operations are also available for mailbox, native notification, worker heartbeat/status, stale-claim recovery, startup ACK, events, monitor snapshots, approvals, and shutdown request/ack flows; run `gjc team api --help` for the full operation list.

Structured trace records in `trace.jsonl` are append-only schema version 1 entries. Each trace references the legacy `events.jsonl` source via `source_event_id`, keeps `event_type`, worker/task ids, and includes `evidence_refs` for completion evidence or claim recovery when available. Trace append failures are isolated in `trace-errors.jsonl` and do not break `events.jsonl` compatibility.

## GJC-native concept parity

GJC ports team-mode concepts from `../../oh-my-codex`, not code or OMX/Codex-specific assumptions:

| Concept | GJC-native equivalent |
|---------|-----------------------|
| Worker identity/inbox/mailbox paths | `.gjc/_session-{sessionid}/state/team/<team>/workers/<worker>/identity.json`, `inbox.md`, and per-message mailbox records under `.gjc/_session-{sessionid}/state/team/<team>/mailbox/<worker>/`. |
| Startup ACK | `gjc team api worker-startup-ack`, persisted as `workers/<worker>/startup-ack.json`. |
| Claim-safe lifecycle APIs | `claim-task`, `transition-task-status`, and `release-task-claim` with worker ownership and claim-token guards. |
| Delivery states and deferred pane attempts | Native notification records under `.gjc/_session-{sessionid}/state/team/<team>/notifications/` with `pending`, `sent`, `queued`, `deferred`, `failed`, `delivered`, and `acknowledged` states. |
| Non-destructive leader nudges | Lifecycle nudge records under `workers/<worker>/nudges/`; GJC suggests inspection/relaunch but never auto-kills or auto-relaunches workers. |

Forbidden assumptions: do not copy OMX paths, Codex notify payload formats, OMX process names, or source code directly. Keep tmux as the current runtime; native split-worker TUI remains roadmap-only.

Worker protocol:

- Send startup ACK with `worker-startup-ack` before task work.
- Report worker activity with `update-worker-status`; this is the worker-reported status plane, not the runtime lifecycle state.
- Claim pending work with `claim-task`.
- Transition the task to `completed`, `failed`, or `blocked` with `transition-task-status`, including claim token and evidence for completion.
- Commit or leave worktree changes in the worker worktree; the leader `monitor`/`resume` path will auto-checkpoint dirty worktrees and integrate committed history where possible.
- Record implementation/verification evidence in normal task output and state files; leader integration/conflict notifications are delivered through `.gjc/_session-{sessionid}/state/team/<team>/mailbox/leader-fixed.json`.

