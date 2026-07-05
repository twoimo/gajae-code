//! App-server core: connection handshake gate, thread registry, and the
//!
//! transport-agnostic request dispatcher that ties together identity,
//! scheduling/admission, the field policy, and the `AgentBackend` seam.
//!
//! This is transport-agnostic: transports (stdio/ws/unix, in pi-natives) parse
//! frames and call [`AppServer::dispatch`]/[`AppServer::handle_connection_*`].
//! Full concurrent running turns are supported — each thread has its own
//! backend and admission slots, and dispatch does not hold a global lock across
//! backend calls.

use std::{sync::Arc, time::Duration};

use dashmap::DashMap;
use parking_lot::Mutex;

use crate::{
	backend::{AgentBackend, BackendCallContext, BackendEvent, BackendFactory},
	error::{AppServerError, Result},
	event_map::ThreadStream,
	host_tools::{HostToolRegistry, HostToolResult, PendingHostToolCall},
	host_uris::{HostUriRegistry, HostUriResultParams, PendingHostUriRequest},
	identity::{ThreadIdentity, ThreadStatus},
	ids::{ConnectionId, ThreadId, TurnId},
	jsonrpc::{Inbound, Notification, Response},
	scheduler::{Admission, Lane},
};

/// Where mapped notifications are delivered (transport fan-out to subscribers).
/// Transports (pi-natives) implement this to push frames to connected clients.
pub trait EventSink: Send + Sync {
	fn emit(&self, note: Notification);
}

/// Per-thread registry entry: identity + backend + admission + event stream.
struct ThreadEntry {
	identity: Mutex<ThreadIdentity>,
	backend: Arc<dyn AgentBackend>,
	admission: Mutex<Admission>,
	stream: Mutex<ThreadStream>,
	active_turn: Mutex<Option<TurnId>>,
	/// Serializes non-turn mutating backend calls for this thread (serial
	/// mutating lane); read/cancel lanes never take it.
	mutating_lane: Arc<tokio::sync::Mutex<()>>,
	host_tools: Mutex<HostToolRegistry>,
	workflow_gates: Mutex<crate::workflow_gate::WorkflowGateBroker>,
	unattended: Mutex<crate::unattended::UnattendedController>,
	host_uris: Mutex<HostUriRegistry>,
}

/// Per-connection handshake state.
#[derive(Default)]
struct ConnectionState {
	/// Set once the `initialize` request has been answered.
	initialize_seen: bool,
	/// Set once the `initialized` notification acks the handshake.
	initialized: bool,
	/// Set once this connection subscribes to `gjc/notifications/event` frames.
	notifications_subscriber: bool,
}

/// Tunables for admission control.
#[derive(Debug, Clone, Copy)]
pub struct AppServerConfig {
	pub max_inflight_turns_per_thread: usize,
	pub max_queued_mutations_per_thread: usize,
}

impl Default for AppServerConfig {
	fn default() -> Self {
		Self { max_inflight_turns_per_thread: 8, max_queued_mutations_per_thread: 64 }
	}
}

/// The app-server core. Cheap to clone-share behind an `Arc`.
pub struct AppServer {
	factory: Arc<dyn BackendFactory>,
	threads: DashMap<ThreadId, ThreadEntry>,
	connections: DashMap<ConnectionId, Mutex<ConnectionState>>,
	config: AppServerConfig,
	sink: Arc<dyn EventSink>,
	notification_host: Arc<dyn crate::notifications::NotificationHost>,
	/// Fan-out of every emitted notification to socket transports (e.g. WS)
	/// that subscribe per-connection, in addition to the primary `sink`.
	event_tx: tokio::sync::broadcast::Sender<Notification>,
	pending_host_tool_calls: DashMap<String, PendingHostToolCall>,
	pending_host_uri_requests: DashMap<String, PendingHostUriRequest>,
	pending_workflow_gates:
		DashMap<String, (ThreadId, tokio::sync::oneshot::Receiver<serde_json::Value>)>,
}

impl AppServer {
	#[must_use]
	pub fn new(
		factory: Arc<dyn BackendFactory>,
		config: AppServerConfig,
		sink: Arc<dyn EventSink>,
	) -> Self {
		Self::new_with_notification_host(
			factory,
			config,
			sink,
			Arc::new(crate::notifications::NoopNotificationHost),
		)
	}

	#[must_use]
	pub fn new_with_notification_host(
		factory: Arc<dyn BackendFactory>,
		config: AppServerConfig,
		sink: Arc<dyn EventSink>,
		notification_host: Arc<dyn crate::notifications::NotificationHost>,
	) -> Self {
		let (event_tx, _rx) = tokio::sync::broadcast::channel(256);
		Self {
			factory,
			threads: DashMap::new(),
			connections: DashMap::new(),
			config,
			sink,
			notification_host,
			event_tx,
			pending_host_tool_calls: DashMap::new(),
			pending_workflow_gates: DashMap::new(),
			pending_host_uri_requests: DashMap::new(),
		}
	}

	/// Deliver a backend event: reject stale events by generation, map it to
	/// codex `item/*`/`turn/*` notifications via the thread's stream, and push
	/// each to the sink. Returns the number of notifications emitted (0 when the
	/// event was rejected as stale or the thread is unknown).
	pub fn emit_backend_event(&self, ev: &BackendEvent) -> usize {
		let Some(entry) = self.threads.get(&ev.thread_id) else {
			return 0;
		};
		// Stale/unknown-generation/deleted events are rejected, never mapped.
		if !entry
			.value()
			.identity
			.lock()
			.accepts_event(&ev.thread_id, ev.generation)
		{
			return 0;
		}
		let notes = entry.value().stream.lock().on_event(ev);
		let n = notes.len();
		for note in notes {
			self.publish(note);
		}
		n
	}

	/// Push an opaque notifications SDK frame to the transport sink.
	pub fn push_notification(&self, frame: serde_json::Value) {
		self.publish(crate::notifications::event(frame));
	}

	/// Emit a notification to the primary sink and the socket-transport
	/// broadcast. Broadcast send errors (no live subscribers) are ignored.
	fn publish(&self, note: Notification) {
		let _ = self.event_tx.send(note.clone());
		self.sink.emit(note);
	}

