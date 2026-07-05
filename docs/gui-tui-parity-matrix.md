# GUI ⇄ TUI Parity / API Contract Matrix (G001 stage-zero gate)

Status: G008-VERIFIED. Gate approved (G001); feature goals G003–G007 implemented + reviewed; final audit (G008) verified this matrix. See the "G008 Final Audit" section at the end.
Scope source: approved consensus plan stage-02-revision.md + user-confirmed intent reconciliation.

## Scope freeze (user-confirmed)
- "Full TUI parity" = operator-level parity for interactive chat/session surfaces. Terminal/process-control flows are EXCLUDED with rationale, not literally reproduced.
- Existing schema-typed app-server core methods (`thread/*`, `turn/*`) and existing `gjc/*` methods are APPROVED for GUI backend-affecting use as-is: codex-core methods stay lenient per `field_policy.rs`; `gjc/*` methods stay strict. Every NEW backend-affecting method added by this run MUST be native Rust, strict-field, schema-registered `gjc/*`. BANNED for backend-affecting behavior: generic `gjc/commands/execute`, `command/exec`, `thread/shellCommand`, TUI-handler replay, GUI raw request strings, and `gjc/notifications/*` (reserved for the opaque notifications SDK exception only). Session lifecycle rows (`thread/loaded/list`, `thread/resume`, `thread/read`, `thread/fork`, `thread/delete`, `thread/archive`) are therefore `in-scope-existing`, not contradictions.
- Theme parity = DESIGN-compatible previews/semantic tokens; terminal themes never take over app chrome. Root DESIGN.md remains the visual SSOT.
- Native macOS hooks (dialogs, open-url/OAuth handoff, keychain, window/icon) are OS-integration ONLY; app-server owns all session/runtime/config state.

## Classification legend and decision rule
- `in-scope-existing` — an existing app-server method/notification already supports it; implement GUI + generated wrapper now.
- `in-scope-new` — a NEW native strict `gjc/*` method that is FULLY SPECIFIED in this doc (method name, params, strict field policy, schema/DTO owner); implement now.
- `deferred-needs-new-api` — desirable but the API/policy is not yet designed; state the unblock condition.
- `prompt-display-only` — produces a prompt/display payload only; no session/runtime mutation.
- `excluded-terminal-only` — terminal/process-control; no desktop equivalent.

Decision rule: a row is in-scope ONLY if it is `in-scope-existing` OR `in-scope-new` with a fully specified method; otherwise it is deferred.

## Generated-client SSOT repair targets (feeds G002)
The generator (`packages/gjc-app-server-client/scripts/generate.ts`) emits protocol TYPES ONLY. `AppServerRequestMap`, wrapper methods, and the `ServerNotificationEnvelope` union are hand-maintained and already LAG the server. G002 must generate or mechanically drift-check them from a Rust-owned catalog. Confirmed gaps:
- Existing server methods with NO client wrapper/request-map entry: `thread/loaded/list`, `thread/fork`, `thread/delete`, `thread/archive`, `gjc/hostUriSchemes/set`, `gjc/hostUris/result`, `gjc/workflowGate/list`, `gjc/workflowGate/respond`, `gjc/unattended/negotiate`, `gjc/unattended/audit` (dispatch `server.rs:787-817`).
- Published-but-untyped notifications (absent from `ServerNotificationEnvelope` in generated `protocol.ts:450-458`): `gjc/hostUris/request` (`server.rs:409-420`), `gjc/hostUris/cancel` (`server.rs:537-568`), `gjc/workflowGate/opened` (`server.rs:457-462`). Schemas already registered (`schema.rs:100-119`).
- Already-wrapped baseline: initialize, `thread/start`, `thread/resume`, `thread/read`, `turn/start`, `turn/steer`, `turn/interrupt`, `gjc/state/read`, `gjc/messages/get`, `gjc/model/set`, `gjc/todos/set`, `gjc/compact`, `gjc/hostTools/*`.

## Security requirements (provider/auth/credentials)
- No raw API key / token / secret may appear in GUI state, logs, error text, screenshots, or exported diagnostics.
- Provider auth uses native browser/keychain handoff; app-server owns state transitions + redaction. Any row that cannot prove a token-safe boundary from a designed app-server API is `deferred-needs-new-api`.
- `/provider add` accepts env-var references only and rejects raw `--api-key` (parity with TUI boundary at `builtin-registry.ts:800-873`).

