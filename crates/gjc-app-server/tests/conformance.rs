//! app-server-conformance suite (integration).
//!
//! Exercises the public core end-to-end through the JSON-RPC surface: the
//! initialize handshake, thread lifecycle, a full streamed turn mapped from
//! backend events, concurrent two-thread streaming, stale-event rejection, and
//! gjc/* strict field rejection. This is the named acceptance suite referenced
//! by the plan; it grows as protocol surface is added.

use std::sync::Arc;

use async_trait::async_trait;
use gjc_app_server::{
	backend::{AgentBackend, BackendCallContext, BackendEvent, BackendFactory, BackendHandleInfo},
	identity::SessionMetadata,
	ids::{BackendGeneration, ThreadId, TurnId},
	jsonrpc::{Notification, parse_inbound},
	server::{AppServer, AppServerConfig, EventSink},
};
use parking_lot::Mutex;

// ---- test doubles -----------------------------------------------------------

struct EchoBackend;

#[async_trait]
impl AgentBackend for EchoBackend {
	async fn prompt(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<TurnId> {
		Ok(TurnId::generate())
	}

	async fn steer(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<TurnId> {
		Ok(TurnId::generate())
	}

	async fn abort(&self, _c: &BackendCallContext, _t: &TurnId) -> gjc_app_server::Result<()> {
		Ok(())
	}

	async fn get_state(
		&self,
		_c: &BackendCallContext,
		_i: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({ "status": "idle" }))
	}

	async fn get_messages(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!([]))
	}

	async fn set_model(
		&self,
		_c: &BackendCallContext,
		provider: &str,
		model_id: &str,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({ "provider": provider, "modelId": model_id }))
	}

	async fn compact(
		&self,
		_c: &BackendCallContext,
		_ci: Option<&str>,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({ "compacted": true }))
	}

	async fn set_todos(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<()> {
		Ok(())
	}

	async fn exec(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({ "exitCode": 0 }))
	}

	async fn dispose(&self, _c: &BackendCallContext) -> gjc_app_server::Result<()> {
		Ok(())
	}
}

#[derive(Clone, Default)]
struct EchoFactory {
	notification_calls:  Arc<Mutex<Vec<(String, serde_json::Value)>>>,
	notification_replay: Arc<Mutex<Vec<serde_json::Value>>>,
}

#[async_trait]
impl BackendFactory for EchoFactory {
	async fn create_thread(
		&self,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		let info = BackendHandleInfo {
			thread_id:        ThreadId::generate(),
			generation:       BackendGeneration::FIRST,
			session_metadata: SessionMetadata::default(),
		};
		Ok((info, Arc::new(EchoBackend)))
	}

	async fn resume_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(p).await
	}

	async fn fork_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(p).await
	}
}

