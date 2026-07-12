# Coordinator MCP bridge

GJC exposes a native outward MCP bridge for external coordinators:

```bash
gjc mcp-serve coordinator
```

`gjc mcp-serve hermes` is accepted as a compatibility alias for the same coordinator bridge.

The bridge is intentionally separate from GJC's client-side MCP runtime. It lets an external coordinator discover and control SDK-backed sessions, queue bounded follow-up prompts, read status/artifacts, handle structured questions, and write coordination reports without scraping terminal scrollback.

## Core contract and adapters

The coordinator bridge is intentionally a core contract with multiple adapters, not an MCP-only or Hermes-only product direction. Hermes is one compatibility preset, not a privileged integration mode:

- `packages/coding-agent/src/coordinator/contract.ts` owns transport-neutral server metadata and tool names.
- `gjc mcp-serve coordinator` is the outward MCP adapter for external agents.
- `gjc coordinator` is the read-only CLI/debug adapter for humans and scripts that need to inspect the same contract without starting MCP transport.
- `gjc setup hermes` is the compatibility setup adapter that renders coordinator config and operator guidance.

Future session, turn, question, artifact, and report behavior should move toward shared coordinator core services that both MCP and CLI adapters call instead of duplicating transport-specific logic.

## Coordinator setup adapter

Use `gjc setup hermes` to render or install a portable MCP setup package for any controller that accepts Hermes-compatible MCP config:

```bash
gjc setup hermes --root /path/to/repo --profile my-bot --repo gajae-code
```

The default mode is render-only and writes no files. To install into a Hermes profile:

```bash
gjc setup hermes \
  --root /path/to/repo \
  --profile my-bot \
  --repo gajae-code \
  --mutation sessions,questions,reports \
  --profile-dir /path/to/hermes/profile \
  --install
```

The generated setup is model-agnostic and worktree-isolated. By default it renders `GJC_COORDINATOR_MCP_SESSION_COMMAND` as `gjc --worktree`, so spawned sessions launch inside a GJC-managed sibling worktree while GJC retains the source repository as project identity. Users who need a stable named branch can set `--worktree-name`; users who need a specific local wrapper, dev checkout, or provider/model can opt in explicitly:

```bash
gjc setup hermes \
  --root /path/to/repo \
  --worktree-name hermes-gajae-code
```

```bash
gjc setup hermes \
  --root /path/to/repo \
  --session-command "gjc --worktree hermes-custom --model <provider/model>"
```

Provider/model examples are examples only; GJC does not hard-code GPT, Anthropic, or any other provider as the Hermes bridge default.

Run a non-mutating setup smoke check with:

```bash
gjc setup hermes --root /path/to/repo --smoke
```

Smoke verifies the MCP server/tool contract. It does not call a downstream LLM and does not validate provider credentials.


## Safety model

The bridge is read-only and fail-closed by default.

Required root allowlist:

```bash
export GJC_COORDINATOR_MCP_WORKDIR_ROOTS="/path/to/repo:/path/to/worktrees"
```

Mutating tools require both startup opt-in and per-call consent:

```bash
export GJC_COORDINATOR_MCP_MUTATIONS="sessions,questions,reports"
```

Every mutating MCP call must include `allow_mutation: true` and the required caller-provided `idempotency_key`. Missing startup opt-in, per-call consent, or an idempotency key returns an error.

`gjc_coordinator_start_session` uses the configured GJC-compatible session command to create a session. `gjc setup hermes` writes `gjc --worktree` by default:

```bash
export GJC_COORDINATOR_MCP_SESSION_COMMAND="gjc --worktree"
```

The coordinator discovers that session's SDK endpoint, then sends prompts and answers through SDK control operations. `gjc_coordinator_read_coordination_status` returns a canonical polling snapshot for sessions, session states, turns, questions, reports, and bounded event summaries. Tmux identifiers, when supplied while registering an existing session, are advisory process metadata only; they do not provide control authority or determine turn completion.

