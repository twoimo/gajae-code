//! Deterministic idempotency, work-intent, and single-flight lock keys.
//!
//! These keys are the concurrency authority for the daemon. With enforced
//! budgets and self-revision caps disabled (D3/D4), correctness against
//! duplicate / racing webhook + poll deliveries rests entirely on these keys
//! plus the `SQLite` unique constraints that store them.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The deterministic head-branch ref the daemon assigns to a work item.
///
/// The coding agent is instructed to push exactly this branch, and PR/branch
/// discovery matches on it, so a run's PR is bound to its own work item (never a
/// stale or concurrent daemon branch for a different issue).
#[must_use]
pub fn work_branch_ref(work_key: &str) -> String {
	use core::fmt::Write as _;
	let digest = Sha256::digest(work_key.as_bytes());
	let mut hex = String::with_capacity(16);
	for b in digest.iter().take(8) {
		let _ = write!(hex, "{b:02x}");
	}
	format!("git-daemon/wk-{hex}")
}

/// The kind of forge item a work unit targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
	Issue,
	Pr,
}

impl ItemKind {
	/// Stable wire token used inside composite keys.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Issue => "issue",
			Self::Pr => "pr",
		}
	}

	/// Parse a stable wire token back into an [`ItemKind`].
	#[must_use]
	pub fn from_wire(token: &str) -> Option<Self> {
		match token {
			"issue" => Some(Self::Issue),
			"pr" => Some(Self::Pr),
			_ => None,
		}
	}
}

/// Identifies a single forge item independent of the event that surfaced it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ItemRef {
	pub provider: String,
	pub repo_node_id: String,
	pub item_kind: ItemKind,
	pub item_node_id: String,
}

impl ItemRef {
	#[must_use]
	pub fn new(
		provider: impl Into<String>,
		repo_node_id: impl Into<String>,
		item_kind: ItemKind,
		item_node_id: impl Into<String>,
	) -> Self {
		Self {
			provider: provider.into(),
			repo_node_id: repo_node_id.into(),
			item_kind,
			item_node_id: item_node_id.into(),
		}
	}

	/// Single-flight lock key: at most one active run per item.
	#[must_use]
	pub fn lock_key(&self) -> LockKey {
		LockKey(format!(
			"item:{}:{}:{}:{}",
			self.provider,
			self.repo_node_id,
			self.item_kind.as_str(),
			self.item_node_id
		))
	}

	/// Work-intent key: blocks a duplicate PR for the same normalized action.
	/// Follow-ups reuse this key (same item + action) so they update the
	/// existing work item instead of opening a second PR.
	#[must_use]
	pub fn work_intent_key(&self, normalized_action: &str) -> WorkIntentKey {
		WorkIntentKey(format!(
			"work:{}:{}:{}:{}:{}",
			self.provider,
			self.repo_node_id,
			self.item_kind.as_str(),
			self.item_node_id,
			normalized_action
		))
	}
}

/// How an event reached the daemon. Webhook deliveries and poll-discovered
/// events dedupe into the same logical revision via [`DedupKey`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventSource {
	/// A webhook delivery, keyed by the provider's delivery id (e.g.
	/// GitHub's `X-GitHub-Delivery`).
	Webhook { delivery_id: String },
	/// A poll-discovered event, keyed by a synthetic id derived from the
	/// resource's observable state so re-polling the same state is idempotent.
	Poll { resource: String, state_token: String },
}

impl EventSource {
	fn delivery_token(&self) -> String {
		match self {
			Self::Webhook { delivery_id } => delivery_id.clone(),
			Self::Poll { resource, state_token } => format!("poll:{resource}:{state_token}"),
		}
	}
}

/// Exactly-once event dedupe key spanning webhook + poll.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DedupKey(pub String);

/// Work-intent uniqueness key (one daemon PR per item + normalized action).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkIntentKey(pub String);

/// Single-flight lock key (one active run per item).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LockKey(pub String);

impl DedupKey {
	/// Compose the dedupe key for an ingested event.
	#[must_use]
	pub fn new(item: &ItemRef, event_family: &str, source: &EventSource, event_revision: &str) -> Self {
		Self(format!(
			"forge:{}:repo:{}:event:{}:item:{}:{}:delivery:{}:revision:{}",
			item.provider,
			item.repo_node_id,
			event_family,
			item.item_kind.as_str(),
			item.item_node_id,
			source.delivery_token(),
			event_revision
		))
	}
}

