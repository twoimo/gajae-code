//! Phase 3 (G004): cross-transport equality gate.
//!
//! Proves the SAME logical frame vector (a prompt → stream → gate → reply → idle
//! exchange) is delivered identically over the in-process path and a real UDS,
//! compared via [`crate::logical_equality::streams_logically_equal`] and asserting
//! `protocol_version == PROTOCOL_VERSION` on every frame. This is the executable
//! `G004_CROSS_TRANSPORT_EQUALITY_GATE`.

#[cfg(test)]
mod tests {
	use crate::authz::{GrantAudit, GrantLimits, GrantRecord, Principal, RedactionPolicy, Scope};
	use crate::authz_eval::CapabilityAuthorizer;
	use crate::frame::{FrameKind, GjcFrame};
	use crate::in_process::InProcessPipeline;
	use crate::logical_equality::streams_logically_equal;
	use crate::uds_codec::FrameDecoder;
	use crate::uds_transport::{read_frame, secure_bind, write_frame};
	use crate::{CorrelationId, Direction, FrameId, PROTOCOL_VERSION, Seq, SessionId};
	use tokio::net::UnixStream;

	fn srv(seq: u64, kind: FrameKind, ty: &str, corr: Option<&str>) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(format!("f{seq}")),
			session_id: SessionId("s1".into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind,
			r#type: ty.into(),
			correlation_id: corr.map(|c| CorrelationId(c.into())),
			replay: false,
			capability_scope: Some(Scope::Subscribe),
			payload: serde_json::json!({ "seq": seq, "t": ty }),
		}
	}

	/// The canonical prompt -> stream -> gate -> reply -> idle output vector.
	fn vector() -> Vec<GjcFrame> {
		vec![
			srv(1, FrameKind::Response, "prompt_accepted", Some("c1")),
			srv(2, FrameKind::Event, "turn_stream", None),
			srv(3, FrameKind::WorkflowGate, "workflow_gate", Some("g1")),
			srv(4, FrameKind::Response, "gate_resolved", Some("g1")),
			srv(5, FrameKind::Event, "idle", None),
		]
	}

	fn full_grant() -> GrantRecord {
		GrantRecord {
			version: 1,
			grant_id: "g".into(),
			principal_binding: Principal::Unix { uid: 0, gid: 0, pid: None },
			bearer_hash: None,
			issued_at: "2026-01-01T00:00:00Z".into(),
			expires_at: "2026-12-31T00:00:00Z".into(),
			renewable_until: "2027-01-01T00:00:00Z".into(),
			revoked_at: None,
			issuer: "cli".into(),
			purpose: "xtransport".into(),
			sessions: vec!["s1".into()],
			scopes: vec![Scope::Subscribe, Scope::Read],
			redaction_policy: RedactionPolicy::Full,
			limits: GrantLimits::default(),
			audit: GrantAudit::default(),
		}
	}

	#[tokio::test]
	async fn same_vector_logically_equal_in_process_and_uds() {
		let v = vector();

		// In-process path: emit each frame through the pipeline (Full policy keeps
		// payloads). The pipeline applies the same envelope/redaction semantics the
		// UDS daemon uses, just without serialization.
		let authz = CapabilityAuthorizer::new(vec![full_grant()], "2026-06-01T00:00:00Z");
		let mut pipe =
			InProcessPipeline::new(SessionId("s1".into()), authz, 64, RedactionPolicy::Full);
		let in_process_out: Vec<GjcFrame> = v.iter().cloned().map(|f| pipe.emit(f)).collect();

		// UDS path: server writes the vector over a real socket; client reads it.
		let mut path = std::env::temp_dir();
		path.push(format!("gjc-xtransport-{}.sock", std::process::id()));
		let listener = secure_bind(&path).expect("bind");
		let server_vec = v.clone();
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			for f in &server_vec {
				write_frame(&mut stream, f).await.expect("write");
			}
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let mut dec = FrameDecoder::new();
		let mut uds_out = Vec::new();
		for _ in 0..v.len() {
			let f = read_frame(&mut client, &mut dec)
				.await
				.expect("read")
				.expect("frame");
			uds_out.push(f);
		}
		server.await.expect("server task");
		let _ = std::fs::remove_file(&path);

		// Gate: identical logical streams across both transports.
		assert!(
			streams_logically_equal(&in_process_out, &uds_out),
			"in_process and uds logical frame streams diverged"
		);
		// And every frame is the negotiated protocol version.
		assert!(
			in_process_out
				.iter()
				.all(|f| f.protocol_version == PROTOCOL_VERSION)
		);
		assert!(
			uds_out
				.iter()
				.all(|f| f.protocol_version == PROTOCOL_VERSION)
		);
		assert_eq!(uds_out.len(), v.len());
	}
}
