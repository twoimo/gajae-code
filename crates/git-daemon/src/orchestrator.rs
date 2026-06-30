//! Per-item work orchestration: lock → run → SHA-bound gate → merge.
//!
//! This is the e2e seam that composes the safety pieces. It is generic over the
//! [`ForgeAdapter`] and a [`WorkRunner`] (the unattended engine), so it is
//! integration-tested with in-memory fakes — exercising the real lock, gate, and
//! merge invariants without a network or the live TS engine.

use crate::config::MergePolicy;
use crate::forge_adapter::{ForgeAdapter, MergeRequest};
use crate::keys::ItemRef;
use crate::merge_gate::{DenyReason, GateInputs, evaluate};
use crate::store::{GitDaemonStateStore, StoreError};

/// Outcome of an unattended run, including the live gate signals it produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
	pub succeeded: bool,
	pub pr_id: String,
	/// Head SHA the run produced (the queued head for the gate decision).
	pub head_sha: String,
	pub ci_green: bool,
	pub ultragoal_pass: bool,
	pub reviews_resolved: bool,
	pub diff_within_budget: bool,
	pub diff_in_scope: bool,
}

/// The unattended engine seen by the orchestrator. The real implementation
/// drives the TS engine over gjc-rpc in unbounded mode (D3); the test fake
/// returns a canned [`RunResult`].
#[allow(async_fn_in_trait, reason = "internal trait with in-crate impls; no Send bound needed yet")]
pub trait WorkRunner {
	async fn run(&self, work_key: &str) -> RunResult;
}

/// What the orchestrator did for one item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriveOutcome {
	/// Merged to a non-protected dev branch; carries the merge commit SHA.
	Merged { merge_sha: String },
	/// The merge gate denied the merge (no merge call was made).
	GateDenied(DenyReason),
	/// The unattended run did not succeed; escalated, nothing merged.
	RunFailed,
	/// Another worker holds a live lease on this item.
	LockBusy,
	/// The forge could not return live PR state for the SHA-bound refetch.
	RefetchFailed,
}

/// Drive one item from lock acquisition through a SHA-bound merge decision.
///
/// The lock is released after settlement regardless of outcome. The merge call
/// (when allowed) always passes the gate's bound head SHA so a race fails closed.
///
/// # Errors
/// Returns [`StoreError`] on a store failure other than a live-lease conflict
/// (which is surfaced as [`DriveOutcome::LockBusy`]).
#[allow(
	clippy::future_not_send,
	reason = "driven on a per-item task; no cross-thread Send boundary committed yet"
)]
pub async fn drive_to_merge<F: ForgeAdapter, R: WorkRunner>(
	store: &mut GitDaemonStateStore,
	forge: &F,
	runner: &R,
	item: &ItemRef,
	work_key: &str,
	policy: &MergePolicy,
	now: &str,
	lease_expires_at: &str,
) -> Result<DriveOutcome, StoreError> {
	let lock = match store.acquire_lock(&item.lock_key(), "git-daemon-worker", now, lease_expires_at) {
		Ok(guard) => guard,
		Err(StoreError::LeaseConflict) => return Ok(DriveOutcome::LockBusy),
		Err(e) => return Err(e),
	};
	let outcome = run_and_merge(forge, runner, work_key, policy).await;
	// Release only after the run/merge has settled (D3/D4: no budget/cap abort).
	store.release_lock(&lock)?;
	Ok(outcome)
}

