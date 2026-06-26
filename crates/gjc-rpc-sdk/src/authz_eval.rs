//! Phase 2: concrete capability authorizer.
//!
//! Implements the fail-closed decision logic from `docs/rpc-sdk/authz.md`: a grant
//! must be unrevoked and unexpired, bound to the calling principal, cover the target
//! session (explicit id or the reserved `"all"`, admin-only), and carry the required
//! scope. Every failure path denies. Redaction and replay enforcement live in their
//! own modules; this type answers the schedule/broker/fanout authorization question.

use crate::SessionId;
use crate::authz::{Authorizer, GrantRecord, Principal, Scope};

/// Reason an authorization was denied (stable, log-safe — no secrets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenyReason {
	NoGrantForPrincipal,
	GrantRevoked,
	GrantExpired,
	SessionNotInGrant,
	ScopeNotGranted,
	AllSessionsRequiresAdminIssuer,
}

impl std::fmt::Display for DenyReason {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let s = match self {
			Self::NoGrantForPrincipal => "no grant for principal",
			Self::GrantRevoked => "grant revoked",
			Self::GrantExpired => "grant expired",
			Self::SessionNotInGrant => "session not in grant",
			Self::ScopeNotGranted => "scope not granted",
			Self::AllSessionsRequiresAdminIssuer => "all-sessions grant requires admin issuer",
		};
		f.write_str(s)
	}
}

impl std::error::Error for DenyReason {}

const ALL_SESSIONS: &str = "all";
const ADMIN_ISSUER: &str = "admin";

fn principal_matches(grant: &Principal, caller: &Principal) -> bool {
	match (grant, caller) {
		(Principal::Unix { uid: a, gid: b, .. }, Principal::Unix { uid: c, gid: d, .. }) => {
			a == c && b == d
		},
		(Principal::NativeTuiSelf, Principal::NativeTuiSelf) => true,
		(Principal::Bearer { bearer_hash: a }, Principal::Bearer { bearer_hash: b }) => a == b,
		_ => false,
	}
}

/// Whether a grant authorizes `scope` on `session` at time `now` (ISO-8601 UTC,
/// lexicographically comparable). Returns the first failing reason, or Ok.
fn grant_allows(
	grant: &GrantRecord,
	session: &SessionId,
	scope: Scope,
	now: &str,
) -> Result<(), DenyReason> {
	if grant.revoked_at.is_some() {
		return Err(DenyReason::GrantRevoked);
	}
	if now >= grant.expires_at.as_str() {
		return Err(DenyReason::GrantExpired);
	}
	let covers_all = grant.sessions.iter().any(|s| s == ALL_SESSIONS);
	if covers_all && grant.issuer != ADMIN_ISSUER {
		return Err(DenyReason::AllSessionsRequiresAdminIssuer);
	}
	let covers_session = covers_all || grant.sessions.iter().any(|s| s == &session.0);
	if !covers_session {
		return Err(DenyReason::SessionNotInGrant);
	}
	if !grant.scopes.contains(&scope) {
		return Err(DenyReason::ScopeNotGranted);
	}
	Ok(())
}

/// Authorizer over a set of persisted grants, evaluated at a fixed `now`.
#[derive(Debug, Clone)]
pub struct CapabilityAuthorizer {
	grants: Vec<GrantRecord>,
	now: String,
}

impl CapabilityAuthorizer {
	#[must_use]
	pub fn new(grants: Vec<GrantRecord>, now: impl Into<String>) -> Self {
		Self { grants, now: now.into() }
	}
}

impl Authorizer for CapabilityAuthorizer {
	type Error = DenyReason;

	fn authorize(
		&self,
		principal: &Principal,
		session: &SessionId,
		scope: Scope,
	) -> Result<(), Self::Error> {
		let mut matched_any = false;
		let mut last_reason = DenyReason::NoGrantForPrincipal;
		for grant in &self.grants {
			if !principal_matches(&grant.principal_binding, principal) {
				continue;
			}
			matched_any = true;
			match grant_allows(grant, session, scope, &self.now) {
				Ok(()) => return Ok(()),
				Err(reason) => last_reason = reason,
			}
		}
		if matched_any {
			Err(last_reason)
		} else {
			Err(DenyReason::NoGrantForPrincipal)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::authz::{GrantAudit, GrantLimits, RedactionPolicy};

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

	const NOW: &str = "2026-06-01T00:00:00Z";
	fn caller() -> Principal {
		Principal::Unix { uid: 501, gid: 20, pid: Some(99) }
	}

	#[test]
	fn grants_control_on_listed_session() {
		let a = CapabilityAuthorizer::new(vec![grant(vec!["s1"], vec![Scope::Control], "cli")], NOW);
		assert!(
			a.authorize(&caller(), &SessionId("s1".into()), Scope::Control)
				.is_ok()
		);
	}

	#[test]
	fn denies_cross_session_subscribe() {
		let a =
			CapabilityAuthorizer::new(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")], NOW);
		assert_eq!(
			a.authorize(&caller(), &SessionId("s2".into()), Scope::Subscribe),
			Err(DenyReason::SessionNotInGrant)
		);
	}

	#[test]
	fn denies_control_without_control_scope() {
		let a =
			CapabilityAuthorizer::new(vec![grant(vec!["s1"], vec![Scope::Subscribe], "cli")], NOW);
		assert_eq!(
			a.authorize(&caller(), &SessionId("s1".into()), Scope::Control),
			Err(DenyReason::ScopeNotGranted)
		);
	}

	#[test]
	fn denies_revoked_grant_everywhere() {
		let mut g = grant(vec!["s1"], vec![Scope::Control], "cli");
		g.revoked_at = Some("2026-05-01T00:00:00Z".into());
		let a = CapabilityAuthorizer::new(vec![g], NOW);
		assert_eq!(
			a.authorize(&caller(), &SessionId("s1".into()), Scope::Control),
			Err(DenyReason::GrantRevoked)
		);
	}

	#[test]
	fn denies_expired_grant() {
		let mut g = grant(vec!["s1"], vec![Scope::Control], "cli");
		g.expires_at = "2026-02-01T00:00:00Z".into();
		let a = CapabilityAuthorizer::new(vec![g], NOW);
		assert_eq!(
			a.authorize(&caller(), &SessionId("s1".into()), Scope::Control),
			Err(DenyReason::GrantExpired)
		);
	}

	#[test]
	fn all_sessions_requires_admin_issuer() {
		let non_admin =
			CapabilityAuthorizer::new(vec![grant(vec!["all"], vec![Scope::Enumerate], "cli")], NOW);
		assert_eq!(
			non_admin.authorize(&caller(), &SessionId("any".into()), Scope::Enumerate),
			Err(DenyReason::AllSessionsRequiresAdminIssuer)
		);
		let admin =
			CapabilityAuthorizer::new(vec![grant(vec!["all"], vec![Scope::Enumerate], "admin")], NOW);
		assert!(
			admin
				.authorize(&caller(), &SessionId("any".into()), Scope::Enumerate)
				.is_ok()
		);
	}

	#[test]
	fn denies_when_no_grant_matches_principal() {
		let a = CapabilityAuthorizer::new(vec![grant(vec!["s1"], vec![Scope::Control], "cli")], NOW);
		let other = Principal::Unix { uid: 0, gid: 0, pid: None };
		assert_eq!(
			a.authorize(&other, &SessionId("s1".into()), Scope::Control),
			Err(DenyReason::NoGrantForPrincipal)
		);
	}
}
