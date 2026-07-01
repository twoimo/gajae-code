//! GitHub `ForgeAdapter` implementation.
//!
//! All GitHub-specific request construction and response parsing lives here
//! (the provider boundary). To keep it verifiable without a live API, the HTTP
//! send is abstracted behind [`HttpTransport`]: this module builds requests +
//! parses/maps responses, and a fake transport exercises every path in tests.
//! The concrete `reqwest` transport is a thin adapter added in a live slice.

use serde_json::Value;

use crate::forge_adapter::{ForgeAdapter, ForgeError, ForgePr, MergeRequest, MergeSignals, PolledItem};
use crate::keys::ItemKind;

/// Head-branch prefix the daemon instructs the engine to use, so its PR is
/// discoverable via `find_work_pr`.
pub const DAEMON_BRANCH_PREFIX: &str = "git-daemon/";
/// Conservative changed-line ceiling for autonomous merge (diff budget).
const DIFF_LINE_BUDGET: u64 = 5000;

/// A minimal HTTP request the transport must perform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
	pub method: &'static str,
	pub url: String,
	pub headers: Vec<(String, String)>,
	pub body: Option<String>,
}

/// A minimal HTTP response.
#[derive(Debug, Clone)]
pub struct HttpResponse {
	pub status: u16,
	pub body: String,
}

/// Pluggable HTTP send. The live impl wraps `reqwest`; tests use a fake.
#[allow(async_fn_in_trait, reason = "internal transport seam with in-crate impls")]
pub trait HttpTransport {
	async fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError>;
}

/// GitHub adapter over a pluggable transport. `pr_id`/`item_id` are PR/issue
/// numbers (GitHub REST addresses by number).
pub struct GithubForge<T: HttpTransport> {
	transport: T,
	token: String,
	api_base: String,
	repo_full_name: String,
}

impl<T: HttpTransport> GithubForge<T> {
	#[must_use]
	pub fn new(transport: T, token: impl Into<String>, repo_full_name: impl Into<String>) -> Self {
		Self {
			transport,
			token: token.into(),
			api_base: "https://api.github.com".to_owned(),
			repo_full_name: repo_full_name.into(),
		}
	}

	/// Override the API base (e.g. GitHub Enterprise or a test server).
	#[must_use]
	pub fn with_api_base(mut self, base: impl Into<String>) -> Self {
		self.api_base = base.into();
		self
	}

	fn headers(&self) -> Vec<(String, String)> {
		vec![
			("Authorization".to_owned(), format!("Bearer {}", self.token)),
			("Accept".to_owned(), "application/vnd.github+json".to_owned()),
			("X-GitHub-Api-Version".to_owned(), "2022-11-28".to_owned()),
			("User-Agent".to_owned(), "gjc-git-daemon".to_owned()),
		]
	}

	fn pr_url(&self, number: &str) -> String {
		format!("{}/repos/{}/pulls/{number}", self.api_base, self.repo_full_name)
	}

	/// GET a URL and parse a JSON body, mapping a non-200 status to a typed error.
	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn get_json(&self, url: &str) -> Result<Value, ForgeError> {
		let req = HttpRequest { method: "GET", url: url.to_owned(), headers: self.headers(), body: None };
		let resp = self.transport.send(req).await?;
		if resp.status != 200 {
			return Err(map_status(resp.status));
		}
		serde_json::from_str(&resp.body).map_err(|e| ForgeError::Transient(format!("bad json: {e}")))
	}
}

/// Map an HTTP status to a typed forge error (fail-closed).
fn map_status(status: u16) -> ForgeError {
	match status {
		404 => ForgeError::NotFound,
		409 | 422 => ForgeError::ShaMismatch,
		405 => ForgeError::ProtectedBranch,
		401 => ForgeError::Auth,
		403 | 429 => ForgeError::RateLimited,
		other => ForgeError::Transient(format!("http {other}")),
	}
}

