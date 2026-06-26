//! Phase 3 (G004 / G010): end-to-end UDS accept handler.
//!
//! Ties the real UDS transport to the daemon decision core: on an accepted
//! connection it derives the peer principal, reads the client `hello`, and runs
//! capability authorization BEFORE any side effect. On denial it writes one error
//! frame and returns WITHOUT registering the session or touching the scheduler /
//! broker / replay — proving authz runs before side effects over a real socket.
//! Unix-only.

use crate::worker_supervisor::{Worker, WorkerSpec};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::AsyncBufReadExt;
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::authz::{Principal, RedactionPolicy, Scope};
use crate::authz_eval::DenyReason;
use crate::backpressure::BackpressureQueue;
use crate::brokers::{BrokerLifecycleError, Brokers, NotificationActions, broker_kind_for_frame};
use crate::daemon::{Daemon, HelloAccept};
use crate::frame::{FrameKind, GjcFrame};
use crate::observability_ext::{ObservabilitySink, fields};
use crate::registry::SessionRegistry;
use crate::replay_store::ReplayOutcome;
use crate::uds_codec::FrameDecoder;
use crate::uds_transport::{TransportError, peer_principal, read_frame, write_frame};
use crate::{Direction, FrameId, PROTOCOL_VERSION, Seq, SessionId};

const DEFAULT_SUBSCRIBER_ID: &str = "default";

type WorkerEvent = Result<GjcFrame, ()>;

struct WorkerHandle {
	worker: Worker,
}

/// One requested subscription in a client hello.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloSessionRequest {
	pub session: String,
	pub redaction: RedactionPolicy,
}

/// The client hello payload (carried in a `Hello` frame).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloRequest {
	pub protocol_version: u32,
	pub requested: Vec<HelloSessionRequest>,
	#[serde(default)]
	pub grant_id: Option<String>,
}

/// Why serving a connection failed.
#[derive(Debug)]
pub enum ServeError {
	Transport(TransportError),
	/// First frame was not a client hello.
	NotHello,
	/// Authorization denied (handshake fails; no side effects performed).
	Denied(DenyReason),
}

impl std::fmt::Display for ServeError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Transport(e) => write!(f, "{e}"),
			Self::NotHello => write!(f, "first frame was not a hello"),
			Self::Denied(r) => write!(f, "hello denied: {r}"),
		}
	}
}

impl std::error::Error for ServeError {}

fn error_frame(reason: &str) -> GjcFrame {
	GjcFrame {
		protocol_version: PROTOCOL_VERSION,
		frame_id: FrameId("hello_error".into()),
		session_id: SessionId(String::new()),
		seq: Seq(0),
		direction: Direction::ServerToClient,
		kind: FrameKind::Error,
		r#type: "hello_denied".into(),
		correlation_id: None,
		replay: false,
		capability_scope: None,
		payload: serde_json::json!({ "denied": reason }),
	}
}

fn ready_frame(accept: &HelloAccept) -> GjcFrame {
	GjcFrame {
		protocol_version: PROTOCOL_VERSION,
		frame_id: FrameId("hello_ok".into()),
		session_id: SessionId(String::new()),
		seq: Seq(0),
		direction: Direction::ServerToClient,
		kind: FrameKind::Ready,
		r#type: "hello_accepted".into(),
		correlation_id: None,
		replay: false,
		capability_scope: None,
		payload: serde_json::json!({ "sessions": accept.subscriptions.len() }),
	}
}

/// Encode a command-dispatch result as a `Response` frame.
fn command_response_frame(
	request: &GjcFrame,
	result: &Result<crate::session_scheduler::Dispatch, crate::in_process::PipelineError>,
) -> GjcFrame {
	use crate::session_scheduler::Dispatch;
	let (ty, payload) = match result {
		Ok(Dispatch::Immediate) => {
			("dispatch_immediate", serde_json::json!({ "dispatch": "immediate" }))
		},
		Ok(Dispatch::Queued(n)) => {
			("dispatch_queued", serde_json::json!({ "dispatch": "queued", "position": n }))
		},
		Err(e) => ("dispatch_denied", serde_json::json!({ "denied": e.to_string() })),
	};
	GjcFrame {
		protocol_version: PROTOCOL_VERSION,
		frame_id: FrameId("cmd_resp".into()),
		session_id: request.session_id.clone(),
		seq: Seq(0),
		direction: Direction::ServerToClient,
		kind: FrameKind::Response,
		r#type: ty.into(),
		correlation_id: request.correlation_id.clone(),
		replay: false,
		capability_scope: None,
		payload,
	}
}

fn lifecycle_response_frame(
	request: &GjcFrame,
	result: &Result<(), BrokerLifecycleError>,
) -> GjcFrame {
	let (ty, payload) = match result {
		Ok(()) => ("lifecycle_ok", serde_json::json!({ "ok": true })),
		Err(e) => ("lifecycle_denied", serde_json::json!({ "denied": format!("{e:?}") })),
	};
	GjcFrame {
		protocol_version: PROTOCOL_VERSION,
		frame_id: FrameId(format!("{}_lifecycle", request.frame_id.0)),
		session_id: request.session_id.clone(),
		seq: Seq(0),
		direction: Direction::ServerToClient,
		kind: if result.is_ok() {
			FrameKind::Response
		} else {
			FrameKind::Error
		},
		r#type: ty.into(),
		correlation_id: request.correlation_id.clone(),
		replay: false,
		capability_scope: request.capability_scope,
		payload,
	}
}

