//! GitHub proxy client and server boundary for isolated credentials.

#[cfg(all(target_os = "linux", unix))]
use std::os::unix::process::CommandExt;
use std::{
	collections::HashSet,
	path::{Path, PathBuf},
	process::Stdio,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::github::{GitHubClient, GitHubError, OpenPullRequest};
use axum::{
	Router,
	body::Body,
	extract::{Request, State},
	http::{HeaderMap, Method, StatusCode},
	response::{IntoResponse, Response},
	routing::{any, get, post},
};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use url::Url;

pub const HEADER_TIMESTAMP: &str = "X-Robogjc-Timestamp";
pub const HEADER_SIGNATURE: &str = "X-Robogjc-Sig";
pub const DEFAULT_SKEW_SECONDS: i64 = 30;

const GITHUB_API_BASE: &str = "https://api.github.com";

type HmacSha256 = Hmac<Sha256>;

fn hex_encode(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut out = String::with_capacity(bytes.len() * 2);
	for &byte in bytes {
		out.push(HEX[(byte >> 4) as usize] as char);
		out.push(HEX[(byte & 0x0f) as usize] as char);
	}
	out
}

fn string_to_sign(method: &str, path: &str, timestamp: &str, body: &[u8]) -> Vec<u8> {
	let body_hash = hex_encode(&Sha256::digest(body));
	[method.to_ascii_uppercase(), path.to_owned(), timestamp.to_owned(), body_hash]
		.join("\n")
		.into_bytes()
}

pub fn sign(method: &str, path: &str, body: &[u8], key: &[u8], timestamp: &str) -> String {
	let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any size");
	mac.update(&string_to_sign(method, path, timestamp, body));
	hex_encode(&mac.finalize().into_bytes())
}

pub fn signed_headers(method: &str, path: &str, body: &[u8], key: &[u8]) -> HeaderMap {
	let timestamp = now_seconds().to_string();
	let signature = sign(method, path, body, key, &timestamp);
	let mut headers = HeaderMap::new();
	headers.insert(HEADER_TIMESTAMP, timestamp.parse().expect("valid header"));
	headers.insert(HEADER_SIGNATURE, signature.parse().expect("valid header"));
	headers
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyResult {
	pub ok: bool,
	pub reason: String,
}

impl VerifyResult {
	fn ok() -> Self {
		Self { ok: true, reason: String::new() }
	}

	fn err(reason: &str) -> Self {
		Self { ok: false, reason: reason.to_owned() }
	}
}

pub fn verify(
	method: &str,
	path: &str,
	body: &[u8],
	timestamp: Option<&str>,
	signature: Option<&str>,
	key: &[u8],
	now: i64,
	skew: i64,
) -> VerifyResult {
	let (Some(timestamp), Some(signature)) = (timestamp, signature) else {
		return VerifyResult::err("missing signature headers");
	};
	let Ok(ts_int) = timestamp.parse::<i64>() else {
		return VerifyResult::err("malformed timestamp");
	};
	if (now - ts_int).abs() > skew {
		return VerifyResult::err("timestamp outside skew window");
	}
	let expected = sign(method, path, body, key, timestamp);
	if !constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
		return VerifyResult::err("signature mismatch");
	}
	VerifyResult::ok()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
	if left.len() != right.len() {
		return false;
	}
	let mut diff = 0u8;
	for (a, b) in left.iter().zip(right.iter()) {
		diff |= a ^ b;
	}
	diff == 0
}

fn now_seconds() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs() as i64
}

#[derive(Debug, Clone)]
pub struct ProxyServerConfig {
	pub github_token: String,
	pub hmac_key: Vec<u8>,
	pub upstream_base: String,
	pub workspace_root: PathBuf,
	pub git_timeout_seconds: u64,
	pub allowed_origins: HashSet<String>,
	pub max_body_bytes: usize,
	pub skew_seconds: i64,
}

impl ProxyServerConfig {
	pub fn new(github_token: impl Into<String>, hmac_key: impl Into<Vec<u8>>) -> Self {
		Self {
			github_token: github_token.into(),
			hmac_key: hmac_key.into(),
			upstream_base: GITHUB_API_BASE.to_owned(),
			allowed_origins: HashSet::from(["api.github.com".to_owned(), "github.com".to_owned()]),
			max_body_bytes: 1024 * 1024,
			skew_seconds: DEFAULT_SKEW_SECONDS,
			workspace_root: PathBuf::from("/data/workspaces"),
			git_timeout_seconds: 120,
		}
	}
}

#[derive(Clone)]
struct ProxyState {
	cfg: Arc<ProxyServerConfig>,
}

pub fn router(config: ProxyServerConfig) -> Router {
	let state = ProxyState { cfg: Arc::new(config) };
	Router::new()
		.route("/healthz", get(|| async { axum::Json(json!({"status":"ok"})) }))
		.route("/gh/v1/authenticated_login", get(typed_request))
		.route("/gh/v1/repo", get(typed_request))
		.route("/gh/v1/issue", get(typed_request))
		.route("/gh/v1/closing_prs", get(typed_request))
		.route("/gh/v1/pull_request", get(typed_request))
		.route("/gh/v1/issues", any(typed_request))
		.route("/gh/v1/comments", get(typed_request))
		.route("/gh/v1/review_comments", get(typed_request))
		.route("/gh/v1/pr_reviews", get(typed_request))
		.route("/gh/v1/comment_reactions", get(typed_request))
		.route("/gh/v1/post_comment", post(typed_request))
		.route("/gh/v1/open_pull_request", post(typed_request))
		.route("/gh/v1/request_reviewers", post(typed_request))
		.route("/gh/v1/add_issue_labels", post(typed_request))
		.route("/gh/v1/add_assignees", post(typed_request))
		.route("/gh/v1/close_issue", post(typed_request))
		.route("/gh/v1/git/clone", post(typed_request))
		.route("/gh/v1/git/fetch", post(typed_request))
		.route("/gh/v1/git/fetch_ref", post(typed_request))
		.route("/gh/v1/git/push", post(typed_request))
		.with_state(state)
}

