#![cfg(unix)]

mod generated {
	include!("generated/runtime_io_conformance.rs");
}

use std::collections::BTreeSet;

use generated::{RUNTIME_IO_FIXTURES, RuntimeIoFixture};
use gjc_rpc_sdk::authz::{GrantAudit, GrantLimits, GrantRecord, Principal, RedactionPolicy, Scope};
use gjc_rpc_sdk::authz_eval::{CapabilityAuthorizer, DenyReason};
use gjc_rpc_sdk::backpressure::BackpressureQueue;
use gjc_rpc_sdk::broker_correlation::BrokerKind;
use gjc_rpc_sdk::brokers::{BrokerLifecycleError, Brokers, broker_kind_for_frame};
use gjc_rpc_sdk::daemon_server::{DaemonState, HelloRequest, HelloSessionRequest, ServeError};
use gjc_rpc_sdk::frame::{FrameKind, GjcFrame};
use gjc_rpc_sdk::in_process::InProcessPipeline;
use gjc_rpc_sdk::inventory::RuntimeIoInventory;
use gjc_rpc_sdk::logical_equality::streams_logically_equal;
use gjc_rpc_sdk::replay_store::{ReplayOutcome, ReplayStore};
use gjc_rpc_sdk::session_scheduler::Dispatch;
use gjc_rpc_sdk::uds_codec::FrameDecoder;
use gjc_rpc_sdk::uds_transport::{read_frame, secure_bind, write_frame};
use gjc_rpc_sdk::{CorrelationId, Direction, FrameId, PROTOCOL_VERSION, Seq, SessionId};
use tokio::net::UnixStream;

const NOW: &str = "2026-06-01T00:00:00Z";
const INVENTORY_JSON: &str = include_str!("../../../docs/rpc-sdk/runtime-io-inventory.json");

#[derive(Clone, Copy)]
enum Transport {
	InProcess,
	Uds,
}

fn me() -> Principal {
	// SAFETY: getuid/getgid are side-effect-free libc calls on Unix.
	let uid = unsafe { libc::getuid() };
	// SAFETY: getuid/getgid are side-effect-free libc calls on Unix.
	let gid = unsafe { libc::getgid() };
	Principal::Unix { uid, gid, pid: None }
}

fn grant(
	principal: &Principal,
	scopes: Vec<Scope>,
	sessions: Vec<&str>,
	redaction: RedactionPolicy,
) -> GrantRecord {
	GrantRecord {
		version: 1,
		grant_id: "g".into(),
		principal_binding: principal.clone(),
		bearer_hash: None,
		issued_at: "2026-01-01T00:00:00Z".into(),
		expires_at: "2026-12-31T00:00:00Z".into(),
		renewable_until: "2027-01-01T00:00:00Z".into(),
		revoked_at: None,
		issuer: "cli".into(),
		purpose: "runtime-io-conformance".into(),
		sessions: sessions.into_iter().map(String::from).collect(),
		scopes,
		redaction_policy: redaction,
		limits: GrantLimits::default(),
		audit: GrantAudit::default(),
	}
}

fn frame(seq: u64, kind: FrameKind, ty: &str, payload: serde_json::Value) -> GjcFrame {
	GjcFrame {
		protocol_version: PROTOCOL_VERSION,
		frame_id: FrameId(format!("f{seq}")),
		session_id: SessionId("s1".into()),
		seq: Seq(seq),
		direction: Direction::ServerToClient,
		kind,
		r#type: ty.into(),
		correlation_id: None,
		replay: false,
		capability_scope: Some(Scope::Subscribe),
		payload,
	}
}

fn command_frame(ty: &str) -> GjcFrame {
	GjcFrame {
		direction: Direction::ClientToServer,
		kind: FrameKind::Command,
		capability_scope: None,
		..frame(0, FrameKind::Command, ty, serde_json::json!({}))
	}
}

fn evidence_frame(seq: u64, ty: &str, payload: serde_json::Value) -> GjcFrame {
	frame(seq, FrameKind::Event, ty, payload)
}

fn fixture_frame(fixture: &RuntimeIoFixture) -> GjcFrame {
	frame(
		fixture.ordinal as u64 + 1,
		FrameKind::Event,
		"inventory_fixture",
		serde_json::json!({ "section": fixture.section, "item": fixture.item, "ordinal": fixture.ordinal }),
	)
}

