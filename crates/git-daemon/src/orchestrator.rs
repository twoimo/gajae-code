//! Per-item work orchestration: lock → run → SHA-bound gate → merge.
//!
//! This is the e2e seam that composes the safety pieces. It is generic over the
//! [`ForgeAdapter`] and a [`WorkRunner`] (the unattended engine), so it is
//! integration-tested with in-memory fakes — exercising the real lock, gate,
//! and merge invariants without a network or the live TS engine.

use crate::{
	config::MergePolicy,
	forge_adapter::{ForgeAdapter, MergeRequest},
	keys::ItemRef,
	merge_gate::{DenyReason, GateInputs, evaluate},
	state_machine::WorkItemState,
	store::{GitDaemonStateStore, StoreError},
};

/// Outcome of an unattended engine run.
///
/// Carries whether the run completed successfully plus the observed usage (D3).
/// PR discovery + merge-gate signals are NOT part of this — the orchestrator
/// derives those from the forge after the run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
	pub succeeded: bool,
	pub usage:     crate::spend_ledger::UsageObservation,
}

/// The unattended engine seen by the orchestrator.
///
/// The real implementation drives the TS engine over gjc-rpc in unbounded mode
/// (D3) and consumes its event stream to completion; the test fake returns a
/// canned [`RunOutcome`].
#[allow(async_fn_in_trait, reason = "internal trait with in-crate impls; no Send bound needed yet")]
pub trait WorkRunner {
	async fn run(&self, work_key: &str) -> RunOutcome;
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
	/// The run completed but opened no discoverable PR; escalated, nothing
	/// merged.
	NoPrOpened,
	/// Another worker holds a live lease on this item.
	LockBusy,
	/// The forge could not return live PR state for the SHA-bound refetch.
	RefetchFailed,
	/// The immutable SHA-bound merge evidence could not be persisted; the merge
	/// is denied (evidence-write-failure fails closed).
	EvidenceWriteFailed,
}

/// Drive one item from lock acquisition through a SHA-bound merge decision.
///
/// The lock is released after settlement regardless of outcome. The merge call
/// (when allowed) always passes the gate's bound head SHA so a race fails
/// closed.
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
	let lock = match store.acquire_lock(&item.lock_key(), "git-daemon-worker", now, lease_expires_at)
	{
		Ok(guard) => guard,
		Err(StoreError::LeaseConflict) => return Ok(DriveOutcome::LockBusy),
		Err(e) => return Err(e),
	};
	let outcome = run_and_merge(store, forge, runner, work_key, policy, now).await?;
	// Settle the work item out of the ready set so a later reconciliation tick
	// cannot reselect and re-run/re-merge the same key. A merge is terminal
	// (merged_dev); any other completed run escalates (a follow-up event will
	// re-queue it via the dispatcher). A lock conflict never reaches here.
	let settled = match &outcome {
		DriveOutcome::Merged { .. } => Some(WorkItemState::MergedDev),
		DriveOutcome::GateDenied(_)
		| DriveOutcome::RunFailed
		| DriveOutcome::NoPrOpened
		| DriveOutcome::RefetchFailed
		| DriveOutcome::EvidenceWriteFailed => Some(WorkItemState::Escalated),
		DriveOutcome::LockBusy => None,
	};
	if let Some(state) = settled {
		store.set_work_state(work_key, state, now)?;
	}
	// Release only after the run/merge has settled (D3/D4: no budget/cap abort).
	store.release_lock(&lock)?;
	Ok(outcome)
}

