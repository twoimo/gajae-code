# OpenClaw / Hermes RPC integration notes

GJC's supported integration boundary for OpenClaw- or Hermes-style hosts is the daemon RPC transport, not direct imports from runtime MCP internals or the removed standalone RPC subprocess.

## Recommended boundary

Use the daemon SDK and daemon-supervised worker:

- `@gajae-code/rpc-sdk` to connect to `gjc-rpc-daemon`.
- Daemon host-tool commands to expose host-owned tools.
- Daemon event subscriptions to observe lifecycle, tool, and approval frames.

OpenClaw/Hermes should map their own tools, MCP servers, and skills into daemon RPC host tools. From GJC's point of view those are just host-owned tools; the host remains responsible for policy, credentials, approvals, and process lifetime.

## MCP and skills mapping

Treat MCP as a host implementation detail:

1. OpenClaw/Hermes discovers its MCP servers and skills.
2. The host converts selected capabilities into daemon RPC host tools.
3. GJC calls those tools through `host_tool_call` frames.
4. The host executes the real MCP/skill operation and returns `host_tool_result`.

This avoids leaking host credentials or policy decisions into GJC and lets OpenClaw keep its own approval, sandbox, and skill-loading rules.

## What not to import

Do not import these package paths from integrations:

- `@gajae-code/coding-agent/runtime-mcp`
- `@gajae-code/coding-agent/mcp`
- `@gajae-code/coding-agent/capability/mcp`
- `@gajae-code/coding-agent/config/mcp-schema`
- `@gajae-code/coding-agent/discovery/mcp-json`

Those paths are intentionally quarantined in `packages/coding-agent/package.json` and enforced by `scripts/verify-g002-gates.ts`. If an integration needs MCP functionality, expose it as a host-owned daemon RPC tool instead of depending on those internals.

## Practical host-tool shape

Good first OpenClaw/Hermes bridge tools are small and policy-preserving:

- `openclaw_skill_search({ query })`
- `openclaw_skill_read({ name })`
- `openclaw_mcp_call({ server, tool, input })`
- `hermes_route_message({ target, message })`

Keep destructive or external-write actions behind the host's own approval flow. When a host tool starts long-running work, stream progress so GJC can surface the state without polling the host directly.

## Verification checklist

Before claiming an integration works:

1. `gjc --help` or `bun packages/coding-agent/src/cli.ts --help` starts without native/package resolution errors.
2. A host tool can be registered through the daemon route.
3. GJC emits `host_tool_call` for that tool.
4. The host returns `host_tool_result` and GJC emits `tool_execution_end`.
5. Direct imports from quarantined MCP paths still fail.

`packages/coding-agent/test/rpc-host-tools.test.ts` covers the host-tool flow and is the reference test for OpenClaw/Hermes bridge work.