fn in_process_roundtrip(input: &[GjcFrame]) -> Vec<GjcFrame> {
	let principal = me();
	let authz = CapabilityAuthorizer::new(
		vec![grant(
			&principal,
			vec![Scope::Subscribe, Scope::Read, Scope::Control],
			vec!["s1"],
			RedactionPolicy::Full,
		)],
		NOW,
	);
	let mut pipe = InProcessPipeline::new(SessionId("s1".into()), authz, 256, RedactionPolicy::Full);
	input.iter().cloned().map(|f| pipe.emit(f)).collect()
}

async fn uds_roundtrip(input: &[GjcFrame], gate: &str) -> Vec<GjcFrame> {
	// SAFETY: getuid is side-effect-free on Unix.
	let uid = unsafe { libc::getuid() };
	let mut path = std::path::PathBuf::from(format!("/tmp/gcrt-{uid}"));
	std::fs::create_dir_all(&path).expect("create owned socket dir");
	std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
		.expect("secure socket dir");
	let tag: String = gate.chars().take(8).collect();
	path.push(format!("{tag}-{}.sock", std::process::id()));
	let _ = std::fs::remove_file(&path);
	let listener = secure_bind(&path).expect("bind loopback uds");
	let server_vec = input.to_vec();
	let server = tokio::spawn(async move {
		let (mut stream, _addr) = listener.accept().await.expect("accept loopback uds");
		for f in &server_vec {
			write_frame(&mut stream, f)
				.await
				.expect("write conformance frame");
		}
	});
	let mut client = UnixStream::connect(&path)
		.await
		.expect("connect loopback uds");
	let mut dec = FrameDecoder::new();
	let mut out = Vec::new();
	for _ in 0..input.len() {
		out.push(
			read_frame(&mut client, &mut dec)
				.await
				.expect("read uds frame")
				.expect("frame"),
		);
	}
	server.await.expect("server task");
	let _ = std::fs::remove_file(&path);
	out
}

async fn assert_cross_transport(gate: &str, logical: Vec<GjcFrame>) {
	let in_process = in_process_roundtrip(&logical);
	let uds = uds_roundtrip(&logical, gate).await;
	assert!(
		streams_logically_equal(&in_process, &uds),
		"{gate}: in_process and uds logical vectors diverged"
	);
	assert!(
		in_process
			.iter()
			.chain(uds.iter())
			.all(|f| f.protocol_version == PROTOCOL_VERSION)
	);
	assert_eq!(in_process.len(), logical.len(), "{gate}: in_process dropped frames");
	assert_eq!(uds.len(), logical.len(), "{gate}: uds dropped frames");
}

fn inventory_coverage_vector() -> Vec<GjcFrame> {
	let inventory: RuntimeIoInventory =
		serde_json::from_str(INVENTORY_JSON).expect("inventory json parses");
	assert_eq!(generated::INVENTORY_SCHEMA_VERSION, inventory.schema_version);
	assert_eq!(generated::INVENTORY_KIND, inventory.kind);
	assert_eq!(generated::INVENTORY_PROTOCOL_VERSION, inventory.protocol_version);
	assert_eq!(generated::INVENTORY_SECTION_COUNT, inventory.sections.len());
	assert_eq!(generated::INVENTORY_TOTAL_ITEMS, inventory.total_items);
	assert_eq!(RUNTIME_IO_FIXTURES.len(), inventory.total_items);

	let fixture_keys: BTreeSet<_> = RUNTIME_IO_FIXTURES
		.iter()
		.map(|f| (f.section, f.item))
		.collect();
	let inventory_keys: BTreeSet<_> = inventory
		.sections
		.iter()
		.flat_map(|s| {
			assert_eq!(s.count, s.items.len(), "inventory section count mismatch for {}", s.name);
			s.items
				.iter()
				.map(move |item| (s.name.as_str(), item.as_str()))
		})
		.collect();
	assert_eq!(
		fixture_keys.len(),
		RUNTIME_IO_FIXTURES.len(),
		"generated fixtures contain duplicates"
	);
	assert_eq!(fixture_keys, inventory_keys, "fixtures must equal inventory exactly");
	assert_eq!(inventory.total_items, 90);
	assert_eq!(inventory.sections.len(), 5);

	RUNTIME_IO_FIXTURES.iter().map(fixture_frame).collect()
}

