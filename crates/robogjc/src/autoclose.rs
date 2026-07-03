//! Background scheduler for due question auto-closures.

use std::{
	future::Future,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
	config::Settings,
	db::{Database, DbResult, PendingClosureRow},
	github::{GitHubBackend, GitHubError, ReactionInfo},
};

pub type GithubFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, GitHubError>> + Send + 'a>>;

pub trait AutocloseGithub: Send + Sync + 'static {
	fn list_comment_reactions<'a>(
		&'a self,
		repo: &'a str,
		comment_id: i64,
	) -> GithubFuture<'a, Vec<ReactionInfo>>;
	fn close_issue<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		reason: &'a str,
	) -> GithubFuture<'a, ()>;
}

impl<T: GitHubBackend + ?Sized + 'static> AutocloseGithub for T {
	fn list_comment_reactions<'a>(
		&'a self,
		repo: &'a str,
		comment_id: i64,
	) -> GithubFuture<'a, Vec<ReactionInfo>> {
		GitHubBackend::list_comment_reactions(self, repo, comment_id)
	}
	fn close_issue<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		reason: &'a str,
	) -> GithubFuture<'a, ()> {
		GitHubBackend::close_issue(self, repo, number, reason)
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutocloseCounts {
	pub closed: usize,
	pub cancelled: usize,
	pub retried: usize,
}

pub struct AutocloseScheduler<G: AutocloseGithub + ?Sized> {
	settings: Settings,
	db: Arc<Database>,
	github: Arc<G>,
	task: Option<tokio::task::JoinHandle<()>>,
	stop: Arc<AtomicBool>,
	notify: Arc<tokio::sync::Notify>,
	now: Arc<dyn Fn() -> String + Send + Sync>,
}

impl<G: AutocloseGithub + ?Sized> AutocloseScheduler<G> {
	pub fn new(settings: Settings, db: Arc<Database>, github: Arc<G>) -> Self {
		Self::with_now(settings, db, github, Arc::new(utcnow_iso))
	}
	pub fn with_now(
		settings: Settings,
		db: Arc<Database>,
		github: Arc<G>,
		now: Arc<dyn Fn() -> String + Send + Sync>,
	) -> Self {
		Self {
			settings,
			db,
			github,
			task: None,
			stop: Arc::new(AtomicBool::new(false)),
			notify: Arc::new(tokio::sync::Notify::new()),
			now,
		}
	}
	pub fn enabled(&self) -> bool {
		self.settings.question_autoclose_enabled
			&& self.settings.question_autoclose_hours > 0.0
			&& self.settings.question_autoclose_scan_seconds > 0.0
	}
	pub async fn start(&mut self) {
		if !self.enabled() || self.task.is_some() {
			return;
		}
		self.stop.store(false, Ordering::SeqCst);
		let db = self.db.clone();
		let gh = self.github.clone();
		let stop = self.stop.clone();
		let notify = self.notify.clone();
		let now = self.now.clone();
		let delay = Duration::from_secs_f64(self.settings.question_autoclose_scan_seconds);
		self.task = Some(tokio::spawn(async move {
			loop {
				if stop.load(Ordering::SeqCst) {
					break;
				}
				let sched = Tick { db: db.clone(), github: gh.clone(), now: now.clone() };
				let _ = sched.tick().await;
				if stop.load(Ordering::SeqCst) {
					break;
				}
				tokio::select! { _ = notify.notified() => if stop.load(Ordering::SeqCst) { break; }, _ = tokio::time::sleep(delay) => {} }
			}
		}));
	}
	pub async fn stop(&mut self) {
		self.stop.store(true, Ordering::SeqCst);
		self.notify.notify_waiters();
		if let Some(t) = self.task.take() {
			let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
		}
	}
	pub async fn tick(&self) -> DbResult<AutocloseCounts> {
		Tick { db: self.db.clone(), github: self.github.clone(), now: self.now.clone() }
			.tick()
			.await
	}
}