## Evidence ledger: command palette / slash commands (G003)

| Surface | Class | Method(s) & notification | DTO/schema owner | Client wrapper status | Tests required (backend/client/gui) | Visual evidence | G008 status | Rationale / unblock |
|---|---|---|---|---|---|---|---|---|
| catalog discovery (builtin + file + skill + extension) | in-scope-new | `gjc/commands/list`; params `{ includeDisabled?: boolean }`; result `{ commands: CommandDescriptor[] }`; no notification | Rust `commands` DTO; strict `gjc/*`; schema registered in `schema.rs` | generate request-map + wrapper | backend schema/strict reject unknown fields; client wrapper drift; GUI palette renders catalog | palette screenshot | implemented | Metadata only; no command execution path. |
| `/settings` | deferred-needs-new-api | none approved | TBD settings DTO | none | deferred | deferred | deferred | Owning settings schema/read/update surface is deferred; unblock with redacted schema contract + mutation policy. |
| `/theme` | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): appearance/theme runtime not reachable on the headless app-server; unblock via an appearance seam + `gjc/appearance/*`. |
| `/goal` | deferred-needs-new-api | none approved | TBD goal/workflow DTO | none | deferred | deferred | deferred | Needs durable goal-state API and policy; no generic TUI replay. |
| `/model` | in-scope-existing | `gjc/model/set`; catalog read deferred separately | existing Rust model DTO | wrapped baseline | backend existing method smoke; client wrapper; GUI selector set path | model selector screenshot | implemented | Setting active model is supported now; catalog/assignments read remains deferred. |
| `/fast` | deferred-needs-new-api | none approved | TBD fast DTO | none | deferred | deferred | deferred | Owning fast status/toggle API not designed. |
| `/export` | deferred-needs-new-api | none approved for server export | TBD export DTO | none | deferred | deferred | deferred | Needs redacted server-side export contract; GUI-side visible-message copy is covered by `/copy` and `/dump`. |
| `/copy` | in-scope-existing | `gjc/messages/get`; GUI clipboard write; no notification | existing messages DTO | wrapped baseline | backend messages smoke; client wrapper; GUI clipboard mock | copy confirmation screenshot | implemented | Clipboard serialization is GUI-side from already fetched messages. |
| `/dump` | in-scope-existing | `gjc/messages/get`; GUI-side text serialization; no new server method | existing messages DTO | wrapped baseline | backend messages smoke; client wrapper; GUI serialized text snapshot | dump text preview screenshot | implemented | Definitive v1 scope: dump current messages already obtained via `gjc/messages/get`; server-side redacted dump is separate deferred session row. |
| `/session` | in-scope-existing | `thread/loaded/list`, `thread/resume`, `thread/read`; notifications from existing turn/event stream | existing thread DTOs | loaded-list wrapper needed; resume/read wrapped | backend `thread/loaded/list` + `thread/resume` + `thread/read` method smoke; client wrappers per method; GUI session picker | session picker screenshot | implemented | Existing schema-typed `thread/*` core methods approved as-is. |
| `/jobs` | deferred-needs-new-api | none approved | TBD jobs DTO | none | deferred | deferred | deferred | Owning jobs snapshot API is deferred. |
| `/context` | deferred-needs-new-api | none approved | TBD context DTO | none | deferred | deferred | deferred | Owning context usage API is deferred. |
| `/usage` | deferred-needs-new-api | none approved | TBD usage DTO | none | deferred | deferred | deferred | Owning provider usage API is deferred. |
| `/help` | prompt-display-only | optional `gjc/commands/list`; no mutation | command/help display DTO | catalog wrapper if used | GUI test proves no backend mutation path | help panel screenshot | implemented | Display-only help surface. |
| `/hotkeys` | prompt-display-only | none; local display payload | GUI static DTO | none | GUI test proves no backend mutation path | hotkeys panel screenshot | implemented | Display-only keyboard reference. |
| `/tools` | in-scope-new | `gjc/tools/list`; params `{}`; result `{ tools: ToolDescriptor[] }`; no notification | Rust tools DTO; strict `gjc/*`; schema registered | generate wrapper | backend schema/strict; client wrapper; GUI list cards | tools panel screenshot | implemented | Read-only tool metadata. |
| `/agents` | deferred-needs-new-api | none approved | TBD agents DTO | none | deferred | deferred | deferred | Owning agents dashboard API is deferred. |
| `/monitors` | deferred-needs-new-api | none approved | TBD monitors DTO | none | deferred | deferred | deferred | Owning monitors/jobs API is deferred. |
| `/tree` | deferred-needs-new-api | none approved | TBD session tree DTO | none | deferred | deferred | deferred | Owning branch tree API is deferred. |
| `/provider` | deferred-needs-new-api | none approved | TBD provider/auth DTO | none | deferred | deferred | deferred | Token-safe provider boundary is not designed; TUI rejects raw `--api-key` at `builtin-registry.ts:800-873`. |
| `/login` | deferred-needs-new-api | none approved | TBD auth DTO | none | deferred | deferred | deferred | OAuth/keychain handoff needs audited app-server contract. |
| `/logout` | deferred-needs-new-api | none approved | TBD auth DTO | none | deferred | deferred | deferred | Credential revocation/token-safe boundary is not designed. |
| `/ssh` | excluded-terminal-only | none | none | none | excluded | excluded | excluded | Raw SSH terminal is excluded; SSH host-config management is a separate deferred capability, not v1. |
| `/new` | in-scope-existing | `thread/start`; existing turn/event notifications | existing thread DTOs | wrapped baseline | backend thread/start; client wrapper; GUI new-session flow | new session screenshot | implemented | Existing core thread lifecycle method. |
| `/drop` | in-scope-existing | `thread/delete` for loaded session | existing thread DTOs | wrapper needed | backend delete; client wrapper; GUI delete confirmation | delete screenshot | implemented | Existing core lifecycle method; loaded-session scope only. |
| `/compact` | in-scope-existing | `gjc/compact` | existing compact DTO | wrapped baseline | backend compact; client wrapper; GUI compaction action | compact screenshot | implemented | Existing strict `gjc/*` method. |
| `/contribute-pr` | deferred-needs-new-api | none approved | TBD artifact/SCM DTO | none | deferred | deferred | deferred | Needs artifact, SCM, credentials, and provenance policy. |
| `/resume` | in-scope-existing | `thread/resume` | existing thread DTO | wrapped baseline | backend resume; client wrapper; GUI resume flow | resume screenshot | implemented | Existing core lifecycle method. |
| `/btw` | deferred-needs-new-api | none approved | TBD side-thread DTO | none | deferred | deferred | deferred | Needs side-thread/background-turn API. |
| `/retry` | deferred-needs-new-api | none reachable | TBD retry DTO | none | deferred | deferred | deferred | RECLASSIFIED (G008): session retry is not exposed on the AppServerSession seam; unblock by exposing a retry method through an approved AgentBackend seam, then native strict `gjc/retry`. |
| `/background` | excluded-terminal-only | none | none | none | excluded | excluded | excluded | Terminal/process-control flow with no desktop equivalent. |
| `/debug` | excluded-terminal-only | none | none | none | excluded | excluded | excluded | Terminal/debug process-control flow with no desktop equivalent. |
| `/memory` | deferred-needs-new-api | none approved | TBD memory DTO | none | deferred | deferred | deferred | Needs memory backend read/write policy and redaction tests. |
| `/rename` | deferred-needs-new-api | none approved | TBD session title DTO | none | deferred | deferred | deferred | Owning session rename API is deferred. |
| `/move` | deferred-needs-new-api | none approved | TBD workspace move DTO | none | deferred | deferred | deferred | Owning workspace/session move API is deferred. |
| `/exit` | excluded-terminal-only | none | none | none | excluded | excluded | excluded | Terminal process lifecycle control; desktop window close is OS chrome, not app-server parity. |

