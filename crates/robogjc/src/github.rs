//! GitHub REST client and webhook routing for robogjc.

use std::{
	collections::{HashMap, HashSet},
	fmt,
	future::Future,
	pin::Pin,
	time::{SystemTime, UNIX_EPOCH},
};

use hmac::{Hmac, Mac};
use regex::Regex;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use crate::{db::issue_key, pragmas::parse_pragmas};

pub const GITHUB_API: &str = "https://api.github.com";
pub const GITHUB_ACCEPT: &str = "application/vnd.github+json";
pub const GITHUB_API_VERSION: &str = "2022-11-28";

#[derive(Debug, Clone, PartialEq)]
pub struct GitHubError {
	pub status: u16,
	pub message: String,
	pub retry_after: Option<f64>,
}

impl fmt::Display for GitHubError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "GitHub {}: {}", self.status, self.message)
	}
}

impl std::error::Error for GitHubError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueInfo {
	pub repo: String,
	pub number: i64,
	pub title: String,
	pub body: String,
	pub state: String,
	pub author: String,
	pub labels: Vec<String>,
	pub is_pull_request: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentInfo {
	pub id: i64,
	pub author: String,
	pub body: String,
	pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoInfo {
	pub full_name: String,
	pub default_branch: String,
	pub clone_url: String,
	pub private: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestInfo {
	pub repo: String,
	pub number: i64,
	pub html_url: String,
	pub head_ref: String,
	pub base_ref: String,
	pub state: String,
	pub author: String,
	pub head_repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewCommentInfo {
	pub id: i64,
	pub author: String,
	pub body: String,
	pub path: String,
	pub line: Option<i64>,
	pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestReviewInfo {
	pub id: i64,
	pub author: String,
	pub body: String,
	pub state: String,
	pub submitted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueSummary {
	pub repo: String,
	pub number: i64,
	pub title: String,
	pub state: String,
	pub author: String,
	pub labels: Vec<String>,
	pub comments: i64,
	pub updated_at: String,
	pub created_at: String,
	pub html_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReactionInfo {
	pub content: String,
	pub user_login: String,
	pub user_type: String,
}

#[derive(Clone)]
pub struct GitHubClient {
	client: reqwest::Client,
	base_url: String,
}

impl GitHubClient {
	pub fn new(token: impl AsRef<str>) -> Result<Self, reqwest::Error> {
		Self::with_base_url(token, GITHUB_API)
	}

	pub fn with_base_url(
		token: impl AsRef<str>,
		base_url: impl AsRef<str>,
	) -> Result<Self, reqwest::Error> {
		let mut headers = HeaderMap::new();
		headers.insert(
			AUTHORIZATION,
			HeaderValue::from_str(&format!("Bearer {}", token.as_ref())).expect("valid token header"),
		);
		headers.insert(ACCEPT, HeaderValue::from_static(GITHUB_ACCEPT));
		headers.insert("X-GitHub-Api-Version", HeaderValue::from_static(GITHUB_API_VERSION));
		headers.insert(USER_AGENT, HeaderValue::from_static("robogjc/0.1"));
		let client = reqwest::Client::builder()
			.default_headers(headers)
			.timeout(std::time::Duration::from_secs(30))
			.connect_timeout(std::time::Duration::from_secs(10))
			.redirect(reqwest::redirect::Policy::limited(10))
			.build()?;
		Ok(Self { client, base_url: base_url.as_ref().trim_end_matches('/').to_owned() })
	}

	async fn request(
		&self,
		method: reqwest::Method,
		path: &str,
		json: Option<&Value>,
		params: Option<&[(&str, String)]>,
	) -> Result<Value, GitHubError> {
		let url = format!("{}{}", self.base_url, path);
		let mut req = self.client.request(method, url);
		if let Some(j) = json {
			req = req.json(j);
		}
		if let Some(p) = params {
			req = req.query(p);
		}
		let resp = req.send().await.map_err(|e| GitHubError {
			status: 0,
			message: e.to_string(),
			retry_after: None,
		})?;
		Self::check(resp).await
	}

	async fn check(resp: reqwest::Response) -> Result<Value, GitHubError> {
		let status = resp.status().as_u16();
		let retry_after = parse_retry_after(resp.headers());
		if status == 204 {
			return Ok(Value::Null);
		}
		let text = resp.text().await.unwrap_or_default();
		if status >= 400 {
			let msg = serde_json::from_str::<Value>(&text)
				.ok()
				.and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
				.unwrap_or(text);
			return Err(GitHubError { status, message: msg, retry_after });
		}
		if status >= 300 {
			return Err(GitHubError {
				status,
				message: "unexpected redirect; resource may have moved".to_owned(),
				retry_after,
			});
		}
		if text.is_empty() {
			return Ok(Value::Null);
		}
		serde_json::from_str(&text).map_err(|e| GitHubError {
			status,
			message: e.to_string(),
			retry_after,
		})
	}

	pub async fn get_repo(&self, repo: &str) -> Result<RepoInfo, GitHubError> {
		Ok(repo_from_payload(
			&self
				.request(reqwest::Method::GET, &format!("/repos/{repo}"), None, None)
				.await?,
		))
	}

	pub async fn get_issue(&self, repo: &str, number: i64) -> Result<IssueInfo, GitHubError> {
		Ok(issue_from_payload(
			repo,
			&self
				.request(reqwest::Method::GET, &format!("/repos/{repo}/issues/{number}"), None, None)
				.await?,
		))
	}

	pub async fn list_closing_pull_requests(
		&self,
		repo: &str,
		number: i64,
	) -> Result<Vec<i64>, GitHubError> {
		let data = self
			.request(
				reqwest::Method::GET,
				&format!("/repos/{repo}/issues/{number}/timeline"),
				None,
				Some(&[("per_page", "100".to_owned())]),
			)
			.await?;
		let mut linked = HashSet::new();
		let mut states: HashMap<i64, String> = HashMap::new();
		for event in data.as_array().into_iter().flatten() {
			let Some(src_issue) = event.get("source").and_then(|s| s.get("issue")) else {
				continue;
			};
			if src_issue.get("pull_request").is_none() {
				continue;
			}
			let Some(n) = src_issue.get("number").and_then(Value::as_i64) else {
				continue;
			};
			states.insert(n, str_field(src_issue, "state", "open"));
			match event.get("event").and_then(Value::as_str) {
				Some("connected") => {
					linked.insert(n);
				},
				Some("disconnected") => {
					linked.remove(&n);
				},
				_ => {},
			}
		}
		let mut out: Vec<i64> = linked
			.into_iter()
			.filter(|n| states.get(n).map_or(true, |s| s == "open"))
			.collect();
		out.sort_unstable();
		Ok(out)
	}

	pub async fn get_pull_request(
		&self,
		repo: &str,
		number: i64,
	) -> Result<PullRequestInfo, GitHubError> {
		Ok(pr_from_payload(
			repo,
			&self
				.request(reqwest::Method::GET, &format!("/repos/{repo}/pulls/{number}"), None, None)
				.await?,
		))
	}

	pub async fn list_issues(
		&self,
		repo: &str,
		state: &str,
		limit: i64,
	) -> Result<Vec<IssueSummary>, GitHubError> {
		if !matches!(state, "open" | "closed" | "all") {
			return Err(GitHubError {
				status: 0,
				message: format!("invalid state: {state:?}"),
				retry_after: None,
			});
		}
		let per_page = limit.clamp(1, 100).to_string();
		let data = self
			.request(
				reqwest::Method::GET,
				&format!("/repos/{repo}/issues"),
				None,
				Some(&[
					("state", state.to_owned()),
					("per_page", per_page),
					("sort", "updated".to_owned()),
					("direction", "desc".to_owned()),
				]),
			)
			.await?;
		Ok(data
			.as_array()
			.into_iter()
			.flatten()
			.filter(|v| v.get("pull_request").is_none())
			.map(|v| issue_summary_from_payload(repo, v))
			.collect())
	}

	pub async fn list_comments(
		&self,
		repo: &str,
		number: i64,
	) -> Result<Vec<CommentInfo>, GitHubError> {
		let data = self
			.request(
				reqwest::Method::GET,
				&format!("/repos/{repo}/issues/{number}/comments"),
				None,
				Some(&[("per_page", "100".to_owned())]),
			)
			.await?;
		Ok(data
			.as_array()
			.into_iter()
			.flatten()
			.map(comment_from_payload)
			.collect())
	}

	pub async fn list_review_comments(
		&self,
		repo: &str,
		pr_number: i64,
	) -> Result<Vec<ReviewCommentInfo>, GitHubError> {
		let data = self
			.request(
				reqwest::Method::GET,
				&format!("/repos/{repo}/pulls/{pr_number}/comments"),
				None,
				Some(&[("per_page", "100".to_owned())]),
			)
			.await?;
		Ok(data
			.as_array()
			.into_iter()
			.flatten()
			.map(review_comment_from_payload)
			.collect())
	}

	pub async fn list_pr_reviews(
		&self,
		repo: &str,
		pr_number: i64,
	) -> Result<Vec<PullRequestReviewInfo>, GitHubError> {
		let data = self
			.request(
				reqwest::Method::GET,
				&format!("/repos/{repo}/pulls/{pr_number}/reviews"),
				None,
				Some(&[("per_page", "100".to_owned())]),
			)
			.await?;
		Ok(data
			.as_array()
			.into_iter()
			.flatten()
			.filter_map(pr_review_from_payload)
			.collect())
	}

	pub async fn post_comment(
		&self,
		repo: &str,
		number: i64,
		body: &str,
	) -> Result<CommentInfo, GitHubError> {
		Ok(comment_from_payload(
			&self
				.request(
					reqwest::Method::POST,
					&format!("/repos/{repo}/issues/{number}/comments"),
					Some(&serde_json::json!({"body": body})),
					None,
				)
				.await?,
		))
	}

	pub async fn open_pull_request(
		&self,
		req: OpenPullRequest<'_>,
	) -> Result<PullRequestInfo, GitHubError> {
		let data = self.request(reqwest::Method::POST, &format!("/repos/{}/pulls", req.repo), Some(&serde_json::json!({"title": req.title, "body": req.body, "head": req.head, "base": req.base, "draft": req.draft, "maintainer_can_modify": req.maintainer_can_modify})), None).await?;
		Ok(pr_from_payload(req.repo, &data))
	}

	pub async fn request_reviewers(
		&self,
		repo: &str,
		pr_number: i64,
		reviewers: &[String],
		team_reviewers: &[String],
	) -> Result<(), GitHubError> {
		if reviewers.is_empty() && team_reviewers.is_empty() {
			return Ok(());
		}
		let mut obj = serde_json::Map::new();
		if !reviewers.is_empty() {
			obj.insert("reviewers".to_owned(), serde_json::json!(reviewers));
		}
		if !team_reviewers.is_empty() {
			obj.insert("team_reviewers".to_owned(), serde_json::json!(team_reviewers));
		}
		self
			.request(
				reqwest::Method::POST,
				&format!("/repos/{repo}/pulls/{pr_number}/requested_reviewers"),
				Some(&Value::Object(obj)),
				None,
			)
			.await?;
		Ok(())
	}

	pub async fn add_issue_labels(
		&self,
		repo: &str,
		number: i64,
		labels: &[String],
	) -> Result<Vec<String>, GitHubError> {
		if labels.is_empty() {
			return Ok(Vec::new());
		}
		let data = self
			.request(
				reqwest::Method::POST,
				&format!("/repos/{repo}/issues/{number}/labels"),
				Some(&serde_json::json!({"labels": labels})),
				None,
			)
			.await?;
		Ok(data
			.as_array()
			.into_iter()
			.flatten()
			.map(label_name)
			.collect())
	}

	pub async fn add_assignees(
		&self,
		repo: &str,
		number: i64,
		assignees: &[String],
	) -> Result<(), GitHubError> {
		if assignees.is_empty() {
			return Ok(());
		}
		self
			.request(
				reqwest::Method::POST,
				&format!("/repos/{repo}/issues/{number}/assignees"),
				Some(&serde_json::json!({"assignees": assignees})),
				None,
			)
			.await?;
		Ok(())
	}

	pub async fn list_comment_reactions(
		&self,
		repo: &str,
		comment_id: i64,
	) -> Result<Vec<ReactionInfo>, GitHubError> {
		let data = self
			.request(
				reqwest::Method::GET,
				&format!("/repos/{repo}/issues/comments/{comment_id}/reactions"),
				None,
				Some(&[("content", "-1".to_owned()), ("per_page", "100".to_owned())]),
			)
			.await?;
		Ok(data
			.as_array()
			.into_iter()
			.flatten()
			.map(reaction_from_payload)
			.collect())
	}

	pub async fn close_issue(
		&self,
		repo: &str,
		number: i64,
		reason: &str,
	) -> Result<(), GitHubError> {
		self
			.request(
				reqwest::Method::PATCH,
				&format!("/repos/{repo}/issues/{number}"),
				Some(&serde_json::json!({"state": "closed", "state_reason": reason})),
				None,
			)
			.await?;
		Ok(())
	}

	pub async fn get_authenticated_login(&self) -> Result<String, GitHubError> {
		Ok(str_field(
			&self
				.request(reqwest::Method::GET, "/user", None, None)
				.await?,
			"login",
			"",
		))
	}
}

pub struct OpenPullRequest<'a> {
	pub repo: &'a str,
	pub head: &'a str,
	pub base: &'a str,
	pub title: &'a str,
	pub body: &'a str,
	pub draft: bool,
	pub maintainer_can_modify: bool,
}

fn parse_retry_after(headers: &HeaderMap) -> Option<f64> {
	if let Some(v) = headers
		.get("retry-after")
		.and_then(|v| v.to_str().ok())
		.and_then(|s| s.parse::<f64>().ok())
	{
		return Some(v);
	}
	let reset = headers
		.get("x-ratelimit-reset")?
		.to_str()
		.ok()?
		.parse::<f64>()
		.ok()?;
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.ok()?
		.as_secs_f64();
	Some((reset - now).max(0.0))
}
fn str_field(v: &Value, key: &str, default: &str) -> String {
	v.get(key)
		.and_then(Value::as_str)
		.unwrap_or(default)
		.to_owned()
}
fn label_name(v: &Value) -> String {
	v.get("name")
		.and_then(Value::as_str)
		.map_or_else(|| v.as_str().unwrap_or("").to_owned(), str::to_owned)
}
fn user_login(v: &Value) -> String {
	v.get("user")
		.and_then(|u| u.get("login"))
		.and_then(Value::as_str)
		.unwrap_or("")
		.to_owned()
}
fn repo_from_payload(v: &Value) -> RepoInfo {
	RepoInfo {
		full_name: str_field(v, "full_name", ""),
		default_branch: str_field(v, "default_branch", ""),
		clone_url: str_field(v, "clone_url", ""),
		private: v.get("private").and_then(Value::as_bool).unwrap_or(false),
	}
}
fn issue_from_payload(repo: &str, v: &Value) -> IssueInfo {
	IssueInfo {
		repo: repo.to_owned(),
		number: v.get("number").and_then(Value::as_i64).unwrap_or(0),
		title: str_field(v, "title", ""),
		body: str_field(v, "body", ""),
		state: str_field(v, "state", "open"),
		author: user_login(v),
		labels: v
			.get("labels")
			.and_then(Value::as_array)
			.map_or_else(Vec::new, |a| a.iter().map(label_name).collect()),
		is_pull_request: v.get("pull_request").is_some(),
	}
}
fn pr_from_payload(repo: &str, v: &Value) -> PullRequestInfo {
	let head = v.get("head").unwrap_or(&Value::Null);
	let base = v.get("base").unwrap_or(&Value::Null);
	PullRequestInfo {
		repo: repo.to_owned(),
		number: v.get("number").and_then(Value::as_i64).unwrap_or(0),
		html_url: str_field(v, "html_url", ""),
		head_ref: str_field(head, "ref", ""),
		base_ref: str_field(base, "ref", ""),
		state: str_field(v, "state", "open"),
		author: user_login(v),
		head_repo: head
			.get("repo")
			.map_or_else(String::new, |r| str_field(r, "full_name", "")),
	}
}
fn comment_from_payload(v: &Value) -> CommentInfo {
	CommentInfo {
		id: v.get("id").and_then(Value::as_i64).unwrap_or(0),
		author: user_login(v),
		body: str_field(v, "body", ""),
		created_at: str_field(v, "created_at", ""),
	}
}
fn review_comment_from_payload(v: &Value) -> ReviewCommentInfo {
	ReviewCommentInfo {
		id: v.get("id").and_then(Value::as_i64).unwrap_or(0),
		author: user_login(v),
		body: str_field(v, "body", ""),
		path: str_field(v, "path", ""),
		line: v
			.get("line")
			.and_then(Value::as_i64)
			.or_else(|| v.get("original_line").and_then(Value::as_i64)),
		created_at: str_field(v, "created_at", ""),
	}
}
fn pr_review_from_payload(v: &Value) -> Option<PullRequestReviewInfo> {
	let body = str_field(v, "body", "").trim().to_owned();
	(!body.is_empty()).then(|| PullRequestReviewInfo {
		id: v.get("id").and_then(Value::as_i64).unwrap_or(0),
		author: user_login(v),
		body,
		state: str_field(v, "state", ""),
		submitted_at: str_field(v, "submitted_at", &str_field(v, "created_at", "")),
	})
}
fn issue_summary_from_payload(repo: &str, v: &Value) -> IssueSummary {
	IssueSummary {
		repo: repo.to_owned(),
		number: v.get("number").and_then(Value::as_i64).unwrap_or(0),
		title: str_field(v, "title", ""),
		state: str_field(v, "state", "open"),
		author: user_login(v),
		labels: v
			.get("labels")
			.and_then(Value::as_array)
			.map_or_else(Vec::new, |a| a.iter().map(label_name).collect()),
		comments: v.get("comments").and_then(Value::as_i64).unwrap_or(0),
		updated_at: str_field(v, "updated_at", ""),
		created_at: str_field(v, "created_at", ""),
		html_url: str_field(v, "html_url", ""),
	}
}
fn reaction_from_payload(v: &Value) -> ReactionInfo {
	let user = v.get("user").unwrap_or(&Value::Null);
	ReactionInfo {
		content: str_field(v, "content", ""),
		user_login: str_field(user, "login", ""),
		user_type: str_field(user, "type", ""),
	}
}

pub fn parse_issue_payload(payload: &Value) -> Option<(RepoInfo, IssueInfo)> {
	let repo = repo_from_payload(payload.get("repository")?);
	let issue = issue_from_payload(&repo.full_name, payload.get("issue")?);
	Some((repo, issue))
}

pub trait GitHubBackend {
	fn get_repo<'a>(
		&'a self,
		repo: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<RepoInfo, GitHubError>> + Send + 'a>>;
	fn get_issue<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<IssueInfo, GitHubError>> + Send + 'a>>;
	fn list_closing_pull_requests<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<i64>, GitHubError>> + Send + 'a>>;
	fn get_pull_request<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<PullRequestInfo, GitHubError>> + Send + 'a>>;
	fn list_issues<'a>(
		&'a self,
		repo: &'a str,
		state: &'a str,
		limit: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<IssueSummary>, GitHubError>> + Send + 'a>>;
	fn list_comments<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<CommentInfo>, GitHubError>> + Send + 'a>>;
	fn list_review_comments<'a>(
		&'a self,
		repo: &'a str,
		pr_number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<ReviewCommentInfo>, GitHubError>> + Send + 'a>>;
	fn list_pr_reviews<'a>(
		&'a self,
		repo: &'a str,
		pr_number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<PullRequestReviewInfo>, GitHubError>> + Send + 'a>>;
	fn get_authenticated_login<'a>(
		&'a self,
	) -> Pin<Box<dyn Future<Output = Result<String, GitHubError>> + Send + 'a>>;
	fn post_comment<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		body: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<CommentInfo, GitHubError>> + Send + 'a>>;
	fn open_pull_request<'a>(
		&'a self,
		req: OpenPullRequest<'a>,
	) -> Pin<Box<dyn Future<Output = Result<PullRequestInfo, GitHubError>> + Send + 'a>>;
	fn request_reviewers<'a>(
		&'a self,
		repo: &'a str,
		pr_number: i64,
		reviewers: &'a [String],
		team_reviewers: &'a [String],
	) -> Pin<Box<dyn Future<Output = Result<(), GitHubError>> + Send + 'a>>;
	fn add_issue_labels<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		labels: &'a [String],
	) -> Pin<Box<dyn Future<Output = Result<Vec<String>, GitHubError>> + Send + 'a>>;
	fn add_assignees<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		assignees: &'a [String],
	) -> Pin<Box<dyn Future<Output = Result<(), GitHubError>> + Send + 'a>>;
	fn list_comment_reactions<'a>(
		&'a self,
		repo: &'a str,
		comment_id: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<ReactionInfo>, GitHubError>> + Send + 'a>>;
	fn close_issue<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		reason: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<(), GitHubError>> + Send + 'a>>;
}
impl GitHubBackend for GitHubClient {
	fn get_repo<'a>(
		&'a self,
		repo: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<RepoInfo, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.get_repo(repo).await })
	}
	fn get_issue<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<IssueInfo, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.get_issue(repo, number).await })
	}
	fn list_closing_pull_requests<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<i64>, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.list_closing_pull_requests(repo, number).await })
	}
	fn get_pull_request<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<PullRequestInfo, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.get_pull_request(repo, number).await })
	}
	fn list_issues<'a>(
		&'a self,
		repo: &'a str,
		state: &'a str,
		limit: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<IssueSummary>, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.list_issues(repo, state, limit).await })
	}
	fn list_comments<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<CommentInfo>, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.list_comments(repo, number).await })
	}
	fn list_review_comments<'a>(
		&'a self,
		repo: &'a str,
		pr_number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<ReviewCommentInfo>, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.list_review_comments(repo, pr_number).await })
	}
	fn list_pr_reviews<'a>(
		&'a self,
		repo: &'a str,
		pr_number: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<PullRequestReviewInfo>, GitHubError>> + Send + 'a>>
	{
		Box::pin(async move { self.list_pr_reviews(repo, pr_number).await })
	}
	fn get_authenticated_login<'a>(
		&'a self,
	) -> Pin<Box<dyn Future<Output = Result<String, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.get_authenticated_login().await })
	}
	fn post_comment<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		body: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<CommentInfo, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.post_comment(repo, number, body).await })
	}
	fn open_pull_request<'a>(
		&'a self,
		req: OpenPullRequest<'a>,
	) -> Pin<Box<dyn Future<Output = Result<PullRequestInfo, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.open_pull_request(req).await })
	}
	fn request_reviewers<'a>(
		&'a self,
		repo: &'a str,
		pr_number: i64,
		reviewers: &'a [String],
		team_reviewers: &'a [String],
	) -> Pin<Box<dyn Future<Output = Result<(), GitHubError>> + Send + 'a>> {
		Box::pin(async move {
			self
				.request_reviewers(repo, pr_number, reviewers, team_reviewers)
				.await
		})
	}
	fn add_issue_labels<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		labels: &'a [String],
	) -> Pin<Box<dyn Future<Output = Result<Vec<String>, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.add_issue_labels(repo, number, labels).await })
	}
	fn add_assignees<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		assignees: &'a [String],
	) -> Pin<Box<dyn Future<Output = Result<(), GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.add_assignees(repo, number, assignees).await })
	}
	fn list_comment_reactions<'a>(
		&'a self,
		repo: &'a str,
		comment_id: i64,
	) -> Pin<Box<dyn Future<Output = Result<Vec<ReactionInfo>, GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.list_comment_reactions(repo, comment_id).await })
	}
	fn close_issue<'a>(
		&'a self,
		repo: &'a str,
		number: i64,
		reason: &'a str,
	) -> Pin<Box<dyn Future<Output = Result<(), GitHubError>> + Send + 'a>> {
		Box::pin(async move { self.close_issue(repo, number, reason).await })
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
	Queue,
	Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteDecision {
	pub decision: Decision,
	pub task: Option<String>,
	pub repo: Option<String>,
	pub issue_key: Option<String>,
	pub reason: String,
	pub submitter: Option<String>,
	pub association: Option<String>,
	pub directive: bool,
	pub directive_body: Option<String>,
	pub directive_author: Option<String>,
	pub directive_pragmas: Vec<(String, String)>,
}
impl RouteDecision {
	pub fn should_queue(&self) -> bool {
		self.decision == Decision::Queue
	}
}
fn queue(task: &str, repo: &str, key: String, reason: &str) -> RouteDecision {
	RouteDecision {
		decision: Decision::Queue,
		task: Some(task.to_owned()),
		repo: Some(repo.to_owned()),
		issue_key: Some(key),
		reason: reason.to_owned(),
		submitter: None,
		association: None,
		directive: false,
		directive_body: None,
		directive_author: None,
		directive_pragmas: Vec::new(),
	}
}
fn skip(repo: Option<String>, key: Option<String>, reason: &str) -> RouteDecision {
	RouteDecision {
		decision: Decision::Skip,
		task: None,
		repo,
		issue_key: key,
		reason: reason.to_owned(),
		submitter: None,
		association: None,
		directive: false,
		directive_body: None,
		directive_author: None,
		directive_pragmas: Vec::new(),
	}
}

