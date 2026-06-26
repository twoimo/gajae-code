//! Phase 2: concrete broker correlation tracker.
//!
//! Tracks open request/result correlations for extension-UI, workflow-gate,
//! host-tool, and host-URI flows (`protocol.md`, `topology.md`). Correlation
//! ownership is authoritative in the Rust core so a TS worker crash cannot lose or
//! double-resolve a broker exchange: resolving an unknown or already-resolved
//! correlation fails closed.

use std::collections::HashMap;

use crate::CorrelationId;

/// Why a broker resolve was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerError {
	UnknownCorrelation,
	AlreadyResolved,
	DuplicateCorrelation,
}

impl std::fmt::Display for BrokerError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(match self {
			Self::UnknownCorrelation => "unknown broker correlation",
			Self::AlreadyResolved => "broker correlation already resolved",
			Self::DuplicateCorrelation => "broker correlation already exists",
		})
	}
}

impl std::error::Error for BrokerError {}

/// What kind of broker exchange a correlation belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrokerKind {
	ExtensionUi,
	WorkflowGate,
	HostTool,
	HostUri,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
	Pending,
	Resolved,
}

/// Authoritative correlation tracker. One per daemon (keys are globally unique).
#[derive(Debug, Default)]
pub struct BrokerCorrelations {
	entries: HashMap<String, (BrokerKind, State)>,
}

impl BrokerCorrelations {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Register a new pending correlation. Duplicate ids fail closed, including
	/// resolved tombstones, so ownership cannot be overwritten by re-opening an id.
	pub fn open(
		&mut self,
		id: CorrelationId,
		kind: BrokerKind,
	) -> Result<CorrelationId, BrokerError> {
		if self.entries.contains_key(&id.0) {
			return Err(BrokerError::DuplicateCorrelation);
		}
		self.entries.insert(id.0.clone(), (kind, State::Pending));
		Ok(id)
	}

	/// Resolve a pending correlation. Fails closed if unknown or already resolved.
	pub fn resolve(&mut self, id: &CorrelationId) -> Result<BrokerKind, BrokerError> {
		match self.entries.get_mut(&id.0) {
			None => Err(BrokerError::UnknownCorrelation),
			Some((_, State::Resolved)) => Err(BrokerError::AlreadyResolved),
			Some((kind, state)) => {
				*state = State::Resolved;
				Ok(*kind)
			},
		}
	}

	/// Number of still-pending correlations (e.g. to fail on a worker crash).
	#[must_use]
	pub fn pending_count(&self) -> usize {
		self
			.entries
			.values()
			.filter(|(_, s)| *s == State::Pending)
			.count()
	}

	/// Drop all pending correlations (worker crash): returns the ids that were
	/// pending so the daemon can fail their sessions rather than blind-replay.
	pub fn fail_all_pending(&mut self) -> Vec<String> {
		let pending: Vec<String> = self
			.entries
			.iter()
			.filter(|(_, (_, s))| *s == State::Pending)
			.map(|(k, _)| k.clone())
			.collect();
		for k in &pending {
			self.entries.remove(k);
		}
		pending
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn id(s: &str) -> CorrelationId {
		CorrelationId(s.into())
	}

	#[test]
	fn open_then_resolve_returns_kind() {
		let mut b = BrokerCorrelations::new();
		b.open(id("c1"), BrokerKind::WorkflowGate).unwrap();
		assert_eq!(b.pending_count(), 1);
		assert_eq!(b.resolve(&id("c1")), Ok(BrokerKind::WorkflowGate));
		assert_eq!(b.pending_count(), 0);
	}

	#[test]
	fn duplicate_open_fails_for_pending_and_resolved_ids() {
		let mut b = BrokerCorrelations::new();
		b.open(id("c1"), BrokerKind::WorkflowGate).unwrap();
		assert_eq!(b.open(id("c1"), BrokerKind::HostTool), Err(BrokerError::DuplicateCorrelation));
		assert_eq!(b.resolve(&id("c1")), Ok(BrokerKind::WorkflowGate));
		assert_eq!(b.open(id("c1"), BrokerKind::HostTool), Err(BrokerError::DuplicateCorrelation));
	}

	#[test]
	fn double_resolve_fails_closed() {
		let mut b = BrokerCorrelations::new();
		b.open(id("c1"), BrokerKind::HostTool).unwrap();
		assert!(b.resolve(&id("c1")).is_ok());
		assert_eq!(b.resolve(&id("c1")), Err(BrokerError::AlreadyResolved));
	}

	#[test]
	fn unknown_correlation_fails_closed() {
		let mut b = BrokerCorrelations::new();
		assert_eq!(b.resolve(&id("nope")), Err(BrokerError::UnknownCorrelation));
	}

	#[test]
	fn worker_crash_fails_pending_correlations() {
		let mut b = BrokerCorrelations::new();
		b.open(id("c1"), BrokerKind::ExtensionUi).unwrap();
		b.open(id("c2"), BrokerKind::HostUri).unwrap();
		b.resolve(&id("c1")).unwrap();
		let mut failed = b.fail_all_pending();
		failed.sort();
		assert_eq!(failed, vec!["c2".to_string()]);
		assert_eq!(b.pending_count(), 0);
	}
}
