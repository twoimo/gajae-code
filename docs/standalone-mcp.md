# Standalone MCP configuration

`gjc mcp add` writes only the definition supplied on that invocation to GJC's own MCP config (`~/.gjc/agent/mcp.json` by default, or `./.gjc/mcp.json` with `--project`). It does not read other tools' live configurations. `gjc mcp list` and `gjc mcp remove` print redacted definitions.

## Supported integrations

| Need | Use | Notes |
| --- | --- | --- |
| External bot or multi-session controller | [Coordinator MCP](./hermes-mcp-bridge.md) | Coordinator MCP exposes GJC lifecycle and coordination tools. |
| External session control | [SDK machine interface](./sdk.md) | The SDK WebSocket protocol is the only external control interface. |
| Editor/ACP client owns MCP servers | ACP via `gjc --mode acp` or `gjc acp` | ACP remains a stdio editor protocol. |
| Codex / Claude Code delegation plugin | [Canonical gajae-code plugin](./hermes-mcp-bridge.md) | Installs Coordinator MCP plus GJC delegation commands. |

## Boundary

Standalone GJC does not inherit arbitrary MCP server configurations from Claude Code, Codex, OpenCode, or other tools. MCP servers often carry credentials, filesystem reach, browser state, approval semantics, and lifecycle that belong to the configuring host.

`--mode rpc`, `--mode rpc-ui`, and `--mode bridge` have been removed. Do not use the former RPC host-tool protocol to connect an MCP server; use the [SDK machine interface](./sdk.md) for supported external session control.

## Related docs

- [SDK machine interfaces](./sdk.md)
- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)
