# gjc-rpc

Thin Python reference client for Gajae Code RPC hosts.

This package intentionally is **not** a maintained full Python SDK. It is a
small reference consumer for hosts that need to drive Gajae Code from Python
while the supported SDK surface remains TypeScript and Rust. It provides:

- a default subprocess JSONL client that starts `gjc --mode rpc-daemon-worker`
- `command=` support for hosts and tests that provide their own RPC subprocess
- an opt-in Unix-domain-socket client for the rpc-sdk daemon GjcFrame v1 transport
- a byte-faithful GjcFrame codec: 4-byte big-endian length prefix plus UTF-8 JSON body
- typed command methods for the stable RPC surface
- typed startup options for both subprocess and daemon socket routes
- typed per-event listeners plus a typed catch-all notification hook
- helpers for collecting prompt runs and handling extension UI requests in manual or headless mode
- typed host-tool helpers so Python RPC owners can expose custom tools with JSON Schema metadata


## Basic Usage

```python
from gjc_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    print(state.model.id if state.model else "no model")

    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

By default `RpcClient` starts a subprocess using `gjc --mode rpc-daemon-worker`
and speaks the JSONL RPC transport over stdin/stdout. Pass `command=` to run a
custom RPC subprocess instead:

```python
from gjc_rpc import RpcClient

with RpcClient(command=["python", "fake_rpc_server.py"]) as client:
    print(client.get_state().session_id)
```

To connect to the rpc-sdk daemon over a Unix domain socket, opt in with
`socket_path=`. The helper `default_daemon_socket_path()` matches the TypeScript
SDK discovery order:

1. `GJC_RPC_DAEMON_SOCKET`, when set
2. `$XDG_RUNTIME_DIR/gjc/rpc-sdk/daemon.sock`, when `XDG_RUNTIME_DIR` is set
3. `.gjc/state/rpc-sdk/daemon.sock` under the current working directory

```python
from gjc_rpc import RpcClient, default_daemon_socket_path

with RpcClient(socket_path=default_daemon_socket_path()) as client:
    print(client.get_state().session_id)
```


The wrapper also exposes the common RPC startup flags directly, so scripts do not
need to build `extra_args` by hand:

```python
from gjc_rpc import RpcClient

with RpcClient(
    model="openrouter/anthropic/claude-sonnet-4.6",
    thinking="high",
    no_session=True,
    no_skills=True,
    no_rules=True,
    tools=("read", "edit", "write"),
    append_system_prompt="Focus on reproducible benchmark behavior.",
) as client:
    print(client.get_state().thinking_level)
```

For orchestration hosts, the wrapper also exposes typed event hooks and a simple
way to seed todos before the first prompt:

```python
from gjc_rpc import MessageUpdateEvent, RpcClient

def on_message_update(event: MessageUpdateEvent) -> None:
    assistant_event = event.assistant_message_event
    if assistant_event.get("type") == "text_delta":
        print(assistant_event["delta"], end="", flush=True)

with RpcClient(model="openrouter/anthropic/claude-sonnet-4.6", no_session=True) as client:
    client.on_message_update(on_message_update)
    client.set_todos(
        [
            "Map the read and edit tool surface.",
            "Exercise the supported edit paths.",
            "Write concrete findings and gaps.",
        ]
    )
    client.prompt_and_wait("Evaluate the current tool behavior.")
```

`set_todos()` accepts either a flat list of todo strings/items or explicit
phases, and `get_state().todo_phases` returns the typed current todo state.

For advanced subprocess orchestration, pass an explicit `command=`:

```python
from gjc_rpc import RpcClient

with RpcClient(
    command=[
        "bun",
        "packages/coding-agent/src/cli.ts",
        "--mode",
        "rpc",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
    ],
) as client:
    print(client.get_state().session_id)
```

Use `socket_path=` only when a daemon is already running and you want the UDS
route instead of spawning a subprocess.

## Host-Owned Custom Tools

RPC hosts can expose custom tools to the agent with JSON Schema metadata. The
Python helper keeps the wire format simple while still giving the handler a
typed signature:

```python
from typing import TypedDict

from gjc_rpc import RpcClient, host_tool


class EchoArgs(TypedDict):
    message: str


def echo_host(args: EchoArgs, context) -> str:
    context.send_update(f"working:{args['message']}")
    return f"host:{args['message']}"


with RpcClient(
    no_session=True,
    custom_tools=(
        host_tool(
            name="echo_host",
            description="Echo a value from the Python host",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
            execute=echo_host,
        ),
    ),
) as client:
    client.prompt_and_wait("Use the echo_host tool with the value hello")
