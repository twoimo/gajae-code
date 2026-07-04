# External control surface readiness

This document classifies every public GJC surface that an external controller, bot, editor, or harness can use to drive `gjc`. It is intentionally narrower than the generic bot guide: it states what is ready today, what is editor/client-oriented, and what smoke coverage exists.

## Readiness matrix

| Surface | Current readiness | Primary command | Use when | Do not use when | Provider-independent smoke path |
| --- | --- | --- | --- | --- | --- |
| Coordinator MCP | Preferred multi-session bot/control-plane surface. | `gjc mcp-serve coordinator` | A controller needs to start/register GJC sessions, send bounded turns, answer questions, read artifacts, and write durable status reports across one or more repo/worktree lanes. | The controller only needs one embedded subprocess and can own stdio directly. | `gjc mcp-serve coordinator --check --json`; `packages/coding-agent/test/coordinator-mcp.test.ts`; `packages/coding-agent/test/setup-cli.test.ts`. |
| App-server JSON-RPC | Stable subprocess worker and Codex-compatible protocol surface. | `gjc app-server` or `gjc --mode app-server` | A host embeds one GJC worker process, sends JSON-RPC 2.0 requests over stdio or a local app-server socket, consumes codex-shaped turn/item notifications, and optionally uses strict `gjc/*` extension methods. | The host needs multi-session orchestration or MCP tool discovery; use Coordinator MCP for those. | `packages/coding-agent/test/app-server-host.test.ts`; `packages/coding-agent/test/harness-control-plane/app-server-detached-owner.test.ts`; `packages/coding-agent/test/agent-wire/agent-wire-handshake.test.ts`. |
| ACP mode | Editor/ACP client surface with tested protocol initialization, session lifecycle, client-owned MCP, file/terminal client bridges, permission routing, and stdout hygiene. | `gjc --mode acp` or `gjc acp` | An editor or ACP-compatible client wants to drive GJC through the Agent Client Protocol over stdio. | A bot needs a generic multi-session control plane; use Coordinator MCP instead. | `packages/coding-agent/test/acp-initialize-conformance.test.ts`; `packages/coding-agent/test/acp-stdout-hygiene.test.ts`; `packages/coding-agent/test/acp-lazy-startup.test.ts`; `packages/coding-agent/test/acp-mcp-isolation.test.ts`; `packages/coding-agent/test/read-acp-fs.test.ts`; `packages/coding-agent/test/write-acp-fs.test.ts`; `packages/coding-agent/test/bash-acp-terminal.test.ts`. |

## Surface details

### Standalone TUI and MCP inheritance

Normal standalone GJC (`gjc`, `gjc --tmux`, and print-mode prompts) does not inherit Claude Code, Codex, Cursor, Gemini, Windsurf, or other tools' MCP servers as a public startup contract. It also does not expose a supported standalone-TUI setting that automatically imports arbitrary MCP servers for the model. See [Standalone GJC MCP support](./standalone-mcp.md) for the user-facing boundary and workarounds.

### Coordinator MCP

Coordinator MCP is the default answer for external bot and orchestration integrations. It exposes a transport-level MCP tool contract for session discovery, managed session start, visible tmux registration, prompt delivery, bounded turn waiting, structured question answering, artifact reads, and explicit completion/failure/cancellation reports.

Readiness claim:

- Ready as the preferred generic external-controller control plane.
- Provider-independent contract checks exist for server metadata, tool discovery, read-only defaults, mutation gates, setup rendering, and dry-run lifecycle behavior.
- It is not a provider/model contract. Live model execution remains the operator's environment-specific smoke.

Primary references:

- `docs/bot-integration.md`
- `docs/hermes-mcp-bridge.md`
- `packages/coding-agent/src/coordinator/contract.ts`
- `packages/coding-agent/src/coordinator-mcp/server.ts`

### App-server JSON-RPC

App-server is the stable embedded-worker surface. It speaks JSON-RPC 2.0 over stdio by default and can also expose local socket transports through discovery metadata. Hosts initialize the connection, create or resume a thread, submit turns, and observe codex-shaped lifecycle notifications.

Readiness claim:

- Ready for single-process host integration, harness control, and Codex-compatible local clients.
- Codex-core methods are lenient for unsupported experimental fields; `gjc/*` extension methods are strict.
- Multi-session orchestration and MCP tool discovery are out of scope; use Coordinator MCP for those.

Primary references:

- `docs/app-server.md`
- `schemas/app-server.schema.json`
- `crates/gjc-app-server/`
- `packages/coding-agent/src/modes/app-server/`
- `packages/coding-agent/src/harness-control-plane/app-server-adapter.ts`

### ACP mode

ACP mode runs GJC as an Agent Client Protocol server over stdio. It is useful for editor-style clients that own the ACP transport and want session creation, session load/fork/resume/close metadata, prompt handling, client-provided MCP servers, permission prompts, editor file reads/writes, terminal-backed bash, and elicitation support.

Readiness claim:

- ACP is implemented and covered for current editor/client contracts: initialize conformance, agent capability advertisement, lazy startup, stdout JSON-RPC hygiene, client-owned MCP isolation, event mapping, file bridge routing, terminal routing, and permission routing.
- ACP is not the preferred bot control-plane surface. It is not positioned as a multi-session external bot coordinator, and it does not replace Coordinator MCP reports/artifacts/turn state.
- A real prompt still depends on the selected provider/model credentials, so required PR smokes should stay on provider-independent initialize, lifecycle, and mapper tests.

Current entrypoints:

```sh
gjc --mode acp
# equivalent ACP subcommand for ACP clients that prefer command-style launch
gjc acp
```

For Zed custom-agent setup, add a custom `agent_servers` entry that launches the same stdio server explicitly:

```json
{
  "agent_servers": {
    "gjc": {
      "type": "custom",
      "command": "gjc",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Zed owns the ACP client connection and may forward editor-owned MCP servers over ACP; GJC keeps this isolated from standalone `.mcp.json` discovery and only starts ACP behavior through the explicit entrypoint.

Primary references:

- `packages/coding-agent/src/commands/acp.ts`
- `packages/coding-agent/src/modes/acp/acp-mode.ts`
- `packages/coding-agent/src/modes/acp/acp-agent.ts`
- `packages/coding-agent/src/modes/acp/acp-client-bridge.ts`
- `packages/coding-agent/src/modes/acp/acp-event-mapper.ts`

## PR smoke checklist

For external-control PRs, use this provider-independent checklist before any optional live provider smoke:

1. **Docs-to-code alignment:** the readiness matrix still matches CLI mode parsing, MCP command registration, ACP command registration, app-server entrypoints, and focused tests.
2. **Coordinator MCP:** `gjc mcp-serve coordinator --check --json` still reports the coordinator server and tool list, and focused MCP tests pass without provider credentials.
3. **App-server:** app-server protocol, harness-adapter, and neutral agent-wire tests prove JSON-RPC startup/command routing without a real provider key.
4. **ACP mode:** initialize/stdout or conformance tests prove the ACP JSON-RPC entrypoint and capability advertisement without a real provider key.
5. **Local leak audit:** deliverable docs/tests must not contain private profile names, user-home paths, callback artifact paths, local proxy names, terminal app names, or private launch wrappers.

Optional live smokes are useful diagnostics for one operator's model/profile/network setup, but they must not be required for PR readiness unless the PR explicitly changes live provider behavior.
