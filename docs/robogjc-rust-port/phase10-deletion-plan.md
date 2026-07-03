# Phase 10 — Atomic Python Deletion (operator-authorized; Docker + GitHub verified)

Status: **operator-authorized; executing.** Phases 0–9 are complete, reviewed, and checkpointed; the Rust `crates/robogjc` service is parity-proven against the standby Python implementation (64 cross-implementation cases, 0 unexplained diffs — `artifacts/robogjc/qa/g010-parity-report.json`). The operator authorized deletion and provided Docker Desktop + an authorized local `gh`. The Docker compose smoke was run on the Rust-only deployment (both `robogjc serve` and `robogjc proxy serve` on the Rust binary): `/healthz`+`/readyz` 200, signed webhook 202, bad-signature 401, webhook enqueue confirmed, no `GITHUB_TOKEN` in the orchestrator env (PAT only in gh-proxy), dashboard emits no raw replay token, and the gh-proxy `/gh/v1/*` round-trip forwards to GitHub with HMAC+PAT. A live provider triage→fix→PR turn was verified end-to-end via the ROBGJC_INTEGRATION worker smoke (real model opened a PR with all required sections and a valid closing keyword). The Rust `proxy serve` subcommand was added so gh-proxy no longer depends on Python.

Known non-blocking follow-up: the containerized Rust services currently emit no log lines to stdout or the JSONL file (`configure_logging` is not taking effect on the `serve`/`proxy serve` paths at runtime despite being wired). This is observability-only — request handling, security gates, and the durable DB audit trail (`tool_calls`/`events`) are unaffected and were verified — but stdout/file logging should be fixed as a fast follow-up for production operability.

## What Phase 10 deletes (deletion set)

- `python/robogjc/src/**` — the Python service (server, worker, queue, sandbox, host tools, db, proxy, github, autoclose, manual_triage, cli, persona, pragmas, natives_cache).
- `python/robogjc/tests/**` — Python behavioral suite (superseded by transposed Rust tests + shared golden fixtures; see `python-test-inventory.md`).
- `python/robogjc/pyproject.toml`, package metadata/cache directories, Python test/support files, `scripts/`, `assets/`, `.env.example`, `AGENTS.md`, and `README.md`; the Python service package.
- Root `package.json` scripts that drive the Python service: `robogjc:serve` (python3 -m robogjc serve), `robogjc:install`, and `robogjc:test:integration`; Python-package test scripts are removed from the robogjc deletion path.
- Docs referencing `python/robogjc` as the implementation: update `docs/bot-integration.md`, `docs/codebase-overview.md`, `docs/onboarding-packet.md`, `docs/natives-build-release-debugging.md` to describe the Rust `crates/robogjc` service.

## What Phase 10 RETAINS (explicit keep rationale)

- `python/robogjc/web/**` — the TS/Vite dashboard **stays** (plan non-goal: do not port the dashboard). The Rust `server.rs`/`dashboard.rs` already serve its built assets. Keep `robogjc:web:build` / `robogjc:web:dev` scripts.
- `python/robogjc/docker-compose.yml` and `python/robogjc/entrypoint.sh` — retained as Rust deployment assets. The entrypoint only prepares slot users, state directories, and shared caches before execing `robogjc serve` / `robogjc proxy serve`; it no longer installs or assumes the Python robogjc package.
- `Dockerfile.robogjc` — retained as the Rust image definition; Python robogjc install/copy steps are removed, while dashboard build output and the Rust binary stay.
- App-server client fixtures and tests that are not part of the robogjc implementation deletion set.
- `docs/app-server-artifacts/**` — historical planning artifacts for the *separate* app-server port. Keep.
- `crates/robogjc/**` — the new Rust implementation.

## Reference-search gate (robogjc-implementation dangling refs)

Targets to re-run to zero (or explicit keep) immediately after deletion:
`python/robogjc/src`, `robogjc.worker`, `robogjc.cli`, `from robogjc`, `import robogjc`, `python3 -m robogjc`, `robogjc:serve`, `robogjc:install`, `robogjc:test:integration`, Python `robogjc` Docker entrypoints.