pub async fn serve(listener: TcpListener, config: ProxyServerConfig) -> Result<(), std::io::Error> {
	axum::serve(listener, router(config)).await
}

fn request_target(parts: &http::request::Parts) -> String {
	parts
		.uri
		.path_and_query()
		.map_or_else(|| parts.uri.path().to_owned(), ToString::to_string)
}

async fn authenticate(
	state: &ProxyState,
	parts: &http::request::Parts,
	body: Body,
) -> Result<Bytes, Response> {
	if let Some(len) = parts.headers.get(http::header::CONTENT_LENGTH) {
		let declared = len
			.to_str()
			.ok()
			.and_then(|s| s.parse::<usize>().ok())
			.ok_or_else(|| (StatusCode::BAD_REQUEST, "invalid content-length").into_response())?;
		if declared > state.cfg.max_body_bytes {
			return Err((StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response());
		}
	}
	let target = request_target(parts);
	let body = axum::body::to_bytes(body, state.cfg.max_body_bytes)
		.await
		.map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "request body too large").into_response())?;
	let ts = parts
		.headers
		.get(HEADER_TIMESTAMP)
		.and_then(|v| v.to_str().ok());
	let sig = parts
		.headers
		.get(HEADER_SIGNATURE)
		.and_then(|v| v.to_str().ok());
	let result = verify(
		parts.method.as_str(),
		&target,
		&body,
		ts,
		sig,
		&state.cfg.hmac_key,
		now_seconds(),
		state.cfg.skew_seconds,
	);
	if !result.ok {
		return Err((StatusCode::UNAUTHORIZED, "unauthenticated").into_response());
	}
	Ok(body)
}

fn query_value(target: &str, key: &str) -> Option<String> {
	let query = target.split_once('?')?.1;
	url::form_urlencoded::parse(query.as_bytes())
		.find(|(k, _)| k == key)
		.map(|(_, v)| v.into_owned())
}

fn query_i64(target: &str, key: &str) -> Result<i64, Response> {
	query_value(target, key)
		.and_then(|v| v.parse::<i64>().ok())
		.ok_or_else(|| (StatusCode::BAD_REQUEST, format!("missing/invalid '{key}'")).into_response())
}

fn json_error(exc: GitHubError) -> Response {
	let status = StatusCode::from_u16(exc.status).unwrap_or(StatusCode::BAD_GATEWAY);
	(status, axum::Json(json!({"error":{"kind":"github","status":exc.status,"message":exc.message,"retry_after":exc.retry_after}}))).into_response()
}

fn required_str<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str, Response> {
	v.get(key)
		.and_then(serde_json::Value::as_str)
		.filter(|s| !s.is_empty())
		.ok_or_else(|| (StatusCode::BAD_REQUEST, format!("missing/invalid '{key}'")).into_response())
}

fn required_i64(v: &serde_json::Value, key: &str) -> Result<i64, Response> {
	v.get(key)
		.and_then(serde_json::Value::as_i64)
		.ok_or_else(|| (StatusCode::BAD_REQUEST, format!("missing/invalid '{key}'")).into_response())
}

async fn typed_request(State(state): State<ProxyState>, req: Request) -> Response {
	let (parts, body) = req.into_parts();
	let target = request_target(&parts);
	let body = match authenticate(&state, &parts, body).await {
		Ok(body) => body,
		Err(resp) => return resp,
	};
	let github = match GitHubClient::with_base_url(&state.cfg.github_token, &state.cfg.upstream_base)
	{
		Ok(client) => client,
		Err(err) => return (StatusCode::BAD_GATEWAY, err.to_string()).into_response(),
	};
	if parts.method == Method::POST && parts.uri.path().starts_with("/gh/v1/git/") {
		return git_typed(&state.cfg, parts.uri.path(), &body).await;
	}
	if parts.method == Method::POST {
		return post_typed(&github, parts.uri.path(), &body).await;
	}
	let result =
		typed_request_result(&github, parts.method.as_str(), parts.uri.path(), &target).await;
	match result {
		Ok(value) => axum::Json(value).into_response(),
		Err(resp) => resp,
	}
}