fn is_cancel_frame(frame: &GjcFrame) -> bool {
	frame.kind == FrameKind::Command
		&& (frame.r#type == "cancel"
			|| frame.r#type.starts_with("cancel_")
			|| frame.r#type.starts_with("abort"))
}

fn subscriber_key(
	session: &SessionId,
	principal: &Principal,
	subscriber_id: &str,
	redaction: RedactionPolicy,
) -> String {
	format!("{}::{principal:?}::{subscriber_id}::{redaction:?}", session.0)
}

/// Serve one accepted connection through hello + authz. Registers the authorized
/// sessions in `registry` ONLY on success; a denial returns before any mutation.
pub async fn serve_connection(
	stream: &mut UnixStream,
	daemon: &Daemon,
	registry: &mut SessionRegistry,
) -> Result<HelloAccept, ServeError> {
	let principal = peer_principal(stream).map_err(|e| ServeError::Denied(map_peer_err(e)))?;

	let mut dec = FrameDecoder::new();
	let hello_frame = read_frame(stream, &mut dec)
		.await
		.map_err(ServeError::Transport)?
		.ok_or(ServeError::NotHello)?;
	if hello_frame.kind != FrameKind::Hello || hello_frame.direction != Direction::ClientToServer {
		return Err(ServeError::NotHello);
	}
	let req: HelloRequest =
		serde_json::from_value(hello_frame.payload).map_err(|_| ServeError::NotHello)?;

	let requested: Vec<(SessionId, RedactionPolicy)> = req
		.requested
		.iter()
		.map(|r| (SessionId(r.session.clone()), r.redaction))
		.collect();

	// Authorize BEFORE any side effect. On denial: write one error frame, register
	// nothing, return — the registry/scheduler/broker are never touched.
	match daemon.negotiate_hello(req.protocol_version, &principal, &requested) {
		Ok(accept) => {
			for sub in &accept.subscriptions {
				registry.register_session(sub.session.clone());
			}
			write_frame(stream, &ready_frame(&accept))
				.await
				.map_err(ServeError::Transport)?;
			Ok(accept)
		},
		Err(reason) => {
			let _ = write_frame(stream, &error_frame(&reason.to_string())).await;
			Err(ServeError::Denied(reason))
		},
	}
}

fn map_peer_err(_e: crate::peer_cred::PeerCredError) -> DenyReason {
	DenyReason::NoGrantForPrincipal
}
/// End-to-end daemon state composing the Boundary-B core per session (G010 #2).
///
/// Each authorized session gets its own [`InProcessPipeline`] (scheduler, authz,
/// replay, redactor), reached through the registry. A command is
/// authorized and scheduled by the session pipeline; output frames fan out
/// per-subscriber. The grants drive both the hello authz and each pipeline's authz.
pub struct DaemonState {
	daemon: Daemon,
	registry: SessionRegistry,
	pipelines: HashMap<String, crate::in_process::InProcessPipeline>,
	grants: Vec<crate::authz::GrantRecord>,
	now: String,
	queues: HashMap<String, BackpressureQueue>,
	brokers: Brokers,
	notifications: NotificationActions,
	observability: ObservabilitySink,
	worker_spec: WorkerSpec,
	workers: HashMap<String, WorkerHandle>,
	worker_events_tx: mpsc::UnboundedSender<WorkerEvent>,
	worker_events_rx: mpsc::UnboundedReceiver<WorkerEvent>,
	worker_hosting: bool,
}

impl DaemonState {
	fn default_worker_spec() -> WorkerSpec {
		let program = std::env::var("GJC_RPC_DAEMON_WORKER_PROGRAM").unwrap_or_else(|_| "bun".into());
		let args = std::env::var("GJC_RPC_DAEMON_WORKER_ARGS").map_or_else(
			|_| {
				let source_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
					.join("../..")
					.join("packages/coding-agent/src/modes/rpc-daemon-worker.ts");
				vec![source_path.to_string_lossy().into_owned()]
			},
			|raw| raw.split_whitespace().map(str::to_owned).collect(),
		);
		let env = std::env::vars().collect();
		WorkerSpec { program, args, env }
	}

	#[must_use]
	pub fn new(grants: Vec<crate::authz::GrantRecord>, now: impl Into<String>) -> Self {
		let now = now.into();
		let authz = crate::authz_eval::CapabilityAuthorizer::new(grants.clone(), now.clone());
		let worker_spec = Self::default_worker_spec();
		let (worker_events_tx, worker_events_rx) = mpsc::unbounded_channel();
		Self {
			daemon: Daemon::new(authz.clone()),
			registry: SessionRegistry::new(),
			pipelines: HashMap::new(),
			grants,
			now,
			queues: HashMap::new(),
			brokers: Brokers::new(authz.clone()),
			notifications: NotificationActions::new(authz),
			observability: ObservabilitySink::new(),
			worker_spec,
			workers: HashMap::new(),
			worker_events_tx,
			worker_events_rx,
			worker_hosting: false,
		}
	}

	#[must_use]
	pub fn with_worker_spec(mut self, worker_spec: WorkerSpec) -> Self {
		self.worker_spec = worker_spec;
		self
	}

	#[must_use]
	pub const fn with_worker_hosting(mut self) -> Self {
		self.worker_hosting = true;
		self
	}

	fn ensure_session_for_subscriber(
		&mut self,
		session: &SessionId,
		principal: &Principal,
		subscriber_id: &str,
		redaction: RedactionPolicy,
	) {
		if !self.pipelines.contains_key(&session.0) {
			let authz =
				crate::authz_eval::CapabilityAuthorizer::new(self.grants.clone(), self.now.clone());
			self.pipelines.insert(
				session.0.clone(),
				crate::in_process::InProcessPipeline::new(session.clone(), authz, 64, redaction),
			);
			self.registry.register_session(session.clone());
		}
		let key = subscriber_key(session, principal, subscriber_id, redaction);
		self
			.queues
			.entry(key)
			.or_insert_with(|| BackpressureQueue::new(session.clone(), 64));
	}

	/// Negotiate hello and, on success, compose a per-session pipeline for each
	/// authorized subscription. Returns the accepted subscriptions.
	pub fn accept_hello_for_subscriber(
		&mut self,
		protocol_version: u32,
		principal: &Principal,
		subscriber_id: &str,
		requested: &[(SessionId, RedactionPolicy)],
	) -> Result<HelloAccept, DenyReason> {
		let accept = self
			.daemon
			.negotiate_hello(protocol_version, principal, requested)?;
		for sub in &accept.subscriptions {
			self.ensure_session_for_subscriber(&sub.session, principal, subscriber_id, sub.redaction);
		}
		Ok(accept)
	}

	pub fn accept_hello(
		&mut self,
		protocol_version: u32,
		principal: &Principal,
		requested: &[(SessionId, RedactionPolicy)],
	) -> Result<HelloAccept, DenyReason> {
		self.accept_hello_for_subscriber(
			protocol_version,
			principal,
			DEFAULT_SUBSCRIBER_ID,
			requested,
		)
	}

	fn emit_observability(
		&mut self,
		principal: &Principal,
		scope: Option<Scope>,
		frame: &GjcFrame,
		deny_reason: Option<String>,
		redaction: Option<RedactionPolicy>,
		replay_cursor: Option<Seq>,
		queue_lag: Option<usize>,
	) {
		let mut event = fields(
			"daemon",
			principal,
			None,
			scope,
			frame.frame_id.clone(),
			frame.session_id.clone(),
			frame.correlation_id.clone(),
			deny_reason,
		);
		event.redaction_decision = redaction.map(|p| format!("{p:?}"));
		event.replay_cursor = replay_cursor.map(|s| s.0);
		event.queue_lag = queue_lag;
		self.observability.emit(event);
	}

	#[must_use]
	pub fn observability_events(&self) -> &[crate::observability::ObservabilityFields] {
		self.observability.events()
	}

	#[must_use]
	pub const fn semantic_frame(frame: &GjcFrame) -> bool {
		matches!(
			frame.kind,
			FrameKind::Response
				| FrameKind::UiRequest
				| FrameKind::PermissionRequest
				| FrameKind::HostToolCall
				| FrameKind::HostUriRequest
				| FrameKind::WorkflowGate
				| FrameKind::Reset
				| FrameKind::Error
		) || frame.correlation_id.is_some()
	}

	fn append_raw_output(
		&mut self,
		frame: GjcFrame,
	) -> Result<(), crate::in_process::PipelineError> {
		let pipe = self
			.pipelines
			.get_mut(&frame.session_id.0)
			.ok_or(crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant))?;
		pipe.append_raw(frame);
		Ok(())
	}

	fn render_for_subscriber(
		&mut self,
		principal: &Principal,
		subscriber_id: &str,
		frame: GjcFrame,
		redaction: RedactionPolicy,
		cursor: Seq,
	) -> Result<GjcFrame, crate::in_process::PipelineError> {
		let pipe = self
			.pipelines
			.get(&frame.session_id.0)
			.ok_or(crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant))?;
		let fanned = pipe.render_for_policy(frame.clone(), redaction);
		let key = subscriber_key(&frame.session_id, principal, subscriber_id, redaction);
		let queue = self
			.queues
			.entry(key)
			.or_insert_with(|| BackpressureQueue::new(frame.session_id.clone(), 64));
		let semantic = Self::semantic_frame(&frame);
		queue.enqueue(fanned.clone(), semantic);
		queue.acknowledge_to(cursor);
		let lag = queue.current_lag();
		self.emit_observability(
			principal,
			Some(Scope::Subscribe),
			&frame,
			None,
			Some(redaction),
			Some(cursor),
			Some(lag),
		);
		Ok(fanned)
	}

	pub fn emit_to_subscriber(
		&mut self,
		principal: &Principal,
		frame: GjcFrame,
		redaction: RedactionPolicy,
	) -> Result<GjcFrame, crate::in_process::PipelineError> {
		self
			.daemon
			.authorize(principal, &frame.session_id, Scope::Subscribe)
			.map_err(crate::in_process::PipelineError::Denied)?;
		self.append_raw_output(frame.clone())?;
		self.render_for_subscriber(principal, DEFAULT_SUBSCRIBER_ID, frame, redaction, Seq(0))
	}

	pub fn fanout_to_subscribers(
		&mut self,
		principal: &Principal,
		frame: GjcFrame,
		subscribers: &[(String, RedactionPolicy, Seq)],
	) -> Result<Vec<GjcFrame>, crate::in_process::PipelineError> {
		self
			.daemon
			.authorize(principal, &frame.session_id, Scope::Subscribe)
			.map_err(crate::in_process::PipelineError::Denied)?;
		self.append_raw_output(frame.clone())?;
		subscribers
			.iter()
			.map(|(subscriber_id, redaction, cursor)| {
				self.render_for_subscriber(principal, subscriber_id, frame.clone(), *redaction, *cursor)
			})
			.collect()
	}

	pub fn drain_subscriber_queue(
		&mut self,
		principal: &Principal,
		subscriber_id: &str,
		session: &SessionId,
		redaction: RedactionPolicy,
		cursor: Seq,
	) -> Vec<GjcFrame> {
		let key = subscriber_key(session, principal, subscriber_id, redaction);
		self
			.queues
			.get_mut(&key)
			.map_or_else(Vec::new, |queue| queue.drain_to(cursor))
	}

	#[must_use]
	pub fn replay_len(&self, session: &SessionId) -> usize {
		self
			.pipelines
			.get(&session.0)
			.map_or(0, |pipe| pipe.replay_store().len())
	}

	pub fn route_lifecycle_frame(
		&mut self,
		principal: &Principal,
		frame: &GjcFrame,
	) -> Result<(), BrokerLifecycleError> {
		if let Some(kind) = broker_kind_for_frame(frame) {
			let correlation = self.brokers.open(principal, frame, kind)?;
			self
				.registry
				.bind_correlation(&correlation, frame.session_id.clone());
			return Ok(());
		}
		if frame.kind == FrameKind::Notification && frame.r#type == "action_needed" {
			let correlation = self.notifications.open(principal, frame)?;
			self
				.registry
				.bind_correlation(&correlation, frame.session_id.clone());
			return Ok(());
		}
		if frame.kind == FrameKind::Notification && frame.r#type == "expired" {
			let correlation = frame
				.correlation_id
				.as_ref()
				.ok_or(BrokerLifecycleError::MissingCorrelation)?;
			self.notifications.expire(principal, frame)?;
			self.registry.release_correlation(correlation);
			return Ok(());
		}
		if frame.kind == FrameKind::Notification && frame.r#type == "callback" {
			let correlation = frame
				.correlation_id
				.as_ref()
				.ok_or(BrokerLifecycleError::MissingCorrelation)?;
			self.notifications.callback(principal, frame)?;
			self.registry.release_correlation(correlation);
			return Ok(());
		}
		if frame.kind == FrameKind::Command && is_cancel_frame(frame) {
			let correlation = frame
				.correlation_id
				.as_ref()
				.ok_or(BrokerLifecycleError::MissingCorrelation)?;
			self.brokers.cancel(principal, correlation)?;
			self.registry.release_correlation(correlation);
			return Ok(());
		}
		if frame.kind == FrameKind::Response {
			let correlation = frame
				.correlation_id
				.as_ref()
				.ok_or(BrokerLifecycleError::MissingCorrelation)?;
			let _ = self.brokers.resolve(principal, correlation, frame)?;
			self.registry.release_correlation(correlation);
		}
		Ok(())
	}

	#[must_use]
	pub fn replay_to_subscriber(
		&mut self,
		principal: &Principal,
		session: &SessionId,
		cursor: Seq,
		redaction: RedactionPolicy,
	) -> ReplayOutcome {
		let frame = GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("replay".into()),
			session_id: session.clone(),
			seq: cursor,
			direction: Direction::ServerToClient,
			kind: FrameKind::Event,
			r#type: "replay".into(),
			correlation_id: None,
			replay: true,
			capability_scope: Some(Scope::Subscribe),
			payload: serde_json::json!({}),
		};
		if self
			.authorize_replay(principal, session, &frame, redaction, cursor)
			.is_err()
		{
			return ReplayOutcome::ResetRequired { floor: cursor };
		}
		let outcome = self
			.pipelines
			.get(&session.0)
			.map_or(ReplayOutcome::Frames(Vec::new()), |pipe| {
				pipe.replay_from_for_policy(cursor, redaction)
			});
		self.emit_observability(
			principal,
			Some(Scope::Read),
			&frame,
			None,
			Some(redaction),
			Some(cursor),
			None,
		);
		outcome
	}

	fn authorize_replay(
		&mut self,
		principal: &Principal,
		session: &SessionId,
		frame: &GjcFrame,
		redaction: RedactionPolicy,
		cursor: Seq,
	) -> Result<(), DenyReason> {
		for scope in [Scope::Subscribe, Scope::Read] {
			if let Err(reason) = self.daemon.authorize(principal, session, scope) {
				self.emit_observability(
					principal,
					Some(scope),
					frame,
					Some(format!("{reason:?}")),
					Some(redaction),
					Some(cursor),
					None,
				);
				return Err(reason);
			}
		}
		Ok(())
	}

	/// Dispatch a client runtime-input command through the session's pipeline. The
	/// pipeline authorizes (control/read) BEFORE scheduling, so an unauthorized
	/// command is denied with no scheduling side effect.
	pub fn dispatch_command(
		&mut self,
		principal: &Principal,
		session: &SessionId,
		command: &str,
	) -> Result<crate::session_scheduler::Dispatch, crate::in_process::PipelineError> {
		// Registry lifecycle gate: only an Active session dispatches. An unknown or
		// Failed (e.g. post-worker-crash) session is denied with no scheduling.
		if self.registry.state(session) != Some(crate::registry::SessionState::Active) {
			return Err(crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant));
		}
		match self.pipelines.get_mut(&session.0) {
			Some(pipe) => pipe.submit(principal, command),
			None => Err(crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant)),
		}
	}

	async fn dispatch_command_to_worker(
		&mut self,
		principal: &Principal,
		frame: &GjcFrame,
	) -> Result<(), crate::in_process::PipelineError> {
		let session = frame.session_id.clone();
		self.dispatch_command(principal, &session, &frame.r#type)?;
		let handle = match self.workers.entry(session.0.clone()) {
			std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
			std::collections::hash_map::Entry::Vacant(entry) => {
				let mut spec = self.worker_spec.clone();
				spec
					.args
					.extend(["--provider-session-id".into(), session.0.clone()]);
				let mut worker = spec.spawn().map_err(|_| {
					crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant)
				})?;
				let mut stdout = worker
					.take_stdout()
					.ok_or(crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant))?;
				let tx = self.worker_events_tx.clone();
				tokio::spawn(async move {
					loop {
						let mut line = String::new();
						match stdout.read_line(&mut line).await {
							Ok(0) => break,
							Ok(_) => {
								if line.ends_with('\n') {
									line.pop();
								}
								match serde_json::from_str::<GjcFrame>(&line) {
									Ok(event) if event.kind != FrameKind::Ready => {
										let _ = tx.send(Ok(event));
									},
									Ok(_) => {},
									Err(_) => {
										let _ = tx.send(Err(()));
										break;
									},
								}
							},
							Err(_) => {
								let _ = tx.send(Err(()));
								break;
							},
						}
					}
				});
				entry.insert(WorkerHandle { worker })
			},
		};
		let encoded = serde_json::to_string(frame)
			.map_err(|_| crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant))?;
		handle
			.worker
			.write_line(&encoded)
			.await
			.map_err(|_| crate::in_process::PipelineError::Denied(DenyReason::SessionNotInGrant))
	}

	/// Run a full session over a real UDS connection: peer-cred → client hello →
	/// authz (no side effects on denial) → per-session pipeline composition →
	/// command loop dispatching each `Command` frame through the registry-gated
	/// session pipeline and replying with a `Response`. Returns when the client
	/// disconnects. This is the exported live serve path.
	pub async fn serve_session(&mut self, stream: &mut UnixStream) -> Result<(), ServeError> {
		let principal = peer_principal(stream).map_err(|e| ServeError::Denied(map_peer_err(e)))?;
		let (mut reader, mut writer) = stream.split();
		let mut dec = FrameDecoder::new();
		let hf = read_frame(&mut reader, &mut dec)
			.await
			.map_err(ServeError::Transport)?
			.ok_or(ServeError::NotHello)?;
		if hf.kind != FrameKind::Hello || hf.direction != Direction::ClientToServer {
			return Err(ServeError::NotHello);
		}
		let req: HelloRequest =
			serde_json::from_value(hf.payload).map_err(|_| ServeError::NotHello)?;
		let requested: Vec<(SessionId, RedactionPolicy)> = req
			.requested
			.iter()
			.map(|r| (SessionId(r.session.clone()), r.redaction))
			.collect();
		let accept = self
			.accept_hello_for_subscriber(req.protocol_version, &principal, &hf.frame_id.0, &requested)
			.map_err(ServeError::Denied)?;
		let redactions: HashMap<String, RedactionPolicy> = accept
			.subscriptions
			.iter()
			.map(|sub| (sub.session.0.clone(), sub.redaction))
			.collect();
		write_frame(&mut writer, &ready_frame(&accept))
			.await
			.map_err(ServeError::Transport)?;
		loop {
			tokio::select! {
				worker_event = self.worker_events_rx.recv(), if self.worker_hosting => {
					let Some(worker_event) = worker_event else {
						return Ok(());
					};
					let event = worker_event.map_err(|()| ServeError::Denied(DenyReason::SessionNotInGrant))?;
					let redaction = redactions
						.get(&event.session_id.0)
						.copied()
						.unwrap_or(RedactionPolicy::MetadataOnly);
					self.append_raw_output(event.clone())
						.map_err(|_| ServeError::Denied(DenyReason::SessionNotInGrant))?;
					let outbound = self
						.render_for_subscriber(&principal, &hf.frame_id.0, event, redaction, Seq(0))
						.map_err(|_| ServeError::Denied(DenyReason::SessionNotInGrant))?;
					write_frame(&mut writer, &outbound)
						.await
						.map_err(ServeError::Transport)?;
				},
				incoming = read_frame(&mut reader, &mut dec) => {
					let Some(frame) = incoming.map_err(ServeError::Transport)? else {
						return Ok(());
					};
					match frame.kind {
						FrameKind::Command if !is_cancel_frame(&frame) => {
							if !self.worker_hosting {
								let session = frame.session_id.clone();
								let result = self.dispatch_command(&principal, &session, &frame.r#type);
								write_frame(&mut writer, &command_response_frame(&frame, &result))
									.await
									.map_err(ServeError::Transport)?;
								continue;
							}
							let result = self.dispatch_command_to_worker(&principal, &frame).await;
							if let Err(err) = result {
								let dispatch_result: Result<
									crate::session_scheduler::Dispatch,
									crate::in_process::PipelineError,
								> = Err(err);
								write_frame(&mut writer, &command_response_frame(&frame, &dispatch_result))
									.await
									.map_err(ServeError::Transport)?;
							}
						},
						_ => {
							let result = self.route_lifecycle_frame(&principal, &frame);
							write_frame(&mut writer, &lifecycle_response_frame(&frame, &result))
								.await
								.map_err(ServeError::Transport)?;
						},
					}
				},
			}
		}
	}

	#[must_use]
	pub fn active_sessions(&self) -> Vec<SessionId> {
		self.registry.active_sessions()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::CorrelationId;
	use crate::authz::{GrantAudit, GrantLimits, GrantRecord, Principal, Scope};
	use crate::authz_eval::CapabilityAuthorizer;

	fn grant(sessions: Vec<&str>) -> GrantRecord {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		GrantRecord {
			version: 1,
			grant_id: "g".into(),
			// Bind to the running uid so peer-cred derivation matches in the test.
			principal_binding: Principal::Unix { uid: me, gid, pid: None },
			bearer_hash: None,
			issued_at: "2026-01-01T00:00:00Z".into(),
			expires_at: "2026-12-31T00:00:00Z".into(),
			renewable_until: "2027-01-01T00:00:00Z".into(),
			revoked_at: None,
			issuer: "cli".into(),
			purpose: "serve-test".into(),
			sessions: sessions.into_iter().map(String::from).collect(),
			scopes: vec![Scope::Subscribe, Scope::Control, Scope::Read],
			redaction_policy: RedactionPolicy::Redacted,
			limits: GrantLimits::default(),
			audit: GrantAudit::default(),
		}
	}

	fn hello_frame(req: &HelloRequest) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("c_hello".into()),
			session_id: SessionId(String::new()),
			seq: Seq(0),
			direction: Direction::ClientToServer,
			kind: FrameKind::Hello,
			r#type: "hello".into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::to_value(req).unwrap(),
		}
	}

	fn command_frame(session: &str, correlation: &str, command: &str) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("cmd_frame".into()),
			session_id: SessionId(session.into()),
			seq: Seq(1),
			direction: Direction::ClientToServer,
			kind: FrameKind::Command,
			r#type: command.into(),
			correlation_id: Some(CorrelationId(correlation.into())),
			replay: false,
			capability_scope: Some(Scope::Control),
			payload: serde_json::json!({}),
		}
	}

	fn worker_output_frame(
		frame_id: &str,
		session: &str,
		seq: u64,
		kind: FrameKind,
		frame_type: &str,
		correlation: Option<&str>,
	) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(frame_id.into()),
			session_id: SessionId(session.into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind,
			r#type: frame_type.into(),
			correlation_id: correlation.map(|id| CorrelationId(id.into())),
			replay: false,
			capability_scope: Some(Scope::Subscribe),
			payload: serde_json::json!({ "message": frame_type }),
		}
	}

	#[test]
	fn hello_request_accepts_typescript_camelcase_payload() {
		let payload = serde_json::json!({
			 "protocolVersion": PROTOCOL_VERSION,
			 "requested": [{ "session": "s1", "redaction": "redacted" }],
			 "grantId": "g1"
		});
		let req: HelloRequest = serde_json::from_value(payload.clone()).expect("TS hello payload");
		assert_eq!(req.protocol_version, PROTOCOL_VERSION);
		assert_eq!(req.requested[0].session, "s1");
		assert_eq!(req.grant_id.as_deref(), Some("g1"));
		assert_eq!(serde_json::to_value(&req).unwrap(), payload);
	}

	fn sock(tag: &str) -> std::path::PathBuf {
		let mut p = std::env::temp_dir();
		p.push(format!("gjc-serve-{}-{}.sock", tag, std::process::id()));
		p
	}

	#[tokio::test]
	async fn hello_accepted_registers_sessions_over_real_uds() {
		let path = sock("ok");
		let listener = crate::uds_transport::secure_bind(&path).expect("bind");
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let daemon = Daemon::new(CapabilityAuthorizer::new(vec![grant(vec!["s1"])], future_now()));
			let mut reg = SessionRegistry::new();
			let res = serve_connection(&mut stream, &daemon, &mut reg).await;
			(res.is_ok(), reg.active_sessions())
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let req = HelloRequest {
			protocol_version: PROTOCOL_VERSION,
			requested: vec![HelloSessionRequest {
				session: "s1".into(),
				redaction: RedactionPolicy::Redacted,
			}],
			grant_id: None,
		};
		write_frame(&mut client, &hello_frame(&req))
			.await
			.expect("send hello");
		let mut dec = FrameDecoder::new();
		let resp = read_frame(&mut client, &mut dec)
			.await
			.expect("read")
			.expect("resp");
		assert_eq!(resp.kind, FrameKind::Ready);
		let (ok, sessions) = server.await.expect("server");
		assert!(ok);
		assert_eq!(sessions, vec![SessionId("s1".into())]);
		let _ = std::fs::remove_file(&path);
	}

	#[tokio::test]
	async fn hello_denied_performs_no_side_effects_over_real_uds() {
		let path = sock("deny");
		let listener = crate::uds_transport::secure_bind(&path).expect("bind");
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let daemon = Daemon::new(CapabilityAuthorizer::new(vec![grant(vec!["s1"])], future_now()));
			let mut reg = SessionRegistry::new();
			let res = serve_connection(&mut stream, &daemon, &mut reg).await;
			// Key assertion: a denied hello mutated NOTHING.
			(res, reg.active_sessions())
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		// Request an UNAUTHORIZED session (s2 not in grant).
		let req = HelloRequest {
			protocol_version: PROTOCOL_VERSION,
			requested: vec![HelloSessionRequest {
				session: "s2".into(),
				redaction: RedactionPolicy::Redacted,
			}],
			grant_id: None,
		};
		write_frame(&mut client, &hello_frame(&req))
			.await
			.expect("send hello");
		let mut dec = FrameDecoder::new();
		let resp = read_frame(&mut client, &mut dec)
			.await
			.expect("read")
			.expect("resp");
		assert_eq!(resp.kind, FrameKind::Error);
		let (res, sessions) = server.await.expect("server");
		assert!(matches!(res, Err(ServeError::Denied(DenyReason::SessionNotInGrant))));
		assert!(sessions.is_empty(), "denied hello must not register any session");
		let _ = std::fs::remove_file(&path);
	}

	// The authorizer compares `now` lexicographically against expires_at; use a
	// fixed in-window timestamp.
	fn future_now() -> String {
		"2026-06-01T00:00:00Z".to_string()
	}

	#[tokio::test]
	async fn daemon_state_dispatches_command_through_session_pipeline_over_uds() {
		let path = sock("dispatch");
		let listener = crate::uds_transport::secure_bind(&path).expect("bind");
		// Grant Subscribe + Control for s1 so hello accepts and prompt dispatches.
		// SAFETY: getuid is always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		let g = me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::Control]);
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let mut state = DaemonState::new(vec![g], future_now());
			// Drive the FULL exported serve path (hello + composition + command loop).
			let r = state.serve_session(&mut stream).await;
			(r.is_ok(), state.active_sessions())
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let req = HelloRequest {
			protocol_version: PROTOCOL_VERSION,
			requested: vec![HelloSessionRequest {
				session: "s1".into(),
				redaction: RedactionPolicy::Full,
			}],
			grant_id: None,
		};
		write_frame(&mut client, &hello_frame(&req))
			.await
			.expect("hello");
		let mut cdec = FrameDecoder::new();
		let ready = read_frame(&mut client, &mut cdec)
			.await
			.expect("read")
			.expect("ready");
		assert_eq!(ready.kind, FrameKind::Ready);
		// Send a control command "prompt" and read the dispatch response.
		let cmd = GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("c_cmd".into()),
			session_id: SessionId("s1".into()),
			seq: Seq(0),
			direction: Direction::ClientToServer,
			kind: FrameKind::Command,
			r#type: "prompt".into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({}),
		};
		write_frame(&mut client, &cmd).await.expect("send cmd");
		let resp = read_frame(&mut client, &mut cdec)
			.await
			.expect("read")
			.expect("resp");
		assert_eq!(resp.kind, FrameKind::Response);
		assert_eq!(resp.r#type, "dispatch_immediate");
		drop(client); // disconnect -> serve_session returns Ok
		let (ok, sessions) = server.await.expect("server");
		assert!(ok);
		assert_eq!(sessions, vec![SessionId("s1".into())]);
		let _ = std::fs::remove_file(&path);
	}

	#[tokio::test]
	async fn daemon_path_command_responses_preserve_distinct_correlation_ids() {
		let path = sock("correlated-commands");
		let listener = crate::uds_transport::secure_bind(&path).expect("bind");
		// SAFETY: getuid is always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		let g = me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::Read, Scope::Control]);
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let mut state = DaemonState::new(vec![g], future_now());
			let r = state.serve_session(&mut stream).await;
			(r.is_ok(), state.active_sessions())
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let req = HelloRequest {
			protocol_version: PROTOCOL_VERSION,
			requested: vec![HelloSessionRequest {
				session: "s1".into(),
				redaction: RedactionPolicy::Full,
			}],
			grant_id: None,
		};
		write_frame(&mut client, &hello_frame(&req))
			.await
			.expect("hello");
		let mut cdec = FrameDecoder::new();
		let ready = read_frame(&mut client, &mut cdec)
			.await
			.expect("read")
			.expect("ready");
		assert_eq!(ready.kind, FrameKind::Ready);

		let get_state = GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("get_state_cmd".into()),
			session_id: SessionId("s1".into()),
			seq: Seq(1),
			direction: Direction::ClientToServer,
			kind: FrameKind::Command,
			r#type: "get_state".into(),
			correlation_id: Some(CorrelationId("corr-get-state".into())),
			replay: false,
			capability_scope: Some(Scope::Read),
			payload: serde_json::json!({}),
		};
		let prompt = GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("prompt_cmd".into()),
			session_id: SessionId("s1".into()),
			seq: Seq(2),
			direction: Direction::ClientToServer,
			kind: FrameKind::Command,
			r#type: "prompt".into(),
			correlation_id: Some(CorrelationId("corr-prompt".into())),
			replay: false,
			capability_scope: Some(Scope::Control),
			payload: serde_json::json!({ "message": "correlation smoke" }),
		};
		write_frame(&mut client, &get_state)
			.await
			.expect("send get_state");
		write_frame(&mut client, &prompt)
			.await
			.expect("send prompt");

		let first = read_frame(&mut client, &mut cdec)
			.await
			.expect("read first")
			.expect("first response");
		let second = read_frame(&mut client, &mut cdec)
			.await
			.expect("read second")
			.expect("second response");
		assert_eq!(first.kind, FrameKind::Response);
		assert_eq!(second.kind, FrameKind::Response);
		let by_correlation = [first, second]
			.into_iter()
			.map(|frame| (frame.correlation_id.clone(), frame))
			.collect::<std::collections::HashMap<_, _>>();
		assert_eq!(
			by_correlation
				.get(&Some(CorrelationId("corr-get-state".into())))
				.expect("get_state response")
				.r#type,
			"dispatch_immediate"
		);
		assert_eq!(
			by_correlation
				.get(&Some(CorrelationId("corr-prompt".into())))
				.expect("prompt response")
				.r#type,
			"dispatch_immediate"
		);
		assert_eq!(by_correlation.len(), 2, "responses must not mix correlation ids");
		drop(client);
		let (ok, sessions) = server.await.expect("server");
		assert!(ok);
		assert_eq!(sessions, vec![SessionId("s1".into())]);
		let _ = std::fs::remove_file(&path);
	}

	#[tokio::test]
	async fn g007_bridge_smoke_exchanges_frame_with_daemon_over_uds() {
		let path = sock("g007-bridge-smoke");
		let listener = crate::uds_transport::secure_bind(&path).expect("bind");
		// SAFETY: getuid is always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		let g = me_grant(me, vec!["bridge-smoke-session"], vec![Scope::Subscribe, Scope::Control]);
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let mut state = DaemonState::new(vec![g], future_now());
			let r = state.serve_session(&mut stream).await;
			(r.is_ok(), state.active_sessions())
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let req = HelloRequest {
			protocol_version: PROTOCOL_VERSION,
			requested: vec![HelloSessionRequest {
				session: "bridge-smoke-session".into(),
				redaction: RedactionPolicy::Full,
			}],
			grant_id: None,
		};
		write_frame(&mut client, &hello_frame(&req))
			.await
			.expect("hello");
		let mut cdec = FrameDecoder::new();
		let ready = read_frame(&mut client, &mut cdec)
			.await
			.expect("read")
			.expect("ready");
		assert_eq!(ready.kind, FrameKind::Ready);
		let cmd = GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("bridge_smoke_cmd".into()),
			session_id: SessionId("bridge-smoke-session".into()),
			seq: Seq(1),
			direction: Direction::ClientToServer,
			kind: FrameKind::Command,
			r#type: "prompt".into(),
			correlation_id: Some(crate::CorrelationId("bridge-smoke-correlation".into())),
			replay: false,
			capability_scope: Some(Scope::Control),
			payload: serde_json::json!({ "message": "bridge smoke" }),
		};
		write_frame(&mut client, &cmd).await.expect("send cmd");
		let resp = read_frame(&mut client, &mut cdec)
			.await
			.expect("read")
			.expect("resp");
		assert_eq!(resp.kind, FrameKind::Response);
		assert_eq!(resp.direction, Direction::ServerToClient);
		assert_eq!(resp.session_id, SessionId("bridge-smoke-session".into()));
		drop(client);
		let (ok, sessions) = server.await.expect("server");
		assert!(ok);
		assert_eq!(sessions, vec![SessionId("bridge-smoke-session".into())]);
		let _ = std::fs::remove_file(&path);
	}

	#[test]
	fn daemon_state_denies_unauthorized_control_with_no_scheduling() {
		// Subscribe only (no Control): a prompt is denied by the session pipeline.
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let mut state =
			DaemonState::new(vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe])], future_now());
		let principal = Principal::Unix { uid: me, gid, pid: None };
		state
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Redacted)],
			)
			.expect("hello");
		let res = state.dispatch_command(&principal, &SessionId("s1".into()), "prompt");
		assert!(matches!(
			res,
			Err(crate::in_process::PipelineError::Denied(DenyReason::ScopeNotGranted))
		));
	}

	fn output_frame(seq: u64, ty: &str, payload: serde_json::Value) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(format!("out-{seq}")),
			session_id: SessionId("s1".into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind: FrameKind::Notification,
			r#type: ty.into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload,
		}
	}

	#[test]
	fn daemon_path_reconnect_resume_survives_backpressure_and_replays_gap() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let mut state = DaemonState::new(
			vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::Read])],
			future_now(),
		);
		state
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		for seq in 1..=6 {
			let ty = if seq % 2 == 0 {
				"status_update"
			} else {
				"semantic_event"
			};
			state
				.emit_to_subscriber(
					&principal,
					output_frame(seq, ty, serde_json::json!({"n": seq})),
					RedactionPolicy::Full,
				)
				.unwrap();
		}
		let ReplayOutcome::Frames(frames) = state.replay_to_subscriber(
			&principal,
			&SessionId("s1".into()),
			Seq(2),
			RedactionPolicy::Full,
		) else {
			panic!("expected replay frames");
		};
		assert_eq!(frames.iter().map(|f| f.seq.0).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
		assert!(frames.iter().all(|f| f.replay));
	}

	#[test]
	fn daemon_observability_has_fields_and_omits_payload_secret() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let mut state =
			DaemonState::new(vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe])], future_now());
		state
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Redacted)],
			)
			.unwrap();
		state
			.emit_to_subscriber(
				&principal,
				output_frame(
					1,
					"turn_stream",
					serde_json::json!({"token":"synthetic-secret", "bearer":"bearer-token"}),
				),
				RedactionPolicy::Redacted,
			)
			.unwrap();
		let denied = Principal::Unix { uid: me.saturating_add(1), gid, pid: None };
		let _ = state.replay_to_subscriber(
			&denied,
			&SessionId("s1".into()),
			Seq(0),
			RedactionPolicy::Redacted,
		);
		let json = serde_json::to_string(state.observability_events()).unwrap();
		assert!(json.contains("connectionId"));
		assert!(json.contains("queueLag"));
		assert!(json.contains("denyReason"));
		assert!(!json.contains("synthetic-secret"));
		assert!(!json.contains("bearer-token"));
	}

	#[test]
	fn daemon_path_redaction_is_per_subscriber_full_then_redacted() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let mut state = DaemonState::new(
			vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::Read])],
			future_now(),
		);
		state
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		let full = state
			.emit_to_subscriber(
				&principal,
				output_frame(1, "turn_stream", serde_json::json!({"text":"secret"})),
				RedactionPolicy::Full,
			)
			.unwrap();
		assert_eq!(full.payload, serde_json::json!({"text":"secret"}));
		let ReplayOutcome::Frames(redacted) = state.replay_to_subscriber(
			&principal,
			&SessionId("s1".into()),
			Seq(0),
			RedactionPolicy::Redacted,
		) else {
			panic!("expected replay");
		};
		assert_eq!(redacted[0].payload, serde_json::json!({"redacted": true}));
	}

	#[test]
	fn daemon_path_redaction_is_per_subscriber_redacted_then_full() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let mut state = DaemonState::new(
			vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::Read])],
			future_now(),
		);
		state
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Redacted)],
			)
			.unwrap();
		let redacted = state
			.emit_to_subscriber(
				&principal,
				output_frame(1, "turn_stream", serde_json::json!({"text":"secret"})),
				RedactionPolicy::Redacted,
			)
			.unwrap();
		assert_eq!(redacted.payload, serde_json::json!({"redacted": true}));
		let ReplayOutcome::Frames(full) = state.replay_to_subscriber(
			&principal,
			&SessionId("s1".into()),
			Seq(0),
			RedactionPolicy::Full,
		) else {
			panic!("expected replay");
		};
		assert_eq!(full[0].payload, serde_json::json!({"text":"secret"}));
	}

	fn lifecycle_frame(kind: FrameKind, ty: &str, corr: &str, session: &str) -> GjcFrame {
		let mut frame = output_frame(1, ty, serde_json::json!({ "ok": true }));
		frame.kind = kind;
		frame.session_id = SessionId(session.into());
		frame.correlation_id = Some(CorrelationId(corr.into()));
		frame
	}

	#[test]
	fn daemon_path_broker_lifecycle_rejects_duplicate_wrong_principal_and_wrong_session() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let other = Principal::Unix { uid: me.saturating_add(1), gid, pid: None };
		let mut state = DaemonState::new(
			vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::GateAnswer])],
			future_now(),
		);
		state
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		let open = lifecycle_frame(FrameKind::WorkflowGate, "workflow_gate", "c1", "s1");
		assert_eq!(state.route_lifecycle_frame(&principal, &open), Ok(()));
		assert_eq!(
			state.registry.owner_of(&CorrelationId("c1".into())),
			Some(&SessionId("s1".into()))
		);
		assert_eq!(
			state.route_lifecycle_frame(&principal, &open),
			Err(BrokerLifecycleError::DuplicateCorrelation)
		);
		let response = lifecycle_frame(FrameKind::Response, "workflow_gate_result", "c1", "s1");
		assert_eq!(
			state.route_lifecycle_frame(&other, &response),
			Err(BrokerLifecycleError::WrongPrincipal)
		);
		let wrong_session =
			lifecycle_frame(FrameKind::Response, "workflow_gate_result", "c1", "other");
		assert_eq!(
			state.route_lifecycle_frame(&principal, &wrong_session),
			Err(BrokerLifecycleError::SessionMismatch)
		);
		assert_eq!(
			state.registry.owner_of(&CorrelationId("c1".into())),
			Some(&SessionId("s1".into()))
		);
		assert_eq!(state.route_lifecycle_frame(&principal, &response), Ok(()));
		assert!(
			state
				.registry
				.owner_of(&CorrelationId("c1".into()))
				.is_none()
		);
	}

	#[test]
	fn daemon_path_cancel_and_notification_terminal_state_are_enforced() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let other = Principal::Unix { uid: me.saturating_add(1), gid, pid: None };
		let mut state = DaemonState::new(
			vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::GateAnswer])],
			future_now(),
		);
		state
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		let open = lifecycle_frame(FrameKind::WorkflowGate, "workflow_gate", "cancel-c", "s1");
		assert_eq!(state.route_lifecycle_frame(&principal, &open), Ok(()));
		let cancel = lifecycle_frame(FrameKind::Command, "cancel", "cancel-c", "s1");
		assert_eq!(
			state.route_lifecycle_frame(&other, &cancel),
			Err(BrokerLifecycleError::WrongPrincipal)
		);
		assert_eq!(state.route_lifecycle_frame(&principal, &cancel), Ok(()));
		assert!(
			state
				.registry
				.owner_of(&CorrelationId("cancel-c".into()))
				.is_none()
		);

		let action = lifecycle_frame(FrameKind::Notification, "action_needed", "n1", "s1");
		assert_eq!(state.route_lifecycle_frame(&principal, &action), Ok(()));
		let wrong_principal = lifecycle_frame(FrameKind::Notification, "callback", "n1", "s1");
		assert_eq!(
			state.route_lifecycle_frame(&other, &wrong_principal),
			Err(BrokerLifecycleError::WrongPrincipal)
		);
		assert_eq!(
			state.registry.owner_of(&CorrelationId("n1".into())),
			Some(&SessionId("s1".into()))
		);
		let wrong_session = lifecycle_frame(FrameKind::Notification, "callback", "n1", "other");
		assert_eq!(
			state.route_lifecycle_frame(&principal, &wrong_session),
			Err(BrokerLifecycleError::SessionMismatch)
		);
		assert_eq!(
			state.registry.owner_of(&CorrelationId("n1".into())),
			Some(&SessionId("s1".into()))
		);
		let callback = lifecycle_frame(FrameKind::Notification, "callback", "n1", "s1");
		assert_eq!(state.route_lifecycle_frame(&principal, &callback), Ok(()));
		assert!(
			state
				.registry
				.owner_of(&CorrelationId("n1".into()))
				.is_none()
		);
		let expired = lifecycle_frame(FrameKind::Notification, "expired", "n1", "s1");
		assert_eq!(
			state.route_lifecycle_frame(&principal, &expired),
			Err(BrokerLifecycleError::TerminalNotification)
		);
	}

	#[test]
	fn daemon_path_two_live_subscribers_share_one_raw_replay_and_drain_acked_frames() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let mut state = DaemonState::new(
			vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::Read])],
			future_now(),
		);
		state
			.accept_hello_for_subscriber(
				PROTOCOL_VERSION,
				&principal,
				"sub-a",
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		state
			.accept_hello_for_subscriber(
				PROTOCOL_VERSION,
				&principal,
				"sub-b",
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		let rendered = state
			.fanout_to_subscribers(
				&principal,
				output_frame(1, "turn_stream", serde_json::json!({"text":"secret"})),
				&[
					("sub-a".to_string(), RedactionPolicy::Full, Seq(0)),
					("sub-b".to_string(), RedactionPolicy::Full, Seq(0)),
				],
			)
			.unwrap();
		assert_eq!(state.replay_len(&SessionId("s1".into())), 1);
		assert_eq!(rendered[0].payload, serde_json::json!({"text":"secret"}));
		assert_eq!(rendered[1].payload, serde_json::json!({"text":"secret"}));
		let drained_a = state.drain_subscriber_queue(
			&principal,
			"sub-a",
			&SessionId("s1".into()),
			RedactionPolicy::Full,
			Seq(1),
		);
		assert!(drained_a.is_empty());
		let pending_b = state.drain_subscriber_queue(
			&principal,
			"sub-b",
			&SessionId("s1".into()),
			RedactionPolicy::Full,
			Seq(0),
		);
		assert_eq!(pending_b.iter().map(|f| f.seq.0).collect::<Vec<_>>(), vec![1]);
	}

	#[test]
	fn daemon_path_replay_requires_subscribe_and_read() {
		// SAFETY: getuid/getgid are always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		let principal = Principal::Unix { uid: me, gid, pid: None };
		let mut subscribe_only =
			DaemonState::new(vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe])], future_now());
		subscribe_only
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		subscribe_only
			.emit_to_subscriber(
				&principal,
				output_frame(1, "turn_stream", serde_json::json!({"text":"secret"})),
				RedactionPolicy::Full,
			)
			.unwrap();
		assert!(matches!(
			subscribe_only.replay_to_subscriber(
				&principal,
				&SessionId("s1".into()),
				Seq(0),
				RedactionPolicy::Full,
			),
			ReplayOutcome::ResetRequired { .. }
		));
		let denied_json = serde_json::to_string(subscribe_only.observability_events()).unwrap();
		assert!(denied_json.contains("ScopeNotGranted"));

		let mut read_allowed = DaemonState::new(
			vec![me_grant(me, vec!["s1"], vec![Scope::Subscribe, Scope::Read])],
			future_now(),
		);
		read_allowed
			.accept_hello(
				PROTOCOL_VERSION,
				&principal,
				&[(SessionId("s1".into()), RedactionPolicy::Full)],
			)
			.unwrap();
		read_allowed
			.emit_to_subscriber(
				&principal,
				output_frame(1, "turn_stream", serde_json::json!({"text":"secret"})),
				RedactionPolicy::Full,
			)
			.unwrap();
		let ReplayOutcome::Frames(frames) = read_allowed.replay_to_subscriber(
			&principal,
			&SessionId("s1".into()),
			Seq(0),
			RedactionPolicy::Full,
		) else {
			panic!("expected replay frames");
		};
		assert_eq!(frames.len(), 1);
		assert_eq!(frames[0].payload, serde_json::json!({"text":"secret"}));
	}

	#[tokio::test]
	async fn daemon_hosts_real_ts_worker_get_state_end_to_end() {
		let path = sock("real-ts-worker-get-state");
		let listener = crate::uds_transport::secure_bind(&path).expect("bind");
		// SAFETY: getuid is always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		let g = me_grant(me, vec!["e2e-get-state"], vec![Scope::Subscribe, Scope::Read]);
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let mut state = DaemonState::new(vec![g], future_now()).with_worker_hosting();
			let r = state.serve_session(&mut stream).await;
			(r.is_ok(), state.replay_len(&SessionId("e2e-get-state".into())))
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let req = HelloRequest {
			protocol_version: PROTOCOL_VERSION,
			requested: vec![HelloSessionRequest {
				session: "e2e-get-state".into(),
				redaction: RedactionPolicy::Full,
			}],
			grant_id: None,
		};
		write_frame(&mut client, &hello_frame(&req))
			.await
			.expect("hello");
		let mut cdec = FrameDecoder::new();
		let ready = read_frame(&mut client, &mut cdec)
			.await
			.expect("read")
			.expect("ready");
		assert_eq!(ready.kind, FrameKind::Ready);
		let cmd = GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("get_state_cmd".into()),
			session_id: SessionId("e2e-get-state".into()),
			seq: Seq(1),
			direction: Direction::ClientToServer,
			kind: FrameKind::Command,
			r#type: "get_state".into(),
			correlation_id: Some(CorrelationId("corr-get-state".into())),
			replay: false,
			capability_scope: Some(Scope::Read),
			payload: serde_json::json!({}),
		};
		write_frame(&mut client, &cmd)
			.await
			.expect("send get_state");
		let response = tokio::time::timeout(
			std::time::Duration::from_secs(30),
			read_frame(&mut client, &mut cdec),
		)
		.await
		.expect("worker response timeout")
		.expect("read response")
		.expect("response");
		assert_eq!(response.kind, FrameKind::Response);
		assert_eq!(response.r#type, "get_state");
		assert_eq!(response.session_id, SessionId("e2e-get-state".into()));
		assert_eq!(response.correlation_id, Some(CorrelationId("corr-get-state".into())));
		assert_eq!(response.payload["success"], serde_json::json!(true));
		drop(client);
		let (ok, replay_len) = server.await.expect("server");
		assert!(ok);
		assert!(replay_len >= 1);
		let _ = std::fs::remove_file(&path);
	}

	#[tokio::test]
	async fn worker_stdout_pump_delivers_later_async_event_without_second_command() {
		let path = sock("worker-pump-multiframe");
		let listener = crate::uds_transport::secure_bind(&path).expect("bind");
		let mut script_path = std::env::temp_dir();
		script_path.push(format!("gjc-rpc-worker-pump-{}-{}.sh", std::process::id(), "multiframe"));
		let response = serde_json::to_string(&worker_output_frame(
			"worker-response",
			"pump-session",
			1,
			FrameKind::Response,
			"get_state",
			Some("corr-pump"),
		))
		.unwrap();
		let async_event = serde_json::to_string(&worker_output_frame(
			"worker-event",
			"pump-session",
			2,
			FrameKind::Event,
			"agent_start",
			None,
		))
		.unwrap();
		let script = format!(
			"#!/bin/sh\nIFS= read line\nprintf '%s\\n' '{response}'\nsleep 0.05\nprintf '%s\\n' '{async_event}'\n"
		);
		std::fs::write(&script_path, script).expect("write worker fixture");
		let mut perms = std::fs::metadata(&script_path)
			.expect("script metadata")
			.permissions();
		use std::os::unix::fs::PermissionsExt;
		perms.set_mode(0o700);
		std::fs::set_permissions(&script_path, perms).expect("chmod worker fixture");
		// SAFETY: getuid is always-successful, thread-safe, side-effect-free.
		let me = unsafe { libc::getuid() };
		let g = me_grant(me, vec!["pump-session"], vec![Scope::Subscribe, Scope::Read]);
		let worker_spec = WorkerSpec {
			program: script_path.to_string_lossy().into_owned(),
			args: Vec::new(),
			env: HashMap::new(),
		};
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let mut state = DaemonState::new(vec![g], future_now())
				.with_worker_spec(worker_spec)
				.with_worker_hosting();
			let r = state.serve_session(&mut stream).await;
			(r.is_ok(), state.replay_len(&SessionId("pump-session".into())))
		});
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let req = HelloRequest {
			protocol_version: PROTOCOL_VERSION,
			requested: vec![HelloSessionRequest {
				session: "pump-session".into(),
				redaction: RedactionPolicy::Full,
			}],
			grant_id: None,
		};
		write_frame(&mut client, &hello_frame(&req))
			.await
			.expect("hello");
		let mut cdec = FrameDecoder::new();
		let ready = read_frame(&mut client, &mut cdec)
			.await
			.expect("read ready")
			.expect("ready");
		assert_eq!(ready.kind, FrameKind::Ready);
		write_frame(&mut client, &command_frame("pump-session", "corr-pump", "get_state"))
			.await
			.expect("send command");
		let first = tokio::time::timeout(
			std::time::Duration::from_secs(2),
			read_frame(&mut client, &mut cdec),
		)
		.await
		.expect("first frame timeout")
		.expect("read first")
		.expect("first frame");
		let second = tokio::time::timeout(
			std::time::Duration::from_secs(2),
			read_frame(&mut client, &mut cdec),
		)
		.await
		.expect("async event timeout")
		.expect("read async event")
		.expect("async event");
		assert_eq!(first.kind, FrameKind::Response);
		assert_eq!(first.correlation_id, Some(CorrelationId("corr-pump".into())));
		assert_eq!(second.kind, FrameKind::Event);
		assert_eq!(second.r#type, "agent_start");
		drop(client);
		let (ok, replay_len) = server.await.expect("server");
		assert!(ok);
		assert_eq!(replay_len, 2);
		let _ = std::fs::remove_file(&path);
		let _ = std::fs::remove_file(&script_path);
	}

	fn me_grant(uid: u32, sessions: Vec<&str>, scopes: Vec<Scope>) -> GrantRecord {
		// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
		let gid = unsafe { libc::getgid() };
		GrantRecord {
			version: 1,
			grant_id: "g".into(),
			principal_binding: Principal::Unix { uid, gid, pid: None },
			bearer_hash: None,
			issued_at: "2026-01-01T00:00:00Z".into(),
			expires_at: "2026-12-31T00:00:00Z".into(),
			renewable_until: "2027-01-01T00:00:00Z".into(),
			revoked_at: None,
			issuer: "cli".into(),
			purpose: "dispatch-test".into(),
			sessions: sessions.into_iter().map(String::from).collect(),
			scopes,
			redaction_policy: RedactionPolicy::Full,
			limits: GrantLimits::default(),
			audit: GrantAudit::default(),
		}
	}
}
