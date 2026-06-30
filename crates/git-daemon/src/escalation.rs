//! Human-escalation summaries and no-op acknowledgement.
//!
//! Humans are the exception path, not the happy path. When the daemon cannot
//! proceed autonomously (a gate denial that is not self-correctable, a lost run
//! stream, or a hard run failure) it posts a structured escalation comment so a
//! maintainer has the full context. For a discretionary no-op it instead leaves
//! an acknowledgement reaction and enters the watching state (D1).

use crate::merge_gate::DenyReason;

/// Reaction left to acknowledge a no-op / watching decision (GitHub reaction
/// content name). Signals "seen, watching for an actionable follow-up".
pub const ACK_REACTION: &str = "eyes";

/// Why the daemon escalated to a human.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EscalationReason {
	/// The merge gate denied in a way the daemon will not auto-resolve.
	GateDenied(DenyReason),
	/// The unattended run stream was lost and could not be recovered.
	StreamLost,
	/// The unattended run failed (error, not a gate denial).
	RunFailed,
}

impl EscalationReason {
	/// A short, stable code for status/metrics.
	#[must_use]
	pub const fn code(&self) -> &'static str {
		match self {
			Self::GateDenied(reason) => match reason {
				DenyReason::StaleHead => "gate_stale_head",
				DenyReason::BranchProtectionUnknown => "gate_protection_unknown",
				DenyReason::MainBranchDenied => "gate_main_branch",
				DenyReason::ProtectedBranch => "gate_protected_branch",
				DenyReason::NotAnAllowedDevBranch => "gate_not_allowed_branch",
				DenyReason::CiNotGreen => "gate_ci_not_green",
				DenyReason::UltragoalFailed => "gate_ultragoal_failed",
				DenyReason::ReviewUnresolved => "gate_review_unresolved",
				DenyReason::DiffTooLarge => "gate_diff_too_large",
				DenyReason::ScopeViolation => "gate_scope_violation",
			},
			Self::StreamLost => "stream_lost",
			Self::RunFailed => "run_failed",
		}
	}

	/// Human-readable explanation of the escalation.
	#[must_use]
	pub const fn explanation(&self) -> &'static str {
		match self {
			Self::GateDenied(DenyReason::MainBranchDenied | DenyReason::ProtectedBranch) => {
				"The change targets a protected branch, which this daemon never merges autonomously."
			}
			Self::GateDenied(DenyReason::CiNotGreen) => "CI is not green; a human should review the failures.",
			Self::GateDenied(DenyReason::DiffTooLarge) => "The diff exceeds the size/risk budget for autonomous merge.",
			Self::GateDenied(DenyReason::ScopeViolation) => "The diff touches files outside the issue's scope.",
			Self::GateDenied(_) => "The merge gate denied the change and it is not auto-correctable.",
			Self::StreamLost => "The run stream was lost and could not be recovered; please check the run.",
			Self::RunFailed => "The autonomous run failed; manual attention is needed.",
		}
	}
}

/// Build a structured escalation comment for an item.
#[must_use]
pub fn escalation_comment(item_node_id: &str, reason: &EscalationReason, detail: &str) -> String {
	format!(
		"⚠️ git-daemon escalation\n\nItem: {item_node_id}\nReason: {} ({})\n{}\n\nDetail: {detail}\n\nThis item is paused for human attention; reply or push a fix to re-engage.",
		reason.code(),
		match reason {
			EscalationReason::GateDenied(_) => "merge gate",
			EscalationReason::StreamLost => "stream",
			EscalationReason::RunFailed => "run",
		},
		reason.explanation(),
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ack_reaction_is_eyes() {
		assert_eq!(ACK_REACTION, "eyes");
	}

	#[test]
	fn codes_are_stable_and_distinct() {
		let protected = EscalationReason::GateDenied(DenyReason::ProtectedBranch);
		let main = EscalationReason::GateDenied(DenyReason::MainBranchDenied);
		assert_eq!(protected.code(), "gate_protected_branch");
		assert_eq!(main.code(), "gate_main_branch");
		assert_eq!(EscalationReason::StreamLost.code(), "stream_lost");
		assert_eq!(EscalationReason::RunFailed.code(), "run_failed");
	}

	#[test]
	fn comment_includes_item_reason_and_detail() {
		let reason = EscalationReason::GateDenied(DenyReason::CiNotGreen);
		let body = escalation_comment("I_42", &reason, "3 failing tests in suite X");
		assert!(body.contains("I_42"));
		assert!(body.contains("gate_ci_not_green"));
		assert!(body.contains("CI is not green"));
		assert!(body.contains("3 failing tests in suite X"));
	}

	#[test]
	fn protected_branch_explanation_is_specific() {
		let reason = EscalationReason::GateDenied(DenyReason::ProtectedBranch);
		assert!(reason.explanation().contains("protected branch"));
	}
}
