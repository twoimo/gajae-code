//! SHA-bound, fail-closed merge gate.
//!
//! The preliminary gate is never authority to merge. Immediately before merging,
//! the daemon refetches live PR state and recomputes this decision bound to the
//! *current* head SHA. Any change, unknown branch protection, protected/main
//! target, or failing condition denies the merge. The merge call must then pass
//! the expected head SHA so a race between decision and merge also fails closed.

use crate::config::MergePolicy;

/// Live inputs captured at the immediate pre-merge refetch.
#[derive(Debug, Clone)]
pub struct GateInputs<'a> {
	/// Head SHA recorded when the item entered `merge_ready`.
	pub queued_head_sha: &'a str,
	/// Head SHA observed in the immediate pre-merge refetch.
	pub current_head_sha: &'a str,
	/// Target branch of the PR.
	pub base_branch: &'a str,
	/// Live branch protection state; `None` means it could not be fetched.
	pub branch_protection_known: bool,
	/// All required CI/checks are green.
	pub ci_green: bool,
	/// An ultragoal verification pass confirms the PR satisfies the issue.
	pub ultragoal_pass: bool,
	/// No unresolved review threads and no human `request changes`.
	pub reviews_resolved: bool,
	/// Diff is within the configured size/risk budget.
	pub diff_within_budget: bool,
	/// Diff touches only in-scope files (no out-of-scope/infra/secret edits).
	pub diff_in_scope: bool,
}

/// Why a merge was denied (fail-closed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
	/// Head SHA changed between `merge_ready` and the pre-merge refetch.
	StaleHead,
	/// Branch protection could not be fetched — refuse rather than guess.
	BranchProtectionUnknown,
	/// Target is `main`/`master`.
	MainBranchDenied,
	/// Target is a configured protected branch.
	ProtectedBranch,
	/// Target is not in the allowed dev-branch list.
	NotAnAllowedDevBranch,
	CiNotGreen,
	UltragoalFailed,
	ReviewUnresolved,
	DiffTooLarge,
	ScopeViolation,
}

/// The immutable, SHA-bound gate decision (persisted before the merge attempt).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateDecision {
	pub allow: bool,
	pub reason: Option<DenyReason>,
	/// The head SHA the merge must be performed against (`expected head`).
	pub head_sha: String,
	pub base_branch: String,
}

impl GateDecision {
	/// Whether it is safe to call the forge merge API with `head_sha`.
	#[must_use]
	pub const fn may_merge(&self) -> bool {
		self.allow
	}
}

/// Evaluate the merge gate. Checks run in fail-closed priority order so the most
/// fundamental safety violations are reported first.
#[must_use]
pub fn evaluate(inputs: &GateInputs<'_>, policy: &MergePolicy) -> GateDecision {
	let deny = |reason: DenyReason| GateDecision {
		allow: false,
		reason: Some(reason),
		head_sha: inputs.current_head_sha.to_owned(),
		base_branch: inputs.base_branch.to_owned(),
	};

	// 1. SHA-bound: the queued decision is void if the head moved.
	if inputs.queued_head_sha != inputs.current_head_sha {
		return deny(DenyReason::StaleHead);
	}
	// 2. Fail closed when protection is unknown.
	if !inputs.branch_protection_known {
		return deny(DenyReason::BranchProtectionUnknown);
	}
	// 3. Never merge to main/master.
	if inputs.base_branch == "main" || inputs.base_branch == "master" {
		return deny(DenyReason::MainBranchDenied);
	}
	// 4. Never merge to a configured protected branch.
	if policy.protected_branches.iter().any(|b| b == inputs.base_branch) {
		return deny(DenyReason::ProtectedBranch);
	}
	// 5. Only merge to an allowed dev branch.
	if !policy.allowed_dev_branches.iter().any(|b| b == inputs.base_branch) {
		return deny(DenyReason::NotAnAllowedDevBranch);
	}
	// 6-9. The five ultragoal-LGTM conditions.
	if !inputs.ci_green {
		return deny(DenyReason::CiNotGreen);
	}
	if !inputs.ultragoal_pass {
		return deny(DenyReason::UltragoalFailed);
	}
	if !inputs.reviews_resolved {
		return deny(DenyReason::ReviewUnresolved);
	}
	if !inputs.diff_within_budget {
		return deny(DenyReason::DiffTooLarge);
	}
	if !inputs.diff_in_scope {
		return deny(DenyReason::ScopeViolation);
	}
	GateDecision {
		allow: true,
		reason: None,
		head_sha: inputs.current_head_sha.to_owned(),
		base_branch: inputs.base_branch.to_owned(),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn policy() -> MergePolicy {
		MergePolicy {
			protected_branches: vec!["release".into()],
			allowed_dev_branches: vec!["dev".into()],
		}
	}

	fn all_pass<'a>() -> GateInputs<'a> {
		GateInputs {
			queued_head_sha: "sha1",
			current_head_sha: "sha1",
			base_branch: "dev",
			branch_protection_known: true,
			ci_green: true,
			ultragoal_pass: true,
			reviews_resolved: true,
			diff_within_budget: true,
			diff_in_scope: true,
		}
	}

	#[test]
	fn all_conditions_pass_allows_merge_to_dev() {
		let d = evaluate(&all_pass(), &policy());
		assert!(d.may_merge());
		assert_eq!(d.reason, None);
		assert_eq!(d.head_sha, "sha1");
	}

	#[test]
	fn current_head_race_denies() {
		let mut i = all_pass();
		i.current_head_sha = "sha2"; // head moved after merge_ready
		let d = evaluate(&i, &policy());
		assert!(!d.may_merge());
		assert_eq!(d.reason, Some(DenyReason::StaleHead));
		// Evidence binds to the *current* head so a later merge can't use sha1.
		assert_eq!(d.head_sha, "sha2");
	}

	#[test]
	fn unknown_protection_fails_closed() {
		let mut i = all_pass();
		i.branch_protection_known = false;
		assert_eq!(evaluate(&i, &policy()).reason, Some(DenyReason::BranchProtectionUnknown));
	}

	#[test]
	fn never_merges_main_master_or_protected() {
		for (branch, reason) in [
			("main", DenyReason::MainBranchDenied),
			("master", DenyReason::MainBranchDenied),
			("release", DenyReason::ProtectedBranch),
		] {
			let mut i = all_pass();
			i.base_branch = branch;
			assert_eq!(evaluate(&i, &policy()).reason, Some(reason), "branch {branch}");
		}
	}

	#[test]
	fn non_allowed_dev_branch_denied() {
		let mut i = all_pass();
		i.base_branch = "feature/x";
		assert_eq!(evaluate(&i, &policy()).reason, Some(DenyReason::NotAnAllowedDevBranch));
	}

	#[test]
	fn each_lgtm_condition_denies() {
		for (mutate, reason) in [
			((|i: &mut GateInputs| i.ci_green = false) as fn(&mut GateInputs), DenyReason::CiNotGreen),
			(|i: &mut GateInputs| i.ultragoal_pass = false, DenyReason::UltragoalFailed),
			(|i: &mut GateInputs| i.reviews_resolved = false, DenyReason::ReviewUnresolved),
			(|i: &mut GateInputs| i.diff_within_budget = false, DenyReason::DiffTooLarge),
			(|i: &mut GateInputs| i.diff_in_scope = false, DenyReason::ScopeViolation),
		] {
			let mut i = all_pass();
			mutate(&mut i);
			assert_eq!(evaluate(&i, &policy()).reason, Some(reason));
		}
	}
}