async fn typed_request_result(
	github: &GitHubClient,
	method: &str,
	path: &str,
	target: &str,
) -> Result<serde_json::Value, Response> {
	match (method, path) {
		("GET", "/gh/v1/authenticated_login") => github
			.get_authenticated_login()
			.await
			.map(|login| json!({"login": login}))
			.map_err(json_error),
		("GET", "/gh/v1/repo") => github
			.get_repo(&query_value(target, "repo").unwrap_or_default())
			.await
			.map(|v| json!(v))
			.map_err(json_error),
		("GET", "/gh/v1/issue") => github
			.get_issue(&query_value(target, "repo").unwrap_or_default(), query_i64(target, "number")?)
			.await
			.map(|v| json!(v))
			.map_err(json_error),
		("GET", "/gh/v1/closing_prs") => github
			.list_closing_pull_requests(
				&query_value(target, "repo").unwrap_or_default(),
				query_i64(target, "number")?,
			)
			.await
			.map(|v| json!({"pr_numbers": v}))
			.map_err(json_error),
		("GET", "/gh/v1/pull_request") => github
			.get_pull_request(
				&query_value(target, "repo").unwrap_or_default(),
				query_i64(target, "number")?,
			)
			.await
			.map(|v| json!(v))
			.map_err(json_error),
		("GET", "/gh/v1/issues") => github
			.list_issues(
				&query_value(target, "repo").unwrap_or_default(),
				&query_value(target, "state").unwrap_or_else(|| "open".to_owned()),
				query_value(target, "limit")
					.and_then(|v| v.parse().ok())
					.unwrap_or(30),
			)
			.await
			.map(|v| json!({"items": v}))
			.map_err(json_error),
		("GET", "/gh/v1/comments") => github
			.list_comments(
				&query_value(target, "repo").unwrap_or_default(),
				query_i64(target, "number")?,
			)
			.await
			.map(|v| json!({"items": v}))
			.map_err(json_error),
		("GET", "/gh/v1/review_comments") => github
			.list_review_comments(
				&query_value(target, "repo").unwrap_or_default(),
				query_i64(target, "pr_number")?,
			)
			.await
			.map(|v| json!({"items": v}))
			.map_err(json_error),
		("GET", "/gh/v1/pr_reviews") => github
			.list_pr_reviews(
				&query_value(target, "repo").unwrap_or_default(),
				query_i64(target, "pr_number")?,
			)
			.await
			.map(|v| json!({"items": v}))
			.map_err(json_error),
		("GET", "/gh/v1/comment_reactions") => github
			.list_comment_reactions(
				&query_value(target, "repo").unwrap_or_default(),
				query_i64(target, "comment_id")?,
			)
			.await
			.map(|v| json!({"items": v}))
			.map_err(json_error),
		_ => Err((StatusCode::NOT_FOUND, "unknown typed proxy endpoint").into_response()),
	}
}

async fn post_typed(github: &GitHubClient, path: &str, body: &[u8]) -> Response {
	let data: serde_json::Value = match serde_json::from_slice::<serde_json::Value>(body) {
		Ok(data) if data.is_object() => data,
		_ => return (StatusCode::BAD_REQUEST, "json body must be an object").into_response(),
	};
	match post_typed_result(github, path, &data).await {
		Ok(value) => axum::Json(value).into_response(),
		Err(resp) => resp,
	}
}

async fn post_typed_result(
	github: &GitHubClient,
	path: &str,
	data: &serde_json::Value,
) -> Result<serde_json::Value, Response> {
	match path {
		"/gh/v1/post_comment" => github
			.post_comment(
				required_str(data, "repo")?,
				required_i64(data, "number")?,
				required_str(data, "body")?,
			)
			.await
			.map(|v| json!(v))
			.map_err(json_error),
		"/gh/v1/open_pull_request" => github
			.open_pull_request(OpenPullRequest {
				repo: required_str(data, "repo")?,
				head: required_str(data, "head")?,
				base: required_str(data, "base")?,
				title: required_str(data, "title")?,
				body: required_str(data, "body")?,
				draft: data
					.get("draft")
					.and_then(serde_json::Value::as_bool)
					.unwrap_or(false),
				maintainer_can_modify: data
					.get("maintainer_can_modify")
					.and_then(serde_json::Value::as_bool)
					.unwrap_or(true),
			})
			.await
			.map(|v| json!(v))
			.map_err(json_error),
		"/gh/v1/request_reviewers" => {
			let reviewers = string_vec(data.get("reviewers"));
			let teams = string_vec(data.get("team_reviewers"));
			github
				.request_reviewers(
					required_str(data, "repo")?,
					required_i64(data, "pr_number")?,
					&reviewers,
					&teams,
				)
				.await
				.map(|()| json!({"ok": true}))
				.map_err(json_error)
		},
		"/gh/v1/add_issue_labels" => {
			let labels = string_vec(data.get("labels"));
			github
				.add_issue_labels(required_str(data, "repo")?, required_i64(data, "number")?, &labels)
				.await
				.map(|labels| json!({"labels": labels}))
				.map_err(json_error)
		},
		"/gh/v1/add_assignees" => {
			let assignees = string_vec(data.get("assignees"));
			github
				.add_assignees(required_str(data, "repo")?, required_i64(data, "number")?, &assignees)
				.await
				.map(|()| json!({"ok": true}))
				.map_err(json_error)
		},
		"/gh/v1/close_issue" => github
			.close_issue(
				required_str(data, "repo")?,
				required_i64(data, "number")?,
				data
					.get("reason")
					.and_then(serde_json::Value::as_str)
					.unwrap_or("completed"),
			)
			.await
			.map(|()| json!({"ok": true}))
			.map_err(json_error),
		_ => Err((StatusCode::NOT_FOUND, "unknown typed proxy endpoint").into_response()),
	}
}

