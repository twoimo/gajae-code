//! gjc-rpc runner: reduce an engine event stream into a [`RunResult`].
//!
//! The live transport (socket connect, SSE read loop) is thin; the verifiable
//! core is turning the ordered event stream into a run outcome while tracking
//! the sequence (so a bridge reset degrades to `stream_lost` rather than a false
//! success) and accumulating observed usage (D3). This reducer is pure and fully
//! tested; the socket impl just feeds it [`StreamEvent`]s in arrival order.

use crate::orchestrator::RunResult;
use crate::runner::{StreamProgress, StreamTracker};
use crate::spend_ledger::UsageObservation;

/// One event from the unattended engine’s stream, carrying its sequence number.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
	/// The daemon opened a PR with this head SHA and base branch.
	PrOpened { seq: u64, pr_id: String, head_sha: String, base_branch: String },
	/// Live gate signals observed for the current head.
	GateSignals {
		seq: u64,
		ci_green: bool,
		ultragoal_pass: bool,
		reviews_resolved: bool,
		diff_within_budget: bool,
		diff_in_scope: bool,
	},
	/// Observed (not enforced) usage, accumulated for the ledger (D3).
	UsageObserved { seq: u64, usage: UsageObservation },
	/// Terminal event: the run finished (success or failure).
	Terminal { seq: u64, succeeded: bool },
}

impl StreamEvent {
	const fn seq(&self) -> u64 {
		match self {
			Self::PrOpened { seq, .. }
			| Self::GateSignals { seq, .. }
			| Self::UsageObserved { seq, .. }
			| Self::Terminal { seq, .. } => *seq,
		}
	}
}

/// The outcome of reducing a run’s event stream.
#[derive(Debug, Clone, PartialEq)]
pub struct RunReduction {
	/// The run result, if a terminal event was reached on an intact stream.
	pub result: Option<RunResult>,
	/// True if the stream was lost (gap beyond the replay window) — non-terminal.
	pub stream_lost: bool,
	/// Total observed usage (always recorded, never enforced — D3).
	pub usage: UsageObservation,
	/// Last applied sequence number.
	pub last_seq: Option<u64>,
}

/// Reduce an ordered slice of stream events into a [`RunReduction`].
///
/// Feeds each event’s sequence through a [`StreamTracker`]; a gap beyond
/// `replay_window` marks the stream lost and stops (no false terminal success).
#[must_use]
pub fn reduce_run_events(events: &[StreamEvent], replay_window: u64) -> RunReduction {
	let mut tracker = StreamTracker::new(replay_window);
	let mut usage = UsageObservation::default();
	let mut pr_id: Option<String> = None;
	let mut head_sha: Option<String> = None;
	let mut base_branch: Option<String> = None;
	let mut ci_green = false;
	let mut ultragoal_pass = false;
	let mut reviews_resolved = false;
	let mut diff_within_budget = false;
	let mut diff_in_scope = false;
	let mut succeeded: Option<bool> = None;

	for event in events {
		match tracker.observe(event.seq()) {
			StreamProgress::Duplicate => continue,
			StreamProgress::Lost { .. } => {
				return RunReduction { result: None, stream_lost: true, usage, last_seq: tracker.last_seq() };
			}
			StreamProgress::Applied => {}
			StreamProgress::ReplayNeededFrom(_) => {
				// An in-window sequence gap. The live socket-runner path has no
				// replay request/response channel before reduction, so we must NOT
				// assume the missing events were delivered — doing so would let a
				// gap (e.g. seq 1 -> seq 5 -> terminal) produce a false terminal
				// success. Fail closed: mark the stream lost (non-terminal).
				return RunReduction { result: None, stream_lost: true, usage, last_seq: tracker.last_seq() };
			}
		}
		match event {
			StreamEvent::PrOpened { pr_id: id, head_sha: sha, base_branch: base, .. } => {
				pr_id = Some(id.clone());
				head_sha = Some(sha.clone());
				base_branch = Some(base.clone());
			}
			StreamEvent::GateSignals {
				ci_green: ci,
				ultragoal_pass: ug,
				reviews_resolved: rr,
				diff_within_budget: db,
				diff_in_scope: ds,
				..
			} => {
				ci_green = *ci;
				ultragoal_pass = *ug;
				reviews_resolved = *rr;
				diff_within_budget = *db;
				diff_in_scope = *ds;
			}
			StreamEvent::UsageObserved { usage: u, .. } => usage.add_observed(u),
			StreamEvent::Terminal { succeeded: ok, .. } => {
				succeeded = Some(*ok);
				break;
			}
		}
	}

	let result = match (succeeded, pr_id, head_sha) {
		(Some(ok), Some(pr_id), Some(head_sha)) => Some(RunResult {
			succeeded: ok,
			pr_id,
			head_sha,
			base_branch: base_branch.unwrap_or_default(),
			ci_green,
			ultragoal_pass,
			reviews_resolved,
			diff_within_budget,
			diff_in_scope,
		}),
		// Terminal failure before a PR was opened still yields a failed result.
		(Some(false), _, _) => Some(RunResult {
			succeeded: false,
			pr_id: String::new(),
			head_sha: String::new(),
			base_branch: String::new(),
			ci_green,
			ultragoal_pass,
			reviews_resolved,
			diff_within_budget,
			diff_in_scope,
		}),
		_ => None,
	};
	RunReduction { result, stream_lost: false, usage, last_seq: tracker.last_seq() }
}