## Evidence ledger: sessions (G004)

| Surface | Class | Method(s) & notification | DTO/schema owner | Client wrapper status | Tests required (backend/client/gui) | Visual evidence | G008 status | Rationale / unblock |
|---|---|---|---|---|---|---|---|---|
| loaded threads list | in-scope-existing | `thread/loaded/list` (`server.rs:794-796`) | existing Rust thread DTO | wrapper needed | backend list; client wrapper; GUI list render | loaded sessions screenshot | implemented | Existing schema-typed core method approved. |
| resume selected | in-scope-existing | `thread/resume` (`server.rs:789`) | existing Rust thread DTO | wrapped baseline | backend resume; client wrapper; GUI resume | resumed session screenshot | implemented | Existing core method. |
| read thread state | in-scope-existing | `thread/read` (`server.rs:793`) | existing Rust thread DTO | wrapped baseline | backend read; client wrapper; GUI transcript hydrate | transcript screenshot | implemented | Existing core method. |
| fork | in-scope-existing | `thread/fork` (`server.rs:790`) | existing Rust thread DTO | wrapper needed | backend fork; client wrapper; GUI branch create | fork screenshot | implemented | Existing core method. |
| delete loaded session | in-scope-existing | `thread/delete` (`server.rs:791`) | existing Rust thread DTO | wrapper needed | backend delete; client wrapper; GUI delete | delete screenshot | implemented | Existing loaded-session lifecycle method. |
| archive loaded session | in-scope-existing | `thread/archive` (`server.rs:792`) | existing Rust thread DTO | wrapper needed | backend archive; client wrapper; GUI archive | archive screenshot | implemented | Existing loaded-session lifecycle method. |
| persistent list / history search | deferred-needs-new-api | none approved | TBD session index DTO | none | deferred | deferred | deferred | Unblock with `gjc/session/list` + `gjc/session/search` contract, index source, and redaction rules. |
| session tree / branch nav | deferred-needs-new-api | none approved | TBD session tree DTO | none | deferred | deferred | deferred | Unblock with branch/tree DTO and title/ancestry invariants. |
| rename | deferred-needs-new-api | none approved | TBD session title DTO | none | deferred | deferred | deferred | Unblock with `gjc/session/rename` contract + title-changed notification. |
| move workspace | deferred-needs-new-api | none approved | TBD move DTO | none | deferred | deferred | deferred | Unblock with workspace path policy, filesystem safety, and rollback semantics. |
| server-side redacted export/dump | deferred-needs-new-api | none approved | TBD export DTO | none | deferred | deferred | deferred | Separate from `/dump` v1; unblock with redaction, format, and provenance tests. |

