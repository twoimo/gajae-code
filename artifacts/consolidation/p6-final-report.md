# Transport Consolidation — P6 Final Report

Branch `feat/codex-app-server-port`. Consolidates all legacy agent-session transports into the single app-server (`crates/gjc-app-server` + pi-natives bridge + `--mode app-server` + harness app-server adapter). ACP (`--mode acp`) and the notifications SDK (`crates/gjc-notifications`, `packages/coding-agent/src/notifications/*`) are retained and were untouched throughout (protected-boundary diff empty across P1–P6).

## Phase commits
- P1 relocate shared agent-wire types — `9322fafe`
- P2 neutral harness contract + owner→app-server default + rpc* renames — `59d2ea6d`; blocker fix (app-server notification→owner observation mapping) — `1d32afa9`
- P3 app-server wire parity: Lane A workflow-gate `b71ee104`, Lane B unattended (+ Rust-dispatcher preflight) `1094fccf`, Lane C host-URI (+ thread-scoped router) `353547e3`; sign-off blocker fixes `e7b802b7`
- P4 owner observability + session-routed M10 (deterministic + live) — `375663f2`
- P5 remove rpc/rpc-ui/bridge mode wiring + SDK exports `185e313f`, `9f4c34e6`; app-server-only harness factory `99fc4d3e`
- P6 atomic deletion — `41f05668`; docs cleanup (this blocker) — follow-up

## P6 deletion set
- Source dirs: `packages/coding-agent/src/modes/rpc/**`, `packages/coding-agent/src/modes/bridge/**`, `packages/bridge-client/**`, `python/gjc-rpc/**`
- Source files: `packages/coding-agent/src/harness-control-plane/rpc-adapter.ts` (GajaeCodeRpc), `scripts/edit-benchmark.py`, `scripts/edit_benchmark_common.py`, `scripts/rate-edit-tool.py`, `docs/rpc.md`
- Pure transport tests: `test/rpc*.test.ts`, `test/rpc/**`, `test/checkpoint-rpc-qa.ts`, `test/rpc-example.ts`, the transport files under `test/bridge/`, `harness-control-plane/rpc-acceptance.test.ts` + `rpc-unattended-lifecycle.test.ts`
- Purged: root `package.json` bridge-client dep + `test:py`; `coding-agent/package.json` export tombstones (`./modes/rpc`, `./modes/rpc/*`, `./modes/bridge`, `./modes/bridge/*` = null); `scripts/ci-dev-affected.ts`(+test) python rules/PYTHON_DEV_SETUP/isPythonPath; `ci-release-publish.ts` bridge-client; docs; regenerated `bun.lock`

## Retained / retargeted (no coverage lost)
- Neutral agent-wire tests moved `test/bridge/agent-wire-*.test.ts` → `test/agent-wire/*` (45 tests)
- Feature coverage retargeted in P1/P3 to neutral/app-server suites: workflow-gate, unattended-action-policy, host-URI, harness owner
- `ooo-bridge-*` tests kept (they test the unrelated ouroboros command-bridge extension, not the retired transport)

## Verification (HEAD 41f05668)
- `bun run check` exit 0 (biome + `cargo clippy --workspace -- -D warnings` + nightly rustfmt + rust-scope)
- `cargo test -p gjc-app-server` 72 unit + 31 conformance; `cargo test -p robogjc` 212
- Consolidation suites: agent-wire 45, app-server 52, harness-control-plane 253, ci-dev-affected 29 — all pass
- Reference-search to zero for live retired symbols (`modes/rpc`, `modes/bridge`, `RpcClient`, `runRpcMode`, `runBridgeMode`, `--mode rpc|bridge`, `bridge-client`, `gjc_rpc`, `python/gjc-rpc`, `GJC_HARNESS_RPC_COMMAND`, `GajaeCodeRpc`). Only intentional package.json export tombstones + a historical test fixture (`test/fixtures/before-compaction.jsonl`, captured old-conversation text) remain.
- Protected-boundary: `git diff --name-only 9322fafe^ -- packages/coding-agent/src/modes/acp crates/gjc-notifications packages/coding-agent/src/notifications` is empty.

## test:ts full-run flakiness (pre-existing, not consolidation-caused)
The parallel `bun run test:ts` surfaces 15 failures in `@gajae-code/coding-agent` that are environmental, not regressions:
- `autoresearch-tools.test.ts` (`log_experiment`, real-git), `harness-control-plane/preserve.test.ts` (real-git B2), `harness-control-plane/owner.test.ts` (`RuntimeOwner recover`), with symptoms `gjc --tmux failed: new-session failed`, 5000ms real-git timeouts, and corrupt-temp-state warnings.
- Isolation proof (fresh runs): `owner.test.ts` 12/0, `preserve.test.ts` 3/0, `autoresearch-tools.test.ts` 20/0 — all pass.
- None of these tests reference deleted rpc/bridge/gjc-rpc code (grep clean). They fail only under full-suite parallel contention + tmux unavailability, independent of this consolidation.

## Architect/critic sign-offs
- P3 wire parity: architect `114-P3SignOff` (BLOCK) → fix → `117-P3ReSignOff` CLEAR/APPROVE
- P4 owner observability: architect `119-P4SignOff` CLEAR/APPROVE
- P5 mode-wiring removal: architect `121-P5SignOff` (BLOCK) → fix → `122-P5ReReview` CLEAR/APPROVE (export-tombstone deferral to P6 accepted)
- Final consolidation: critic `124` (REJECT on active-doc cleanup + this report) → this blocker resolves docs + report