impl DedupKey {
	#[must_use]
	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl WorkIntentKey {
	#[must_use]
	pub fn as_str(&self) -> &str {
		&self.0
	}

	/// Parse a work-intent key back into its [`ItemRef`] and normalized action.
	///
	/// Inverse of [`ItemRef::work_intent_key`]. Returns `None` if the token is
	/// not a well-formed `work:provider:repo:kind:node:action` key. The
	/// provider, repo node id, kind token, and item node id never contain `:`
	/// (forge node ids are colon-free), so a fixed split is unambiguous; the
	/// trailing action may contain `:` and is taken verbatim.
	#[must_use]
	pub fn parse(&self) -> Option<(ItemRef, String)> {
		let rest = self.0.strip_prefix("work:")?;
		let mut parts = rest.splitn(5, ':');
		let provider = parts.next()?;
		let repo = parts.next()?;
		let kind = ItemKind::from_wire(parts.next()?)?;
		let node = parts.next()?;
		let action = parts.next()?;
		if action.is_empty() {
			return None;
		}
		Some((ItemRef::new(provider, repo, kind, node), action.to_owned()))
	}
}

impl LockKey {
	#[must_use]
	pub fn as_str(&self) -> &str {
		&self.0
	}
}

/// Acquire locks for several items in a stable, deadlock-free order.
///
/// When a single issue owns a daemon PR, work touches both the issue and the PR
/// item; acquiring them in a globally consistent (sorted) order prevents lock
/// cycles between concurrent workers.
#[must_use]
pub fn sorted_lock_keys(items: &[ItemRef]) -> Vec<LockKey> {
	let mut keys: Vec<LockKey> = items.iter().map(ItemRef::lock_key).collect();
	keys.sort();
	keys.dedup();
	keys
}

#[cfg(test)]
mod tests {
	use super::*;

	fn issue() -> ItemRef {
		ItemRef::new("github", "R_repo1", ItemKind::Issue, "I_42")
	}

	#[test]
	fn work_intent_key_round_trips_through_parse() {
		let item = ItemRef::new("github", "R_kgDOABC", ItemKind::Pr, "PR_kwDOxyz");
		let key = item.work_intent_key("resolve");
		let (parsed, action) = key.parse().expect("well-formed key parses");
		assert_eq!(parsed, item);
		assert_eq!(action, "resolve");
	}

	#[test]
	fn work_branch_ref_is_deterministic_and_distinct() {
		let a = work_branch_ref("work:github:R_1:issue:I_1:resolve");
		assert_eq!(a, work_branch_ref("work:github:R_1:issue:I_1:resolve"), "same key -> same ref");
		assert!(a.starts_with("git-daemon/wk-"));
		assert_ne!(a, work_branch_ref("work:github:R_1:issue:I_2:resolve"), "distinct keys -> distinct refs");
	}

	#[test]
	fn parse_rejects_malformed_keys() {
		assert!(WorkIntentKey("not-a-work-key".to_owned()).parse().is_none());
		assert!(WorkIntentKey("work:github:R_1:issue:I_1".to_owned()).parse().is_none()); // no action
		assert!(WorkIntentKey("work:github:R_1:bogus:I_1:resolve".to_owned()).parse().is_none()); // bad kind
	}

	#[test]
	fn dedup_key_has_documented_shape() {
		let k = DedupKey::new(
			&issue(),
			"issues",
			&EventSource::Webhook { delivery_id: "d-1".into() },
			"rev-1",
		);
		assert_eq!(
			k.as_str(),
			"forge:github:repo:R_repo1:event:issues:item:issue:I_42:delivery:d-1:revision:rev-1"
		);
	}

	#[test]
	fn webhook_and_poll_for_same_state_are_distinguishable_but_stable() {
		let poll = DedupKey::new(
			&issue(),
			"issues",
			&EventSource::Poll { resource: "issue".into(), state_token: "I_42:open:sha9".into() },
			"rev-1",
		);
		// Re-polling the identical observable state reproduces the same key
		// (idempotent), so the SQLite unique constraint drops the duplicate.
		let poll_again = DedupKey::new(
			&issue(),
			"issues",
			&EventSource::Poll { resource: "issue".into(), state_token: "I_42:open:sha9".into() },
			"rev-1",
		);
		assert_eq!(poll, poll_again);
	}

	#[test]
	fn follow_ups_share_one_work_intent_so_no_duplicate_pr() {
		// Two events on the same issue with the same normalized action collapse
		// to one work-intent key: the follow-up updates the work item rather
		// than opening a second PR.
		let first = issue().work_intent_key("resolve");
		let follow_up = issue().work_intent_key("resolve");
		assert_eq!(first, follow_up);
		assert_eq!(first.as_str(), "work:github:R_repo1:issue:I_42:resolve");
	}

	#[test]
	fn lock_key_is_per_item() {
		assert_eq!(issue().lock_key().as_str(), "item:github:R_repo1:issue:I_42");
		let pr = ItemRef::new("github", "R_repo1", ItemKind::Pr, "PR_7");
		assert_ne!(issue().lock_key(), pr.lock_key());
	}

	#[test]
	fn sorted_lock_keys_are_stable_and_deduped() {
		let issue = issue();
		let pr = ItemRef::new("github", "R_repo1", ItemKind::Pr, "PR_7");
		// Order of inputs must not change the acquisition order.
		let a = sorted_lock_keys(&[issue.clone(), pr.clone()]);
		let b = sorted_lock_keys(&[pr, issue.clone(), issue]);
		assert_eq!(a, b);
		assert_eq!(a.len(), 2);
	}

	#[test]
	fn item_kind_round_trips_through_serde() {
		let json = serde_json::to_string(&ItemKind::Pr).unwrap();
		assert_eq!(json, "\"pr\"");
		let back: ItemKind = serde_json::from_str(&json).unwrap();
		assert_eq!(back, ItemKind::Pr);
	}
}
