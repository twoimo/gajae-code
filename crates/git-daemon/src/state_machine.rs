//! Work-item lifecycle and its legal transitions.
//!
//! Honors the reconciled intent: no eligibility filter (every ingested item is
//! `queued`, D1), `revising` may loop indefinitely (no self-revision cap, D4),
//! and `stream_lost` is **non-terminal** — it is only resolved by reconnect,
//! operator action, or stale-lease takeover, never auto-completed.

use serde::{Deserialize, Serialize};

/// States a work item can occupy. `MergedDev` and `Closed` are terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemState {
	/// Event ingested, no scheduling decision yet.
	Seen,
	/// Actionable and waiting for a worker / lock.
	Queued,
	/// Item lock held and an unattended run is active.
	Running,
	/// A daemon PR exists for the source item.
	PrOpen,
	/// PR head submitted; CI/checks pending.
	AwaitingCi,
	/// Self-revision in progress (CI / review / scope fix). May loop forever.
	Revising,
	/// Preliminary gate passed; awaiting the SHA-bound pre-merge refetch.
	MergeReady,
	/// Merged to a configured non-protected branch (success terminal).
	MergedDev,
	/// Escalated to a human; paused unless a new allowed follow-up arrives.
	Escalated,
	/// Blocked on a hard external dependency (secret, permission, protection).
	Blocked,
	/// The unattended run's stream was lost; needs recovery (non-terminal).
	StreamLost,
	/// Source item no longer actionable (terminal).
	Closed,
}

/// Returned when an illegal state transition is attempted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionError {
	pub from: WorkItemState,
	pub to: WorkItemState,
}

impl core::fmt::Display for TransitionError {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		write!(f, "illegal work-item transition: {:?} -> {:?}", self.from, self.to)
	}
}

impl core::error::Error for TransitionError {}

impl WorkItemState {
	/// Terminal states never transition out (a reopened item becomes a new
	/// work item with its own intent key).
	#[must_use]
	pub const fn is_terminal(self) -> bool {
		matches!(self, Self::MergedDev | Self::Closed)
	}

	/// The states reachable from `self` in one legal step.
	#[must_use]
	pub const fn allowed_next(self) -> &'static [Self] {
		use WorkItemState::{
			AwaitingCi, Blocked, Closed, Escalated, MergeReady, MergedDev, PrOpen, Queued, Revising,
			Running, Seen, StreamLost,
		};
		match self {
			// D1: every ingested item is queued (no eligibility no-op path).
			Seen => &[Queued, Blocked, Closed],
			Queued => &[Running, Blocked, Closed],
			Running => &[PrOpen, Escalated, Blocked, StreamLost, Closed],
			PrOpen => &[AwaitingCi, Revising, MergeReady, Escalated, Blocked, StreamLost, Closed],
			AwaitingCi => &[Revising, MergeReady, Escalated, Blocked, StreamLost, Closed],
			// D4: self-revision may loop indefinitely (Revising -> Revising).
			Revising => &[Revising, AwaitingCi, MergeReady, Escalated, Blocked, StreamLost, Closed],
			// Gate may bounce back to Revising/AwaitingCi when the head SHA moved.
			MergeReady => &[MergedDev, Revising, AwaitingCi, Escalated, Blocked, StreamLost, Closed],
			MergedDev => &[Closed],
			// Re-engage on an actionable follow-up.
			Escalated => &[Queued, Revising, Blocked, Closed],
			Blocked => &[Queued, Escalated, Closed],
			// Non-terminal: only recovery/operator/takeover resolves it.
			StreamLost => &[Running, Queued, Escalated, Blocked, Closed],
			Closed => &[],
		}
	}

	/// Whether `self -> to` is a legal transition.
	#[must_use]
	pub fn can_transition_to(self, to: Self) -> bool {
		self.allowed_next().contains(&to)
	}

	/// Validate a transition, returning a typed error when illegal.
	///
	/// # Errors
	/// Returns [`TransitionError`] when `to` is not in [`Self::allowed_next`].
	pub fn transition_to(self, to: Self) -> Result<Self, TransitionError> {
		if self.can_transition_to(to) {
			Ok(to)
		} else {
			Err(TransitionError { from: self, to })
		}
	}
}

#[cfg(test)]
mod tests {
	use super::WorkItemState::{
		AwaitingCi, Blocked, Closed, Escalated, MergeReady, MergedDev, PrOpen, Queued, Revising,
		Running, Seen, StreamLost,
	};
	use super::*;

	#[test]
	fn every_item_is_queued_not_no_opped() {
		// D1: there is no eligibility/watching no-op path; Seen routes to Queued.
		assert!(Seen.can_transition_to(Queued));
		assert!(!Seen.can_transition_to(Running)); // must pass through Queued
	}

	#[test]
	fn revising_can_loop_forever() {
		// D4: no self-revision cap — Revising -> Revising is always legal.
		assert!(Revising.can_transition_to(Revising));
	}

	#[test]
	fn merged_dev_only_reachable_from_merge_ready() {
		for s in [Seen, Queued, Running, PrOpen, AwaitingCi, Revising, Escalated, Blocked, StreamLost] {
			assert_eq!(s.can_transition_to(MergedDev), s == MergeReady, "from {s:?}");
		}
		assert!(MergeReady.can_transition_to(MergedDev));
	}

	#[test]
	fn stream_lost_is_non_terminal() {
		assert!(!StreamLost.is_terminal());
		assert!(StreamLost.can_transition_to(Running));
		assert!(StreamLost.can_transition_to(Queued));
	}

	#[test]
	fn escalated_re_engages_on_followup() {
		assert!(Escalated.can_transition_to(Queued));
		assert!(Escalated.can_transition_to(Revising));
	}

	#[test]
	fn terminal_states_have_no_or_closing_exits() {
		assert!(MergedDev.is_terminal());
		assert!(Closed.is_terminal());
		assert!(Closed.allowed_next().is_empty());
		// success terminal may still record the issue closing
		assert!(MergedDev.can_transition_to(Closed));
	}

	#[test]
	fn transition_to_reports_typed_error() {
		let err = Seen.transition_to(MergedDev).unwrap_err();
		assert_eq!(err.from, Seen);
		assert_eq!(err.to, MergedDev);
		assert!(Queued.transition_to(Running).is_ok());
	}

	#[test]
	fn state_round_trips_through_serde() {
		let json = serde_json::to_string(&WorkItemState::StreamLost).unwrap();
		assert_eq!(json, "\"stream_lost\"");
		let back: WorkItemState = serde_json::from_str(&json).unwrap();
		assert_eq!(back, WorkItemState::StreamLost);
	}
}
