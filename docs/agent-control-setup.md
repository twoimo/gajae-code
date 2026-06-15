# Agent Control Plane setup guide

Gajae-Code should be presented to other agents as one product surface: the **GJC Agent Control Plane**. ACP, RPC, and MCP are adapters underneath that surface, not three separate products for operators to choose from casually.

Use this guide when an agent host, editor, bot, or scheduler needs to run `gjc` as a controllable worker instead of asking a human to drive the TUI.

## Mental model

```text
agent host / editor / bot / scheduler
  └─ GJC Agent Control Plane
       ├─ Coordinator adapter: MCP tools for multi-session orchestration
       ├─ Worker adapter: RPC stdio for one embedded subprocess
       └─ Editor adapter: ACP stdio for ACP-compatible clients
            ↓
         GJC session, workflows, tools, artifacts, evidence
```

The host should advertise **Agent Control Plane** in product docs and then pick the adapter internally from host shape:

| Adapter role | Backing transport | Use when | Start command |
| --- | --- | --- | --- |
| Coordinator adapter | MCP | The host coordinates one or more GJC sessions, repo/worktree lanes, questions, artifacts, and durable turn status. | `gjc mcp-serve coordinator` |
| Worker adapter | RPC stdio | The host embeds one GJC worker process and owns stdin/stdout JSONL directly. | `gjc --mode rpc` |
| Editor adapter | ACP stdio | The host is an ACP-compatible editor/client that owns ACP session, file, terminal, permission, and elicitation bridges. | `gjc --mode acp` or `gjc acp` |

Bridge HTTPS is not part of the default Agent Control Plane packaging today. It remains experimental protocol scaffolding with session-control endpoints fail-closed by default.

For readiness status and lower-level protocol details, see [`external-control-readiness.md`](./external-control-readiness.md), [`bot-integration.md`](./bot-integration.md), [`rpc.md`](./rpc.md), and [`hermes-mcp-bridge.md`](./hermes-mcp-bridge.md).

## Shared setup

1. Install and smoke-test GJC:

```sh
bun install -g gajae-code
gjc --version
gjc --smoke-test
```

2. Confirm provider credentials in the same environment that will launch the agent worker.
3. Pick a narrow repository/worktree root. Avoid broad allowlists such as `/`, `/home`, or a whole user directory.
4. Keep workflow prompts explicit: `/skill:deep-interview` for ambiguity, `/skill:ralplan` for planning, `gjc ultragoal ...` for durable execution, and `gjc team ...` only when tmux workers materially help.

## Default adapter: Coordinator MCP

Use the Coordinator adapter when the host is an orchestrator, bot, scheduler, or any control plane that may need multiple sessions or durable reports.

### One-shot check

```sh
gjc mcp-serve coordinator --check --json
```

This proves the control-plane server boots and advertises its tool contract without requiring provider credentials.

### MCP server config

A generic MCP client can launch the control plane with this shape:

```json
{
  "mcp_servers": {
    "gjc_agent_control": {
      "command": "gjc",
      "args": ["mcp-serve", "coordinator"],
      "env": {
        "GJC_COORDINATOR_MCP_WORKDIR_ROOTS": "/abs/path/to/repo:/abs/path/to/worktrees",
        "GJC_COORDINATOR_MCP_MUTATIONS": "sessions,questions,reports",
        "GJC_COORDINATOR_MCP_PROFILE": "agent-host",
        "GJC_COORDINATOR_MCP_REPO": "repo-name",
        "GJC_COORDINATOR_MCP_SESSION_COMMAND": "gjc --worktree"
      }
    }
  }
}
```

Mutation is double-gated: the server must opt in through `GJC_COORDINATOR_MCP_MUTATIONS`, and each mutating tool call must pass `allow_mutation: true`.

### Generated Hermes-compatible config

For clients that consume Hermes-style MCP config, render it instead of hand-writing env blocks:

```sh
gjc setup hermes --root /abs/path/to/repo --profile agent-host --repo repo-name --smoke --json

gjc setup hermes \
  --root /abs/path/to/repo \
  --profile agent-host \
  --repo repo-name \
  --mutation sessions,questions,reports \
  --profile-dir /abs/path/to/profile \
  --install
```

### Minimal control-plane lifecycle

