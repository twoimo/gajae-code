//! Hardened `rusqlite` operational store — the daemon's safety authority.
//!
//! With enforced budgets and self-revision caps disabled (D3/D4), correctness
//! against duplicate/racing deliveries and concurrent runs rests on this store:
//! unique constraints dedupe events and work intents, and leased + fenced locks
//! enforce single-flight per item. The open sequence mirrors the repo's hardened
//! `packages/ai/src/auth-storage.ts` pattern: `busy_timeout` is set **before**
//! enabling WAL, and the DB file is created with restrictive permissions.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};

use crate::keys::{DedupKey, LockKey, WorkIntentKey};
use crate::state_machine::WorkItemState;

/// Current migration version stamped into `PRAGMA user_version`.
pub const SCHEMA_VERSION: i64 = 2;

/// Errors surfaced by the store.
#[derive(Debug)]
pub enum StoreError {
	/// Underlying `SQLite` failure.
	Sqlite(rusqlite::Error),
	/// A schema migration failed to apply.
	MigrationFailed(String),
	/// The lock is actively held by another holder (lease not expired).
	LeaseConflict,
	/// A mutation presented a fencing token that no longer owns the lock.
	FencingTokenStale,
}

impl core::fmt::Display for StoreError {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		match self {
			Self::Sqlite(e) => write!(f, "sqlite error: {e}"),
			Self::MigrationFailed(m) => write!(f, "migration_failed: {m}"),
			Self::LeaseConflict => write!(f, "lease_conflict"),
			Self::FencingTokenStale => write!(f, "fencing_token_stale"),
		}
	}
}

impl core::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
	fn from(e: rusqlite::Error) -> Self {
		Self::Sqlite(e)
	}
}

/// A held single-flight lock with its fencing token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockGuard {
	pub lock_key: String,
	pub fencing_token: i64,
}

/// The per-repo operational store.
pub struct GitDaemonStateStore {
	conn: Connection,
}