For resume safety, prefer the generated GJC-native worktree command over creating a git worktree in Hermes itself. GJC's launch path records the original repo as the project identity while running in the worktree, so session listing/resume can still group the session under the source project. If Hermes creates and later deletes an unmanaged worktree, a saved session may still exist but its cwd can be gone.

Artifact reads are canonicalized, symlink escapes are rejected, and returned content is byte-capped by `GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP`.

`gjc setup hermes` renders `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` with the host platform path delimiter (`:` on POSIX, `;` on Windows). Manual configs should prefer the same encoding.

## Optional namespace

Use namespace variables to prevent cross-profile or cross-repo enumeration:

```bash
export GJC_COORDINATOR_MCP_PROFILE="team-a"
export GJC_COORDINATOR_MCP_REPO="gajae-code"
```

Missing namespace never widens into global session enumeration.

## Tool surface

Read tools:

- `gjc_coordinator_list_sessions`
- `gjc_coordinator_read_status`
- `gjc_coordinator_read_tail`
- `gjc_coordinator_list_questions`
- `gjc_coordinator_list_artifacts`
- `gjc_coordinator_read_artifact`
- `gjc_coordinator_read_coordination_status`
- `gjc_coordinator_read_turn`
- `gjc_coordinator_await_turn`
- `gjc_coordinator_watch_events`


Mutating tools:

- `gjc_coordinator_start_session`
- `gjc_coordinator_register_session`
- `gjc_coordinator_send_prompt`
- `gjc_coordinator_submit_question_answer`
- `gjc_coordinator_report_status`
- `gjc_delegate_plan`
- `gjc_delegate_execute`
- `gjc_delegate_team`

The `gjc_delegate_*` tools are high-level, session-level delegation: each starts (or reuses) an SDK-discovered session and sends one workflow-tagged turn for `/skill:ralplan`, `/skill:ultragoal`, or `/skill:team`, returning a durable `turn_id`, status, and artifact references. They use the same `sessions` mutation class and fail-closed workdir gating as `gjc_coordinator_start_session`, and emit a `delegation.started` event. Pass `await_completion: true` to use the durable bounded await/report path; `timeout_ms`, `poll_interval_ms`, and `lines` apply to that completion payload. Without it, the tool returns immediately after SDK acknowledgement. Pass `cwd` and `task`; set `allow_mutation: true` and a caller-provided `idempotency_key` only with startup mutation opt-in plus per-call consent. Optionally pass `mpreset` (same semantics as `gjc --mpreset <profile>`) to `gjc_coordinator_start_session` or a delegate tool to authoritatively activate a GJC model profile when starting a fresh session — it is resolved through the merged built-in/custom profile registry, applied from the first turn, and surfaced in status; unknown names are rejected with the available-profile listing, and reusing a session with a conflicting `mpreset` fails with `mpreset_conflict`. This is distinct from the advisory `model` prompt hint. Prefer these over manual `start_session` + `send_prompt` when delegating a whole workflow.

`gjc_coordinator_register_session` registers an existing SDK-discoverable GJC session for coordinator control. It validates the workdir allowlist and session id, then verifies endpoint discovery before writing session state. Optional tmux identifiers are retained only as advisory process metadata.
## Turn orchestration flow

External coordinators should treat turns, not terminal scrollback, as the unit of work:

1. Call `gjc_coordinator_start_session` with `allow_mutation: true` and `idempotency_key`.
2. Call `gjc_coordinator_send_prompt` with `allow_mutation: true` and `idempotency_key`.
3. Store the returned `turn_id`.
4. Poll `gjc_coordinator_read_turn`, or call bounded `gjc_coordinator_await_turn`, until the turn is terminal.
5. If `gjc_coordinator_list_questions` shows a question for that turn, answer with `gjc_coordinator_submit_question_answer`.
6. Use `gjc_coordinator_report_status` with `session_id` and `turn_id` to write explicit completion/failure evidence.
   Use `status: "cancelled"` for coordinator-policy cancellation, and `status: "failed"` plus `blocker` for provider/tool/task failures.