/// Parse a GitHub PR JSON object into a canonical [`ForgePr`].
fn parse_pr(body: &str) -> Result<ForgePr, ForgeError> {
	let v: Value = serde_json::from_str(body).map_err(|e| ForgeError::Transient(format!("bad json: {e}")))?;
	let id = v.get("node_id").and_then(Value::as_str).ok_or(ForgeError::NotFound)?.to_owned();
	let number = v.get("number").and_then(Value::as_u64).ok_or(ForgeError::NotFound)?;
	let head_sha = v
		.pointer("/head/sha")
		.and_then(Value::as_str)
		.ok_or_else(|| ForgeError::Transient("missing head.sha".to_owned()))?
		.to_owned();
	let base_branch = v
		.pointer("/base/ref")
		.and_then(Value::as_str)
		.ok_or_else(|| ForgeError::Transient("missing base.ref".to_owned()))?
		.to_owned();
	Ok(ForgePr { id, number, head_sha, base_branch })
}

/// Parse a GitHub issues-list JSON array into [`PolledItem`]s. Entries that
/// carry a `pull_request` key are PRs surfaced by the issues endpoint and are
/// skipped (issues only).
fn parse_open_issues(body: &str) -> Result<Vec<PolledItem>, ForgeError> {
	let v: Value = serde_json::from_str(body).map_err(|e| ForgeError::Transient(format!("bad json: {e}")))?;
	let arr = v.as_array().ok_or_else(|| ForgeError::Transient("issues body is not an array".to_owned()))?;
	let mut out = Vec::new();
	for item in arr {
		if item.get("pull_request").is_some() {
			continue;
		}
		let (Some(node_id), Some(updated_at), Some(state)) = (
			item.get("node_id").and_then(Value::as_str),
			item.get("updated_at").and_then(Value::as_str),
			item.get("state").and_then(Value::as_str),
		) else {
			continue;
		};
		out.push(PolledItem {
			node_id: node_id.to_owned(),
			item_kind: ItemKind::Issue,
			updated_at: updated_at.to_owned(),
			state: state.to_owned(),
		});
	}
	Ok(out)
}

