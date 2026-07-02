# Python test inventory for the robogjc Rust port

Counts are rough static counts of `test_` functions/methods. Dispositions are Phase 0 porting guidance, not completed Rust coverage.

## `python/robogjc/tests/` (23 files, excluding package `__init__.py`)

| File | Rough tests | Disposition |
|---|---:|---|
| `conftest.py` | 0 | Transpose fixture concepts to Rust test helpers: temp DB, settings, repo fixtures, and fake GitHub/proxy clients. |
| `test_app_server_worker.py` | 0 | Transpose as integration harness scaffolding once the app-server worker boundary exists. |
| `test_autoclose.py` | 10 | Transpose to Rust scheduler tests; keep GitHub reaction payloads as shared golden fixtures. |
| `test_config.py` | 16 | Transpose to Rust config/env validation tests. |
| `test_db.py` | 27 | Transpose to Rust SQLite repository tests and share the Python-era DB fixture. |
| `test_github_client.py` | 11 | Transpose HTTP client behavior with mocked responses; share JSON error and PR/reaction fixtures. |
| `test_github_events.py` | 45 | Transpose webhook routing and signature tests; share webhook payloads as golden fixtures. |
| `test_host_tools.py` | 49 | Transpose host-tool binding tests after host-tool implementation; share transcript/result fixtures where possible. |
| `test_natives_cache.py` | 19 | Drop from robogjc Rust scope with rationale: native artifact cache belongs to the broader build/native system, not the initial robogjc service port. |
| `test_permissions_e2e.py` | 3 | Transpose as privileged/ignored Rust e2e tests or documented operator checks; not a default unit-test gate. |
| `test_persona.py` | 6 | Transpose prompt rendering snapshots; use shared golden prompt fixtures. |
| `test_pragmas.py` | 19 | Transpose parser tests directly to Rust. |
| `test_proxy_client.py` | 9 | Transpose proxy client round trips with mocked HTTP/Git transport. |
| `test_proxy_server.py` | 33 | Transpose proxy server HMAC and endpoint forwarding tests. |
| `test_queue_cancel.py` | 8 | Transpose queue cancellation semantics and slot reaping behavior. |
| `test_queue_shutdown.py` | 6 | Transpose graceful shutdown/drain behavior. |
| `test_sandbox.py` | 45 | Transpose deterministic workspace/branch/ref-repair logic; keep Git repository fixtures shared. |
| `test_server.py` | 58 | Transpose webhook/API server behavior; share request/response golden fixtures. |
| `test_slot_pool.py` | 5 | Transpose slot allocation and release behavior. |
| `test_tasks_directive.py` | 4 | Transpose directive parsing/rendering into Rust prompt/persona tests. |
| `test_worker.py` | 25 | Transpose worker orchestration with fake GitHub, DB, sandbox, and app-server clients. |
| `test_worker_pragmas.py` | 9 | Transpose worker-specific pragma application tests. |
| `test_worker_smoke.py` | 1 | Transpose as a Rust smoke/integration test after the worker path exists. |

## `python/gjc-rpc/tests/` (12 files)

| File | Rough tests | Disposition |
|---|---:|---|
| `__init__.py` | 0 | Drop with rationale: package marker only, no behavior to port. |
| `test_app_server.py` | 7 | Shared golden fixture / transpose only the app-server metadata and notification contract relevant to robogjc. |
| `test_client.py` | 24 | Shared golden fixture for host-tool and event frames; do not port full Python client ergonomics into robogjc. |
| `test_client_workflow_gate.py` | 3 | Drop from robogjc scope with rationale: workflow-gate client API is not part of the robogjc service port. |
| `test_context_and_unattended.py` | 5 | Shared golden fixture for session state metadata where it overlaps app-server resume metadata. |
| `test_host_uris.py` | 12 | Drop from robogjc scope unless host URI support becomes a robogjc dependency; currently outside target contract. |
| `test_protocol.py` | 24 | Shared golden fixture for protocol parsing shapes that intersect app-server notifications and metadata. |
| `test_real_binary.py` | 5 | Drop from default robogjc port with rationale: live binary RPC e2e belongs to the RPC package acceptance suite. |
| `test_registry.py` | 5 | Drop from robogjc scope unless robogjc owns session registry compatibility later. |
| `test_user_group.py` | 3 | Transpose only if Rust robogjc directly launches subprocesses with user/group isolation; otherwise covered by sandbox/permissions tests. |
| `test_workflow_gate.py` | 6 | Drop from robogjc scope: workflow-gate parsing is not a robogjc service requirement. |
| `test_workflow_gate_redteam.py` | 5 | Drop from robogjc scope: red-team gate client behavior remains in the RPC package. |

## Porting priorities

1. Start with config, pragma, DB, webhook routing, and app-server metadata/host-tool golden tests.
2. Add worker, queue, sandbox, and proxy tests as those modules move beyond stubs.
3. Keep Python-era SQLite and JSON webhook/RPC frames as shared fixtures so the Rust port proves compatibility rather than merely matching rewritten assertions.
4. Do not port tests that exercise unrelated Python package ergonomics unless robogjc takes ownership of that behavior.

## Recorded deviations / dropped compatibility edges

- `python/robogjc/src/db.py` pending-closure `finalize_closure` has no `state = 'claimed'` guard, so a second finalization can overwrite a terminal `closed` row with `cancelled`. Rust intentionally deviates from that bug: `Database::finalize_closure` returns `bool`, only updates claimed rows, and leaves double-finalize, cancel-after-finalize, and requeue-after-finalize as no-ops to preserve the documented `claimed -> terminal` lifecycle.
- The Rust Python-interpreter compatibility test is not a silent default pass. The committed Python-era SQLite fixture test fails if `artifacts/robogjc/db/python-era-v1.sqlite` is missing, while the live Python interpreter round trip is explicitly `ignored` unless run with `ROBGJC_PY_COMPAT=1` and `--ignored`.
- `python/robogjc/tests/test_github_events.py` is transposed for Phase 3 in `crates/robogjc/tests/github_phase3.rs`: signature rejection/acceptance, mention extraction, maintainer recognition, rate-limit tiers, and 29 route-decision cases are covered against golden expected-decision fixtures under `crates/robogjc/tests/fixtures/phase3/`. No event cases are intentionally omitted; Python helper-only assertions are covered as direct Rust assertions rather than payload fixtures.
- `python/robogjc/tests/test_github_client.py` is transposed for Phase 3 in `crates/robogjc/tests/github_phase3.rs` against a local Axum mock HTTP server. Python `github_client.py` parses `Retry-After`/`X-RateLimit-Reset` into `GitHubError.retry_after` but does not sleep or retry requests; Rust matches that no-retry behavior and verifies the parsed retry delay.