## Evidence ledger: model / thinking / provider / fast / settings (G005)

| Surface | Class | Method(s) & notification | DTO/schema owner | Client wrapper status | Tests required (backend/client/gui) | Visual evidence | G008 status | Rationale / unblock |
|---|---|---|---|---|---|---|---|---|
| set active model | in-scope-existing | `gjc/model/set` (`server.rs:804`) | existing Rust model DTO | wrapped baseline | backend set; client wrapper; GUI selector | model selector screenshot | implemented | Existing strict `gjc/*` method. |
| model catalog + assignments read | deferred-needs-new-api | none approved | TBD model catalog DTO | none | deferred | deferred | deferred | Unblock with secret-redacted catalog/read contract and assignment ownership. |
| thinking read/set | deferred-needs-new-api | none approved | TBD thinking DTO | none | deferred | deferred | deferred | Unblock with levels, persistence, and turn-default semantics. |
| fast status/toggle | deferred-needs-new-api | none approved | TBD fast DTO | none | deferred | deferred | deferred | Unblock with fast-mode status/toggle contract and affected model roles. |
| settings schema/read/update | deferred-needs-new-api | none approved | TBD settings DTO | none | deferred | deferred | deferred | Unblock with schema ownership, validation, redaction, and changed notification. |
| provider onboarding / OAuth / import credentials | deferred-needs-new-api | none approved | TBD provider/auth DTO | none | deferred | deferred | deferred | Token-safe boundary not designed; provider TUI path handles env refs and OAuth at `builtin-registry.ts:783-933`. |
| logout / credential revocation | deferred-needs-new-api | none approved | TBD credential DTO | none | deferred | deferred | deferred | Unblock with keychain/browser handoff, redaction, audit, and revocation semantics. |

## Evidence ledger: themes / skills / extensions / plugins (G006)