pub fn verify_signature(secret: &str, body: &[u8], signature_header: Option<&str>) -> bool {
	let Some(sig) = signature_header.and_then(|h| h.strip_prefix("sha256=")) else {
		return false;
	};
	let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
		return false;
	};
	mac.update(body);
	let expected = mac.finalize().into_bytes();
	let Ok(provided) = hex_to_bytes(sig) else {
		return false;
	};
	constant_time_eq(&expected, &provided)
}
fn hex_to_bytes(s: &str) -> Result<Vec<u8>, ()> {
	if !s.len().is_multiple_of(2) {
		return Err(());
	}
	(0..s.len())
		.step_by(2)
		.map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
		.collect()
}
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
	if a.len() != b.len() {
		return false;
	}
	a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn repo_full_name(payload: &Value) -> Option<String> {
	payload
		.get("repository")?
		.get("full_name")?
		.as_str()
		.map(str::to_owned)
}
fn is_bot_account(user: Option<&Value>, bot_login: &str) -> bool {
	let Some(u) = user else {
		return false;
	};
	let login = str_field(u, "login", "");
	!login.is_empty()
		&& (login == bot_login || login.ends_with("[bot]") || str_field(u, "type", "") == "Bot")
}
fn submitter_info(obj: Option<&Value>) -> (Option<String>, Option<String>) {
	let login = obj
		.and_then(|o| o.get("user"))
		.and_then(|u| u.get("login"))
		.and_then(Value::as_str)
		.filter(|s| !s.is_empty())
		.map(str::to_owned);
	let assoc = obj
		.and_then(|o| o.get("author_association"))
		.and_then(Value::as_str)
		.filter(|s| !s.is_empty())
		.map(str::to_owned);
	(login, assoc)
}

