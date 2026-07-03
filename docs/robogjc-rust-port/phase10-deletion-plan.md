# Phase 10 — Atomic Python Deletion (operator-authorized; Docker + GitHub verified)

Status: **operator-authorized; executing.** Phases 0–9 are complete, reviewed, and checkpointed; the Rust `crates/robogjc` service is parity-proven against the standby Python implementation (64 cross-implementation cases, 0 unexplained diffs — `artifacts/robogjc/qa/g010-parity-report.json`). The operator authorized deletion and provided Docker Desktop + an authorized local `gh`. The Docker compose smoke was run on the Rust-only deployment (both `robogjc serve` and `robogjc proxy serve` on the Rust binary): `/healthz`+`/readyz` 200, signed webhook 202, bad-signature 401, webhook enqueue confirmed, no `GITHUB_TOKEN` in the orchestrator env (PAT only in gh-proxy), dashboard emits no raw replay token, and the gh-proxy `/gh/v1/*` round-trip forwards to GitHub with HMAC+PAT. A live provider triage→fix→PR turn was verified end-to-end via the ROBGJC_INTEGRATION worker smoke (real model opened a PR with all required sections and a valid closing keyword). The Rust `proxy serve` subcommand was added so gh-proxy no longer depends on Python.

Known non-blocking follow-up: the containerized Rust services currently emit no log lines to stdout or the JSONL file (`configure_logging` is not taking effect on the `serve`/`proxy serve` paths at runtime despite being wired). This is observability-only — request handling, security gates, and the durable DB audit trail (`tool_calls`/`events`) are unaffected and were verified — but stdout/file logging should be fixed as a fast follow-up for production operability.

## What Phase 10 deletes (deletion set)

- `python/robogjc/src/**` — the Python service (server, worker, queue, sandbox, host tools, db, proxy, github, autoclose, manual_triage, cli, persona, pragmas, natives_cache).
- `python/robogjc/tests/**` — Python behavioral suite (superseded by transposed Rust tests + shared golden fixtures; see `python-test-inventory.md`).
- `python/robogjc/pyproject.toml`, package metadata/cache directories, Python test/support files, `scripts/`, `assets/`, `.env.example`, `AGENTS.md`, and `README.md`; the Python service package.
- Root `package.json` scripts that drive the Python service: `robogjc:serve` (python3 -m robogjc serve), `robogjc:install`, `robogjc:test:integration`; and `test:py` narrowed to `python/gjc-rpc/tests` only (gjc-rpc stays — it is a general client, not robogjc).
- Docs referencing `python/robogjc` as the implementation: update `docs/bot-integration.md`, `docs/codebase-overview.md`, `docs/onboarding-packet.md`, `docs/natives-build-release-debugging.md` to describe the Rust `crates/robogjc` service.

## What Phase 10 RETAINS (explicit keep rationale)

- `python/robogjc/web/**` — the TS/Vite dashboard **stays** (plan non-goal: do not port the dashboard). The Rust `server.rs`/`dashboard.rs` already serve its built assets. Keep `robogjc:web:build` / `robogjc:web:dev` scripts.
- `python/robogjc/docker-compose.yml` and `python/robogjc/entrypoint.sh` — retained as Rust deployment assets. The entrypoint only prepares slot users, state directories, and shared caches before execing `robogjc serve` / `robogjc proxy serve`; it no longer installs or assumes the Python robogjc package.
- `Dockerfile.robogjc` — retained as the Rust image definition; Python robogjc install/copy steps are removed, while dashboard build output and the Rust binary stay.
- `python/gjc-rpc/**` — general Python app-server client; not part of the robogjc deletion set. Keep `python/gjc-rpc/tests`.
- `docs/app-server-artifacts/**` — historical planning artifacts for the *separate* app-server port; the `--mode rpc` / `RpcClient` references there belong to that plan, not this one. Keep.
- `crates/robogjc/**` — the new Rust implementation.

## Reference-search gate (robogjc-implementation dangling refs)

Targets to re-run to zero (or explicit keep) immediately after deletion:
`python/robogjc/src`, `robogjc.worker`, `robogjc.cli`, `from robogjc`, `import robogjc`, `python3 -m robogjc`, `robogjc:serve`, `robogjc:install`, `robogjc:test:integration`, Python `robogjc` Docker entrypoints.

Current non-doc code references to migrate/remove at deletion time:
- Root `package.json`: `robogjc:serve`, `robogjc:install`, `robogjc:test:integration`, `test:py` (narrow to gjc-rpc), workspace member `python/robogjc/web` (keep — dashboard).
- `scripts/ci-dev-affected.ts` + tests: Python rules must be narrowed to `python/gjc-rpc`; `crates/robogjc` remains covered by Rust rules and `python/robogjc/web` by web rules.
- `packages/coding-agent/src/internal-urls/docs-index.generated.ts`: regenerated after doc edits.

## Rollback note

Until Phase 10 executes, rollback = redeploy the Python `robogjc` service (it remains runnable and is the standby). After Phase 10 (atomic deletion), rollback is `git revert` of the deletion commit only; there is no in-tree Python fallback. Therefore the deletion MUST be gated on the live-e2e green evidence below so that the Rust service is proven safe before the safety net is removed.

## Blockers (operator-only — why this is not executed autonomously)

The plan's Phase 10 acceptance requires, before deleting the production Python service and its rollback path:
1. **Docker compose smoke green** — Docker is not installed in this environment (`command -v docker` → none). The `robogjc:build`/`robogjc:up` smoke and the Rust-image gh-proxy smoke cannot be run.
2. **`robogjc:test:integration` + `ROBGJC_INTEGRATION=1 worker_smoke` green** — require real GitHub credentials and a live provider/model.
3. **Harness M10-equivalent live e2e green** — requires live provider/model credentials.
4. **Operator authorization** for the irreversible deletion of the current production Python service and removal of the rollback safety net.

These match the human-gated resources recorded in the original app-server ultragoal ledger (session 019f1c30). No autonomous action can satisfy them.

## Resume checklist (for the operator)

1. Install Docker; run `bun run robogjc:build` then the compose smoke in gh-proxy mode (assert `/healthz`, `/readyz`, signed webhook 202, proxy round trip, no PAT in the orchestrator env).
2. Provide GitHub + provider credentials; run `bun run robogjc:test:integration` and `ROBGJC_INTEGRATION=1 cargo test -p robogjc --test worker_smoke -- --ignored` (the Rust equivalent) to green.
3. Run the Rust service as the active webhook consumer against a staging repo allowlist with Python on standby; confirm parity in production.
4. Authorize deletion; execute the deletion set above; run the reference-search gate to zero; run `bun run check`, `bun run test`, `bun run test:py` (gjc-rpc only), `cargo test -p robogjc`, `cargo test -p gjc-app-server`, web typecheck/build, Docker smoke; obtain architect + critic pre-deletion signoff; commit.
