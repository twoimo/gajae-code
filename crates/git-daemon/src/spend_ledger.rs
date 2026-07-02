//! Observability-only spend ledger (D3).
//!
//! With enforced budgets removed (D3), the daemon **never** aborts a run for
//! cost/tokens/tool-calls/wall-time. This ledger therefore only *observes* and
//! aggregates usage so status/metrics can surface it — it has no cap, no
//! threshold, and no `enforce`/`abort` path by construction.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A single usage observation reported from an unattended run.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct UsageObservation {
	pub tokens:       u64,
	pub tool_calls:   u64,
	pub cost_usd:     f64,
	pub wall_time_ms: u64,
}

impl UsageObservation {
	fn add(&mut self, other: &Self) {
		self.add_observed(other);
	}

	/// Accumulate another observation (saturating for counters). Public so other
	/// subsystems (e.g. the RPC runner reducer) can fold observed usage.
	pub fn add_observed(&mut self, other: &Self) {
		self.tokens = self.tokens.saturating_add(other.tokens);
		self.tool_calls = self.tool_calls.saturating_add(other.tool_calls);
		self.cost_usd += other.cost_usd;
		self.wall_time_ms = self.wall_time_ms.saturating_add(other.wall_time_ms);
	}
}

/// Per-day aggregated usage.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct DayRollup {
	pub day:          String,
	pub observations: u64,
	pub total:        UsageObservation,
}

/// Observability-only ledger. There is intentionally no cap or enforcement API:
/// recording usage can never deny work or abort a run.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpendLedger {
	by_day:            BTreeMap<String, DayRollup>,
	grand_total:       UsageObservation,
	observation_count: u64,
}

impl SpendLedger {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a usage observation for a UTC `day` (e.g. `2026-01-01`). Always
	/// succeeds — there is no limit to exceed.
	pub fn observe(&mut self, day: &str, usage: &UsageObservation) {
		let entry = self
			.by_day
			.entry(day.to_owned())
			.or_insert_with(|| DayRollup { day: day.to_owned(), ..DayRollup::default() });
		entry.observations += 1;
		entry.total.add(usage);
		self.grand_total.add(usage);
		self.observation_count += 1;
	}

	/// Aggregated usage for a specific UTC day, if any was recorded.
	#[must_use]
	pub fn day(&self, day: &str) -> Option<&DayRollup> {
		self.by_day.get(day)
	}

	/// Cumulative usage across all recorded days.
	#[must_use]
	pub const fn grand_total(&self) -> &UsageObservation {
		&self.grand_total
	}

	/// Number of observations recorded.
	#[must_use]
	pub const fn observation_count(&self) -> u64 {
		self.observation_count
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn usage(tokens: u64, tool_calls: u64, cost: f64, wall: u64) -> UsageObservation {
		UsageObservation { tokens, tool_calls, cost_usd: cost, wall_time_ms: wall }
	}

	#[test]
	fn accumulates_within_a_day() {
		let mut l = SpendLedger::new();
		l.observe("2026-01-01", &usage(100, 2, 0.5, 1000));
		l.observe("2026-01-01", &usage(50, 1, 0.25, 500));
		let day = l.day("2026-01-01").unwrap();
		assert_eq!(day.observations, 2);
		assert_eq!(day.total.tokens, 150);
		assert_eq!(day.total.tool_calls, 3);
		assert!((day.total.cost_usd - 0.75).abs() < 1e-9);
		assert_eq!(day.total.wall_time_ms, 1500);
	}

	#[test]
	fn buckets_by_day() {
		let mut l = SpendLedger::new();
		l.observe("2026-01-01", &usage(10, 0, 0.0, 0));
		l.observe("2026-01-02", &usage(20, 0, 0.0, 0));
		assert_eq!(l.day("2026-01-01").unwrap().total.tokens, 10);
		assert_eq!(l.day("2026-01-02").unwrap().total.tokens, 20);
		assert_eq!(l.grand_total().tokens, 30);
		assert_eq!(l.observation_count(), 2);
	}

	#[test]
	fn huge_usage_is_observed_never_capped() {
		// D3: there is no enforcement path; even enormous usage just accumulates.
		let mut l = SpendLedger::new();
		for _ in 0..1000 {
			l.observe("2026-01-01", &usage(10_000_000, 10_000, 1_000.0, 3_600_000));
		}
		let total = l.grand_total();
		assert_eq!(total.tokens, 10_000_000_000);
		assert_eq!(total.tool_calls, 10_000_000);
		assert!(total.cost_usd >= 1_000_000.0);
		// The only "result" of recording is a bigger number — never an error/abort.
		assert_eq!(l.observation_count(), 1000);
	}

	#[test]
	fn round_trips_through_serde() {
		let mut l = SpendLedger::new();
		l.observe("2026-01-01", &usage(5, 1, 0.1, 10));
		let json = serde_json::to_string(&l).unwrap();
		let back: SpendLedger = serde_json::from_str(&json).unwrap();
		assert_eq!(back.grand_total().tokens, 5);
		assert_eq!(back.day("2026-01-01").unwrap().observations, 1);
	}
}