Current non-doc code references to migrate/remove at deletion time:
- Root `package.json`: `robogjc:serve`, `robogjc:install`, `robogjc:test:integration`, workspace member `python/robogjc/web` (keep — dashboard).
- `scripts/ci-dev-affected.ts` + tests: Python rules must no longer depend on robogjc service paths; `crates/robogjc` remains covered by Rust rules and `python/robogjc/web` by web rules.
- `packages/coding-agent/src/internal-urls/docs-index.generated.ts`: regenerated after doc edits.

## Rollback note

Until Phase 10 executes, rollback = redeploy the Python `robogjc` service (it remains runnable and is the standby). After Phase 10 (atomic deletion), rollback is `git revert` of the deletion commit only; there is no in-tree Python fallback. Therefore the deletion MUST be gated on the live-e2e green evidence below so that the Rust service is proven safe before the safety net is removed.

## Execution evidence (Phase 10 completed)

Executed on branch `feat/codex-app-server-port` after operator authorization. Results:

1. **Docker compose smoke green (Rust-only image)** — rebuilt `robogjc:dev` from `Dockerfile.robogjc` with the Python package install removed. Verified in-container: `python3 -c "import robogjc"` → `ModuleNotFoundError` (Python service gone), while the retained app-server client fixtures stayed outside the robogjc image. Both `robogjc` (orchestrator) and `gh-proxy` run the Rust ELF binary; gh-proxy `Cmd` is `["robogjc","proxy","serve"]`. Endpoints: `/healthz`=200, `/readyz`=200, bad-signature webhook=400 (rejected), signed ping=202, signed `issues` opened=202 (enqueued; DB `robogjc.sqlite` created). PAT isolation: `GITHUB_TOKEN` count in orchestrator env=0, in gh-proxy=1. Dashboard body contains 0 occurrences of the replay token. gh-proxy reachable from the orchestrator and rejects unsigned requests with 401 (HMAC gate enforced).
2. **Live provider e2e green** — the `ROBGJC_INTEGRATION=1` worker smoke reproduced a real bug, applied the fix, and opened a PR with all required sections and a valid closing keyword (real model + real GitHub).
3. **Repo gates green** — `bun run check` exit 0 (biome + `cargo clippy --workspace -- -D warnings` with the two new crates allowlisted in `scripts/check-rust-scope.ts`; ~260 pedantic/nursery clippy warnings across robogjc/gjc-app-server + 3 in the pi-natives app-server bridge fixed; nightly rustfmt clean), `cargo test -p robogjc` (210) + `cargo test -p gjc-app-server` (70 unit + 31 conformance) green, dashboard `vite build` green.
4. **Reference-search gate at zero** — no live references to the deleted Python `robogjc` package remain in `package.json`, `Dockerfile.robogjc`, `scripts/**`, `crates/**`, `packages/**`, target docs, app-server client fixtures, or the retained deploy assets.

### Known non-blocking follow-up
- **Container stdout/JSONL logging is silent.** Despite `configure_logging` being wired into the `serve`/`proxy serve` paths, the running Rust services emit no lines to `docker logs` or the JSONL file. This is observability-only — request handling, the HMAC/PAT security gates, and the durable SQLite audit trail (`tool_calls`/`events`) are unaffected and were verified — but stdout/file logging should be fixed as a fast follow-up for production operability.

## Resume checklist (for the operator)

1. Install Docker; run `bun run robogjc:build` then the compose smoke in gh-proxy mode (assert `/healthz`, `/readyz`, signed webhook 202, proxy round trip, no PAT in the orchestrator env).
2. Provide GitHub + provider credentials; run `bun run robogjc:test:integration` and `ROBGJC_INTEGRATION=1 cargo test -p robogjc --test worker_smoke -- --ignored` (the Rust equivalent) to green.
3. Run the Rust service as the active webhook consumer against a staging repo allowlist with Python on standby; confirm parity in production.
4. Authorize deletion; execute the deletion set above; run the reference-search gate to zero; run `bun run check`, `bun run test`, `cargo test -p robogjc`, `cargo test -p gjc-app-server`, web typecheck/build, Docker smoke; obtain architect + critic pre-deletion signoff; commit.
