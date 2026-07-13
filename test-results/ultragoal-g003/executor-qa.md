# G003 Executor QA / Red-Team Evidence

**QA: passed**

Date: 2026-07-12

## Scope and method

This evidence is an independent focused-test and inline-script check of the G003 protocol-fix acceptance probes. No repository source files were edited by this QA lane.

## Commands and outcomes

### Focused Bun test suite

```sh
bun test packages/coding-agent/test/workflow-gate-broker.test.ts packages/coding-agent/test/agent-wire/agent-wire-scopes.test.ts packages/coding-agent/test/notifications-token.test.ts packages/coding-agent/test/notifications-app-server-unwired.test.ts packages/coding-agent/test/notifications-session-switch.test.ts packages/coding-agent/test/acp-agent.test.ts packages/coding-agent/test/extensions-runner.test.ts
```

Outcome:

```text
bun test v1.3.14 (0d9b296a)

 129 pass
 0 fail
 502 expect() calls
Ran 129 tests across 7 files. [6.69s]
```

### Prototype-pollution command-name probe

```sh
bun -e 'import { isRpcCommandType } from "./packages/coding-agent/src/modes/shared/agent-wire/scopes.ts"; const denied = ["toString", "constructor", "__proto__"]; for (const type of denied) { if (isRpcCommandType(type)) throw new Error(`${type} was accepted as an RPC command`); } for (const type of ["prompt", "steer", "follow_up", "abort_and_prompt"]) { if (!isRpcCommandType(type)) throw new Error(`${type} was rejected as an RPC command`); } console.log(JSON.stringify({ denied, promptFamilyAccepted: ["prompt", "steer", "follow_up", "abort_and_prompt"] }));'
```

Outcome:

```json
{"denied":["toString","constructor","__proto__"],"promptFamilyAccepted":["prompt","steer","follow_up","abort_and_prompt"]}
```

## Acceptance-probe matrix

| Probe | Evidence | Result |
| --- | --- | --- |
| Accepted-but-unadvanced gate replays its cached resolution, advances once, and persists `advanced: true` | `workflow-gate-broker.test.ts`, test `completes advance before returning an idempotent replay after a crash` (lines 154-183): asserts accepted/`advanced:false` after pre-advance crash, matching-key replay equal to cached resolution, `advanced:true`, one advance; repeat replay remains one advance. | Pass |
| Corrupt gate store (negative counter and mismatched gate key) is quarantined and throws | `workflow-gate-broker.test.ts`, test `quarantines structurally corrupt FileGateStore state` (lines 289-308): writes both corrupt conditions, requires corrupt-store error and `gates.json.corrupt-*` quarantine. | Pass |
| Throwing gate emit preserves a pending, answerable gate and audits `gate_emit_failed` | `workflow-gate-broker.test.ts`, test `audits failed emission while preserving the pending gate for a later answer` (lines 185-214): throw from emit, inspect persisted pending record/audit, then resolve successfully. | Pass |
| RPC scope guard rejects inherited prototype names while allowing prompt family | Existing scope test covers `toString`, `constructor`, `prompt`, and `workflow_gate_response` (lines 110-115); the inline probe above additionally verifies `__proto__` plus `prompt`, `steer`, `follow_up`, and `abort_and_prompt`. | Pass |
| Whitespace notification token is absent, generation is nonblank, and token alone does not enable notifications | `notifications-token.test.ts`, lines 19-63: `GJC_NOTIFICATIONS_TOKEN = " \t "`, asserts `notificationsEnabled() === false`, starts only after explicit enable flag, and verifies generated endpoint token is nonblank and not the whitespace env value. | Pass |
| App-server notification endpoint refuses startup without transport | `notifications-app-server-unwired.test.ts`, lines 11-55: app-server flag enabled without transport; command produces failure notification, installs no ask-answer source, and creates no endpoint discovery file. | Pass |
| ACP custom UI rejects explicitly | `extensions-runner.test.ts`, lines 59-76: `runner.getUIContext().custom(...)` rejects with `Custom UI components are unavailable in this mode`; factory is never invoked. | Pass |
| ACP prompt response echoes the request `messageId` at top-level `userMessageId` | `acp-agent.test.ts`, prompt test lines 841-904, particularly lines 876-900: invokes `prompt` with a known message ID and asserts `response.userMessageId` equals it. | Pass |

## Blockers

None. Every required probe succeeded.
