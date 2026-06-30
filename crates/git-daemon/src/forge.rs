//! Provider-neutral forge events and the GitHub payload normalizer.
//!
//! GitHub-specific JSON shapes are confined to [`normalize_github`]; the rest of
//! the daemon only ever sees the canonical [`ForgeEvent`]. This is the
//! portability boundary that lets a future GitLab/Gitea adapter slot in without
//! touching ingestion, the state machine, or the merge gate.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::keys::ItemKind;

/// A canonical, provider-neutral forge event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgeEvent {
	pub provider: String,
	pub repo_node_id: String,
	pub item_kind: ItemKind,
	pub item_node_id: String,
	/// Provider event family (e.g. `issues`, `pull_request`, `issue_comment`).
	pub event_family: String,
	/// Normalized action (e.g. `opened`, `edited`, `commented`, `synchronize`).
	pub action: String,
	/// Login of the actor that triggered the event, when present.
	pub actor_login: Option<String>,
	/// Observable revision token (`updated_at` or head SHA) — feeds the dedupe key.
	pub event_revision: String,
	/// Whether the event warrants (re)engaging work, vs. an ack-only no-op.
	pub actionable: bool,
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
	let mut cur = v;
	for key in path {
		cur = cur.get(key)?;
	}
	cur.as_str()
}

fn is_actionable_issue(action: &str) -> bool {
	matches!(action, "opened" | "edited" | "reopened" | "labeled" | "assigned")
}

fn is_actionable_pr(action: &str) -> bool {
	matches!(action, "opened" | "edited" | "reopened" | "synchronize" | "ready_for_review")
}

/// Normalize a GitHub webhook into a canonical [`ForgeEvent`].
///
/// Takes the `event_name` plus parsed JSON `payload`. Returns `None` for event
/// families the daemon does not act on, keeping all GitHub-specific shape
/// knowledge inside this function.
#[must_use]
pub fn normalize_github(event_name: &str, payload: &Value) -> Option<ForgeEvent> {
	let provider = "github".to_owned();
	let repo_node_id = str_at(payload, &["repository", "node_id"])?.to_owned();
	let actor_login = str_at(payload, &["sender", "login"]).map(str::to_owned);

	match event_name {
		"issues" => {
			let action = str_at(payload, &["action"])?.to_owned();
			Some(ForgeEvent {
				provider,
				repo_node_id,
				item_kind: ItemKind::Issue,
				item_node_id: str_at(payload, &["issue", "node_id"])?.to_owned(),
				event_family: "issues".to_owned(),
				actionable: is_actionable_issue(&action),
				action,
				actor_login,
				event_revision: str_at(payload, &["issue", "updated_at"])?.to_owned(),
			})
		}
		"issue_comment" => Some(ForgeEvent {
			provider,
			repo_node_id,
			item_kind: ItemKind::Issue,
			item_node_id: str_at(payload, &["issue", "node_id"])?.to_owned(),
			event_family: "issue_comment".to_owned(),
			action: "commented".to_owned(),
			actor_login,
			event_revision: str_at(payload, &["comment", "updated_at"])?.to_owned(),
			actionable: true,
		}),
		"pull_request" => {
			let action = str_at(payload, &["action"])?.to_owned();
			Some(ForgeEvent {
				provider,
				repo_node_id,
				item_kind: ItemKind::Pr,
				item_node_id: str_at(payload, &["pull_request", "node_id"])?.to_owned(),
				event_family: "pull_request".to_owned(),
				actionable: is_actionable_pr(&action),
				action,
				actor_login,
				event_revision: str_at(payload, &["pull_request", "head", "sha"])?.to_owned(),
			})
		}
		"pull_request_review" => Some(ForgeEvent {
			provider,
			repo_node_id,
			item_kind: ItemKind::Pr,
			item_node_id: str_at(payload, &["pull_request", "node_id"])?.to_owned(),
			event_family: "pull_request_review".to_owned(),
			action: "review_submitted".to_owned(),
			actor_login,
			event_revision: str_at(payload, &["review", "submitted_at"])
				.or_else(|| str_at(payload, &["pull_request", "head", "sha"]))?
				.to_owned(),
			actionable: true,
		}),
		"pull_request_review_comment" => Some(ForgeEvent {
			provider,
			repo_node_id,
			item_kind: ItemKind::Pr,
			item_node_id: str_at(payload, &["pull_request", "node_id"])?.to_owned(),
			event_family: "pull_request_review_comment".to_owned(),
			action: "review_comment".to_owned(),
			actor_login,
			event_revision: str_at(payload, &["comment", "updated_at"])?.to_owned(),
			actionable: true,
		}),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	#[test]
	fn normalizes_issue_opened_as_actionable() {
		let payload = json!({
			"action": "opened",
			"repository": { "node_id": "R_1" },
			"sender": { "login": "octocat" },
			"issue": { "node_id": "I_42", "updated_at": "2026-01-01T00:00:00Z" }
		});
		let ev = normalize_github("issues", &payload).unwrap();
		assert_eq!(ev.item_kind, ItemKind::Issue);
		assert_eq!(ev.item_node_id, "I_42");
		assert_eq!(ev.action, "opened");
		assert_eq!(ev.actor_login.as_deref(), Some("octocat"));
		assert_eq!(ev.event_revision, "2026-01-01T00:00:00Z");
		assert!(ev.actionable);
	}

	#[test]
	fn pr_synchronize_uses_head_sha_revision() {
		let payload = json!({
			"action": "synchronize",
			"repository": { "node_id": "R_1" },
			"pull_request": { "node_id": "PR_7", "head": { "sha": "abc123" } }
		});
		let ev = normalize_github("pull_request", &payload).unwrap();
		assert_eq!(ev.item_kind, ItemKind::Pr);
		assert_eq!(ev.event_revision, "abc123");
		assert!(ev.actionable);
	}

	#[test]
	fn issue_comment_is_actionable_follow_up() {
		let payload = json!({
			"repository": { "node_id": "R_1" },
			"issue": { "node_id": "I_42" },
			"comment": { "updated_at": "2026-02-02T00:00:00Z" }
		});
		let ev = normalize_github("issue_comment", &payload).unwrap();
		assert_eq!(ev.action, "commented");
		assert!(ev.actionable);
	}

	#[test]
	fn non_actionable_pr_action_still_normalizes() {
		// `closed` is a real event but not something the daemon attempts work on.
		let payload = json!({
			"action": "closed",
			"repository": { "node_id": "R_1" },
			"pull_request": { "node_id": "PR_7", "head": { "sha": "z9" } }
		});
		let ev = normalize_github("pull_request", &payload).unwrap();
		assert_eq!(ev.action, "closed");
		assert!(!ev.actionable);
	}

	#[test]
	fn unknown_event_family_is_ignored() {
		let payload = json!({ "repository": { "node_id": "R_1" } });
		assert!(normalize_github("star", &payload).is_none());
	}

	#[test]
	fn missing_required_fields_returns_none() {
		// No issue node_id -> cannot form a canonical event.
		let payload = json!({ "action": "opened", "repository": { "node_id": "R_1" } });
		assert!(normalize_github("issues", &payload).is_none());
	}
}
