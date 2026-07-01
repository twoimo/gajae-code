//! gjc-rpc runner: reduce the engine's unattended event stream into a run
//! outcome.
//!
//! The engine emits agent-lifecycle event frames
//! (`{type:"event", seq, payload:{event_type, event}}`) — `agent_start`,
//! `turn_start`/`turn_end`, `message`, `completed`/`agent_end`, `error`,
//! `budget_exceeded`. This reducer turns that ordered stream into a
//! [`RunOutcome`] (did the run complete successfully + observed usage), tracking
//! the sequence so a bridge reset degrades to `stream_lost` rather than a false
//! success (D3: usage is observed, never enforced). PR discovery and merge-gate
//! signals are NOT engine events — the orchestrator derives those from the forge
//! after the run completes.

use crate::orchestrator::RunOutcome;
use crate::runner::{StreamProgress, StreamTracker};
use crate::spend_ledger::UsageObservation;

/// One frame from the engine's unattended event stream, carrying its sequence.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
	/// An agent-lifecycle event; `event_type` is the engine's `payload.event_type`.
	Lifecycle { seq: u64, event_type: String },
	/// Observed (not enforced) usage, accumulated for the ledger (D3).
	Usage { seq: u64, usage: UsageObservation },
}

impl StreamEvent {
	const fn seq(&self) -> u64 {
		match self {
			Self::Lifecycle { seq, .. } | Self::Usage { seq, .. } => *seq,
		}
	}
}

/// Terminal lifecycle event types that end the agent loop. Reaching one means
/// the run completed; an `error` event mid-run is NOT terminal (the agent may
/// recover and continue), so only the end-of-loop signal ends reduction. A
/// stream that ends without one yields no outcome (the caller treats it as a
/// failed run), so a truncated/aborted run never counts as success.
const TERMINAL_OK: [&str; 2] = ["completed", "agent_end"];

/// The outcome of reducing a run's event stream.
#[derive(Debug, Clone, PartialEq)]
pub struct RunReduction {
	/// The run outcome, if a terminal event was reached on an intact stream.
	pub outcome: Option<RunOutcome>,
	/// True if the stream was lost (gap beyond the replay window) — non-terminal.
	pub stream_lost: bool,
	/// Total observed usage (always recorded, never enforced — D3).
	pub usage: UsageObservation,
	/// Last applied sequence number.
	pub last_seq: Option<u64>,
}

/// Reduce an ordered slice of engine events into a [`RunReduction`].
///
/// A sequence gap (in-window or beyond) with no replay channel degrades to
/// `stream_lost` with no outcome — never a false terminal success. A terminal
/// event (`completed`/`agent_end` → success, `error`/`budget_exceeded` →
/// failure) ends reduction; a stream that ends without a terminal event yields
/// no outcome (the caller treats that as a failed run).
#[must_use]
pub fn reduce_run_events(events: &[StreamEvent], replay_window: u64) -> RunReduction {
	let mut tracker = StreamTracker::new(replay_window);
	let mut usage = UsageObservation::default();
	let mut succeeded: Option<bool> = None;

	for event in events {
		match tracker.observe(event.seq()) {
			StreamProgress::Duplicate => continue,
			StreamProgress::Lost { .. } | StreamProgress::ReplayNeededFrom(_) => {
				// No replay channel before reduction: any gap fails closed so a
				// gapped stream can never reduce to a terminal success.
				return RunReduction { outcome: None, stream_lost: true, usage, last_seq: tracker.last_seq() };
			}
			StreamProgress::Applied => {}
		}
		match event {
			StreamEvent::Usage { usage: u, .. } => usage.add_observed(u),
			StreamEvent::Lifecycle { event_type, .. } => {
				if TERMINAL_OK.contains(&event_type.as_str()) {
					succeeded = Some(true);
					break;
				}
			}
		}
	}

	let outcome = succeeded.map(|ok| RunOutcome { succeeded: ok, usage });
	RunReduction { outcome, stream_lost: false, usage, last_seq: tracker.last_seq() }
}

#[cfg(test)]
mod tests {
	use super::*;

	fn usage(t: u64) -> UsageObservation {
		UsageObservation { tokens: t, tool_calls: 1, cost_usd: 0.0, wall_time_ms: 0 }
	}

	fn life(seq: u64, ev: &str) -> StreamEvent {
		StreamEvent::Lifecycle { seq, event_type: ev.to_owned() }
	}

	#[test]
	fn reduces_a_successful_run() {
		let events = vec![
			life(1, "agent_start"),
			StreamEvent::Usage { seq: 2, usage: usage(100) },
			life(3, "turn_end"),
			life(4, "completed"),
		];
		let r = reduce_run_events(&events, 10);
		assert!(!r.stream_lost);
		let out = r.outcome.unwrap();
		assert!(out.succeeded);
		assert_eq!(out.usage.tokens, 100);
		assert_eq!(r.last_seq, Some(4));
	}

	#[test]
	fn agent_end_is_also_terminal_success() {
		let r = reduce_run_events(&[life(1, "agent_start"), life(2, "agent_end")], 10);
		assert!(r.outcome.unwrap().succeeded);
	}

	#[test]
	fn mid_run_error_is_not_terminal_and_recovers_to_success() {
		// An `error` event mid-run is not terminal; the agent recovers and the
		// run still ends successfully at agent_end.
		let r = reduce_run_events(&[life(1, "agent_start"), life(2, "error"), life(3, "agent_end")], 10);
		assert!(r.outcome.unwrap().succeeded, "recoverable mid-run error must not fail the run");
	}

	#[test]
	fn error_without_terminal_yields_no_outcome() {
		// A run that errors and never reaches agent_end has no outcome -> failed.
		let r = reduce_run_events(&[life(1, "agent_start"), life(2, "error")], 10);
		assert!(r.outcome.is_none(), "no end-of-loop terminal => no outcome (caller treats as failed)");
	}

	#[test]
	fn unbounded_usage_is_accumulated_not_capped() {
		// D3: huge usage just accumulates; nothing aborts the reduction.
		let events = vec![
			life(1, "agent_start"),
			StreamEvent::Usage { seq: 2, usage: usage(10_000_000) },
			StreamEvent::Usage { seq: 3, usage: usage(10_000_000) },
			life(4, "completed"),
		];
		let r = reduce_run_events(&events, 10);
		assert_eq!(r.usage.tokens, 20_000_000);
		assert!(r.outcome.unwrap().succeeded);
	}

	#[test]
	fn gap_beyond_window_marks_stream_lost_no_outcome() {
		let r = reduce_run_events(&[life(1, "agent_start"), life(100, "completed")], 10);
		assert!(r.stream_lost);
		assert!(r.outcome.is_none());
	}

	#[test]
	fn in_window_gap_before_terminal_is_stream_lost_not_success() {
		// A gap WITHIN the replay window with no replay channel must fail closed.
		let r = reduce_run_events(&[life(1, "agent_start"), life(5, "completed")], 10);
		assert!(r.stream_lost, "in-window gap must degrade to stream_lost");
		assert!(r.outcome.is_none(), "must never reduce a gapped stream to success");
	}

	#[test]
	fn stream_without_terminal_yields_no_outcome() {
		let r = reduce_run_events(&[life(1, "agent_start"), life(2, "turn_end")], 10);
		assert!(!r.stream_lost);
		assert!(r.outcome.is_none(), "no terminal event => no outcome (caller treats as failed)");
	}
}
