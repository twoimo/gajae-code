# robogjc Rust port golden fixtures

Fixtures under this directory are cross-implementation contracts for Phase 1 of the Rust port. Each JSON file is produced from the current Python `python/robogjc` implementation and consumed by Rust unit tests without rewriting expected values by hand.

Convention:

- Keep fixtures deterministic: fixed timestamps, keys, request paths, and input strings.
- Store phase-specific files under `phase1/` with `schema_version` and named cases.
- Regenerate expected values by running the Python implementation, then verify the Rust port consumes the same JSON.
- Track the broader Python test inventory and drop ledger at `docs/robogjc-rust-port/python-test-inventory.md`.

## Phase 1 provenance

Regenerate all Phase 1 vectors from the Python implementation with:

```sh
/tmp/robogjc-uv/bin/python crates/robogjc/tests/fixtures/phase1/regen.py
# or: uv run python crates/robogjc/tests/fixtures/phase1/regen.py
```

Last verified regeneration: `/tmp/robogjc-uv/bin/python crates/robogjc/tests/fixtures/phase1/regen.py` exited 0 on 2026-07-02 and left the checked-in fixture JSON byte-identical.

Current generator source inputs:

- `python/robogjc/src/proxy_hmac.py` sha256 `30f1721b46e03845ddebdb9c09d56e4e8ab1b6e8ca7a204a5877827b96d87d3a`
- `python/robogjc/src/git_ops.py` sha256 `137174fd304d33334d165f9763f3ddfdb05e300fc9752e0a289b306044135b70`
- `python/robogjc/src/sandbox.py` sha256 `0314045a42b3826f4fadc037878018a5540628db6388669f9109ae34c72c85eb`
