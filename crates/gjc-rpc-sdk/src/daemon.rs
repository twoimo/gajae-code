//! Phase 3 (G004): daemon decision/routing core.
//!
//! Ties the UDS edge to the verified Boundary-B core: `hello` negotiation +
//! capability authorization (via [`crate::authz_eval::CapabilityAuthorizer`])
//! BEFORE any scheduling/broker/replay/fanout, and PER-SUBSCRIBER daemon-side
//! redaction (via [`crate::redactor::DaemonRedactor`]) immediately before fanout.
//! The per-session core retains RAW canonical frames; redaction is applied per
//! subscriber grant, so one subscriber's policy never becomes a global per-session
//! decision (multi-subscriber UDS).
//!
//! This module is the transport-agnostic decision logic; `uds_transport` carries
//! the bytes. Keeping it pure makes the full UDS authz negative suite unit-testable.

use crate::SessionId;
use crate::authz::{Authorizer, Principal, RedactionPolicy, Scope};
use crate::authz_eval::{CapabilityAuthorizer, DenyReason};
use crate::frame::GjcFrame;
use crate::redaction::Redactor;
use crate::redactor::DaemonRedactor;

/// A client's negotiated subscription to one session (result of an authorized hello).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
	pub session: SessionId,
	/// Redaction policy applied to this subscriber's fanout/replay (per grant).
	pub redaction: RedactionPolicy,
}

/// Accepted hello result: the authorized subscriptions + granted scopes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloAccept {
	pub protocol_version: u32,
	pub principal: Principal,
	pub subscriptions: Vec<Subscription>,
}

/// The daemon decision core. Authz is fail-closed and runs before side effects.
pub struct Daemon {
	authorizer: CapabilityAuthorizer,
	redactor: DaemonRedactor,
}

impl Daemon {
	#[must_use]
	pub const fn new(authorizer: CapabilityAuthorizer) -> Self {
		Self { authorizer, redactor: DaemonRedactor }
	}

	/// Authorize a single (session, scope) action. Runs BEFORE scheduling, broker
	/// reply, replay, or fanout. Fail-closed.
	pub fn authorize(
		&self,
		principal: &Principal,
		session: &SessionId,
		scope: Scope,
	) -> Result<(), DenyReason> {
		self.authorizer.authorize(principal, session, scope)
	}

	/// Negotiate hello: the client requests `subscribe` on each session in
	/// `requested_sessions`; every one must authorize or the WHOLE handshake fails
	/// (no post-hello frames flow on denial). Returns the accepted subscriptions
	/// with each session's per-grant redaction policy.
	pub fn negotiate_hello(
		&self,
		protocol_version: u32,
		principal: &Principal,
		requested_sessions: &[(SessionId, RedactionPolicy)],
	) -> Result<HelloAccept, DenyReason> {
		if protocol_version != crate::PROTOCOL_VERSION {
			return Err(DenyReason::ScopeNotGranted); // version mismatch -> reject handshake
		}
		let mut subscriptions = Vec::new();
		for (session, redaction) in requested_sessions {
			// subscribe scope is required to receive a session's frames.
			self.authorize(principal, session, Scope::Subscribe)?;
			subscriptions.push(Subscription { session: session.clone(), redaction: *redaction });
		}
		Ok(HelloAccept { protocol_version, principal: principal.clone(), subscriptions })
	}

	/// Authorize session enumeration (separate from per-session subscribe).
	pub fn authorize_enumerate(
		&self,
		principal: &Principal,
		session: &SessionId,
	) -> Result<(), DenyReason> {
		self.authorize(principal, session, Scope::Enumerate)
	}

	/// Fan a RAW canonical frame out to one subscriber, applying that subscriber's
	/// per-grant redaction immediately before send. The raw frame is never mutated;
	/// each subscriber gets its own redacted copy.
	#[must_use]
	pub fn fanout_to_subscriber(&self, raw: &GjcFrame, sub: &Subscription) -> GjcFrame {
		self.redactor.redact(raw.clone(), sub.redaction)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::authz::{GrantAudit, GrantLimits, GrantRecord};
	use crate::frame::{FrameKind, GjcFrame};
	use crate::{Direction, FrameId, PROTOCOL_VERSION, Seq};

	const NOW: &str = "2026-06-01T00:00:00Z";

	fn caller() -> Principal {
		Principal::Unix { uid: 501, gid: 20, pid: Some(9) }
	}

	fn grant(sessions: Vec<&str>, scopes: Vec<Scope>, issuer: &str) -> GrantRecord {
		GrantRecord {
			version: 1,
			grant_id: "g".into(),
			principal_binding: Principal::Unix { uid: 501, gid: 20, pid: None },
			bearer_hash: None,
			issued_at: "2026-01-01T00:00:00Z".into(),
			expires_at: "2026-12-31T00:00:00Z".into(),
			renewable_until: "2027-01-01T00:00:00Z".into(),
			revoked_at: None,
			issuer: issuer.into(),
			purpose: "test".into(),
			sessions: sessions.into_iter().map(String::from).collect(),
			scopes,
			redaction_policy: RedactionPolicy::Redacted,
			limits: GrantLimits::default(),
			audit: GrantAudit::default(),
		}
	}

	fn daemon(grants: Vec<GrantRecord>) -> Daemon {
		Daemon::new(CapabilityAuthorizer::new(grants, NOW))
	}

	fn sid(s: &str) -> SessionId {
		SessionId(s.into())
	}

	// --- Named UDS authz negative suite (decision logic over the daemon path) ---

	#[test]
	fn authz_cross_session_subscribe_denied() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		assert_eq!(
			d.authorize(&caller(), &sid("s2"), Scope::Subscribe),
			Err(DenyReason::SessionNotInGrant)
		);
	}