fn string_vec(value: Option<&serde_json::Value>) -> Vec<String> {
	value
		.and_then(serde_json::Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(|v| v.as_str().map(str::to_owned))
		.collect()
}

fn pool_dir(cfg: &ProxyServerConfig, repo: &str) -> Result<PathBuf, Response> {
	if !repo.contains('/') || repo.starts_with('/') || repo.split('/').any(|p| p == "..") {
		return Err((StatusCode::BAD_REQUEST, format!("invalid repo {repo:?}")).into_response());
	}
	Ok(cfg
		.workspace_root
		.join("_pool")
		.join(repo.replace('/', "__")))
}

fn workspace_repo_dir(cfg: &ProxyServerConfig, workspace_key: &str) -> Result<PathBuf, Response> {
	if workspace_key.contains('/') || workspace_key.starts_with('.') || workspace_key.contains("..")
	{
		return Err(
			(StatusCode::BAD_REQUEST, format!("invalid workspace_key {workspace_key:?}"))
				.into_response(),
		);
	}
	Ok(cfg.workspace_root.join(workspace_key).join("repo"))
}

fn basic_auth_header(token: &str) -> String {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let raw = format!("x-access-token:{token}");
	let bytes = raw.as_bytes();
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let b0 = chunk[0];
		let b1 = *chunk.get(1).unwrap_or(&0);
		let b2 = *chunk.get(2).unwrap_or(&0);
		out.push(TABLE[(b0 >> 2) as usize] as char);
		out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
		if chunk.len() > 1 {
			out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
		} else {
			out.push('=');
		}
		if chunk.len() > 2 {
			out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
		} else {
			out.push('=');
		}
	}
	format!("Authorization: Basic {out}")
}