	pub fn active_turn_id(&self, thread_id: &ThreadId) -> Result<Option<TurnId>> {
		let entry = self
			.threads
			.get(thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		Ok(entry.value().active_turn.lock().clone())
	}

	pub async fn call_host_tool(
		&self,
		thread_id: &ThreadId,
		turn_id: &TurnId,
		tool: &str,
		args: serde_json::Value,
	) -> Result<HostToolResult> {
		self
			.call_host_tool_with_timeout(thread_id, turn_id, tool, args, Duration::from_secs(30))
			.await
	}

	pub async fn call_host_tool_with_timeout(
		&self,
		thread_id: &ThreadId,
		turn_id: &TurnId,
		tool: &str,
		args: serde_json::Value,
		timeout: Duration,
	) -> Result<HostToolResult> {
		let generation = {
			let entry = self
				.threads
				.get(thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			if !entry.value().host_tools.lock().contains(tool) {
				return Err(AppServerError::not_found(format!("host tool not registered: {tool}")));
			}
			entry.value().identity.lock().generation
		};
		let call_id = format!("call_{}", crate::ids::TurnId::generate().0);
		let (tx, rx) = tokio::sync::oneshot::channel();
		self.pending_host_tool_calls.insert(
			call_id.clone(),
			PendingHostToolCall {
				thread_id: thread_id.clone(),
				generation,
				turn_id: turn_id.clone(),
				tool: tool.to_string(),
				progress: Arc::new(Mutex::new(Vec::new())),
				tx,
			},
		);
		self.publish(Notification::new(
			"gjc/hostTools/call",
			serde_json::json!({
				"threadId": thread_id.0,
				"generation": generation.0,
				"turnId": turn_id.0,
				"callId": call_id,
				"tool": tool,
				"args": args,
			}),
		));
		match tokio::time::timeout(timeout, rx).await {
			Ok(Ok(result)) => Ok(result),
			Ok(Err(_)) => Err(AppServerError::conflict("host tool call was cancelled")),
			Err(_) => {
				self.pending_host_tool_calls.remove(&call_id);
				Err(AppServerError::new(
					crate::error::codes::INTERNAL_ERROR,
					"host tool call timed out",
				))
			},
		}
	}

	async fn preflight_host_uri_operation(
		&self,
		thread_id: &ThreadId,
		method: &str,
	) -> Result<Option<crate::unattended::PreflightOutcome>> {
		let params = serde_json::json!({ "threadId": thread_id.0 });
		let Some(entry) = self.threads.get(thread_id) else {
			return Ok(None);
		};
		let preflight = entry
			.value()
			.unattended
			.lock()
			.preflight(thread_id, method, Some(&params));
		match preflight {
			Ok(outcome) => Ok(outcome),
			Err(err) => {
				if err
					.data
					.as_ref()
					.and_then(|d| d.get("code"))
					.and_then(|v| v.as_str())
					== Some("budget_exceeded")
				{
					self.abort_unattended_thread(thread_id, &err).await;
				}
				Err(err)
			},
		}
	}

	pub async fn read_host_uri(
		&self,
		thread_id: &ThreadId,
		turn_id: &TurnId,
		url: &str,
	) -> Result<crate::host_uris::HostUriResource> {
		let charged = self
			.preflight_host_uri_operation(thread_id, "gjc/hostUris/read")
			.await?
			.is_some_and(|outcome| outcome.charged);
		let scheme = extract_url_scheme(url)?;
		let (generation, definition) = {
			let entry = self
				.threads
				.get(thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			let definition = entry.value().host_uris.lock().get(&scheme).ok_or_else(|| {
				AppServerError::not_found(format!("host URI scheme not registered: {scheme}"))
			})?;
			(entry.value().identity.lock().generation, definition)
		};
		let result = self
			.dispatch_host_uri_request(
				thread_id,
				generation,
				turn_id,
				"read",
				url,
				None,
				Duration::from_secs(30),
			)
			.await?;
		self
			.reconcile_host_uri_preflight(thread_id, charged)
			.await?;
		crate::host_uris::resource_from_result(url, &definition, result)
	}

	pub async fn write_host_uri(
		&self,
		thread_id: &ThreadId,
		turn_id: &TurnId,
		url: &str,
		content: String,
	) -> Result<()> {
		let charged = self
			.preflight_host_uri_operation(thread_id, "gjc/hostUris/write")
			.await?
			.is_some_and(|outcome| outcome.charged);
		let scheme = extract_url_scheme(url)?;
		{
			let entry = self
				.threads
				.get(thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			let definition = entry.value().host_uris.lock().get(&scheme).ok_or_else(|| {
				AppServerError::not_found(format!("host URI scheme not registered: {scheme}"))
			})?;
			if !definition.writable {
				return Err(AppServerError::conflict(format!(
					"host URI scheme is not writable: {scheme}"
				)));
			}
		}
		let generation = {
			let entry = self
				.threads
				.get(thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			entry.value().identity.lock().generation
		};
		let result = self
			.dispatch_host_uri_request(
				thread_id,
				generation,
				turn_id,
				"write",
				url,
				Some(content),
				Duration::from_secs(30),
			)
			.await?;
		self
			.reconcile_host_uri_preflight(thread_id, charged)
			.await?;
		if result.is_error {
			return Err(AppServerError::new(
				crate::error::codes::INTERNAL_ERROR,
				result
					.error
					.or(result.content)
					.unwrap_or_else(|| format!("Host URI write failed for {url}")),
			));
		}
		Ok(())
	}

	async fn reconcile_host_uri_preflight(&self, thread_id: &ThreadId, charged: bool) -> Result<()> {
		if !charged {
			return Ok(());
		}
		let usage = if let Ok((backend, ctx)) = self.backend_and_ctx(thread_id, Lane::Read) {
			backend.usage_snapshot(&ctx).await.ok().flatten()
		} else {
			None
		};
		let reconcile = if let Some(entry) = self.threads.get(thread_id) {
			entry.value().unattended.lock().reconcile(usage)
		} else {
			Ok(())
		};
		if let Err(err) = reconcile {
			self.abort_unattended_thread(thread_id, &err).await;
			return Err(err);
		}
		Ok(())
	}

	async fn dispatch_host_uri_request(
		&self,
		thread_id: &ThreadId,
		generation: crate::ids::BackendGeneration,
		turn_id: &TurnId,
		operation: &str,
		url: &str,
		content: Option<String>,
		timeout: Duration,
	) -> Result<HostUriResultParams> {
		let request_id = format!("host_uri_{}", crate::ids::TurnId::generate().0);
		let (tx, rx) = tokio::sync::oneshot::channel();
		self.pending_host_uri_requests.insert(
			request_id.clone(),
			PendingHostUriRequest {
				thread_id: thread_id.clone(),
				generation,
				turn_id: turn_id.clone(),
				tx,
			},
		);
		self.publish(Notification::new(
			"gjc/hostUris/request",
			serde_json::json!({
				"threadId": thread_id.0,
				"generation": generation.0,
				"turnId": turn_id.0,
				"requestId": request_id,
				"operation": operation,
				"url": url,
				"content": content,
			}),
		));
		match tokio::time::timeout(timeout, rx).await {
			Ok(Ok(result)) => Ok(result),
			Ok(Err(_)) => Err(AppServerError::conflict("host URI request was cancelled")),
			Err(_) => {
				self.pending_host_uri_requests.remove(&request_id);
				Err(AppServerError::new(
					crate::error::codes::INTERNAL_ERROR,
					"host URI request timed out",
				))
			},
		}
	}

	pub async fn open_workflow_gate(
		&self,
		thread_id: &ThreadId,
		input: crate::workflow_gate::OpenWorkflowGateInput,
	) -> Result<serde_json::Value> {
		let (generation, gate, rx) = {
			let entry = self
				.threads
				.get(thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			let generation = entry.value().identity.lock().generation;
			let (gate, rx) = entry.value().workflow_gates.lock().open(thread_id, input)?;
			(generation, gate, rx)
		};
		let gate_id = gate.gate_id.clone();
		self
			.pending_workflow_gates
			.insert(gate_id.clone(), (thread_id.clone(), rx));
		let params = crate::workflow_gate::WorkflowGateOpenedParams {
			thread_id: thread_id.0.clone(),
			generation: generation.0,
			gate,
		};
		self.publish(Notification::new(
			"gjc/workflowGate/opened",
			serde_json::to_value(params).map_err(|err| {
				AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string())
			})?,
		));
		let Some((_, (_, rx))) = self.pending_workflow_gates.remove(&gate_id) else {
			return Err(AppServerError::conflict("workflow gate was cancelled"));
		};
		rx.await
			.map_err(|_| AppServerError::conflict("workflow gate was cancelled"))
	}

	pub fn host_tool_names(&self, thread_id: &ThreadId) -> Result<Vec<String>> {
		let entry = self
			.threads
			.get(thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		Ok(entry.value().host_tools.lock().names())
	}

	fn cancel_host_tool_calls_for_turn(&self, thread_id: &ThreadId, turn_id: &TurnId) {
		let call_ids = self
			.pending_host_tool_calls
			.iter()
			.filter(|entry| &entry.value().thread_id == thread_id && &entry.value().turn_id == turn_id)
			.map(|entry| entry.key().clone())
			.collect::<Vec<_>>();
		for call_id in call_ids {
			if let Some((_, pending)) = self.pending_host_tool_calls.remove(&call_id) {
				self.publish(Notification::new(
					"gjc/hostTools/cancel",
					serde_json::json!({
						"threadId": thread_id.0,
						"generation": pending.generation.0,
						"turnId": pending.turn_id.0,
						"callId": call_id,
					}),
				));
				// Dropping `pending.tx` rejects the waiter with a structured
				// "cancelled" conflict error (see the `Ok(Err(_))` branch above).
				drop(pending);
			}
		}
	}

	fn cancel_host_tool_calls_for_thread(&self, thread_id: &ThreadId) {
		let call_ids = self
			.pending_host_tool_calls
			.iter()
			.filter(|entry| &entry.value().thread_id == thread_id)
			.map(|entry| entry.key().clone())
			.collect::<Vec<_>>();
		for call_id in call_ids {
			if let Some((_, pending)) = self.pending_host_tool_calls.remove(&call_id) {
				self.publish(Notification::new(
					"gjc/hostTools/cancel",
					serde_json::json!({
						"threadId": thread_id.0,
						"generation": pending.generation.0,
						"turnId": pending.turn_id.0,
						"callId": call_id,
					}),
				));
				// Dropping `pending.tx` rejects the waiter with a structured
				// "cancelled" conflict error (see the `Ok(Err(_))` branch above).
				drop(pending);
			}
		}
	}

	fn cancel_host_uri_requests_for_turn(&self, thread_id: &ThreadId, turn_id: &TurnId) {
		let request_ids = self
			.pending_host_uri_requests
			.iter()
			.filter(|entry| &entry.value().thread_id == thread_id && &entry.value().turn_id == turn_id)
			.map(|entry| entry.key().clone())
			.collect::<Vec<_>>();
		for request_id in request_ids {
			if let Some((_, pending)) = self.pending_host_uri_requests.remove(&request_id) {
				self.publish(Notification::new(
					"gjc/hostUris/cancel",
					serde_json::json!({
						"threadId": thread_id.0,
						"generation": pending.generation.0,
						"turnId": pending.turn_id.0,
						"requestId": request_id,
					}),
				));
				drop(pending);
			}
		}
	}

	fn cancel_host_uri_requests_for_thread(&self, thread_id: &ThreadId) {
		let request_ids = self
			.pending_host_uri_requests
			.iter()
			.filter(|entry| &entry.value().thread_id == thread_id)
			.map(|entry| entry.key().clone())
			.collect::<Vec<_>>();
		for request_id in request_ids {
			if let Some((_, pending)) = self.pending_host_uri_requests.remove(&request_id) {
				self.publish(Notification::new(
					"gjc/hostUris/cancel",
					serde_json::json!({
						"threadId": thread_id.0,
						"generation": pending.generation.0,
						"turnId": pending.turn_id.0,
						"requestId": request_id,
					}),
				));
				drop(pending);
			}
		}
	}

	/// Subscribe a socket transport connection to the notification fan-out.
	#[must_use]
	pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<Notification> {
		self.event_tx.subscribe()
	}

	/// Whether a socket transport should forward `note` to `conn`. Opaque
	/// `gjc/notifications/event` frames go only to connections that opted in via
	/// `gjc/notifications/subscribe`; all other frames (turn/item/gjc events)
	/// are forwarded to any live connection.
	#[must_use]
	pub fn should_forward(&self, conn: &ConnectionId, note: &Notification) -> bool {
		if note.method != crate::notifications::EVENT_METHOD {
			return true;
		}
		self
			.connections
			.get(conn)
			.is_some_and(|c| c.value().lock().notifications_subscriber)
	}

	pub fn open_connection(&self) -> ConnectionId {
		let id = ConnectionId::generate();
		self
			.connections
			.insert(id.clone(), Mutex::new(ConnectionState::default()));
		id
	}

	pub fn close_connection(&self, conn: &ConnectionId) {
		self.connections.remove(conn);
	}

	fn require_initialized(&self, conn: &ConnectionId) -> Result<()> {
		let entry = self.connections.get(conn).ok_or_else(|| {
			AppServerError::new(crate::error::codes::INVALID_REQUEST, "unknown connection")
		})?;
		if entry.value().lock().initialized {
			Ok(())
		} else {
			Err(AppServerError::not_initialized())
		}
	}

	#[must_use]
	pub fn loaded_thread_ids(&self) -> Vec<ThreadId> {
		self.threads.iter().map(|e| e.key().clone()).collect()
	}

	/// Dispatch one parsed inbound frame. Returns `Some(Response)` for requests,
	/// `None` for notifications.
	pub async fn dispatch(
		self: &Arc<Self>,
		conn: &ConnectionId,
		inbound: Inbound,
	) -> Option<Response> {
		match inbound {
			Inbound::Notification(note) => {
				// The only bootstrap notification is `initialized`.
				if note.method == "initialized"
					&& let Some(c) = self.connections.get(conn)
				{
					c.value().lock().initialized = true;
				}
				// Fire-and-forget notification-shaped notifications frames
				// (reply/userMessage/configCommand) route to the host; the
				// result is ignored since notifications carry no response.
				else if crate::notifications::is_notifications_method(&note.method) {
					let _ = self
						.handle_notification_call(conn, &note.method, note.params)
						.await;
				}
				None
			},
			Inbound::Request(req) => {
				let id = req.id.clone();
				let result = self.dispatch_request(conn, &req.method, req.params).await;
				Some(match result {
					Ok(value) => Response::ok(id, value),
					Err(err) => Response::err(id, err),
				})
			},
		}
	}

	async fn dispatch_request(
		self: &Arc<Self>,
		conn: &ConnectionId,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		// The initialize handshake is the only request allowed pre-init.
		if method == "initialize" {
			return self.handle_initialize(conn);
		}
		self.require_initialized(conn)?;
		if crate::notifications::is_notifications_method(method) {
			// Documented exception to the strict gjc/* invariant: notification
			// frames are opaque JSON owned by the TS notifications extension and
			// are not field-policed here (see field_policy::policy_for docs).
			return self.handle_notification_call(conn, method, params).await;
		}

		// Serial mutating lane: non-turn mutations on the same thread run one at
		// a time with bounded admission, while read/cancel lanes stay fast.
		if is_serialized_mutation(method) {
			let thread_id = extract_thread_id(params.as_ref())?;
			let lane = {
				let entry = self
					.threads
					.get(&thread_id)
					.ok_or_else(|| AppServerError::not_found("thread not found"))?;
				entry.value().admission.lock().try_enqueue_mutation()?; // -32001 when saturated
				Arc::clone(&entry.value().mutating_lane)
			};
			let _guard = lane.lock().await;
			let result = self.dispatch_with_unattended(method, params).await;
			if let Some(entry) = self.threads.get(&thread_id) {
				entry.value().admission.lock().dequeue_mutation();
			}
			return result;
		}

		self.dispatch_with_unattended(method, params).await
	}

	async fn dispatch_with_unattended(
		self: &Arc<Self>,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		if method == "gjc/unattended/negotiate" {
			return self.handle_unattended_negotiate(method, params);
		}
		let thread_id = extract_thread_id(params.as_ref()).ok();
		let mut charged_thread = None;
		if let Some(thread_id) = thread_id.as_ref()
			&& let Some(entry) = self.threads.get(thread_id)
		{
			let preflight =
				entry
					.value()
					.unattended
					.lock()
					.preflight(thread_id, method, params.as_ref());
			match preflight {
				Ok(Some(outcome)) if outcome.charged => charged_thread = Some(thread_id.clone()),
				Ok(_) => {},
				Err(err) => {
					if err
						.data
						.as_ref()
						.and_then(|d| d.get("code"))
						.and_then(|v| v.as_str())
						== Some("budget_exceeded")
					{
						self.abort_unattended_thread(thread_id, &err).await;
					}
					return Err(err);
				},
			}
		}
		let result = self.dispatch_method(method, params).await;
		if let Some(thread_id) = charged_thread {
			let usage = if let Ok((backend, ctx)) = self.backend_and_ctx(&thread_id, Lane::Read) {
				backend.usage_snapshot(&ctx).await.ok().flatten()
			} else {
				None
			};
			let reconcile = if let Some(entry) = self.threads.get(&thread_id) {
				entry.value().unattended.lock().reconcile(usage)
			} else {
				Ok(())
			};
			if let Err(err) = reconcile {
				self.abort_unattended_thread(&thread_id, &err).await;
				return Err(err);
			}
		}
		result
	}

	async fn abort_unattended_thread(&self, thread_id: &ThreadId, err: &AppServerError) {
		let Some(entry) = self.threads.get(thread_id) else {
			return;
		};
		let run_id = err
			.data
			.as_ref()
			.and_then(|d| d.get("run_id"))
			.and_then(|v| v.as_str())
			.unwrap_or("unattended");
		entry
			.value()
			.workflow_gates
			.lock()
			.reject_pending_for_unattended_abort(run_id);
		self.cancel_host_tool_calls_for_thread(thread_id);
		self.cancel_host_uri_requests_for_thread(thread_id);
		let active_turn = entry.value().active_turn.lock().clone();
		if let Some(turn_id) = active_turn
			&& let Ok((backend, ctx)) = self.backend_and_ctx(thread_id, Lane::Cancel)
		{
			let _ = backend.abort(&ctx, &turn_id).await;
		}
		entry.value().unattended.lock().mark_abort_settled();
	}

	async fn dispatch_method(
		self: &Arc<Self>,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		match method {
			"thread/start" => self.handle_thread_start(params).await,
			"thread/resume" => self.handle_thread_resume(params).await,
			"thread/fork" => self.handle_thread_fork(params).await,
			"thread/delete" => self.handle_thread_delete(params).await,
			"thread/archive" => self.handle_thread_archive(params),
			"thread/read" => self.handle_thread_read(params),
			"thread/loaded/list" => Ok(serde_json::json!({
				 "data": self.loaded_thread_ids().iter().map(|t| t.0.clone()).collect::<Vec<_>>()
			})),
			"turn/start" => self.handle_turn_start(params).await,
			"turn/steer" => self.handle_turn_steer(params).await,
			"turn/interrupt" => self.handle_turn_interrupt(params).await,
			"command/exec" => self.handle_command_exec(params).await,
			"thread/shellCommand" => self.handle_thread_shell_command(params).await,
			"gjc/state/read" => self.handle_gjc_state_read(method, params).await,
			"gjc/tools/list" => self.handle_gjc_tools_list(method, params).await,
			"gjc/commands/list" => self.handle_gjc_commands_list(method, params).await,
			"gjc/skills/list" => self.handle_gjc_skills_list(method, params).await,
			"gjc/extensions/list" => self.handle_gjc_extensions_list(method, params).await,
			"gjc/extensions/inspect" => self.handle_gjc_extensions_inspect(method, params).await,
			"gjc/plugins/list" => self.handle_gjc_plugins_list(method, params).await,
			"gjc/plugins/inspect" => self.handle_gjc_plugins_inspect(method, params).await,
			"gjc/messages/get" => self.handle_gjc_messages_get(method, params).await,
			"gjc/model/set" => self.handle_gjc_model_set(method, params).await,
			"gjc/todos/set" => self.handle_gjc_todos_set(method, params).await,
			"gjc/compact" => self.handle_gjc_compact(method, params).await,
			"gjc/hostTools/set" => self.handle_host_tools_set(method, params),
			"gjc/hostTools/result" => self.handle_host_tools_result(method, params),
			"gjc/hostTools/update" => self.handle_host_tools_update(method, params),
			"gjc/hostUriSchemes/set" => self.handle_host_uri_schemes_set(method, params),
			"gjc/hostUris/result" => self.handle_host_uris_result(method, params),
			"gjc/workflowGate/list" => self.handle_workflow_gate_list(method, params),
			"gjc/workflowGate/respond" => self.handle_workflow_gate_respond(method, params),
			"gjc/unattended/negotiate" => self.handle_unattended_negotiate(method, params),
			"gjc/unattended/audit" => self.handle_unattended_audit(method, params),
			other => Err(AppServerError::method_not_found(other)),
		}
	}

	async fn handle_notification_call(
		&self,
		conn: &ConnectionId,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let kind = crate::notifications::call_kind(method)
			.ok_or_else(|| AppServerError::method_not_found(method))?;
		if method == crate::notifications::SUBSCRIBE_METHOD
			&& let Some(c) = self.connections.get(conn)
		{
			c.value().lock().notifications_subscriber = true;
		}
		let result = self
			.notification_host
			.notification_call(&kind, params.unwrap_or(serde_json::Value::Null))
			.await?;
		if method == crate::notifications::SUBSCRIBE_METHOD {
			if let Some(frames) = result.as_array() {
				for frame in frames {
					self.push_notification(frame.clone());
				}
			}
			Ok(serde_json::json!({ "ok": true }))
		} else {
			Ok(result)
		}
	}

	/// Resolve a thread's backend + a call context on the given lane, without
	/// holding the registry lock across the returned backend (so calls run
	/// concurrently across threads).
	fn backend_and_ctx(
		&self,
		thread_id: &ThreadId,
		lane: Lane,
	) -> Result<(Arc<dyn AgentBackend>, BackendCallContext)> {
		let entry = self
			.threads
			.get(thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		let generation = entry.value().identity.lock().generation;
		let ctx =
			BackendCallContext { thread_id: thread_id.clone(), generation, request_id: None, lane };
		Ok((Arc::clone(&entry.value().backend), ctx))
	}

	async fn handle_turn_steer(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		let (backend, ctx) = {
			let entry = self
				.threads
				.get(&thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			Self::check_expected_turn(entry.value(), params.as_ref())?;
			let identity = entry.value().identity.lock();
			let ctx = BackendCallContext {
				thread_id: thread_id.clone(),
				generation: identity.generation,
				request_id: None,
				lane: Lane::Mutating,
			};
			(Arc::clone(&entry.value().backend), ctx)
		};
		let turn_id = backend
			.steer(&ctx, params.unwrap_or(serde_json::Value::Null))
			.await?;
		Ok(serde_json::json!({ "turnId": turn_id.0 }))
	}

	fn check_expected_turn(entry: &ThreadEntry, params: Option<&serde_json::Value>) -> Result<()> {
		let expected = params
			.and_then(|p| p.get("expectedTurnId"))
			.and_then(|v| v.as_str())
			.map(|s| TurnId(s.to_string()));
		if let Some(expected) = expected {
			let active = entry.active_turn.lock().clone();
			if active.as_ref() != Some(&expected) {
				return Err(AppServerError::conflict("expectedTurnId does not match active turn"));
			}
		}
		Ok(())
	}

	fn handle_host_tools_set(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let (thread_id, tools) = crate::host_tools::parse_set_params(method, params.as_ref())?;
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		entry.value().host_tools.lock().replace(tools);
		Ok(serde_json::json!({}))
	}

	fn handle_host_tools_result(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let (thread_id, call_id, result) =
			crate::host_tools::parse_result_params(method, params.as_ref())?;
		let Some((_, pending)) = self.pending_host_tool_calls.remove(&call_id) else {
			return Err(AppServerError::not_found("host tool call not found"));
		};
		if pending.thread_id != thread_id {
			self.pending_host_tool_calls.insert(call_id, pending);
			return Err(AppServerError::conflict(
				"host tool result threadId does not match pending call",
			));
		}
		pending
			.tx
			.send(result)
			.map_err(|_| AppServerError::conflict("host tool call receiver was dropped"))?;
		Ok(serde_json::json!({}))
	}

	fn handle_host_tools_update(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let (thread_id, call_id, payload) =
			crate::host_tools::parse_update_params(method, params.as_ref())?;
		let Some(pending) = self.pending_host_tool_calls.get(&call_id) else {
			return Err(AppServerError::not_found("host tool call not found"));
		};
		if pending.thread_id != thread_id {
			return Err(AppServerError::conflict(
				"host tool update threadId does not match pending call",
			));
		}
		pending.progress.lock().push(payload);
		Ok(serde_json::json!({}))
	}

	fn handle_host_uri_schemes_set(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let (thread_id, schemes) = crate::host_uris::parse_set_params(method, params.as_ref())?;
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		entry.value().host_uris.lock().replace(schemes.clone());
		serde_json::to_value(crate::host_uris::HostUriSchemesSetResult { schemes })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	fn handle_host_uris_result(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let (thread_id, request_id, result) =
			crate::host_uris::parse_result_params(method, params.as_ref())?;
		let Some((_, pending)) = self.pending_host_uri_requests.remove(&request_id) else {
			return Err(AppServerError::not_found("host URI request not found"));
		};
		if pending.thread_id != thread_id {
			self.pending_host_uri_requests.insert(request_id, pending);
			return Err(AppServerError::conflict(
				"host URI result threadId does not match pending request",
			));
		}
		pending
			.tx
			.send(result)
			.map_err(|_| AppServerError::conflict("host URI request receiver was dropped"))?;
		Ok(serde_json::json!({}))
	}

	fn handle_workflow_gate_list(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		let result = crate::workflow_gate::WorkflowGateListResult {
			gates: entry.value().workflow_gates.lock().list_pending(),
		};
		serde_json::to_value(result)
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	fn handle_workflow_gate_respond(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(
			method,
			params.as_ref(),
			&["threadId", "gate_id", "answer", "idempotency_key"],
		)?;
		let parsed: crate::workflow_gate::WorkflowGateRespondParams =
			serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
				.map_err(|err| AppServerError::invalid_params(err.to_string()))?;
		let thread_id = ThreadId(parsed.thread_id.clone());
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		let response = crate::workflow_gate::RpcWorkflowGateResponse {
			gate_id: parsed.gate_id,
			answer: parsed.answer,
			idempotency_key: parsed.idempotency_key,
		};
		let resolution = entry.value().workflow_gates.lock().resolve(response)?;
		serde_json::to_value(resolution)
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	fn handle_unattended_negotiate(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "declaration"])?;
		let params_value = params.unwrap_or(serde_json::Value::Null);
		let declaration = params_value.get("declaration").ok_or_else(|| {
			crate::unattended::negotiation_refusal(
				"invalid_unattended_declaration",
				"declaration is required",
			)
		})?;
		let budget = declaration.get("budget").ok_or_else(|| {
			crate::unattended::negotiation_refusal("incomplete_budget", "budget is required")
		})?;
		if let Some(budget_obj) = budget.as_object() {
			for key in budget_obj.keys() {
				if !matches!(
					key.as_str(),
					"max_tokens" | "max_tool_calls" | "max_wall_time_ms" | "max_cost_usd"
				) {
					return Err(crate::unattended::negotiation_refusal(
						"unsupported_budget_metric",
						format!("unsupported budget metric: {key}"),
					));
				}
			}
		}
		let parsed: crate::unattended::UnattendedNegotiateParams =
			serde_json::from_value(params_value).map_err(|err| {
				let message = err.to_string();
				let code = if message.contains("missing field `budget`")
					|| message.contains("missing field `max_")
				{
					"incomplete_budget"
				} else {
					"invalid_unattended_declaration"
				};
				crate::unattended::negotiation_refusal(code, message)
			})?;
		let thread_id = ThreadId(parsed.thread_id);
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		let accepted = entry
			.value()
			.unattended
			.lock()
			.negotiate(&thread_id, parsed.declaration)?;
		serde_json::to_value(accepted)
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	fn handle_unattended_audit(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		Ok(serde_json::json!({
			"events": entry.value().unattended.lock().audit(),
			"workflowGateEvents": entry.value().workflow_gates.lock().audit(),
		}))
	}

	async fn handle_gjc_state_read(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		// gjc/* is strict: reject unknown fields.
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "include"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let include = params
			.as_ref()
			.and_then(|p| p.get("include"))
			.cloned()
			.unwrap_or(serde_json::Value::Null);
		backend.get_state(&ctx, include).await
	}

	async fn handle_gjc_tools_list(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let state = backend
			.get_state(&ctx, serde_json::json!({ "tools": true }))
			.await?;
		let tools = state
			.get("tools")
			.and_then(|tools| tools.as_array())
			.into_iter()
			.flatten()
			.filter_map(|tool| {
				Some(crate::protocol::ToolDescriptor {
					name: tool.get("name")?.as_str()?.to_string(),
					active: tool
						.get("active")
						.and_then(|active| active.as_bool())
						.unwrap_or(false),
					description: tool
						.get("description")
						.and_then(|description| description.as_str())
						.map(str::to_string),
				})
			})
			.collect::<Vec<_>>();
		serde_json::to_value(crate::protocol::GjcToolsListResult { tools })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	async fn handle_gjc_commands_list(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "includeDisabled"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let include_disabled = params
			.as_ref()
			.and_then(|p| p.get("includeDisabled"))
			.and_then(|v| v.as_bool())
			.unwrap_or(false);
		let state = backend
			.get_state(
				&ctx,
				serde_json::json!({ "commands": true, "includeDisabled": include_disabled }),
			)
			.await?;
		let commands = state
			.get("commands")
			.and_then(|commands| commands.as_array())
			.into_iter()
			.flatten()
			.filter_map(|command| {
				Some(crate::protocol::CommandDescriptor {
					name: command.get("name")?.as_str()?.to_string(),
					source: command
						.get("source")
						.and_then(|source| source.as_str())
						.unwrap_or("unknown")
						.to_string(),
					description: command
						.get("description")
						.and_then(|description| description.as_str())
						.map(str::to_string),
					classification: command
						.get("classification")
						.and_then(|classification| classification.as_str())
						.map(str::to_string),
				})
			})
			.collect::<Vec<_>>();
		serde_json::to_value(crate::protocol::GjcCommandsListResult { commands })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	async fn handle_gjc_skills_list(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "includeDisabled"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let include_disabled = include_disabled_param(params.as_ref());
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let state = backend
			.get_state(
				&ctx,
				serde_json::json!({ "skills": true, "includeDisabled": include_disabled }),
			)
			.await?;
		let skills = state
			.get("skills")
			.and_then(|skills| skills.as_array())
			.into_iter()
			.flatten()
			.filter_map(|skill| {
				Some(crate::protocol::SkillDescriptor {
					name: skill.get("name")?.as_str()?.to_string(),
					source: skill
						.get("source")
						.and_then(|source| source.as_str())
						.unwrap_or("unknown")
						.to_string(),
					description: skill
						.get("description")
						.and_then(|description| description.as_str())
						.map(str::to_string),
					enabled: skill.get("enabled").and_then(|enabled| enabled.as_bool()),
				})
			})
			.collect::<Vec<_>>();
		serde_json::to_value(crate::protocol::GjcSkillsListResult { skills })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	async fn handle_gjc_extensions_list(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "includeDisabled"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let include_disabled = include_disabled_param(params.as_ref());
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let extensions = self
			.extension_descriptors(&*backend, &ctx, include_disabled)
			.await?;
		serde_json::to_value(crate::protocol::GjcExtensionsListResult { extensions })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	async fn handle_gjc_extensions_inspect(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "extensionId"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let extension_id = params
			.as_ref()
			.and_then(|p| p.get("extensionId"))
			.and_then(|v| v.as_str())
			.ok_or_else(|| AppServerError::invalid_params("missing extensionId"))?;
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let extension = self
			.extension_descriptors(&*backend, &ctx, true)
			.await?
			.into_iter()
			.find(|extension| extension.id == extension_id);
		serde_json::to_value(crate::protocol::GjcExtensionsInspectResult { extension })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	async fn extension_descriptors(
		&self,
		backend: &dyn AgentBackend,
		ctx: &BackendCallContext,
		include_disabled: bool,
	) -> Result<Vec<crate::protocol::ExtensionDescriptor>> {
		let state = backend
			.get_state(
				ctx,
				serde_json::json!({ "extensions": true, "includeDisabled": include_disabled }),
			)
			.await?;
		Ok(state
			.get("extensions")
			.and_then(|extensions| extensions.as_array())
			.into_iter()
			.flatten()
			.filter_map(|extension| {
				Some(crate::protocol::ExtensionDescriptor {
					id: extension.get("id")?.as_str()?.to_string(),
					name: extension
						.get("name")
						.and_then(|name| name.as_str())
						.unwrap_or_else(|| {
							extension
								.get("id")
								.and_then(|id| id.as_str())
								.unwrap_or("unknown")
						})
						.to_string(),
					kind: extension
						.get("kind")
						.and_then(|kind| kind.as_str())
						.unwrap_or("extension")
						.to_string(),
					source: extension
						.get("source")
						.and_then(|source| source.as_str())
						.unwrap_or("unknown")
						.to_string(),
					status: extension
						.get("status")
						.and_then(|status| status.as_str())
						.map(str::to_string),
				})
			})
			.collect::<Vec<_>>())
	}

	async fn handle_gjc_plugins_list(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "includeDisabled"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let include_disabled = include_disabled_param(params.as_ref());
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let plugins = self
			.plugin_inspections(&*backend, &ctx, include_disabled, true)
			.await?;
		let plugins = plugins
			.into_iter()
			.map(|inspection| inspection.plugin)
			.collect::<Vec<_>>();
		serde_json::to_value(crate::protocol::GjcPluginsListResult { plugins })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	async fn handle_gjc_plugins_inspect(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(
			method,
			params.as_ref(),
			&["threadId", "pluginId", "includeSettings"],
		)?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let plugin_id = params
			.as_ref()
			.and_then(|p| p.get("pluginId"))
			.and_then(|v| v.as_str())
			.ok_or_else(|| AppServerError::invalid_params("missing pluginId"))?;
		let include_settings = params
			.as_ref()
			.and_then(|p| p.get("includeSettings"))
			.and_then(|v| v.as_bool())
			.unwrap_or(true);
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		let plugin = self
			.plugin_inspections(&*backend, &ctx, true, include_settings)
			.await?
			.into_iter()
			.find(|inspection| inspection.plugin.id == plugin_id);
		serde_json::to_value(crate::protocol::GjcPluginsInspectResult { plugin })
			.map_err(|err| AppServerError::new(crate::error::codes::INTERNAL_ERROR, err.to_string()))
	}

	async fn plugin_inspections(
		&self,
		backend: &dyn AgentBackend,
		ctx: &BackendCallContext,
		include_disabled: bool,
		include_settings: bool,
	) -> Result<Vec<crate::protocol::PluginInspection>> {
		let state = backend
			.get_state(
				ctx,
				serde_json::json!({ "plugins": true, "includeDisabled": include_disabled, "includeSettings": include_settings }),
			)
			.await?;
		Ok(state
			.get("plugins")
			.and_then(|plugins| plugins.as_array())
			.into_iter()
			.flatten()
			.filter_map(|plugin| {
				let descriptor = crate::protocol::PluginDescriptor {
					id: plugin.get("id")?.as_str()?.to_string(),
					name: plugin
						.get("name")
						.and_then(|name| name.as_str())
						.unwrap_or_else(|| {
							plugin
								.get("id")
								.and_then(|id| id.as_str())
								.unwrap_or("unknown")
						})
						.to_string(),
					kind: plugin
						.get("kind")
						.and_then(|kind| kind.as_str())
						.unwrap_or("plugin")
						.to_string(),
					source: plugin
						.get("source")
						.and_then(|source| source.as_str())
						.unwrap_or("unknown")
						.to_string(),
					status: plugin
						.get("status")
						.and_then(|status| status.as_str())
						.map(str::to_string),
				};
				Some(crate::protocol::PluginInspection {
					plugin: descriptor,
					settings: include_settings
						.then(|| plugin.get("settings").cloned())
						.flatten(),
					manifest: plugin.get("manifest").cloned(),
				})
			})
			.collect::<Vec<_>>())
	}

	async fn handle_gjc_messages_get(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		// gjc/* is strict: reject unknown fields.
		crate::field_policy::enforce(method, params.as_ref(), &["threadId"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
		backend.get_messages(&ctx).await
	}

	async fn handle_gjc_model_set(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		// gjc/* is strict: reject unknown fields.
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "provider", "modelId"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let provider = extract_str(params.as_ref(), "provider")?;
		let model_id = extract_str(params.as_ref(), "modelId")?;
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
		backend.set_model(&ctx, &provider, &model_id).await
	}

	async fn handle_gjc_todos_set(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "phases"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let phases = params
			.as_ref()
			.and_then(|p| p.get("phases"))
			.cloned()
			.unwrap_or(serde_json::Value::Null);
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
		backend.set_todos(&ctx, phases).await?;
		Ok(serde_json::json!({}))
	}

	async fn handle_command_exec(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
		backend
			.exec(&ctx, params.unwrap_or(serde_json::Value::Null))
			.await
	}

	async fn handle_thread_shell_command(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		let command = params
			.as_ref()
			.and_then(|p| p.get("command"))
			.cloned()
			.unwrap_or(serde_json::Value::Null);
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
		backend.exec(&ctx, command).await
	}

	async fn handle_gjc_compact(
		&self,
		method: &str,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		crate::field_policy::enforce(method, params.as_ref(), &["threadId", "customInstructions"])?;
		let thread_id = extract_thread_id(params.as_ref())?;
		let custom = params
			.as_ref()
			.and_then(|p| p.get("customInstructions"))
			.and_then(|v| v.as_str());
		let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
		backend.compact(&ctx, custom).await
	}

	fn handle_initialize(&self, conn: &ConnectionId) -> Result<serde_json::Value> {
		// Lenient: unknown initialize fields are ignored. A second initialize
		// request on the same connection is rejected ("Already initialized").
		let entry = self.connections.get(conn).ok_or_else(|| {
			AppServerError::new(crate::error::codes::INVALID_REQUEST, "unknown connection")
		})?;
		{
			let mut state = entry.value().lock();
			if state.initialize_seen {
				return Err(AppServerError::new(
					crate::error::codes::INVALID_REQUEST,
					"Already initialized",
				));
			}
			state.initialize_seen = true;
		}
		Ok(serde_json::json!({
			 "userAgent": concat!("gjc-app-server/", env!("CARGO_PKG_VERSION")),
			 "platformOs": std::env::consts::OS,
			 "platformFamily": std::env::consts::FAMILY,
		}))
	}

	async fn handle_thread_start(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let (info, backend) = self
			.factory
			.create_thread(params.unwrap_or(serde_json::Value::Null))
			.await?;
		Ok(serde_json::json!({ "thread": self.register(info, backend) }))
	}

	async fn handle_thread_resume(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let params_value = params.unwrap_or(serde_json::Value::Null);
		let requested_thread_id = params_value
			.get("threadId")
			.and_then(|v| v.as_str())
			.map(|s| ThreadId(s.to_string()))
			.ok_or_else(|| AppServerError::invalid_params("missing threadId"))?;
		if let Some(entry) = self.threads.get(&requested_thread_id) {
			let generation = {
				let mut identity = entry.value().identity.lock();
				identity.reattach()
			};
			return Ok(serde_json::json!({
				"thread": self.thread_response(&requested_thread_id, generation),
				"resumed": true,
			}));
		}
		let (info, backend) = self.factory.resume_thread(params_value).await?;
		Ok(serde_json::json!({ "thread": self.register(info, backend), "resumed": false }))
	}

	async fn handle_thread_fork(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let (info, backend) = self
			.factory
			.fork_thread(params.unwrap_or(serde_json::Value::Null))
			.await?;
		Ok(serde_json::json!({ "thread": self.register(info, backend) }))
	}

	/// Register a freshly created/resumed/forked backend in the thread registry
	/// and return the `thread` object for the response.
	fn register(
		&self,
		info: crate::backend::BackendHandleInfo,
		backend: Arc<dyn AgentBackend>,
	) -> serde_json::Value {
		let identity = ThreadIdentity::new(info.thread_id.clone(), info.session_metadata.clone());
		let generation = identity.generation;
		let forked_from = identity
			.metadata
			.forked_from_id
			.as_ref()
			.map(|t| t.0.clone());
		let stream = ThreadStream::new(info.thread_id.clone());
		self.threads.insert(
			info.thread_id.clone(),
			ThreadEntry {
				identity: Mutex::new(identity),
				backend,
				admission: Mutex::new(Admission::new(
					self.config.max_inflight_turns_per_thread,
					self.config.max_queued_mutations_per_thread,
				)),
				stream: Mutex::new(stream),
				active_turn: Mutex::new(None),
				mutating_lane: Arc::new(tokio::sync::Mutex::new(())),
				host_tools: Mutex::new(HostToolRegistry::default()),
				workflow_gates: Mutex::new(crate::workflow_gate::WorkflowGateBroker::default()),
				unattended: Mutex::new(crate::unattended::UnattendedController::default()),
				host_uris: Mutex::new(crate::host_uris::HostUriRegistry::default()),
			},
		);
		let mut thread = serde_json::json!({
			"id": info.thread_id.0,
			"status": "idle",
			"generation": generation.0,
			"turns": [],
		});
		if let Some(from) = forked_from {
			thread["forkedFromId"] = serde_json::Value::String(from);
		}
		thread
	}

	fn thread_response(
		&self,
		thread_id: &ThreadId,
		generation: crate::ids::BackendGeneration,
	) -> serde_json::Value {
		let forked_from = self
			.threads
			.get(thread_id)
			.and_then(|entry| {
				entry
					.value()
					.identity
					.lock()
					.metadata
					.forked_from_id
					.clone()
			})
			.map(|t| t.0);
		let mut thread = serde_json::json!({
			"id": thread_id.0,
			"status": "idle",
			"generation": generation.0,
			"turns": [],
		});
		if let Some(from) = forked_from {
			thread["forkedFromId"] = serde_json::Value::String(from);
		}
		thread
	}

	async fn handle_thread_delete(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		let (backend, ctx) = {
			let entry = self
				.threads
				.get(&thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			let mut identity = entry.value().identity.lock();
			identity.status = ThreadStatus::Deleted;
			identity.reattach(); // bump generation so late events are stale
			let ctx = BackendCallContext {
				thread_id: thread_id.clone(),
				generation: identity.generation,
				request_id: None,
				lane: Lane::Cancel,
			};
			(Arc::clone(&entry.value().backend), ctx)
		};
		backend.dispose(&ctx).await?;
		self.cancel_host_tool_calls_for_thread(&thread_id);
		self.cancel_host_uri_requests_for_thread(&thread_id);
		self.threads.remove(&thread_id);
		Ok(serde_json::json!({}))
	}

	fn handle_thread_archive(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		let mut identity = entry.value().identity.lock();
		if identity.status == ThreadStatus::Running {
			return Err(AppServerError::conflict("cannot archive a thread with an active turn"));
		}
		identity.status = ThreadStatus::Archived;
		Ok(serde_json::json!({}))
	}

	fn handle_thread_read(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		let entry = self
			.threads
			.get(&thread_id)
			.ok_or_else(|| AppServerError::not_found("thread not found"))?;
		let identity = entry.value().identity.lock();
		Ok(serde_json::json!({
			 "thread": {
				  "id": identity.thread_id.0,
				  "status": match identity.status {
						ThreadStatus::Idle => "idle",
						ThreadStatus::Running => "running",
						ThreadStatus::Archived => "archived",
						ThreadStatus::Deleted => "deleted",
				  },
			 }
		}))
	}

	#[allow(
		clippy::unused_async,
		reason = "turn/start remains async because dispatch awaits all async request handlers \
		          uniformly"
	)]
	async fn handle_turn_start(
		self: &Arc<Self>,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		// Snapshot backend + context and admit a turn slot without holding the
		// registry lock across the backend call (enables concurrent turns).
		let (backend, ctx) = {
			let entry = self
				.threads
				.get(&thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			Self::check_expected_turn(entry.value(), params.as_ref())?;
			{
				let mut adm = entry.value().admission.lock();
				adm.try_admit_turn()?; // -32001 before any backend call on overload
			}
			let identity = entry.value().identity.lock();
			let ctx = BackendCallContext {
				thread_id: thread_id.clone(),
				generation: identity.generation,
				request_id: None,
				lane: Lane::Mutating,
			};
			(Arc::clone(&entry.value().backend), ctx)
		};

		// Accept the turn now: mint a Rust-owned turn id, record it as active,
		// seed the event mapper so `turn/started` reuses it, and set Running —
		// all BEFORE the long-running prompt so the response precedes streaming.
		let turn_id = TurnId::generate();
		let started = {
			let Some(entry) = self.threads.get(&thread_id) else {
				return Err(AppServerError::not_found("thread not found"));
			};
			*entry.value().active_turn.lock() = Some(turn_id.clone());
			entry.value().identity.lock().status = ThreadStatus::Running;
			entry.value().stream.lock().begin_turn(turn_id.clone())
		};
		for note in started {
			self.publish(note);
		}

		// Run the turn in the background; release the slot and reset thread
		// state when it ends. A prompt error is surfaced as a terminal failure
		// event so clients still see a `turn/completed{status:"failed"}`.
		let this = Arc::clone(self);
		let bg_ctx = ctx;
		let bg_turn = turn_id.clone();
		let bg_thread = thread_id.clone();
		tokio::spawn(async move {
			let result = backend
				.prompt(&bg_ctx, params.unwrap_or(serde_json::Value::Null))
				.await;
			let usage = backend.usage_snapshot(&bg_ctx).await.ok().flatten();
			let reconcile = if let Some(entry) = this.threads.get(&bg_thread) {
				entry.value().unattended.lock().reconcile(usage)
			} else {
				Ok(())
			};
			if let Err(err) = reconcile {
				this.abort_unattended_thread(&bg_thread, &err).await;
			}
			if let Err(err) = &result {
				this.emit_backend_event(&BackendEvent {
					thread_id: bg_thread.clone(),
					generation: bg_ctx.generation,
					event_type: "error".to_string(),
					payload: serde_json::json!({ "message": err.to_string() }),
				});
			}
			if let Some(entry) = this.threads.get(&bg_thread) {
				let remaining = {
					let mut adm = entry.value().admission.lock();
					adm.complete_turn();
					adm.inflight_turns()
				};
				{
					let mut active = entry.value().active_turn.lock();
					if active.as_ref() == Some(&bg_turn) {
						*active = None;
					}
				}
				if remaining == 0 {
					let mut identity = entry.value().identity.lock();
					if matches!(identity.status, ThreadStatus::Running) {
						identity.status = ThreadStatus::Idle;
					}
				}
			}
		});

		Ok(serde_json::json!({ "turn": { "id": turn_id.0, "status": "inProgress" } }))
	}

	async fn handle_turn_interrupt(
		&self,
		params: Option<serde_json::Value>,
	) -> Result<serde_json::Value> {
		let thread_id = extract_thread_id(params.as_ref())?;
		let turn_id = params
			.as_ref()
			.and_then(|p| p.get("turnId"))
			.and_then(|v| v.as_str())
			.map(|s| crate::ids::TurnId(s.to_string()))
			.ok_or_else(|| AppServerError::invalid_params("missing turnId"))?;
		let (backend, ctx) = {
			let entry = self
				.threads
				.get(&thread_id)
				.ok_or_else(|| AppServerError::not_found("thread not found"))?;
			let active = entry.value().active_turn.lock().clone();
			if active.as_ref() != Some(&turn_id) {
				return Err(AppServerError::conflict("turnId does not match active turn"));
			}
			let identity = entry.value().identity.lock();
			let ctx = BackendCallContext {
				thread_id: thread_id.clone(),
				generation: identity.generation,
				request_id: None,
				lane: Lane::Cancel,
			};
			(Arc::clone(&entry.value().backend), ctx)
		};
		self.cancel_host_tool_calls_for_turn(&thread_id, &turn_id);
		self.cancel_host_uri_requests_for_turn(&thread_id, &turn_id);
		backend.abort(&ctx, &turn_id).await?;
		Ok(serde_json::json!({}))
	}
}

fn extract_thread_id(params: Option<&serde_json::Value>) -> Result<ThreadId> {
	params
		.and_then(|p| p.get("threadId"))
		.and_then(|v| v.as_str())
		.map(|s| ThreadId(s.to_string()))
		.ok_or_else(|| AppServerError::invalid_params("missing threadId"))
}

fn include_disabled_param(params: Option<&serde_json::Value>) -> bool {
	params
		.and_then(|p| p.get("includeDisabled"))
		.and_then(|v| v.as_bool())
		.unwrap_or(true)
}

fn extract_url_scheme(url: &str) -> Result<String> {
	let Some((scheme, _)) = url.split_once("://") else {
		return Err(AppServerError::invalid_params("host URI url must include a scheme"));
	};
	if scheme.is_empty() {
		return Err(AppServerError::invalid_params("host URI url must include a scheme"));
	}
	Ok(scheme.to_ascii_lowercase())
}

/// Non-turn mutating methods that must run one-at-a-time on a thread's serial
/// mutating lane. `turn/start` is excluded (own turn admission + background
/// run); `turn/interrupt` is a cancel fast-lane; reads never serialize.
fn is_serialized_mutation(method: &str) -> bool {
	matches!(
		method,
		"command/exec"
			| "thread/shellCommand"
			| "gjc/compact"
			| "gjc/model/set"
			| "gjc/todos/set"
			| "turn/steer"
			| "gjc/hostUriSchemes/set"
			| "gjc/hostUris/result"
	)
}

fn extract_str(params: Option<&serde_json::Value>, key: &str) -> Result<String> {
	params
		.and_then(|p| p.get(key))
		.and_then(|v| v.as_str())
		.map(String::from)
		.ok_or_else(|| AppServerError::invalid_params(format!("missing `{key}`")))
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use async_trait::async_trait;

	use super::*;
	use crate::{backend::BackendHandleInfo, identity::SessionMetadata, ids::BackendGeneration};

	struct SlowBackend;

	#[async_trait]
	impl AgentBackend for SlowBackend {
		async fn prompt(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<TurnId> {
			tokio::time::sleep(Duration::from_millis(40)).await;
			Ok(TurnId::generate())
		}

		async fn steer(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<TurnId> {
			Ok(TurnId::generate())
		}

		async fn abort(&self, _c: &BackendCallContext, _t: &TurnId) -> Result<()> {
			Ok(())
		}

		async fn get_state(
			&self,
			_c: &BackendCallContext,
			i: serde_json::Value,
		) -> Result<serde_json::Value> {
			if i.get("tools").and_then(|v| v.as_bool()) == Some(true) {
				return Ok(serde_json::json!({
					"tools": [{ "name": "read", "active": true, "description": "Read files" }]
				}));
			}
			if i.get("commands").and_then(|v| v.as_bool()) == Some(true) {
				return Ok(serde_json::json!({
					"commands": [{ "name": "help", "source": "builtin", "description": "Show help", "classification": "builtin" }]
				}));
			}
			if i.get("skills").and_then(|v| v.as_bool()) == Some(true) {
				return Ok(serde_json::json!({
					"skills": [{ "name": "ralplan", "source": "builtin", "description": "Plan", "enabled": true }]
				}));
			}
			if i.get("extensions").and_then(|v| v.as_bool()) == Some(true) {
				return Ok(serde_json::json!({
					"extensions": [{ "id": "gemini", "name": "Gemini", "kind": "extension", "source": "project", "status": "available" }]
				}));
			}
			if i.get("plugins").and_then(|v| v.as_bool()) == Some(true) {
				return Ok(serde_json::json!({
					"plugins": [{ "id": "pkg", "name": "Pkg", "kind": "plugin", "source": "/tmp/pkg", "status": "enabled", "settings": { "apiKey": "********", "region": "us" }, "manifest": { "settings": { "apiKey": { "secret": true }, "region": { "secret": false } } } }]
				}));
			}
			Ok(serde_json::json!({}))
		}

		async fn get_messages(&self, _c: &BackendCallContext) -> Result<serde_json::Value> {
			Ok(serde_json::json!([]))
		}

		async fn set_model(
			&self,
			_c: &BackendCallContext,
			_p: &str,
			_m: &str,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn compact(
			&self,
			_c: &BackendCallContext,
			_ci: Option<&str>,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn set_todos(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<()> {
			Ok(())
		}

		async fn exec(
			&self,
			c: &BackendCallContext,
			p: serde_json::Value,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({ "lane": format!("{:?}", c.lane), "params": p }))
		}

		async fn dispose(&self, _c: &BackendCallContext) -> Result<()> {
			Ok(())
		}
	}

	struct SlowFactory;

	#[async_trait]
	impl BackendFactory for SlowFactory {
		async fn create_thread(
			&self,
			_p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			let info = BackendHandleInfo {
				thread_id: ThreadId::generate(),
				generation: BackendGeneration::FIRST,
				session_metadata: SessionMetadata::default(),
			};
			Ok((info, Arc::new(SlowBackend)))
		}

		async fn resume_thread(
			&self,
			p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			self.create_thread(p).await
		}

		async fn fork_thread(
			&self,
			p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			self.create_thread(p).await
		}
	}

	/// Backend that records the maximum observed concurrency inside `exec` so a
	/// test can prove same-thread mutations are serialized on the mutating lane.
	#[derive(Default)]
	struct GaugeBackend {
		inflight: std::sync::atomic::AtomicUsize,
		max_inflight: std::sync::atomic::AtomicUsize,
	}
	#[async_trait]
	impl AgentBackend for GaugeBackend {
		async fn prompt(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<TurnId> {
			Ok(TurnId::generate())
		}

		async fn steer(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<TurnId> {
			Ok(TurnId::generate())
		}

		async fn abort(&self, _c: &BackendCallContext, _t: &TurnId) -> Result<()> {
			Ok(())
		}

		async fn get_state(
			&self,
			_c: &BackendCallContext,
			_i: serde_json::Value,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn get_messages(&self, _c: &BackendCallContext) -> Result<serde_json::Value> {
			Ok(serde_json::json!([]))
		}

		async fn set_model(
			&self,
			_c: &BackendCallContext,
			_p: &str,
			_m: &str,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn compact(
			&self,
			_c: &BackendCallContext,
			_ci: Option<&str>,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn set_todos(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<()> {
			Ok(())
		}

		async fn exec(
			&self,
			_c: &BackendCallContext,
			_p: serde_json::Value,
		) -> Result<serde_json::Value> {
			use std::sync::atomic::Ordering;
			let now = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
			self.max_inflight.fetch_max(now, Ordering::SeqCst);
			tokio::time::sleep(Duration::from_millis(30)).await;
			self.inflight.fetch_sub(1, Ordering::SeqCst);
			Ok(serde_json::json!({ "ok": true }))
		}

		async fn dispose(&self, _c: &BackendCallContext) -> Result<()> {
			Ok(())
		}
	}

	struct GaugeFactory(Arc<GaugeBackend>);
	#[async_trait]
	impl BackendFactory for GaugeFactory {
		async fn create_thread(
			&self,
			_p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			let info = BackendHandleInfo {
				thread_id: ThreadId::generate(),
				generation: BackendGeneration::FIRST,
				session_metadata: SessionMetadata::default(),
			};
			Ok((info, self.0.clone()))
		}

		async fn resume_thread(
			&self,
			p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			self.create_thread(p).await
		}

		async fn fork_thread(
			&self,
			p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			self.create_thread(p).await
		}
	}

	#[derive(Default)]
	struct CollectingSink {
		notes: Mutex<Vec<Notification>>,
	}
	impl EventSink for CollectingSink {
		fn emit(&self, note: Notification) {
			self.notes.lock().push(note);
		}
	}

	fn server() -> Arc<AppServer> {
		Arc::new(AppServer::new(
			Arc::new(SlowFactory),
			AppServerConfig::default(),
			Arc::new(CollectingSink::default()),
		))
	}

	fn server_with_sink() -> (Arc<AppServer>, Arc<CollectingSink>) {
		let sink = Arc::new(CollectingSink::default());
		let s =
			Arc::new(AppServer::new(Arc::new(SlowFactory), AppServerConfig::default(), sink.clone()));
		(s, sink)
	}

	async fn init_conn(s: &Arc<AppServer>) -> ConnectionId {
		let conn = s.open_connection();
		let init = crate::jsonrpc::parse_inbound(
			r#"{"id":0,"method":"initialize","params":{"unknownField":1}}"#,
		)
		.unwrap();
		let resp = s.dispatch(&conn, init).await.unwrap();
		assert!(resp.error.is_none(), "initialize should ignore unknown fields");
		let acked = crate::jsonrpc::parse_inbound(r#"{"method":"initialized"}"#).unwrap();
		assert!(s.dispatch(&conn, acked).await.is_none());
		conn
	}

	async fn start_thread(s: &Arc<AppServer>, conn: &ConnectionId) -> ThreadId {
		let req =
			crate::jsonrpc::parse_inbound(r#"{"id":1,"method":"thread/start","params":{"cwd":"/p"}}"#)
				.unwrap();
		let resp = s.dispatch(conn, req).await.unwrap();
		let v = resp.result.unwrap();
		ThreadId(v["thread"]["id"].as_str().unwrap().to_string())
	}

	#[tokio::test]
	async fn rejects_requests_before_initialize() {
		let s = server();
		let conn = s.open_connection();
		let req = crate::jsonrpc::parse_inbound(r#"{"id":1,"method":"thread/start"}"#).unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, crate::error::codes::NOT_INITIALIZED);
	}

	#[tokio::test]
	async fn unknown_method_is_method_not_found() {
		let s = server();
		let conn = init_conn(&s).await;
		let req = crate::jsonrpc::parse_inbound(r#"{"id":9,"method":"no/such"}"#).unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, crate::error::codes::METHOD_NOT_FOUND);
	}

	#[tokio::test]
	async fn two_simultaneous_running_turns_in_two_threads() {
		// Phase 0A conformance fixture: two threads run turns concurrently in
		// one process and both complete; total wall time proves overlap.
		let s = server();
		let conn = init_conn(&s).await;
		let t_a = start_thread(&s, &conn).await;
		let t_b = start_thread(&s, &conn).await;
		assert_ne!(t_a, t_b);

		let sa = Arc::clone(&s);
		let sb = Arc::clone(&s);
		let ca = conn.clone();
		let cb = conn.clone();
		let ta = t_a.0.clone();
		let tb = t_b.0.clone();

		let start = std::time::Instant::now();
		let (ra, rb) = tokio::join!(
			async move {
				let req = crate::jsonrpc::parse_inbound(&format!(
					r#"{{"id":10,"method":"turn/start","params":{{"threadId":"{ta}","input":"a"}}}}"#
				))
				.unwrap();
				sa.dispatch(&ca, req).await.unwrap()
			},
			async move {
				let req = crate::jsonrpc::parse_inbound(&format!(
					r#"{{"id":11,"method":"turn/start","params":{{"threadId":"{tb}","input":"b"}}}}"#
				))
				.unwrap();
				sb.dispatch(&cb, req).await.unwrap()
			},
		);
		let elapsed = start.elapsed();

		assert!(ra.error.is_none() && rb.error.is_none(), "both turns succeed");
		// Each backend prompt sleeps 40ms; if serialized total would be ~80ms.
		// Concurrent execution completes well under the serialized sum.
		assert!(elapsed < Duration::from_millis(75), "turns must overlap, took {elapsed:?}");
	}

	#[tokio::test]
	async fn turn_start_ignores_unknown_codex_fields() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":20,"method":"turn/start","params":{{"threadId":"{}","input":"x","environments":[],"selectedCapabilityRoots":[]}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none(), "codex-core unknown fields are ignored");
	}

	#[tokio::test]
	async fn backend_events_flow_through_stream_to_sink() {
		let (s, sink) = server_with_sink();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let ev = |kind: &str| BackendEvent {
			thread_id: t.clone(),
			generation: BackendGeneration::FIRST,
			event_type: kind.into(),
			payload: serde_json::json!({}),
		};
		assert!(s.emit_backend_event(&ev("agent_start")) >= 1);
		assert!(s.emit_backend_event(&ev("agent_end")) >= 1);
		let methods: Vec<String> = sink.notes.lock().iter().map(|n| n.method.clone()).collect();
		assert!(methods.contains(&"turn/started".to_string()));
		assert!(methods.contains(&"turn/completed".to_string()));
	}

	#[tokio::test]
	async fn stale_generation_events_are_rejected() {
		let (s, sink) = server_with_sink();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		// Generation 2 has never been attached; event must be rejected.
		let stale = BackendEvent {
			thread_id: t,
			generation: BackendGeneration(2),
			event_type: "agent_start".into(),
			payload: serde_json::json!({}),
		};
		assert_eq!(s.emit_backend_event(&stale), 0, "stale-generation event rejected");
		assert!(sink.notes.lock().is_empty());
	}

	#[tokio::test]
	async fn events_for_unknown_thread_are_dropped() {
		let (s, sink) = server_with_sink();
		let _conn = init_conn(&s).await;
		let ev = BackendEvent {
			thread_id: ThreadId("thr_missing".into()),
			generation: BackendGeneration::FIRST,
			event_type: "agent_start".into(),
			payload: serde_json::json!({}),
		};
		assert_eq!(s.emit_backend_event(&ev), 0);
		assert!(sink.notes.lock().is_empty());
	}

	#[tokio::test]
	async fn gjc_state_read_routes_to_backend() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":30,"method":"gjc/state/read","params":{{"threadId":"{}"}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
	}
	#[tokio::test]
	async fn gjc_state_read_rejects_unknown_fields_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":33,"method":"gjc/state/read","params":{{"threadId":"{}","bogus":1}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let err = resp.error.expect("gjc/* strict: unknown field rejected");
		assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
		assert!(err.message.contains("bogus"));
	}

	#[tokio::test]
	async fn gjc_state_read_accepts_include_field() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":34,"method":"gjc/state/read","params":{{"threadId":"{}","include":["model"]}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
	}

	#[tokio::test]
	async fn gjc_tools_list_rejects_unknown_fields_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":36,"method":"gjc/tools/list","params":{{"threadId":"{}","bogus":1}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let err = resp.error.expect("gjc/* strict: unknown field rejected");
		assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
		assert!(err.message.contains("bogus"));
	}

	#[tokio::test]
	async fn gjc_tools_list_accepts_thread_id_and_shapes_result() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":37,"method":"gjc/tools/list","params":{{"threadId":"{}"}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
		assert_eq!(
			resp.result.unwrap(),
			serde_json::json!({ "tools": [{ "name": "read", "active": true, "description": "Read files" }] })
		);
	}

	#[tokio::test]
	async fn gjc_commands_list_rejects_unknown_fields_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":38,"method":"gjc/commands/list","params":{{"threadId":"{}","bogus":1}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let err = resp.error.expect("gjc/* strict: unknown field rejected");
		assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
		assert!(err.message.contains("bogus"));
	}

	#[tokio::test]
	async fn gjc_commands_list_accepts_allowed_fields_and_shapes_result() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":39,"method":"gjc/commands/list","params":{{"threadId":"{}","includeDisabled":true}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
		assert_eq!(
			resp.result.unwrap(),
			serde_json::json!({ "commands": [{ "name": "help", "source": "builtin", "description": "Show help", "classification": "builtin" }] })
		);
	}

	#[tokio::test]
	async fn gjc_reachable_catalogs_reject_unknown_fields_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		for (id, method, extra) in [
			(40, "gjc/skills/list", r""),
			(41, "gjc/extensions/list", r""),
			(42, "gjc/extensions/inspect", r#", "extensionId":"gemini""#),
			(43, "gjc/plugins/list", r""),
			(44, "gjc/plugins/inspect", r#", "pluginId":"pkg""#),
		] {
			let req = crate::jsonrpc::parse_inbound(&format!(
				r#"{{"id":{id},"method":"{method}","params":{{"threadId":"{}"{extra},"bogus":1}}}}"#,
				t.0
			))
			.unwrap();
			let resp = s.dispatch(&conn, req).await.unwrap();
			let err = resp.error.expect("gjc/* strict: unknown field rejected");
			assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
			assert!(err.message.contains("bogus"));
		}
	}

	#[tokio::test]
	async fn gjc_catalog_lists_accept_include_disabled_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		for (id, method) in
			[(140, "gjc/skills/list"), (141, "gjc/extensions/list"), (142, "gjc/plugins/list")]
		{
			let req = crate::jsonrpc::parse_inbound(&format!(
				r#"{{"id":{id},"method":"{method}","params":{{"threadId":"{}","includeDisabled":false}}}}"#,
				t.0
			))
			.unwrap();
			let resp = s.dispatch(&conn, req).await.unwrap();
			assert!(resp.error.is_none(), "{method} should allow includeDisabled");
		}
	}

	#[tokio::test]
	async fn gjc_reachable_catalogs_shape_results() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		for (id, method, params, expected) in [
			(
				45,
				"gjc/skills/list",
				format!(r#"{{"threadId":"{}"}}"#, t.0),
				serde_json::json!({ "skills": [{ "name": "ralplan", "source": "builtin", "description": "Plan", "enabled": true }] }),
			),
			(
				46,
				"gjc/extensions/list",
				format!(r#"{{"threadId":"{}"}}"#, t.0),
				serde_json::json!({ "extensions": [{ "id": "gemini", "name": "Gemini", "kind": "extension", "source": "project", "status": "available" }] }),
			),
			(
				47,
				"gjc/extensions/inspect",
				format!(r#"{{"threadId":"{}","extensionId":"gemini"}}"#, t.0),
				serde_json::json!({ "extension": { "id": "gemini", "name": "Gemini", "kind": "extension", "source": "project", "status": "available" } }),
			),
			(
				48,
				"gjc/plugins/list",
				format!(r#"{{"threadId":"{}"}}"#, t.0),
				serde_json::json!({ "plugins": [{ "id": "pkg", "name": "Pkg", "kind": "plugin", "source": "/tmp/pkg", "status": "enabled" }] }),
			),
			(
				49,
				"gjc/plugins/inspect",
				format!(r#"{{"threadId":"{}","pluginId":"pkg"}}"#, t.0),
				serde_json::json!({ "plugin": { "plugin": { "id": "pkg", "name": "Pkg", "kind": "plugin", "source": "/tmp/pkg", "status": "enabled" }, "settings": { "apiKey": "********", "region": "us" }, "manifest": { "settings": { "apiKey": { "secret": true }, "region": { "secret": false } } } } }),
			),
		] {
			let req = crate::jsonrpc::parse_inbound(&format!(
				r#"{{"id":{id},"method":"{method}","params":{params}}}"#
			))
			.unwrap();
			let resp = s.dispatch(&conn, req).await.unwrap();
			assert!(resp.error.is_none());
			assert_eq!(resp.result.unwrap(), expected);
		}
	}

	#[tokio::test]
	async fn gjc_plugins_inspect_returns_masked_settings_without_raw_secret() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":143,"method":"gjc/plugins/inspect","params":{{"threadId":"{}","pluginId":"pkg"}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let result = resp.result.unwrap();
		assert_eq!(result["plugin"]["settings"]["apiKey"], "********");
		assert_eq!(result["plugin"]["settings"]["region"], "us");
		assert!(!result.to_string().contains("raw-secret"));
	}

	#[tokio::test]
	async fn gjc_plugins_inspect_accepts_include_settings_and_stays_strict() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;

		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":144,"method":"gjc/plugins/inspect","params":{{"threadId":"{}","pluginId":"pkg","includeSettings":true}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none(), "includeSettings should be an allowed strict field");
		let result = resp.result.unwrap();
		assert_eq!(result["plugin"]["settings"]["apiKey"], "********");
		assert_eq!(result["plugin"]["settings"]["region"], "us");
		assert!(!result.to_string().contains("raw-secret"));

		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":145,"method":"gjc/plugins/inspect","params":{{"threadId":"{}","pluginId":"pkg","includeSettings":false}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none(), "includeSettings=false should be an allowed strict field");
		let result = resp.result.unwrap();
		assert!(result["plugin"].get("settings").is_none());
		assert!(result["plugin"].get("manifest").is_some());

		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":146,"method":"gjc/plugins/inspect","params":{{"threadId":"{}","pluginId":"pkg","includeSettings":true,"bogus":1}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let err = resp
			.error
			.expect("truly unknown field should still be rejected");
		assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
		assert!(err.message.contains("bogus"));
	}

	#[tokio::test]
	async fn gjc_messages_get_rejects_unknown_fields_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":35,"method":"gjc/messages/get","params":{{"threadId":"{}","bogus":1}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let err = resp.error.expect("gjc/* strict: unknown field rejected");
		assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
		assert!(err.message.contains("bogus"));
	}

	#[tokio::test]
	async fn gjc_messages_get_accepts_thread_id_only() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":36,"method":"gjc/messages/get","params":{{"threadId":"{}"}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
	}

	#[tokio::test]
	async fn gjc_notifications_methods_are_exempt_from_field_policy() {
		// Documented exception: gjc/notifications/* frames are opaque JSON owned
		// by the TS notifications extension (see field_policy::policy_for docs).
		// Unknown fields must pass through to the NotificationHost untouched.
		let s = server();
		let conn = init_conn(&s).await;
		let req = crate::jsonrpc::parse_inbound(
			r#"{"id":37,"method":"gjc/notifications/subscribe","params":{"anyOpaqueField":1,"another":{"nested":true}}}"#,
		)
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		// The Noop host reports method_not_found; what matters is that the
		// opaque frame was NOT rejected by field policy (-32602 invalid params).
		let err = resp.error.expect("noop host reports method_not_found");
		assert_ne!(
			err.code,
			crate::error::codes::INVALID_PARAMS,
			"notifications channel must not field-police opaque frames"
		);
	}

	#[tokio::test]
	async fn gjc_model_set_rejects_unknown_fields_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":31,"method":"gjc/model/set","params":{{"threadId":"{}","provider":"anthropic","modelId":"claude","bogus":1}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let err = resp.error.expect("gjc/* strict: unknown field rejected");
		assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
		assert!(err.message.contains("bogus"));
	}

	#[tokio::test]
	async fn gjc_model_set_accepts_known_fields() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":32,"method":"gjc/model/set","params":{{"threadId":"{}","provider":"anthropic","modelId":"claude"}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
	}

	#[tokio::test]
	async fn command_exec_routes_to_backend_and_returns_result() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":45,"method":"command/exec","params":{{"threadId":"{}","command":["echo","hi"],"bogus":1}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let result = resp.result.expect("command/exec should succeed");
		assert_eq!(result["lane"], "Mutating");
		assert_eq!(result["params"]["command"], serde_json::json!(["echo", "hi"]));
		assert_eq!(result["params"]["bogus"], 1);
	}

	#[tokio::test]
	async fn thread_shell_command_routes_command_to_backend_exec() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":46,"method":"thread/shellCommand","params":{{"threadId":"{}","command":"echo hi","bogus":1}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let result = resp.result.expect("thread/shellCommand should succeed");
		assert_eq!(result["lane"], "Mutating");
		assert_eq!(result["params"], "echo hi");
	}

	#[tokio::test]
	async fn gjc_todos_set_rejects_unknown_fields_strictly() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":47,"method":"gjc/todos/set","params":{{"threadId":"{}","phases":[],"bogus":1}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		let err = resp.error.expect("gjc/* strict: unknown field rejected");
		assert_eq!(err.code, crate::error::codes::INVALID_PARAMS);
		assert!(err.message.contains("bogus"));
	}

	#[tokio::test]
	async fn gjc_todos_set_accepts_known_fields() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":48,"method":"gjc/todos/set","params":{{"threadId":"{}","phases":[{{"title":"phase"}}]}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
		assert_eq!(resp.result.unwrap(), serde_json::json!({}));
	}

	#[tokio::test]
	async fn turn_steer_routes_to_backend() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":33,"method":"turn/steer","params":{{"threadId":"{}","input":"more"}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
		assert!(
			resp.result.unwrap()["turnId"]
				.as_str()
				.unwrap()
				.starts_with("turn_")
		);
	}

	#[tokio::test]
	async fn turn_start_records_active_turn_and_running_status() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":34,"method":"turn/start","params":{{"threadId":"{}","input":"x"}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert!(resp.error.is_none());
		let turn_id = resp.result.unwrap()["turn"]["id"]
			.as_str()
			.unwrap()
			.to_string();
		let entry = s.threads.get(&t).unwrap();
		assert_eq!(*entry.value().active_turn.lock(), Some(TurnId(turn_id)));
		assert_eq!(entry.value().identity.lock().status, ThreadStatus::Running);
	}

	#[tokio::test]
	async fn turn_start_rejects_mismatched_expected_turn_id() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let req = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":35,"method":"turn/start","params":{{"threadId":"{}","input":"x","expectedTurnId":"turn_wrong"}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, crate::error::codes::CONFLICT);
	}

	#[tokio::test]
	async fn turn_steer_rejects_mismatched_expected_turn_id() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let start = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":36,"method":"turn/start","params":{{"threadId":"{}","input":"x"}}}}"#,
			t.0
		))
		.unwrap();
		assert!(s.dispatch(&conn, start).await.unwrap().error.is_none());
		let steer = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":37,"method":"turn/steer","params":{{"threadId":"{}","input":"more","expectedTurnId":"turn_wrong"}}}}"#,
            t.0
        ))
        .unwrap();
		let resp = s.dispatch(&conn, steer).await.unwrap();
		assert_eq!(resp.error.unwrap().code, crate::error::codes::CONFLICT);
	}

	#[tokio::test]
	async fn turn_steer_accepts_matching_expected_turn_id() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let start = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":38,"method":"turn/start","params":{{"threadId":"{}","input":"x"}}}}"#,
			t.0
		))
		.unwrap();
		let start_resp = s.dispatch(&conn, start).await.unwrap();
		let turn_id = start_resp.result.unwrap()["turn"]["id"]
			.as_str()
			.unwrap()
			.to_string();
		let steer = crate::jsonrpc::parse_inbound(&format!(
            r#"{{"id":39,"method":"turn/steer","params":{{"threadId":"{}","input":"more","expectedTurnId":"{}"}}}}"#,
            t.0, turn_id
        ))
        .unwrap();
		let resp = s.dispatch(&conn, steer).await.unwrap();
		assert!(resp.error.is_none());
	}

	#[tokio::test]
	async fn thread_delete_removes_thread_and_rejects_later_reads() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let del = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":40,"method":"thread/delete","params":{{"threadId":"{}"}}}}"#,
			t.0
		))
		.unwrap();
		assert!(s.dispatch(&conn, del).await.unwrap().error.is_none());
		let read = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":41,"method":"thread/read","params":{{"threadId":"{}"}}}}"#,
			t.0
		))
		.unwrap();
		assert_eq!(
			s.dispatch(&conn, read).await.unwrap().error.unwrap().code,
			crate::error::codes::NOT_FOUND
		);
	}

	#[tokio::test]
	async fn thread_archive_sets_archived_status() {
		let s = server();
		let conn = init_conn(&s).await;
		let t = start_thread(&s, &conn).await;
		let arch = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":42,"method":"thread/archive","params":{{"threadId":"{}"}}}}"#,
			t.0
		))
		.unwrap();
		assert!(s.dispatch(&conn, arch).await.unwrap().error.is_none());
		let read = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":43,"method":"thread/read","params":{{"threadId":"{}"}}}}"#,
			t.0
		))
		.unwrap();
		let resp = s.dispatch(&conn, read).await.unwrap();
		assert_eq!(resp.result.unwrap()["thread"]["status"], "archived");
	}

	#[tokio::test]
	async fn thread_resume_and_fork_register_new_threads() {
		let s = server();
		let conn = init_conn(&s).await;
		for method in ["thread/resume", "thread/fork"] {
			let req = crate::jsonrpc::parse_inbound(&format!(
				r#"{{"id":44,"method":"{method}","params":{{"threadId":"x"}}}}"#
			))
			.unwrap();
			let resp = s.dispatch(&conn, req).await.unwrap();
			assert!(resp.error.is_none(), "{method} should register a thread");
			assert!(
				resp.result.unwrap()["thread"]["id"]
					.as_str()
					.unwrap()
					.starts_with("thr_")
			);
		}
	}

	#[tokio::test]
	async fn same_thread_mutations_serialize_on_the_mutating_lane() {
		let gauge = Arc::new(GaugeBackend::default());
		let s = Arc::new(AppServer::new(
			Arc::new(GaugeFactory(gauge.clone())),
			AppServerConfig::default(),
			Arc::new(CollectingSink::default()),
		));
		let conn = init_conn(&s).await;
		let thread = start_thread(&s, &conn).await;

		// Fire two command/exec on the same thread concurrently.
		let frame = format!(
			r#"{{"id":7,"method":"command/exec","params":{{"threadId":"{}","command":"echo hi"}}}}"#,
			thread.0
		);
		let (fa, fb) = (frame.clone(), frame);
		let (sa, sb) = (Arc::clone(&s), Arc::clone(&s));
		let (ca, cb) = (conn.clone(), conn.clone());
		let h1 = tokio::spawn(async move {
			sa.dispatch(&ca, crate::jsonrpc::parse_inbound(&fa).unwrap())
				.await
		});
		let h2 = tokio::spawn(async move {
			sb.dispatch(&cb, crate::jsonrpc::parse_inbound(&fb).unwrap())
				.await
		});
		let (r1, r2) = (h1.await.unwrap(), h2.await.unwrap());
		assert!(r1.unwrap().error.is_none());
		assert!(r2.unwrap().error.is_none());

		// The mutating lane must have serialized them: never two in exec at once.
		assert_eq!(gauge.max_inflight.load(std::sync::atomic::Ordering::SeqCst), 1);
	}
	#[tokio::test]
	async fn host_uri_preflight_denies_before_emitting_requests() {
		let (s, sink) = server_with_sink();
		let conn = init_conn(&s).await;
		let thread = start_thread(&s, &conn).await;
		let set = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":70,"method":"gjc/hostUriSchemes/set","params":{{"threadId":"{}","schemes":[{{"scheme":"db","writable":true}}]}}}}"#,
			thread.0
		))
		.unwrap();
		assert!(s.dispatch(&conn, set).await.unwrap().error.is_none());
		let negotiate = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":71,"method":"gjc/unattended/negotiate","params":{{"threadId":"{}","declaration":{{"actor":"model","budget":{{"max_tokens":100,"max_tool_calls":10,"max_wall_time_ms":10000,"max_cost_usd":1.0}},"scopes":["command.host_uri"],"action_allowlist":["command.host_uri"]}}}}}}"#,
			thread.0
		))
		.unwrap();
		assert!(s.dispatch(&conn, negotiate).await.unwrap().error.is_none());

		let read = s
			.read_host_uri(&thread, &TurnId("turn_read".into()), "db://row/1")
			.await;
		let write = s
			.write_host_uri(&thread, &TurnId("turn_write".into()), "db://row/1", "body".into())
			.await;
		assert_eq!(read.unwrap_err().message, "action_denied");
		assert_eq!(write.unwrap_err().message, "action_denied");
		assert!(
			!sink
				.notes
				.lock()
				.iter()
				.any(|note| note.method == "gjc/hostUris/request")
		);
	}

	#[tokio::test]
	async fn unattended_abort_cancels_pending_host_calls_uris_and_gates() {
		let (s, sink) = server_with_sink();
		let conn = init_conn(&s).await;
		let thread = start_thread(&s, &conn).await;
		let turn = TurnId("turn_pending".into());
		let set_tool = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":80,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"lookup","inputSchema":{{"type":"object"}}}}]}}}}"#,
			thread.0
		))
		.unwrap();
		assert!(s.dispatch(&conn, set_tool).await.unwrap().error.is_none());
		let set_uri = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":81,"method":"gjc/hostUriSchemes/set","params":{{"threadId":"{}","schemes":[{{"scheme":"db","writable":true}}]}}}}"#,
			thread.0
		))
		.unwrap();
		assert!(s.dispatch(&conn, set_uri).await.unwrap().error.is_none());

		let tool_task = {
			let s = Arc::clone(&s);
			let thread = thread.clone();
			let turn = turn.clone();
			tokio::spawn(async move {
				s.call_host_tool(&thread, &turn, "lookup", serde_json::json!({}))
					.await
			})
		};
		let uri_task = {
			let s = Arc::clone(&s);
			let thread = thread.clone();
			let turn = turn.clone();
			tokio::spawn(async move { s.read_host_uri(&thread, &turn, "db://row/1").await })
		};
		let gate_task = {
			let s = Arc::clone(&s);
			let thread = thread.clone();
			tokio::spawn(async move {
				s.open_workflow_gate(
					&thread,
					crate::workflow_gate::OpenWorkflowGateInput {
						stage: crate::workflow_gate::RpcWorkflowStage::Ultragoal,
						kind: crate::workflow_gate::RpcWorkflowGateKind::Approval,
						schema: serde_json::json!({"type":"object"}),
						options: None,
						context: crate::workflow_gate::RpcWorkflowGateContext::default(),
					},
				)
				.await
			})
		};
		tokio::time::sleep(Duration::from_millis(10)).await;
		let gate_id = s
			.threads
			.get(&thread)
			.unwrap()
			.value()
			.workflow_gates
			.lock()
			.list_pending()
			.first()
			.unwrap()
			.gate_id
			.clone();
		let err = AppServerError::new(crate::error::codes::INVALID_REQUEST, "budget_exceeded")
			.with_data(serde_json::json!({"code":"budget_exceeded","run_id":"run_abort"}));
		s.abort_unattended_thread(&thread, &err).await;

		assert!(
			tool_task
				.await
				.unwrap()
				.unwrap_err()
				.message
				.contains("cancelled")
		);
		assert!(
			uri_task
				.await
				.unwrap()
				.unwrap_err()
				.message
				.contains("cancelled")
		);
		assert!(
			gate_task
				.await
				.unwrap()
				.unwrap_err()
				.message
				.contains("cancelled")
		);
		let list = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":82,"method":"gjc/workflowGate/list","params":{{"threadId":"{}"}}}}"#,
			thread.0
		))
		.unwrap();
		let list_resp = s.dispatch(&conn, list).await.unwrap().result.unwrap();
		assert_eq!(list_resp["gates"].as_array().unwrap().len(), 0);

		let respond = crate::jsonrpc::parse_inbound(&format!(
			r#"{{"id":83,"method":"gjc/workflowGate/respond","params":{{"threadId":"{}","gate_id":"{}","answer":{{}},"idempotency_key":"after-abort"}}}}"#,
			thread.0, gate_id
		))
		.unwrap();
		assert!(s.dispatch(&conn, respond).await.unwrap().error.is_some());
		let methods: Vec<String> = sink
			.notes
			.lock()
			.iter()
			.map(|note| note.method.clone())
			.collect();
		assert!(methods.contains(&"gjc/hostTools/cancel".to_string()));
		assert!(methods.contains(&"gjc/hostUris/cancel".to_string()));
	}
}