#[allow(
	clippy::future_not_send,
	reason = "driven on a per-item task; no cross-thread Send boundary committed yet"
)]
async fn run_and_merge<F: ForgeAdapter, R: WorkRunner>(
	forge: &F,
	runner: &R,
	work_key: &str,
	policy: &MergePolicy,
) -> DriveOutcome {
	let run = runner.run(work_key).await;
	if !run.succeeded {
		return DriveOutcome::RunFailed;
	}
	// Immediate pre-merge refetch (SHA-bound).
	let Ok(live) = forge.get_pr(&run.pr_id).await else {
		return DriveOutcome::RefetchFailed;
	};
	let inputs = GateInputs {
		queued_head_sha: &run.head_sha,
		current_head_sha: &live.head_sha,
		base_branch: &live.base_branch,
		branch_protection_known: true,
		ci_green: run.ci_green,
		ultragoal_pass: run.ultragoal_pass,
		reviews_resolved: run.reviews_resolved,
		diff_within_budget: run.diff_within_budget,
		diff_in_scope: run.diff_in_scope,
	};
	let decision = evaluate(&inputs, policy);
	if !decision.may_merge() {
		return decision.reason.map_or(DriveOutcome::RunFailed, DriveOutcome::GateDenied);
	}
	match forge.merge_pr(&MergeRequest { pr_id: run.pr_id, expected_head_sha: decision.head_sha }).await {
		Ok(merge_sha) => DriveOutcome::Merged { merge_sha },
		Err(_) => DriveOutcome::GateDenied(DenyReason::StaleHead),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::forge_adapter::{FakeForge, ForgePr};
	use crate::keys::ItemKind;

	struct FakeRunner {
		result: RunResult,
	}

	impl WorkRunner for FakeRunner {
		async fn run(&self, _work_key: &str) -> RunResult {
			self.result.clone()
		}
	}

	fn good_run(head: &str) -> RunResult {
		RunResult {
			succeeded: true,
			pr_id: "PR_7".into(),
			head_sha: head.into(),
			ci_green: true,
			ultragoal_pass: true,
			reviews_resolved: true,
			diff_within_budget: true,
			diff_in_scope: true,
		}
	}

	fn item() -> ItemRef {
		ItemRef::new("github", "R_1", ItemKind::Issue, "I_9")
	}

	fn dev_policy() -> MergePolicy {
		MergePolicy { protected_branches: vec![], allowed_dev_branches: vec!["dev".into()] }
	}

	fn pr(head: &str, base: &str) -> ForgePr {
		ForgePr { id: "PR_7".into(), number: 7, head_sha: head.into(), base_branch: base.into() }
	}

	async fn run_with(pr: ForgePr, run: RunResult, policy: &MergePolicy) -> (DriveOutcome, FakeForge) {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = FakeForge::new();
		forge.put_pr(pr);
		let runner = FakeRunner { result: run };
		let out = drive_to_merge(
			&mut store,
			&forge,
			&runner,
			&item(),
			"work:github:R_1:issue:I_9:resolve",
			policy,
			"2026-01-01T00:00:00Z",
			"2026-01-01T01:00:00Z",
		)
		.await
		.unwrap();
		(out, forge)
	}

	#[tokio::test]
	async fn happy_path_merges_to_dev() {
		let (out, forge) = run_with(pr("sha1", "dev"), good_run("sha1"), &dev_policy()).await;
		assert_eq!(out, DriveOutcome::Merged { merge_sha: "merge-sha1".into() });
		assert_eq!(forge.merged(), vec!["PR_7".to_owned()]);
	}

	#[tokio::test]
	async fn protected_base_is_denied_and_never_merged() {
		let (out, forge) = run_with(pr("sha1", "main"), good_run("sha1"), &dev_policy()).await;
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::MainBranchDenied));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn stale_head_between_run_and_refetch_denies() {
		let (out, forge) = run_with(pr("sha2", "dev"), good_run("sha1"), &dev_policy()).await;
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::StaleHead));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn failing_ci_denies_merge() {
		let mut run = good_run("sha1");
		run.ci_green = false;
		let (out, forge) = run_with(pr("sha1", "dev"), run, &dev_policy()).await;
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::CiNotGreen));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn failed_run_escalates_without_merge() {
		let mut run = good_run("sha1");
		run.succeeded = false;
		let (out, forge) = run_with(pr("sha1", "dev"), run, &dev_policy()).await;
		assert_eq!(out, DriveOutcome::RunFailed);
		assert!(forge.merged().is_empty());
	}
}