fn optional_slot_uid(data: &serde_json::Value) -> Result<Option<u32>, Response> {
	let Some(value) = data.get("slot_uid") else {
		return Ok(None);
	};
	let Some(uid) = value.as_u64() else {
		return Err((StatusCode::BAD_REQUEST, "missing/invalid 'slot_uid'").into_response());
	};
	if uid == 0 || uid >= 65_536 {
		return Err((StatusCode::BAD_REQUEST, "missing/invalid 'slot_uid'").into_response());
	}
	Ok(Some(uid as u32))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitCommandSpec {
	args: Vec<String>,
	cwd: PathBuf,
	token_header: Option<String>,
	safe_directory: Option<PathBuf>,
	slot_uid: Option<u32>,
}

impl GitCommandSpec {
	fn new(
		args: Vec<String>,
		cwd: &Path,
		token: Option<&str>,
		safe_directory: Option<&Path>,
		slot_uid: Option<u32>,
	) -> Self {
		Self {
			args,
			cwd: cwd.to_path_buf(),
			token_header: token.map(basic_auth_header),
			safe_directory: safe_directory.map(Path::to_path_buf),
			slot_uid,
		}
	}

	fn command(&self) -> tokio::process::Command {
		let mut cmd = tokio::process::Command::new("git");
		cmd.args(&self.args)
			.current_dir(&self.cwd)
			.env("GIT_TERMINAL_PROMPT", "0")
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		let mut config_count = 0;
		if let Some(header) = &self.token_header {
			cmd.env(format!("GIT_CONFIG_KEY_{config_count}"), "http.extraHeader")
				.env(format!("GIT_CONFIG_VALUE_{config_count}"), header);
			config_count += 1;
		}
		if let Some(safe_directory) = &self.safe_directory {
			cmd.env(format!("GIT_CONFIG_KEY_{config_count}"), "safe.directory")
				.env(format!("GIT_CONFIG_VALUE_{config_count}"), safe_directory);
			config_count += 1;
		}
		if config_count > 0 {
			cmd.env("GIT_CONFIG_COUNT", config_count.to_string());
		}
		#[cfg(all(target_os = "linux", unix))]
		if let Some(uid) = self.slot_uid.filter(|_| unsafe { libc_geteuid() } == 0) {
			cmd.uid(uid).gid(uid);
		}
		cmd
	}
}

#[cfg(all(target_os = "linux", unix))]
unsafe extern "C" {
	fn geteuid() -> u32;
}

#[cfg(all(target_os = "linux", unix))]
unsafe fn libc_geteuid() -> u32 {
	unsafe { geteuid() }
}

async fn run_git(
	args: Vec<String>,
	cwd: &Path,
	token: &str,
	timeout_seconds: u64,
	slot_uid: Option<u32>,
) -> Result<(), Response> {
	let spec = GitCommandSpec::new(args, cwd, Some(token), None, slot_uid);
	let mut cmd = spec.command();
	let out = tokio::time::timeout(Duration::from_secs(timeout_seconds), cmd.output())
		.await
		.map_err(|_| (StatusCode::GATEWAY_TIMEOUT, axum::Json(json!({"error":{"kind":"git","returncode":124,"cmd":["git"],"stdout":"","stderr":"git command timed out"}}))).into_response())?
		.map_err(|err| (StatusCode::BAD_GATEWAY, axum::Json(json!({"error":{"kind":"git","returncode":1,"cmd":["git"],"stdout":"","stderr":redact_token(&err.to_string(), token)}}))).into_response())?;
	if out.status.success() {
		Ok(())
	} else {
		Err((StatusCode::BAD_GATEWAY, axum::Json(json!({"error":{"kind":"git","returncode":out.status.code().unwrap_or(1),"cmd":["git"],"stdout":String::from_utf8_lossy(&out.stdout),"stderr":redact_token(&String::from_utf8_lossy(&out.stderr), token)}}))).into_response())
	}
}

async fn run_git_stdout(
	args: Vec<String>,
	cwd: &Path,
	timeout_seconds: u64,
	slot_uid: Option<u32>,
	safe_directory: Option<&Path>,
	error_message: &'static str,
) -> Result<String, Response> {
	let spec = GitCommandSpec::new(args, cwd, None, safe_directory, slot_uid);
	let mut cmd = spec.command();
	let out = tokio::time::timeout(Duration::from_secs(timeout_seconds), cmd.output())
		.await
		.map_err(|_| (StatusCode::GATEWAY_TIMEOUT, error_message).into_response())?
		.map_err(|_| (StatusCode::BAD_REQUEST, error_message).into_response())?;
	if !out.status.success() {
		return Err((StatusCode::BAD_REQUEST, error_message).into_response());
	}
	Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

async fn read_origin_url(
	repo_dir: &Path,
	timeout_seconds: u64,
	slot_uid: Option<u32>,
) -> Result<String, Response> {
	run_git_stdout(
		vec!["remote".into(), "get-url".into(), "origin".into()],
		repo_dir,
		timeout_seconds.min(5),
		slot_uid,
		slot_uid.map(|_| repo_dir),
		"could not read origin url for worktree",
	)
	.await
}

async fn assert_origin_safe_for_repo(
	repo_dir: &Path,
	expected_repo: &str,
	timeout_seconds: u64,
	slot_uid: Option<u32>,
) -> Result<(), Response> {
	let url = read_origin_url(repo_dir, timeout_seconds, slot_uid).await?;
	let Ok(parsed) = Url::parse(&url) else {
		return Ok(());
	};
	let scheme = parsed.scheme().to_ascii_lowercase();
	if scheme != "http" && scheme != "https" {
		return Ok(());
	}
	let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
	let mut path = parsed.path().trim_matches('/').to_owned();
	if path.ends_with(".git") {
		path.truncate(path.len() - 4);
	}
	if host != "github.com" || !path.eq_ignore_ascii_case(expected_repo) {
		return Err(
			(StatusCode::BAD_REQUEST, "origin url does not match repo; refusing to push")
				.into_response(),
		);
	}
	Ok(())
}

async fn git_typed(cfg: &ProxyServerConfig, path: &str, body: &[u8]) -> Response {
	let data: serde_json::Value = match serde_json::from_slice::<serde_json::Value>(body) {
		Ok(data) if data.is_object() => data,
		_ => return (StatusCode::BAD_REQUEST, "json body must be an object").into_response(),
	};
	let repo = match required_str(&data, "repo") {
		Ok(v) => v,
		Err(resp) => return resp,
	};
	match path {
		"/gh/v1/git/clone" => {
			let target = match pool_dir(cfg, repo) {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			let clone_url = match required_str(&data, "clone_url") {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			let default_branch = match required_str(&data, "default_branch") {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			if !target.exists() {
				if let Some(parent) = target.parent() {
					let _ = tokio::fs::create_dir_all(parent).await;
				}
				if let Err(resp) = run_git(
					vec![
						"clone".into(),
						"--filter=blob:none".into(),
						"--branch".into(),
						default_branch.into(),
						clone_url.into(),
						target.to_string_lossy().into_owned(),
					],
					Path::new("."),
					&cfg.github_token,
					cfg.git_timeout_seconds,
					None,
				)
				.await
				{
					return resp;
				}
			}
			axum::Json(json!({"pool_dir": target})).into_response()
		},
		"/gh/v1/git/fetch" => {
			let target = match pool_dir(cfg, repo) {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			if let Err(resp) = run_git(
				vec!["fetch".into(), "--prune".into(), "origin".into()],
				&target,
				&cfg.github_token,
				cfg.git_timeout_seconds,
				None,
			)
			.await
			{
				return resp;
			}
			axum::Json(json!({"pool_dir": target})).into_response()
		},
		"/gh/v1/git/fetch_ref" => {
			let target = match pool_dir(cfg, repo) {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			let git_ref = match required_str(&data, "ref") {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			let _ = run_git(
				vec!["fetch".into(), "origin".into(), git_ref.into()],
				&target,
				&cfg.github_token,
				cfg.git_timeout_seconds,
				None,
			)
			.await;
			axum::Json(json!({"pool_dir": target})).into_response()
		},
		"/gh/v1/git/push" => {
			let workspace_key = match required_str(&data, "workspace_key") {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			if !workspace_key.starts_with(&(repo.replace('/', "__") + "__")) {
				return (StatusCode::BAD_REQUEST, "workspace_key does not match repo").into_response();
			}
			let repo_dir = match workspace_repo_dir(cfg, workspace_key) {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			if !repo_dir.is_dir() {
				return (StatusCode::NOT_FOUND, format!("workspace not found: {workspace_key}"))
					.into_response();
			}
			let branch = match required_str(&data, "branch") {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			let expected_head = match required_str(&data, "expected_head") {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			let slot_uid = match optional_slot_uid(&data) {
				Ok(v) => v,
				Err(resp) => return resp,
			};
			if let Err(resp) =
				assert_origin_safe_for_repo(&repo_dir, repo, cfg.git_timeout_seconds, slot_uid).await
			{
				return resp;
			}
			let head = run_git_stdout(
				vec!["rev-parse".into(), "HEAD".into()],
				&repo_dir,
				cfg.git_timeout_seconds.min(5),
				slot_uid,
				slot_uid.map(|_| repo_dir.as_path()),
				"could not read HEAD for worktree",
			)
			.await
			.unwrap_or_default();
			if !expected_head.is_empty() && head != expected_head {
				return (StatusCode::CONFLICT, axum::Json(json!({"error":{"kind":"head_drift","returncode":1,"cmd":["git","rev-parse","HEAD"],"stdout":head,"stderr":"head drift"}}))).into_response();
			}
			if let Err(resp) = run_git(
				vec!["push".into(), "origin".into(), format!("HEAD:{branch}")],
				&repo_dir,
				&cfg.github_token,
				cfg.git_timeout_seconds,
				slot_uid,
			)
			.await
			{
				return resp;
			}
			axum::Json(json!({"head": head, "branch": branch})).into_response()
		},
		_ => (StatusCode::NOT_FOUND, "unknown git proxy endpoint").into_response(),
	}
}

#[derive(Debug, Clone)]
pub struct GitHubProxyClient {
	base_url: String,
	hmac_key: Vec<u8>,
	client: reqwest::Client,
}

impl GitHubProxyClient {
	pub fn new(base_url: impl Into<String>, hmac_key: impl Into<Vec<u8>>) -> Self {
		Self {
			base_url: base_url.into().trim_end_matches('/').to_owned(),
			hmac_key: hmac_key.into(),
			client: reqwest::Client::new(),
		}
	}

	pub async fn request(
		&self,
		method: Method,
		path: &str,
		body: Bytes,
	) -> Result<reqwest::Response, ProxyClientError> {
		let url = format!("{}{}", self.base_url, path);
		let headers = signed_headers(method.as_str(), path, &body, &self.hmac_key);
		let method = reqwest::Method::from_bytes(method.as_str().as_bytes())
			.map_err(|err| ProxyClientError(redact_token(&err.to_string(), "")))?;
		let mut builder = self.client.request(method, url).body(body);
		for (name, value) in headers {
			if let Some(name) = name {
				builder = builder.header(name, value);
			}
		}
		builder
			.send()
			.await
			.map_err(|err| ProxyClientError(redact_token(&err.to_string(), "")))
	}

	pub async fn request_params(
		&self,
		method: Method,
		path: &str,
		params: &[(&str, String)],
		body: Bytes,
	) -> Result<reqwest::Response, ProxyClientError> {
		let target = canonical_target(path, params).map_err(ProxyClientError)?;
		self.request(method, &target, body).await
	}

	pub async fn get_json<T: for<'de> Deserialize<'de>>(
		&self,
		path: &str,
	) -> Result<T, ProxyClientError> {
		let resp = self.request(Method::GET, path, Bytes::new()).await?;
		let status = resp.status();
		let text = resp
			.text()
			.await
			.map_err(|err| ProxyClientError(err.to_string()))?;
		if !status.is_success() {
			return Err(ProxyClientError(text));
		}
		serde_json::from_str(&text).map_err(|err| ProxyClientError(err.to_string()))
	}
}

pub fn canonical_target(path: &str, params: &[(&str, String)]) -> Result<String, String> {
	if params.is_empty() {
		return Ok(path.to_owned());
	}
	let mut url = Url::parse(&format!("http://proxy.test{path}")).map_err(|err| err.to_string())?;
	url.query_pairs_mut()
		.clear()
		.extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
	let mut target = url.path().to_owned();
	if let Some(query) = url.query() {
		target.push('?');
		target.push_str(query);
	}
	Ok(target)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyClientError(String);

impl std::fmt::Display for ProxyClientError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl std::error::Error for ProxyClientError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCredentialRequest {
	pub protocol: String,
	pub host: String,
	pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCredentialResponse {
	pub username: String,
	pub password: String,
}

pub fn credential_helper_response(token: &str) -> String {
	format!("username=x-access-token\npassword={token}\n")
}

pub fn orchestrator_env_without_pat() -> Vec<(&'static str, &'static str)> {
	vec![("GIT_TERMINAL_PROMPT", "0")]
}

pub fn redact_token(message: &str, token: &str) -> String {
	if token.is_empty() {
		message.to_owned()
	} else {
		message.replace(token, "<redacted>")
	}
}

#[cfg(test)]
mod tests {
	use axum::{body::Body, http::Request};
	use serde::Deserialize;
	use tower::ServiceExt;

	use super::*;

	#[derive(Debug, Deserialize)]
	struct HmacFixture {
		cases: Vec<HmacCase>,
	}

	#[derive(Debug, Deserialize)]
	struct HmacCase {
		method: String,
		path: String,
		body: String,
		key: String,
		timestamp: String,
		expected_signature: String,
		expected_timestamp: String,
		verify_ok: bool,
	}

	#[test]
	fn proxy_hmac_vectors() {
		let fixture: HmacFixture = crate::fixture_harness::load_fixture("phase1/hmac-vectors.json");
		for case in fixture.cases {
			let signature = sign(
				&case.method,
				&case.path,
				case.body.as_bytes(),
				case.key.as_bytes(),
				&case.timestamp,
			);
			assert_eq!(signature, case.expected_signature);
			assert_eq!(case.timestamp, case.expected_timestamp);

			let result = verify(
				&case.method,
				&case.path,
				case.body.as_bytes(),
				Some(&case.timestamp),
				Some(&case.expected_signature),
				case.key.as_bytes(),
				case.timestamp.parse().unwrap(),
				DEFAULT_SKEW_SECONDS,
			);
			assert_eq!(result.ok, case.verify_ok, "{}", result.reason);
		}
	}

	#[test]
	fn verify_rejects_failure_modes() {
		let signature = sign("GET", "/x", b"", b"k", "100");
		assert_eq!(
			verify("GET", "/x", b"", None, Some(&signature), b"k", 100, 30).reason,
			"missing signature headers"
		);
		assert_eq!(
			verify("GET", "/x", b"", Some("nope"), Some(&signature), b"k", 100, 30).reason,
			"malformed timestamp"
		);
		assert_eq!(
			verify("GET", "/x", b"", Some("69"), Some(&signature), b"k", 100, 30).reason,
			"timestamp outside skew window"
		);
		assert_eq!(
			verify("GET", "/x", b"changed", Some("100"), Some(&signature), b"k", 100, 30).reason,
			"signature mismatch"
		);
	}

	#[test]
	fn differential_boundary_hmac_cases_match_python() {
		let key = b"k";
		let path = "/unicodé/路径?q=✓";
		for (timestamp, expected_signature, now, ok, reason) in [
			(
				"970",
				"a820c17e3afb0c013aaf0b357c3d9049f542dc95febbc2f64a61c2f881c54add",
				1000,
				true,
				"",
			),
			(
				"1030",
				"3172124bc3c62a56e80e01ec4efcaf9c80706b4e1574d0978a7581854ab26823",
				1000,
				true,
				"",
			),
			(
				"969",
				"1f3830ecbf345eef286a9d2b18c20be1d943c4a4a9386128e117d3dd97d7a8b0",
				1000,
				false,
				"timestamp outside skew window",
			),
		] {
			assert_eq!(sign("GET", path, b"", key, timestamp), expected_signature);
			let result = verify(
				"GET",
				path,
				b"",
				Some(timestamp),
				Some(expected_signature),
				key,
				now,
				DEFAULT_SKEW_SECONDS,
			);
			assert_eq!((result.ok, result.reason.as_str()), (ok, reason));
		}

		let signature = sign("POST", "/x", b"", key, "1000");
		for bad_signature in [&signature[..signature.len() - 1], &"z".repeat(64)] {
			let result = verify(
				"POST",
				"/x",
				b"",
				Some("1000"),
				Some(bad_signature),
				key,
				1000,
				DEFAULT_SKEW_SECONDS,
			);
			assert_eq!((result.ok, result.reason.as_str()), (false, "signature mismatch"));
		}
	}

	#[tokio::test]
	async fn proxy_server_rejects_missing_bad_stale_and_query_replay() {
		let app = router(ProxyServerConfig::new("ghp_secret", b"k".to_vec()));
		let resp = app
			.clone()
			.oneshot(
				Request::builder()
					.uri("/gh/v1/repo?repo=octo/widget")
					.body(Body::empty())
					.unwrap(),
			)
			.await
			.unwrap();
		assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

		let ts = now_seconds().to_string();
		let bad = Request::builder()
			.uri("/gh/v1/repo?repo=octo/widget")
			.header(HEADER_TIMESTAMP, ts)
			.header(HEADER_SIGNATURE, "0".repeat(64))
			.body(Body::empty())
			.unwrap();
		let resp = app.clone().oneshot(bad).await.unwrap();
		assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

		let stale_ts = (now_seconds() - 120).to_string();
		let stale_sig = sign("GET", "/gh/v1/repo?repo=octo/widget", b"", b"k", &stale_ts);
		let stale = Request::builder()
			.uri("/gh/v1/repo?repo=octo/widget")
			.header(HEADER_TIMESTAMP, stale_ts)
			.header(HEADER_SIGNATURE, stale_sig)
			.body(Body::empty())
			.unwrap();
		let resp = app.clone().oneshot(stale).await.unwrap();
		assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

		let ts = now_seconds().to_string();
		let sig = sign("GET", "/gh/v1/repo?repo=octo/widget", b"", b"k", &ts);
		let replay = Request::builder()
			.uri("/gh/v1/repo?repo=octo/other")
			.header(HEADER_TIMESTAMP, ts)
			.header(HEADER_SIGNATURE, sig)
			.body(Body::empty())
			.unwrap();
		let resp = app.oneshot(replay).await.unwrap();
		assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
	}

	#[tokio::test]
	async fn proxy_server_enforces_body_cap_before_proxying() {
		let mut cfg = ProxyServerConfig::new("ghp_secret", b"k".to_vec());
		cfg.max_body_bytes = 4;
		let app = router(cfg);
		let body = Bytes::from_static(b"12345");
		let ts = now_seconds().to_string();
		let sig = sign("POST", "/gh/v1/issues", &body, b"k", &ts);
		let req = Request::builder()
			.method("POST")
			.uri("/gh/v1/issues")
			.header(HEADER_TIMESTAMP, ts)
			.header(HEADER_SIGNATURE, sig)
			.body(Body::from(body))
			.unwrap();
		let resp = app.oneshot(req).await.unwrap();
		assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
	}

	#[tokio::test]
	async fn proxy_server_rejects_oversize_content_length_before_reading_body() {
		let mut cfg = ProxyServerConfig::new("ghp_secret", b"k".to_vec());
		cfg.max_body_bytes = 4;
		let app = router(cfg);
		let ts = now_seconds().to_string();
		let sig = sign("POST", "/gh/v1/post_comment", b"", b"k", &ts);
		let req = Request::builder()
			.method("POST")
			.uri("/gh/v1/post_comment")
			.header(http::header::CONTENT_LENGTH, "5")
			.header(HEADER_TIMESTAMP, ts)
			.header(HEADER_SIGNATURE, sig)
			.body(Body::empty())
			.unwrap();
		let resp = app.oneshot(req).await.unwrap();
		assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
	}

	#[tokio::test]
	async fn proxy_server_rejects_unlisted_gh_path_without_upstream_contact() {
		let mut cfg = ProxyServerConfig::new("ghp_secret", b"k".to_vec());
		cfg.upstream_base = "http://127.0.0.1:9".to_owned();
		let app = router(cfg);
		let ts = now_seconds().to_string();
		let sig = sign("GET", "/gh/v1/repos/octo/widget?per_page=1", b"", b"k", &ts);
		let req = Request::builder()
			.method("GET")
			.uri("/gh/v1/repos/octo/widget?per_page=1")
			.header(HEADER_TIMESTAMP, ts)
			.header(HEADER_SIGNATURE, sig)
			.body(Body::empty())
			.unwrap();
		let resp = app.oneshot(req).await.unwrap();
		assert_eq!(resp.status(), StatusCode::NOT_FOUND);
	}

	#[tokio::test]
	async fn git_push_rejects_invalid_slot_uid_before_origin_or_push() {
		let tmp = tempfile::tempdir().unwrap();
		let repo_dir = tmp.path().join("octo__widget__1/repo");
		std::fs::create_dir_all(&repo_dir).unwrap();
		let mut cfg = ProxyServerConfig::new("ghp_secret", b"k".to_vec());
		cfg.workspace_root = tmp.path().to_path_buf();
		let app = router(cfg);
		let body = Bytes::from_static(br#"{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"main","expected_head":"abc","slot_uid":0}"#);
		let ts = now_seconds().to_string();
		let sig = sign("POST", "/gh/v1/git/push", &body, b"k", &ts);
		let req = Request::builder()
			.method("POST")
			.uri("/gh/v1/git/push")
			.header(HEADER_TIMESTAMP, ts)
			.header(HEADER_SIGNATURE, sig)
			.body(Body::from(body))
			.unwrap();
		let resp = app.oneshot(req).await.unwrap();
		assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
	}

	#[test]
	fn git_push_slot_uid_reaches_origin_head_and_push_specs() {
		let repo_dir = Path::new("/tmp/workspace/repo");
		let origin = GitCommandSpec::new(
			vec!["remote".into(), "get-url".into(), "origin".into()],
			repo_dir,
			None,
			Some(repo_dir),
			Some(12345),
		);
		let head = GitCommandSpec::new(
			vec!["rev-parse".into(), "HEAD".into()],
			repo_dir,
			None,
			Some(repo_dir),
			Some(12345),
		);
		let push = GitCommandSpec::new(
			vec!["push".into(), "origin".into(), "HEAD:main".into()],
			repo_dir,
			Some("ghp_secret"),
			None,
			Some(12345),
		);
		assert_eq!(origin.slot_uid, Some(12345));
		assert_eq!(head.slot_uid, Some(12345));
		assert_eq!(push.slot_uid, Some(12345));
		assert_eq!(origin.safe_directory.as_deref(), Some(repo_dir));
		assert_eq!(head.safe_directory.as_deref(), Some(repo_dir));
		assert!(
			push
				.token_header
				.as_deref()
				.unwrap()
				.starts_with("Authorization: Basic ")
		);
	}

	#[tokio::test]
	async fn git_push_origin_guard_allows_local_and_rejects_wrong_https_origin() {
		let tmp = tempfile::tempdir().unwrap();
		let repo_dir = tmp.path().join("repo");
		std::fs::create_dir_all(&repo_dir).unwrap();
		let init = tokio::process::Command::new("git")
			.args(["init"])
			.current_dir(&repo_dir)
			.output()
			.await
			.unwrap();
		assert!(init.status.success());
		let add_local = tokio::process::Command::new("git")
			.args(["remote", "add", "origin", tmp.path().to_str().unwrap()])
			.current_dir(&repo_dir)
			.output()
			.await
			.unwrap();
		assert!(add_local.status.success());
		assert!(
			assert_origin_safe_for_repo(&repo_dir, "octo/widget", 5, None)
				.await
				.is_ok()
		);
		let set_evil = tokio::process::Command::new("git")
			.args(["remote", "set-url", "origin", "https://evil.example/octo/widget.git"])
			.current_dir(&repo_dir)
			.output()
			.await
			.unwrap();
		assert!(set_evil.status.success());
		let err = assert_origin_safe_for_repo(&repo_dir, "octo/widget", 5, None)
			.await
			.unwrap_err();
		assert_eq!(err.status(), StatusCode::BAD_REQUEST);
		let set_github = tokio::process::Command::new("git")
			.args(["remote", "set-url", "origin", "https://github.com/octo/widget.git"])
			.current_dir(&repo_dir)
			.output()
			.await
			.unwrap();
		assert!(set_github.status.success());
		assert!(
			assert_origin_safe_for_repo(&repo_dir, "Octo/Widget", 5, None)
				.await
				.is_ok()
		);
	}

	#[test]
	fn proxy_client_signs_query_and_keeps_pat_out_of_orchestrator_env() {
		let headers = signed_headers("GET", "/gh/v1/repo?repo=octo/widget", b"", b"k");
		let ts = headers.get(HEADER_TIMESTAMP).unwrap().to_str().unwrap();
		let sig = headers.get(HEADER_SIGNATURE).unwrap().to_str().unwrap();
		assert!(
			verify(
				"GET",
				"/gh/v1/repo?repo=octo/widget",
				b"",
				Some(ts),
				Some(sig),
				b"k",
				ts.parse().unwrap(),
				30
			)
			.ok
		);
		assert!(
			!orchestrator_env_without_pat()
				.iter()
				.any(|(k, _)| *k == "GITHUB_TOKEN")
		);
		assert!(!redact_token("boom ghp_secret leaked", "ghp_secret").contains("ghp_secret"));
	}

	#[test]
	fn proxy_client_canonicalizes_params_like_wire_url() {
		let target = canonical_target(
			"/gh/v1/issue",
			&[
				("repo", "octo/widget".to_owned()),
				("q", "has space".to_owned()),
				("unicode", "✓".to_owned()),
			],
		)
		.unwrap();
		assert_eq!(target, "/gh/v1/issue?repo=octo%2Fwidget&q=has+space&unicode=%E2%9C%93");

		let reversed = canonical_target(
			"/gh/v1/issue",
			&[("unicode", "✓".to_owned()), ("repo", "octo/widget".to_owned())],
		)
		.unwrap();
		assert_eq!(reversed, "/gh/v1/issue?unicode=%E2%9C%93&repo=octo%2Fwidget");
	}
}