impl<T: HttpTransport> ForgeAdapter for GithubForge<T> {
	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn get_pr(&self, pr_id: &str) -> Result<ForgePr, ForgeError> {
		let req = HttpRequest {
			method: "GET",
			url: self.pr_url(pr_id),
			headers: self.headers(),
			body: None,
		};
		let resp = self.transport.send(req).await?;
		if resp.status == 200 {
			parse_pr(&resp.body)
		} else {
			Err(map_status(resp.status))
		}
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn list_open_issues(&self) -> Result<Vec<PolledItem>, ForgeError> {
		let req = HttpRequest {
			method: "GET",
			url: format!("{}/repos/{}/issues?state=open&per_page=100", self.api_base, self.repo_full_name),
			headers: self.headers(),
			body: None,
		};
		let resp = self.transport.send(req).await?;
		if resp.status == 200 {
			parse_open_issues(&resp.body)
		} else {
			Err(map_status(resp.status))
		}
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn find_work_branch(&self, _base_branch: &str) -> Result<Option<String>, ForgeError> {
		// Server-side prefix match (repos with many branches won't fit one page):
		// GET /git/matching-refs/heads/git-daemon returns refs under the prefix.
		let prefix = DAEMON_BRANCH_PREFIX.trim_end_matches('/');
		let v = self
			.get_json(&format!("{}/repos/{}/git/matching-refs/heads/{prefix}/", self.api_base, self.repo_full_name))
			.await?;
		let arr = v.as_array().ok_or_else(|| ForgeError::Transient("matching-refs body not array".to_owned()))?;
		for r in arr {
			if let Some(name) = r.get("ref").and_then(Value::as_str).and_then(|s| s.strip_prefix("refs/heads/")) {
				return Ok(Some(name.to_owned()));
			}
		}
		Ok(None)
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn create_pr(&self, head_branch: &str, base_branch: &str, title: &str, body: &str) -> Result<ForgePr, ForgeError> {
		let payload = serde_json::json!({ "title": title, "head": head_branch, "base": base_branch, "body": body }).to_string();
		let http = HttpRequest {
			method: "POST",
			url: format!("{}/repos/{}/pulls", self.api_base, self.repo_full_name),
			headers: self.headers(),
			body: Some(payload),
		};
		let resp = self.transport.send(http).await?;
		if resp.status == 201 || resp.status == 200 {
			parse_pr(&resp.body)
		} else {
			Err(map_status(resp.status))
		}
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn find_work_pr(&self, _work_key: &str) -> Result<Option<ForgePr>, ForgeError> {
		// List open PRs and pick the one on the daemon's head-branch convention.
		let req = HttpRequest {
			method: "GET",
			url: format!("{}/repos/{}/pulls?state=open&per_page=100", self.api_base, self.repo_full_name),
			headers: self.headers(),
			body: None,
		};
		let resp = self.transport.send(req).await?;
		if resp.status != 200 {
			return Err(map_status(resp.status));
		}
		let v: Value = serde_json::from_str(&resp.body).map_err(|e| ForgeError::Transient(format!("bad json: {e}")))?;
		let arr = v.as_array().ok_or_else(|| ForgeError::Transient("pulls body not array".to_owned()))?;
		for pr in arr {
			let head_ref = pr.pointer("/head/ref").and_then(Value::as_str).unwrap_or_default();
			if head_ref.starts_with(DAEMON_BRANCH_PREFIX) {
				return Ok(Some(ForgePr {
					id: pr.get("node_id").and_then(Value::as_str).unwrap_or_default().to_owned(),
					number: pr.get("number").and_then(Value::as_u64).unwrap_or(0),
					head_sha: pr.pointer("/head/sha").and_then(Value::as_str).unwrap_or_default().to_owned(),
					base_branch: pr.pointer("/base/ref").and_then(Value::as_str).unwrap_or_default().to_owned(),
				}));
			}
		}
		Ok(None)
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn fetch_merge_signals(&self, pr_id: &str, head_sha: &str) -> Result<MergeSignals, ForgeError> {
		// CI: check-runs for the head SHA are all non-failing.
		let checks = self.get_json(&format!("{}/repos/{}/commits/{head_sha}/check-runs", self.api_base, self.repo_full_name)).await?;
		let ci_green = checks
			.pointer("/check_runs")
			.and_then(Value::as_array)
			.is_none_or(|runs| runs.iter().all(|r| {
				matches!(
					r.get("conclusion").and_then(Value::as_str),
					None | Some("success" | "neutral" | "skipped")
				)
			}));
		// Reviews: no outstanding CHANGES_REQUESTED.
		let reviews = self.get_json(&format!("{}/repos/{}/pulls/{pr_id}/reviews", self.api_base, self.repo_full_name)).await?;
		let reviews_resolved = reviews
			.as_array()
			.is_none_or(|rs| rs.iter().all(|r| r.get("state").and_then(Value::as_str) != Some("CHANGES_REQUESTED")));
		// Diff budget: total changed lines under a conservative ceiling.
		let pr = self.get_json(&format!("{}/repos/{}/pulls/{pr_id}", self.api_base, self.repo_full_name)).await?;
		let changed = pr.get("additions").and_then(Value::as_u64).unwrap_or(0)
			+ pr.get("deletions").and_then(Value::as_u64).unwrap_or(0);
		let diff_within_budget = changed <= DIFF_LINE_BUDGET;
		// Scope: no changed file under an out-of-scope/infra/secret path.
		let files = self.get_json(&format!("{}/repos/{}/pulls/{pr_id}/files?per_page=100", self.api_base, self.repo_full_name)).await?;
		let diff_in_scope = files.as_array().is_none_or(|fs| {
			fs.iter().all(|f| {
				let p = f.get("filename").and_then(Value::as_str).unwrap_or_default();
				!(p.starts_with(".github/") || p.contains(".env") || p.contains("secret"))
			})
		});
		Ok(MergeSignals { ci_green, reviews_resolved, diff_within_budget, diff_in_scope })
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn get_branch_protection(&self, base_branch: &str) -> Result<bool, ForgeError> {
		// GET .../branches/{branch}/protection: 200 => protected, 404 => not
		// protected (both are a successful read); any other status is an
		// unverifiable protection state and surfaces as an error (fail closed).
		let req = HttpRequest {
			method: "GET",
			url: format!("{}/repos/{}/branches/{base_branch}/protection", self.api_base, self.repo_full_name),
			headers: self.headers(),
			body: None,
		};
		let resp = self.transport.send(req).await?;
		match resp.status {
			200 => Ok(true),
			404 => Ok(false),
			other => Err(map_status(other)),
		}
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn merge_pr(&self, req: &MergeRequest) -> Result<String, ForgeError> {
		// GitHub enforces the expected head SHA server-side: a moved head returns
		// 409, which we map to ShaMismatch (fail closed).
		let body = serde_json::json!({ "sha": req.expected_head_sha, "merge_method": "squash" }).to_string();
		let http = HttpRequest {
			method: "PUT",
			url: format!("{}/merge", self.pr_url(&req.pr_id)),
			headers: self.headers(),
			body: Some(body),
		};
		let resp = self.transport.send(http).await?;
		if resp.status == 200 {
			let v: Value =
				serde_json::from_str(&resp.body).map_err(|e| ForgeError::Transient(format!("bad json: {e}")))?;
			v.get("sha")
				.and_then(Value::as_str)
				.map(ToOwned::to_owned)
				.ok_or_else(|| ForgeError::Transient("merge response missing sha".to_owned()))
		} else {
			Err(map_status(resp.status))
		}
	}

	#[allow(clippy::future_not_send, reason = "driven per-item; no cross-thread Send boundary yet")]
	async fn post_comment(&self, item_id: &str, body: &str) -> Result<(), ForgeError> {
		let payload = serde_json::json!({ "body": body }).to_string();
		let http = HttpRequest {
			method: "POST",
			url: format!("{}/repos/{}/issues/{item_id}/comments", self.api_base, self.repo_full_name),
			headers: self.headers(),
			body: Some(payload),
		};
		let resp = self.transport.send(http).await?;
		if resp.status == 201 || resp.status == 200 {
			Ok(())
		} else {
			Err(map_status(resp.status))
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::Mutex;

	/// Records the last request and returns a scripted response.
	struct FakeHttp {
		response: HttpResponse,
		last: Mutex<Option<HttpRequest>>,
	}

	impl FakeHttp {
		fn new(status: u16, body: &str) -> Self {
			Self { response: HttpResponse { status, body: body.to_owned() }, last: Mutex::new(None) }
		}
	}

	impl HttpTransport for FakeHttp {
		async fn send(&self, req: HttpRequest) -> Result<HttpResponse, ForgeError> {
			*self.last.lock().unwrap() = Some(req);
			Ok(self.response.clone())
		}
	}

	fn forge(status: u16, body: &str) -> GithubForge<FakeHttp> {
		GithubForge::new(FakeHttp::new(status, body), "tok", "acme/widget")
	}

	#[tokio::test]
	async fn get_pr_builds_request_and_parses_response() {
		let json = r#"{"node_id":"PR_7","number":7,"head":{"sha":"abc"},"base":{"ref":"dev"}}"#;
		let f = forge(200, json);
		let pr = f.get_pr("7").await.unwrap();
		assert_eq!(pr, ForgePr { id: "PR_7".into(), number: 7, head_sha: "abc".into(), base_branch: "dev".into() });
		let last = f.transport.last.lock().unwrap().clone().unwrap();
		assert_eq!(last.method, "GET");
		assert_eq!(last.url, "https://api.github.com/repos/acme/widget/pulls/7");
		assert!(last.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer tok"));
	}

	#[tokio::test]
	async fn merge_sends_expected_sha_and_returns_merge_sha() {
		let f = forge(200, r#"{"sha":"merge-abc","merged":true}"#);
		let out = f.merge_pr(&MergeRequest { pr_id: "7".into(), expected_head_sha: "abc".into() }).await;
		assert_eq!(out, Ok("merge-abc".into()));
		let last = f.transport.last.lock().unwrap().clone().unwrap();
		assert_eq!(last.method, "PUT");
		assert!(last.url.ends_with("/pulls/7/merge"));
		assert!(last.body.unwrap().contains("\"sha\":\"abc\""));
	}

	#[tokio::test]
	async fn merge_conflict_maps_to_sha_mismatch() {
		let f = forge(409, r#"{"message":"Head branch was modified"}"#);
		let out = f.merge_pr(&MergeRequest { pr_id: "7".into(), expected_head_sha: "abc".into() }).await;
		assert_eq!(out, Err(ForgeError::ShaMismatch));
	}

	#[tokio::test]
	async fn status_codes_map_to_typed_errors() {
		assert_eq!(forge(404, "").get_pr("7").await, Err(ForgeError::NotFound));
		assert_eq!(forge(405, "").get_pr("7").await, Err(ForgeError::ProtectedBranch));
		assert_eq!(forge(401, "").get_pr("7").await, Err(ForgeError::Auth));
		assert_eq!(forge(403, "").get_pr("7").await, Err(ForgeError::RateLimited));
		assert!(matches!(forge(500, "").get_pr("7").await, Err(ForgeError::Transient(_))));
	}

	#[tokio::test]
	async fn post_comment_targets_issue_comments_endpoint() {
		let f = forge(201, "{}");
		f.post_comment("42", "hello").await.unwrap();
		let last = f.transport.last.lock().unwrap().clone().unwrap();
		assert_eq!(last.method, "POST");
		assert!(last.url.ends_with("/repos/acme/widget/issues/42/comments"));
		assert!(last.body.unwrap().contains("hello"));
	}

	#[tokio::test]
	async fn list_open_issues_parses_and_skips_prs() {
		// The issues endpoint returns issues + PRs; PR entries carry a
		// pull_request key and must be skipped.
		let body = r#"[
			{"node_id":"I_1","updated_at":"2026-01-01T00:00:00Z","state":"open"},
			{"node_id":"PR_9","updated_at":"2026-01-02T00:00:00Z","state":"open","pull_request":{"url":"x"}},
			{"node_id":"I_2","updated_at":"2026-01-03T00:00:00Z","state":"open"}
		]"#;
		let f = forge(200, body);
		let items = f.list_open_issues().await.unwrap();
		assert_eq!(items.len(), 2, "PR entry skipped");
		assert_eq!(items[0].node_id, "I_1");
		assert_eq!(items[1].node_id, "I_2");
		assert!(items.iter().all(|i| i.item_kind == crate::keys::ItemKind::Issue));
		let last = f.transport.last.lock().unwrap().clone().unwrap();
		assert_eq!(last.method, "GET");
		assert!(last.url.contains("/repos/acme/widget/issues?state=open"));
	}

	#[tokio::test]
	async fn list_open_issues_maps_error_status() {
		assert_eq!(forge(401, "").list_open_issues().await.err(), Some(ForgeError::Auth));
	}

	#[tokio::test]
	async fn find_work_branch_matches_daemon_prefix() {
		let body = r#"[{"ref":"refs/heads/git-daemon/fix-telegram","object":{"sha":"abc"}}]"#;
		let f = forge(200, body);
		let br = f.find_work_branch("dev").await.unwrap();
		assert_eq!(br, Some("git-daemon/fix-telegram".to_owned()));
		let last = f.transport.last.lock().unwrap().clone().unwrap();
		assert!(last.url.contains("/repos/acme/widget/git/matching-refs/heads/git-daemon/"));
	}

	#[tokio::test]
	async fn find_work_branch_none_when_no_daemon_branch() {
		let f = forge(200, "[]");
		assert_eq!(f.find_work_branch("dev").await.unwrap(), None);
	}

	#[tokio::test]
	async fn create_pr_posts_and_parses() {
		let f = forge(201, r#"{"node_id":"PR_9","number":9,"head":{"sha":"abc"},"base":{"ref":"dev"}}"#);
		let pr = f.create_pr("git-daemon/fix", "dev", "t", "b").await.unwrap();
		assert_eq!(pr, ForgePr { id: "PR_9".into(), number: 9, head_sha: "abc".into(), base_branch: "dev".into() });
		let last = f.transport.last.lock().unwrap().clone().unwrap();
		assert_eq!(last.method, "POST");
		assert!(last.url.ends_with("/repos/acme/widget/pulls"));
		let body = last.body.unwrap();
		assert!(body.contains("\"head\":\"git-daemon/fix\"") && body.contains("\"base\":\"dev\""));
	}
}