pub fn extract_mention(body: Option<&str>, bot_login: &str) -> Option<String> {
	let body = body.filter(|b| !b.is_empty())?;
	let login = bot_login.trim();
	if login.is_empty() {
		return None;
	}
	let pattern =
		Regex::new(&format!(r"(?i)(^|[^A-Za-z0-9_-])@{}([^A-Za-z0-9_-]|$)", regex::escape(login)))
			.ok()?;
	if !pattern.is_match(body) {
		return None;
	}
	let marker = Regex::new(&format!(
		r"(?i)(?P<pre>^|[^A-Za-z0-9_-])@{}(?P<post>[^A-Za-z0-9_-]|$)",
		regex::escape(login)
	))
	.ok()?;
	let stripped = marker.replace_all(body, "$pre$post");
	let spaces = Regex::new(r"[ \t]+").ok()?.replace_all(&stripped, " ");
	let line_spaces = Regex::new(r"\n[ \t]+").ok()?.replace_all(&spaces, "\n");
	Some(line_spaces.trim().to_owned())
}

pub const TRUSTED_ASSOCIATIONS: &[&str] = &["OWNER", "MEMBER", "COLLABORATOR"];
pub fn is_maintainer(
	login: Option<&str>,
	association: Option<&str>,
	maintainers: &HashSet<String>,
) -> bool {
	login.is_some_and(|l| maintainers.contains(&l.to_ascii_lowercase()))
		|| association
			.is_some_and(|a| TRUSTED_ASSOCIATIONS.contains(&a.to_ascii_uppercase().as_str()))
}
pub fn rate_limit_cap(
	login: &str,
	association: Option<&str>,
	unlimited: &HashSet<String>,
	default: i64,
	contributor: i64,
) -> Option<i64> {
	if unlimited.contains(&login.to_ascii_lowercase()) {
		return None;
	}
	match association.map(str::to_ascii_uppercase).as_deref() {
		Some("OWNER" | "MEMBER" | "COLLABORATOR") => None,
		Some("CONTRIBUTOR") => Some(contributor),
		_ => Some(default),
	}
}

