# RPC SDK — Capability Authorization Mini-Spec (Phase 1)

Replaces today's filesystem-`0600`-only UDS hardening (`rpc-socket-security.ts`) and
per-session notification token (`crates/gjc-notifications/src/discovery.rs`,
`server.rs`) with a capability model that must not be weaker than either. This is a
**Phase 1 prerequisite**: no transport implementation (Phase 3) starts until this is
approved.

## Principal derivation
- **UDS, Linux:** `SO_PEERCRED` → `principal = unix:uid:gid:pid` (+ executable
  metadata where trustworthy).
- **UDS, macOS/BSD:** `getpeereid` → `principal = unix:uid:gid` (+ process metadata
  where available).
- **Unsupported peer-credential platforms:** fail closed for daemon-wide sockets.
  Development fallback is an explicit opt-in local bearer mode (private socket dir,
  `0600` grant files, audit warning) and is NOT sufficient for default all-session
  access.
- **Native in-process TUI:** `principal = native_tui:self` with implicit
  session-local grants for the active UI session only — no enumeration by default.
- **Windows / non-unix:** out of scope this effort (no named-pipe transport).

## GrantRecord
Stored at `.gjc/state/rpc-sdk/grants/<grantId>.json` (dir `0700`, files `0600`):

```jsonc
{
  "version": 1,
  "grantId": "g_01J...",
  "principalBinding": { "kind": "unix", "uid": 501, "gid": 20, "pid": 1234 },
  "bearerHash": "sha256:...",          // when bearer fallback is used
  "issuedAt": "<iso>", "expiresAt": "<iso>", "renewableUntil": "<iso>", "revokedAt": null,
  "issuer": "cli|tui|admin", "purpose": "string",
  "sessions": ["019ef..."] ,            // explicit ids, or "all" only with admin issuer
  "scopes": ["subscribe","read","control","gate_answer","host_tool_result",
             "host_uri_result","host_tool_register","host_uri_register","enumerate","admin"],
  "redactionPolicy": "full|redacted|metadata_only",
  "limits": { "maxSessions": 8, "maxQueue": 1024, "maxReplay": 4096 },
  "audit": { "lastUsedAt": "<iso>", "denialCount": 0, "renewalCount": 0 }
}
```

## Scope matrix
| scope | grants |
|-------|--------|
| `subscribe` | receive live frames for listed sessions (after redaction); no replay |
| `read` | replay/history/state reads for listed sessions; stream replay also needs `subscribe` |
| `control` | send mutating commands for listed sessions |
| `gate_answer` | workflow-gate / notification action replies for listed sessions |
| `host_tool_result` / `host_uri_result` | answer host-tool / host-URI requests for listed sessions + registered ids |
| `host_tool_register` / `host_uri_register` | register definitions / schemes |
| `enumerate` | list session metadata — **separate** from all-session subscribe/read/control |
| `admin` | issue/revoke grants, daemon control, `sessions:"all"` |

## Authz check order (fail closed)
1. Authenticate connection, derive principal.
2. Resolve grant; reject expired / revoked / principal-mismatched.
3. On `hello`: authorize requested capabilities + session filters; `enumerate`
   denied unless granted.
4. **Before scheduling** any command: authorize session + command scope. Denial
   happens before side effects and before the RuntimePort.
5. **Before broker reply/result/cancel:** authorize session + broker scope +
   correlation ownership.
6. **Before replay:** authorize `subscribe`/`read`; apply redaction immediately
   before enqueueing replay frames.
7. **Before live fanout:** authorize `subscribe`/`read`; apply redaction immediately
   before transport send.
8. Log every denial: connection, principal, grant, scope, session, frame kind/type,
   correlationId, deny reason. Never log bearer tokens or redacted content.

## Issuance / renewal / revocation
- Bootstrap grants issued by local CLI or native-TUI setup after proving local user
  ownership of the private state dir.
- Headless automation requests a grant via an explicit local command that prints the
  bearer once and stores only a hash.
- Finite default lifetime; renewal requires unrevoked grant + matching principal.
- Revocation writes `revokedAt` and updates an in-memory deny cache; revoked grants
  deny immediately before scheduling, broker handling, replay, and fanout.

## Required negative tests (Phase 4/5 gate)
`authz_cross_session_subscribe_denied`, `authz_enumeration_without_grant_denied`,
`authz_read_without_subscribe_denied`, `authz_control_without_control_denied`,
`authz_gate_answer_denied`, `authz_host_tool_result_denied`,
`authz_host_uri_result_denied`, `authz_revoked_grant_denied_everywhere`,
`authz_redacts_live_and_replay_frames`.
