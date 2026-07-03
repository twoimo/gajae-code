//! Axum HTTP server and webhook ingress boundary for robogjc.

use std::{
	collections::{HashMap, HashSet},
	net::SocketAddr,
	path::PathBuf,
	sync::{Arc, Mutex},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
	Json, Router,
	body::Bytes,
	extract::{Query, State},
	http::{HeaderMap, StatusCode, header},
	response::{Html, IntoResponse, Response},
	routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::{
	autoclose::AutocloseScheduler,
	config::Settings,
	dashboard,
	db::{Database, issue_key},
	github::{self, GitHubBackend, GitHubClient, GitHubError, IssueSummary},
	manual_triage::{ManualTriageConflict, enqueue_manual_triage, parse_issue_ref},
	queue::WorkerPool,
	worker::AppServerWorker,
};

const INACTIVE_EVENT_STATES: &[&str] = &["done", "failed", "skipped"];

pub type Pool = WorkerPool<AppServerWorker>;

#[derive(Clone)]
pub struct AppState {
	pub settings: Arc<Settings>,
	pub db: Arc<Database>,
	pub github: Arc<dyn GitHubBackend>,
	pub pool: Arc<Pool>,
	started_at: Instant,
	issue_cache: Arc<IssueBrowseCache>,
}

impl AppState {
	pub fn new(
		settings: Settings,
		db: Arc<Database>,
		github: Arc<dyn GitHubBackend>,
		pool: Arc<Pool>,
	) -> Self {
		Self {
			settings: Arc::new(settings),
			db,
			github,
			pool,
			started_at: Instant::now(),
			issue_cache: Arc::new(IssueBrowseCache::default()),
		}
	}
}

#[derive(Clone)]
struct CacheEntry {
	repos: Vec<String>,
	issues: Vec<IssueSummary>,
	errors: Vec<Value>,
	fetched_at: f64,
}
#[derive(Default)]
struct IssueBrowseCache {
	entries: Mutex<HashMap<(String, i64, Vec<String>), CacheEntry>>,
}

pub fn create_app(state: AppState) -> Router {
	Router::new()
		.route("/healthz", get(healthz))
		.route("/readyz", get(readyz))
		.route("/webhook/github", post(webhook))
		.route("/replay", post(replay))
		.route("/api/github/issues", get(api_github_issues))
		.route("/api/trigger", post(api_trigger))
		.route("/api/cancel", post(api_cancel))
		.route("/events", get(events))
		.route("/issues", get(issues))
		.route("/", get(index))
		.route("/api/status", get(api_status))
		.route("/api/logs", get(api_logs))
		.route("/static/*path", get(static_asset))
		.with_state(state)
}

pub async fn serve(state: AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
	let addr: SocketAddr =
		format!("{}:{}", state.settings.bind_host, state.settings.bind_port).parse()?;
	let mut autoclose = AutocloseScheduler::new(
		state.settings.as_ref().clone(),
		state.db.clone(),
		state.github.clone(),
	);
	autoclose.start().await;
	let app = create_app(state);
	let listener = TcpListener::bind(addr).await?;
	let result = axum::serve(listener, app).await;
	autoclose.stop().await;
	result?;
	Ok(())
}

async fn healthz() -> Json<Value> {
	Json(json!({"status":"ok"}))
}
async fn readyz() -> Json<Value> {
	Json(json!({"status":"ready"}))
}

async fn webhook(State(st): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
	let event = match header_str(&headers, "x-github-event") {
		Some(v) => v.to_owned(),
		None => return err(StatusCode::BAD_REQUEST, "missing X-GitHub-Event"),
	};
	let delivery = match header_str(&headers, "x-github-delivery") {
		Some(v) => v.to_owned(),
		None => return err(StatusCode::BAD_REQUEST, "missing X-GitHub-Delivery"),
	};
	if !github::verify_signature(
		st.settings.github_webhook_secret.expose(),
		&body,
		header_str(&headers, "x-hub-signature-256"),
	) {
		return err(StatusCode::UNAUTHORIZED, "invalid signature");
	}
	let mut payload: Value = match serde_json::from_slice(&body) {
		Ok(v) => v,
		Err(e) => return err(StatusCode::BAD_REQUEST, &format!("invalid json: {e}")),
	};
	apply_webhook_cache(&st, &event, &payload);
	let allow = to_hash(st.settings.repo_allowlist());
	let maintainers = to_hash(st.settings.maintainer_logins());
	let reviewers = to_hash(st.settings.reviewer_bots());
	let db = st.db.clone();
	let resolver = |repo: &str, pr: i64| db.find_issue_by_pr(repo, pr).ok().flatten().map(|r| r.key);
	let decision = github::route(
		&event,
		&payload,
		&allow,
		&st.settings.bot_login,
		&maintainers,
		&reviewers,
		Some(&resolver),
	);
	if decision.directive {
		if let Some(obj) = payload.as_object_mut() {
			obj.insert("_robogjc_directive".into(), json!({"body":decision.directive_body,"author":decision.directive_author,"pragmas":decision.directive_pragmas}));
		}
	}
	if !decision.should_queue() {
		let _ = st.db.record_event(
			&delivery,
			&event,
			decision.repo.as_deref(),
			decision.issue_key.as_deref(),
			&payload,
			"skipped",
			Some(&decision.reason),
		);
		return (StatusCode::ACCEPTED, Json(json!({"delivery":delivery,"state":"skipped"})))
			.into_response();
	}
	if let Some(submitter) = decision.submitter.as_deref() {
		let unlimited = to_hash(st.settings.rate_limit_unlimited())
			.into_iter()
			.chain(to_hash(st.settings.maintainer_logins()))
			.collect::<HashSet<_>>();
		let cap = github::rate_limit_cap(
			submitter,
			decision.association.as_deref(),
			&unlimited,
			st.settings.rate_limit_default as i64,
			st.settings.rate_limit_contributor as i64,
		);
		let since = crate::db::iso_seconds_ago(st.settings.rate_limit_window_seconds);
		match st
			.db
			.admit_submission(&delivery, submitter, decision.repo.as_deref(), &since, cap)
		{
			Ok(adm) if !adm.accepted => {
				let _ = st.db.record_event(
					&delivery,
					&event,
					decision.repo.as_deref(),
					decision.issue_key.as_deref(),
					&payload,
					"skipped",
					Some("rate_limited"),
				);
				return (
					StatusCode::ACCEPTED,
					Json(json!({"delivery":delivery,"state":"skipped","reason":"rate_limited"})),
				)
					.into_response();
			},
			_ => {},
		}
	}
	let inserted = st
		.db
		.record_event(
			&delivery,
			&event,
			decision.repo.as_deref(),
			decision.issue_key.as_deref(),
			&payload,
			"queued",
			None,
		)
		.unwrap_or(false);
	if inserted {
		st.pool.wake();
	}
	(StatusCode::ACCEPTED, Json(json!({"delivery":delivery,"state":"queued"}))).into_response()
}

#[derive(Deserialize)]
struct ReplayQuery {
	delivery_id: Option<String>,
}
async fn replay(
	State(st): State<AppState>,
	headers: HeaderMap,
	Query(q): Query<ReplayQuery>,
) -> Response {
	if let Err(resp) = require_token(&st, &headers, "replay disabled") {
		return resp;
	}
	let delivery = q.delivery_id.unwrap_or_default();
	let row = match st.db.get_event(&delivery).unwrap_or(None) {
		Some(r) => r,
		None => return err(StatusCode::NOT_FOUND, "unknown delivery"),
	};
	if !st
		.db
		.requeue_event(&delivery, Some(INACTIVE_EVENT_STATES))
		.unwrap_or(false)
	{
		return err(
			StatusCode::CONFLICT,
			&format!("delivery {delivery} is {}; only inactive events can be replayed", row.state),
		);
	}
	st.pool.wake();
	Json(json!({"delivery":delivery,"state":"queued"})).into_response()
}

#[derive(Deserialize)]
struct BrowseQuery {
	state: Option<String>,
	limit: Option<i64>,
	refresh: Option<bool>,
}
async fn api_github_issues(
	State(st): State<AppState>,
	headers: HeaderMap,
	Query(q): Query<BrowseQuery>,
) -> Response {
	if let Err(resp) =
		require_token(&st, &headers, "trigger disabled (set ROBGJC_REPLAY_TOKEN to enable)")
	{
		return resp;
	}
	let state = q.state.unwrap_or_else(|| "open".into());
	if !matches!(state.as_str(), "open" | "closed" | "all") {
		return err(StatusCode::BAD_REQUEST, "state must be open|closed|all");
	}
	let limit = q.limit.unwrap_or(30).clamp(1, 100);
	let repos: Vec<String> = st.settings.repo_allowlist().into_iter().collect();
	if repos.is_empty() {
		return Json(
			json!({"issues":[],"errors":[],"repos":[],"cache":{"hit":false,"fetched_at":now_secs()}}),
		)
		.into_response();
	}
	let key = (state.clone(), limit, repos.clone());
	if !q.refresh.unwrap_or(false) {
		if let Some(entry) = st.issue_cache.entries.lock().unwrap().get(&key).cloned() {
			return issue_browse_payload(&st, entry, true).into_response();
		}
	}
	let mut issues = Vec::new();
	let mut errors = Vec::new();
	for repo in &repos {
		match st.github.list_issues(repo, &state, limit).await {
			Ok(mut xs) => issues.append(&mut xs),
			Err(e) => errors.push(json!({"repo":repo,"error":e.to_string()})),
		}
	}
	issues.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
	issues.truncate(limit as usize);
	let entry = CacheEntry { repos, issues, errors, fetched_at: now_secs() };
	st.issue_cache
		.entries
		.lock()
		.unwrap()
		.insert(key, entry.clone());
	issue_browse_payload(&st, entry, false).into_response()
}

#[derive(Deserialize)]
struct TriggerBody {
	mode: Option<String>,
	issue: Option<String>,
	delivery_id: Option<String>,
}
async fn api_trigger(
	State(st): State<AppState>,
	headers: HeaderMap,
	Json(body): Json<TriggerBody>,
) -> Response {
	if let Err(resp) =
		require_token(&st, &headers, "trigger disabled (set ROBGJC_REPLAY_TOKEN to enable)")
	{
		return resp;
	}
	match body.mode.as_deref().unwrap_or("") {
		"triage" => {
			let issue_ref = match body.issue.as_deref() {
				Some(s) if !s.is_empty() => s,
				_ => return err(StatusCode::BAD_REQUEST, "triage requires 'issue' = 'owner/repo#NN'"),
			};
			let (repo, number) = match parse_issue_ref(issue_ref) {
				Ok(v) => v,
				Err(e) => return err(StatusCode::BAD_REQUEST, &e.to_string()),
			};
			if !st.settings.allows(&repo) {
				return err(StatusCode::FORBIDDEN, &format!("{repo} not in ROBGJC_REPO_ALLOWLIST"));
			}
			let delivery =
				match enqueue_manual_triage(st.db.as_ref(), st.github.as_ref(), &repo, number).await {
					Ok(d) => d,
					Err(e) if e.downcast_ref::<ManualTriageConflict>().is_some() => {
						return err(StatusCode::CONFLICT, &e.to_string());
					},
					Err(e) if e.downcast_ref::<GitHubError>().is_some() => {
						return err(StatusCode::BAD_GATEWAY, &e.to_string());
					},
					Err(e) => return err(StatusCode::BAD_REQUEST, &e.to_string()),
				};
			st.pool.wake();
			(StatusCode::ACCEPTED, Json(json!({"delivery":delivery,"state":"queued","mode":"triage"})))
				.into_response()
		},
		"retry" => {
			let target = if let Some(d) = body.delivery_id.filter(|d| !d.is_empty()) {
				d
			} else if let Some(issue_ref) = body.issue.filter(|i| !i.is_empty()) {
				let (repo, number) = match parse_issue_ref(&issue_ref) {
					Ok(v) => v,
					Err(e) => return err(StatusCode::BAD_REQUEST, &e.to_string()),
				};
				if !st.settings.allows(&repo) {
					return err(StatusCode::FORBIDDEN, &format!("{repo} not in ROBGJC_REPO_ALLOWLIST"));
				}
				match st
					.db
					.latest_event_for_issue(&issue_key(&repo, number), false)
					.unwrap_or(None)
				{
					Some(r) => r.delivery_id,
					None => {
						return err(
							StatusCode::NOT_FOUND,
							&format!("no retryable stored event for {repo}#{number}"),
						);
					},
				}
			} else {
				return err(StatusCode::BAD_REQUEST, "retry requires 'delivery_id' or 'issue'");
			};
			let event = match st.db.get_event(&target).unwrap_or(None) {
				Some(e) => e,
				None => return err(StatusCode::NOT_FOUND, &format!("unknown delivery {target}")),
			};
			if !st
				.db
				.requeue_event(&target, Some(INACTIVE_EVENT_STATES))
				.unwrap_or(false)
			{
				return err(
					StatusCode::CONFLICT,
					&format!(
						"delivery {target} is {}; only inactive events can be retried",
						event.state
					),
				);
			}
			st.pool.wake();
			(StatusCode::ACCEPTED, Json(json!({"delivery":target,"state":"queued","mode":"retry"})))
				.into_response()
		},
		_ => err(StatusCode::BAD_REQUEST, "mode must be 'triage' or 'retry'"),
	}
}

#[derive(Deserialize)]
struct CancelBody {
	delivery_id: Option<String>,
}
async fn api_cancel(
	State(st): State<AppState>,
	headers: HeaderMap,
	Json(body): Json<CancelBody>,
) -> Response {
	if let Err(resp) =
		require_token(&st, &headers, "trigger disabled (set ROBGJC_REPLAY_TOKEN to enable)")
	{
		return resp;
	}
	let delivery = match body.delivery_id {
		Some(d) if !d.is_empty() => d,
		_ => return err(StatusCode::BAD_REQUEST, "cancel requires 'delivery_id'"),
	};
	let event = match st.db.get_event(&delivery).unwrap_or(None) {
		Some(e) => e,
		None => return err(StatusCode::NOT_FOUND, &format!("unknown delivery {delivery}")),
	};
	let fired = st.pool.cancel_event(&delivery);
	(
		StatusCode::ACCEPTED,
		Json(json!({"delivery":delivery,"fired":fired,"previous_state":event.state})),
	)
		.into_response()
}

#[derive(Deserialize)]
struct LimitQuery {
	limit: Option<i64>,
}
async fn events(State(st): State<AppState>, Query(q): Query<LimitQuery>) -> Response {
	Json(json!({"events": st.db.list_events(q.limit.unwrap_or(50)).unwrap_or_default().into_iter().map(event_json).collect::<Vec<_>>() })).into_response()
}
async fn issues(State(st): State<AppState>, Query(q): Query<LimitQuery>) -> Response {
	Json(json!({"issues": st.db.list_issues(q.limit.unwrap_or(100)).unwrap_or_default().into_iter().map(|r| json!({"key":r.key,"repo":r.repo,"number":r.number,"branch":r.branch,"pr_number":r.pr_number,"state":r.state,"classification":r.classification,"updated_at":r.updated_at})).collect::<Vec<_>>() })).into_response()
}
async fn index(State(st): State<AppState>) -> Response {
	match dashboard::render_index(st.settings.replay_token.is_some()) {
		Ok(html) => Html(html).into_response(),
		Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
	}
}
async fn api_status(State(st): State<AppState>) -> Response {
	let issue_rows = st.db.list_issues(200).unwrap_or_default();
	let keys = issue_rows.iter().map(|r| r.key.clone()).collect::<Vec<_>>();
	let latest = st
		.db
		.latest_events_for_issues(&keys, false)
		.unwrap_or_default();
	Json(json!({"runtime":{"bot_login":st.settings.bot_login,"repo_allowlist":st.settings.repo_allowlist().into_iter().collect::<Vec<_>>(),"max_concurrency":st.settings.max_concurrency,"model":st.settings.model,"thinking_level":st.settings.thinking_level,"uptime_seconds":st.started_at.elapsed().as_secs_f64()},"event_counts":st.db.event_state_counts().unwrap_or_default(),"issue_event_counts":st.db.latest_issue_event_state_counts().unwrap_or_default(),"running_events":st.db.list_running_events().unwrap_or_default().into_iter().map(|r| json!({"delivery_id":r.delivery_id,"event_type":r.event_type,"repo":r.repo,"issue_key":r.issue_key,"received_at":r.received_at,"started_at":r.started_at,"attempts":r.attempts,"model":r.model,"last_tool":r.last_tool,"last_tool_ts":r.last_tool_ts})).collect::<Vec<_>>(),"inflight":st.pool.inflight_snapshot(),"issues":issue_rows.into_iter().map(|r| { let ev = latest.get(&r.key).map(|e| event_json(e.clone())); json!({"key":r.key,"repo":r.repo,"number":r.number,"branch":r.branch,"pr_number":r.pr_number,"state":r.state,"classification":r.classification,"updated_at":r.updated_at,"latest_event":ev}) }).collect::<Vec<_>>(),"recent_events":st.db.list_events(25).unwrap_or_default().into_iter().map(event_json).collect::<Vec<_>>() })).into_response()
}
async fn api_logs(State(st): State<AppState>, Query(q): Query<LimitQuery>) -> Response {
	let limit = q.limit.unwrap_or(400).clamp(1, 2000) as usize;
	let entries = dashboard::tail_jsonl(&st.settings.log_dir.join("robogjc.log.jsonl"), limit);
	Json(json!({"entries":entries,"count":entries.len(),"limit":limit})).into_response()
}
async fn static_asset(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
	let safe = path
		.split('/')
		.filter(|p| !p.is_empty() && *p != ".." && !p.contains('\\'))
		.fold(dashboard::static_dir(), |acc, p| acc.join(p));
	match tokio::fs::read(&safe).await {
		Ok(bytes) => {
			([(header::CONTENT_TYPE, dashboard::content_type(&safe))], bytes).into_response()
		},
		Err(_) => StatusCode::NOT_FOUND.into_response(),
	}
}

fn event_json(r: crate::db::EventRow) -> Value {
	json!({"delivery_id":r.delivery_id,"event_type":r.event_type,"repo":r.repo,"issue_key":r.issue_key,"state":r.state,"attempts":r.attempts,"received_at":r.received_at,"last_error":r.last_error})
}
fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
	headers.get(name).and_then(|v| v.to_str().ok())
}
fn err(status: StatusCode, msg: &str) -> Response {
	(status, Json(json!({"detail":msg}))).into_response()
}
fn to_hash<T: IntoIterator<Item = String>>(xs: T) -> HashSet<String> {
	xs.into_iter().collect()
}
fn require_token(st: &AppState, headers: &HeaderMap, disabled: &str) -> Result<(), Response> {
	let Some(token) = &st.settings.replay_token else {
		return Err(err(StatusCode::NOT_FOUND, disabled));
	};
	if header_str(headers, "x-robogjc-replay-token") != Some(token.expose()) {
		return Err(err(StatusCode::UNAUTHORIZED, "invalid replay token"));
	}
	Ok(())
}
fn now_secs() -> f64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or(Duration::ZERO)
		.as_secs_f64()
}
fn issue_browse_payload(st: &AppState, entry: CacheEntry, hit: bool) -> Json<Value> {
	let keys = entry
		.issues
		.iter()
		.map(|s| issue_key(&s.repo, s.number))
		.collect::<Vec<_>>();
	let processed = st.db.processed_issue_keys(&keys).unwrap_or_default();
	Json(
		json!({"issues":entry.issues.into_iter().map(|s| json!({"repo":s.repo,"number":s.number,"title":s.title,"state":s.state,"author":s.author,"labels":s.labels,"comments":s.comments,"updated_at":s.updated_at,"created_at":s.created_at,"html_url":s.html_url,"processed":processed.contains(&issue_key(&s.repo, s.number))})).collect::<Vec<_>>(),"errors":entry.errors,"repos":entry.repos,"cache":{"hit":hit,"fetched_at":entry.fetched_at}}),
	)
}
fn apply_webhook_cache(_st: &AppState, _event: &str, _payload: &Value) {}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, time::Duration};

	use axum::{
		body::{Body, to_bytes},
		http::{Request, StatusCode},
	};
	use tower::ServiceExt;

	use super::*;
	use crate::{
		config::SecretString,
		sandbox::LocalGitTransport,
		worker::{AppServerHostToolRuntime, AppServerWorkerConfig},
	};

	fn test_settings(tmp: &std::path::Path) -> Settings {
		Settings {
			github_token: Some(SecretString::new("token")),
			github_webhook_secret: SecretString::new("secret"),
			bot_login: "robogjc-bot".into(),
			git_author_name: Some("bot".into()),
			git_author_email: "bot@example.com".into(),
			repo_allowlist_raw: "octo/widget".into(),
			gh_proxy_url: None,
			gh_proxy_hmac_key: None,
			gh_proxy_bind_host: "0.0.0.0".into(),
			gh_proxy_bind_port: 8081,
			gh_proxy_max_body_bytes: 1048576,
			gh_proxy_git_timeout_seconds: 60.0,
			model: "model".into(),
			provider: None,
			thinking_level: "high".into(),
			max_concurrency: 1,
			task_timeout_seconds: 1.0,
			task_timeout_hard_grace_seconds: 1.0,
			request_timeout_seconds: 1.0,
			task_completion_max_reminders: 1,
			gjc_command: "gjc".into(),
			shutdown_drain_timeout_seconds: 0.1,
			shutdown_kill_timeout_seconds: 0.1,
			workspace_root: tmp.join("work"),
			sqlite_path: tmp.join("db.sqlite"),
			log_dir: tmp.join("logs"),
			bind_host: "127.0.0.1".into(),
			bind_port: 0,
			replay_token: Some(SecretString::new("rt")),
			rate_limit_window_seconds: 3600.0,
			rate_limit_default: 3,
			rate_limit_contributor: 10,
			rate_limit_unlimited_raw: "".into(),
			maintainer_logins_raw: "".into(),
			reviewer_bots_raw: "".into(),
			question_autoclose_enabled: false,
			question_autoclose_hours: 4.0,
			question_autoclose_scan_seconds: 60.0,
			natives_cache_enabled: false,
			natives_cache_root: tmp.join("cache"),
			natives_cache_max_entries_per_repo: 8,
			natives_cache_max_bytes: 1,
			natives_cache_gc_interval_seconds: 3600.0,
		}
	}

	fn app(tmp: &std::path::Path) -> Router {
		let cfg = test_settings(tmp);
		cfg.ensure_paths().unwrap();
		let db = Arc::new(Database::open(&cfg.sqlite_path).unwrap());
		let github = Arc::new(GitHubClient::with_base_url("token", "http://127.0.0.1:9").unwrap());
		let runtime = AppServerHostToolRuntime {
			db: db.clone(),
			github: github.clone(),
			git_transport: Arc::new(LocalGitTransport::default()),
			settings: Some(cfg.clone()),
			author_name: "bot".into(),
			author_email: cfg.git_author_email.clone(),
		};
		let worker = Arc::new(AppServerWorker::new(
			AppServerWorkerConfig { hard_timeout: Duration::from_millis(10), ..Default::default() },
			runtime,
		));
		let pool = Arc::new(WorkerPool::new(db.clone(), worker, 1, None));
		create_app(AppState::new(cfg, db, github, pool))
	}

	#[tokio::test]
	async fn server_routes_healthz_and_events_are_json() {
		let tmp = tempfile::tempdir().unwrap();
		let app = app(tmp.path());
		let resp = app
			.clone()
			.oneshot(
				Request::builder()
					.uri("/healthz")
					.body(Body::empty())
					.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(resp.status(), StatusCode::OK);
		let resp = app
			.oneshot(
				Request::builder()
					.uri("/events")
					.body(Body::empty())
					.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(resp.status(), StatusCode::OK);
	}

	#[tokio::test]
	async fn manual_trigger_rejects_missing_token() {
		let tmp = tempfile::tempdir().unwrap();
		let app = app(tmp.path());
		let resp = app
			.oneshot(
				Request::builder()
					.method("POST")
					.uri("/api/trigger")
					.header("content-type", "application/json")
					.body(Body::from(r#"{"mode":"retry"}"#))
					.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
	}

	#[tokio::test]
	async fn manual_trigger_conflict_returns_409() {
		let tmp = tempfile::tempdir().unwrap();
		let app = app(tmp.path());
		let db = Database::open(&tmp.path().join("db.sqlite")).unwrap();
		db.record_event(
			"manual-octo__widget-42",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#42"),
			&json!({"action":"opened"}),
			"queued",
			None,
		)
		.unwrap();
		let resp = app
			.oneshot(
				Request::builder()
					.method("POST")
					.uri("/api/trigger")
					.header("content-type", "application/json")
					.header("x-robogjc-replay-token", "rt")
					.body(Body::from(r#"{"mode":"triage","issue":"octo/widget#42"}"#))
					.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(resp.status(), StatusCode::CONFLICT);
	}

	#[tokio::test]
	async fn manual_trigger_github_failure_returns_502() {
		let tmp = tempfile::tempdir().unwrap();
		let app = app(tmp.path());
		let resp = app
			.oneshot(
				Request::builder()
					.method("POST")
					.uri("/api/trigger")
					.header("content-type", "application/json")
					.header("x-robogjc-replay-token", "rt")
					.body(Body::from(r#"{"mode":"triage","issue":"octo/widget#43"}"#))
					.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
	}

	#[tokio::test]
	async fn dashboard_status_reports_counts() {
		let tmp = tempfile::tempdir().unwrap();
		let app = app(tmp.path());
		let resp = app
			.oneshot(
				Request::builder()
					.uri("/api/status")
					.body(Body::empty())
					.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(resp.status(), StatusCode::OK);
		let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
		let body: Value = serde_json::from_slice(&bytes).unwrap();
		assert_eq!(body["runtime"]["bot_login"], "robogjc-bot");
		assert!(body["event_counts"].is_object());
	}
}
