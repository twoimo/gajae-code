//! gjc-rpc/bridge runner contract: unbounded negotiation + durable stream
//! resume bookkeeping.
//!
//! The async transport (spawning/connecting to the TS engine, reading the SSE
//! stream) is a later slice. This module is the pure, testable contract: it
//! builds the exact `negotiate_unattended` declaration the TS engine expects in
//! unbounded mode (D3), and tracks the event-stream sequence so a bridge reset
//! is resolved by replay when possible and degraded to `stream_lost` (a
//! non-terminal state, never a clean terminal success) when the replay window
//! is exceeded.

use serde_json::{Value, json};

/// Build the unbounded-mode `negotiate_unattended` command (D3).
///
/// No numeric budget is sent, so the engine never aborts on
/// cost/tokens/tool-calls/wall time, while scope/action authorization and
/// workflow gates still apply.
#[must_use]
pub fn unbounded_negotiation(actor: &str, scopes: &[&str], action_allowlist: &[&str]) -> Value {
	json!({
		"type": "negotiate_unattended",
		"declaration": {
			"actor": actor,
			"budget_mode": "unbounded",
			"scopes": scopes,
			"action_allowlist": action_allowlist,
		}
	})
}

/// Result of observing the next stream event sequence number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamProgress {
	/// The event advanced the stream by exactly one; applied.
	Applied,
	/// An already-seen (or older) sequence; ignored idempotently.
	Duplicate,
	/// A gap within the replay window: request replay from this sequence before
	/// applying further events.
	ReplayNeededFrom(u64),
	/// A gap beyond the replay window (or post-reset history overflow): the
	/// stream is lost and the work item must transition to `stream_lost`.
	Lost { gap: u64 },
}

/// Tracks the last applied event sequence and decides recovery on a gap.
#[derive(Debug, Clone)]
pub struct StreamTracker {
	last_seq:      Option<u64>,
	replay_window: u64,
	lost:          bool,
}

impl StreamTracker {
	/// `replay_window` is the maximum sequence gap the bridge can replay.
	#[must_use]
	pub const fn new(replay_window: u64) -> Self {
		Self { last_seq: None, replay_window, lost: false }
	}

	/// The last applied sequence, if any.
	#[must_use]
	pub const fn last_seq(&self) -> Option<u64> {
		self.last_seq
	}

	/// Whether the stream has been declared lost.
	#[must_use]
	pub const fn is_lost(&self) -> bool {
		self.lost
	}

	/// Observe the next event's sequence number and decide what to do.
	pub const fn observe(&mut self, seq: u64) -> StreamProgress {
		if self.lost {
			return StreamProgress::Lost { gap: 0 };
		}
		let Some(last) = self.last_seq else {
			self.last_seq = Some(seq);
			return StreamProgress::Applied;
		};
		if seq <= last {
			return StreamProgress::Duplicate;
		}
		if seq == last + 1 {
			self.last_seq = Some(seq);
			return StreamProgress::Applied;
		}
		// Gap: events between last+1 and seq-1 were missed.
		let gap = seq - last - 1;
		if gap <= self.replay_window {
			StreamProgress::ReplayNeededFrom(last + 1)
		} else {
			self.lost = true;
			StreamProgress::Lost { gap }
		}
	}

	/// Record that a replay caught the stream up to `seq` (the replayed events
	/// were applied in order), advancing the cursor.
	pub const fn mark_resumed(&mut self, seq: u64) {
		if !self.lost {
			self.last_seq = Some(seq);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn unbounded_negotiation_omits_budget() {
		let v = unbounded_negotiation("git-daemon", &["prompt", "bash"], &["bash.mutating"]);
		let decl = &v["declaration"];
		assert_eq!(decl["budget_mode"], "unbounded");
		assert!(decl.get("budget").is_none(), "unbounded must not carry a numeric budget");
		assert_eq!(decl["actor"], "git-daemon");
		assert_eq!(v["type"], "negotiate_unattended");
	}

	#[test]
	fn sequential_events_apply() {
		let mut t = StreamTracker::new(10);
		assert_eq!(t.observe(1), StreamProgress::Applied);
		assert_eq!(t.observe(2), StreamProgress::Applied);
		assert_eq!(t.observe(3), StreamProgress::Applied);
		assert_eq!(t.last_seq(), Some(3));
	}

	#[test]
	fn duplicate_and_older_events_are_ignored() {
		let mut t = StreamTracker::new(10);
		t.observe(1);
		t.observe(2);
		assert_eq!(t.observe(2), StreamProgress::Duplicate);
		assert_eq!(t.observe(1), StreamProgress::Duplicate);
		assert_eq!(t.last_seq(), Some(2));
	}

	#[test]
	fn small_gap_requests_replay_then_resumes() {
		let mut t = StreamTracker::new(10);
		t.observe(1);
		// Jump to 5: events 2-4 missed (gap 3, within window) -> replay from 2.
		assert_eq!(t.observe(5), StreamProgress::ReplayNeededFrom(2));
		// Cursor not advanced until replay completes.
		assert_eq!(t.last_seq(), Some(1));
		t.mark_resumed(5);
		assert_eq!(t.last_seq(), Some(5));
		assert!(!t.is_lost());
	}

	#[test]
	fn gap_beyond_window_is_lost_and_sticky() {
		let mut t = StreamTracker::new(10);
		t.observe(1);
		// Jump to 100: gap 98 > window 10 -> lost.
		assert_eq!(t.observe(100), StreamProgress::Lost { gap: 98 });
		assert!(t.is_lost());
		// Once lost, it stays lost (non-terminal recovery happens out-of-band).
		assert_eq!(t.observe(101), StreamProgress::Lost { gap: 0 });
		// mark_resumed does not silently clear a lost stream.
		t.mark_resumed(101);
		assert!(t.is_lost());
	}
}
