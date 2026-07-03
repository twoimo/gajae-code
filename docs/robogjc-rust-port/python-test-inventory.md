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

## App-server client fixture inventory (12 files)

| File | Rough tests | Disposition |
|---|---:|---|
| `__init__.py` | 0 | Drop with rationale: package marker only, no behavior to port. |
| `test_app_server.py` | 7 | Shared golden fixture / transpose only the app-server metadata and notification contract relevant to robogjc. |
| `test_client.py` | 24 | Shared golden fixture for host-tool and event frames; do not port full Python client ergonomics into robogjc. |
| `test_client_workflow_gate.py` | 3 | Drop from robogjc scope with rationale: workflow-gate client API is not part of the robogjc service port. |
| `test_context_and_unattended.py` | 5 | Shared golden fixture for session state metadata where it overlaps app-server resume metadata. |
| `test_host_uris.py` | 12 | Drop from robogjc scope unless host URI support becomes a robogjc dependency; currently outside target contract. |
| `test_protocol.py` | 24 | Shared golden fixture for protocol parsing shapes that intersect app-server notifications and metadata. |
| `test_real_binary.py` | 5 | Drop from default robogjc port with rationale: live binary app-server e2e belongs to the app-server package acceptance suite. |
| `test_registry.py` | 5 | Drop from robogjc scope unless robogjc owns session registry compatibility later. |
| `test_user_group.py` | 3 | Transpose only if Rust robogjc directly launches subprocesses with user/group isolation; otherwise covered by sandbox/permissions tests. |
| `test_workflow_gate.py` | 6 | Drop from robogjc scope: workflow-gate parsing is not a robogjc service requirement. |
| `test_workflow_gate_redteam.py` | 5 | Drop from robogjc scope: red-team gate client behavior remains in app-server conformance coverage. |

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
- `python/robogjc/tests/test_host_tools.py` is partially transposed for Phase 5 in executable Rust coverage. Current default Rust mapping: descriptor/schema fixture shape and fixture wiring (`descriptors_match_app_server_contract_fields`, `phase5_tool_name_fixture_matches_descriptors`); local tool-closure result redaction (`host_tool_closure_redacts_comment_result`); abort idempotence (`abort_task_signals_controller_once`); repro transcript creation (`repro_record_writes_transcript`); bug priority validation (`classify_requires_bug_priority`); branch-slug live binding + DB update parity (`classify_issue_branch_slug_updates_live_binding_branch`); question autoclose suffix/body/audit scheduling through `pending_closures` and `tool_calls` (`gh_post_comment_schedules_autoclose_for_question`); whitespace-label stripping/rejection (`labels_trim_and_reject_whitespace_only`); reviewer/assignee non-array rejection (`gh_request_review_rejects_non_array_reviewers_and_assignees`); dirty-tree pre-fix push gate (`gh_push_branch_dirty_tree_pre_fix_gate_blocks_push`); dirty-tree PR gate (`gh_open_pr_dirty_tree_gate_blocks_pr`); commit author scan rejection (`gh_push_branch_commit_author_scan_gate_rejects_wrong_identity`); bun check failure audit (`gh_push_branch_bun_check_failure_blocks_with_audit_row`); bun fix timeout audit without sleeping (`gh_push_branch_bun_fix_timeout_path_is_audited_without_sleeping`); skip-check audit row (`gh_push_branch_skip_checks_audit_row_recorded`); PR template and close-keyword validation (`gh_open_pr_template_validation_rejects_missing_sections_and_close_keyword`). The Rust suite does not claim a one-test-per-Python-test 49/49 mechanical port; Python live HTTP/client-edge coverage remains protected by the unchanged `python/robogjc/tests/test_host_tools.py` gate.
- `python/robogjc/tests/test_server.py` Phase 8 server-surface coverage is transposed into Rust unit tests with required prefixes: `server_routes_healthz_and_events_are_json`, `dashboard_status_reports_counts`, `manual_trigger_rejects_missing_token`, `manual_trigger_conflict_returns_409`, `manual_trigger_github_failure_returns_502`, and `cli_prefix_help_mentions_commands`. Stage 13 additionally wires the Rust `AutocloseScheduler` into `serve` start/stop lifecycle. The dashboard issue-browse webhook cache mutation remains explicitly deferred: `apply_webhook_cache` is still a no-op, so the Rust dashboard relies on cache TTL/live fetch instead of Python's immediate cache update on webhook delivery. Not every Python FastAPI assertion is duplicated one-for-one because the unchanged Python suite remains the parity oracle and Rust direct route tests currently avoid live GitHub/network fetches; Docker and web-build behavior are intentionally excluded from the required verification gates.
