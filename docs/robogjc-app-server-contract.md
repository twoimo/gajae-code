# robogjc app-server contract

This document fixes the Phase 0 host-tool and metadata contract between robogjc and `gjc-app-server`.

## Host-tool wire frames

Client→server request:

```json
{
  "method": "gjc/hostTools/set",
  "params": {
    "threadId": "<thread id>",
    "tools": [
      {
        "name": "<tool name>",
        "description": "<tool description>",
        "inputSchema": {},
        "resultPolicy": {},
        "redactionHints": {}
      }
    ]
  }
}
```

Rules:

- The `params` shape is exactly `{threadId, tools:[{name, description, inputSchema, resultPolicy?, redactionHints?}]}`.
- The server applies a strict `gjc/*` field policy: only the documented `gjc/hostTools/*` methods and documented frame fields are accepted.
- The registry lifetime is per thread. Replacing a thread's tools does not leak registrations into another thread.
- The response is exactly `{}`.

Server→client notification frames:

```json
{
  "method": "gjc/hostTools/call",
  "params": {
    "threadId": "<thread id>",
    "generation": 0,
    "turnId": "<turn id>",
    "callId": "<call id>",
    "tool": "<tool name>",
    "args": {}
  }
}
```


```json
{
  "method": "gjc/hostTools/cancel",
  "params": {
    "threadId": "<thread id>",
    "generation": 0,
    "turnId": "<turn id>",
    "callId": "<call id>"
  }
}
```

Rules:

- `gjc/hostTools/call` is server→client and has params `{threadId, generation, turnId, callId, tool, args}`.
- `gjc/hostTools/cancel` is server→client with params `{threadId, generation, callId, turnId?}`. Server-originated cancels include `turnId` when the pending call was associated with a known turn.

Client→server progress request:

```json
{
  "method": "gjc/hostTools/update",
  "params": {
    "threadId": "<thread id>",
    "callId": "<call id>",
    "payload": {}
  }
}
```

Rules:

- `gjc/hostTools/update` is client→server progress and optional, with strict params `{threadId, callId, payload}`. Unknown `callId` returns a structured not-found error; matching calls record the payload as progress for the pending call.

Client→server result request:

```json
{
  "method": "gjc/hostTools/result",
  "params": {
    "threadId": "<thread id>",
    "callId": "<call id>",
    "ok": true,
    "result": {}
  }
}
```

Rules:

- The `params` shape is exactly `{threadId, callId, ok, result?, error?}`.
- Successful results set `ok: true`, require `result`, and forbid `error`.
- Failed results set `ok: false`, require `error:{message, code?}`, and forbid `result`.
- The response is exactly `{}`.

## Redaction boundaries

`redactionHints` are part of tool registration metadata and mark fields or values that must not be exposed in logs, transcripts, progress events, or operator-facing diagnostics. They are metadata only: they do not change the host tool's input schema, result schema, or result success/error semantics.

## Metadata parity and resume semantics

`thread/start` and `thread/resume` params carry optional:

```json
{
  "cwd": "<working directory>",
  "sessionId": "<session id>",
  "sessionDir": "<session dir>",
  "systemPromptAppend": "<additional system prompt>",
  "model": { "provider": "<provider>", "modelId": "<model id>" },
  "thinking": "high",
  "todos": []
}
```

Rules:

- Metadata parity is required: `thread/start` and `thread/resume` both carry the optional `{cwd, sessionId, sessionDir, systemPromptAppend, model:{provider,modelId}, thinking, todos}` fields.
- `thinking` may be either a plain non-empty string or `{ "level": "<level>" }`; only the level string is consumed as the SDK `thinkingLevel` option.
- These fields round-trip through the factory to the backend.
- These fields are preserved on resume.
- True resume means the same `threadId` identity, not a fresh session.
- A fresh-session fallback must be reported in the response as `{resumed:false}`.
- Resume first checks the in-memory registry. Existing `threadId` values reattach the same ThreadEntry, preserve stream/admission/host-tool registry state, bump `generation` monotonically, reject stale events from the previous generation, and report `{resumed:true}` with `thread.generation` visible in the response. Unknown `threadId` values fall back to backend factory resume and report `{resumed:false}`.