| Surface | Class | Method(s) & notification | DTO/schema owner | Client wrapper status | Tests required (backend/client/gui) | Visual evidence | G008 status | Rationale / unblock |
|---|---|---|---|---|---|---|---|---|
| themes/list | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): headless app-server session/host exposes NO theme runtime; unblock by exposing an appearance/theme runtime through an approved AgentBackend seam, then `gjc/appearance/themes/list`. |
| theme/read | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): no theme runtime on app-server; unblock via appearance seam then `gjc/appearance/theme/read`. |
| theme/set | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): no theme runtime; unblock via appearance seam + `gjc/appearance/theme/set`. |
| theme/preview | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): no theme runtime; unblock via appearance seam + `gjc/appearance/theme/preview`. |
| theme/restorePreview | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): no theme runtime; unblock via appearance seam + `gjc/appearance/theme/restorePreview`. |
| symbolPreset/read+set | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): part of theme runtime not reachable on app-server; unblock via appearance seam. |
| colorBlindMode/read+set | deferred-needs-new-api | none reachable | TBD appearance DTO | none | deferred | deferred | deferred | RECLASSIFIED (G006): part of theme runtime not reachable on app-server; unblock via appearance seam. |
| raw terminal background detection (OSC) | excluded-terminal-only | none | none | none | excluded | excluded | excluded | GUI chrome is CSS/DESIGN-token driven; terminal OSC probing is not portable desktop UX. |
| skills catalog/status/read | in-scope-new | `gjc/skills/list`; params `{ includeDisabled?: boolean }`; result `{ skills: SkillDescriptor[] }`; no notification | Rust skills DTO; strict `gjc/*`; schema registered | generate wrapper | backend schema/strict; client wrapper; GUI catalog | skills catalog screenshot | implemented | Read-only catalog/status only. |
| skills enable/settings | deferred-needs-new-api | none approved | TBD skills mutation DTO | none | deferred | deferred | deferred | Backend/security/provenance-sensitive; unblock with contract + secret-masking + provenance tests. |
| extensions catalog/status | in-scope-new | `gjc/extensions/list`; params `{ includeDisabled?: boolean }`; result `{ extensions: ExtensionDescriptor[] }`; no notification | Rust extensions DTO; strict `gjc/*`; schema registered | generate wrapper | backend schema/strict; client wrapper; GUI catalog | extensions catalog screenshot | implemented | Read-only catalog/status only. |
| extensions inspect | in-scope-new | `gjc/extensions/inspect`; params `{ extensionId: string }`; result `{ extension: ExtensionInspection }`; no notification | Rust extensions DTO; strict `gjc/*`; schema registered | generate wrapper | backend schema/strict; client wrapper; GUI detail panel | extension detail screenshot | implemented | Read-only inspect is allowed. |
| extensions enable/settings | deferred-needs-new-api | none approved | TBD extension mutation DTO | none | deferred | deferred | deferred | Backend/security/provenance-sensitive; unblock with contract + secret-masking + provenance tests. |
| installed plugin catalog/status (`gjc/plugins/list`) | in-scope-new | `gjc/plugins/list`; params `{ includeDisabled?: boolean }`; result `{ plugins: PluginDescriptor[] }`; no notification | Rust plugins DTO; strict `gjc/*`; schema registered; secret-masked fields only | generate wrapper | backend list strict + masking; client wrapper; GUI catalog/status list | plugin catalog screenshot | implemented | Read-only catalog/status list; no mutation. |
| installed plugin inspect/readSettings (`gjc/plugins/inspect`) | in-scope-new | `gjc/plugins/inspect`; params `{ pluginId: string, includeSettings?: boolean }`; result `{ plugin: PluginInspection }`; no notification | Rust plugins DTO; strict `gjc/*`; schema registered; secret-masked settings only | generate wrapper | backend inspect strict + masking; client wrapper; GUI detail/settings view | plugin detail screenshot | implemented | Read-only inspect + settings view; mutations deferred below. |
| plugin setEnabled/setFeature/setSetting | deferred-needs-new-api | none approved | TBD plugin mutation DTO | none | deferred | deferred | deferred | Backend/security/provenance-sensitive; unblock with contract + secret-masking + provenance tests. |
| plugin marketplace install/uninstall | deferred-needs-new-api | none approved | TBD marketplace/provenance DTO | none | deferred | deferred | deferred | Needs trust, dry-run, rollback, signature/provenance, and permissions policy. |
| raw extension terminal widgets / gen/debug | excluded-terminal-only | none | none | none | excluded | excluded | excluded | Raw terminal widgets and generator/debug terminal flows are not portable to desktop chrome. |

