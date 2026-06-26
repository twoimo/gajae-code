//! Phase 2: concrete two-lane per-session scheduler.
//!
//! Enforces the locked causality contract (`rpc-mode.ts:83-169`, `runtime-port.md`):
//! ordered commands form a per-session serial chain, while fast-lane control/read
//! commands MUST dispatch immediately even while an ordered command is in flight. A
//! single FIFO that blocks the fast lane behind ordered work is exactly what this
//! type forbids. This is a transport-agnostic behavioral model shared by both the
//! native in-process and headless-worker RuntimePort bindings.

use std::collections::VecDeque;

use crate::classifier::UnknownCommand;
use crate::scheduler::{CommandClassifier, Lane};

/// Outcome of submitting a command to the scheduler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatch {
	/// Runs now: a fast-lane command, or the first ordered command in an idle chain.
	Immediate,
	/// An ordered command queued behind in-flight/earlier ordered work, at this
	/// 0-based position in the pending queue.
	Queued(usize),
}

/// Per-session scheduler. Not internally synchronized; the daemon owns one per
/// session and drives it from the single scheduling task.
#[derive(Debug, Default)]
pub struct SessionScheduler {
	ordered_in_flight: bool,
	ordered_queue: VecDeque<String>,
}

impl SessionScheduler {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Submit a pre-classified command.
	pub fn submit(&mut self, command: &str, lane: Lane) -> Dispatch {
		match lane {
			// Fast lane bypasses the ordered chain unconditionally.
			Lane::FastLaneCancellation | Lane::FastLaneSafeRead => Dispatch::Immediate,
			Lane::Ordered => {
				if self.ordered_in_flight {
					self.ordered_queue.push_back(command.to_string());
					Dispatch::Queued(self.ordered_queue.len())
				} else {
					self.ordered_in_flight = true;
					Dispatch::Immediate
				}
			},
		}
	}

	/// Classify with the given classifier, then submit. Fails closed on unknown
	/// commands (never silently scheduled).
	pub fn submit_command<C: CommandClassifier<Error = UnknownCommand>>(
		&mut self,
		classifier: &C,
		command: &str,
	) -> Result<Dispatch, UnknownCommand> {
		let lane = classifier.lane_for(command)?;
		Ok(self.submit(command, lane))
	}

	/// Mark the in-flight ordered command finished and promote the next queued one.
	/// Returns the promoted command, if any. Fast-lane commands never touch this.
	pub fn complete_ordered(&mut self) -> Option<String> {
		let next = self.ordered_queue.pop_front();
		self.ordered_in_flight = next.is_some();
		next
	}

	/// Number of ordered commands waiting behind the in-flight one.
	#[must_use]
	pub fn ordered_pending(&self) -> usize {
		self.ordered_queue.len()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::classifier::ManifestCommandClassifier;

	#[test]
	fn fast_lane_bypasses_in_flight_ordered_command() {
		let c = ManifestCommandClassifier::from_embedded();
		let mut s = SessionScheduler::new();

		// A long ordered command starts running.
		assert_eq!(s.submit_command(&c, "bash").unwrap(), Dispatch::Immediate);
		// A second ordered command must queue behind it.
		assert_eq!(s.submit_command(&c, "prompt").unwrap(), Dispatch::Queued(1));
		// Fast-lane cancellation/read dispatch immediately despite the in-flight ordered work.
		assert_eq!(s.submit_command(&c, "abort_bash").unwrap(), Dispatch::Immediate);
		assert_eq!(s.submit_command(&c, "get_state").unwrap(), Dispatch::Immediate);
		// The fast-lane traffic did not disturb the ordered queue.
		assert_eq!(s.ordered_pending(), 1);
	}

	#[test]
	fn ordered_commands_serialize_in_arrival_order() {
		let c = ManifestCommandClassifier::from_embedded();
		let mut s = SessionScheduler::new();
		assert_eq!(s.submit_command(&c, "prompt").unwrap(), Dispatch::Immediate);
		assert_eq!(s.submit_command(&c, "set_model").unwrap(), Dispatch::Queued(1));
		assert_eq!(s.submit_command(&c, "compact").unwrap(), Dispatch::Queued(2));
		// Completing the in-flight command promotes the next in arrival order.
		assert_eq!(s.complete_ordered(), Some("set_model".to_string()));
		assert_eq!(s.ordered_pending(), 1);
		assert_eq!(s.complete_ordered(), Some("compact".to_string()));
		assert_eq!(s.complete_ordered(), None);
	}

	#[test]
	fn unknown_command_fails_closed() {
		let c = ManifestCommandClassifier::from_embedded();
		let mut s = SessionScheduler::new();
		assert!(s.submit_command(&c, "not_a_real_command").is_err());
	}
}
