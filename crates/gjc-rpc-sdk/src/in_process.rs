//! Phase 2: in-process pipeline composing the Boundary-B core.
//!
//! Wires the classifier, two-lane scheduler, capability authorizer, replay store,
//! and redactor into one cohesive in-memory pipeline for a single session. This is
//! the zero-serialization in-process path's *logic* (the native TUI binds it via
//! N-API): runtime input and output move as typed `GjcFrame` / command values with
//! no serde round-trip. The N-API FFI shim and a TS-side e2e are separate Phase 2
//! deliverables; this module proves the composed Rust semantics end to end.

use crate::authz::{Authorizer, RedactionPolicy};
use crate::authz::{Principal, Scope};
use crate::authz_eval::{CapabilityAuthorizer, DenyReason};
use crate::classifier::ManifestCommandClassifier;
use crate::frame::GjcFrame;
use crate::redaction::Redactor;
use crate::redactor::DaemonRedactor;
use crate::replay_store::{ReplayOutcome, ReplayStore};
use crate::scheduler::{CommandClassifier, Lane};
use crate::session_scheduler::{Dispatch, SessionScheduler};
use crate::{Seq, SessionId};

/// Why a pipeline submission was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineError {
	/// Authorization denied (with the fail-closed reason).
	Denied(DenyReason),
	/// The command is not in the generated manifest.
	UnknownCommand(String),
}

impl std::fmt::Display for PipelineError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Denied(r) => write!(f, "denied: {r}"),
			Self::UnknownCommand(c) => write!(f, "unknown command: {c}"),
		}
	}
}

impl std::error::Error for PipelineError {}

/// The scope a command requires, derived from its lane: pure reads need `Read`,
/// everything else (cancellation + ordered mutations) needs `Control`.
const fn required_scope(lane: Lane) -> Scope {
	match lane {
		Lane::FastLaneSafeRead => Scope::Read,
		Lane::FastLaneCancellation | Lane::Ordered => Scope::Control,
	}
}

/// Single-session in-process pipeline. The daemon owns one per active session.
pub struct InProcessPipeline {
	session: SessionId,
	classifier: ManifestCommandClassifier,
	scheduler: SessionScheduler,
	authorizer: CapabilityAuthorizer,
	replay: ReplayStore,
	redactor: DaemonRedactor,
	default_policy: RedactionPolicy,
}

impl InProcessPipeline {
	#[must_use]
	pub fn new(
		session: SessionId,
		authorizer: CapabilityAuthorizer,
		replay_capacity: usize,
		policy: RedactionPolicy,
	) -> Self {
		Self {
			session: session.clone(),
			classifier: ManifestCommandClassifier::from_embedded(),
			scheduler: SessionScheduler::new(),
			authorizer,
			replay: ReplayStore::new(session, replay_capacity),
			redactor: DaemonRedactor,
			default_policy: policy,
		}
	}

	/// Submit runtime input: authorize (before scheduling), classify, schedule.
	/// Authorization runs before any side effect, per `authz.md`.
	pub fn submit(
		&mut self,
		principal: &Principal,
		command: &str,
	) -> Result<Dispatch, PipelineError> {
		let lane = self
			.classifier
			.lane_for(command)
			.map_err(|e| PipelineError::UnknownCommand(e.0))?;
		self
			.authorizer
			.authorize(principal, &self.session, required_scope(lane))
			.map_err(PipelineError::Denied)?;
		Ok(self.scheduler.submit(command, lane))
	}

	/// Mark the current ordered command complete and return the next promoted command, if any.
	pub fn complete_ordered(&mut self) -> Option<String> {
		self.scheduler.complete_ordered()
	}

	/// Emit a runtime-output frame: store the raw canonical frame for replay and
	/// return a frame redacted with the pipeline's default in-process policy.
	pub fn emit(&mut self, frame: GjcFrame) -> GjcFrame {
		self.emit_for_policy(frame, self.default_policy)
	}

	/// Emit for a daemon subscriber policy while retaining only raw canonical data.
	pub fn emit_for_policy(&mut self, frame: GjcFrame, policy: RedactionPolicy) -> GjcFrame {
		self.append_raw(frame.clone());
		self.render_for_policy(frame, policy)
	}

	/// Append one raw runtime-output frame to replay storage.
	pub fn append_raw(&mut self, frame: GjcFrame) {
		self.replay.append(frame);
	}

	/// Render one frame for a subscriber without mutating replay storage.
	#[must_use]
	pub fn render_for_policy(&self, frame: GjcFrame, policy: RedactionPolicy) -> GjcFrame {
		self.redactor.redact(frame, policy)
	}

	/// Replay after `cursor` with the default in-process policy.
	#[must_use]
	pub fn replay_from(&self, cursor: Seq) -> ReplayOutcome {
		self.replay_from_for_policy(cursor, self.default_policy)
	}

