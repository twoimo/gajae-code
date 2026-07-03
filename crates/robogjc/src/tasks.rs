//! Task entry helpers shared by the queue dispatcher.

use serde_json::Value;

use crate::{
	config::Settings,
	db::{Database, DbResult, IssueRow},
	github::{GitHubClient, GitHubError, PullRequestInfo},
	sandbox::SandboxManager,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadMessage {
	pub kind:       String,
	pub author:     String,
	pub body:       String,
	pub created_at: String,
	pub path:       Option<String>,
	pub line:       Option<i64>,
	pub state:      Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectiveInfo {
	pub body:    String,
	pub author:  String,
	pub pragmas: Vec<(String, String)>,
	pub thread:  Vec<ThreadMessage>,
}

pub fn directive_from_payload(payload: &Value) -> Option<DirectiveInfo> {
	let raw = payload.get("_robogjc_directive")?.as_object()?;
	let body = raw.get("body")?.as_str()?.trim();
	let author = raw.get("author")?.as_str()?.trim();
	if body.is_empty() || author.is_empty() {
		return None;
	}
	let mut pragmas = Vec::new();
	if let Some(entries) = raw.get("pragmas").and_then(Value::as_array) {
		for entry in entries {
			let Some(pair) = entry.as_array() else {
				continue;
			};
			if pair.len() != 2 {
				continue;
			}
			let (Some(k), Some(v)) = (pair[0].as_str(), pair[1].as_str()) else {
				continue;
			};
			pragmas.push((k.to_owned(), v.to_owned()));
		}
	}
	Some(DirectiveInfo {
		body: body.to_owned(),
		author: author.to_owned(),
		pragmas,
		thread: Vec::new(),
	})
}

pub fn can_handle_pr_directly(settings: &Settings, repo_full: &str, pr: &PullRequestInfo) -> bool {
	!pr.head_ref.is_empty()
		&& pr.author.eq_ignore_ascii_case(&settings.bot_login)
		&& pr.head_repo.eq_ignore_ascii_case(repo_full)
}

pub async fn resolve_issue_row_for_pr(
	db: &Database,
	github: &GitHubClient,
	repo_full: &str,
	pr_number: i64,
) -> Result<(Option<IssueRow>, Option<PullRequestInfo>), GitHubError> {
	let issue_row = db.find_issue_by_pr(repo_full, pr_number).map_err(db_err)?;
	if issue_row.as_ref().is_some_and(|r| r.branch.is_some()) {
		return Ok((issue_row, None));
	}
	let pr = github.get_pull_request(repo_full, pr_number).await?;
	let mut repaired = issue_row;
	if repaired.is_none() && !pr.head_ref.is_empty() {
		repaired = db
			.find_issue_by_branch(repo_full, &pr.head_ref)
			.map_err(db_err)?;
		if let Some(row) = &repaired {
			db.set_issue_pr(&row.key, pr_number).map_err(db_err)?;
			repaired = db.get_issue(&row.key).map_err(db_err)?;
		}
	} else if let Some(row) = &repaired
		&& row.branch.is_none()
		&& !pr.head_ref.is_empty()
	{
		db.set_issue_branch(&row.key, &pr.head_ref)
			.map_err(db_err)?;
		repaired = db.get_issue(&row.key).map_err(db_err)?;
	}
	Ok((repaired, Some(pr)))
}

fn db_err(e: rusqlite::Error) -> GitHubError {
	GitHubError { status: 0, message: e.to_string(), retry_after: None }
}

pub fn cleanup_workspace(
	db: &Database,
	sandbox: &SandboxManager,
	issue_key: &str,
	target_state: &str,
) -> DbResult<()> {
	if let Some(issue) = db.get_issue(issue_key)? {
		sandbox.remove_workspace(&issue.repo, issue.number as u64);
	}
	db.set_issue_state(issue_key, target_state)
}

#[cfg(test)]
mod tasks_tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn tasks_directive_from_payload_parses_pragmas() {
		let d = directive_from_payload(&json!({"_robogjc_directive":{"body":"do it","author":"can1357","pragmas":[["model","gpt"],["thinking","low"]]}})).unwrap();
		assert_eq!(d.body, "do it");
		assert_eq!(d.author, "can1357");
		assert_eq!(d.pragmas, vec![
			("model".into(), "gpt".into()),
			("thinking".into(), "low".into())
		]);
	}

	#[test]
	fn tasks_directive_from_payload_drops_malformed_entries() {
		let d = directive_from_payload(&json!({"_robogjc_directive":{"body":"x","author":"a","pragmas":[["model","gpt"],["bad"],[1,"v"],"x"]}})).unwrap();
		assert_eq!(d.pragmas, vec![("model".into(), "gpt".into())]);
		assert!(directive_from_payload(&json!({})).is_none());
	}

	#[test]
	fn tasks_pr_mapping_direct_handle_requires_bot_same_repo_branch() {
		let settings = Settings {
			github_token: None,
			github_webhook_secret: crate::config::SecretString::new("x"),
			bot_login: "robogjc-bot".into(),
			git_author_name: None,
			git_author_email: "bot@example.invalid".into(),
			repo_allowlist_raw: "octo/widget".into(),
			gh_proxy_url: None,
			gh_proxy_hmac_key: None,
			gh_proxy_bind_host: "127.0.0.1".into(),
			gh_proxy_bind_port: 8081,
			gh_proxy_max_body_bytes: 1024,
			gh_proxy_git_timeout_seconds: 60.0,
			model: "m".into(),
			provider: None,
			thinking_level: "low".into(),
			max_concurrency: 1,
			task_timeout_seconds: 1.0,
			task_timeout_hard_grace_seconds: 1.0,
			request_timeout_seconds: 1.0,
			task_completion_max_reminders: 1,
			gjc_command: "gjc".into(),
			shutdown_drain_timeout_seconds: 1.0,
			shutdown_kill_timeout_seconds: 1.0,
			workspace_root: std::path::PathBuf::from("/tmp"),
			sqlite_path: std::path::PathBuf::from("/tmp/x.sqlite"),
			log_dir: std::path::PathBuf::from("/tmp"),
			bind_host: "127.0.0.1".into(),
			bind_port: 8080,
			replay_token: None,
			rate_limit_window_seconds: 1.0,
			rate_limit_default: 1,
			rate_limit_contributor: 1,
			rate_limit_unlimited_raw: String::new(),
			maintainer_logins_raw: String::new(),
			reviewer_bots_raw: String::new(),
			question_autoclose_enabled: true,
			question_autoclose_hours: 4.0,
			question_autoclose_scan_seconds: 60.0,
			natives_cache_enabled: false,
			natives_cache_root: std::path::PathBuf::from("/tmp"),
			natives_cache_max_entries_per_repo: 1,
			natives_cache_max_bytes: 1,
			natives_cache_gc_interval_seconds: 0.0,
		};
		let pr = PullRequestInfo {
			repo:      "octo/widget".into(),
			number:    7,
			html_url:  String::new(),
			head_ref:  "robogjc/issue-1".into(),
			base_ref:  "main".into(),
			state:     "open".into(),
			author:    "RoboGJC-Bot".into(),
			head_repo: "OCTO/WIDGET".into(),
		};
		assert!(can_handle_pr_directly(&settings, "octo/widget", &pr));
		let mut other = pr;
		other.author = "alice".into();
		assert!(!can_handle_pr_directly(&settings, "octo/widget", &other));
	}

	#[test]
	fn tasks_cleanup_workspace_removes_sandbox_before_state_update() {
		let d = tempfile::tempdir().unwrap();
		let db = Database::open(d.path().join("t.sqlite")).unwrap();
		let sandbox = SandboxManager::new(d.path().join("workspaces"));
		db.upsert_issue("octo/widget#42", "octo/widget", 42, "open", None, None, None)
			.unwrap();
		let ws_root = sandbox.workspace_root("octo/widget", 42);
		std::fs::create_dir_all(ws_root.join("repo")).unwrap();
		cleanup_workspace(&db, &sandbox, "octo/widget#42", "closed").unwrap();
		assert!(!ws_root.exists());
		assert_eq!(db.get_issue("octo/widget#42").unwrap().unwrap().state, "closed");
	}
}