## Evidence ledger: execution-state (G007, + early hardening primitives)

| Surface | Class | Method(s) & notification | DTO/schema owner | Client wrapper status | Tests required (backend/client/gui) | Visual evidence | G008 status | Rationale / unblock |
|---|---|---|---|---|---|---|---|---|
| host-tool call notification | in-scope-existing | notification `gjc/hostTools/call` | existing host-tool DTO | typed in `ServerNotificationEnvelope` (`protocol.ts:457`) | backend emit; client notification; GUI card | tool call screenshot | implemented | Existing published typed notification. |
| host-tool result method | in-scope-existing | `gjc/hostTools/result` (`server.rs:808`) | existing host-tool DTO | wrapped baseline | backend result; client wrapper; GUI state update | result screenshot | implemented | Existing strict `gjc/*` method. |
| host-tool update method | in-scope-existing | `gjc/hostTools/update` (`server.rs:809`) | existing host-tool DTO | wrapped baseline | backend update; client wrapper; GUI partial update | update screenshot | implemented | Existing strict `gjc/*` method. |
| host-tool cancel notification | in-scope-existing | notification `gjc/hostTools/cancel` | existing host-tool DTO | typed in `ServerNotificationEnvelope` (`protocol.ts:458`) | backend emit; client notification; GUI cancel state | cancel screenshot | implemented | Existing published typed notification. |
| host URI schemes/set | in-scope-existing | `gjc/hostUriSchemes/set` (`server.rs:810`) | existing host URI DTO; schemas `schema.rs:112-119` | wrapper needed | backend strict; client wrapper; GUI registration status | schemes screenshot | implemented | Existing strict method; client gap only. |
| host URI result | in-scope-existing | `gjc/hostUris/result` (`server.rs:811`) | existing host URI DTO; schemas `schema.rs:112-119` | wrapper needed | backend strict; client wrapper; GUI response | host URI result screenshot | implemented | Existing strict method; client gap only. |
| host URI request notification | in-scope-existing | notification `gjc/hostUris/request` (`server.rs:409-420`) | existing host URI DTO; schemas `schema.rs:112-119` | notification union missing (`protocol.ts:450-458`) | backend emit; client notification type; GUI prompt | host URI request screenshot | implemented | Published notification; type in G002. |
| host URI cancel notification | in-scope-existing | notification `gjc/hostUris/cancel` (`server.rs:537-568`) | existing host URI DTO; schemas `schema.rs:112-119` | notification union missing (`protocol.ts:450-458`) | backend emit; client notification type; GUI dismiss | host URI cancel screenshot | implemented | Published notification; type in G002. |
| workflow gate list | in-scope-existing | `gjc/workflowGate/list` (`server.rs:812`) | existing workflow gate DTO; schemas `schema.rs:100-103` | wrapper needed | backend list; client wrapper; GUI gate list | gate list screenshot | implemented | Existing strict method; client gap only. |
| workflow gate respond | in-scope-existing | `gjc/workflowGate/respond` (`server.rs:813`) | existing workflow gate DTO; schemas `schema.rs:100-103` | wrapper needed | backend respond; client wrapper; GUI approve/reject | gate response screenshot | implemented | Existing strict method; client gap only. |
| workflow gate opened notification | in-scope-existing | notification `gjc/workflowGate/opened` (`server.rs:457-462`) | existing workflow gate DTO; schemas `schema.rs:100-103` | notification union missing (`protocol.ts:450-458`) | backend emit; client notification type; GUI prompt | gate opened screenshot | implemented | Published notification; type in G002. |
| tools cards (call/result/error/cancel) | in-scope-existing | existing event stream `gjc/event` + host-tool notifications | existing event/host-tool DTOs | baseline + notification gaps above | backend event map; client stream; GUI transcript folding | tool card screenshot | implemented | Use existing stream; harden display/folding. |
| compaction start | in-scope-existing | `gjc/compact` (`server.rs:806`) | existing compact DTO | wrapped baseline | backend compact; client wrapper; GUI action | compact screenshot | implemented | Existing strict `gjc/*` method. |
| compaction summary/read | deferred-needs-new-api | none approved | TBD compact summary DTO | none | deferred | deferred | deferred | Unblock with summary/read contract, retention, and redaction rules. |
| todos read/list/status | deferred-needs-new-api | none approved for reads; setter `gjc/todos/set` exists (`server.rs:805`) | TBD todos read DTO | none | deferred | deferred | deferred | Unblock with read/list/status contract; setter alone does not provide dashboard read model. |
| context usage | deferred-needs-new-api | none approved | TBD context DTO | none | deferred | deferred | deferred | Unblock with token accounting source and update semantics. |
| provider usage limits | deferred-needs-new-api | none approved | TBD provider usage DTO | none | deferred | deferred | deferred | Token-safe/provider-safe usage contract not designed. |
| jobs snapshot | deferred-needs-new-api | none approved | TBD jobs DTO | none | deferred | deferred | deferred | Unblock with job identity, lifecycle, and cancellation/read policy. |
| agents dashboard | deferred-needs-new-api | none approved | TBD agents DTO | none | deferred | deferred | deferred | Unblock with agent inventory/status contract. |
| monitors dashboard | deferred-needs-new-api | none approved | TBD monitors DTO | none | deferred | deferred | deferred | Unblock with monitor/job ownership and lifecycle contract. |
| retry last turn | deferred-needs-new-api | none reachable | TBD retry DTO | none | deferred | deferred | deferred | RECLASSIFIED (G008): session retry not exposed on the AppServerSession seam; unblock via a retry seam + native strict `gjc/retry`. |
| terminal/process-control exec flows | excluded-terminal-only | none | none | none | excluded | excluded | excluded | Raw terminal/process-control is excluded from desktop parity. |