	/// Replay raw canonical frames after `cursor`, applying redaction per subscriber.
	#[must_use]
	pub fn replay_from_for_policy(&self, cursor: Seq, policy: RedactionPolicy) -> ReplayOutcome {
		match self.replay.replay_from(cursor) {
			ReplayOutcome::Frames(frames) => ReplayOutcome::Frames(
				frames
					.into_iter()
					.map(|frame| self.redactor.redact(frame, policy))
					.collect(),
			),
			reset => reset,
		}
	}

	#[must_use]
	pub const fn replay_store(&self) -> &ReplayStore {
		&self.replay
	}

	/// Native binding marker: this pipeline never serializes frames (typed in-memory).
	#[must_use]
	pub const fn is_zero_serialization(&self) -> bool {
		true
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::authz::{GrantAudit, GrantLimits, GrantRecord};
	use crate::frame::{FrameKind, GjcFrame};
	use crate::{Direction, FrameId, PROTOCOL_VERSION};

	fn caller() -> Principal {
		Principal::Unix { uid: 501, gid: 20, pid: Some(7) }
	}

	fn grant(session: &str, scopes: Vec<Scope>) -> GrantRecord {
		GrantRecord {
			version: 1,
			grant_id: "g".into(),
			principal_binding: Principal::Unix { uid: 501, gid: 20, pid: None },
			bearer_hash: None,
			issued_at: "2026-01-01T00:00:00Z".into(),
			expires_at: "2026-12-31T00:00:00Z".into(),
			renewable_until: "2027-01-01T00:00:00Z".into(),
			revoked_at: None,
			issuer: "cli".into(),
			purpose: "test".into(),
			sessions: vec![session.into()],
			scopes,
			redaction_policy: RedactionPolicy::Redacted,
			limits: GrantLimits::default(),
			audit: GrantAudit::default(),
		}
	}

	fn pipeline(scopes: Vec<Scope>) -> InProcessPipeline {
		let authz = CapabilityAuthorizer::new(vec![grant("s", scopes)], "2026-06-01T00:00:00Z");
		InProcessPipeline::new(SessionId("s".into()), authz, 16, RedactionPolicy::Redacted)
	}

	fn content_frame(seq: u64) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(format!("f{seq}")),
			session_id: SessionId("s".into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind: FrameKind::Notification,
			r#type: "turn_stream".into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({"text": "secret"}),
		}
	}

	#[test]
	fn end_to_end_in_process_flow() {
		let mut p = pipeline(vec![Scope::Control, Scope::Read, Scope::Subscribe]);
		assert!(p.is_zero_serialization());

		assert_eq!(p.submit(&caller(), "prompt").unwrap(), Dispatch::Immediate);
		assert_eq!(p.submit(&caller(), "bash").unwrap(), Dispatch::Queued(1));
		assert_eq!(p.submit(&caller(), "abort_bash").unwrap(), Dispatch::Immediate);

		let fanned = p.emit(content_frame(1));
		assert_eq!(fanned.payload, serde_json::json!({"redacted": true}));

		p.emit(content_frame(2));
		let ReplayOutcome::Frames(out) = p.replay_from(Seq(0)) else {
			panic!("expected frames");
		};
		assert_eq!(out.len(), 2);
		assert!(
			out.iter()
				.all(|f| f.replay && f.payload == serde_json::json!({"redacted": true}))
		);
	}

	#[test]
	fn raw_replay_redacts_per_subscriber_policy() {
		let mut p = pipeline(vec![Scope::Subscribe]);
		assert_eq!(
			p.emit_for_policy(content_frame(1), RedactionPolicy::Full)
				.payload,
			serde_json::json!({"text": "secret"})
		);
		let ReplayOutcome::Frames(redacted) =
			p.replay_from_for_policy(Seq(0), RedactionPolicy::Redacted)
		else {
			panic!("expected frames");
		};
		assert_eq!(redacted[0].payload, serde_json::json!({"redacted": true}));
		let ReplayOutcome::Frames(full) = p.replay_from_for_policy(Seq(0), RedactionPolicy::Full)
		else {
			panic!("expected frames");
		};
		assert_eq!(full[0].payload, serde_json::json!({"text": "secret"}));
	}

	#[test]
	fn control_denied_before_scheduling() {
		let mut p = pipeline(vec![Scope::Read]);
		assert_eq!(
			p.submit(&caller(), "prompt"),
			Err(PipelineError::Denied(DenyReason::ScopeNotGranted))
		);
		assert_eq!(p.submit(&caller(), "get_state").unwrap(), Dispatch::Immediate);
	}

	#[test]
	fn unknown_command_rejected() {
		let mut p = pipeline(vec![Scope::Control]);
		assert_eq!(
			p.submit(&caller(), "bogus"),
			Err(PipelineError::UnknownCommand("bogus".to_string()))
		);
	}
}
