//! SQLite-backed durable event queue + bot state.

use std::{
	collections::{HashMap, HashSet},
	path::{Path, PathBuf},
	sync::Mutex,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter, types::Type};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;

pub type DbResult<T> = rusqlite::Result<T>;

pub const SCHEMA_VERSION: i32 = 1;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  delivery_id   TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  repo          TEXT,
  issue_key     TEXT,
  payload_json  TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  state         TEXT NOT NULL
    CHECK (state IN ('queued','running','done','failed','skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  model         TEXT
);

CREATE INDEX IF NOT EXISTS events_state_received
  ON events(state, received_at);

CREATE TABLE IF NOT EXISTS issues (
  key            TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  number         INTEGER NOT NULL,
  branch         TEXT,
  session_dir    TEXT,
  pr_number      INTEGER,
  state          TEXT NOT NULL,
  classification TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key     TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  result_json   TEXT,
  error         TEXT,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_issue ON tool_calls(issue_key, ts);

CREATE TABLE IF NOT EXISTS submissions (
  delivery_id   TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  repo          TEXT,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_login_ts ON submissions(login, ts);

CREATE TABLE IF NOT EXISTS pending_closures (
  issue_key     TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  number        INTEGER NOT NULL,
  comment_id    INTEGER NOT NULL,
  issue_author  TEXT NOT NULL,
  close_at      TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','claimed','closed','cancelled')),
  cancel_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_closures_state_close_at
  ON pending_closures(state, close_at);
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRow {
	pub delivery_id: String,
	pub event_type: String,
	pub repo: Option<String>,
	pub issue_key: Option<String>,
	pub payload: Value,
	pub received_at: String,
	pub state: String,
	pub attempts: i64,
	pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueRow {
	pub key: String,
	pub repo: String,
	pub number: i64,
	pub branch: Option<String>,
	pub session_dir: Option<String>,
	pub pr_number: Option<i64>,
	pub state: String,
	pub updated_at: String,
	pub classification: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmissionAdmission {
	pub accepted: bool,
	pub duplicate: bool,
	pub used: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingClosureRow {
	pub issue_key: String,
	pub repo: String,
	pub number: i64,
	pub comment_id: i64,
	pub issue_author: String,
	pub close_at: String,
	pub state: String,
	pub cancel_reason: Option<String>,
	pub created_at: String,
	pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningEvent {
	pub delivery_id: String,
	pub event_type: String,
	pub repo: Option<String>,
	pub issue_key: Option<String>,
	pub received_at: String,
	pub started_at: Option<String>,
	pub attempts: i64,
	pub model: Option<String>,
	pub last_tool: Option<String>,
	pub last_tool_ts: Option<String>,
}

pub fn issue_key(repo: &str, number: i64) -> String {
	format!("{repo}#{number}")
}

pub fn iso_seconds_ago(seconds: f64) -> String {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("system time before epoch");
	let micros = now.as_micros() as i128 - (seconds * 1_000_000.0).round() as i128;
	iso_from_unix_micros(micros)
}

fn utcnow() -> String {
	iso_seconds_ago(0.0)
}

fn iso_from_unix_micros(micros: i128) -> String {
	let secs = micros.div_euclid(1_000_000);
	let sub = micros.rem_euclid(1_000_000);
	let days = secs.div_euclid(86_400);
	let sod = secs.rem_euclid(86_400);
	let (y, m, d) = civil_from_days(days + 719_468);
	format!(
		"{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{sub:06}Z",
		sod / 3600,
		(sod % 3600) / 60,
		sod % 60
	)
}

fn civil_from_days(z: i128) -> (i128, i128, i128) {
	let era = (z - 1).div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096).div_euclid(365);
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2).div_euclid(153);
	let d = doy - (153 * mp + 2).div_euclid(5) + 1;
	let m = mp + if mp < 10 { 3 } else { -9 };
	(y + if m <= 2 { 1 } else { 0 }, m, d)
}

pub struct Database {
	path: PathBuf,
	conn: Mutex<Connection>,
}

impl Database {
	pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
		let path = path.as_ref().to_path_buf();
		if let Some(parent) = path.parent() {
			let _ = std::fs::create_dir_all(parent);
		}
		let conn = Connection::open(&path)?;
		conn.busy_timeout(Duration::from_secs(5))?;
		conn.execute_batch(SCHEMA)?;
		migrate(&conn)?;
		Ok(Self { path, conn: Mutex::new(conn) })
	}

	pub fn path(&self) -> &Path {
		&self.path
	}
	pub fn user_version(&self) -> DbResult<i32> {
		self
			.conn
			.lock()
			.unwrap()
			.query_row("PRAGMA user_version", [], |r| r.get(0))
	}

	pub fn record_event(
		&self,
		delivery_id: &str,
		event_type: &str,
		repo: Option<&str>,
		issue_key: Option<&str>,
		payload: &Value,
		state: &str,
		last_error: Option<&str>,
	) -> DbResult<bool> {
		let cur = self.conn.lock().unwrap().execute(r#"
                INSERT OR IGNORE INTO events
                  (delivery_id, event_type, repo, issue_key, payload_json, received_at, state, last_error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                "#, params![delivery_id, event_type, repo, issue_key, compact_json(payload), utcnow(), state, last_error])?;
		Ok(cur > 0)
	}

	pub fn claim_next_event(&self) -> DbResult<Option<EventRow>> {
		let mut conn = self.conn.lock().unwrap();
		let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
		let row = tx
			.query_row(
				r#"
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events
                WHERE state = 'queued'
                ORDER BY received_at
                LIMIT 1
                "#,
				[],
				event_from_row,
			)
			.optional()?;
		let Some(mut row) = row else {
			tx.commit()?;
			return Ok(None);
		};
		tx.execute(
			"UPDATE events SET state='running', attempts=attempts+1, started_at=? WHERE delivery_id=?",
			params![utcnow(), row.delivery_id],
		)?;
		tx.commit()?;
		row.state = "running".into();
		row.attempts += 1;
		Ok(Some(row))
	}

	pub fn mark_event(&self, delivery_id: &str, state: &str, error: Option<&str>) -> DbResult<()> {
		self.conn.lock().unwrap().execute(
			"UPDATE events SET state=?, last_error=?, finished_at=? WHERE delivery_id=?",
			params![state, error, utcnow(), delivery_id],
		)?;
		Ok(())
	}
	pub fn set_event_model(&self, delivery_id: &str, model: &str) -> DbResult<()> {
		self
			.conn
			.lock()
			.unwrap()
			.execute("UPDATE events SET model=? WHERE delivery_id=?", params![model, delivery_id])?;
		Ok(())
	}
	pub fn reset_stuck_running(&self) -> DbResult<usize> {
		self
			.conn
			.lock()
			.unwrap()
			.execute("UPDATE events SET state='queued' WHERE state='running'", [])
	}
	pub fn remove_event(&self, delivery_id: &str) -> DbResult<()> {
		self
			.conn
			.lock()
			.unwrap()
			.execute("DELETE FROM events WHERE delivery_id=?", params![delivery_id])?;
		Ok(())
	}

	pub fn list_events(&self, limit: i64) -> DbResult<Vec<EventRow>> {
		let conn = self.conn.lock().unwrap();
		let mut st = conn.prepare(
			r#"
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events
                ORDER BY received_at DESC
                LIMIT ?
                "#,
		)?;
		st.query_map(params![limit], event_from_row)?.collect()
	}

	pub fn replace_event_if_state_in(
		&self,
		delivery_id: &str,
		event_type: &str,
		repo: Option<&str>,
		issue_key: Option<&str>,
		payload: &Value,
		state: &str,
		allowed_existing_states: &[&str],
	) -> DbResult<bool> {
		let mut conn = self.conn.lock().unwrap();
		let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
		let existing: Option<String> = tx
			.query_row("SELECT state FROM events WHERE delivery_id = ?", params![delivery_id], |r| {
				r.get(0)
			})
			.optional()?;
		if let Some(s) = existing {
			if !allowed_existing_states.contains(&s.as_str()) {
				tx.commit()?;
				return Ok(false);
			}
			tx.execute("DELETE FROM events WHERE delivery_id = ?", params![delivery_id])?;
		}
		tx.execute(
			r#"
                INSERT INTO events
                  (delivery_id, event_type, repo, issue_key, payload_json, received_at, state)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                "#,
			params![delivery_id, event_type, repo, issue_key, compact_json(payload), utcnow(), state],
		)?;
		tx.commit()?;
		Ok(true)
	}

	pub fn latest_event_for_issue(
		&self,
		key: &str,
		include_skipped: bool,
	) -> DbResult<Option<EventRow>> {
		let sql = format!(
			r#"
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events
                WHERE issue_key = ?
                  {}
                ORDER BY received_at DESC, rowid DESC
                LIMIT 1
                "#,
			if include_skipped {
				""
			} else {
				"AND state <> 'skipped'"
			}
		);
		self
			.conn
			.lock()
			.unwrap()
			.query_row(&sql, params![key], event_from_row)
			.optional()
	}

	pub fn latest_events_for_issues(
		&self,
		keys: &[String],
		include_skipped: bool,
	) -> DbResult<HashMap<String, EventRow>> {
		let unique: Vec<String> = keys
			.iter()
			.filter(|k| !k.is_empty())
			.cloned()
			.collect::<HashSet<_>>()
			.into_iter()
			.collect();
		let mut out = HashMap::new();
		if unique.is_empty() {
			return Ok(out);
		};
		let conn = self.conn.lock().unwrap();
		for batch in unique.chunks(500) {
			let placeholders = vec!["?"; batch.len()].join(",");
			let sql = format!(
				r#"
                    SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                           state, attempts, last_error
                    FROM events
                    WHERE issue_key IN ({placeholders})
                      {}
                    ORDER BY issue_key ASC, received_at DESC, rowid DESC
                    "#,
				if include_skipped {
					""
				} else {
					"AND state <> 'skipped'"
				}
			);
			let mut st = conn.prepare(&sql)?;
			let rows: Vec<EventRow> = st
				.query_map(params_from_iter(batch), event_from_row)?
				.collect::<DbResult<_>>()?;
			for row in rows {
				if let Some(k) = row.issue_key.clone() {
					out.entry(k).or_insert(row);
				}
			}
		}
		Ok(out)
	}

	pub fn event_state_counts(&self) -> DbResult<HashMap<String, i64>> {
		let mut counts = state_count_map();
		let conn = self.conn.lock().unwrap();
		let mut st = conn.prepare("SELECT state, COUNT(*) AS n FROM events GROUP BY state")?;
		for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
			let (s, n) = row?;
			counts.insert(s, n);
		}
		Ok(counts)
	}
	pub fn latest_issue_event_state_counts(&self) -> DbResult<HashMap<String, i64>> {
		let mut counts = state_count_map();
		let conn = self.conn.lock().unwrap();
		let mut seen = HashSet::new();
		let mut st = conn.prepare(
			r#"
                SELECT issue_key, state
                FROM events
                WHERE issue_key IS NOT NULL
                  AND state <> 'skipped'
                ORDER BY issue_key ASC, received_at DESC, rowid DESC
                "#,
		)?;
		for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
			let (k, s) = row?;
			if seen.insert(k) {
				*counts.entry(s).or_insert(0) += 1;
			}
		}
		Ok(counts)
	}
	pub fn list_running_events(&self) -> DbResult<Vec<RunningEvent>> {
		let conn = self.conn.lock().unwrap();
		let mut st = conn.prepare(
			r#"
                SELECT e.delivery_id, e.event_type, e.repo, e.issue_key, e.received_at,
                       e.started_at, e.attempts, e.model,
                       (SELECT tool FROM tool_calls
                          WHERE issue_key = e.issue_key AND ts >= e.started_at
                          ORDER BY ts DESC LIMIT 1) AS last_tool,
                       (SELECT ts FROM tool_calls
                          WHERE issue_key = e.issue_key AND ts >= e.started_at
                          ORDER BY ts DESC LIMIT 1) AS last_tool_ts
                FROM events e
                WHERE e.state = 'running'
                ORDER BY COALESCE(e.started_at, e.received_at)
                "#,
		)?;
		st.query_map([], |r| {
			Ok(RunningEvent {
				delivery_id: r.get(0)?,
				event_type: r.get(1)?,
				repo: r.get(2)?,
				issue_key: r.get(3)?,
				received_at: r.get(4)?,
				started_at: r.get(5)?,
				attempts: r.get(6)?,
				model: r.get(7)?,
				last_tool: r.get(8)?,
				last_tool_ts: r.get(9)?,
			})
		})?
		.collect()
	}
	pub fn get_event(&self, delivery_id: &str) -> DbResult<Option<EventRow>> {
		self
			.conn
			.lock()
			.unwrap()
			.query_row(
				r#"
                SELECT delivery_id, event_type, repo, issue_key, payload_json, received_at,
                       state, attempts, last_error
                FROM events WHERE delivery_id = ?
                "#,
				params![delivery_id],
				event_from_row,
			)
			.optional()
	}
	pub fn requeue_event(&self, delivery_id: &str, from_states: Option<&[&str]>) -> DbResult<bool> {
		let conn = self.conn.lock().unwrap();
		let n = match from_states {
			None => conn.execute(
				"UPDATE events SET state='queued' WHERE delivery_id=?",
				params![delivery_id],
			)?,
			Some([]) => 0,
			Some(states) => {
				let placeholders = vec!["?"; states.len()].join(",");
				let sql = format!(
					"UPDATE events SET state='queued' WHERE delivery_id=? AND state IN ({placeholders})"
				);
				let vals = std::iter::once(delivery_id.to_string())
					.chain(states.iter().map(|s| (*s).to_string()))
					.collect::<Vec<_>>();
				conn.execute(&sql, params_from_iter(vals))?
			},
		};
		Ok(n > 0)
	}

	pub fn upsert_issue(
		&self,
		key: &str,
		repo: &str,
		number: i64,
		state: &str,
		branch: Option<&str>,
		session_dir: Option<&str>,
		pr_number: Option<i64>,
	) -> DbResult<IssueRow> {
		self.conn.lock().unwrap().execute(r#"
                INSERT INTO issues (key, repo, number, branch, session_dir, pr_number, state, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  branch = COALESCE(excluded.branch, issues.branch),
                  session_dir = COALESCE(excluded.session_dir, issues.session_dir),
                  pr_number = COALESCE(excluded.pr_number, issues.pr_number),
                  state = excluded.state,
                  updated_at = excluded.updated_at
                "#, params![key, repo, number, branch, session_dir, pr_number, state, utcnow()])?;
		Ok(self.get_issue(key)?.expect("upserted issue missing"))
	}
	pub fn set_issue_state(&self, key: &str, state: &str) -> DbResult<()> {
		self.conn.lock().unwrap().execute(
			"UPDATE issues SET state=?, updated_at=? WHERE key=?",
			params![state, utcnow(), key],
		)?;
		Ok(())
	}
	pub fn set_issue_pr(&self, key: &str, pr_number: i64) -> DbResult<()> {
		self.conn.lock().unwrap().execute(
			"UPDATE issues SET pr_number=?, updated_at=? WHERE key=?",
			params![pr_number, utcnow(), key],
		)?;
		Ok(())
	}
	pub fn set_issue_classification(&self, key: &str, classification: &str) -> DbResult<()> {
		self.conn.lock().unwrap().execute(
			"UPDATE issues SET classification=?, updated_at=? WHERE key=?",
			params![classification, utcnow(), key],
		)?;
		Ok(())
	}
	pub fn set_issue_branch(&self, key: &str, branch: &str) -> DbResult<()> {
		self.conn.lock().unwrap().execute(
			"UPDATE issues SET branch=?, updated_at=? WHERE key=?",
			params![branch, utcnow(), key],
		)?;
		Ok(())
	}
	pub fn get_issue(&self, key: &str) -> DbResult<Option<IssueRow>> {
		self.conn.lock().unwrap().query_row("SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at FROM issues WHERE key=?", params![key], issue_from_row).optional()
	}
	pub fn find_issue_by_pr(&self, repo: &str, pr_number: i64) -> DbResult<Option<IssueRow>> {
		self.conn.lock().unwrap().query_row("SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at FROM issues WHERE repo=? AND pr_number=?", params![repo, pr_number], issue_from_row).optional()
	}
	pub fn find_issue_by_branch(&self, repo: &str, branch: &str) -> DbResult<Option<IssueRow>> {
		self.conn.lock().unwrap().query_row(r#"
                SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at
                FROM issues
                WHERE repo=? AND branch=?
                ORDER BY updated_at DESC
                LIMIT 1
                "#, params![repo, branch], issue_from_row).optional()
	}
	pub fn list_issues(&self, limit: i64) -> DbResult<Vec<IssueRow>> {
		let conn = self.conn.lock().unwrap();
		let mut st=conn.prepare("SELECT key, repo, number, branch, session_dir, pr_number, state, classification, updated_at FROM issues ORDER BY updated_at DESC LIMIT ?")?;
		st.query_map(params![limit], issue_from_row)?.collect()
	}
	pub fn processed_issue_keys(&self, keys: &[String]) -> DbResult<HashSet<String>> {
		let unique: Vec<String> = keys
			.iter()
			.filter(|k| !k.is_empty())
			.cloned()
			.collect::<HashSet<_>>()
			.into_iter()
			.collect();
		let mut out = HashSet::new();
		if unique.is_empty() {
			return Ok(out);
		};
		let conn = self.conn.lock().unwrap();
		for batch in unique.chunks(500) {
			let placeholders = vec!["?"; batch.len()].join(",");
			let sql = format!("SELECT key FROM issues WHERE key IN ({placeholders})");
			let mut st = conn.prepare(&sql)?;
			for row in st.query_map(params_from_iter(batch), |r| r.get::<_, String>(0))? {
				out.insert(row?);
			}
		}
		Ok(out)
	}

	pub fn log_tool_call(
		&self,
		issue_key: &str,
		tool: &str,
		args: &Value,
		result: Option<&Value>,
		error: Option<&str>,
	) -> DbResult<i64> {
		let conn = self.conn.lock().unwrap();
		conn.execute("INSERT INTO tool_calls (issue_key, tool, args_json, result_json, error, ts) VALUES (?, ?, ?, ?, ?, ?)", params![issue_key, tool, compact_json(args), result.map(compact_json), error, utcnow()])?;
		Ok(conn.last_insert_rowid())
	}

	pub fn admit_submission(
		&self,
		delivery_id: &str,
		login: &str,
		repo: Option<&str>,
		since: &str,
		cap: Option<i64>,
	) -> DbResult<SubmissionAdmission> {
		let normalized = login.to_lowercase();
		let mut conn = self.conn.lock().unwrap();
		let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
		let existing: Option<i64> = tx
			.query_row("SELECT 1 FROM submissions WHERE delivery_id=?", params![delivery_id], |r| {
				r.get(0)
			})
			.optional()?;
		if existing.is_some() {
			let used = count_submissions_tx(&tx, &normalized, since)?;
			tx.commit()?;
			return Ok(SubmissionAdmission { accepted: true, duplicate: true, used });
		}
		let used = count_submissions_tx(&tx, &normalized, since)?;
		if cap.is_some_and(|c| used >= c) {
			tx.commit()?;
			return Ok(SubmissionAdmission { accepted: false, duplicate: false, used });
		}
		tx.execute(
			"INSERT INTO submissions (delivery_id, login, repo, ts) VALUES (?, ?, ?, ?)",
			params![delivery_id, normalized, repo, utcnow()],
		)?;
		tx.commit()?;
		Ok(SubmissionAdmission { accepted: true, duplicate: false, used: used + 1 })
	}
	pub fn record_submission(
		&self,
		delivery_id: &str,
		login: &str,
		repo: Option<&str>,
	) -> DbResult<bool> {
		let n = self.conn.lock().unwrap().execute(
			"INSERT OR IGNORE INTO submissions (delivery_id, login, repo, ts) VALUES (?, ?, ?, ?)",
			params![delivery_id, login.to_lowercase(), repo, utcnow()],
		)?;
		Ok(n > 0)
	}
	pub fn count_submissions_since(&self, login: &str, since: &str) -> DbResult<i64> {
		self.conn.lock().unwrap().query_row(
			"SELECT COUNT(*) AS n FROM submissions WHERE login=? AND ts>=?",
			params![login.to_lowercase(), since],
			|r| r.get(0),
		)
	}

	pub fn upsert_pending_closure(
		&self,
		issue_key: &str,
		repo: &str,
		number: i64,
		comment_id: i64,
		issue_author: &str,
		close_at: &str,
	) -> DbResult<()> {
		let now = utcnow();
		self.conn.lock().unwrap().execute(
			r#"
                INSERT INTO pending_closures
                  (issue_key, repo, number, comment_id, issue_author, close_at,
                   state, cancel_reason, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
                ON CONFLICT(issue_key) DO UPDATE SET
                  repo = excluded.repo,
                  number = excluded.number,
                  comment_id = excluded.comment_id,
                  issue_author = excluded.issue_author,
                  close_at = excluded.close_at,
                  state = 'pending',
                  cancel_reason = NULL,
                  updated_at = excluded.updated_at
                "#,
			params![
				issue_key,
				repo,
				number,
				comment_id,
				issue_author.to_lowercase(),
				close_at,
				now,
				now
			],
		)?;
		Ok(())
	}
	pub fn claim_due_closures(&self, now: &str, limit: i64) -> DbResult<Vec<PendingClosureRow>> {
		let mut conn = self.conn.lock().unwrap();
		let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
		let rows = {
			let mut st = tx.prepare(
				r#"
                UPDATE pending_closures
                SET state = 'claimed', updated_at = ?
                WHERE issue_key IN (
                  SELECT issue_key FROM pending_closures
                  WHERE state = 'pending' AND close_at <= ?
                  ORDER BY close_at
                  LIMIT ?
                )
                RETURNING issue_key, repo, number, comment_id, issue_author,
                          close_at, state, cancel_reason, created_at, updated_at
                "#,
			)?;
			st.query_map(params![now, now, limit], pending_from_row)?
				.collect::<DbResult<Vec<_>>>()?
		};
		tx.commit()?;
		Ok(rows)
	}
	pub fn finalize_closure(
		&self,
		issue_key: &str,
		state: &str,
		reason: Option<&str>,
	) -> DbResult<bool> {
		if !matches!(state, "closed" | "cancelled") {
			return Err(rusqlite::Error::InvalidParameterName(format!(
				"finalize_closure: invalid terminal state {state:?}"
			)));
		}
		let n = self.conn.lock().unwrap().execute(
			r#"
                UPDATE pending_closures
                SET state = ?, cancel_reason = ?, updated_at = ?
                WHERE issue_key = ? AND state = 'claimed'
                "#,
			params![state, reason, utcnow(), issue_key],
		)?;
		Ok(n > 0)
	}
	pub fn requeue_claimed_closure(&self, issue_key: &str) -> DbResult<bool> {
		let n = self.conn.lock().unwrap().execute(
			r#"
                UPDATE pending_closures
                SET state = 'pending', updated_at = ?
                WHERE issue_key = ? AND state = 'claimed'
                "#,
			params![utcnow(), issue_key],
		)?;
		Ok(n > 0)
	}
	pub fn cancel_pending_closure(&self, issue_key: &str, reason: &str) -> DbResult<bool> {
		let n = self.conn.lock().unwrap().execute(
			r#"
                UPDATE pending_closures
                SET state = 'cancelled', cancel_reason = ?, updated_at = ?
                WHERE issue_key = ? AND state = 'pending'
                "#,
			params![reason, utcnow(), issue_key],
		)?;
		Ok(n > 0)
	}
	pub fn get_pending_closure(&self, issue_key: &str) -> DbResult<Option<PendingClosureRow>> {
		self
			.conn
			.lock()
			.unwrap()
			.query_row(
				r#"
                SELECT issue_key, repo, number, comment_id, issue_author,
                       close_at, state, cancel_reason, created_at, updated_at
                FROM pending_closures WHERE issue_key = ?
                "#,
				params![issue_key],
				pending_from_row,
			)
			.optional()
	}
}

fn migrate(conn: &Connection) -> DbResult<()> {
	let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
	let issue_cols = table_cols(conn, "issues")?;
	if !issue_cols.contains("classification") {
		conn.execute("ALTER TABLE issues ADD COLUMN classification TEXT", [])?;
	}
	let event_cols = table_cols(conn, "events")?;
	if !event_cols.contains("model") {
		conn.execute("ALTER TABLE events ADD COLUMN model TEXT", [])?;
	}
	if version < SCHEMA_VERSION {
		conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
	}
	Ok(())
}
fn table_cols(conn: &Connection, table: &str) -> DbResult<HashSet<String>> {
	let mut st = conn.prepare(&format!("PRAGMA table_info({table})"))?;
	st.query_map([], |r| r.get::<_, String>(1))?.collect()
}
fn compact_json(v: &Value) -> String {
	serde_json::to_string(v).expect("json value serializes")
}
fn event_from_row(row: &Row<'_>) -> DbResult<EventRow> {
	let payload_s: String = row.get("payload_json")?;
	let payload = serde_json::from_str(&payload_s)
		.map_err(|err| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(err)))?;
	Ok(EventRow {
		delivery_id: row.get("delivery_id")?,
		event_type: row.get("event_type")?,
		repo: row.get("repo")?,
		issue_key: row.get("issue_key")?,
		payload,
		received_at: row.get("received_at")?,
		state: row.get("state")?,
		attempts: row.get("attempts")?,
		last_error: row.get("last_error")?,
	})
}
fn issue_from_row(row: &Row<'_>) -> DbResult<IssueRow> {
	Ok(IssueRow {
		key: row.get("key")?,
		repo: row.get("repo")?,
		number: row.get("number")?,
		branch: row.get("branch")?,
		session_dir: row.get("session_dir")?,
		pr_number: row.get("pr_number")?,
		state: row.get("state")?,
		classification: row.get("classification")?,
		updated_at: row.get("updated_at")?,
	})
}
fn pending_from_row(row: &Row<'_>) -> DbResult<PendingClosureRow> {
	Ok(PendingClosureRow {
		issue_key: row.get("issue_key")?,
		repo: row.get("repo")?,
		number: row.get("number")?,
		comment_id: row.get("comment_id")?,
		issue_author: row.get("issue_author")?,
		close_at: row.get("close_at")?,
		state: row.get("state")?,
		cancel_reason: row.get("cancel_reason")?,
		created_at: row.get("created_at")?,
		updated_at: row.get("updated_at")?,
	})
}
fn state_count_map() -> HashMap<String, i64> {
	["queued", "running", "done", "failed", "skipped"]
		.into_iter()
		.map(|s| (s.to_string(), 0))
		.collect()
}
fn count_submissions_tx(tx: &rusqlite::Transaction<'_>, login: &str, since: &str) -> DbResult<i64> {
	tx.query_row(
		"SELECT COUNT(*) AS n FROM submissions WHERE login=? AND ts>=?",
		params![login, since],
		|r| r.get(0),
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::{
		fs,
		process::{Command, Stdio},
		sync::{Arc, Barrier, mpsc},
		thread,
		time::Duration as StdDuration,
	};
	use tempfile::tempdir;

	fn db() -> (tempfile::TempDir, Database) {
		let dir = tempdir().unwrap();
		let database = Database::open(dir.path().join("test.sqlite")).unwrap();
		(dir, database)
	}

	#[test]
	fn record_event_dedupes_by_delivery() {
		let (_d, db) = db();
		let p = json!({"action":"opened","issue":{"number":1}});
		assert!(
			db.record_event(
				"abc",
				"issues",
				Some("octo/widget"),
				Some(&issue_key("octo/widget", 1)),
				&p,
				"queued",
				None
			)
			.unwrap()
		);
		assert!(
			!db.record_event(
				"abc",
				"issues",
				Some("octo/widget"),
				Some(&issue_key("octo/widget", 1)),
				&p,
				"queued",
				None
			)
			.unwrap()
		);
	}
	#[test]
	fn db_claim_contention() {
		let dir = tempdir().unwrap();
		let path = dir.path().join("events.sqlite");
		Database::open(&path).unwrap();
		for i in 0..5 {
			Database::open(&path)
				.unwrap()
				.record_event(
					&format!("d-{i}"),
					"issues",
					Some("octo/widget"),
					Some(&issue_key("octo/widget", i)),
					&json!({"i":i}),
					"queued",
					None,
				)
				.unwrap();
		}
		let mut handles = vec![];
		for _ in 0..40 {
			let p = path.clone();
			handles.push(thread::spawn(move || {
				Database::open(p)
					.unwrap()
					.claim_next_event()
					.unwrap()
					.map(|r| r.delivery_id)
			}));
		}
		let mut winners = handles
			.into_iter()
			.filter_map(|h| h.join().unwrap())
			.collect::<Vec<_>>();
		winners.sort();
		assert_eq!(winners, (0..5).map(|i| format!("d-{i}")).collect::<Vec<_>>());
	}
	#[test]
	fn claim_next_event_singleton_under_contention() {
		db_claim_contention();
	}
	#[test]
	fn claim_next_event_waits_for_immediate_writer_lock() {
		let dir = tempdir().unwrap();
		let path = dir.path().join("blocked-claim.sqlite");
		let db = Database::open(&path).unwrap();
		db.record_event("blocked", "issues", None, None, &json!({}), "queued", None)
			.unwrap();
		let mut lock_conn = Connection::open(&path).unwrap();
		lock_conn.busy_timeout(StdDuration::from_secs(5)).unwrap();
		let tx = lock_conn
			.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
			.unwrap();
		tx.execute("UPDATE events SET last_error = NULL WHERE delivery_id = 'blocked'", [])
			.unwrap();
		let (sender, receiver) = mpsc::channel();
		let claim_path = path.clone();
		let handle = thread::spawn(move || {
			let claimed = Database::open(claim_path)
				.unwrap()
				.claim_next_event()
				.unwrap()
				.map(|row| row.delivery_id);
			sender.send(claimed).unwrap();
		});
		assert!(
			receiver
				.recv_timeout(StdDuration::from_millis(100))
				.is_err()
		);
		tx.commit().unwrap();
		assert_eq!(
			receiver.recv_timeout(StdDuration::from_secs(2)).unwrap(),
			Some("blocked".to_string())
		);
		handle.join().unwrap();
	}
	#[test]
	fn invalid_payload_json_returns_db_error() {
		let (_d, db) = db();
		db.record_event("bad-json", "issues", None, None, &json!({}), "queued", None)
			.unwrap();
		db.conn
			.lock()
			.unwrap()
			.execute("UPDATE events SET payload_json = '{' WHERE delivery_id = 'bad-json'", [])
			.unwrap();
		assert!(db.get_event("bad-json").is_err());
	}
	#[test]
	fn requeue_event_can_be_restricted_by_source_state() {
		let (_d, db) = db();
		db.record_event(
			"done-event",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#1"),
			&json!({}),
			"done",
			None,
		)
		.unwrap();
		db.record_event(
			"running-event",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#2"),
			&json!({}),
			"running",
			None,
		)
		.unwrap();
		assert!(
			db.requeue_event("done-event", Some(&["done", "failed", "skipped"]))
				.unwrap()
		);
		assert_eq!(db.get_event("done-event").unwrap().unwrap().state, "queued");
		assert!(
			!db.requeue_event("running-event", Some(&["done", "failed", "skipped"]))
				.unwrap()
		);
	}
	#[test]
	fn latest_issue_events_ignore_skipped_noise() {
		let (_d, db) = db();
		let fixed = issue_key("octo/widget", 1);
		let failed = issue_key("octo/widget", 2);
		db.record_event(
			"fixed-failed",
			"issues",
			Some("octo/widget"),
			Some(&fixed),
			&json!({}),
			"failed",
			None,
		)
		.unwrap();
		db.record_event(
			"fixed-done",
			"issues",
			Some("octo/widget"),
			Some(&fixed),
			&json!({}),
			"done",
			None,
		)
		.unwrap();
		db.record_event(
			"failed-run",
			"issues",
			Some("octo/widget"),
			Some(&failed),
			&json!({}),
			"failed",
			None,
		)
		.unwrap();
		db.record_event(
			"label-noise",
			"issues",
			Some("octo/widget"),
			Some(&failed),
			&json!({}),
			"skipped",
			Some("ignored"),
		)
		.unwrap();
		assert_eq!(
			db.latest_event_for_issue(&failed, false)
				.unwrap()
				.unwrap()
				.delivery_id,
			"failed-run"
		);
		assert_eq!(
			db.latest_event_for_issue(&failed, true)
				.unwrap()
				.unwrap()
				.delivery_id,
			"label-noise"
		);
		let latest = db
			.latest_events_for_issues(&[fixed.clone(), failed.clone()], false)
			.unwrap();
		assert_eq!(latest[&fixed].delivery_id, "fixed-done");
		assert_eq!(latest[&failed].delivery_id, "failed-run");
		let counts = db.latest_issue_event_state_counts().unwrap();
		assert_eq!(counts["done"], 1);
		assert_eq!(counts["failed"], 1);
		assert_eq!(counts["skipped"], 0);
	}
	#[test]
	fn reset_stuck_running_recovers() {
		let (_d, db) = db();
		db.record_event(
			"d1",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#1"),
			&json!({}),
			"queued",
			None,
		)
		.unwrap();
		assert!(db.claim_next_event().unwrap().is_some());
		assert_eq!(db.reset_stuck_running().unwrap(), 1);
		assert_eq!(db.get_event("d1").unwrap().unwrap().state, "queued");
	}
	#[test]
	fn upsert_issue_round_trip() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 7);
		assert_eq!(
			db.upsert_issue(&key, "octo/widget", 7, "new", None, None, None)
				.unwrap()
				.state,
			"new"
		);
		let row = db
			.upsert_issue(
				&key,
				"octo/widget",
				7,
				"opened",
				Some("farm/abcd1234/some-issue"),
				Some("/tmp/s"),
				Some(42),
			)
			.unwrap();
		assert_eq!(row.pr_number, Some(42));
		assert_eq!(db.find_issue_by_pr("octo/widget", 42).unwrap().unwrap().key, key);
		assert_eq!(
			db.find_issue_by_branch("octo/widget", "farm/abcd1234/some-issue")
				.unwrap()
				.unwrap()
				.key,
			key
		);
	}
	#[test]
	fn log_tool_call() {
		let (_d, db) = db();
		db.upsert_issue("octo/widget#1", "octo/widget", 1, "new", None, None, None)
			.unwrap();
		assert!(
			db.log_tool_call(
				"octo/widget#1",
				"gh_post_comment",
				&json!({"body":"hi"}),
				Some(&json!({"comment_id":9})),
				None
			)
			.unwrap() > 0
		);
	}
	#[test]
	fn processed_issue_keys_returns_only_known() {
		let (_d, db) = db();
		let k1 = issue_key("octo/widget", 1);
		let k2 = issue_key("octo/widget", 2);
		db.upsert_issue(&k1, "octo/widget", 1, "new", None, None, None)
			.unwrap();
		db.upsert_issue(&k2, "octo/widget", 2, "reproducing", None, None, None)
			.unwrap();
		let got = db
			.processed_issue_keys(&[
				k1.clone(),
				k2.clone(),
				issue_key("octo/widget", 3),
				issue_key("octo/other", 7),
			])
			.unwrap();
		assert_eq!(got, HashSet::from([k1, k2]));
	}
	#[test]
	fn processed_issue_keys_empty_input() {
		let (_d, db) = db();
		assert!(db.processed_issue_keys(&[]).unwrap().is_empty());
		assert!(
			db.processed_issue_keys(&["".to_string(), "".to_string()])
				.unwrap()
				.is_empty()
		);
	}
	#[test]
	fn processed_issue_keys_handles_large_batch() {
		let (_d, db) = db();
		let mut keys = vec![];
		for n in 1..750 {
			let k = issue_key("octo/widget", n);
			if n % 3 == 0 {
				db.upsert_issue(&k, "octo/widget", n, "new", None, None, None)
					.unwrap();
			}
			keys.push(k);
		}
		keys.push("bogus#1".into());
		let got = db.processed_issue_keys(&keys).unwrap();
		let exp = (1..750)
			.filter(|n| n % 3 == 0)
			.map(|n| issue_key("octo/widget", n))
			.collect::<HashSet<_>>();
		assert_eq!(got, exp);
	}
	#[test]
	fn classification_roundtrip() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 7);
		db.upsert_issue(&key, "octo/widget", 7, "new", None, None, None)
			.unwrap();
		assert_eq!(db.get_issue(&key).unwrap().unwrap().classification, None);
		db.set_issue_classification(&key, "question").unwrap();
		assert_eq!(db.get_issue(&key).unwrap().unwrap().classification, Some("question".into()));
		assert!(
			db.list_issues(100)
				.unwrap()
				.iter()
				.any(|r| r.key == key && r.classification.as_deref() == Some("question"))
		);
	}
	#[test]
	fn migration_adds_classification_to_existing_db() {
		let dir = tempdir().unwrap();
		let path = dir.path().join("legacy.sqlite");
		let conn = Connection::open(&path).unwrap();
		conn.execute_batch("CREATE TABLE events (delivery_id TEXT PRIMARY KEY, event_type TEXT, payload_json TEXT, received_at TEXT, state TEXT CHECK(state IN ('queued','running','done','failed','skipped')), attempts INTEGER DEFAULT 0, last_error TEXT, repo TEXT, issue_key TEXT, started_at TEXT, finished_at TEXT); CREATE TABLE issues (key TEXT PRIMARY KEY, repo TEXT, number INTEGER, branch TEXT, session_dir TEXT, pr_number INTEGER, state TEXT, updated_at TEXT); CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT, tool TEXT, args_json TEXT, result_json TEXT, error TEXT, ts TEXT); INSERT INTO issues VALUES ('octo/widget#1','octo/widget',1,'farm/x','/tmp/s',NULL,'reproducing','2026-01-01T00:00:00Z');").unwrap();
		drop(conn);
		let db = Database::open(&path).unwrap();
		assert_eq!(
			db.get_issue("octo/widget#1")
				.unwrap()
				.unwrap()
				.classification,
			None
		);
		db.set_issue_classification("octo/widget#1", "bug").unwrap();
		assert_eq!(
			db.get_issue("octo/widget#1")
				.unwrap()
				.unwrap()
				.classification,
			Some("bug".into())
		);
	}
	#[test]
	fn set_event_model_persists_on_running_event() {
		let (_d, db) = db();
		db.record_event(
			"d-model",
			"issues",
			Some("octo/widget"),
			Some(&issue_key("octo/widget", 42)),
			&json!({}),
			"queued",
			None,
		)
		.unwrap();
		db.claim_next_event().unwrap();
		db.set_event_model("d-model", "claude-sonnet-4-5").unwrap();
		assert_eq!(db.list_running_events().unwrap()[0].model.as_deref(), Some("claude-sonnet-4-5"));
		db.set_event_model("d-model", "claude-opus-4-5").unwrap();
		assert_eq!(db.list_running_events().unwrap()[0].model.as_deref(), Some("claude-opus-4-5"));
	}
	#[test]
	fn list_running_events_surfaces_last_tool_since_start() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 7);
		db.upsert_issue(&key, "octo/widget", 7, "reproducing", None, None, None)
			.unwrap();
		db.log_tool_call(&key, "stale_tool", &json!({}), None, None)
			.unwrap();
		db.record_event("d-7", "issues", Some("octo/widget"), Some(&key), &json!({}), "queued", None)
			.unwrap();
		db.claim_next_event().unwrap();
		let running = db.list_running_events().unwrap();
		assert_eq!(running[0].last_tool, None);
		db.log_tool_call(&key, "gh_post_comment", &json!({}), None, None)
			.unwrap();
		db.log_tool_call(&key, "set_issue_labels", &json!({}), None, None)
			.unwrap();
		assert_eq!(
			db.list_running_events().unwrap()[0].last_tool.as_deref(),
			Some("set_issue_labels")
		);
	}
	#[test]
	fn record_submission_dedupes_by_delivery() {
		let (_d, db) = db();
		assert!(
			db.record_submission("d-1", "Alice", Some("octo/widget"))
				.unwrap()
		);
		assert!(
			!db.record_submission("d-1", "alice", Some("octo/widget"))
				.unwrap()
		);
	}
	#[test]
	fn admit_submission_dedupes_by_delivery_before_rate_limit() {
		let (_d, db) = db();
		let since = iso_seconds_ago(60.0);
		let first = db
			.admit_submission("d-1", "Alice", Some("octo/widget"), &since, Some(1))
			.unwrap();
		assert!(first.accepted && !first.duplicate && first.used == 1);
		let dup = db
			.admit_submission("d-1", "alice", Some("octo/widget"), &since, Some(1))
			.unwrap();
		assert!(dup.accepted && dup.duplicate && dup.used == 1);
		let rej = db
			.admit_submission("d-2", "ALICE", Some("octo/widget"), &since, Some(1))
			.unwrap();
		assert!(!rej.accepted && !rej.duplicate && rej.used == 1);
		assert_eq!(db.count_submissions_since("alice", &since).unwrap(), 1);
	}
	#[test]
	fn db_submission_admission_contention() {
		let dir = tempdir().unwrap();
		let path = dir.path().join("admission.sqlite");
		Database::open(&path).unwrap();
		let barrier = Arc::new(Barrier::new(2));
		let mut handles = vec![];
		for i in 0..2 {
			let p = path.clone();
			let b = barrier.clone();
			handles.push(thread::spawn(move || {
				let db = Database::open(p).unwrap();
				b.wait();
				db.admit_submission(
					&format!("d-{i}"),
					"alice",
					Some("octo/widget"),
					&iso_seconds_ago(60.0),
					Some(1),
				)
				.unwrap()
				.accepted
			}));
		}
		let mut accepted = handles
			.into_iter()
			.map(|h| h.join().unwrap())
			.collect::<Vec<_>>();
		accepted.sort();
		assert_eq!(accepted, vec![false, true]);
		assert_eq!(
			Database::open(&path)
				.unwrap()
				.count_submissions_since("alice", &iso_seconds_ago(60.0))
				.unwrap(),
			1
		);
	}
	#[test]
	fn admit_submission_enforces_cap_atomically_across_connections() {
		db_submission_admission_contention();
	}
	#[test]
	fn count_submissions_since_is_case_insensitive() {
		let (_d, db) = db();
		db.record_submission("d-1", "Alice", Some("octo/widget"))
			.unwrap();
		db.record_submission("d-2", "ALICE", Some("octo/widget"))
			.unwrap();
		db.record_submission("d-3", "bob", Some("octo/widget"))
			.unwrap();
		let since = iso_seconds_ago(60.0);
		assert_eq!(db.count_submissions_since("alice", &since).unwrap(), 2);
		assert_eq!(db.count_submissions_since("ALICE", &since).unwrap(), 2);
		assert_eq!(db.count_submissions_since("bob", &since).unwrap(), 1);
		assert_eq!(db.count_submissions_since("nobody", &since).unwrap(), 0);
	}
	#[test]
	fn count_submissions_since_respects_window() {
		let (_d, db) = db();
		db.record_submission("d-1", "alice", Some("octo/widget"))
			.unwrap();
		assert_eq!(
			db.count_submissions_since("alice", &iso_seconds_ago(-60.0))
				.unwrap(),
			0
		);
	}
	fn seed_pending(db: &Database, close_at: &str) {
		db.upsert_pending_closure(
			&issue_key("octo/widget", 42),
			"octo/widget",
			42,
			999,
			"Alice",
			close_at,
		)
		.unwrap();
	}
	#[test]
	fn upsert_pending_closure_lowercases_author_and_starts_pending() {
		let (_d, db) = db();
		seed_pending(&db, "2026-05-15T00:00:00.000000Z");
		let row = db
			.get_pending_closure(&issue_key("octo/widget", 42))
			.unwrap()
			.unwrap();
		assert_eq!(row.state, "pending");
		assert_eq!(row.cancel_reason, None);
		assert_eq!(row.issue_author, "alice");
		assert_eq!(row.comment_id, 999);
	}
	#[test]
	fn upsert_pending_closure_overwrites_prior_schedule() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 42);
		seed_pending(&db, "2026-05-15T00:00:00.000000Z");
		db.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
			.unwrap();
		assert!(
			db.finalize_closure(&key, "cancelled", Some("user_replied"))
				.unwrap()
		);
		db.upsert_pending_closure(
			&key,
			"octo/widget",
			42,
			1234,
			"alice",
			"2030-01-01T00:00:00.000000Z",
		)
		.unwrap();
		let row = db.get_pending_closure(&key).unwrap().unwrap();
		assert_eq!(row.state, "pending");
		assert_eq!(row.cancel_reason, None);
		assert_eq!(row.comment_id, 1234);
		assert_eq!(row.close_at, "2030-01-01T00:00:00.000000Z");
	}
	#[test]
	fn claim_due_closures_only_returns_due_pending() {
		let (_d, db) = db();
		seed_pending(&db, "2000-01-01T00:00:00.000000Z");
		db.upsert_pending_closure(
			&issue_key("octo/widget", 7),
			"octo/widget",
			7,
			10,
			"bob",
			"2999-01-01T00:00:00.000000Z",
		)
		.unwrap();
		let claimed = db
			.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
			.unwrap();
		assert_eq!(
			claimed
				.iter()
				.map(|r| r.issue_key.clone())
				.collect::<Vec<_>>(),
			vec![issue_key("octo/widget", 42)]
		);
		assert_eq!(
			db.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
				.unwrap(),
			vec![]
		);
	}
	#[test]
	fn db_pending_closure_claim_contention() {
		let dir = tempdir().unwrap();
		let path = dir.path().join("closures.sqlite");
		let db = Database::open(&path).unwrap();
		for n in 0..5 {
			db.upsert_pending_closure(
				&issue_key("octo/widget", n),
				"octo/widget",
				n,
				100 + n,
				"alice",
				"2000-01-01T00:00:00.000000Z",
			)
			.unwrap();
		}
		let mut handles = vec![];
		for _ in 0..16 {
			let p = path.clone();
			handles.push(thread::spawn(move || {
				Database::open(p)
					.unwrap()
					.claim_due_closures("2026-05-15T00:00:00.000000Z", 2)
					.unwrap()
					.into_iter()
					.map(|r| r.issue_key)
					.collect::<Vec<_>>()
			}));
		}
		let mut seen = handles
			.into_iter()
			.flat_map(|h| h.join().unwrap())
			.collect::<Vec<_>>();
		seen.sort();
		assert_eq!(
			seen,
			(0..5)
				.map(|n| issue_key("octo/widget", n))
				.collect::<Vec<_>>()
		);
	}
	#[test]
	fn claim_due_closures_atomic_under_contention() {
		db_pending_closure_claim_contention();
	}
	#[test]
	fn cancel_pending_closure_only_fires_when_pending() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 42);
		seed_pending(&db, "2026-05-15T00:00:00.000000Z");
		assert!(db.cancel_pending_closure(&key, "user_replied").unwrap());
		let row = db.get_pending_closure(&key).unwrap().unwrap();
		assert_eq!(row.state, "cancelled");
		assert_eq!(row.cancel_reason.as_deref(), Some("user_replied"));
		assert!(!db.cancel_pending_closure(&key, "user_replied").unwrap());
	}
	#[test]
	fn cancel_pending_closure_skips_claimed_rows() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 42);
		seed_pending(&db, "2000-01-01T00:00:00.000000Z");
		assert!(
			!db.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
				.unwrap()
				.is_empty()
		);
		assert!(!db.cancel_pending_closure(&key, "user_replied").unwrap());
		assert_eq!(db.get_pending_closure(&key).unwrap().unwrap().state, "claimed");
	}
	#[test]
	fn finalize_closure_rejects_non_terminal_state() {
		let (_d, db) = db();
		seed_pending(&db, "2026-05-15T00:00:00.000000Z");
		assert!(
			db.finalize_closure(&issue_key("octo/widget", 42), "pending", None)
				.is_err()
		);
	}
	#[test]
	fn finalize_closure_only_updates_claimed_once() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 42);
		seed_pending(&db, "2000-01-01T00:00:00.000000Z");
		db.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
			.unwrap();
		assert!(db.finalize_closure(&key, "closed", None).unwrap());
		assert!(
			!db.finalize_closure(&key, "cancelled", Some("late_cancel"))
				.unwrap()
		);
		let row = db.get_pending_closure(&key).unwrap().unwrap();
		assert_eq!(row.state, "closed");
		assert_eq!(row.cancel_reason, None);
	}
	#[test]
	fn cancel_after_finalize_does_not_overwrite_terminal_closure() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 42);
		seed_pending(&db, "2000-01-01T00:00:00.000000Z");
		db.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
			.unwrap();
		assert!(db.finalize_closure(&key, "closed", None).unwrap());
		assert!(!db.cancel_pending_closure(&key, "user_replied").unwrap());
		let row = db.get_pending_closure(&key).unwrap().unwrap();
		assert_eq!(row.state, "closed");
		assert_eq!(row.cancel_reason, None);
	}
	#[test]
	fn requeue_after_finalize_is_noop() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 42);
		seed_pending(&db, "2000-01-01T00:00:00.000000Z");
		db.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
			.unwrap();
		assert!(db.finalize_closure(&key, "closed", None).unwrap());
		assert!(!db.requeue_claimed_closure(&key).unwrap());
		assert_eq!(db.get_pending_closure(&key).unwrap().unwrap().state, "closed");
	}
	#[test]
	fn requeue_claimed_closure_only_flips_claimed() {
		let (_d, db) = db();
		let key = issue_key("octo/widget", 42);
		seed_pending(&db, "2000-01-01T00:00:00.000000Z");
		db.claim_due_closures("2026-05-15T00:00:00.000000Z", 50)
			.unwrap();
		assert!(db.requeue_claimed_closure(&key).unwrap());
		assert_eq!(db.get_pending_closure(&key).unwrap().unwrap().state, "pending");
		assert!(!db.requeue_claimed_closure(&key).unwrap());
	}
	#[test]
	fn db_migrates_python_era_fixture() {
		let src = Path::new("../../artifacts/robogjc/db/python-era-v1.sqlite");
		assert!(src.exists(), "missing committed Python-era fixture at {}", src.display());
		let dir = tempdir().unwrap();
		let dst = dir.path().join("fixture.sqlite");
		fs::copy(src, &dst).unwrap();
		let db = Database::open(&dst).unwrap();
		assert_eq!(db.user_version().unwrap(), 1);
		assert!(db.get_event("fixture-running").unwrap().is_some());
		assert!(
			db.get_issue("octo/widget#101")
				.unwrap()
				.unwrap()
				.classification
				.as_deref()
				== Some("bug")
		);
		assert!(db.get_pending_closure("octo/widget#303").unwrap().is_some());
		assert_eq!(
			db.count_submissions_since("alice", "2000-01-01T00:00:00.000000Z")
				.unwrap(),
			1
		);
	}
	#[test]
	#[ignore = "set ROBGJC_PY_COMPAT=1 and run with --ignored to exercise the Python interpreter compatibility gate"]
	fn db_python_rust_compatibility() {
		assert_eq!(
			std::env::var("ROBGJC_PY_COMPAT").as_deref(),
			Ok("1"),
			"ROBGJC_PY_COMPAT=1 is required for the Python interpreter compatibility gate"
		);
		let py = Path::new("/tmp/robogjc-uv/bin/python");
		assert!(py.exists(), "missing Python compatibility interpreter at {}", py.display());
		let dir = tempdir().unwrap();
		let path = dir.path().join("compat.sqlite");
		let db = Database::open(&path).unwrap();
		db.record_event(
			"rust-event",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#808"),
			&json!({"action":"opened"}),
			"queued",
			None,
		)
		.unwrap();
		db.upsert_issue(
			"octo/widget#808",
			"octo/widget",
			808,
			"opened",
			Some("farm/rust"),
			Some("/tmp/rust"),
			Some(8080),
		)
		.unwrap();
		db.log_tool_call(
			"octo/widget#808",
			"rust_tool",
			&json!({"ok":true}),
			Some(&json!({"done":true})),
			None,
		)
		.unwrap();
		let code = "import sys,json; from pathlib import Path; from robogjc.db import Database; db=Database(Path(sys.argv[1])); ev=db.get_event('rust-event'); issue=db.get_issue('octo/widget#808'); print(json.dumps({'delivery_id':ev.delivery_id,'action':ev.payload['action'],'pr':issue.pr_number,'branch':issue.branch})); db.close()";
		let out = Command::new(py)
			.arg("-c")
			.arg(code)
			.arg(&path)
			.output()
			.unwrap();
		assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
		let txt = String::from_utf8(out.stdout).unwrap();
		assert!(txt.contains("rust-event") && txt.contains("8080") && txt.contains("farm/rust"));
	}
	#[test]
	fn g003_db_differential_red_team_report() {
		let py = Path::new("/tmp/robogjc-uv/bin/python");
		if !py.exists() {
			return;
		}
		let dir = tempdir().unwrap();
		let db_path = dir.path().join("g003.sqlite");
		let marker = dir.path().join("go");
		let artifact = Path::new("../../artifacts/robogjc/qa/g003-db-differential-report.json");
		fs::create_dir_all(artifact.parent().unwrap()).unwrap();

		let mut cases: Vec<Value> = Vec::new();
		let mut blockers: Vec<Value> = Vec::new();
		let mut commands: Vec<Value> = Vec::new();

		let seed = r#"
import sys, json, sqlite3
from pathlib import Path
from robogjc.db import Database
p=Path(sys.argv[1])
db=Database(p)
db.record_event(delivery_id='py-seed-queued', event_type='issues', repo='octo/widget', issue_key='octo/widget#1', payload={'msg':'hello 🌈','none':None,'long':'x'*4096})
db.record_event(delivery_id='py-seed-done', event_type='issues', repo=None, issue_key=None, payload={'ok': True}, state='done')
db.upsert_issue(key='octo/widget#1', repo='octo/widget', number=1, state='opened', branch='farm/py', session_dir='/tmp/py', pr_number=None)
db.set_issue_classification('octo/widget#1','bug')
db.log_tool_call(issue_key='octo/widget#1', tool='py_tool_🛠', args={'a':None,'s':'ß'*1024}, result={'r':'✅'}, error=None)
db.record_submission(delivery_id='py-sub-old', login='Alice', repo='octo/widget')
db.upsert_pending_closure(issue_key='octo/widget#2', repo='octo/widget', number=2, comment_id=22, issue_author='Bob', close_at='2000-01-01T00:00:00.000000Z')
db.close()
print(json.dumps({'seeded': True}))
"#;
		let seed_out = Command::new(py)
			.arg("-c")
			.arg(seed)
			.arg(&db_path)
			.output()
			.unwrap();
		commands.push(json!({"argv":[py.display().to_string(),"-c","<python seed>",db_path.display().to_string()],"status":seed_out.status.code()}));
		assert!(seed_out.status.success(), "{}", String::from_utf8_lossy(&seed_out.stderr));

		let db = Database::open(&db_path).unwrap();
		let migrated_once = db.user_version().unwrap();
		drop(db);
		let db = Database::open(&db_path).unwrap();
		let migrated_twice = db.user_version().unwrap();
		let claimed = db.claim_next_event().unwrap().unwrap();
		db.mark_event(&claimed.delivery_id, "done", None).unwrap();
		db.admit_submission(
			"rust-sub",
			"Alice",
			Some("octo/widget"),
			"2000-01-01T00:00:00.000000Z",
			Some(10),
		)
		.unwrap();
		db.upsert_pending_closure(
			&issue_key("octo/widget", 3),
			"octo/widget",
			3,
			33,
			"Carol",
			"2000-01-01T00:00:00.000000Z",
		)
		.unwrap();
		let due = db
			.claim_due_closures("2026-07-02T00:00:00.000000Z", 10)
			.unwrap();
		for row in due {
			db.finalize_closure(&row.issue_key, "closed", None).unwrap();
		}
		db.log_tool_call(
			"octo/widget#1",
			"rust_tool_🚀",
			&json!({"null":null,"emoji":"😈","long":"y".repeat(4096)}),
			Some(&json!({"ok":true})),
			None,
		)
		.unwrap();

		let snapshot = r#"
import sys, json, sqlite3
from pathlib import Path
from robogjc.db import Database
p=Path(sys.argv[1])
db=Database(p)
ev=db.list_events(limit=20)
issues=db.list_issues(limit=20)
closures=[]
for k in ['octo/widget#2','octo/widget#3']:
    r=db.get_pending_closure(k)
    closures.append(None if r is None else {'issue_key':r.issue_key,'state':r.state,'author':r.issue_author})
conn=sqlite3.connect(p)
conn.row_factory=sqlite3.Row
counts={t: conn.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] for t in ['events','issues','tool_calls','submissions','pending_closures']}
uv=conn.execute('PRAGMA user_version').fetchone()[0]
print(json.dumps({'user_version':uv,'counts':counts,'events':[(e.delivery_id,e.state,e.attempts,e.payload) for e in ev], 'issues':[(i.key,i.classification) for i in issues], 'closures':closures}, ensure_ascii=False, sort_keys=True))
db.close()
"#;
		let snap_out = Command::new(py)
			.arg("-c")
			.arg(snapshot)
			.arg(&db_path)
			.output()
			.unwrap();
		commands.push(json!({"argv":[py.display().to_string(),"-c","<python snapshot>",db_path.display().to_string()],"status":snap_out.status.code()}));
		assert!(snap_out.status.success(), "{}", String::from_utf8_lossy(&snap_out.stderr));
		let snap: Value = serde_json::from_slice(&snap_out.stdout).unwrap();
		let round_ok = snap["user_version"] == 1
			&& snap["counts"]["events"] == 2
			&& snap["counts"]["tool_calls"] == 2
			&& snap["counts"]["submissions"] == 2;
		cases.push(json!({"id":"python-seed-rust-mutate-python-read","status": if round_ok {"pass"} else {"fail"}, "evidence": snap}));
		cases.push(json!({"id":"migration-idempotence-python-after-rust","status": if migrated_once == 1 && migrated_twice == 1 {"pass"} else {"fail"}, "migratedOnce": migrated_once, "migratedTwice": migrated_twice}));

		let contend = dir.path().join("contend.sqlite");
		let db = Database::open(&contend).unwrap();
		db.record_event(
			"dup-claim",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#9"),
			&json!({"x":1}),
			"queued",
			None,
		)
		.unwrap();
		let p1 = contend.clone();
		let p2 = contend.clone();
		let h1 = thread::spawn(move || {
			Database::open(p1)
				.unwrap()
				.claim_next_event()
				.unwrap()
				.map(|r| r.delivery_id)
		});
		let h2 = thread::spawn(move || {
			Database::open(p2)
				.unwrap()
				.claim_next_event()
				.unwrap()
				.map(|r| r.delivery_id)
		});
		let rust_winners = [h1.join().unwrap(), h2.join().unwrap()]
			.into_iter()
			.flatten()
			.collect::<Vec<_>>();
		cases.push(json!({"id":"duplicate-delivery-claim-two-rust-connections","status": if rust_winners.len() == 1 {"pass"} else {"fail"}, "winners": rust_winners}));

		let mixed = dir.path().join("mixed.sqlite");
		let db = Database::open(&mixed).unwrap();
		db.record_event(
			"mixed-claim",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#10"),
			&json!({"x":1}),
			"queued",
			None,
		)
		.unwrap();
		let py_claim = r#"