fn fastlane_interleaving_vector(_: Transport) -> Vec<GjcFrame> {
	let principal = me();
	let authz = CapabilityAuthorizer::new(
		vec![grant(&principal, vec![Scope::Read, Scope::Control], vec!["s1"], RedactionPolicy::Full)],
		NOW,
	);
	let mut pipe = InProcessPipeline::new(SessionId("s1".into()), authz, 64, RedactionPolicy::Full);
	let first = pipe
		.submit(&principal, "prompt")
		.expect("first ordered dispatches");
	let queued = pipe
		.submit(&principal, "set_model")
		.expect("second ordered queues");
	let cancel = pipe
		.submit(&principal, "abort_bash")
		.expect("cancel bypasses ordered queue");
	let read = pipe
		.submit(&principal, "get_state")
		.expect("safe read bypasses ordered queue");
	assert_eq!(first, Dispatch::Immediate);
	assert_eq!(queued, Dispatch::Queued(1));
	assert_eq!(cancel, Dispatch::Immediate);
	assert_eq!(read, Dispatch::Immediate);
	vec![
		evidence_frame(
			1,
			"fastlane_interleaving",
			serde_json::json!({ "command": "prompt", "dispatch": "immediate" }),
		),
		evidence_frame(
			2,
			"fastlane_interleaving",
			serde_json::json!({ "command": "set_model", "dispatch": "queued", "position": 1 }),
		),
		evidence_frame(
			3,
			"fastlane_interleaving",
			serde_json::json!({ "command": "abort_bash", "dispatch": "immediate" }),
		),
		evidence_frame(
			4,
			"fastlane_interleaving",
			serde_json::json!({ "command": "get_state", "dispatch": "immediate" }),
		),
	]
}

fn broker_roundtrip_vector(_: Transport) -> Vec<GjcFrame> {
	let principal = me();
	let authz = CapabilityAuthorizer::new(
		vec![grant(
			&principal,
			vec![Scope::GateAnswer, Scope::HostToolResult, Scope::HostUriResult],
			vec!["s1"],
			RedactionPolicy::Full,
		)],
		NOW,
	);
	let mut brokers = Brokers::new(authz);
	let cases = [
		(FrameKind::UiRequest, BrokerKind::ExtensionUi, Scope::GateAnswer, "extension_ui", "c1"),
		(FrameKind::WorkflowGate, BrokerKind::WorkflowGate, Scope::GateAnswer, "workflow_gate", "c2"),
		(
			FrameKind::HostToolCall,
			BrokerKind::HostTool,
			Scope::HostToolResult,
			"host_tool_call",
			"c3",
		),
		(
			FrameKind::HostUriRequest,
			BrokerKind::HostUri,
			Scope::HostUriResult,
			"host_uri_request",
			"c4",
		),
	];
	let mut out = Vec::new();
	for (idx, (kind, broker_kind, scope, ty, corr)) in cases.into_iter().enumerate() {
		let mut f = frame(idx as u64 + 1, kind, ty, serde_json::json!({ "prompt": "ok" }));
		f.correlation_id = Some(CorrelationId(corr.into()));
		f.capability_scope = Some(scope);
		assert_eq!(broker_kind_for_frame(&f), Some(broker_kind));
		let id = brokers
			.open(&principal, &f, broker_kind)
			.expect("broker opens");
		assert_eq!(id, CorrelationId(corr.into()));
		let mut result = frame(
			90 + idx as u64,
			FrameKind::Response,
			"broker_result",
			serde_json::json!({ "ok": true }),
		);
		result.correlation_id = Some(id.clone());
		assert_eq!(
			brokers
				.resolve(&principal, &id, &result)
				.expect("broker resolves"),
			broker_kind
		);
		out.push(evidence_frame(
			idx as u64 + 1,
			"broker_roundtrip",
			serde_json::json!({ "kind": ty, "correlation": corr }),
		));
	}
	out
}

