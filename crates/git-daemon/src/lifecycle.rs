//! Daemon ownership + lifecycle, modeled on the telegram daemon pattern.
//!
//! One daemon owns a repo at a time. Ownership is a heartbeat record; a new
//! process may steal a stale lease (owner crashed) but must refuse a live one.
//! Lifecycle adds a `Draining` state so stop/reload can settle in-flight runs
//! before teardown (D3/D4: settlement is the boundary, not a budget abort).

use serde::{Deserialize, Serialize};

/// A heartbeat-based ownership record persisted by the running daemon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnershipRecord {
	pub owner_id: String,
	pub pid: u32,
	/// ISO-8601 (UTC) timestamp of the last heartbeat.
	pub heartbeat_at: String,
}

/// What a starting daemon should do given the current ownership record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TakeoverDecision {
	/// No live owner (or it is us): acquire ownership.
	Acquire,
	/// A different owner holds a fresh lease: refuse to start.
	Refuse { live_owner: String },
	/// A different owner's lease is stale: steal it (it likely crashed).
	Steal { stale_owner: String },
}

/// Decide whether to acquire/steal/refuse ownership.
///
/// `heartbeat_cutoff` is `now - lease_ttl`, computed by the caller (which owns
/// the clock). A record with `heartbeat_at < cutoff` is stale.
#[must_use]
pub fn decide_takeover(
	existing: Option<&OwnershipRecord>,
	my_owner_id: &str,
	heartbeat_cutoff: &str,
) -> TakeoverDecision {
	match existing {
		None => TakeoverDecision::Acquire,
		Some(rec) if rec.owner_id == my_owner_id => TakeoverDecision::Acquire,
		Some(rec) if rec.heartbeat_at.as_str() < heartbeat_cutoff => {
			TakeoverDecision::Steal { stale_owner: rec.owner_id.clone() }
		}
		Some(rec) => TakeoverDecision::Refuse { live_owner: rec.owner_id.clone() },
	}
}

/// Daemon lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonStatus {
	Starting,
	Running,
	/// Stop/reload requested: stop scheduling new work, settle in-flight runs.
	Draining,
	Stopped,
}

impl DaemonStatus {
	/// Whether the daemon should accept/schedule new work in this state.
	#[must_use]
	pub const fn accepts_new_work(self) -> bool {
		matches!(self, Self::Running)
	}

	/// Legal lifecycle transitions.
	#[must_use]
	pub const fn can_transition_to(self, to: Self) -> bool {
		matches!(
			(self, to),
			(Self::Starting, Self::Running | Self::Draining) |
(Self::Running, Self::Draining) | (Self::Draining, Self::Stopped)
		)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn rec(owner: &str, hb: &str) -> OwnershipRecord {
		OwnershipRecord { owner_id: owner.into(), pid: 123, heartbeat_at: hb.into() }
	}

	#[test]
	fn no_existing_owner_acquires() {
		assert_eq!(decide_takeover(None, "me", "2026-01-01T00:00:00Z"), TakeoverDecision::Acquire);
	}

	#[test]
	fn own_record_reacquires() {
		let r = rec("me", "2026-01-01T00:00:00Z");
		assert_eq!(decide_takeover(Some(&r), "me", "2026-01-01T00:05:00Z"), TakeoverDecision::Acquire);
	}

	#[test]
	fn live_other_owner_is_refused() {
		// heartbeat newer than the cutoff -> fresh -> refuse.
		let r = rec("other", "2026-01-01T00:10:00Z");
		assert_eq!(
			decide_takeover(Some(&r), "me", "2026-01-01T00:05:00Z"),
			TakeoverDecision::Refuse { live_owner: "other".into() }
		);
	}

	#[test]
	fn stale_other_owner_is_stolen() {
		// heartbeat older than the cutoff -> stale -> steal.
		let r = rec("other", "2026-01-01T00:00:00Z");
		assert_eq!(
			decide_takeover(Some(&r), "me", "2026-01-01T00:05:00Z"),
			TakeoverDecision::Steal { stale_owner: "other".into() }
		);
	}

	#[test]
	fn only_running_accepts_new_work() {
		assert!(DaemonStatus::Running.accepts_new_work());
		assert!(!DaemonStatus::Draining.accepts_new_work());
		assert!(!DaemonStatus::Starting.accepts_new_work());
		assert!(!DaemonStatus::Stopped.accepts_new_work());
	}

	#[test]
	fn lifecycle_transitions_are_constrained() {
		assert!(DaemonStatus::Starting.can_transition_to(DaemonStatus::Running));
		assert!(DaemonStatus::Running.can_transition_to(DaemonStatus::Draining));
		assert!(DaemonStatus::Draining.can_transition_to(DaemonStatus::Stopped));
		// Cannot jump from running straight to stopped (must drain first).
		assert!(!DaemonStatus::Running.can_transition_to(DaemonStatus::Stopped));
		// Cannot resurrect a stopped daemon in place.
		assert!(!DaemonStatus::Stopped.can_transition_to(DaemonStatus::Running));
	}
}