import sys, json, time
from pathlib import Path
from robogjc.db import Database
p=Path(sys.argv[1]); marker=Path(sys.argv[2])
while not marker.exists(): time.sleep(0.005)
db=Database(p)
r=db.claim_next_event()
print(json.dumps({'winner': None if r is None else r.delivery_id}))
db.close()
"#;
		let child = Command::new(py)
			.arg("-c")
			.arg(py_claim)
			.arg(&mixed)
			.arg(&marker)
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.unwrap();
		fs::write(&marker, b"go").unwrap();
		let rust_mixed = Database::open(&mixed)
			.unwrap()
			.claim_next_event()
			.unwrap()
			.map(|r| r.delivery_id);
		let py_mixed_out = child.wait_with_output().unwrap();
		commands.push(json!({"argv":[py.display().to_string(),"-c","<python concurrent claim>",mixed.display().to_string(),marker.display().to_string()],"status":py_mixed_out.status.code()}));
		assert!(py_mixed_out.status.success(), "{}", String::from_utf8_lossy(&py_mixed_out.stderr));
		let py_mixed: Value = serde_json::from_slice(&py_mixed_out.stdout).unwrap();
		let mixed_winners = [rust_mixed, py_mixed["winner"].as_str().map(str::to_string)]
			.into_iter()
			.flatten()
			.collect::<Vec<_>>();
		cases.push(json!({"id":"duplicate-delivery-claim-rust-python-concurrent","status": if mixed_winners.len() == 1 {"pass"} else {"fail"}, "winners": mixed_winners}));

		let crash = dir.path().join("crash.sqlite");
		let db = Database::open(&crash).unwrap();
		db.record_event(
			"rollback-claim",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#11"),
			&json!({}),
			"queued",
			None,
		)
		.unwrap();
		{
			let mut conn = Connection::open(&crash).unwrap();
			let tx = conn
				.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
				.unwrap();
			tx.execute(
				"UPDATE events SET state='running', attempts=attempts+1 WHERE delivery_id='rollback-claim'",
				[],
			)
			.unwrap();
		}
		let after_rollback = Database::open(&crash)
			.unwrap()
			.claim_next_event()
			.unwrap()
			.map(|r| r.delivery_id);
		cases.push(json!({"id":"rollback-mid-claim-remains-claimable","status": if after_rollback.as_deref() == Some("rollback-claim") {"pass"} else {"fail"}, "claimedAfterRollback": after_rollback}));

		let edge = dir.path().join("edge.sqlite");
		let db = Database::open(&edge).unwrap();
		let conn = Connection::open(&edge).unwrap();
		for (id, ts) in [
			("old", "2026-01-01T00:00:00.000000Z"),
			("exact", "2026-01-02T00:00:00.000000Z"),
			("new", "2026-01-02T00:00:00.000001Z"),
		] {
			conn
				.execute(
					"INSERT INTO submissions (delivery_id, login, repo, ts) VALUES (?, 'edge', 'octo/widget', ?)",
					params![id, ts],
				)
				.unwrap();
		}
		let edge_count = db
			.count_submissions_since("EDGE", "2026-01-02T00:00:00.000000Z")
			.unwrap();
		cases.push(json!({"id":"submission-rate-limit-boundary-inclusive","status": if edge_count == 2 {"pass"} else {"fail"}, "countAtBoundary": edge_count}));

		let closures = dir.path().join("closure-race.sqlite");
		let db = Database::open(&closures).unwrap();
		db.upsert_pending_closure(
			"octo/widget#44",
			"octo/widget",
			44,
			44,
			"Dave",
			"2000-01-01T00:00:00.000000Z",
		)
		.unwrap();
		let claimed = db
			.claim_due_closures("2026-01-01T00:00:00.000000Z", 1)
			.unwrap();
		let cancel_after_claim = db
			.cancel_pending_closure("octo/widget#44", "user_replied")
			.unwrap();
		let first_finalize = db
			.finalize_closure(&claimed[0].issue_key, "closed", None)
			.unwrap();
		let second_finalize = db
			.finalize_closure(&claimed[0].issue_key, "cancelled", Some("late_cancel"))
			.unwrap();
		let terminal = db.get_pending_closure("octo/widget#44").unwrap().unwrap();
		let closure_ok =
			first_finalize && !second_finalize && !cancel_after_claim && terminal.state == "closed";
		if !closure_ok {
			blockers.push(json!({"case":"pending-closure-double-finalize","reason":"finalize_closure can overwrite an already-terminal closed row with cancelled, losing closure outcome","observedState":terminal.state,"observedReason":terminal.cancel_reason}));
		}
		cases.push(json!({"id":"pending-closure-double-finalize-and-cancel-after-claim","status": if closure_ok {"pass"} else {"fail"}, "firstFinalize": first_finalize, "secondFinalize": second_finalize, "cancelAfterClaim": cancel_after_claim, "terminalState": terminal.state, "terminalReason": terminal.cancel_reason}));

		let wal = dir.path().join("wal.sqlite");
		let db = Database::open(&wal).unwrap();
		db.record_event("wal-1", "issues", None, None, &json!({}), "queued", None)
			.unwrap();
		let reader = Connection::open(&wal).unwrap();
		reader.execute("BEGIN", []).unwrap();
		let before: i64 = reader
			.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
			.unwrap();
		db.record_event("wal-2", "issues", None, None, &json!({}), "queued", None)
			.unwrap();
		let during: i64 = reader
			.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
			.unwrap();
		reader.execute("COMMIT", []).unwrap();
		let after: i64 = Connection::open(&wal)
			.unwrap()
			.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
			.unwrap();
		cases.push(json!({"id":"wal-reader-consistent-snapshot-during-writer","status": if before == 1 && during == 1 && after == 2 {"pass"} else {"fail"}, "before":before,"during":during,"after":after}));

		let passed = cases.iter().filter(|c| c["status"] == "pass").count();
		let report = json!({
			"schemaVersion": 1,
			"kind": "package-consumer-report",
			"cases": cases,
			"commands": commands,
			"summary": {"passed": passed, "failed": cases.len() - passed, "blockers": blockers.len()},
			"blockers": blockers,
		});
		fs::write(artifact, serde_json::to_string_pretty(&report).unwrap()).unwrap();
		assert_eq!(blockers.len(), 0, "g003 DB differential blockers: {blockers:#?}");
		assert_eq!(cases.len() - passed, 0, "g003 DB differential failures: {cases:#?}");
	}
}