	#[test]
	fn authz_enumeration_without_grant_denied() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		assert_eq!(d.authorize_enumerate(&caller(), &sid("s1")), Err(DenyReason::ScopeNotGranted));
	}

	#[test]
	fn authz_read_without_subscribe_denied() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Control], "cli")]);
		assert_eq!(d.authorize(&caller(), &sid("s1"), Scope::Read), Err(DenyReason::ScopeNotGranted));
	}

	#[test]
	fn authz_control_without_control_denied() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		assert_eq!(
			d.authorize(&caller(), &sid("s1"), Scope::Control),
			Err(DenyReason::ScopeNotGranted)
		);
	}

	#[test]
	fn authz_gate_answer_denied() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		assert_eq!(
			d.authorize(&caller(), &sid("s1"), Scope::GateAnswer),
			Err(DenyReason::ScopeNotGranted)
		);
	}

	#[test]
	fn authz_host_tool_result_denied() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		assert_eq!(
			d.authorize(&caller(), &sid("s1"), Scope::HostToolResult),
			Err(DenyReason::ScopeNotGranted)
		);
	}

	#[test]
	fn authz_host_uri_result_denied() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		assert_eq!(
			d.authorize(&caller(), &sid("s1"), Scope::HostUriResult),
			Err(DenyReason::ScopeNotGranted)
		);
	}

	#[test]
	fn authz_revoked_grant_denied_everywhere() {
		let mut g = grant(vec!["s1"], vec![Scope::Subscribe, Scope::Control], "cli");
		g.revoked_at = Some("2026-05-01T00:00:00Z".into());
		let d = daemon(vec![g]);
		assert_eq!(
			d.authorize(&caller(), &sid("s1"), Scope::Subscribe),
			Err(DenyReason::GrantRevoked)
		);
		assert_eq!(d.authorize(&caller(), &sid("s1"), Scope::Control), Err(DenyReason::GrantRevoked));
	}

	#[test]
	fn authz_redacts_live_and_replay_frames() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		let raw = GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("f1".into()),
			session_id: sid("s1"),
			seq: Seq(1),
			direction: Direction::ServerToClient,
			kind: FrameKind::Notification,
			r#type: "turn_stream".into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({"secret": "data"}),
		};
		let sub = Subscription { session: sid("s1"), redaction: RedactionPolicy::Redacted };
		let out = d.fanout_to_subscriber(&raw, &sub);
		assert_eq!(out.payload, serde_json::json!({"redacted": true}));
		// Raw retained unchanged for other subscribers (per-subscriber redaction).
		assert_eq!(raw.payload, serde_json::json!({"secret": "data"}));
	}

	// --- hello negotiation ---

	#[test]
	fn uds_hello_negotiates_protocol_1_scopes_principal_grants_and_filters() {
		let d = daemon(vec![grant(vec!["s1", "s2"], vec![Scope::Subscribe], "cli")]);
		let accept = d
			.negotiate_hello(
				PROTOCOL_VERSION,
				&caller(),
				&[(sid("s1"), RedactionPolicy::Redacted), (sid("s2"), RedactionPolicy::Full)],
			)
			.expect("hello accepted");
		assert_eq!(accept.protocol_version, 1);
		assert_eq!(accept.subscriptions.len(), 2);
		assert_eq!(accept.subscriptions[1].redaction, RedactionPolicy::Full);
	}

	#[test]
	fn uds_hello_wrong_version_rejected() {
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		assert!(
			d.negotiate_hello(2, &caller(), &[(sid("s1"), RedactionPolicy::Redacted)])
				.is_err()
		);
	}

	#[test]
	fn uds_hello_denied_grant_fails_whole_handshake() {
		// Requesting a session not in the grant fails the entire hello (no partial).
		let d = daemon(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")]);
		let res = d.negotiate_hello(
			PROTOCOL_VERSION,
			&caller(),
			&[(sid("s1"), RedactionPolicy::Redacted), (sid("s2"), RedactionPolicy::Redacted)],
		);
		assert_eq!(res, Err(DenyReason::SessionNotInGrant));
	}
}
