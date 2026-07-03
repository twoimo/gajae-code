# robogjc Rust fixtures

Fixtures under this directory are checked-in contracts consumed by the Rust `crates/robogjc` tests. Some were originally produced during the Python-to-Rust port, but the Python robogjc package has been deleted; the Rust fixtures are now maintained directly alongside the Rust implementation.

Convention:

- Keep fixtures deterministic: fixed timestamps, keys, request paths, and input strings.
- Store phase-specific files under `phase*/` with `schema_version` and named cases.
- Update expected values only with the corresponding Rust behavior change and focused test evidence.
- Track the historical Python test inventory and drop ledger at `docs/robogjc-rust-port/python-test-inventory.md`.
