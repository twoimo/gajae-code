//! Provider-neutral forge operations the work engine performs.
//!
//! This is the write-side portability boundary (the read-side normalizer lives
//! in [`crate::forge`]). The concrete GitHub App HTTP implementation is a later
//! async slice; this module defines the trait plus an in-memory [`FakeForge`]
//! used to integration-test the merge flow — including the SHA-bound merge
//! invariant — without a network.

use std::{collections::HashMap, sync::Mutex};

/// A pull request as the work engine sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgePr {
	pub id:          String,
	pub number:      u64,
	pub head_sha:    String,
	pub base_branch: String,
}

/// A forge item discovered by a poll sweep (issue or PR).
///
/// Normalized to the fields the ingestion dispatcher needs: `updated_at` is the
/// observable revision (webhook + poll dedupe on it); `state` is the observable
/// state (e.g. `open`/`closed`) folded into the poll dedupe token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolledItem {
	pub node_id:    String,
	pub item_kind:  crate::keys::ItemKind,
	pub updated_at: String,
	pub state:      String,
}

/// Live merge-gate signals derived from the forge for a PR's current head.
///
/// These are the daemon's GitHub observations (CI, reviews, diff), NOT engine
/// events — the orchestrator combines them with the run outcome and its own
/// verification to evaluate the SHA-bound merge gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeSignals {
	/// All required checks/CI concluded successfully (no failing runs).
	pub ci_green:           bool,
	/// No unresolved `CHANGES_REQUESTED` review remains.
	pub reviews_resolved:   bool,
	/// The diff is within the configured size/risk budget.
	pub diff_within_budget: bool,
	/// The diff touches only in-scope paths (no infra/secret/out-of-scope
	/// edits).
	pub diff_in_scope:      bool,
}

/// A SHA-bound merge request. `expected_head_sha` is enforced by the forge so a
/// race between the gate decision and the merge call fails closed.
#[derive(Debug, Clone)]
pub struct MergeRequest {
	pub pr_id:             String,
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
	/// Fetch current PR state (head SHA, base) at the immediate pre-merge
	/// refetch.
	async fn get_pr(&self, pr_id: &str) -> Result<ForgePr, ForgeError>;
	/// List open issues for the repository (poll reconciliation). Returns the
	/// items the dispatcher will dedupe + turn into work intents.
	async fn list_open_issues(&self) -> Result<Vec<PolledItem>, ForgeError>;
	/// Find the open PR the unattended run created for `work_key`, if any (by
	/// the daemon's head-branch convention). `None` means the run opened no PR.
	async fn find_work_pr(&self, work_key: &str) -> Result<Option<ForgePr>, ForgeError>;
	/// Find the daemon head branch bound to `work_key` (its deterministic
	/// [`crate::keys::work_branch_ref`]), if the run pushed it but opened no PR,
	/// so the daemon can open it. Matching on the work-item ref (not any
	/// `git-daemon/*` branch) prevents attributing a stale/concurrent branch to
	/// this run.
	async fn find_work_branch(&self, work_key: &str) -> Result<Option<String>, ForgeError>;
	/// Open a PR from `head_branch` into `base_branch`. Returns the created PR.
	async fn create_pr(
		&self,
		head_branch: &str,
		base_branch: &str,
		title: &str,
		body: &str,
	) -> Result<ForgePr, ForgeError>;
	/// Fetch the live merge-gate signals (CI, reviews, diff) for a PR's head.
	async fn fetch_merge_signals(
		&self,
		pr_id: &str,
		head_sha: &str,
	) -> Result<MergeSignals, ForgeError>;
	/// Determine whether the base branch's protection state could be read.
	/// `Ok(is_protected)` on a successful read; `Err` when protection could not
	/// be determined — the gate then fails closed (`BranchProtectionUnknown`).
	async fn get_branch_protection(&self, base_branch: &str) -> Result<bool, ForgeError>;
	/// Merge the PR, enforcing `expected_head_sha`. Returns the merge commit
	/// SHA.
	async fn merge_pr(&self, req: &MergeRequest) -> Result<String, ForgeError>;
	/// Post a comment on an item (issue or PR).
	async fn post_comment(&self, item_id: &str, body: &str) -> Result<(), ForgeError>;
}

/// In-memory forge for tests. Records merges and enforces the expected head
/// SHA.
#[derive(Default)]
pub struct FakeForge {
	prs:                   Mutex<HashMap<String, ForgePr>>,
	merges:                Mutex<Vec<String>>,
	comments:              Mutex<Vec<(String, String)>>,
	open_issues:           Mutex<Vec<PolledItem>>,
	work_pr:               Mutex<Option<ForgePr>>,
	work_branch:           Mutex<Option<String>>,
	work_branch_sha:       Mutex<Option<String>>,
	created_prs:           Mutex<Vec<(String, String)>>,
	merge_signals:         Mutex<Option<MergeSignals>>,
	/// When set, `get_branch_protection` returns an error (simulating an
	/// unverifiable protection state so the gate fails closed).
	protection_unreadable: Mutex<bool>,
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

	/// Seed an open issue for poll reconciliation.
	pub fn put_open_issue(&self, item: PolledItem) {
		self.open_issues.lock().unwrap().push(item);
	}

	/// Seed the PR that `find_work_pr` returns for the run's work.
	pub fn set_work_pr(&self, pr: ForgePr) {
		*self.work_pr.lock().unwrap() = Some(pr);
	}

	/// Seed a daemon-authored branch (head name + head SHA) that
	/// `find_work_branch` returns when no PR exists yet, so `create_pr` can
	/// open one.
	pub fn set_work_branch(&self, head_branch: &str, head_sha: &str) {
		*self.work_branch.lock().unwrap() = Some(head_branch.to_owned());
		*self.work_branch_sha.lock().unwrap() = Some(head_sha.to_owned());
	}