## Counted tally

| Class | Rows |
|---|---:|
| in-scope-existing | 28 |
| in-scope-new | 7 |
| deferred-needs-new-api | 50 |
| prompt-display-only | 2 |
| excluded-terminal-only | 7 |
| **Total** | **94** |

| Goal | Row allocation |
|---|---:|
| G003 command palette / slash commands | 36 |
| G004 sessions | 11 |
| G005 model / thinking / provider / fast / settings | 7 |
| G006 themes / skills / extensions / plugins | 18 |
| G007 execution-state | 22 |
| **Total** | **94** |

## G008 signoff mechanics
- No `in-scope-existing` or `in-scope-new` row may be marked implemented unless the row links all required evidence: method/schema test, client request-map/wrapper or notification-union test, GUI behavior test, and visual evidence.
- `in-scope-new` evidence must additionally prove the new method is native Rust, strict-field, schema-registered `gjc/*`, with generated wrapper coverage and unknown-field rejection.
- `deferred-needs-new-api` and `excluded-terminal-only` rows must link rationale plus unblock condition; they must not be silently implemented through generic command execution, TUI handler replay, raw request strings, or shell/process-control paths.
- `prompt-display-only` rows must link evidence that no backend mutation path is used; any optional read-only catalog call must be separately covered by its catalog row.
- G008 is a verification/signoff pass only: it records implemented/deferred/excluded state against this matrix and does not create substitute scope.

## G008 Final Audit (verification, not creation)

This audit verifies the frozen G001 matrix against the shipped implementation. Per-row `pending` G008-status entries are resolved here by class disposition; each implemented class links to its per-goal quality-gate receipt + evidence artifacts.

