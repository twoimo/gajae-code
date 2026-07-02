# Phase 7 — token-free app-server WS `gjc/notifications` parity contract

Goal: let the notifications extension (`packages/coding-agent/src/notifications/`) use the
app-server WS transport as its notification endpoint instead of the legacy native
`NotificationServer` (crates/gjc-notifications), speaking a `gjc/notifications` protocol,
verified with fakes (NO Telegram/Discord/Slack tokens).

The app-server is a dumb pipe; all ask/gate/redaction/verbosity logic stays TS-side.

## Native/Rust API contract (Slice R owns; Slice T consumes via a fake)

### Rust `crates/gjc-app-server/src/server.rs` + new `notifications.rs`
- Route any inbound request whose `method` starts with `gjc/notifications/` to the host via
  the existing inverted-control `onCall` path, using call kind `notifications.<suffix>`
  (e.g. `gjc/notifications/reply` -> kind `notifications.reply`). It is NOT thread-scoped
  (threadId may be absent). Return the host's JSON result as the response.
  - `gjc/notifications/subscribe` (request): also mark the connection as a notifications
    subscriber, then forward to host (host returns replay frames array; server emits each
    as a `gjc/notifications/event` before returning `{ "ok": true }`).
- Add `AppServer::push_notification(&self, frame: serde_json::Value)`: wrap into
  `Notification { method: "gjc/notifications/event", params: Some(frame) }` and emit to the sink.
- Field policy: `gjc/notifications/*` are lenient passthrough (frames are opaque JSON), do NOT
  run strict unknown-field enforcement on them.
- Conformance tests in `crates/gjc-app-server/tests/conformance.rs`: subscribe routes to host +
  returns ok; a pushed notification reaches the sink as `gjc/notifications/event`; reply/userMessage
  route to host with correct kind; frames are opaque (unknown fields preserved).

### pi-natives `crates/pi-natives/src/app_server.rs`
- Add napi method `pushNotification(frameJson: string)` on `AppServer` -> `core.push_notification(parsed)`.
- Ensure `onCall` forwards `notifications.*` kinds (same mechanism as backend.* / factory.*).

### TS `packages/coding-agent/src/modes/app-server/host.ts`
- `AppServerHost` interface: add `notificationCall(method: string, params: unknown): Promise<unknown>`.
- `handleCall`: route `call.kind` starting `notifications.` -> `host.notificationCall(method, params)`.
- `AppServerHandle`: add `pushNotification(frame: unknown): void` -> `server.pushNotification(JSON.stringify(frame))`.

## `gjc/notifications` frame protocol (SDK parity; see docs/notifications-sdk.md)
Server->client (emitted as `gjc/notifications/event`, params = the SDK frame):
  `action_needed` {id,kind:"ask",sessionId,question,options} | {id,kind:"idle",sessionId,summary}
  `action_resolved` {id,resolvedBy:"local"|"client"|"timeout"}
  `reply_rejected` {id,reason}
  optional: `identity_header`,`context_update`,`turn_stream`,`activity`,`session_closed`,`hello`,`pong`
Client->server (`gjc/notifications/<x>`):
  `subscribe` {} -> {ok:true} (+replay of sticky frames)
  `reply` {id,answer,idempotencyKey?} -> {ok:true} | {rejected:reason}
  `userMessage` {sessionId?,text} -> {ok:true}
  `configCommand` {command} -> {ok:true}
  `ping` {} -> {pong:true}

## TS endpoint + client (Slice T owns; uses a fake handle until native lands)
- New `packages/coding-agent/src/notifications/app-server-endpoint.ts`:
  `AppServerNotificationEndpoint` implementing the subset of `NotificationServer` the extension
  in `index.ts` uses: `registerAsk(json, repliable)`, `resolveLocal(id, answerJson?)`,
  `resolveClient(id, answerJson, idempotencyKey?)`, `pushFrame(json)`, `onReply(cb)`, `stop()`,
  `endpointUrl()`/discovery. Backed by `handle.pushNotification(frame)` for outbound and by
  `handle.notificationCall`-routed inbound frames for `reply`/`userMessage`/`configCommand`.
  Maintains action lifecycle: pending map, first-valid-reply-wins, idempotency, action_resolved fanout.
- Wire into `index.ts` behind env flag `GJC_NOTIFICATIONS_APP_SERVER=1`: when set, construct the
  app-server-backed endpoint instead of `new NotificationServer(...)`. Legacy path unchanged by default.
- Unit tests with a fake handle: registerAsk -> action_needed pushed; reply -> onReply fires +
  action_resolved(client); resolveLocal -> action_resolved(local); duplicate reply -> reply_rejected
  already_answered; idempotency key replay; config_command + user_message routing.

## Verification (leader integrates)
- `cargo test -p gjc-app-server`; `bun --cwd=packages/natives run build`; TS unit tests;
  an integration smoke: real AppServer + AppServerNotificationEndpoint over an in-process WS
  subscriber (fake chat adapter) exercising action_needed -> reply -> action_resolved.
</content>