#[allow(
	clippy::future_not_send,
	reason = "driven on a per-item task; no cross-thread Send boundary committed yet"
)]
async fn run_and_merge<F: ForgeAdapter, R: WorkRunner>(
	store: &GitDaemonStateStore,
	forge: &F,
	runner: &R,
	work_key: &str,
	policy: &MergePolicy,
	now: &str,
) -> Result<DriveOutcome, StoreError> {
	let run = runner.run(work_key).await;
	if !run.succeeded {
		return Ok(DriveOutcome::RunFailed);
	}
	// The run (a coding agent) resolves the issue and pushes a branch on the
	// daemon's head-branch convention. Discover its PR via the forge; if the run
	// pushed the branch but did not open a PR, the DAEMON opens it (PR creation
	// and merge are the daemon's forge operations, not the agent's). PR/gate
	// signals are the daemon's GitHub observations, never engine events.
	let base = policy
		.allowed_dev_branches
		.first()
		.map_or("dev", String::as_str);
	let pr = match forge.find_work_pr(work_key).await {
		Ok(Some(pr)) => pr,
		Ok(None) => match forge.find_work_branch(work_key).await {
			Ok(Some(head)) => {
				let title = format!("git-daemon: resolve {work_key}");
				let body = format!("Autonomous resolution by git-daemon for `{work_key}`.");
				match forge.create_pr(&head, base, &title, &body).await {
					Ok(pr) => pr,
					Err(_) => return Ok(DriveOutcome::RefetchFailed),
				}
			},
			Ok(None) => return Ok(DriveOutcome::NoPrOpened),
			Err(_) => return Ok(DriveOutcome::RefetchFailed),
		},
		Err(_) => return Ok(DriveOutcome::RefetchFailed),
	};
	let pr_ref = pr.number.to_string();
	// Immediate pre-merge refetch (SHA-bound) + live gate signals from the forge.
	let Ok(live) = forge.get_pr(&pr_ref).await else {
		return Ok(DriveOutcome::RefetchFailed);
	};
	let protection = forge.get_branch_protection(&live.base_branch).await;
	let branch_protection_known = protection.is_ok();
	let base_is_protected = protection.unwrap_or(false);
	let Ok(signals) = forge.fetch_merge_signals(&pr_ref, &live.head_sha).await else {
		return Ok(DriveOutcome::RefetchFailed);
	};
	let inputs = GateInputs {
		queued_head_sha: &pr.head_sha,
		current_head_sha: &live.head_sha,
		queued_base_branch: &pr.base_branch,
		base_branch: &live.base_branch,
		branch_protection_known,
		base_is_protected,
		ci_green: signals.ci_green,
		// The daemon's own verification signal is the unattended run completing.
		ultragoal_pass: run.succeeded,
		reviews_resolved: signals.reviews_resolved,
		diff_within_budget: signals.diff_within_budget,
		diff_in_scope: signals.diff_in_scope,
	};
	let decision = evaluate(&inputs, policy);
	// Persist the immutable, SHA-bound evidence BEFORE any merge call. A write
	// failure denies the merge (fails closed) — we never merge without a record.
	let reason = decision.reason.map(|r| format!("{r:?}"));
	if store
		.persist_merge_evidence(
			work_key,
			&decision.head_sha,
			&decision.base_branch,
			decision.allow,
			reason.as_deref(),
			now,
		)
		.is_err()
	{
		return Ok(DriveOutcome::EvidenceWriteFailed);
	}
	if !decision.may_merge() {
		return Ok(decision
			.reason
			.map_or(DriveOutcome::RunFailed, DriveOutcome::GateDenied));
	}
	Ok(
		match forge
			.merge_pr(&MergeRequest {
				pr_id:             pr_ref,
				expected_head_sha: decision.head_sha,
			})
			.await
		{
			Ok(merge_sha) => DriveOutcome::Merged { merge_sha },
			Err(_) => DriveOutcome::GateDenied(DenyReason::StaleHead),
		},
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{
		forge_adapter::{FakeForge, ForgePr, MergeSignals},
		keys::ItemKind,
		spend_ledger::UsageObservation,
	};

	struct FakeRunner {
		outcome: RunOutcome,
	}

	impl WorkRunner for FakeRunner {
		async fn run(&self, _work_key: &str) -> RunOutcome {
			self.outcome.clone()
		}
	}

	fn outcome(ok: bool) -> RunOutcome {
		RunOutcome { succeeded: ok, usage: UsageObservation::default() }
	}

	fn item() -> ItemRef {
		ItemRef::new("github", "R_1", ItemKind::Issue, "I_9")
	}

	fn dev_policy() -> MergePolicy {
		MergePolicy { protected_branches: vec![], allowed_dev_branches: vec!["dev".into()] }
	}

	/// A PR keyed by its number (`FakeForge::get_pr` looks up by the number
	/// string the orchestrator passes).
	fn pr(number: u64, head: &str, base: &str) -> ForgePr {
		ForgePr { id: number.to_string(), number, head_sha: head.into(), base_branch: base.into() }
	}

	fn good_signals() -> MergeSignals {
		MergeSignals {
			ci_green:           true,
			reviews_resolved:   true,
			diff_within_budget: true,
			diff_in_scope:      true,
		}
	}

	/// Drive with a queued PR (what `find_work_pr` returns), a live PR (what the
	/// pre-merge `get_pr` refetch returns), merge signals, and a run outcome.
	#[allow(clippy::future_not_send, reason = "test helper driven on one task")]
	async fn run_with(
		work_pr: ForgePr,
		live_pr: ForgePr,
		signals: MergeSignals,
		run: RunOutcome,
		policy: &MergePolicy,
	) -> (DriveOutcome, FakeForge) {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = FakeForge::new();
		forge.set_work_pr(work_pr);
		forge.put_pr(live_pr);
		forge.set_merge_signals(signals);
		let runner = FakeRunner { outcome: run };
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
		let (out, forge) = run_with(
			pr(7, "sha1", "dev"),
			pr(7, "sha1", "dev"),
			good_signals(),
			outcome(true),
			&dev_policy(),
		)
		.await;
		assert_eq!(out, DriveOutcome::Merged { merge_sha: "merge-sha1".into() });
		assert_eq!(forge.merged(), vec!["7".to_owned()]);
	}

	#[tokio::test]
	async fn daemon_opens_pr_from_pushed_branch_then_merges() {
		// The run pushed a git-daemon/ branch but opened no PR; the DAEMON opens
		// it and merges. No work_pr seeded -> find_work_pr None -> find_work_branch.
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = FakeForge::new();
		let branch = crate::keys::work_branch_ref("wk"); // the run's bound ref
		forge.set_work_branch(&branch, "sha1");
		forge.put_pr(pr(4242, "sha1", "dev")); // the PR create_pr will expose (number 4242)
		forge.set_merge_signals(good_signals());
		let runner = FakeRunner { outcome: outcome(true) };
		let out =
			drive_to_merge(&mut store, &forge, &runner, &item(), "wk", &dev_policy(), "t0", "t9")
				.await
				.unwrap();
		assert_eq!(out, DriveOutcome::Merged { merge_sha: "merge-sha1".into() });
		assert_eq!(forge.created_prs(), vec![(branch, "dev".to_owned())]);
		assert_eq!(forge.merged(), vec!["4242".to_owned()]);
	}

	#[tokio::test]
	async fn failed_run_escalates_before_pr_lookup() {
		let (out, forge) = run_with(
			pr(7, "sha1", "dev"),
			pr(7, "sha1", "dev"),
			good_signals(),
			outcome(false),
			&dev_policy(),
		)
		.await;
		assert_eq!(out, DriveOutcome::RunFailed);
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn no_pr_opened_escalates() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = FakeForge::new(); // no work_pr seeded -> find_work_pr returns None
		let runner = FakeRunner { outcome: outcome(true) };
		let out =
			drive_to_merge(&mut store, &forge, &runner, &item(), "wk", &dev_policy(), "t0", "t9")
				.await
				.unwrap();
		assert_eq!(out, DriveOutcome::NoPrOpened);
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn protected_base_is_denied_and_never_merged() {
		let (out, forge) = run_with(
			pr(7, "sha1", "main"),
			pr(7, "sha1", "main"),
			good_signals(),
			outcome(true),
			&dev_policy(),
		)
		.await;
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::MainBranchDenied));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn base_retarget_between_queue_and_merge_denies() {
		let policy = MergePolicy {
			protected_branches:   vec![],
			allowed_dev_branches: vec!["dev".into(), "dev2".into()],
		};
		let (out, forge) = run_with(
			pr(7, "sha1", "dev"),
			pr(7, "sha1", "dev2"),
			good_signals(),
			outcome(true),
			&policy,
		)
		.await;
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::BaseChanged));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn stale_head_between_run_and_refetch_denies() {
		// Queued head sha1; the pre-merge refetch sees sha2.
		let (out, forge) = run_with(
			pr(7, "sha1", "dev"),
			pr(7, "sha2", "dev"),
			good_signals(),
			outcome(true),
			&dev_policy(),
		)
		.await;
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::StaleHead));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn failing_ci_denies_merge() {
		let mut signals = good_signals();
		signals.ci_green = false;
		let (out, forge) = run_with(
			pr(7, "sha1", "dev"),
			pr(7, "sha1", "dev"),
			signals,
			outcome(true),
			&dev_policy(),
		)
		.await;
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::CiNotGreen));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn unknown_branch_protection_fails_closed() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = FakeForge::new();
		forge.set_work_pr(pr(7, "sha1", "dev"));
		forge.put_pr(pr(7, "sha1", "dev"));
		forge.set_merge_signals(good_signals());
		forge.set_protection_unreadable();
		let runner = FakeRunner { outcome: outcome(true) };
		let out =
			drive_to_merge(&mut store, &forge, &runner, &item(), "wk", &dev_policy(), "t0", "t9")
				.await
				.unwrap();
		assert_eq!(out, DriveOutcome::GateDenied(DenyReason::BranchProtectionUnknown));
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn evidence_write_failure_denies_merge() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = FakeForge::new();
		forge.set_work_pr(pr(7, "sha1", "dev"));
		forge.put_pr(pr(7, "sha1", "dev"));
		forge.set_merge_signals(good_signals());
		// Pre-record evidence for the same (work_key, head) so the write conflicts.
		store
			.persist_merge_evidence("wk", "sha1", "dev", true, None, "t0")
			.unwrap();
		let runner = FakeRunner { outcome: outcome(true) };
		let out =
			drive_to_merge(&mut store, &forge, &runner, &item(), "wk", &dev_policy(), "t0", "t9")
				.await
				.unwrap();
		assert_eq!(out, DriveOutcome::EvidenceWriteFailed);
		assert!(forge.merged().is_empty(), "must not merge without persisted evidence");
	}

	#[tokio::test]
	async fn merge_settles_work_item_so_it_is_not_reselected() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = FakeForge::new();
		forge.set_work_pr(pr(7, "sha1", "dev"));
		forge.put_pr(pr(7, "sha1", "dev"));
		forge.set_merge_signals(good_signals());
		let it = ItemRef::new("github", "R_1", ItemKind::Issue, "I_9");
		let wk = it.work_intent_key("resolve");
		store.record_work_intent(&wk, "issue", "I_9", "t0").unwrap();
		assert_eq!(store.list_ready_work(10).unwrap().len(), 1);
		let runner = FakeRunner { outcome: outcome(true) };
		let out =
			drive_to_merge(&mut store, &forge, &runner, &it, wk.as_str(), &dev_policy(), "t0", "t9")
				.await
				.unwrap();
		assert!(matches!(out, DriveOutcome::Merged { .. }));
		assert!(
			store.list_ready_work(10).unwrap().is_empty(),
			"merged item must leave the ready set"
		);
	}
}
