# Robogjc side-by-side parity

Phase 9 uses replay-based parity: the Rust port consumes the same golden inputs as the standby Python implementation and emits `artifacts/robogjc/qa/g010-parity-report.json` with `schemaVersion: 1`, `kind: "package-consumer-report"`, per-surface case counts, diffs, and a summary. The acceptance condition is zero unexplained diffs.

Covered surfaces:

- Webhook event routing: phase3 route payload fixtures are replayed through Rust `github::route`; the ignored parity gate also compares against Python `robogjc.github_events.route` via `/tmp/robogjc-uv/bin/python`.
- HMAC sign/verify: phase1 proxy HMAC vectors compare Rust `proxy::sign` to the Python-generated fixture, and the ignored gate compares to Python `proxy_hmac`.
- Credential redaction: phase1 vectors compare Rust `redaction::redact_credentials` to the Python-generated fixture, and the ignored gate compares to `robogjc.git_ops.redact_credentials`.
- DB row shapes: the ignored gate seeds the same phase2 operation sequence through Rust `Database` and Python `seed_python_era.py`, then compares normalized SQLite row shapes with volatile timestamps removed.
- Host-tool descriptor schemas: Rust `host_tools::descriptors()` is compared to the phase5 snapshot by default and to Python `robogjc.host_tools.build(None)` under the Python oracle gate.
- App-server worker transcripts: phase7 NDJSON transcripts are parsed and included in the parity report as the replay transcript corpus used by the Rust worker harness.

Commands:

```sh
cargo test -p robogjc
ROBGJC_PARITY=1 cargo test -p robogjc parity -- --ignored
```

The Python-oracle test is intentionally ignored unless `ROBGJC_PARITY=1` is set, because it depends on the standby interpreter at `/tmp/robogjc-uv/bin/python`. Default cargo test still exercises fixture-only parity comparisons and writes the parity report.

Environment-gated e2e suites that remain outside this self-check:

- harness M10-equivalent live harness parity
- Docker compose smoke
- `robogjc:test:integration`
- `worker_smoke --ignored`