impl GitDaemonStateStore {
	/// Open (creating if needed) the store at `path`, applying the hardened
	/// PRAGMA sequence and migrations.
	///
	/// # Errors
	/// Returns [`StoreError`] if the parent directory cannot be created, the DB
	/// cannot be opened, a PRAGMA cannot be applied, or a migration fails.
	pub fn open(path: &Path) -> Result<Self, StoreError> {
		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent)
				.map_err(|e| StoreError::MigrationFailed(format!("create_dir_all: {e}")))?;
			Self::restrict_dir_permissions(parent)?;
		}
		let conn = Connection::open(path)?;
		Self::restrict_file_permissions(path)?;
		// busy_timeout BEFORE enabling WAL (matches the hardened auth-store order).
		conn.busy_timeout(Duration::from_secs(5))?;
		conn.pragma_update(None, "journal_mode", "WAL")?;
		conn.pragma_update(None, "synchronous", "NORMAL")?;
		conn.pragma_update(None, "foreign_keys", "ON")?;
		let store = Self { conn };
		store.migrate()?;
		Ok(store)
	}

	/// Open an in-memory store (tests only): same schema, no file permissions.
	///
	/// # Errors
	/// Returns [`StoreError`] if the connection or migrations fail.
	pub fn open_in_memory() -> Result<Self, StoreError> {
		let conn = Connection::open_in_memory()?;
		conn.busy_timeout(Duration::from_secs(5))?;
		conn.pragma_update(None, "foreign_keys", "ON")?;
		let store = Self { conn };
		store.migrate()?;
		Ok(store)
	}

	#[cfg(unix)]
	fn restrict_dir_permissions(dir: &Path) -> Result<(), StoreError> {
		use std::os::unix::fs::PermissionsExt as _;
		std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
			.map_err(|e| StoreError::MigrationFailed(format!("restrict dir 0700: {e}")))
	}

	#[cfg(unix)]
	fn restrict_file_permissions(file: &Path) -> Result<(), StoreError> {
		use std::os::unix::fs::PermissionsExt as _;
		std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
			.map_err(|e| StoreError::MigrationFailed(format!("restrict file 0600: {e}")))
	}

	#[cfg(not(unix))]
	fn restrict_dir_permissions(_dir: &Path) -> Result<(), StoreError> {
		Ok(())
	}

	#[cfg(not(unix))]
	fn restrict_file_permissions(_file: &Path) -> Result<(), StoreError> {
		Ok(())
	}

	fn migrate(&self) -> Result<(), StoreError> {
		let version: i64 = self.conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
		if version >= SCHEMA_VERSION {
			return Ok(());
		}
		self.conn
			.execute_batch(
				"BEGIN;
				CREATE TABLE IF NOT EXISTS forge_events (
					dedup_key      TEXT PRIMARY KEY,
					item_kind      TEXT NOT NULL,
					item_node_id   TEXT NOT NULL,
					event_family   TEXT NOT NULL,
					received_at    TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS work_items (
					work_key            TEXT PRIMARY KEY,
					item_kind           TEXT NOT NULL,
					item_node_id        TEXT NOT NULL,
					state               TEXT NOT NULL,
					last_event_revision TEXT,
					updated_at          TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS item_locks (
					lock_key         TEXT PRIMARY KEY,
					fencing_token    INTEGER NOT NULL,
					holder           TEXT NOT NULL,
					lease_expires_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS poll_cursors (
					resource    TEXT PRIMARY KEY,
					watermark   TEXT NOT NULL,
					etag        TEXT,
					updated_at  TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS fencing_seq (
					id    INTEGER PRIMARY KEY CHECK (id = 0),
					value INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS merge_gate_evidence (
					work_key    TEXT NOT NULL,
					head_sha    TEXT NOT NULL,
					base_branch TEXT NOT NULL,
					allow       INTEGER NOT NULL,
					reason      TEXT,
					recorded_at TEXT NOT NULL,
					PRIMARY KEY (work_key, head_sha)
				);
				INSERT OR IGNORE INTO fencing_seq (id, value) VALUES (0, 0);
				COMMIT;",
			)
			.map_err(|e| StoreError::MigrationFailed(e.to_string()))?;
		self.conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
		Ok(())
	}

	/// Insert an ingested event idempotently. Returns `true` if newly inserted,
	/// `false` if the dedupe key was already present (duplicate webhook/poll).
	///
	/// # Errors
	/// Returns [`StoreError`] on a `SQLite` failure.
	pub fn insert_event(
		&self,
		key: &DedupKey,
		item_kind: &str,
		item_node_id: &str,
		event_family: &str,
		received_at: &str,
	) -> Result<bool, StoreError> {
		let changed = self.conn.execute(
			"INSERT OR IGNORE INTO forge_events (dedup_key, item_kind, item_node_id, event_family, received_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)",
			rusqlite::params![key.as_str(), item_kind, item_node_id, event_family, received_at],
		)?;
		Ok(changed == 1)
	}

	/// Record a work intent idempotently. Returns `true` if this created the work
	/// item, `false` if an intent for the same key already existed (so a
	/// follow-up updates the existing item rather than opening a duplicate PR).
	///
	/// # Errors
	/// Returns [`StoreError`] on a `SQLite` failure.
	pub fn record_work_intent(
		&self,
		key: &WorkIntentKey,
		item_kind: &str,
		item_node_id: &str,
		updated_at: &str,
	) -> Result<bool, StoreError> {
		let changed = self.conn.execute(
			"INSERT OR IGNORE INTO work_items (work_key, item_kind, item_node_id, state, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)",
			rusqlite::params![
				key.as_str(),
				item_kind,
				item_node_id,
				WorkItemState::Seen.as_wire(),
				updated_at
			],
		)?;
		Ok(changed == 1)
	}

	/// List ready work items (state `seen` or `queued`) in FIFO order, up to
	/// `limit`. Returns `(work_key, item_kind, item_node_id)` tuples for the
	/// scheduler to dispatch.
	///
	/// # Errors
	/// Returns [`StoreError`] on a `SQLite` failure.
	pub fn list_ready_work(&self, limit: u32) -> Result<Vec<(String, String, String)>, StoreError> {
		let mut stmt = self.conn.prepare(
			"SELECT work_key, item_kind, item_node_id FROM work_items
			 WHERE state IN ('seen', 'queued') ORDER BY updated_at ASC, work_key ASC LIMIT ?1",
		)?;
		let rows = stmt.query_map([limit], |row| {
			Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
		})?;
		let mut out = Vec::new();
		for row in rows {
			out.push(row?);
		}
		Ok(out)
	}

	/// Update a work item's state (compare-and-set on `work_key`). Returns
	/// whether a row was updated.
	///
	/// # Errors
	/// Returns [`StoreError`] on a `SQLite` failure.
	pub fn set_work_state(&self, work_key: &str, state: WorkItemState, updated_at: &str) -> Result<bool, StoreError> {
		let changed = self.conn.execute(
			"UPDATE work_items SET state = ?2, updated_at = ?3 WHERE work_key = ?1",
			rusqlite::params![work_key, state.as_wire(), updated_at],
		)?;
		Ok(changed == 1)
	}

	/// Re-queue an existing work item on a follow-up event so the reconciler
	/// schedules it again, without creating a second work key. CAS: only items in
	/// a settled-but-reopenable state are moved back to `queued`; an item that is
	/// already ready (`seen`/`queued`) or actively `running` is left untouched so
	/// a follow-up cannot disrupt an in-flight run or duplicate ready work.
	/// Returns whether a row was re-queued.
	///
	/// # Errors
	/// Returns [`StoreError`] on a `SQLite` failure.
	pub fn requeue_work(&self, work_key: &str, updated_at: &str) -> Result<bool, StoreError> {
		let changed = self.conn.execute(
			"UPDATE work_items SET state = 'queued', updated_at = ?2
			 WHERE work_key = ?1 AND state NOT IN ('seen', 'queued', 'running')",
			rusqlite::params![work_key, updated_at],
		)?;
		Ok(changed == 1)
	}

	/// Persist the immutable, SHA-bound merge-gate decision BEFORE the merge call.
	/// Keyed by (`work_key`, `head_sha`) so the evidence for a given head is
	/// write-once; a conflicting re-write fails rather than overwriting history.
	/// The orchestrator must treat a write failure here as a merge denial
	/// (evidence-write-failure fails closed).
	///
	/// # Errors
	/// Returns [`StoreError`] on a `SQLite` failure (including a uniqueness
	/// conflict for an already-recorded head).
	pub fn persist_merge_evidence(
		&self,
		work_key: &str,
		head_sha: &str,
		base_branch: &str,
		allow: bool,
		reason: Option<&str>,
		recorded_at: &str,
	) -> Result<(), StoreError> {
		let changed = self.conn.execute(
			"INSERT INTO merge_gate_evidence (work_key, head_sha, base_branch, allow, reason, recorded_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
			rusqlite::params![work_key, head_sha, base_branch, i64::from(allow), reason, recorded_at],
		)?;
		if changed == 1 {
			Ok(())
		} else {
			Err(StoreError::MigrationFailed("merge evidence not persisted".to_owned()))
		}
	}

	/// Acquire a single-flight lock with a lease + fencing token. Steals a stale
	/// lease (expired) and bumps the fencing token; refuses an actively-held lock.
	///
	/// # Errors
	/// - [`StoreError::LeaseConflict`] when the lock is held with a live lease.
	/// - [`StoreError`] on a `SQLite` failure.
	pub fn acquire_lock(
		&mut self,
		key: &LockKey,
		holder: &str,
		now: &str,
		lease_expires_at: &str,
	) -> Result<LockGuard, StoreError> {
		let tx = self.conn.transaction()?;
		let existing: Option<String> = tx
			.query_row(
				"SELECT lease_expires_at FROM item_locks WHERE lock_key = ?1",
				rusqlite::params![key.as_str()],
				|row| row.get(0),
			)
			.optional()?;
		if let Some(expiry) = existing {
			if expiry.as_str() > now {
				return Err(StoreError::LeaseConflict);
			}
			// Stale lease: steal it.
			tx.execute("DELETE FROM item_locks WHERE lock_key = ?1", rusqlite::params![key.as_str()])?;
		}
		tx.execute("UPDATE fencing_seq SET value = value + 1 WHERE id = 0", [])?;
		let token: i64 = tx.query_row("SELECT value FROM fencing_seq WHERE id = 0", [], |row| row.get(0))?;
		tx.execute(
			"INSERT INTO item_locks (lock_key, fencing_token, holder, lease_expires_at)
			 VALUES (?1, ?2, ?3, ?4)",
			rusqlite::params![key.as_str(), token, holder, lease_expires_at],
		)?;
		tx.commit()?;
		Ok(LockGuard { lock_key: key.as_str().to_owned(), fencing_token: token })
	}

	/// Release a held lock. Fails closed if the fencing token no longer owns it
	/// (another holder stole a stale lease in between).
	///
	/// # Errors
	/// - [`StoreError::FencingTokenStale`] when the token no longer owns the lock.
	/// - [`StoreError`] on a `SQLite` failure.
	pub fn release_lock(&self, guard: &LockGuard) -> Result<(), StoreError> {
		let changed = self.conn.execute(
			"DELETE FROM item_locks WHERE lock_key = ?1 AND fencing_token = ?2",
			rusqlite::params![guard.lock_key, guard.fencing_token],
		)?;
		if changed == 0 {
			return Err(StoreError::FencingTokenStale);
		}
		Ok(())
	}
}

impl WorkItemState {
	/// `snake_case` wire token (matches the serde representation).
	#[must_use]
	pub const fn as_wire(self) -> &'static str {
		match self {
			Self::Seen => "seen",
			Self::Queued => "queued",
			Self::Running => "running",
			Self::PrOpen => "pr_open",
			Self::AwaitingCi => "awaiting_ci",
			Self::Revising => "revising",
			Self::MergeReady => "merge_ready",
			Self::MergedDev => "merged_dev",
			Self::Escalated => "escalated",
			Self::Blocked => "blocked",
			Self::StreamLost => "stream_lost",
			Self::Closed => "closed",
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::keys::{EventSource, ItemKind, ItemRef};

	fn item() -> ItemRef {
		ItemRef::new("github", "R_1", ItemKind::Issue, "I_9")
	}

	#[test]
	fn duplicate_event_dedupes_to_one_winner() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let key = DedupKey::new(&item(), "issues", &EventSource::Webhook { delivery_id: "d1".into() }, "r1");
		assert!(store.insert_event(&key, "issue", "I_9", "issues", "2026-01-01T00:00:00Z").unwrap());
		// A racing webhook + poll producing the same dedupe key inserts once.
		assert!(!store.insert_event(&key, "issue", "I_9", "issues", "2026-01-01T00:00:01Z").unwrap());
	}

	fn temp_db_path(tag: &str) -> std::path::PathBuf {
		let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
		std::env::temp_dir().join(format!("gd-store-{tag}-{}-{nanos}", std::process::id())).join("state.sqlite")
	}

	#[test]
	#[cfg(unix)]
	fn open_hardens_file_and_dir_permissions_to_0600_0700() {
		use std::os::unix::fs::PermissionsExt as _;
		let path = temp_db_path("perms");
		let _store = GitDaemonStateStore::open(&path).unwrap();
		let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
		let dir_mode = std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777;
		assert_eq!(file_mode, 0o600, "db file must be 0600");
		assert_eq!(dir_mode, 0o700, "db dir must be 0700");
		let _ = std::fs::remove_dir_all(path.parent().unwrap());
	}

	#[test]
	fn concurrent_two_connection_insert_has_exactly_one_winner() {
		use std::sync::{Arc, Barrier};
		// Two independent connections (separate threads) to the SAME file-backed
		// DB race to insert the same dedupe key; the unique constraint must admit
		// exactly one winner across connections.
		let path = temp_db_path("race");
		// Create the DB + schema once so both threads open an existing file.
		GitDaemonStateStore::open(&path).unwrap();
		let barrier = Arc::new(Barrier::new(2));
		let key = DedupKey::new(&item(), "issues", &EventSource::Webhook { delivery_id: "d1".into() }, "r1");
		let mut handles = Vec::new();
		for _ in 0..2 {
			let p = path.clone();
			let b = Arc::clone(&barrier);
			let k = key.clone();
			handles.push(std::thread::spawn(move || {
				let store = GitDaemonStateStore::open(&p).unwrap();
				b.wait();
				store.insert_event(&k, "issue", "I_9", "issues", "2026-01-01T00:00:00Z").unwrap()
			}));
		}
		let wins = handles.into_iter().map(|h| h.join().unwrap()).filter(|w| *w).count();
		assert_eq!(wins, 1, "exactly one connection may win the dedupe insert");
		let _ = std::fs::remove_dir_all(path.parent().unwrap());
	}

	#[test]
	fn work_intent_is_unique_so_no_duplicate_pr() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let key = item().work_intent_key("resolve");
		assert!(store.record_work_intent(&key, "issue", "I_9", "2026-01-01T00:00:00Z").unwrap());
		assert!(!store.record_work_intent(&key, "issue", "I_9", "2026-01-01T00:00:01Z").unwrap());
	}

	#[test]
	fn list_ready_work_returns_seen_and_queued_in_fifo() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let k1 = ItemRef::new("github", "R_1", ItemKind::Issue, "I_1").work_intent_key("resolve");
		let k2 = ItemRef::new("github", "R_1", ItemKind::Issue, "I_2").work_intent_key("resolve");
		store.record_work_intent(&k1, "issue", "I_1", "2026-01-01T00:00:00Z").unwrap();
		store.record_work_intent(&k2, "issue", "I_2", "2026-01-01T00:00:01Z").unwrap();
		let ready = store.list_ready_work(10).unwrap();
		assert_eq!(ready.len(), 2);
		assert_eq!(ready[0].0, k1.as_str()); // FIFO by updated_at
		// Move one to a non-ready state -> excluded.
		assert!(store.set_work_state(k1.as_str(), WorkItemState::MergedDev, "2026-01-01T00:01:00Z").unwrap());
		let ready = store.list_ready_work(10).unwrap();
		assert_eq!(ready.len(), 1);
		assert_eq!(ready[0].0, k2.as_str());
	}

	#[test]
	fn list_ready_work_respects_limit() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		for i in 0..5 {
			let k = ItemRef::new("github", "R_1", ItemKind::Issue, format!("I_{i}")).work_intent_key("resolve");
			store.record_work_intent(&k, "issue", &format!("I_{i}"), &format!("2026-01-01T00:00:0{i}Z")).unwrap();
		}
		assert_eq!(store.list_ready_work(3).unwrap().len(), 3);
	}

	#[test]
	fn lock_is_single_flight_and_refuses_live_lease() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let key = item().lock_key();
		let guard = store
			.acquire_lock(&key, "worker-a", "2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z")
			.unwrap();
		// Second acquire while the lease is live is refused.
		let err = store
			.acquire_lock(&key, "worker-b", "2026-01-01T00:01:00Z", "2026-01-01T00:11:00Z")
			.unwrap_err();
		assert!(matches!(err, StoreError::LeaseConflict));
		store.release_lock(&guard).unwrap();
	}

	#[test]
	fn stale_lease_takeover_bumps_fencing_token_and_invalidates_old() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let key = item().lock_key();
		let old = store
			.acquire_lock(&key, "worker-a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z")
			.unwrap();
		// After the lease expires, a new worker steals it with a higher token.
		let new = store
			.acquire_lock(&key, "worker-b", "2026-01-01T00:10:00Z", "2026-01-01T00:20:00Z")
			.unwrap();
		assert!(new.fencing_token > old.fencing_token);
		// The old holder can no longer release (fail-closed via fencing token).
		assert!(matches!(store.release_lock(&old).unwrap_err(), StoreError::FencingTokenStale));
		store.release_lock(&new).unwrap();
	}

	#[test]
	fn schema_version_is_stamped() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let v: i64 = store.conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
		assert_eq!(v, SCHEMA_VERSION);
	}

	#[test]
	fn file_open_applies_wal_and_persists() {
		let dir = std::env::temp_dir().join(format!("gitdaemon-test-{}", std::process::id()));
		let path = dir.join("git-daemon.sqlite");
		let _ = std::fs::remove_dir_all(&dir);
		{
			let store = GitDaemonStateStore::open(&path).unwrap();
			let mode: String =
				store.conn.pragma_query_value(None, "journal_mode", |row| row.get(0)).unwrap();
			assert_eq!(mode.to_lowercase(), "wal");
			let key = item().work_intent_key("resolve");
			assert!(store.record_work_intent(&key, "issue", "I_9", "2026-01-01T00:00:00Z").unwrap());
		}
		// Reopen: data persisted, dedupe still holds across connections.
		let store = GitDaemonStateStore::open(&path).unwrap();
		let key = item().work_intent_key("resolve");
		assert!(!store.record_work_intent(&key, "issue", "I_9", "2026-01-01T00:00:01Z").unwrap());
		let _ = std::fs::remove_dir_all(&dir);
	}
}