pub type PrIssueResolver<'a> = Option<&'a dyn Fn(&str, i64) -> Option<String>>;

pub fn route(
	event_type: &str,
	payload: &Value,
	allowlist: &HashSet<String>,
	bot_login: &str,
	maintainers: &HashSet<String>,
	reviewer_bots: &HashSet<String>,
	resolve_issue_from_pr: PrIssueResolver<'_>,
) -> RouteDecision {
	let repo = repo_full_name(payload);
	let Some(repo_s) = repo.as_deref() else {
		return skip(None, None, "repo not on allowlist");
	};
	if !allowlist.contains(&repo_s.to_ascii_lowercase()) {
		return skip(repo, None, "repo not on allowlist");
	}
	let action = str_field(payload, "action", "");
	let resolve_key = |n: i64| {
		resolve_issue_from_pr
			.and_then(|f| f(repo_s, n))
			.unwrap_or_else(|| issue_key(repo_s, n))
	};
	let reviewer_login = |user: Option<&Value>| -> Option<String> {
		let raw = user
			.map(|u| str_field(u, "login", "").to_ascii_lowercase())
			.unwrap_or_default();
		if raw.is_empty() {
			return None;
		}
		let stripped = raw.strip_suffix("[bot]").unwrap_or(&raw);
		if reviewer_bots.contains(stripped) {
			Some(stripped.to_owned())
		} else if reviewer_bots.contains(&raw) {
			Some(raw)
		} else {
			None
		}
	};
	let directive = |comment: Option<&Value>,
	                 login: Option<&String>,
	                 assoc: Option<&String>|
	 -> (bool, Option<String>, Option<String>, Vec<(String, String)>) {
		let Some(c) = comment else {
			return (false, None, None, Vec::new());
		};
		let body = str_field(c, "body", "");
		if let Some(rb) = reviewer_login(c.get("user")) {
			let (cleaned, pragmas) = parse_pragmas(&body);
			return (true, Some(cleaned), Some(rb), pragmas);
		}
		if !is_maintainer(login.map(String::as_str), assoc.map(String::as_str), maintainers) {
			return (false, None, None, Vec::new());
		}
		let Some(stripped) = extract_mention(Some(&body), bot_login) else {
			return (false, None, None, Vec::new());
		};
		let (cleaned, pragmas) = parse_pragmas(&stripped);
		(true, Some(cleaned), login.cloned(), pragmas)
	};
	match (event_type, action.as_str()) {
		("issues", _) => {
			let issue = payload.get("issue").unwrap_or(&Value::Null);
			if issue.get("pull_request").is_some() {
				return skip(repo, None, "issue is a pull request");
			}
			let Some(number) = issue.get("number").and_then(Value::as_i64) else {
				return skip(repo, None, "issue missing number");
			};
			let key = issue_key(repo_s, number);
			if action == "opened" {
				let (login, assoc) = submitter_info(Some(issue));
				let mut d = queue("triage_issue", repo_s, key, "issues.opened");
				d.submitter = login;
				d.association = assoc;
				d
			} else if action == "closed" {
				queue("cleanup_workspace", repo_s, key, "issues.closed")
			} else {
				skip(repo, Some(key), &format!("issues.{action} ignored"))
			}
		},
		("issue_comment", "created") => {
			let comment = payload.get("comment").unwrap_or(&Value::Null);
			if reviewer_login(comment.get("user")).is_none()
				&& is_bot_account(comment.get("user"), bot_login)
			{
				return skip(repo, None, "bot/self comment");
			}
			let issue = payload.get("issue").unwrap_or(&Value::Null);
			let Some(number) = issue.get("number").and_then(Value::as_i64) else {
				return skip(repo, None, "comment missing issue number");
			};
			let (login, assoc) = submitter_info(Some(comment));
			let (dir, body, author, pragmas) =
				directive(Some(comment), login.as_ref(), assoc.as_ref());
			let mut d = if issue.get("pull_request").is_some() {
				queue(
					"handle_pr_conversation",
					repo_s,
					resolve_key(number),
					&format!("issue_comment.created on PR #{number}"),
				)
			} else {
				queue("handle_comment", repo_s, issue_key(repo_s, number), "issue_comment.created")
			};
			d.submitter = login;
			d.association = assoc;
			d.directive = dir;
			d.directive_body = body;
			d.directive_author = author;
			d.directive_pragmas = pragmas;
			d
		},
		("pull_request_review_comment", "created") => {
			let comment = payload.get("comment").unwrap_or(&Value::Null);
			if reviewer_login(comment.get("user")).is_none()
				&& is_bot_account(comment.get("user"), bot_login)
			{
				return skip(repo, None, "bot/self review comment");
			}
			let pr = payload.get("pull_request").unwrap_or(&Value::Null);
			if pr
				.get("user")
				.map(|u| str_field(u, "login", ""))
				.unwrap_or_default()
				!= bot_login
			{
				return skip(repo, None, "PR not authored by bot");
			}
			let Some(number) = pr.get("number").and_then(Value::as_i64) else {
				return skip(repo, None, "PR missing number");
			};
			let (login, assoc) = submitter_info(Some(comment));
			let (dir, body, author, pragmas) =
				directive(Some(comment), login.as_ref(), assoc.as_ref());
			let mut d = queue(
				"handle_review",
				repo_s,
				resolve_key(number),
				"pull_request_review_comment.created",
			);
			d.submitter = login;
			d.association = assoc;
			d.directive = dir;
			d.directive_body = body;
			d.directive_author = author;
			d.directive_pragmas = pragmas;
			d
		},
		("pull_request", "closed") => {
			let pr = payload.get("pull_request").unwrap_or(&Value::Null);
			if pr
				.get("user")
				.map(|u| str_field(u, "login", ""))
				.unwrap_or_default()
				!= bot_login
			{
				return skip(repo, None, "PR not bot-authored");
			}
			if !pr.get("merged").and_then(Value::as_bool).unwrap_or(false) {
				return skip(repo, None, "PR closed without merge");
			}
			let Some(number) = pr.get("number").and_then(Value::as_i64) else {
				return skip(repo, None, "PR missing number");
			};
			queue("cleanup_workspace", repo_s, resolve_key(number), "pull_request.merged")
		},
		_ => skip(repo, None, &format!("{event_type}.{action} not handled")),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	fn hs(values: &[&str]) -> HashSet<String> {
		values.iter().map(|s| (*s).to_owned()).collect()
	}
	fn allow() -> HashSet<String> {
		hs(&["octo/widget"])
	}
	fn bot() -> &'static str {
		"robogjc-bot"
	}
	fn base_payload(event: &str, obj: Value) -> Value {
		let mut v = serde_json::json!({"action": event, "repository": {"full_name": "octo/widget"}});
		if let Some(map) = v.as_object_mut() {
			map.extend(obj.as_object().unwrap().clone());
		}
		v
	}

	#[test]
	fn github_verify_signature() {
		let body = br#"{"x":1}"#;
		let mut mac = Hmac::<Sha256>::new_from_slice(b"shh").unwrap();
		mac.update(body);
		let sig = mac
			.finalize()
			.into_bytes()
			.iter()
			.map(|b| format!("{b:02x}"))
			.collect::<String>();
		assert!(verify_signature("shh", body, Some(&format!("sha256={sig}"))));
		assert!(!verify_signature("wrong", body, Some(&format!("sha256={sig}"))));
		assert!(!verify_signature("shh", body, None));
	}
	#[test]
	fn github_issue_opened_and_allowlist() {
		let payload: Value =
			serde_json::from_str(include_str!("../tests/fixtures/phase3/issues-opened.json")).unwrap();
		let d = route("issues", &payload, &allow(), bot(), &hs(&[]), &hs(&[]), None);
		assert!(d.should_queue());
		assert_eq!(d.task.as_deref(), Some("triage_issue"));
		assert_eq!(d.issue_key.as_deref(), Some("octo/widget#4"));
		assert_eq!(d.submitter.as_deref(), Some("alice"));
		assert_eq!(d.association.as_deref(), Some("FIRST_TIME_CONTRIBUTOR"));
		assert!(!route("issues", &serde_json::json!({"action":"opened","issue":{"number":1},"repository":{"full_name":"other/repo"}}), &allow(), bot(), &hs(&[]), &hs(&[]), None).should_queue());
	}
	#[test]
	fn github_comments_and_bots() {
		assert!(!route("issue_comment", &base_payload("created", serde_json::json!({"comment":{"user":{"login":"github-actions[bot]","type":"Bot"},"body":"ci"},"issue":{"number":4}})), &allow(), bot(), &hs(&[]), &hs(&[]), None).should_queue());
		let d = route(
			"issue_comment",
			&base_payload(
				"created",
				serde_json::json!({"comment":{"user":{"login":"alice"},"body":"hi"},"issue":{"number":4}}),
			),
			&allow(),
			bot(),
			&hs(&[]),
			&hs(&[]),
			None,
		);
		assert_eq!(d.task.as_deref(), Some("handle_comment"));
	}
	#[test]
	fn github_pr_routes_use_resolver_and_fallback() {
		let resolver = |_: &str, _: i64| Some("octo/widget#42".to_owned());
		let d = route(
			"issue_comment",
			&base_payload(
				"created",
				serde_json::json!({"comment":{"user":{"login":"alice"},"body":"ok"},"issue":{"number":9,"pull_request":{"url":"x"}}}),
			),
			&allow(),
			bot(),
			&hs(&[]),
			&hs(&[]),
			Some(&resolver),
		);
		assert_eq!(d.task.as_deref(), Some("handle_pr_conversation"));
		assert_eq!(d.issue_key.as_deref(), Some("octo/widget#42"));
		let miss = |_: &str, _: i64| None;
		let d = route(
			"pull_request_review_comment",
			&base_payload(
				"created",
				serde_json::json!({"comment":{"user":{"login":"alice"},"body":"nit"},"pull_request":{"number":9,"user":{"login":bot()}}}),
			),
			&allow(),
			bot(),
			&hs(&[]),
			&hs(&[]),
			Some(&miss),
		);
		assert_eq!(d.task.as_deref(), Some("handle_review"));
		assert_eq!(d.issue_key.as_deref(), Some("octo/widget#9"));
	}
	#[test]
	fn github_merged_bot_pr_cleanup_only() {
		let payload = base_payload(
			"closed",
			serde_json::json!({"pull_request":{"number":9,"user":{"login":bot()},"merged":true}}),
		);
		let d = route("pull_request", &payload, &allow(), bot(), &hs(&[]), &hs(&[]), None);
		assert_eq!(d.task.as_deref(), Some("cleanup_workspace"));
		assert!(d.submitter.is_none());
		assert!(
			!route(
				"pull_request",
				&base_payload(
					"closed",
					serde_json::json!({"pull_request":{"number":9,"user":{"login":bot()},"merged":false}})
				),
				&allow(),
				bot(),
				&hs(&[]),
				&hs(&[]),
				None
			)
			.should_queue()
		);
	}
	#[test]
	fn github_rate_limit_caps() {
		assert_eq!(rate_limit_cap("Can1357", Some("NONE"), &hs(&["can1357"]), 3, 10), None);
		assert_eq!(rate_limit_cap("alice", Some("CONTRIBUTOR"), &hs(&[]), 3, 10), Some(10));
		assert_eq!(rate_limit_cap("alice", Some("FIRST_TIMER"), &hs(&[]), 3, 10), Some(3));
		assert_eq!(rate_limit_cap("x", Some("OWNER"), &hs(&[]), 3, 10), None);
	}
	#[test]
	fn github_mentions_and_directives() {
		assert_eq!(
			extract_mention(Some("hey @robogjc-bot please look"), bot()).as_deref(),
			Some("hey please look")
		);
		assert_eq!(extract_mention(Some("@robogjc-bot-helper hi"), bot()), None);
		let payload: Value = serde_json::from_str(include_str!(
			"../tests/fixtures/phase3/issue-comment-directive.json"
		))
		.unwrap();
		let d = route("issue_comment", &payload, &allow(), bot(), &hs(&[]), &hs(&[]), None);
		assert!(d.directive);
		assert_eq!(d.directive_body.as_deref(), Some("refactor X"));
		assert_eq!(
			d.directive_pragmas,
			vec![("model".to_owned(), "gpt".to_owned()), ("thinking".to_owned(), "low".to_owned())]
		);
	}
	#[test]
	fn github_reviewer_bot_directive() {
		let payload: Value = serde_json::from_str(include_str!(
			"../tests/fixtures/phase3/reviewer-bot-pr-comment.json"
		))
		.unwrap();
		let d = route(
			"issue_comment",
			&payload,
			&allow(),
			bot(),
			&hs(&[]),
			&hs(&["chatgpt-codex-connector"]),
			None,
		);
		assert!(d.should_queue());
		assert!(d.directive);
		assert_eq!(d.directive_author.as_deref(), Some("chatgpt-codex-connector"));
		assert_eq!(d.directive_body.as_deref(), Some("Leak in foo()"));
	}
}
