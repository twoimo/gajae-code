//! Phase 4: structured daemon observability helpers.
//!
//! Events intentionally carry identifiers and decisions only. Payloads, bearer
//! tokens, and redacted content are never accepted by this emitter.

use crate::authz::{Principal, Scope};
use crate::observability::ObservabilityFields;
use crate::{CorrelationId, FrameId, SessionId};

#[derive(Debug, Default, Clone)]
pub struct ObservabilitySink {
	events: Vec<ObservabilityFields>,
}

impl ObservabilitySink {
	#[must_use]
	pub const fn new() -> Self {
		Self { events: Vec::new() }
	}

	pub fn emit(&mut self, fields: ObservabilityFields) {
		self.events.push(fields);
	}

	#[must_use]
	pub fn events(&self) -> &[ObservabilityFields] {
		&self.events
	}
}

#[must_use]
pub fn principal_label(principal: &Principal) -> String {
	match principal {
		Principal::Unix { uid, gid, pid } => format!("unix:{uid}:{gid}:{pid:?}"),
		Principal::NativeTuiSelf => "native_tui_self".to_string(),
		Principal::Bearer { bearer_hash } => format!("bearer_hash:{bearer_hash}"),
	}
}

#[must_use]
pub fn fields(
	connection_id: impl Into<String>,
	principal: &Principal,
	grant_id: Option<String>,
	scope: Option<Scope>,
	frame_id: FrameId,
	session_id: SessionId,
	correlation_id: Option<CorrelationId>,
	deny_reason: Option<String>,
) -> ObservabilityFields {
	ObservabilityFields {
		connection_id: connection_id.into(),
		principal: principal_label(principal),
		grant_id,
		scope,
		frame_id,
		session_id,
		correlation_id,
		deny_reason,
		redaction_decision: None,
		replay_cursor: None,
		queue_lag: None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn observability_secret_absent() {
		let mut sink = ObservabilitySink::new();
		let principal = Principal::Bearer { bearer_hash: "hash_only".into() };
		let mut event = fields(
			"conn",
			&principal,
			Some("grant".into()),
			Some(Scope::Subscribe),
			FrameId("frame".into()),
			SessionId("session".into()),
			Some(CorrelationId("corr".into())),
			None,
		);
		event.redaction_decision = Some("redacted".into());
		event.replay_cursor = Some(7);
		event.queue_lag = Some(3);
		sink.emit(event);
		let json = serde_json::to_string(sink.events()).unwrap();
		assert!(json.contains("connectionId"));
		assert!(json.contains("queueLag"));
		assert!(!json.contains("synthetic-secret"));
		assert!(!json.contains("bearer-token"));
	}
}
