# App-server provider auth design

## Ownership

- `gjc-app-server` owns the strict `gjc/*` RPC surface, lane classification, schema/catalog registration, state transitions, and redaction rules for provider auth DTOs. It returns provider metadata and boolean state only.
- The TypeScript app-server host owns adaptation to existing auth machinery: `packages/ai/src/auth-storage.ts`, `packages/coding-agent/src/session/auth-storage.ts`, and the auth-broker stores. It must call `AuthStorage.remove()` for logout so broker/local stores keep one deletion path.
- `crates/gjc-desktop` owns only OS integration: opening browser URLs and using platform keychain/browser affordances when a future login flow supplies a URL. It must not persist or inspect credential values.
- The GUI renders provider status, environment-variable guidance, and browser-open affordances. It never accepts, stores, displays, logs, or forwards raw credential values.

## Sign-in state machine

Future OAuth sign-in uses a resumable app-server-owned flow:

`idle -> pending-browser -> authenticated | failed | cancelled`

- `start` creates a flow id, stores only non-secret flow metadata, and returns `{ flowId, authUrl, state }` for the desktop shell to open.
- `poll` returns redacted state only and may be called after reconnect; no token, code verifier, refresh token, access token, or fingerprint is ever returned.
- `cancel` marks the flow cancelled and makes later polls terminal.
- A reconnecting GUI resumes by polling known flow ids or by re-reading `gjc/auth/status`.

The current slice ships list/status/logout only. Login start/poll/cancel is deferred because the reusable OAuth entry points still include provider-specific interactive callbacks (`onAuth`, `onPrompt`) and are not yet a clean headless browser flow with a resumable app-server flow registry.

## Sign-out semantics

`gjc/auth/logout` accepts `{ providerId }` and calls the existing `AuthStorage.remove(providerId)` path. That removes the active stored entry/entries for the resolved storage provider from the configured local or broker-backed store. It does not create a second credential store and does not inspect credential payloads.

The audit event is a single redacted line containing only the event name and provider id:

```json
{"event":"gjc.auth.logout","providerId":"anthropic"}
```

No credential bytes, token metadata, fingerprints, email addresses, auth URLs, or database row ids are allowed in the audit event.

## API-key providers: env-var references only

API-key providers are represented as `authKind: "api-key-env"` with an optional `envVar` name. The GUI may tell the user which environment variable to set, but it must not render a raw-key input. This mirrors the TUI boundary in `packages/coding-agent/src/slash-commands/builtin-registry.ts` where raw API-key input is rejected and users are directed to environment-variable references instead.

The API DTO carries the variable name only. It never carries the variable value, a fingerprint, a masked key, or a credential-bearing URL.

## Audit events

- `gjc.auth.logout`: emitted after `AuthStorage.remove(providerId)` is invoked. Fields: `event`, `providerId` only.
- Future `gjc.auth.login.start`: may include `providerId`, `flowId`, and terminal-safe state only; must not include tokens, verifiers, or credentials.
- Future `gjc.auth.login.poll`: may include `providerId`, `flowId`, and state only.
- Future `gjc.auth.login.cancel`: may include `providerId`, `flowId`, and state only.