struct Tick<G: AutocloseGithub + ?Sized> {
	db: Arc<Database>,
	github: Arc<G>,
	now: Arc<dyn Fn() -> String + Send + Sync>,
}
impl<G: AutocloseGithub + ?Sized> Tick<G> {
	async fn tick(&self) -> DbResult<AutocloseCounts> {
		let rows = self.db.claim_due_closures(&(self.now)(), 100)?;
		let mut c = AutocloseCounts { closed: 0, cancelled: 0, retried: 0 };
		for row in rows {
			match self.process(row).await {
				"closed" => c.closed += 1,
				"cancelled" => c.cancelled += 1,
				_ => c.retried += 1,
			}
		}
		Ok(c)
	}
	async fn process(&self, row: PendingClosureRow) -> &'static str {
		let reactions = match self
			.github
			.list_comment_reactions(&row.repo, row.comment_id)
			.await
		{
			Ok(r) => r,
			Err(_) => {
				let _ = self.db.requeue_claimed_closure(&row.issue_key);
				return "retried";
			},
		};
		let author = row.issue_author.to_ascii_lowercase();
		if reactions
			.iter()
			.any(|r| r.content == "-1" && r.user_login.eq_ignore_ascii_case(&author))
		{
			let _ = self
				.db
				.finalize_closure(&row.issue_key, "cancelled", Some("author_downvoted"));
			return "cancelled";
		}
		match self
			.github
			.close_issue(&row.repo, row.number, "completed")
			.await
		{
			Ok(()) => {
				let _ = self.db.finalize_closure(&row.issue_key, "closed", None);
				"closed"
			},
			Err(e) if e.status == 404 => {
				let _ = self
					.db
					.finalize_closure(&row.issue_key, "cancelled", Some("already_closed"));
				"cancelled"
			},
			Err(_) => {
				let _ = self.db.requeue_claimed_closure(&row.issue_key);
				"retried"
			},
		}
	}
}

fn utcnow_iso() -> String {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs() as i64;
	format_unix_utc(now)
}

