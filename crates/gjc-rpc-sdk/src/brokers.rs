//! Phase 4 broker and notification action lifecycles.
//!
//! Builds on [`crate::broker_correlation`] with principal ownership so only the
//! caller that opened a broker correlation may resolve, reply, or cancel it.

use std::collections::HashMap;

use crate::authz::{Authorizer, Principal, Scope};
use crate::authz_eval::{CapabilityAuthorizer, DenyReason};
use crate::broker_correlation::{BrokerCorrelations, BrokerError, BrokerKind};
use crate::frame::{FrameKind, GjcFrame};
use crate::{CorrelationId, SessionId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerLifecycleError {
	MissingCorrelation,
	UnknownCorrelation,
	AlreadyResolved,
	DuplicateCorrelation,
	WrongPrincipal,
	WrongKind { expected: BrokerKind, actual: BrokerKind },
	SessionMismatch,
	Denied(DenyReason),
	TerminalNotification,
}

impl From<BrokerError> for BrokerLifecycleError {
	fn from(value: BrokerError) -> Self {
		match value {
			BrokerError::UnknownCorrelation => Self::UnknownCorrelation,
			BrokerError::AlreadyResolved => Self::AlreadyResolved,
			BrokerError::DuplicateCorrelation => Self::DuplicateCorrelation,
		}
	}
}

#[derive(Debug, Clone)]
struct BrokerEntry {
	principal: Principal,
	session: SessionId,
	kind: BrokerKind,
}

/// Aggregate broker lifecycle for extension UI, workflow gate, host tool, and host URI.
#[derive(Debug)]
pub struct Brokers {
	correlations: BrokerCorrelations,
	owners: HashMap<String, BrokerEntry>,
	authorizer: CapabilityAuthorizer,
}

impl Brokers {
	#[must_use]
	pub fn new(authorizer: CapabilityAuthorizer) -> Self {
		Self { correlations: BrokerCorrelations::new(), owners: HashMap::new(), authorizer }
	}

	pub fn open(
		&mut self,
		principal: &Principal,
		frame: &GjcFrame,
		kind: BrokerKind,
	) -> Result<CorrelationId, BrokerLifecycleError> {
		let scope = scope_for_open(kind);
		self
			.authorizer
			.authorize(principal, &frame.session_id, scope)
			.map_err(BrokerLifecycleError::Denied)?;
		let id = frame
			.correlation_id
			.clone()
			.ok_or(BrokerLifecycleError::MissingCorrelation)?;
		let opened = self.correlations.open(id.clone(), kind)?;
		self.owners.insert(
			id.0,
			BrokerEntry { principal: principal.clone(), session: frame.session_id.clone(), kind },
		);
		Ok(opened)
	}

	pub fn resolve(
		&mut self,
		principal: &Principal,
		correlation: &CorrelationId,
		result: &GjcFrame,
	) -> Result<BrokerKind, BrokerLifecycleError> {
		let entry = self
			.owners
			.get(&correlation.0)
			.ok_or(BrokerLifecycleError::UnknownCorrelation)?
			.clone();
		if entry.principal != *principal {
			return Err(BrokerLifecycleError::WrongPrincipal);
		}
		self
			.authorizer
			.authorize(principal, &entry.session, scope_for_resolve(entry.kind))
			.map_err(BrokerLifecycleError::Denied)?;
		if result.session_id != entry.session {
			return Err(BrokerLifecycleError::SessionMismatch);
		}
		let actual = self.correlations.resolve(correlation)?;
		if actual != entry.kind {
			return Err(BrokerLifecycleError::WrongKind { expected: entry.kind, actual });
		}
		self.owners.remove(&correlation.0);
		Ok(actual)
	}

	pub fn cancel(
		&mut self,
		principal: &Principal,
		correlation: &CorrelationId,
	) -> Result<(), BrokerLifecycleError> {
		let entry = self
			.owners
			.get(&correlation.0)
			.ok_or(BrokerLifecycleError::UnknownCorrelation)?
			.clone();
		if entry.principal != *principal {
			return Err(BrokerLifecycleError::WrongPrincipal);
		}
		self
			.authorizer
			.authorize(principal, &entry.session, scope_for_resolve(entry.kind))
			.map_err(BrokerLifecycleError::Denied)?;
		let _ = self.correlations.resolve(correlation)?;
		self.owners.remove(&correlation.0);
		Ok(())
	}
}

#[must_use]
pub const fn broker_kind_for_frame(frame: &GjcFrame) -> Option<BrokerKind> {
	match frame.kind {
		FrameKind::UiRequest => Some(BrokerKind::ExtensionUi),
		FrameKind::WorkflowGate | FrameKind::PermissionRequest => Some(BrokerKind::WorkflowGate),
		FrameKind::HostToolCall => Some(BrokerKind::HostTool),
		FrameKind::HostUriRequest => Some(BrokerKind::HostUri),
		_ => None,
	}
}

const fn scope_for_open(kind: BrokerKind) -> Scope {
	match kind {
		BrokerKind::ExtensionUi | BrokerKind::WorkflowGate => Scope::GateAnswer,
		BrokerKind::HostTool => Scope::HostToolResult,
		BrokerKind::HostUri => Scope::HostUriResult,
	}
}

const fn scope_for_resolve(kind: BrokerKind) -> Scope {
	scope_for_open(kind)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationStatus {
	Open,
	Resolved,
	Expired,
}

#[derive(Debug, Clone)]
struct NotificationEntry {
	principal: Principal,
	session: SessionId,
	status: NotificationStatus,
}

#[derive(Debug)]
pub struct NotificationActions {
	authorizer: CapabilityAuthorizer,
	actions: HashMap<String, NotificationEntry>,
}

impl NotificationActions {
	#[must_use]
	pub fn new(authorizer: CapabilityAuthorizer) -> Self {
		Self { authorizer, actions: HashMap::new() }
	}

	pub fn open(
		&mut self,
		principal: &Principal,
		frame: &GjcFrame,
	) -> Result<CorrelationId, BrokerLifecycleError> {
		self
			.authorizer
			.authorize(principal, &frame.session_id, Scope::GateAnswer)
			.map_err(BrokerLifecycleError::Denied)?;
		let correlation = frame
			.correlation_id
			.clone()
			.ok_or(BrokerLifecycleError::MissingCorrelation)?;
		if self.actions.contains_key(&correlation.0) {
			return Err(BrokerLifecycleError::DuplicateCorrelation);
		}
		self.actions.insert(
			correlation.0.clone(),
			NotificationEntry {
				principal: principal.clone(),
				session: frame.session_id.clone(),
				status: NotificationStatus::Open,
			},
		);
		Ok(correlation)
	}

	fn terminal_entry(
		&mut self,
		principal: &Principal,
		frame: &GjcFrame,
	) -> Result<&mut NotificationEntry, BrokerLifecycleError> {
		let correlation = frame
			.correlation_id
			.as_ref()
			.ok_or(BrokerLifecycleError::MissingCorrelation)?;
		let entry = self
			.actions
			.get(&correlation.0)
			.ok_or(BrokerLifecycleError::UnknownCorrelation)?;
		if entry.principal != *principal {
			return Err(BrokerLifecycleError::WrongPrincipal);
		}
		if entry.session != frame.session_id {
			return Err(BrokerLifecycleError::SessionMismatch);
		}
		if entry.status != NotificationStatus::Open {
			return Err(BrokerLifecycleError::TerminalNotification);
		}
		self
			.authorizer
			.authorize(principal, &frame.session_id, Scope::GateAnswer)
			.map_err(BrokerLifecycleError::Denied)?;
		self
			.actions
			.get_mut(&correlation.0)
			.ok_or(BrokerLifecycleError::UnknownCorrelation)
	}

	pub fn callback(
		&mut self,
		principal: &Principal,
		frame: &GjcFrame,
	) -> Result<(), BrokerLifecycleError> {
		let entry = self.terminal_entry(principal, frame)?;
		entry.status = NotificationStatus::Resolved;
		Ok(())
	}

	pub fn expire(
		&mut self,
		principal: &Principal,
		frame: &GjcFrame,
	) -> Result<(), BrokerLifecycleError> {
		let entry = self.terminal_entry(principal, frame)?;
		entry.status = NotificationStatus::Expired;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::authz::{GrantAudit, GrantLimits, GrantRecord, RedactionPolicy};
	use crate::{Direction, FrameId, PROTOCOL_VERSION, Seq};

	fn principal(uid: u32) -> Principal {
		Principal::Unix { uid, gid: 20, pid: None }
	}

	fn grant(scopes: Vec<Scope>) -> GrantRecord {
		GrantRecord {
			version: 1,
			grant_id: "g".into(),
			principal_binding: principal(1),
			bearer_hash: None,
			issued_at: "2026-01-01T00:00:00Z".into(),
			expires_at: "2026-12-31T00:00:00Z".into(),
			renewable_until: "2027-01-01T00:00:00Z".into(),
			revoked_at: None,
			issuer: "cli".into(),
			purpose: "test".into(),
			sessions: vec!["s".into()],
			scopes,
			redaction_policy: RedactionPolicy::Redacted,
			limits: GrantLimits::default(),
			audit: GrantAudit::default(),
		}
	}

	fn frame(kind: FrameKind, seq: u64, corr: &str) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(format!("f{seq}")),
			session_id: SessionId("s".into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind,
			r#type: "request".into(),
			correlation_id: Some(CorrelationId(corr.into())),
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({"prompt":"ok"}),
		}
	}

	fn result(corr: &str) -> GjcFrame {
		frame(FrameKind::Response, 99, corr)
	}

	#[test]
	fn broker_roundtrip() {
		let authz = CapabilityAuthorizer::new(
			vec![grant(vec![Scope::GateAnswer, Scope::HostToolResult, Scope::HostUriResult])],
			"2026-06-01T00:00:00Z",
		);
		let mut brokers = Brokers::new(authz);
		let p = principal(1);
		let cases = [
			(FrameKind::UiRequest, BrokerKind::ExtensionUi, "c1"),
			(FrameKind::WorkflowGate, BrokerKind::WorkflowGate, "c2"),
			(FrameKind::HostToolCall, BrokerKind::HostTool, "c3"),
			(FrameKind::HostUriRequest, BrokerKind::HostUri, "c4"),
		];
		for (fk, bk, corr) in cases {
			let f = frame(fk, 1, corr);
			assert_eq!(broker_kind_for_frame(&f), Some(bk));
			let id = brokers.open(&p, &f, bk).unwrap();
			assert_eq!(id, CorrelationId(corr.into()));
			assert_eq!(brokers.resolve(&p, &id, &result(corr)).unwrap(), bk);
		}

		let f = frame(FrameKind::WorkflowGate, 2, "wrong");
		let id = brokers.open(&p, &f, BrokerKind::WorkflowGate).unwrap();
		assert_eq!(
			brokers.resolve(&principal(2), &id, &result("wrong")),
			Err(BrokerLifecycleError::WrongPrincipal)
		);
	}

	#[test]
	fn duplicate_open_same_owner_fails_and_resolved_tombstone_remains() {
		let authz =
			CapabilityAuthorizer::new(vec![grant(vec![Scope::GateAnswer])], "2026-06-01T00:00:00Z");
		let mut brokers = Brokers::new(authz);
		let p = principal(1);
		let f = frame(FrameKind::WorkflowGate, 1, "dup");
		let id = brokers.open(&p, &f, BrokerKind::WorkflowGate).unwrap();
		assert_eq!(
			brokers.open(&p, &f, BrokerKind::WorkflowGate),
			Err(BrokerLifecycleError::DuplicateCorrelation)
		);
		assert_eq!(brokers.resolve(&p, &id, &result("dup")).unwrap(), BrokerKind::WorkflowGate);
		assert_eq!(
			brokers.open(&p, &f, BrokerKind::WorkflowGate),
			Err(BrokerLifecycleError::DuplicateCorrelation)
		);
	}

	#[test]
	fn resolve_session_mismatch_fails_in_release() {
		let authz =
			CapabilityAuthorizer::new(vec![grant(vec![Scope::GateAnswer])], "2026-06-01T00:00:00Z");
		let mut brokers = Brokers::new(authz);
		let p = principal(1);
		let f = frame(FrameKind::WorkflowGate, 1, "mismatch");
		let id = brokers.open(&p, &f, BrokerKind::WorkflowGate).unwrap();
		let mut wrong_session = result("mismatch");
		wrong_session.session_id = SessionId("other".into());
		assert_eq!(
			brokers.resolve(&p, &id, &wrong_session),
			Err(BrokerLifecycleError::SessionMismatch)
		);
		assert_eq!(brokers.resolve(&p, &id, &result("mismatch")).unwrap(), BrokerKind::WorkflowGate);
	}

	#[test]
	fn cancel_authorizes_before_mutating_owner() {
		let authz =
			CapabilityAuthorizer::new(vec![grant(vec![Scope::GateAnswer])], "2026-06-01T00:00:00Z");
		let mut brokers = Brokers::new(authz);
		let p = principal(1);
		let f = frame(FrameKind::WorkflowGate, 1, "cancel");
		let id = brokers.open(&p, &f, BrokerKind::WorkflowGate).unwrap();
		assert_eq!(brokers.cancel(&principal(2), &id), Err(BrokerLifecycleError::WrongPrincipal));
		assert_eq!(brokers.resolve(&p, &id, &result("cancel")).unwrap(), BrokerKind::WorkflowGate);
	}

	#[test]
	fn notification_action_lifecycle_authz_checked() {
		let authz =
			CapabilityAuthorizer::new(vec![grant(vec![Scope::GateAnswer])], "2026-06-01T00:00:00Z");
		let mut actions = NotificationActions::new(authz);
		let p = principal(1);
		let f = frame(FrameKind::Notification, 1, "n1");
		let _id = actions.open(&p, &f).unwrap();
		assert_eq!(actions.callback(&principal(2), &f), Err(BrokerLifecycleError::WrongPrincipal));
		actions.callback(&p, &f).unwrap();
		let f2 = frame(FrameKind::Notification, 2, "n2");
		let _id2 = actions.open(&p, &f2).unwrap();
		actions.expire(&p, &f2).unwrap();
		assert_eq!(actions.callback(&p, &f), Err(BrokerLifecycleError::TerminalNotification));
		assert_eq!(actions.callback(&p, &f2), Err(BrokerLifecycleError::TerminalNotification));
		let f3 = frame(FrameKind::Notification, 3, "n2");
		assert_eq!(actions.open(&p, &f3), Err(BrokerLifecycleError::DuplicateCorrelation));
	}
}