```

If you want runtime conversion into a richer Python type, pass `decode=` to
`host_tool(...)`. That lets you keep the JSON Schema contract on the wire while
parsing the incoming argument object into a dataclass or model in the handler.

## Host-Owned URI Schemes

Hosts can also expose custom URL schemes that behave like virtual files.
Registered schemes are routed through the agent's `read` (and `write`) tools
over the same RPC transport — handlers do the actual I/O on the Python side:

```python
from gjc_rpc import RpcClient, host_uri

rows: dict[str, str] = {"42": "id=42\nname=Alice\n"}


def read_row(url: str, _ctx) -> str:
	row_id = url.removeprefix("db://users/")
	return rows[row_id]


def write_row(url: str, content: str, _ctx) -> None:
	row_id = url.removeprefix("db://users/")
	rows[row_id] = content


with RpcClient(
	no_session=True,
	host_uris=(
		host_uri(
			scheme="db",
			description="Virtual db row files",
			read=read_row,
			write=write_row,
		),
	),
) as client:
	client.prompt_and_wait("Read db://users/42 and rewrite it with name=Bob")
```

Schemes registered as read-only (no `write=`) reject `write` calls with a
clear error. The agent's `edit` tool does not target host URIs — hosts that
want mutation expose `write` and the model uses the `write` tool with the
full replacement content.

## Extension UI Requests

Extensions in RPC mode can ask the host for input. Those requests are available as
typed `ExtensionUiRequest` instances:

```python
request = client.next_ui_request(timeout=5.0)

if request.method == "confirm":
    client.send_ui_confirmation(request.id, True)
elif request.method in {"input", "editor"}:
    client.send_ui_value(request.id, "approved")
```

For non-interactive scripts, you can install a default headless policy instead of
handling every request manually:

```python
with RpcClient(model="anthropic/claude-sonnet-4-5") as client:
    client.install_headless_ui()
    turn = client.prompt_and_wait("needs ui-safe automation")
    print(turn.assistant_text)
```

That helper ignores passive UI notifications (`notify`, `setStatus`, `setWidget`,
`setTitle`, `set_editor_text`), answers `confirm` with `False`, and cancels
`select`/`input`/`editor` requests unless you provide explicit values.

## Error Handling and Retained History

The client now surfaces more of the transport edge cases that the wire protocol
allows:

- id-less `parse` and unknown-command failures are correlated back to the
  waiting request when they can be matched unambiguously
- late `prompt` / `abort_and_prompt` scheduling failures cause
  `prompt_and_wait()` and `wait_for_idle()` to raise instead of timing out
- unmatched background error responses are exposed through
  `client.protocol_errors` and `client.on_protocol_error(...)`
- listener exceptions no longer kill the stdout reader thread; they are exposed
  through `client.listener_errors` and `client.on_listener_error(...)`

For long-lived hosts, retained event and stderr history is bounded by default:

```python
from gjc_rpc import RpcClient

with RpcClient(max_event_history=20_000, max_stderr_chunks=256) as client:
    ...
```

If a single prompt streams more events than `max_event_history` allows,
`prompt_and_wait()` raises a clear error so hosts can increase the limit instead
of silently losing earlier events.

Prompt lifecycle collection is intentionally single-flight. Only one of
`prompt_and_wait()`, `wait_for_idle()`, or `collect_events()` may be active at a
time on a client instance. If a host needs concurrent orchestration, use
separate `RpcClient` instances instead of overlapping lifecycle waiters on one
session.

## Text Helpers

`assistant_text()` and `message_text()` now return visible text blocks only.
If a host explicitly needs reasoning text too, use the `*_with_thinking`
helpers:

```python
from gjc_rpc import assistant_text, assistant_text_with_thinking

visible = assistant_text(message)
full = assistant_text_with_thinking(message)
```

## Event Frames

AgentSession events are delivered as canonical `event` frames inside daemon GjcFrame payloads:

```json
{ "type": "event", "protocol_version": 2, "session_id": "…", "seq": 1, "frame_id": "…",
  "payload": { "event_type": "tool_execution_start", "event": { "type": "tool_execution_start", … } } }
```

`seq` is monotonic per session (starting at 1). The client unwraps these
automatically: typed listeners (`on_agent_start`, `on_tool_execution_start`,
`on_message_update`, …) and the generic event hook receive the **inner** event,
not the envelope. Non-event frames (`ready`, `response`, `workflow_gate`,
`extension_ui_request`, `extension_error`, host tool/URI requests) stay flat.

## Protocol Reference

The canonical wire protocol still lives in the repo at
[`docs/rpc.md`](../../docs/rpc.md).