#[async_trait]
impl gjc_app_server::notifications::NotificationHost for EchoFactory {
	async fn notification_call(
		&self,
		kind: &str,
		params: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		self
			.notification_calls
			.lock()
			.push((kind.to_string(), params));
		if kind == "notifications.subscribe" {
			Ok(serde_json::Value::Array(self.notification_replay.lock().clone()))
		} else {
			Ok(serde_json::json!({ "ok": true, "kind": kind }))
		}
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

impl CollectingSink {
	fn methods(&self) -> Vec<String> {
		self.notes.lock().iter().map(|n| n.method.clone()).collect()
	}
}

impl EchoFactory {
	fn notification_calls(&self) -> Vec<(String, serde_json::Value)> {
		self.notification_calls.lock().clone()
	}

	fn set_notification_replay(&self, frames: Vec<serde_json::Value>) {
		*self.notification_replay.lock() = frames;
	}
}

// ---- helpers ----------------------------------------------------------------

fn build() -> (Arc<AppServer>, Arc<CollectingSink>) {
	let (server, sink, _) = build_with_factory();
	(server, sink)
}

fn build_with_factory() -> (Arc<AppServer>, Arc<CollectingSink>, EchoFactory) {
	let sink = Arc::new(CollectingSink::default());
	let factory = EchoFactory::default();
	let server = Arc::new(AppServer::new_with_notification_host(
		Arc::new(factory.clone()),
		AppServerConfig::default(),
		sink.clone(),
		Arc::new(factory.clone()),
	));
	(server, sink, factory)
}

async fn initialize(server: &Arc<AppServer>) -> gjc_app_server::ConnectionId {
	let conn = server.open_connection();
	let init =
		parse_inbound(r#"{"id":0,"method":"initialize","params":{"clientInfo":{"name":"conf"}}}"#)
			.unwrap();
	let resp = server.dispatch(&conn, init).await.unwrap();
	assert!(resp.error.is_none());
	let acked = parse_inbound(r#"{"method":"initialized"}"#).unwrap();
	assert!(server.dispatch(&conn, acked).await.is_none());
	conn
}

async fn start_thread(server: &Arc<AppServer>, conn: &gjc_app_server::ConnectionId) -> ThreadId {
	let req = parse_inbound(r#"{"id":1,"method":"thread/start","params":{"cwd":"/repo"}}"#).unwrap();
	let resp = server.dispatch(conn, req).await.unwrap();
	ThreadId(
		resp.result.unwrap()["thread"]["id"]
			.as_str()
			.unwrap()
			.to_string(),
	)
}

fn ev(thread: &ThreadId, kind: &str, payload: serde_json::Value) -> BackendEvent {
	BackendEvent {
		thread_id: thread.clone(),
		generation: BackendGeneration::FIRST,
		event_type: kind.into(),
		payload,
	}
}

// ---- conformance cases ------------------------------------------------------

#[tokio::test]
async fn full_streamed_turn_lifecycle() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;

	let start = parse_inbound(&format!(
		r#"{{"id":2,"method":"turn/start","params":{{"threadId":"{}","input":"hello"}}}}"#,
		thread.0
	))
	.unwrap();
	assert!(server.dispatch(&conn, start).await.unwrap().error.is_none());

	// Simulate the backend streaming a text turn.
	server.emit_backend_event(&ev(&thread, "agent_start", serde_json::json!({})));
	server.emit_backend_event(&ev(&thread, "message_start", serde_json::json!({})));
	server.emit_backend_event(&ev(
		&thread,
		"message_update",
		serde_json::json!({ "assistantMessageEvent": { "delta": "hi" } }),
	));
	server.emit_backend_event(&ev(&thread, "agent_end", serde_json::json!({})));

	let methods = sink.methods();
	// Ordered lifecycle present.
	let idx = |m: &str| methods.iter().position(|x| x == m);
	assert!(idx("turn/started").is_some(), "methods: {methods:?}");
	assert!(idx("item/started").unwrap() > idx("turn/started").unwrap());
	assert!(idx("item/agentMessage/delta").unwrap() > idx("item/started").unwrap());
	assert!(idx("turn/completed").unwrap() > idx("item/agentMessage/delta").unwrap());
	// Exactly one turn/completed.
	assert_eq!(methods.iter().filter(|m| *m == "turn/completed").count(), 1);
}

#[tokio::test]
async fn concurrent_threads_have_independent_streams() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let a = start_thread(&server, &conn).await;
	let b = start_thread(&server, &conn).await;
	assert_ne!(a, b);

	// Interleave two threads' events; each stream is independent.
	server.emit_backend_event(&ev(&a, "agent_start", serde_json::json!({})));
	server.emit_backend_event(&ev(&b, "agent_start", serde_json::json!({})));
	server.emit_backend_event(&ev(&a, "agent_end", serde_json::json!({})));
	server.emit_backend_event(&ev(&b, "agent_end", serde_json::json!({})));

	let notes = sink.notes.lock();
	let a_completed = notes
		.iter()
		.filter(|n| n.method == "turn/completed" && n.params.as_ref().unwrap()["threadId"] == a.0)
		.count();
	let b_completed = notes
		.iter()
		.filter(|n| n.method == "turn/completed" && n.params.as_ref().unwrap()["threadId"] == b.0)
		.count();
	assert_eq!(a_completed, 1);
	assert_eq!(b_completed, 1);
}

#[tokio::test]
async fn stale_generation_event_is_rejected() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let mut stale = ev(&thread, "agent_start", serde_json::json!({}));
	stale.generation = BackendGeneration(99);
	assert_eq!(server.emit_backend_event(&stale), 0);
	assert!(sink.notes.lock().is_empty());
}

#[tokio::test]
async fn malformed_json_frame_yields_parse_error_response() {
	let err = parse_inbound(r#"{"id":1,"method":"initialize","params": "#).unwrap_err();
	let resp =
		gjc_app_server::jsonrpc::Response::err(gjc_app_server::jsonrpc::RequestId::Number(1), err);
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::PARSE_ERROR);
}

#[tokio::test]
async fn gjc_extension_strictly_rejects_unknown_fields() {
	let (server, _sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let req = parse_inbound(&format!(
        r#"{{"id":3,"method":"gjc/model/set","params":{{"threadId":"{}","provider":"anthropic","modelId":"claude","extra":true}}}}"#,
        thread.0
    ))
    .unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
}

#[tokio::test]
async fn codex_core_ignores_unknown_fields() {
	let (server, _sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let req = parse_inbound(&format!(
        r#"{{"id":4,"method":"turn/start","params":{{"threadId":"{}","input":"x","environments":["prod"],"realtime":true}}}}"#,
        thread.0
    ))
    .unwrap();
	assert!(server.dispatch(&conn, req).await.unwrap().error.is_none());
}

#[tokio::test]
async fn unknown_method_is_method_not_found() {
	let (server, _sink) = build();
	let conn = initialize(&server).await;
	let req = parse_inbound(r#"{"id":5,"method":"no/such"}"#).unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::METHOD_NOT_FOUND);
}

#[tokio::test]
async fn requests_before_initialize_are_rejected() {
	let (server, _sink) = build();
	let conn = server.open_connection();
	let req = parse_inbound(r#"{"id":1,"method":"thread/start"}"#).unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::NOT_INITIALIZED);
}

#[tokio::test]
async fn duplicate_initialize_is_rejected() {
	let (server, _sink) = build();
	let conn = server.open_connection();
	let first = parse_inbound(r#"{"id":0,"method":"initialize","params":{}}"#).unwrap();
	assert!(server.dispatch(&conn, first).await.unwrap().error.is_none());
	let second = parse_inbound(r#"{"id":1,"method":"initialize","params":{}}"#).unwrap();
	let resp = server.dispatch(&conn, second).await.unwrap();
	let err = resp.error.expect("second initialize rejected");
	assert!(err.message.contains("Already initialized"));
}

#[tokio::test]
async fn notifications_subscribe_routes_to_host_and_returns_ok() {
	let (server, sink, factory) = build_with_factory();
	factory.set_notification_replay(vec![
		serde_json::json!({ "type": "hello", "sticky": true }),
		serde_json::json!({ "type": "activity", "extra": { "nested": true } }),
	]);
	let conn = initialize(&server).await;

	let req = parse_inbound(
		r#"{"id":6,"method":"gjc/notifications/subscribe","params":{"client":"fake"}}"#,
	)
	.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();

	assert_eq!(resp.result.unwrap(), serde_json::json!({ "ok": true }));
	assert_eq!(factory.notification_calls(), vec![(
		"notifications.subscribe".to_string(),
		serde_json::json!({ "client": "fake" })
	)]);
	let notes = sink.notes.lock();
	assert_eq!(notes.len(), 2);
	assert!(notes.iter().all(|n| n.method == "gjc/notifications/event"));
}

#[tokio::test]
async fn push_notification_reaches_sink_as_notifications_event() {
	let (server, sink) = build();
	let frame = serde_json::json!({ "kind": "ask", "id": "a1", "unknown": { "kept": true } });

	server.push_notification(frame.clone());

	let notes = sink.notes.lock();
	assert_eq!(notes.len(), 1);
	assert_eq!(notes[0].method, "gjc/notifications/event");
	assert_eq!(notes[0].params.as_ref(), Some(&frame));
}

#[tokio::test]
async fn notifications_reply_routes_to_host_with_notifications_kind() {
	let (server, _sink, factory) = build_with_factory();
	let conn = initialize(&server).await;

	let req = parse_inbound(
		r#"{"id":7,"method":"gjc/notifications/reply","params":{"id":"a1","answer":"yes"}}"#,
	)
	.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();

	assert_eq!(
		resp.result.unwrap(),
		serde_json::json!({ "ok": true, "kind": "notifications.reply" })
	);
	assert_eq!(factory.notification_calls(), vec![(
		"notifications.reply".to_string(),
		serde_json::json!({ "id": "a1", "answer": "yes" })
	)]);
}

#[tokio::test]
async fn notifications_frames_preserve_opaque_unknown_fields() {
	let (server, sink, factory) = build_with_factory();
	let replay = serde_json::json!({
		 "type": "action_needed",
		 "id": "opaque-1",
		 "unknownTopLevel": true,
		 "nested": { "array": [1, { "kept": "yes" }] }
	});
	factory.set_notification_replay(vec![replay.clone()]);
	let conn = initialize(&server).await;

	let req = parse_inbound(
		r#"{"id":8,"method":"gjc/notifications/subscribe","params":{"unknownParam":{"preserve":true}}}"#,
	)
	.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();

	assert!(resp.error.is_none());
	assert_eq!(
		factory.notification_calls()[0].1,
		serde_json::json!({ "unknownParam": { "preserve": true } })
	);
	let notes = sink.notes.lock();
	assert_eq!(notes[0].params.as_ref(), Some(&replay));
}

#[tokio::test]
async fn host_tools_round_trip() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let set = parse_inbound(&format!(r#"{{"id":10,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{"type":"object"}}}}]}}}}"#, thread.0)).unwrap();
	let resp = server.dispatch(&conn, set).await.unwrap();
	assert!(resp.error.is_none());
	let turn = TurnId("turn_host".into());
	let call = {
		let server = Arc::clone(&server);
		let thread = thread.clone();
		let turn = turn.clone();
		tokio::spawn(async move {
			server
				.call_host_tool(&thread, &turn, "lookup", serde_json::json!({"q":"gjc"}))
				.await
		})
	};
	tokio::time::sleep(std::time::Duration::from_millis(10)).await;
	let note = sink
		.notes
		.lock()
		.iter()
		.find(|n| n.method == "gjc/hostTools/call")
		.cloned()
		.unwrap();
	let params = note.params.unwrap();
	assert_eq!(params["threadId"], thread.0);
	assert_eq!(params["turnId"], turn.0);
	assert_eq!(params["tool"], "lookup");
	let call_id = params["callId"].as_str().unwrap();
	let result = parse_inbound(&format!(r#"{{"id":11,"method":"gjc/hostTools/result","params":{{"threadId":"{}","callId":"{}","ok":true,"result":{{"answer":42}}}}}}"#, thread.0, call_id)).unwrap();
	let resp = server.dispatch(&conn, result).await.unwrap();
	assert!(resp.error.is_none());
	let resolved = call.await.unwrap().unwrap();
	assert!(resolved.ok);
	assert_eq!(resolved.result.unwrap()["answer"], 42);
}

#[derive(Clone, Default)]
struct CapturingFactory {
	created:          Arc<Mutex<Vec<serde_json::Value>>>,
	resumed:          Arc<Mutex<Vec<serde_json::Value>>>,
	resume_thread_id: Arc<Mutex<Option<ThreadId>>>,
}

#[async_trait]
impl BackendFactory for CapturingFactory {
	async fn create_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.created.lock().push(p.clone());
		Ok((
			BackendHandleInfo {
				thread_id:        ThreadId::generate(),
				generation:       BackendGeneration::FIRST,
				session_metadata: SessionMetadata::default(),
			},
			Arc::new(EchoBackend),
		))
	}

	async fn resume_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.resumed.lock().push(p.clone());
		let thread_id = self
			.resume_thread_id
			.lock()
			.clone()
			.unwrap_or_else(ThreadId::generate);
		Ok((
			BackendHandleInfo {
				thread_id,
				generation: BackendGeneration::FIRST,
				session_metadata: SessionMetadata::default(),
			},
			Arc::new(EchoBackend),
		))
	}

	async fn fork_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(p).await
	}
}

fn build_capturing(factory: CapturingFactory) -> (Arc<AppServer>, Arc<CollectingSink>) {
	let sink = Arc::new(CollectingSink::default());
	let server =
		Arc::new(AppServer::new(Arc::new(factory), AppServerConfig::default(), sink.clone()));
	(server, sink)
}

#[tokio::test]
async fn thread_metadata_parity() {
	let factory = CapturingFactory::default();
	let (server, _) = build_capturing(factory.clone());
	let conn = initialize(&server).await;
	let params = serde_json::json!({"cwd":"/repo","sessionId":"s1","sessionDir":"/tmp/s","systemPromptAppend":"extra","model":{"provider":"p","modelId":"m"},"thinking":{"effort":"high"},"todos":[{"title":"t"}]});
	let req = parse_inbound(&format!(r#"{{"id":20,"method":"thread/start","params":{}}}"#, params))
		.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert!(resp.error.is_none());
	assert_eq!(factory.created.lock()[0], params);
}

#[tokio::test]
async fn true_resume_identity() {
	let factory = CapturingFactory::default();
	let (server, _) = build_capturing(factory.clone());
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let params = serde_json::json!({"threadId":thread.0,"cwd":"/repo","sessionId":"s1","sessionDir":"/tmp/s","systemPromptAppend":"extra","model":{"provider":"p","modelId":"m"},"thinking":{"effort":"high"},"todos":[]});
	let req = parse_inbound(&format!(r#"{{"id":21,"method":"thread/resume","params":{}}}"#, params))
		.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert!(resp.error.is_none());
	let result = resp.result.unwrap();
	assert_eq!(result["thread"]["id"], thread.0);
	assert_eq!(result["thread"]["generation"], 2);
	assert_eq!(result["resumed"], true);
	assert!(factory.resumed.lock().is_empty());
}

#[tokio::test]
async fn resume_preserves_host_tool_registry() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let set = parse_inbound(&format!(r#"{{"id":22,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{}}}}]}}}}"#, thread.0)).unwrap();
	assert!(server.dispatch(&conn, set).await.unwrap().error.is_none());
	let resume = parse_inbound(&format!(
		r#"{{"id":23,"method":"thread/resume","params":{{"threadId":"{}"}}}}"#,
		thread.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, resume).await.unwrap();
	assert!(resp.error.is_none());
	assert_eq!(resp.result.unwrap()["resumed"], true);
	assert_eq!(server.host_tool_names(&thread).unwrap(), vec!["lookup".to_string()]);
	let result = server
		.call_host_tool_with_timeout(
			&thread,
			&TurnId("turn_after_resume".into()),
			"lookup",
			serde_json::json!({}),
			std::time::Duration::from_millis(1),
		)
		.await
		.unwrap_err();
	assert_eq!(result.code, gjc_app_server::error::codes::INTERNAL_ERROR);
}

#[tokio::test]
async fn resume_bumps_generation_rejects_stale() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let resume = parse_inbound(&format!(
		r#"{{"id":24,"method":"thread/resume","params":{{"threadId":"{}"}}}}"#,
		thread.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, resume).await.unwrap();
	assert!(resp.error.is_none());
	assert_eq!(resp.result.unwrap()["thread"]["generation"], 2);
	let stale = BackendEvent {
		thread_id:  thread.clone(),
		generation: BackendGeneration::FIRST,
		event_type: "text_delta".into(),
		payload:    serde_json::json!({"text":"stale"}),
	};
	assert_eq!(server.emit_backend_event(&stale), 0);
	let current = BackendEvent {
		thread_id:  thread,
		generation: BackendGeneration(2),
		event_type: "agent_start".into(),
		payload:    serde_json::json!({}),
	};
	assert!(server.emit_backend_event(&current) > 0);
}

#[tokio::test]
async fn turn_steer_interrupt_by_turn_id() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let start = parse_inbound(&format!(
		r#"{{"id":30,"method":"turn/start","params":{{"threadId":"{}","prompt":"hi"}}}}"#,
		thread.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, start).await.unwrap();
	let turn_id = resp.result.unwrap()["turn"]["id"]
		.as_str()
		.unwrap()
		.to_string();
	let bad = parse_inbound(&format!(
		r#"{{"id":31,"method":"turn/interrupt","params":{{"threadId":"{}","turnId":"wrong"}}}}"#,
		thread.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, bad).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::CONFLICT);
	let steer = parse_inbound(&format!(r#"{{"id":32,"method":"turn/steer","params":{{"threadId":"{}","expectedTurnId":"{}","message":"go"}}}}"#, thread.0, turn_id)).unwrap();
	let resp = server.dispatch(&conn, steer).await.unwrap();
	assert!(resp.error.is_none());
	let ok = parse_inbound(&format!(
		r#"{{"id":33,"method":"turn/interrupt","params":{{"threadId":"{}","turnId":"{}"}}}}"#,
		thread.0, turn_id
	))
	.unwrap();
	let resp = server.dispatch(&conn, ok).await.unwrap();
	assert!(resp.error.is_none());
}

#[tokio::test]
async fn host_tools_set_rejects_unknown_fields() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let req = parse_inbound(&format!(r#"{{"id":40,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"x","description":"x","inputSchema":{{}},"extra":true}}]}}}}"#, thread.0)).unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
}

#[tokio::test]
async fn host_tools_result_rejects_unknown_fields() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let req = parse_inbound(r#"{"id":41,"method":"gjc/hostTools/result","params":{"threadId":"thr","callId":"call","ok":true,"extra":true}}"#).unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
}

#[tokio::test]
async fn host_tools_result_enforces_strict_tagged_union() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	for (id, params) in [
		(42, serde_json::json!({"threadId":thread.0,"callId":"c","ok":true})),
		(
			43,
			serde_json::json!({"threadId":thread.0,"callId":"c","ok":true,"result":{},"error":{"message":"bad"}}),
		),
		(44, serde_json::json!({"threadId":thread.0,"callId":"c","ok":false,"result":{}})),
		(45, serde_json::json!({"threadId":thread.0,"callId":"c","ok":false,"error":{}})),
	] {
		let req = parse_inbound(&format!(
			r#"{{"id":{},"method":"gjc/hostTools/result","params":{}}}"#,
			id, params
		))
		.unwrap();
		let resp = server.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	}
}

#[tokio::test]
async fn host_tools_set_validates_descriptor_shape() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	for (id, tool) in [
		(46, serde_json::json!({"name":"","description":"x","inputSchema":{}})),
		(47, serde_json::json!({"name":"x","description":7,"inputSchema":{}})),
		(48, serde_json::json!({"name":"x","description":"x","inputSchema":true})),
	] {
		let req = parse_inbound(&format!(
			r#"{{"id":{},"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{}]}}}}"#,
			id, thread.0, tool
		))
		.unwrap();
		let resp = server.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	}
}

#[tokio::test]
async fn host_tools_update_dispatches_to_pending_call() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let set = parse_inbound(&format!(r#"{{"id":490,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{}}}}]}}}}"#, thread.0)).unwrap();
	assert!(server.dispatch(&conn, set).await.unwrap().error.is_none());
	let call = {
		let server = Arc::clone(&server);
		let thread = thread.clone();
		tokio::spawn(async move {
			server
				.call_host_tool_with_timeout(
					&thread,
					&TurnId("turn_update".into()),
					"lookup",
					serde_json::json!({}),
					std::time::Duration::from_secs(5),
				)
				.await
		})
	};
	tokio::time::sleep(std::time::Duration::from_millis(10)).await;
	let call_id = sink
		.notes
		.lock()
		.iter()
		.find(|n| n.method == "gjc/hostTools/call")
		.unwrap()
		.params
		.as_ref()
		.unwrap()["callId"]
		.as_str()
		.unwrap()
		.to_string();
	let update = parse_inbound(&format!(r#"{{"id":491,"method":"gjc/hostTools/update","params":{{"threadId":"{}","callId":"{}","payload":{{"pct":50}}}}}}"#, thread.0, call_id)).unwrap();
	assert!(
		server
			.dispatch(&conn, update)
			.await
			.unwrap()
			.error
			.is_none()
	);
	let unknown = parse_inbound(&format!(r#"{{"id":492,"method":"gjc/hostTools/update","params":{{"threadId":"{}","callId":"missing","payload":{{}}}}}}"#, thread.0)).unwrap();
	let resp = server.dispatch(&conn, unknown).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::NOT_FOUND);
	let result = parse_inbound(&format!(r#"{{"id":493,"method":"gjc/hostTools/result","params":{{"threadId":"{}","callId":"{}","ok":true,"result":{{"done":true}}}}}}"#, thread.0, call_id)).unwrap();
	assert!(
		server
			.dispatch(&conn, result)
			.await
			.unwrap()
			.error
			.is_none()
	);
	assert_eq!(call.await.unwrap().unwrap().result.unwrap()["done"], true);
}

#[tokio::test]
async fn host_tools_unknown_tool_errors() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let err = server
		.call_host_tool_with_timeout(
			&thread,
			&TurnId("turn".into()),
			"missing",
			serde_json::json!({}),
			std::time::Duration::from_millis(1),
		)
		.await
		.unwrap_err();
	assert_eq!(err.code, gjc_app_server::error::codes::NOT_FOUND);
}

#[derive(Clone)]
struct BlockingFactory {
	thread_id: ThreadId,
}

struct BlockingBackend;

#[async_trait]
impl AgentBackend for BlockingBackend {
	async fn prompt(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<TurnId> {
		std::future::pending::<()>().await;
		unreachable!()
	}

	async fn steer(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<TurnId> {
		Ok(TurnId::generate())
	}

	async fn abort(&self, _c: &BackendCallContext, _t: &TurnId) -> gjc_app_server::Result<()> {
		Ok(())
	}

	async fn get_state(
		&self,
		_c: &BackendCallContext,
		_i: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({}))
	}

	async fn get_messages(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!([]))
	}

	async fn set_model(
		&self,
		_c: &BackendCallContext,
		provider: &str,
		model_id: &str,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({"provider":provider,"modelId":model_id}))
	}

	async fn compact(
		&self,
		_c: &BackendCallContext,
		_ci: Option<&str>,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({}))
	}

	async fn set_todos(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<()> {
		Ok(())
	}

	async fn exec(
		&self,
		_c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({}))
	}

	async fn dispose(&self, _c: &BackendCallContext) -> gjc_app_server::Result<()> {
		Ok(())
	}
}

#[async_trait]
impl BackendFactory for BlockingFactory {
	async fn create_thread(
		&self,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		Ok((
			BackendHandleInfo {
				thread_id:        self.thread_id.clone(),
				generation:       BackendGeneration::FIRST,
				session_metadata: SessionMetadata::default(),
			},
			Arc::new(BlockingBackend),
		))
	}

	async fn resume_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(p).await
	}

	async fn fork_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(p).await
	}
}

#[tokio::test]
async fn host_tools_cancel_on_interrupt() {
	let sink = Arc::new(CollectingSink::default());
	let thread = ThreadId("thr_blocking".into());
	let server = Arc::new(AppServer::new(
		Arc::new(BlockingFactory { thread_id: thread.clone() }),
		AppServerConfig::default(),
		sink.clone(),
	));
	let conn = initialize(&server).await;
	let started =
		parse_inbound(r#"{"id":49,"method":"thread/start","params":{"cwd":"/repo"}}"#).unwrap();
	assert!(
		server
			.dispatch(&conn, started)
			.await
			.unwrap()
			.error
			.is_none()
	);
	let set = parse_inbound(&format!(r#"{{"id":50,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{}}}}]}}}}"#, thread.0)).unwrap();
	assert!(server.dispatch(&conn, set).await.unwrap().error.is_none());
	let start = parse_inbound(&format!(
		r#"{{"id":51,"method":"turn/start","params":{{"threadId":"{}","prompt":"hi"}}}}"#,
		thread.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, start).await.unwrap();
	let turn = TurnId(
		resp.result.unwrap()["turn"]["id"]
			.as_str()
			.unwrap()
			.to_string(),
	);
	let call = {
		let server = Arc::clone(&server);
		let thread = thread.clone();
		let turn = turn.clone();
		tokio::spawn(async move {
			server
				.call_host_tool_with_timeout(
					&thread,
					&turn,
					"lookup",
					serde_json::json!({}),
					std::time::Duration::from_secs(5),
				)
				.await
		})
	};
	tokio::time::sleep(std::time::Duration::from_millis(10)).await;
	let req = parse_inbound(&format!(
		r#"{{"id":52,"method":"turn/interrupt","params":{{"threadId":"{}","turnId":"{}"}}}}"#,
		thread.0, turn.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert!(resp.error.is_none());
	assert!(call.await.unwrap().is_err());
	assert!(sink.methods().iter().any(|m| m == "gjc/hostTools/cancel"));
}

#[tokio::test]
async fn host_tools_result_unknown_and_duplicate_call_ids_are_terminal() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let unknown = parse_inbound(&format!(r#"{{"id":60,"method":"gjc/hostTools/result","params":{{"threadId":"{}","callId":"missing","ok":true,"result":{{}}}}}}"#, thread.0)).unwrap();
	let resp = server.dispatch(&conn, unknown).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::NOT_FOUND);

	let set = parse_inbound(&format!(r#"{{"id":61,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{}}}}]}}}}"#, thread.0)).unwrap();
	assert!(server.dispatch(&conn, set).await.unwrap().error.is_none());
	let call = {
		let server = Arc::clone(&server);
		let thread = thread.clone();
		tokio::spawn(async move {
			server
				.call_host_tool(&thread, &TurnId("turn_dup".into()), "lookup", serde_json::json!({}))
				.await
		})
	};
	tokio::time::sleep(std::time::Duration::from_millis(10)).await;
	let note = sink
		.notes
		.lock()
		.iter()
		.find(|n| n.method == "gjc/hostTools/call")
		.cloned()
		.unwrap();
	let call_id = note.params.unwrap()["callId"].as_str().unwrap().to_string();
	let result = parse_inbound(&format!(r#"{{"id":62,"method":"gjc/hostTools/result","params":{{"threadId":"{}","callId":"{}","ok":true,"result":{{"answer":1}}}}}}"#, thread.0, call_id)).unwrap();
	assert!(
		server
			.dispatch(&conn, result)
			.await
			.unwrap()
			.error
			.is_none()
	);
	assert_eq!(call.await.unwrap().unwrap().result.unwrap()["answer"], 1);
	let duplicate = parse_inbound(&format!(r#"{{"id":63,"method":"gjc/hostTools/result","params":{{"threadId":"{}","callId":"{}","ok":true,"result":{{"answer":2}}}}}}"#, thread.0, call_id)).unwrap();
	let resp = server.dispatch(&conn, duplicate).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::NOT_FOUND);
}

#[tokio::test]
async fn host_tools_late_result_after_cancel_is_rejected_and_waiter_resolves_error() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let set = parse_inbound(&format!(r#"{{"id":64,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{}}}}]}}}}"#, thread.0)).unwrap();
	assert!(server.dispatch(&conn, set).await.unwrap().error.is_none());
	let turn = TurnId("turn_cancel_late".into());
	let call = {
		let server = Arc::clone(&server);
		let thread = thread.clone();
		let turn = turn.clone();
		tokio::spawn(async move {
			server
				.call_host_tool_with_timeout(
					&thread,
					&turn,
					"lookup",
					serde_json::json!({}),
					std::time::Duration::from_secs(5),
				)
				.await
		})
	};
	tokio::time::sleep(std::time::Duration::from_millis(10)).await;
	let call_id = sink
		.notes
		.lock()
		.iter()
		.find(|n| n.method == "gjc/hostTools/call")
		.unwrap()
		.params
		.as_ref()
		.unwrap()["callId"]
		.as_str()
		.unwrap()
		.to_string();
	let del = parse_inbound(&format!(
		r#"{{"id":650,"method":"thread/delete","params":{{"threadId":"{}"}}}}"#,
		thread.0
	))
	.unwrap();
	assert!(server.dispatch(&conn, del).await.unwrap().error.is_none());
	assert!(call.await.unwrap().is_err());
	assert!(sink.methods().iter().any(|m| m == "gjc/hostTools/cancel"));
	let late = parse_inbound(&format!(r#"{{"id":65,"method":"gjc/hostTools/result","params":{{"threadId":"{}","callId":"{}","ok":true,"result":{{}}}}}}"#, thread.0, call_id)).unwrap();
	let resp = server.dispatch(&conn, late).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::NOT_FOUND);
}

#[tokio::test]
async fn host_tools_set_replacement_does_not_cancel_pending_or_leak_to_other_threads() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let a = start_thread(&server, &conn).await;
	let b = start_thread(&server, &conn).await;
	let set_a = parse_inbound(&format!(r#"{{"id":66,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{}}}}]}}}}"#, a.0)).unwrap();
	assert!(server.dispatch(&conn, set_a).await.unwrap().error.is_none());
	let pending = {
		let server = Arc::clone(&server);
		let a = a.clone();
		tokio::spawn(async move {
			server
				.call_host_tool_with_timeout(
					&a,
					&TurnId("turn_replace".into()),
					"lookup",
					serde_json::json!({}),
					std::time::Duration::from_secs(5),
				)
				.await
		})
	};
	tokio::time::sleep(std::time::Duration::from_millis(10)).await;
	let call_id = sink
		.notes
		.lock()
		.iter()
		.find(|n| n.method == "gjc/hostTools/call")
		.unwrap()
		.params
		.as_ref()
		.unwrap()["callId"]
		.as_str()
		.unwrap()
		.to_string();
	let replace = parse_inbound(&format!(r#"{{"id":67,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"other","description":"Other","inputSchema":{{}}}}]}}}}"#, a.0)).unwrap();
	assert!(
		server
			.dispatch(&conn, replace)
			.await
			.unwrap()
			.error
			.is_none()
	);
	let wrong_thread = server
		.call_host_tool_with_timeout(
			&b,
			&TurnId("turn_other_thread".into()),
			"other",
			serde_json::json!({}),
			std::time::Duration::from_millis(1),
		)
		.await
		.unwrap_err();
	assert_eq!(wrong_thread.code, gjc_app_server::error::codes::NOT_FOUND);
	let old_removed = server
		.call_host_tool_with_timeout(
			&a,
			&TurnId("turn_old_removed".into()),
			"lookup",
			serde_json::json!({}),
			std::time::Duration::from_millis(1),
		)
		.await
		.unwrap_err();
	assert_eq!(old_removed.code, gjc_app_server::error::codes::NOT_FOUND);
	let result = parse_inbound(&format!(r#"{{"id":68,"method":"gjc/hostTools/result","params":{{"threadId":"{}","callId":"{}","ok":true,"result":{{"ok":true}}}}}}"#, a.0, call_id)).unwrap();
	assert!(
		server
			.dispatch(&conn, result)
			.await
			.unwrap()
			.error
			.is_none()
	);
	assert!(pending.await.unwrap().unwrap().ok);
}

#[tokio::test]
async fn thread_resume_unknown_identity_reports_fresh_session_fallback() {
	let factory = CapturingFactory::default();
	*factory.resume_thread_id.lock() = Some(ThreadId("fresh_thread".into()));
	let (server, _) = build_capturing(factory);
	let conn = initialize(&server).await;
	let req = parse_inbound(
		r#"{"id":69,"method":"thread/resume","params":{"threadId":"missing_thread","cwd":"/repo"}}"#,
	)
	.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert!(resp.error.is_none());
	let result = resp.result.unwrap();
	assert_eq!(result["thread"]["id"], "fresh_thread");
	assert_eq!(result["resumed"], false);
}

#[tokio::test]
async fn thread_delete_with_pending_host_tool_call_cancels_waiter() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let set = parse_inbound(&format!(r#"{{"id":70,"method":"gjc/hostTools/set","params":{{"threadId":"{}","tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{}}}}]}}}}"#, thread.0)).unwrap();
	assert!(server.dispatch(&conn, set).await.unwrap().error.is_none());
	let pending = {
		let server = Arc::clone(&server);
		let thread = thread.clone();
		tokio::spawn(async move {
			server
				.call_host_tool_with_timeout(
					&thread,
					&TurnId("turn_delete".into()),
					"lookup",
					serde_json::json!({}),
					std::time::Duration::from_secs(5),
				)
				.await
		})
	};
	tokio::time::sleep(std::time::Duration::from_millis(10)).await;
	let del = parse_inbound(&format!(
		r#"{{"id":71,"method":"thread/delete","params":{{"threadId":"{}"}}}}"#,
		thread.0
	))
	.unwrap();
	assert!(server.dispatch(&conn, del).await.unwrap().error.is_none());
	let err = pending.await.unwrap().unwrap_err();
	assert_eq!(err.code, gjc_app_server::error::codes::CONFLICT);
	assert!(sink.methods().iter().any(|m| m == "gjc/hostTools/cancel"));
}
