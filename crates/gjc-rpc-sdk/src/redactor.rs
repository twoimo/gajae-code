//! Phase 2: concrete daemon-side redactor.
//!
//! Applies `RedactionPolicy` to a frame immediately before replay and live fanout
//! (`authz.md`, mirrors the legacy `engine.ts`/`config.ts` semantics). Asks remain
//! answerable: their prompt/options are never redacted, otherwise a remote client
//! could not answer them. Streamed/content frames are suppressed under `Redacted`;
//! `MetadataOnly` strips every payload to a redaction marker.

use crate::authz::RedactionPolicy;
use crate::frame::{FrameKind, GjcFrame};

/// Frame `type`s that carry streamed/content payloads suppressed under `Redacted`.
/// Mirrors the legacy suppressed set (turn stream, context update, attachments).
const SUPPRESSED_CONTENT_TYPES: &[&str] =
	&["turn_stream", "context_update", "image_attachment", "file_attachment", "message_update"];

/// Whether a frame is an ask the human must read+answer remotely (never redacted).
fn is_ask(frame: &GjcFrame) -> bool {
	match frame.kind {
		FrameKind::WorkflowGate => true,
		FrameKind::Notification => frame.r#type == "action_needed",
		FrameKind::PermissionRequest | FrameKind::UiRequest => true,
		_ => false,
	}
}

fn redaction_marker() -> serde_json::Value {
	serde_json::json!({ "redacted": true })
}

/// The concrete redactor. Stateless.
#[derive(Debug, Default, Clone, Copy)]
pub struct DaemonRedactor;

impl crate::redaction::Redactor for DaemonRedactor {
	fn redact(&self, mut frame: GjcFrame, policy: RedactionPolicy) -> GjcFrame {
		match policy {
			// Everything delivered unchanged.
			RedactionPolicy::Full => frame,
			// Asks exempt; streamed/content payloads suppressed.
			RedactionPolicy::Redacted => {
				if is_ask(&frame) {
					return frame;
				}
				if SUPPRESSED_CONTENT_TYPES.contains(&frame.r#type.as_str()) {
					frame.payload = redaction_marker();
				}
				frame
			},
			// Strip every payload except asks (still answerable) to a marker.
			RedactionPolicy::MetadataOnly => {
				if is_ask(&frame) {
					return frame;
				}
				frame.payload = redaction_marker();
				frame
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::redaction::Redactor;
	use crate::{Direction, FrameId, PROTOCOL_VERSION, Seq, SessionId};

	fn frame(kind: FrameKind, ty: &str) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("f".into()),
			session_id: SessionId("s".into()),
			seq: Seq(1),
			direction: Direction::ServerToClient,
			kind,
			r#type: ty.into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({"secret": "data"}),
		}
	}

	#[test]
	fn full_policy_passes_everything() {
		let r = DaemonRedactor;
		let f = r.redact(frame(FrameKind::Event, "turn_stream"), RedactionPolicy::Full);
		assert_eq!(f.payload, serde_json::json!({"secret": "data"}));
	}

	#[test]
	fn redacted_suppresses_streamed_content() {
		let r = DaemonRedactor;
		let f = r.redact(frame(FrameKind::Notification, "turn_stream"), RedactionPolicy::Redacted);
		assert_eq!(f.payload, serde_json::json!({"redacted": true}));
	}

	#[test]
	fn redacted_keeps_asks_answerable() {
		let r = DaemonRedactor;
		let gate =
			r.redact(frame(FrameKind::WorkflowGate, "workflow_gate"), RedactionPolicy::Redacted);
		assert_eq!(gate.payload, serde_json::json!({"secret": "data"}));
		let ask =
			r.redact(frame(FrameKind::Notification, "action_needed"), RedactionPolicy::Redacted);
		assert_eq!(ask.payload, serde_json::json!({"secret": "data"}));
	}

	#[test]
	fn metadata_only_strips_non_asks_but_keeps_asks() {
		let r = DaemonRedactor;
		let ev = r.redact(frame(FrameKind::Event, "tool_result"), RedactionPolicy::MetadataOnly);
		assert_eq!(ev.payload, serde_json::json!({"redacted": true}));
		let ask = r.redact(
			frame(FrameKind::PermissionRequest, "permission_request"),
			RedactionPolicy::MetadataOnly,
		);
		assert_eq!(ask.payload, serde_json::json!({"secret": "data"}));
	}
}
