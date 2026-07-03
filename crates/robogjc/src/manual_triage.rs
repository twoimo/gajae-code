//! Manual issue triage enqueue helpers.

use std::{
	future::Future,
	pin::Pin,
	sync::Arc,
	time::{Duration, Instant},
};

use regex::Regex;
use serde_json::json;

use crate::{
	db::{Database, EventRow, issue_key},
	github::{GitHubBackend, GitHubError, IssueInfo, RepoInfo},
};

pub const INACTIVE_EVENT_STATES: &[&str] = &["done", "failed", "skipped"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidIssueRef(pub String);
impl std::fmt::Display for InvalidIssueRef {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}
impl std::error::Error for InvalidIssueRef {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualTriageConflict {
	pub delivery_id: String,
	pub state:       String,
}
impl std::fmt::Display for ManualTriageConflict {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{} is already {}", self.delivery_id, self.state)
	}
}
impl std::error::Error for ManualTriageConflict {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualTriageTimeout {
	pub delivery_id: String,
	pub state:       String,
	pub timeout:     Duration,
}
impl std::fmt::Display for ManualTriageTimeout {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{} did not reach terminal state", self.delivery_id)
	}
}
impl std::error::Error for ManualTriageTimeout {}

pub type ManualFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, GitHubError>> + Send + 'a>>;
pub trait ManualTriageGithub: Send + Sync {
	fn get_issue<'a>(&'a self, repo: &'a str, number: i64) -> ManualFuture<'a, IssueInfo>;
	fn get_repo<'a>(&'a self, repo: &'a str) -> ManualFuture<'a, RepoInfo>;
}

impl<T: GitHubBackend + ?Sized> ManualTriageGithub for T {
	fn get_issue<'a>(&'a self, repo: &'a str, number: i64) -> ManualFuture<'a, IssueInfo> {
		GitHubBackend::get_issue(self, repo, number)
	}

	fn get_repo<'a>(&'a self, repo: &'a str) -> ManualFuture<'a, RepoInfo> {
		GitHubBackend::get_repo(self, repo)
	}
}

pub fn parse_issue_ref(input: &str) -> Result<(String, i64), InvalidIssueRef> {
	let cleaned = input.trim();
	let short = Regex::new(r"^(?P<owner>[^/\s]+)/(?P<repo>[^#\s]+)#(?P<number>\d+)$").unwrap();
	let url = Regex::new(r"^(?:https?://)?(?:www\.)?github\.com/(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+)/issues/(?P<number>\d+)(?:[/?#].*)?$").unwrap();
	let caps = short
		.captures(cleaned)
		.or_else(|| url.captures(cleaned))
		.ok_or_else(|| {
			InvalidIssueRef(format!("expected owner/repo#NN or GitHub issue URL, got {input:?}"))
		})?;
	Ok((format!("{}/{}", &caps["owner"], &caps["repo"]), caps["number"].parse().unwrap()))
}

pub fn manual_delivery_id(repo_full: &str, number: i64) -> String {
	format!("manual-{}-{number}", repo_full.replace('/', "__"))
}

pub async fn enqueue_manual_triage<G: ManualTriageGithub + ?Sized>(
	db: &Database,
	github: &G,
	repo_full: &str,
	number: i64,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
	let delivery = manual_delivery_id(repo_full, number);
	if let Some(existing) = db.get_event(&delivery)?
		&& (existing.state == "queued" || existing.state == "running")
	{
		return Err(Box::new(ManualTriageConflict {
			delivery_id: delivery,
			state:       existing.state,
		}));
	}
	let issue = github.get_issue(repo_full, number).await?;
	if issue.is_pull_request {
		return Err("pull request cannot be manually triaged".into());
	}
	let repo = github.get_repo(repo_full).await?;
	let payload = json!({"action":"opened","issue":{"number":issue.number,"title":issue.title,"body":issue.body,"state":issue.state,"user":{"login":issue.author},"labels":issue.labels.iter().map(|l| json!({"name":l})).collect::<Vec<_>>()},"repository":{"full_name":repo.full_name,"default_branch":repo.default_branch,"clone_url":repo.clone_url,"private":repo.private}});
	let ok = db.replace_event_if_state_in(
		&delivery,
		"issues",
		Some(repo_full),
		Some(&issue_key(repo_full, number)),
		&payload,
		"queued",
		INACTIVE_EVENT_STATES,
	)?;
	if !ok {
		let state = db
			.get_event(&delivery)?
			.map_or_else(|| "active".into(), |r| r.state);
		return Err(Box::new(ManualTriageConflict { delivery_id: delivery, state }));
	}
	Ok(delivery)
}

pub async fn await_terminal_state(
	db: Arc<Database>,
	delivery_id: &str,
	poll_interval: Duration,
	timeout: Option<Duration>,
) -> Result<Option<EventRow>, Box<dyn std::error::Error + Send + Sync>> {
	let start = Instant::now();
	loop {
		let row = db.get_event(delivery_id)?;
		match row {
			None => return Ok(None),
			Some(r) if matches!(r.state.as_str(), "done" | "failed" | "skipped") => {
				return Ok(Some(r));
			},
			Some(r) => {
				if let Some(timeout) = timeout.filter(|t| start.elapsed() >= *t) {
					return Err(Box::new(ManualTriageTimeout {
						delivery_id: delivery_id.into(),
						state: r.state,
						timeout,
					}));
				}
				tokio::time::sleep(poll_interval).await;
			},
		}
	}
}

#[cfg(test)]
mod manual_triage_tests {
	use tempfile::tempdir;

	use super::*;

	#[test]
	fn manual_triage_parse_refs_and_delivery_id() {
		assert_eq!(parse_issue_ref("octo/widget#42").unwrap(), ("octo/widget".into(), 42));
		assert_eq!(
			parse_issue_ref("https://github.com/octo/widget/issues/42?x=1").unwrap(),
			("octo/widget".into(), 42)
		);
		assert!(parse_issue_ref("octo/widget/pulls/1").is_err());
		assert_eq!(manual_delivery_id("octo/widget", 42), "manual-octo__widget-42");
	}

	#[tokio::test]
	async fn manual_triage_await_terminal_timeout_and_done() {
		let d = tempdir().unwrap();
		let db = Arc::new(Database::open(d.path().join("t.sqlite")).unwrap());
		db.record_event(
			"d",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#1"),
			&json!({}),
			"queued",
			None,
		)
		.unwrap();
		assert!(
			await_terminal_state(
				db.clone(),
				"d",
				Duration::from_millis(1),
				Some(Duration::from_millis(2))
			)
			.await
			.is_err()
		);
		db.mark_event("d", "done", None).unwrap();
		assert_eq!(
			await_terminal_state(db, "d", Duration::from_millis(1), Some(Duration::from_millis(20)))
				.await
				.unwrap()
				.unwrap()
				.state,
			"done"
		);
	}
}
