# Human-visible GJC tmux sessions

A tmux-hosted GJC TUI is a **human-only terminal surface**. It is not an external control or viewing API.

Hermes, OpenClaw, Clawhip, chatops bots, and any other external controller must use Coordinator MCP, ACP, or the Gajae-Code SDK. They must not inject prompts, scrape pane output, or use tmux state as workflow evidence.

## Human operator use

A human operator may start an interactive TUI in a dedicated worktree for local terminal visibility:

```sh
./scripts/gjc-session/create.sh <session-name> <worktree-path> [channel-id] [mention]
```

The person at that terminal interacts with the TUI directly. The helper preserves lifecycle metadata for local troubleshooting; it does not create an API for another process to submit prompts or read the conversation.

For external automation, use the canonical interfaces:

- Coordinator MCP for bounded workflow control, turn status, questions, and reports.
- ACP for an ACP client over the SDK-backed session surface.
- The Gajae-Code SDK for authenticated lifecycle, control, and query operations.

## Boundaries

- Keep visible work in a dedicated worktree, never the shared canonical checkout.
- Treat tmux existence and terminal output as human-only diagnostics, not machine acceptance or completion evidence.
- Use SDK turn status and lifecycle events for every external decision, notification, and audit record.
- Keep channel IDs, mentions, tokens, and routing configuration in the host deployment rather than portable documentation.