`gjc_coordinator_send_prompt` returns versioned top-level routing fields that exactly mirror its nested durable `turn`: `status`, `queued`, and `delivered` equal `turn.status`, `turn.delivery.queued`, and `turn.delivery.delivered`; `active_turn_id` is the new turn id unless this response queued a follow-up, in which case it is the existing active turn id.

```json
{
  "ok": true,
  "session_id": "gjc-coordinator-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "active_turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "status": "active",
  "queued": false,
  "delivered": true
}
```

A session may have only one active turn by default. A second prompt is rejected with `active_turn_exists` unless the caller explicitly passes `queue: true` or `force: true`. Queued turns are durable and the next queued turn is promoted when the active turn reaches a terminal `gjc_coordinator_report_status`. Force supersedes the previous active turn and audits that state in the turn journal.
Coordinator cancellation is recorded through `gjc_coordinator_report_status` with terminal `status: "cancelled"`; this updates durable turn state but does not control any process. If the correct policy is replacement work rather than cancellation, send the replacement prompt with `force: true` so the previous active turn is superseded and audited.

`gjc_coordinator_read_turn` returns the authoritative durable turn plus advisory SDK session status:

```json
{
  "ok": true,
  "turn": {
    "schema_version": 1,
    "turn_id": "turn-00000000-0000-0000-0000-000000000000",
    "session_id": "gjc-coordinator-demo",
    "status": "completed",
    "final_response": {
      "text": "Done",
      "format": "markdown",
      "source": "report_status",
      "artifact_path": null,
      "truncated": false
    },
    "evidence": [{ "path": "artifact.txt" }],
    "error": null
  },
  "advisory_status": {
    "live": true,
    "state": "idle_or_unknown"
  }
}
```

The coordinator MCP bridge is currently a durable polling/await surface. It does not expose a push subscription stream; external coordinators should poll `gjc_coordinator_read_coordination_status`, `gjc_coordinator_read_turn`, or bounded `gjc_coordinator_await_turn` instead of waiting for server-sent push events.

External `session_id`, `turn_id`, and `question_id` values are validated before path use, and loaded records must match the requested session/turn owner.

## Coordinator event journal

The bridge persists a restart-safe event journal under the configured coordinator state namespace, for example:

```text
$GJC_COORDINATOR_MCP_STATE_ROOT/<profile>/<repo>/events/event-journal.jsonl
```

Each event is a bounded JSONL record with `schema_version`, monotonic namespace-local `seq`, stable `id`, `timestamp`, canonical `kind`, optional `session_id`/`turn_id`/`question_id`/`report_id`, short `summary`, optional `payload_ref`, and bounded scalar `metadata`. Full prompts, reports, final responses, and artifacts stay in their existing turn/report/artifact read paths; event records only point at them.

`gjc_coordinator_watch_events` is a bounded long-poll MCP tool, not an unbounded stream. Inputs are `after_seq` (default `0`), optional `session_id`, optional `event_types`, `timeout_ms` capped at 30000, and `limit` capped at 100. If matching events already exist after `after_seq`, it returns immediately. Otherwise it waits for the event journal to change or for timeout. The response includes `events`, `latest_seq`, `timed_out`, and `transport: { "mcp": "long_poll", "push_subscriptions": false }`, so coordinators can persist `latest_seq` and resume safely after restart.

`gjc_coordinator_read_coordination_status` keeps its existing report fields and now also includes `latest_event_seq` plus recent event summaries for snapshot-style consumers.

## Generic controller config snippet

```json
{
  "mcp_servers": {
    "gjc_coordinator": {
      "command": "gjc",
      "args": ["mcp-serve", "coordinator"],
      "env": {
        "GJC_COORDINATOR_MCP_WORKDIR_ROOTS": "/path/to/repo",
        "GJC_COORDINATOR_MCP_PROFILE": "team-a",
        "GJC_COORDINATOR_MCP_REPO": "project",
        "GJC_COORDINATOR_MCP_SESSION_COMMAND": "gjc --worktree"
      },
      "enabled": true
    }
  }
}
```

## Smoke check

```bash
gjc mcp-serve coordinator --check --json
```

Expected result includes `ok: true`, server name `gjc-coordinator-mcp`, and the GJC-named tool list.