	/// `(head, base)` pairs for PRs the daemon opened via `create_pr`.
	#[must_use]
	pub fn created_prs(&self) -> Vec<(String, String)> {
		self.created_prs.lock().unwrap().clone()
	}

	/// Seed the merge signals `fetch_merge_signals` returns.
	pub fn set_merge_signals(&self, signals: MergeSignals) {
		*self.merge_signals.lock().unwrap() = Some(signals);
	}

	/// Simulate a base branch whose protection state cannot be read (the gate
	/// must then fail closed with `BranchProtectionUnknown`).
	pub fn set_protection_unreadable(&self) {
		*self.protection_unreadable.lock().unwrap() = true;
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
		self
			.prs
			.lock()
			.unwrap()
			.get(pr_id)
			.cloned()
			.ok_or(ForgeError::NotFound)
	}

	async fn list_open_issues(&self) -> Result<Vec<PolledItem>, ForgeError> {
		Ok(self.open_issues.lock().unwrap().clone())
	}

	async fn find_work_pr(&self, _work_key: &str) -> Result<Option<ForgePr>, ForgeError> {
		Ok(self.work_pr.lock().unwrap().clone())
	}

	async fn find_work_branch(&self, work_key: &str) -> Result<Option<String>, ForgeError> {
		// Bound to the work item: only return the branch if it is this work_key's
		// deterministic ref (models attribution — a stale/other branch is ignored).
		let want = crate::keys::work_branch_ref(work_key);
		Ok(self
			.work_branch
			.lock()
			.unwrap()
			.clone()
			.filter(|b| *b == want))
	}

	async fn create_pr(
		&self,
		head_branch: &str,
		base_branch: &str,
		_title: &str,
		_body: &str,
	) -> Result<ForgePr, ForgeError> {
		// Record the created PR and expose it as the live PR for subsequent calls.
		let pr = ForgePr {
			id:          format!("pr-for-{head_branch}"),
			number:      4242,
			head_sha:    self
				.work_branch_sha
				.lock()
				.unwrap()
				.clone()
				.unwrap_or_else(|| "sha1".to_owned()),
			base_branch: base_branch.to_owned(),
		};
		self
			.created_prs
			.lock()
			.unwrap()
			.push((head_branch.to_owned(), base_branch.to_owned()));
		self
			.prs
			.lock()
			.unwrap()
			.insert(pr.number.to_string(), pr.clone());
		Ok(pr)
	}

	async fn fetch_merge_signals(
		&self,
		_pr_id: &str,
		_head_sha: &str,
	) -> Result<MergeSignals, ForgeError> {
		self
			.merge_signals
			.lock()
			.unwrap()
			.clone()
			.ok_or_else(|| ForgeError::Transient("no merge signals seeded".to_owned()))
	}

	async fn get_branch_protection(&self, _base_branch: &str) -> Result<bool, ForgeError> {
		if *self.protection_unreadable.lock().unwrap() {
			return Err(ForgeError::Transient("branch protection unreadable".to_owned()));
		}
		Ok(false)
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
		self
			.comments
			.lock()
			.unwrap()
			.push((item_id.to_owned(), body.to_owned()));
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		config::MergePolicy,
		merge_gate::{GateInputs, evaluate},
	};

	fn pr(head: &str) -> ForgePr {
		ForgePr {
			id:          "PR_7".into(),
			number:      7,
			head_sha:    head.into(),
			base_branch: "dev".into(),
		}
	}

	fn policy() -> MergePolicy {
		MergePolicy { protected_branches: vec![], allowed_dev_branches: vec!["dev".into()] }
	}

	#[tokio::test]
	async fn merge_enforces_expected_head_sha() {
		let forge = FakeForge::new();
		forge.put_pr(pr("sha1"));
		// Correct expected SHA merges.
		let ok = forge
			.merge_pr(&MergeRequest {
				pr_id:             "PR_7".into(),
				expected_head_sha: "sha1".into(),
			})
			.await;
		assert_eq!(ok, Ok("merge-sha1".into()));
		// A stale expected SHA fails closed.
		let stale = forge
			.merge_pr(&MergeRequest {
				pr_id:             "PR_7".into(),
				expected_head_sha: "sha0".into(),
			})
			.await;
		assert_eq!(stale, Err(ForgeError::ShaMismatch));
	}

	#[tokio::test]
	async fn gate_pass_then_sha_bound_merge_succeeds() {
		let forge = FakeForge::new();
		forge.put_pr(pr("sha1"));
		// Pre-merge refetch.
		let live = forge.get_pr("PR_7").await.unwrap();
		let inputs = GateInputs {
			queued_head_sha:         "sha1",
			current_head_sha:        &live.head_sha,
			queued_base_branch:      &live.base_branch,
			base_branch:             &live.base_branch,
			branch_protection_known: true,
			base_is_protected:       false,
			ci_green:                true,
			ultragoal_pass:          true,
			reviews_resolved:        true,
			diff_within_budget:      true,
			diff_in_scope:           true,
		};
		let decision = evaluate(&inputs, &policy());
		assert!(decision.may_merge());
		// Merge with the decision's bound head SHA.
		let merged = forge
			.merge_pr(&MergeRequest {
				pr_id:             "PR_7".into(),
				expected_head_sha: decision.head_sha,
			})
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
		let stale = forge
			.merge_pr(&MergeRequest {
				pr_id:             "PR_7".into(),
				expected_head_sha: "sha1".into(),
			})
			.await;
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