fn authz_negative_vector(_: Transport) -> Vec<GjcFrame> {
	let principal = me();
	let mut state = DaemonState::new(
		vec![grant(&principal, vec![Scope::Subscribe], vec!["s1"], RedactionPolicy::Full)],
		NOW,
	);
	state
		.accept_hello(
			PROTOCOL_VERSION,
			&principal,
			&[(SessionId("s1".into()), RedactionPolicy::Full)],
		)
		.expect("subscribe accepted");
	let dispatch = state.dispatch_command(&principal, &SessionId("s1".into()), "prompt");
	assert!(matches!(
		dispatch,
		Err(gjc_rpc_sdk::in_process::PipelineError::Denied(DenyReason::ScopeNotGranted))
	));
	assert!(matches!(
		state.replay_to_subscriber(
			&principal,
			&SessionId("s1".into()),
			Seq(0),
			RedactionPolicy::Full
		),
		ReplayOutcome::ResetRequired { .. }
	));
	let broker = state.route_lifecycle_frame(&principal, &broker_open_frame("deny-broker"));
	assert_eq!(broker, Err(BrokerLifecycleError::Denied(DenyReason::ScopeNotGranted)));
	assert_eq!(
		state.replay_len(&SessionId("s1".into())),
		0,
		"denied operations must not mutate replay"
	);
	assert!(
		state
			.observability_events()
			.iter()
			.any(|e| e.deny_reason.as_deref() == Some("ScopeNotGranted"))
	);
	vec![evidence_frame(
		1,
		"authz_negative",
		serde_json::json!({ "dispatch": "denied_before_schedule", "broker": "denied_before_open", "replay": "denied_before_frames", "fanout": "no_replay_mutation" }),
	)]
}

fn replay_redaction_vector(_: Transport) -> Vec<GjcFrame> {
	let principal = me();
	let mut state = DaemonState::new(
		vec![grant(
			&principal,
			vec![Scope::Subscribe, Scope::Read],
			vec!["s1"],
			RedactionPolicy::Full,
		)],
		NOW,
	);
	state
		.accept_hello(
			PROTOCOL_VERSION,
			&principal,
			&[(SessionId("s1".into()), RedactionPolicy::Full)],
		)
		.expect("hello");
	let secret =
		frame(1, FrameKind::Event, "turn_stream", serde_json::json!({ "text": "secret-token" }));
	let ask = frame(
		2,
		FrameKind::WorkflowGate,
		"workflow_gate",
		serde_json::json!({ "prompt": "approve?", "options": ["yes", "no"] }),
	);
	state
		.emit_to_subscriber(&principal, secret, RedactionPolicy::Full)
		.expect("emit secret");
	state
		.emit_to_subscriber(&principal, ask, RedactionPolicy::Full)
		.expect("emit ask");
	let ReplayOutcome::Frames(frames) = state.replay_to_subscriber(
		&principal,
		&SessionId("s1".into()),
		Seq(0),
		RedactionPolicy::Redacted,
	) else {
		panic!("expected replay frames");
	};
	assert_eq!(frames.len(), 2);
	assert!(frames.iter().all(|f| f.replay));
	assert_eq!(frames[0].payload, serde_json::json!({ "redacted": true }));
	assert_eq!(
		frames[1].payload,
		serde_json::json!({ "prompt": "approve?", "options": ["yes", "no"] })
	);
	frames
}

