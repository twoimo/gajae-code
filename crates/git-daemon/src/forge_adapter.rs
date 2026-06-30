//! Provider-neutral forge operations the work engine performs.
//!
//! This is the write-side portability boundary (the read-side normalizer lives
//! in [`crate::forge`]). The concrete GitHub App HTTP implementation is a later
//! async slice; this module defines the trait plus an in-memory [`FakeForge`]
//! used to integration-test the merge flow — including the SHA-bound merge
//! invariant — without a network.

use std::collections::HashMap;
use std::sync::Mutex;

/// A pull request as the work engine sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgePr {
	pub id: String,
	pub number: u64,
	pub head_sha: String,
	pub base_branch: String,
}

/// A SHA-bound merge request. `expected_head_sha` is enforced by the forge so a
/// race between the gate decision and the merge call fails closed.
#[derive(Debug, Clone)]
pub struct MergeRequest {
	pub pr_id: String,
	pub expected_head_sha: String,
}

/// Errors a forge operation may return.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeError {
	NotFound,
	/// The PR head moved; `expected_head_sha` no longer matches.
	ShaMismatch,
	ProtectedBranch,
	RateLimited,
	Auth,
	Transient(String),
}

impl core::fmt::Display for ForgeError {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		match self {
			Self::NotFound => f.write_str("not_found"),
			Self::ShaMismatch => f.write_str("sha_mismatch"),
			Self::ProtectedBranch => f.write_str("protected_branch"),
			Self::RateLimited => f.write_str("rate_limited"),
			Self::Auth => f.write_str("auth_failed"),
			Self::Transient(m) => write!(f, "transient: {m}"),
		}
	}
}

impl core::error::Error for ForgeError {}

/// Provider-neutral write operations. GitHub-specific HTTP/JSON lives in the
/// concrete implementation; callers only see canonical types.
#[allow(
	async_fn_in_trait,
	reason = "internal trait with a single in-crate impl per provider; no Send bound needed yet"
)]
pub trait ForgeAdapter {
	/// Fetch current PR state (head SHA, base) at the immediate pre-merge refetch.
	async fn get_pr(&self, pr_id: &str) -> Result<ForgePr, ForgeError>;
	/// Merge the PR, enforcing `expected_head_sha`. Returns the merge commit SHA.
	async fn merge_pr(&self, req: &MergeRequest) -> Result<String, ForgeError>;
	/// Post a comment on an item (issue or PR).
	async fn post_comment(&self, item_id: &str, body: &str) -> Result<(), ForgeError>;
}

/// In-memory forge for tests. Records merges and enforces the expected head SHA.
#[derive(Default)]
pub struct FakeForge {
	prs: Mutex<HashMap<String, ForgePr>>,
	merges: Mutex<Vec<String>>,
	comments: Mutex<Vec<(String, String)>>,
}

impl FakeForge {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Seed (or replace) a PR.
	pub fn put_pr(&self, pr: ForgePr) {
		self.prs.lock().unwrap().insert(pr.id.clone(), pr);
	}

	/// PR ids that were merged, in order.
	#[must_use]
	pub fn merged(&self) -> Vec<String> {
		self.merges.lock().unwrap().clone()
	}

	/// Recorded comments as `(item_id, body)`.
	#[must_use]
	pub fn comments(&self) -> Vec<(String, String)> {
		self.comments.lock().unwrap().clone()
	}
}

impl ForgeAdapter for FakeForge {
	async fn get_pr(&self, pr_id: &str) -> Result<ForgePr, ForgeError> {
		self.prs.lock().unwrap().get(pr_id).cloned().ok_or(ForgeError::NotFound)
	}

	async fn merge_pr(&self, req: &MergeRequest) -> Result<String, ForgeError> {
		let prs = self.prs.lock().unwrap();
		let pr = prs.get(&req.pr_id).ok_or(ForgeError::NotFound)?;
		if pr.head_sha != req.expected_head_sha {
			return Err(ForgeError::ShaMismatch);
		}
		let merge_sha = format!("merge-{}", pr.head_sha);
		self.merges.lock().unwrap().push(req.pr_id.clone());
		Ok(merge_sha)
	}

	async fn post_comment(&self, item_id: &str, body: &str) -> Result<(), ForgeError> {
		self.comments.lock().unwrap().push((item_id.to_owned(), body.to_owned()));
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::config::MergePolicy;
	use crate::merge_gate::{GateInputs, evaluate};

	fn pr(head: &str) -> ForgePr {
		ForgePr { id: "PR_7".into(), number: 7, head_sha: head.into(), base_branch: "dev".into() }
	}

	fn policy() -> MergePolicy {
		MergePolicy { protected_branches: vec![], allowed_dev_branches: vec!["dev".into()] }
	}

	#[tokio::test]
	async fn merge_enforces_expected_head_sha() {
		let forge = FakeForge::new();
		forge.put_pr(pr("sha1"));
		// Correct expected SHA merges.
		let ok = forge.merge_pr(&MergeRequest { pr_id: "PR_7".into(), expected_head_sha: "sha1".into() }).await;
		assert_eq!(ok, Ok("merge-sha1".into()));
		// A stale expected SHA fails closed.
		let stale =
			forge.merge_pr(&MergeRequest { pr_id: "PR_7".into(), expected_head_sha: "sha0".into() }).await;
		assert_eq!(stale, Err(ForgeError::ShaMismatch));
	}

	#[tokio::test]
	async fn gate_pass_then_sha_bound_merge_succeeds() {
		let forge = FakeForge::new();
		forge.put_pr(pr("sha1"));
		// Pre-merge refetch.
		let live = forge.get_pr("PR_7").await.unwrap();
		let inputs = GateInputs {
			queued_head_sha: "sha1",
			current_head_sha: &live.head_sha,
			base_branch: &live.base_branch,
			branch_protection_known: true,
			ci_green: true,
			ultragoal_pass: true,
			reviews_resolved: true,
			diff_within_budget: true,
			diff_in_scope: true,
		};
		let decision = evaluate(&inputs, &policy());
		assert!(decision.may_merge());
		// Merge with the decision's bound head SHA.
		let merged = forge
			.merge_pr(&MergeRequest { pr_id: "PR_7".into(), expected_head_sha: decision.head_sha })
			.await
			.unwrap();
		assert_eq!(merged, "merge-sha1");
		assert_eq!(forge.merged(), vec!["PR_7".to_owned()]);
	}

	#[tokio::test]
	async fn head_moved_after_decision_never_merges() {
		let forge = FakeForge::new();
		forge.put_pr(pr("sha1"));
		// Gate decided on sha1, but the head moved to sha2 before the merge call.
		forge.put_pr(pr("sha2"));
		let stale =
			forge.merge_pr(&MergeRequest { pr_id: "PR_7".into(), expected_head_sha: "sha1".into() }).await;
		assert_eq!(stale, Err(ForgeError::ShaMismatch));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn comments_are_recorded() {
		let forge = FakeForge::new();
		forge.post_comment("I_42", "working on it").await.unwrap();
		assert_eq!(forge.comments(), vec![("I_42".to_owned(), "working on it".to_owned())]);
	}
}
