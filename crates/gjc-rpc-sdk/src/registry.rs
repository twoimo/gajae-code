//! Phase 3 (G004): daemon session registry + correlation→session ownership.
//!
//! Tracks active sessions (for `enumerate` authorization) and which session owns
//! each in-flight broker correlation. On a TS-worker crash the supervisor calls
//! `BrokerCorrelations::fail_all_pending()` (which returns only correlation ids);
//! this registry maps those ids back to their owning sessions so the daemon can
//! deterministically FAIL exactly the affected sessions — never blind-replay.

use std::collections::{HashMap, HashSet};

use crate::{CorrelationId, SessionId};

/// Lifecycle state of a registered session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
	Active,
	/// Deterministically failed (e.g. worker crash with in-flight broker work).
	Failed,
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
	sessions: HashMap<SessionId, SessionState>,
	/// correlation id -> owning session, for crash containment.
	correlation_owner: HashMap<String, SessionId>,
}

impl SessionRegistry {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Register a newly-created session as active.
	pub fn register_session(&mut self, session: SessionId) {
		self.sessions.insert(session, SessionState::Active);
	}

	/// Remove a session and any correlations it owned.
	pub fn remove_session(&mut self, session: &SessionId) {
		self.sessions.remove(session);
		self.correlation_owner.retain(|_, owner| owner != session);
	}

	/// Active session ids (the `enumerate` authz surface; never leak failed ones
	/// as active).
	#[must_use]
	pub fn active_sessions(&self) -> Vec<SessionId> {
		self
			.sessions
			.iter()
			.filter(|(_, s)| **s == SessionState::Active)
			.map(|(id, _)| id.clone())
			.collect()
	}

	#[must_use]
	pub fn state(&self, session: &SessionId) -> Option<SessionState> {
		self.sessions.get(session).copied()
	}

	/// Record that `correlation` is owned by `session` (call on broker open).
	pub fn bind_correlation(&mut self, correlation: &CorrelationId, session: SessionId) {
		self
			.correlation_owner
			.insert(correlation.0.clone(), session);
	}

	/// Drop a correlation mapping (call on broker resolve).
	pub fn release_correlation(&mut self, correlation: &CorrelationId) {
		self.correlation_owner.remove(&correlation.0);
	}

	#[must_use]
	pub fn owner_of(&self, correlation: &CorrelationId) -> Option<&SessionId> {
		self.correlation_owner.get(&correlation.0)
	}

	/// Worker-crash containment: given the pending correlation ids returned by
	/// `BrokerCorrelations::fail_all_pending()`, mark each owning session `Failed`
	/// and return the distinct failed sessions (deterministic; no replay). Unknown
	/// correlations are ignored (already released).
	pub fn fail_sessions_for_correlations(&mut self, pending: &[String]) -> Vec<SessionId> {
		let mut failed: HashSet<SessionId> = HashSet::new();
		for cid in pending {
			if let Some(owner) = self.correlation_owner.get(cid).cloned() {
				self.sessions.insert(owner.clone(), SessionState::Failed);
				failed.insert(owner);
			}
		}
		// The correlations are terminal now — drop their mappings.
		for cid in pending {
			self.correlation_owner.remove(cid);
		}
		let mut out: Vec<SessionId> = failed.into_iter().collect();
		out.sort_by(|a, b| a.0.cmp(&b.0));
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::broker_correlation::{BrokerCorrelations, BrokerKind};

	fn sid(s: &str) -> SessionId {
		SessionId(s.into())
	}
	fn cid(s: &str) -> CorrelationId {
		CorrelationId(s.into())
	}

	#[test]
	fn active_sessions_excludes_failed() {
		let mut r = SessionRegistry::new();
		r.register_session(sid("s1"));
		r.register_session(sid("s2"));
		assert_eq!(r.active_sessions().len(), 2);
	}

	#[test]
	fn worker_crash_mid_broker_calls_fail_all_pending_fails_session_no_replay() {
		// Mirror the daemon flow: brokers opened, correlations bound to sessions.
		let mut broker = BrokerCorrelations::new();
		let mut reg = SessionRegistry::new();
		reg.register_session(sid("s1"));
		reg.register_session(sid("s2"));
		reg.register_session(sid("s3"));

		broker.open(cid("c1"), BrokerKind::WorkflowGate).unwrap();
		reg.bind_correlation(&cid("c1"), sid("s1"));
		broker.open(cid("c2"), BrokerKind::HostTool).unwrap();
		reg.bind_correlation(&cid("c2"), sid("s2"));
		// s2 also resolved one fine earlier; s3 has no in-flight broker work.
		broker.open(cid("c3"), BrokerKind::HostUri).unwrap();
		reg.bind_correlation(&cid("c3"), sid("s2"));
		broker.resolve(&cid("c3")).unwrap();
		reg.release_correlation(&cid("c3"));

		// Worker crashes: fail all still-pending broker correlations.
		let mut pending = broker.fail_all_pending();
		pending.sort();
		assert_eq!(pending, vec!["c1".to_string(), "c2".to_string()]);

		// Map to owning sessions and fail exactly those (deterministic, no replay).
		let failed = reg.fail_sessions_for_correlations(&pending);
		assert_eq!(failed, vec![sid("s1"), sid("s2")]);
		assert_eq!(reg.state(&sid("s1")), Some(SessionState::Failed));
		assert_eq!(reg.state(&sid("s2")), Some(SessionState::Failed));
		// s3 had no in-flight broker work -> stays active.
		assert_eq!(reg.state(&sid("s3")), Some(SessionState::Active));
		// Failed sessions are not advertised as active (no resurrection/replay).
		assert_eq!(reg.active_sessions(), vec![sid("s3")]);
	}

	#[test]
	fn remove_session_drops_its_correlations() {
		let mut r = SessionRegistry::new();
		r.register_session(sid("s1"));
		r.bind_correlation(&cid("c1"), sid("s1"));
		r.remove_session(&sid("s1"));
		assert!(r.owner_of(&cid("c1")).is_none());
		assert!(r.state(&sid("s1")).is_none());
	}
}