fn backpressure_resume_vector(_: Transport) -> Vec<GjcFrame> {
	let mut q = BackpressureQueue::new(SessionId("s1".into()), 3);
	let mut replay = ReplayStore::new(SessionId("s1".into()), 10);
	for seq in 1..=6 {
		let ty = if seq % 2 == 0 { "status" } else { "semantic" };
		let f = frame(seq, FrameKind::Event, ty, serde_json::json!({ "n": seq }));
		replay.append(f.clone());
		q.enqueue(f, seq % 2 == 1);
	}
	assert!(q.current_lag() > 0);
	let live = q.drain_to(Seq(0));
	let live_seq: Vec<_> = live.iter().map(|f| f.seq.0).collect();
	assert!(live_seq.contains(&1) && live_seq.contains(&3) && live_seq.contains(&5));
	assert_eq!(
		live_seq
			.iter()
			.filter(|seq| **seq % 2 == 0)
			.copied()
			.collect::<Vec<_>>(),
		vec![6]
	);
	let ReplayOutcome::Frames(resumed) = q.resume_from(&replay, Seq(2)) else {
		panic!("expected replay frames");
	};
	assert_eq!(resumed.iter().map(|f| f.seq.0).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
	resumed
}

fn broker_open_frame(corr: &str) -> GjcFrame {
	let mut f =
		frame(1, FrameKind::WorkflowGate, "workflow_gate", serde_json::json!({ "prompt": "ok" }));
	f.correlation_id = Some(CorrelationId(corr.into()));
	f
}

async fn uds_authz_denial_has_no_side_effects() {
	let principal = me();
	// SAFETY: getuid is side-effect-free on Unix.
	let uid = unsafe { libc::getuid() };
	let mut path = std::path::PathBuf::from(format!("/tmp/gcrt-{uid}"));
	std::fs::create_dir_all(&path).expect("create owned socket dir");
	std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
		.expect("secure socket dir");
	path.push(format!("deny-{}.sock", std::process::id()));
	let _ = std::fs::remove_file(&path);
	let listener = secure_bind(&path).expect("bind authz uds");
	let server = tokio::spawn(async move {
		let (mut stream, _addr) = listener.accept().await.expect("accept");
		let mut state = DaemonState::new(
			vec![grant(&principal, vec![Scope::Subscribe], vec!["s1"], RedactionPolicy::Full)],
			NOW,
		);
		let result = state.serve_session(&mut stream).await;
		(result, state.active_sessions(), state.replay_len(&SessionId("s1".into())))
	});
	let mut client = UnixStream::connect(&path).await.expect("connect authz uds");
	let req = HelloRequest {
		protocol_version: PROTOCOL_VERSION,
		requested: vec![HelloSessionRequest {
			session: "s2".into(),
			redaction: RedactionPolicy::Full,
		}],
		grant_id: None,
	};
	let mut hello = command_frame("hello");
	hello.kind = FrameKind::Hello;
	hello.session_id = SessionId(String::new());
	hello.payload = serde_json::to_value(req).expect("hello payload");
	write_frame(&mut client, &hello)
		.await
		.expect("write denied hello");
	drop(client);
	let (result, sessions, replay_len) = server.await.expect("server");
	assert!(matches!(result, Err(ServeError::Denied(DenyReason::SessionNotInGrant))));
	assert!(sessions.is_empty());
	assert_eq!(replay_len, 0);
	let _ = std::fs::remove_file(&path);
}

fn native_tui_surrogate_vector() -> Vec<GjcFrame> {
	let principal = me();
	let authz = CapabilityAuthorizer::new(
		vec![grant(
			&principal,
			vec![Scope::Subscribe, Scope::Read, Scope::Control],
			vec!["s1"],
			RedactionPolicy::Full,
		)],
		NOW,
	);
	let mut pipe = InProcessPipeline::new(SessionId("s1".into()), authz, 64, RedactionPolicy::Full);
	assert!(pipe.is_zero_serialization(), "native N-API surrogate uses typed in-process pipeline");
	assert_eq!(pipe.submit(&principal, "prompt"), Ok(Dispatch::Immediate));
	let emitted = pipe.emit(frame(
		1,
		FrameKind::Event,
		"native_tui_surrogate",
		serde_json::json!({ "surface": "crates/pi-natives/src/rpc_sdk.rs", "pipeline": "in_process" }),
	));
	vec![emitted]
}

#[tokio::test]
async fn runtime_io_generated_golden_conformance() {
	assert_cross_transport("inventory_coverage", inventory_coverage_vector()).await;
	for transport in [Transport::InProcess, Transport::Uds] {
		assert_cross_transport("fastlane_interleaving", fastlane_interleaving_vector(transport))
			.await;
		assert_cross_transport("broker_roundtrip", broker_roundtrip_vector(transport)).await;
		assert_cross_transport("authz_negative", authz_negative_vector(transport)).await;
		assert_cross_transport("replay_redaction", replay_redaction_vector(transport)).await;
		assert_cross_transport("backpressure_resume", backpressure_resume_vector(transport)).await;
	}
	uds_authz_denial_has_no_side_effects().await;
	assert_cross_transport("native_tui_surrogate", native_tui_surrogate_vector()).await;
	assert!(
		RUNTIME_IO_FIXTURES
			.iter()
			.any(|f| f.section == "commands" && f.item == "prompt")
	);
	assert!(
		RUNTIME_IO_FIXTURES
			.iter()
			.any(|f| f.section == "frame_types" && f.item == "workflow_gate")
	);
}

#[test]
fn runtime_io_generated_fixtures_are_complete_without_transport() {
	let vector = inventory_coverage_vector();
	assert_eq!(vector.len(), 90);
}