#[cfg(test)]
mod tests {
	use super::*;

	fn usage(t: u64) -> UsageObservation {
		UsageObservation { tokens: t, tool_calls: 1, cost_usd: 0.0, wall_time_ms: 0 }
	}

	#[test]
	fn reduces_a_successful_run() {
		let events = vec![
			StreamEvent::PrOpened { seq: 1, pr_id: "PR_7".into(), head_sha: "abc".into(), base_branch: "dev".into() },
			StreamEvent::UsageObserved { seq: 2, usage: usage(100) },
			StreamEvent::GateSignals {
				seq: 3,
				ci_green: true,
				ultragoal_pass: true,
				reviews_resolved: true,
				diff_within_budget: true,
				diff_in_scope: true,
			},
			StreamEvent::Terminal { seq: 4, succeeded: true },
		];
		let r = reduce_run_events(&events, 10);
		assert!(!r.stream_lost);
		let result = r.result.unwrap();
		assert!(result.succeeded);
		assert_eq!(result.pr_id, "PR_7");
		assert_eq!(result.head_sha, "abc");
		assert!(result.ci_green && result.ultragoal_pass);
		assert_eq!(r.usage.tokens, 100);
		assert_eq!(r.last_seq, Some(4));
	}

	#[test]
	fn unbounded_usage_is_accumulated_not_capped() {
		// D3: huge usage just accumulates; nothing aborts the reduction.
		let events = vec![
			StreamEvent::PrOpened { seq: 1, pr_id: "PR_7".into(), head_sha: "abc".into(), base_branch: "dev".into() },
			StreamEvent::UsageObserved { seq: 2, usage: usage(10_000_000) },
			StreamEvent::UsageObserved { seq: 3, usage: usage(10_000_000) },
			StreamEvent::Terminal { seq: 4, succeeded: true },
		];
		let r = reduce_run_events(&events, 10);
		assert_eq!(r.usage.tokens, 20_000_000);
		assert!(r.result.unwrap().succeeded);
	}

	#[test]
	fn gap_beyond_window_marks_stream_lost_no_result() {
		let events = vec![
			StreamEvent::PrOpened { seq: 1, pr_id: "PR_7".into(), head_sha: "abc".into(), base_branch: "dev".into() },
			// Jump to 100: gap beyond window -> lost, no terminal success.
			StreamEvent::Terminal { seq: 100, succeeded: true },
		];
		let r = reduce_run_events(&events, 10);
		assert!(r.stream_lost);
		assert!(r.result.is_none());
	}

	#[test]
	fn terminal_failure_yields_failed_result() {
		let events = vec![StreamEvent::Terminal { seq: 1, succeeded: false }];
		let r = reduce_run_events(&events, 10);
		assert!(!r.stream_lost);
		assert!(!r.result.unwrap().succeeded);
	}

	#[test]
	fn in_window_gap_before_terminal_is_stream_lost_not_success() {
		// A gap WITHIN the replay window with no replay channel must NOT be
		// treated as recovered: seq 1 -> seq 5 -> terminal must fail closed.
		let events = vec![
			StreamEvent::PrOpened { seq: 1, pr_id: "PR_7".into(), head_sha: "abc".into(), base_branch: "dev".into() },
			StreamEvent::Terminal { seq: 5, succeeded: true },
		];
		let r = reduce_run_events(&events, 10);
		assert!(r.stream_lost, "in-window gap must degrade to stream_lost");
		assert!(r.result.is_none(), "must never reduce a gapped stream to terminal success");
	}
}