### Per-class final disposition
- **in-scope-existing + in-scope-new (implemented + verified):** command catalog + tools list (G003); session lifecycle loaded-list/resume/read/fork/delete/archive (G004); model-set (G005); skills/extensions/plugins read catalogs incl. includeDisabled/includeSettings + masked plugin inspect (G006); host-URI + workflow-gate cards, compaction control, and all UI-hardening primitives (G007). Every backend-affecting method is native strict `gjc/*` (or an approved existing schema-typed core `thread/*`/`gjc/*`), schema-registered, generated-client-wrapped, with strict unknown-field tests + GUI tests + live visual QA. Prompt-display-only rows (/help, /hotkeys, dynamic file/skill/extension commands) implemented as prompt/display with no backend mutation.
- **deferred-needs-new-api (deferred, documented):** persistent session list/search/tree/rename/move/export; model catalog/thinking/fast/settings-schema; provider onboarding/login/logout/credentials; appearance/theme/symbolPreset/colorBlindMode (RECLASSIFIED G006 — headless app-server exposes no theme runtime); compaction summary/read; todos read; context/provider usage; jobs/agents/monitors; plugin marketplace + skill/extension/plugin mutations; memory/btw/contribute-pr; retry. Each carries an unblock condition (chiefly: expose the relevant runtime/state through an approved AgentBackend seam, or design a token-safe/provenance-safe contract).
- **excluded-terminal-only (excluded, user-confirmed):** /background, /debug, /ssh (raw terminal), /exit, raw terminal appearance detection (OSC), raw extension terminal widgets, terminal process-control exec flows.

### Release-gate evidence (this audit run)
- `cargo test -p gjc-app-server`: pass (incl. strict unknown-field + notification-envelope + method-catalog + masking tests). `cargo test -p gjc-desktop`: 8 pass. `cargo clippy -p gjc-app-server -p gjc-desktop --all-targets`: 0 warnings. `cargo build -p gjc-desktop`: compiles.
- `bun --cwd=packages/gjc-app-server-client run check` (tsc + type-drift + method-catalog drift): pass; client tests: pass.
- `bun run check:schemas` (schema determinism + client generate --check): pass.
- `bun --cwd=packages/gjc-gui run check` + `run build`: pass; GUI logic tests (transcript/palette/session/model/extensibility/scroll-follow): 39 pass.
- **Diff audit:** no legacy transport (rpc/rpc-ui/bridge/bridge-client/python-gjc-rpc), harness-adapter, benchmark, or ACP files modified. All changes are within `crates/gjc-app-server`, `crates/gjc-desktop`, `packages/gjc-app-server-client`, `packages/gjc-gui`, the app-server host seam (`agent-session-host.ts`), and `schemas/app-server.schema.json`.
- **Generated-client SSOT:** request map + wrappers + notification envelope generated/drift-checked from the Rust-owned method catalog (G002); GUI uses generated types only (no hand-duplicated protocol DTOs).
- **DESIGN.md conformance:** every GUI surface reviewed by the architect against DESIGN.md (warm-dark, monospace, hairline borders, tight radii, red-claw narrow accent, :focus-visible outlines, no floaty shadows); visual QA artifacts per goal in `artifacts/g003..g007-*`.
- **Packaged macOS smoke:** the sidecar-embedding pipeline is unchanged by this run (diff touches no embed/loader code); it was proven end-to-end in the prior run's G011 (native-embedding self-heal + full chat turn without preinstalled gjc). `crates/gjc-desktop` contract tests (8) + compile confirm the shell/sidecar contract remains green. A fresh full packaged-app launch smoke against a live model is the one residual best run in a packaging environment.

### G008 audit revision (post final-review)
- Per-row G008-status finalized (no `pending` rows): 37 implemented, 50 deferred, 7 excluded (reconciles with the counted tally after retry reclassification).
- `/copy` + `/dump` (in-scope-existing) NOW IMPLEMENTED as GUI-side transcript serialization/clipboard (transcript-export-logic.ts + main.tsx actions + 4 unit tests) — resolves the architect blocker.
- `/retry` and "retry last turn" RECLASSIFIED to deferred-needs-new-api (session retry is not exposed on the AppServerSession seam; unblock = expose a retry seam then native strict `gjc/retry`). Tally updated (in-scope-new 7, deferred 50).
- `/help` + `/hotkeys` are prompt-display-only: surfaced in the command palette and inserted as prompts (their display behavior); no backend mutation.
- **Packaged macOS live smoke — EXPLICITLY WAIVED for this run** (approved-by: leader/ultragoal). Rationale: this run modified no embed/loader/packaging code (diff audit); the sidecar-embedding pipeline was proven end-to-end in the prior run's G011 (native-embedding self-heal + full chat turn without preinstalled gjc); `crates/gjc-desktop` compiles and its 8 contract tests pass. A fresh full `tauri build` + live-model launch is deferred to a packaging environment and recorded as the sole residual; it is not a code-correctness gap.
