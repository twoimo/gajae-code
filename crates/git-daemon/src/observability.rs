//! Daemon observability: status report + KPI snapshot.
//!
//! Surfaces what the daemon is doing for `gjc daemon status`. The KPI uses an
//! all-attempt denominator (D2): the success rate is autonomous dev merges over
//! every attempted issue, not an eligible subset. Spend is reported, never
//! enforced (D3).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::lifecycle::DaemonStatus;
use crate::spend_ledger::UsageObservation;

/// Headline KPI snapshot over a rolling window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct KpiSnapshot {
	/// Every issue the daemon attempted in the window (the denominator, D2).
	pub attempts: u64,
	/// Attempts that reached an autonomous dev merge (zero human touch).
	pub dev_merges: u64,
	/// Median intake-to-dev-merge in seconds, when measurable.
	pub median_seconds_to_merge: Option<u64>,
}

impl KpiSnapshot {
	/// Success rate over ALL attempts (D2). Returns 0.0 when there are no
	/// attempts (avoids a divide-by-zero and reads as "no signal yet").
	#[must_use]
	pub fn success_rate(&self) -> f64 {
		if self.attempts == 0 {
			return 0.0;
		}
		#[allow(
			clippy::cast_precision_loss,
			reason = "rate is a display metric; u64->f64 precision loss is irrelevant at these magnitudes"
		)]
		{
			self.dev_merges as f64 / self.attempts as f64
		}
	}
}

/// A point-in-time status report for the daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusReport {
	pub owner_id: String,
	pub pid: u32,
	pub repo_full_name: String,
	pub status: DaemonStatus,
	/// Items queued/awaiting a worker.
	pub queue_depth: u64,
	/// Currently held single-flight locks (active runs).
	pub active_locks: u64,
	/// Duplicate events dropped by dedupe.
	pub duplicate_drops: u64,
	/// Gate denials by reason code.
	pub gate_denials: BTreeMap<String, u64>,
	/// Runs whose stream was lost (awaiting recovery).
	pub stream_gaps: u64,
	/// Observed (not enforced) usage (D3).
	pub spend_observed: UsageObservation,
	/// Last human escalation code, if any.
	pub last_escalation: Option<String>,
	pub kpi: KpiSnapshot,
}

impl StatusReport {
	/// A bare report for a freshly started daemon.
	#[must_use]
	pub fn starting(owner_id: impl Into<String>, pid: u32, repo_full_name: impl Into<String>) -> Self {
		Self {
			owner_id: owner_id.into(),
			pid,
			repo_full_name: repo_full_name.into(),
			status: DaemonStatus::Starting,
			queue_depth: 0,
			active_locks: 0,
			duplicate_drops: 0,
			gate_denials: BTreeMap::new(),
			stream_gaps: 0,
			spend_observed: UsageObservation::default(),
			last_escalation: None,
			kpi: KpiSnapshot::default(),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn success_rate_is_over_all_attempts() {
		let kpi = KpiSnapshot { attempts: 10, dev_merges: 6, median_seconds_to_merge: Some(3600) };
		assert!((kpi.success_rate() - 0.6).abs() < 1e-9);
	}

	#[test]
	fn success_rate_zero_attempts_is_zero_not_nan() {
		let kpi = KpiSnapshot::default();
		assert_eq!(kpi.success_rate(), 0.0);
		assert!(!kpi.success_rate().is_nan());
	}

	#[test]
	fn starting_report_is_empty_and_serializes() {
		let r = StatusReport::starting("owner-1", 42, "acme/widget");
		assert_eq!(r.status, DaemonStatus::Starting);
		assert_eq!(r.queue_depth, 0);
		assert!(r.gate_denials.is_empty());
		let json = serde_json::to_string(&r).unwrap();
		let back: StatusReport = serde_json::from_str(&json).unwrap();
		assert_eq!(back, r);
	}

	#[test]
	fn gate_denials_tally_by_reason() {
		let mut r = StatusReport::starting("o", 1, "a/b");
		*r.gate_denials.entry("gate_ci_not_green".into()).or_insert(0) += 1;
		*r.gate_denials.entry("gate_ci_not_green".into()).or_insert(0) += 1;
		*r.gate_denials.entry("gate_main_branch".into()).or_insert(0) += 1;
		assert_eq!(r.gate_denials["gate_ci_not_green"], 2);
		assert_eq!(r.gate_denials["gate_main_branch"], 1);
	}
}