1. Start or register a session with `gjc_coordinator_start_session` or `gjc_coordinator_register_session`.
2. Send a bounded prompt with `gjc_coordinator_send_prompt` and store the returned `turn_id`.
3. Poll or wait with `gjc_coordinator_read_turn` / `gjc_coordinator_await_turn`.
4. Answer pending questions with `gjc_coordinator_list_questions` and `gjc_coordinator_submit_question_answer`.
5. End the turn with `gjc_coordinator_report_status` using `completed`, `failed`, or `cancelled` plus evidence paths.
6. Read artifacts/reports through `gjc_coordinator_list_artifacts`, `gjc_coordinator_read_artifact`, and `gjc_coordinator_read_coordination_status`.

## Embedded-worker adapter: RPC stdio

Use the Worker adapter when the agent host wants one GJC subprocess and direct JSONL control under the same Agent Control Plane concept.

```sh
gjc --mode rpc --provider anthropic --model claude-sonnet-4-5
```

The process emits a `ready` frame before accepting commands. Hosts send commands over stdin and read events over stdout. The typed Python client is the easiest integration path:

```python
from gjc_rpc import RpcClient, WorkflowGate

with RpcClient(no_session=True, no_rules=True) as client:
    client.install_headless_ui()

    def on_gate(gate: WorkflowGate) -> None:
        if gate.kind == "approval":
            client.respond_gate(gate.gate_id, {"decision": "approve"})

    client.on_workflow_gate(on_gate)
    turn = client.prompt_and_wait("Inspect this repository and summarize the setup contract.")
    print(turn.require_assistant_text())
```

Use RPC host tools and host URI schemes when the agent needs controlled access to issue trackers, databases, or artifact stores. Keep long-lived credentials in the host and return only the bounded data GJC needs.

## Editor/client adapter: ACP stdio

Use the Editor adapter when the caller is an ACP-compatible editor or agent client. GJC speaks ACP over stdio:

```sh
gjc --mode acp
# or
gjc acp
```

ACP is client-driven: the ACP client owns initialization, session creation/loading, prompt submission, client-provided MCP servers, permission responses, file bridges, terminal bridges, and elicitation responses. It is the right fit for editor-style integrations, not for generic multi-session bot orchestration.

A generic ACP launcher entry should point at `gjc` with one of these argument lists:

```json
{
  "command": "gjc",
  "args": ["--mode", "acp"],
  "cwd": "/abs/path/to/repo"
}
```

or:

```json
{
  "command": "gjc",
  "args": ["acp"],
  "cwd": "/abs/path/to/repo"
}
```

Provider credentials, model selection, project cwd, and client-owned MCP servers remain the ACP client's responsibility.

## Verification checklist

Run provider-independent checks before live model smokes:

```sh
gjc mcp-serve coordinator --check --json
bun test packages/coding-agent/test/coordinator-mcp.test.ts
bun test packages/coding-agent/test/rpc-unattended-stdio.test.ts packages/coding-agent/test/rpc-client.start.test.ts
bun test packages/coding-agent/test/acp-initialize-conformance.test.ts packages/coding-agent/test/acp-stdout-hygiene.test.ts
```

Optional live smoke after credentials are configured:

1. Start the selected adapter from the target repo/worktree.
2. Send a tiny prompt such as `Reply with exactly GJC-LIVE-OK`.
3. Confirm completion through the adapter's terminal event or status report.
4. Record command, cwd, model/provider, and evidence path in the host-side audit log.

## Failure handling

| Failure | Correct response |
| --- | --- |
| MCP mutation denied | Add the required mutation class and per-call `allow_mutation: true`, or keep the client read-only. |
| Active turn already exists | Poll/await the active turn, enqueue with `queue: true`, or supersede with `force: true` only under explicit host policy. |
| Await timeout | Treat as non-terminal. Read status/tail/turn again; do not mark failure from timeout alone. |
| Provider/auth error | Report `failed` with the provider error and evidence; do not retry forever without a budget. |
| Pending question/gate | Answer the advertised schema explicitly; do not synthesize destructive approvals unless host policy permits it. |
| Host shutdown | Persist session id and turn id, then recover with read/status calls before sending new work. |

## Security boundaries

- Keep provider keys and GitHub tokens out of prompts.
- Prefer host tools, host URI schemes, or sidecars for credentialed external writes.
- Narrow `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` and namespace profiles/repos for multi-tenant hosts.
- Treat `.gjc/` as local runtime state and evidence, not a public blob dump.
- Present GJC externally as one Agent Control Plane; mention MCP/RPC/ACP only as adapter choices for concrete host shapes.
