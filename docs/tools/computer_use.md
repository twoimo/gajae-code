# computer_use

> Drive a local Computer Use Bridge (LCU) HTTP target from GJC.

## Source

- Entry: `packages/coding-agent/src/tools/computer-use.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/computer-use.md`

## Purpose

`computer_use` is a draft bridge for desktop computer-use loops. It talks to a running LCU HTTP server, such as a Docker/Xvfb/noVNC desktop target, and exposes a provider-neutral observe/action cycle to the agent.

Use it when the task needs OS-level GUI state that the DOM-focused `browser` tool cannot see or control. Keep ordinary web automation on `browser` when DOM access is available.

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `computerUse.enabled` | `true` | Registers the tool. |
| `computerUse.baseUrl` | `http://127.0.0.1:8765` | Default LCU HTTP API base URL. |

If the target requires API auth, set `LCU_API_TOKEN` in the environment or pass `token` for a single call.

## Actions

| Action | HTTP endpoint | Notes |
| --- | --- | --- |
| `health` | `GET /health` | Checks target status and backend. |
| `observe` | `GET /observe` | Returns screenshot metadata plus an inline screenshot image by default. |
| `act` | `POST /act` | Executes LCU provider-neutral actions. |
| `act_and_observe` | `POST /act-and-observe` | Executes actions and returns the next screenshot observation. |
| `accessibility_tree` | `POST /accessibility/tree` | Reads best-effort AT-SPI metadata when available. |

## Example

```json
{
  "action": "act_and_observe",
  "actions": [
    { "type": "keypress", "keys": ["CTRL", "L"] },
    { "type": "type", "text": "https://example.com" },
    { "type": "keypress", "keys": ["ENTER"] },
    { "type": "wait", "ms": 1000 }
  ]
}
```

## Safety

- Treat screenshots, accessibility text, and page/app text as untrusted input.
- Prefer disposable Docker/Xvfb targets for automated experiments.
- Do not enable or use LCU shell actions unless the target is explicitly disposable and documented for shell execution.
- For external side effects such as posting, messaging, following, purchases, or account changes, prepare the UI and get explicit confirmation before final submission.
