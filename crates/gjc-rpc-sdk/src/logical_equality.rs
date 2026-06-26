//! Phase 2/3: cross-transport logical-frame equality.
//!
//! The native (in-process) and UDS transports must carry the IDENTICAL logical
//! frame stream (docs/rpc-sdk/protocol.md, runtime-port.md). The CI surrogate and
//! the Phase 5 conformance harness compare frames after transport normalization:
//! per-frame ids and wall-clock timestamps differ by construction and are ignored,
//! while every logical field — kind, type, payload, session, seq, correlation,
//! replay marker, and capability scope — must match exactly.

use crate::frame::GjcFrame;

/// The logical projection of a frame: everything that must match across transports
/// after normalization (frame id is dropped).
#[allow(
	clippy::derive_partial_eq_without_eq,
	reason = "payload is serde_json::Value which is PartialEq but not Eq"
)]
#[derive(Debug, Clone, PartialEq)]
pub struct LogicalFrame {
	pub protocol_version: u32,
	pub kind: crate::frame::FrameKind,
	pub session_id: crate::SessionId,
	pub seq: crate::Seq,
	pub direction: crate::Direction,
	pub r#type: String,
	pub correlation_id: Option<crate::CorrelationId>,
	pub replay: bool,
	pub capability_scope: Option<crate::authz::Scope>,
	pub payload: serde_json::Value,
}

impl LogicalFrame {
	/// Project a wire frame to its logical form (drops `frame_id`).
	#[must_use]
	pub fn of(frame: &GjcFrame) -> Self {
		Self {
			protocol_version: frame.protocol_version,
			kind: frame.kind,
			session_id: frame.session_id.clone(),
			seq: frame.seq,
			direction: frame.direction,
			r#type: frame.r#type.clone(),
			correlation_id: frame.correlation_id.clone(),
			replay: frame.replay,
			capability_scope: frame.capability_scope,
			payload: frame.payload.clone(),
		}
	}
}

/// True when two frames are logically equal across transports.
#[must_use]
pub fn logically_equal(a: &GjcFrame, b: &GjcFrame) -> bool {
	LogicalFrame::of(a) == LogicalFrame::of(b)
}

/// Compare two frame streams (e.g. the same vector replayed over `in_process` and
/// `uds`). Returns the index of the first divergence, or `None` if logically equal.
#[must_use]
pub fn first_divergence(in_process: &[GjcFrame], uds: &[GjcFrame]) -> Option<usize> {
	if in_process.len() != uds.len() {
		return Some(in_process.len().min(uds.len()));
	}
	in_process
		.iter()
		.zip(uds.iter())
		.position(|(a, b)| !logically_equal(a, b))
}

/// True when two frame streams are logically identical across transports.
#[must_use]
pub fn streams_logically_equal(in_process: &[GjcFrame], uds: &[GjcFrame]) -> bool {
	first_divergence(in_process, uds).is_none()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::frame::{FrameKind, GjcFrame};
	use crate::{CorrelationId, Direction, FrameId, PROTOCOL_VERSION, Seq, SessionId};

	fn frame(frame_id: &str, seq: u64, payload: serde_json::Value) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(frame_id.into()),
			session_id: SessionId("s".into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind: FrameKind::Event,
			r#type: "message_update".into(),
			correlation_id: Some(CorrelationId("c1".into())),
			replay: false,
			capability_scope: None,
			payload,
		}
	}

	#[test]
	fn differing_frame_ids_are_logically_equal() {
		let a = frame("in_process_f1", 1, serde_json::json!({"x": 1}));
		let b = frame("uds_f1", 1, serde_json::json!({"x": 1}));
		assert!(logically_equal(&a, &b));
	}

	#[test]
	fn differing_payload_breaks_equality() {
		let a = frame("f", 1, serde_json::json!({"x": 1}));
		let b = frame("f", 1, serde_json::json!({"x": 2}));
		assert!(!logically_equal(&a, &b));
	}

	#[test]
	fn differing_seq_breaks_equality() {
		let a = frame("f", 1, serde_json::json!({}));
		let b = frame("f", 2, serde_json::json!({}));
		assert!(!logically_equal(&a, &b));
	}

	#[test]
	fn equal_streams_have_no_divergence() {
		let ip = vec![
			frame("ip1", 1, serde_json::json!({"a": 1})),
			frame("ip2", 2, serde_json::json!({"a": 2})),
		];
		let uds = vec![
			frame("u1", 1, serde_json::json!({"a": 1})),
			frame("u2", 2, serde_json::json!({"a": 2})),
		];
		assert!(streams_logically_equal(&ip, &uds));
		assert_eq!(first_divergence(&ip, &uds), None);
	}

	#[test]
	fn divergent_stream_reports_first_index() {
		let ip = vec![
			frame("ip1", 1, serde_json::json!({"a": 1})),
			frame("ip2", 2, serde_json::json!({"a": 2})),
		];
		let uds = vec![
			frame("u1", 1, serde_json::json!({"a": 1})),
			frame("u2", 2, serde_json::json!({"a": 999})),
		];
		assert_eq!(first_divergence(&ip, &uds), Some(1));
	}

	#[test]
	fn length_mismatch_reports_divergence() {
		let ip = vec![frame("ip1", 1, serde_json::json!({}))];
		let uds: Vec<GjcFrame> = vec![];
		assert_eq!(first_divergence(&ip, &uds), Some(0));
	}
}