fn format_unix_utc(secs: i64) -> String {
	let days = secs.div_euclid(86_400);
	let sod = secs.rem_euclid(86_400);
	let (year, month, day) = civil_from_days(days);
	let hour = sod / 3_600;
	let minute = (sod % 3_600) / 60;
	let second = sod % 60;
	format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000000Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
	let z = days + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = mp + if mp < 10 { 3 } else { -9 };
	(y + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod autoclose_tests {
	use super::*;
	use crate::{config::SecretString, db::issue_key};
	use tempfile::tempdir;
	use tokio::sync::Mutex;

	struct FakeGh {
		reactions: Vec<ReactionInfo>,
		reaction_error: Option<GitHubError>,
		close_error: Option<GitHubError>,
		close_calls: Mutex<Vec<(String, i64, String)>>,
		list_calls: Mutex<usize>,
		// When set, list_comment_reactions blocks until this Notify fires,
		// letting tests hold a tick in flight while calling stop().
		list_gate: Option<Arc<tokio::sync::Notify>>,
	}
	impl FakeGh {
		fn ok(reactions: Vec<ReactionInfo>) -> Self {
			Self {
				reactions,
				reaction_error: None,
				close_error: None,
				close_calls: Mutex::new(vec![]),
				list_calls: Mutex::new(0),
				list_gate: None,
			}
		}
	}
	impl AutocloseGithub for FakeGh {
		fn list_comment_reactions<'a>(
			&'a self,
			_: &'a str,
			_: i64,
		) -> GithubFuture<'a, Vec<ReactionInfo>> {
			Box::pin(async move {
				if let Some(gate) = &self.list_gate {
					gate.notified().await;
				}
				*self.list_calls.lock().await += 1;
				if let Some(e) = &self.reaction_error {
					Err(e.clone())
				} else {
					Ok(self.reactions.clone())
				}
			})
		}
		fn close_issue<'a>(
			&'a self,
			repo: &'a str,
			number: i64,
			reason: &'a str,
		) -> GithubFuture<'a, ()> {
			Box::pin(async move {
				self
					.close_calls
					.lock()
					.await
					.push((repo.into(), number, reason.into()));
				if let Some(e) = &self.close_error {
					Err(e.clone())
				} else {
					Ok(())
				}
			})
		}
	}
	fn settings(enabled: bool, hours: f64) -> Settings {
		Settings {
			github_token: None,
			github_webhook_secret: SecretString::new("x"),
			bot_login: "bot".into(),
			git_author_name: None,
			git_author_email: "b@example.invalid".into(),
			repo_allowlist_raw: "".into(),
			gh_proxy_url: None,
			gh_proxy_hmac_key: None,
			gh_proxy_bind_host: "".into(),
			gh_proxy_bind_port: 0,
			gh_proxy_max_body_bytes: 0,
			gh_proxy_git_timeout_seconds: 0.0,
			model: "".into(),
			provider: None,
			thinking_level: "low".into(),
			max_concurrency: 1,
			task_timeout_seconds: 0.0,
			task_timeout_hard_grace_seconds: 0.0,
			request_timeout_seconds: 0.0,
			task_completion_max_reminders: 0,
			gjc_command: "gjc".into(),
			shutdown_drain_timeout_seconds: 0.0,
			shutdown_kill_timeout_seconds: 0.0,
			workspace_root: "/tmp".into(),
			sqlite_path: "/tmp/x".into(),
			log_dir: "/tmp".into(),
			bind_host: "".into(),
			bind_port: 0,
			replay_token: None,
			rate_limit_window_seconds: 0.0,
			rate_limit_default: 0,
			rate_limit_contributor: 0,
			rate_limit_unlimited_raw: "".into(),
			maintainer_logins_raw: "".into(),
			reviewer_bots_raw: "".into(),
			question_autoclose_enabled: enabled,
			question_autoclose_hours: hours,
			question_autoclose_scan_seconds: 60.0,
			natives_cache_enabled: false,
			natives_cache_root: "/tmp".into(),
			natives_cache_max_entries_per_repo: 0,
			natives_cache_max_bytes: 0,
			natives_cache_gc_interval_seconds: 0.0,
		}
	}
	fn seeded() -> (tempfile::TempDir, Arc<Database>) {
		let d = tempdir().unwrap();
		let db = Arc::new(Database::open(d.path().join("t.sqlite")).unwrap());
		db.upsert_pending_closure(
			&issue_key("octo/widget", 42),
			"octo/widget",
			42,
			999,
			"alice",
			"2000-01-01T00:00:00.000000Z",
		)
		.unwrap();
		(d, db)
	}

	#[tokio::test]
	async fn autoclose_tick_closes_without_author_downvote() {
		let (_d, db) = seeded();
		let gh = Arc::new(FakeGh::ok(vec![]));
		let sched = AutocloseScheduler::new(settings(true, 4.0), db.clone(), gh.clone());
		assert_eq!(
			sched.tick().await.unwrap(),
			AutocloseCounts { closed: 1, cancelled: 0, retried: 0 }
		);
		assert_eq!(
			db.get_pending_closure(&issue_key("octo/widget", 42))
				.unwrap()
				.unwrap()
				.state,
			"closed"
		);
	}
	#[tokio::test]
	async fn autoclose_tick_cancels_author_downvote() {
		let (_d, db) = seeded();
		let gh = Arc::new(FakeGh::ok(vec![ReactionInfo {
			content: "-1".into(),
			user_login: "Alice".into(),
			user_type: "User".into(),
		}]));
		let sched = AutocloseScheduler::new(settings(true, 4.0), db.clone(), gh);
		assert_eq!(
			sched.tick().await.unwrap(),
			AutocloseCounts { closed: 0, cancelled: 1, retried: 0 }
		);
		assert_eq!(
			db.get_pending_closure(&issue_key("octo/widget", 42))
				.unwrap()
				.unwrap()
				.cancel_reason
				.as_deref(),
			Some("author_downvoted")
		);
	}
	#[tokio::test]
	async fn autoclose_tick_retries_close_error() {
		let (_d, db) = seeded();
		let mut fake = FakeGh::ok(vec![]);
		fake.close_error =
			Some(GitHubError { status: 502, message: "bad".into(), retry_after: None });
		let gh = Arc::new(fake);
		let sched = AutocloseScheduler::new(settings(true, 4.0), db.clone(), gh);
		assert_eq!(sched.tick().await.unwrap().retried, 1);
		assert_eq!(
			db.get_pending_closure(&issue_key("octo/widget", 42))
				.unwrap()
				.unwrap()
				.state,
			"pending"
		);
	}
	#[test]
	fn autoclose_disabled_when_feature_off_or_hours_zero() {
		let (_d, db) = seeded();
		let gh = Arc::new(FakeGh::ok(vec![]));
		assert!(!AutocloseScheduler::new(settings(false, 4.0), db.clone(), gh.clone()).enabled());
		assert!(!AutocloseScheduler::new(settings(true, 0.0), db, gh).enabled());
	}

	#[tokio::test]
	async fn autoclose_tick_skips_future_rows() {
		let (_d, db) = seeded();
		let gh = Arc::new(FakeGh::ok(vec![]));
		let sched = AutocloseScheduler::with_now(
			settings(true, 4.0),
			db.clone(),
			gh.clone(),
			Arc::new(|| "1999-01-01T00:00:00.000000Z".to_owned()),
		);
		assert_eq!(
			sched.tick().await.unwrap(),
			AutocloseCounts { closed: 0, cancelled: 0, retried: 0 }
		);
		assert_eq!(*gh.list_calls.lock().await, 0);
		assert_eq!(
			db.get_pending_closure(&issue_key("octo/widget", 42))
				.unwrap()
				.unwrap()
				.state,
			"pending"
		);
	}

	#[tokio::test]
	async fn autoclose_404_finalizes_cancelled() {
		let (_d, db) = seeded();
		let mut fake = FakeGh::ok(vec![]);
		fake.close_error =
			Some(GitHubError { status: 404, message: "missing".into(), retry_after: None });
		let sched = AutocloseScheduler::new(settings(true, 4.0), db.clone(), Arc::new(fake));
		assert_eq!(
			sched.tick().await.unwrap(),
			AutocloseCounts { closed: 0, cancelled: 1, retried: 0 }
		);
		let row = db
			.get_pending_closure(&issue_key("octo/widget", 42))
			.unwrap()
			.unwrap();
		assert_eq!(row.state, "cancelled");
		assert_eq!(row.cancel_reason.as_deref(), Some("already_closed"));
	}

	#[tokio::test]
	async fn autoclose_non_author_downvote_ignored_and_list_error_retries() {
		let (_d, db) = seeded();
		let gh = Arc::new(FakeGh::ok(vec![ReactionInfo {
			content: "-1".into(),
			user_login: "bob".into(),
			user_type: "User".into(),
		}]));
		let sched = AutocloseScheduler::new(settings(true, 4.0), db.clone(), gh);
		assert_eq!(sched.tick().await.unwrap().closed, 1);

		let (_d2, db2) = seeded();
		let mut fake = FakeGh::ok(vec![]);
		fake.reaction_error =
			Some(GitHubError { status: 500, message: "oops".into(), retry_after: None });
		let sched = AutocloseScheduler::new(settings(true, 4.0), db2.clone(), Arc::new(fake));
		assert_eq!(sched.tick().await.unwrap().retried, 1);
		assert_eq!(
			db2.get_pending_closure(&issue_key("octo/widget", 42))
				.unwrap()
				.unwrap()
				.state,
			"pending"
		);
	}

	#[tokio::test]
	async fn autoclose_stop_during_tick_terminates_scheduler() {
		// Hold the tick in flight inside list_comment_reactions, call stop()
		// while it is pending, then release the gate: stop must observe the
		// level-triggered flag after the tick instead of sleeping again.
		let (_d, db) = seeded();
		let gate = Arc::new(tokio::sync::Notify::new());
		let mut fake = FakeGh::ok(vec![]);
		fake.list_gate = Some(gate.clone());
		let mut sched = AutocloseScheduler::new(settings(true, 4.0), db, Arc::new(fake));
		sched.settings.question_autoclose_scan_seconds = 60.0;
		sched.start().await;
		// Let the scheduler enter the gated tick.
		tokio::time::sleep(Duration::from_millis(50)).await;
		let stop_fut = sched.stop();
		tokio::pin!(stop_fut);
		// stop() must not complete while the tick is still gated...
		assert!(
			tokio::time::timeout(Duration::from_millis(50), stop_fut.as_mut())
				.await
				.is_err(),
			"stop resolved while the tick was still in flight"
		);
		// ...and must complete promptly once the in-flight tick is released.
		gate.notify_waiters();
		gate.notify_one();
		assert!(
			tokio::time::timeout(Duration::from_millis(500), stop_fut)
				.await
				.is_ok(),
			"stop did not resolve after the in-flight tick was released"
		);
	}
}
