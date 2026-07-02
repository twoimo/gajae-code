# robogjc SQLite migration strategy

## Current Python-era schema inventory

Verified against `python/robogjc/src/db.py` (`SCHEMA`):

- `events`
- `issues`
- `tool_calls`
- `submissions`
- `pending_closures`

The Python schema also creates indexes `events_state_received`, `tool_calls_issue`, `submissions_login_ts`, and `pending_closures_state_close_at`.

## Versioning

Rust migrations use `PRAGMA user_version` as the canonical schema version. Version `1` is the Python-era baseline represented by the tables above. Every Rust migration must:

1. Read `PRAGMA user_version` in a transaction before applying changes.
2. Apply only migrations newer than the current value.
3. Set `PRAGMA user_version = <new version>` in the same successful migration transaction.
4. Leave a failed migration at the previous `user_version`.

## Python-era fixture plan

The fixture path for compatibility tests is:

```text
artifacts/robogjc/db/python-era-v1.sqlite
```

The fixture must be created by the Python implementation, not hand-authored SQL, so it captures Python defaults, indexes, and any implicit SQLite behavior. It should contain representative rows for:

- queued, running, done, failed, and skipped `events`
- `issues` with and without branch/session/PR metadata
- successful and failed `tool_calls`
- duplicate and distinct `submissions`
- pending, claimed, closed, and cancelled `pending_closures`

## Bidirectional compatibility requirement

Until the Python implementation is deleted, compatibility is bidirectional:

- Rust must read and preserve Python-era v1 databases.
- Python must continue to read any database produced by Rust migrations that are marked compatible.
- Rust must not drop, rename, or reinterpret Python-era columns while Python standby rollback is required.
- Any additive Rust migration must either be ignored safely by Python or be guarded behind a rollout step that prevents rollback to an incompatible Python binary.

## Backup, dry-run, and rollback

Before applying a Rust migration to an operator database:

1. Stop mutating consumers for the repo allowlist.
2. Checkpoint WAL state so the backup is complete.
3. Copy the database and sidecar files (`.sqlite`, `-wal`, `-shm`) to a timestamped backup location.
4. Run migration dry-run on the backup.
5. Validate `PRAGMA integrity_check`, `PRAGMA user_version`, and expected table/index inventory on the dry-run output.
6. Run a read-only compatibility smoke against both Rust and Python while Python rollback remains in scope.
7. Apply the migration to the live database only after dry-run success.

Rollback steps:

1. Stop Rust and any other mutating consumer.
2. Restore the timestamped database backup and sidecar files as a set.
3. Re-run `PRAGMA integrity_check`.
4. Re-enable the previous active consumer.
5. Record whether the restored database is Python-era v1 or a later compatible version.

## Deletion boundary

The bidirectional requirement remains until the Python implementation is deleted. After deletion, Rust migrations may remove Python-only compatibility code, but only in a migration that records the new `PRAGMA user_version` and documents the irreversible boundary.
