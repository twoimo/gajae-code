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

	async fn read_context(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcContextReadResult> {
		Ok(gjc_app_server::protocol::GjcContextReadResult {
			tokens:         gjc_app_server::protocol::GjcContextTokens {
				input:       10,
				output:      5,
				cache_read:  Some(2),
				cache_write: Some(3),
				total:       20,
			},
			context_window: Some(100),
			percent_used:   Some(20.0),
			source:         "test".into(),
			freshness:      gjc_app_server::protocol::GjcContextFreshness::Live,
		})
	}

	async fn session_tree(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionTreeResult> {
		Ok(gjc_app_server::protocol::GjcSessionTreeResult {
			nodes:          vec![],
			active_leaf_id: None,
		})
	}

	async fn session_navigate(
		&self,
		_c: &BackendCallContext,
		_params: gjc_app_server::protocol::GjcSessionNavigateParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionNavigateResult> {
		Ok(gjc_app_server::protocol::GjcSessionNavigateResult {
			ok:             true,
			active_leaf_id: Some("leaf-1".into()),
		})
	}

	async fn session_label(
		&self,
		_c: &BackendCallContext,
		_params: gjc_app_server::protocol::GjcSessionLabelParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionLabelResult> {
		Ok(gjc_app_server::protocol::GjcSessionLabelResult { ok: true })
	}

	async fn read_todos(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcTodosReadResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"todos":[{"id":"t1","content":"ship","status":"pending"}]}),
		)
		.unwrap())
	}

	async fn read_usage(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcUsageReadResult> {
		Ok(serde_json::from_value(serde_json::json!({"perModel":[{"modelId":"m","input":1,"output":2,"cost":0.1}],"totalCost":0.1,"source":"test","freshness":"live"})).unwrap())
	}

	async fn list_jobs(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcJobsListResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"jobs":[{"id":"j1","type":"monitor","status":"running"}]}),
		)
		.unwrap())
	}

	async fn list_agents(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAgentsListResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"agents":[{"id":"a1","agentType":"executor","status":"completed"}]}),
		)
		.unwrap())
	}

	async fn list_monitors(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcMonitorsListResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"monitors":[{"id":"m1","kind":"monitor","status":"running","outputTail":"tail"}],"crons":[{"id":"cron-1","humanSchedule":"hourly","cronExpression":"0 * * * *","prompt":"ping","recurring":true,"nextFireAt":"2026-01-01T01:00:00Z","createdAt":"2026-01-01T00:00:00Z"}]}),
		)
		.unwrap())
	}

	async fn compact_summary(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcCompactSummaryResult> {
		Ok(serde_json::from_value(serde_json::json!({"summaries":[{"id":"c1","summary":"sum","tokensBefore":3,"timestamp":"2026-01-01T00:00:00.000Z"}]})).unwrap())
	}

	async fn model_catalog(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcModelCatalogResult> {
		Ok(serde_json::from_value(serde_json::json!({"models":[{"provider":"openai","modelId":"gpt-5","label":"GPT-5","available":true}],"activeProvider":"openai","activeModelId":"gpt-5"})).unwrap())
	}

	async fn read_thinking(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcThinkingReadResult> {
		Ok(gjc_app_server::protocol::GjcThinkingReadResult {
			level:  "medium".into(),
			levels: vec!["low".into(), "medium".into(), "high".into()],
		})
	}

	async fn set_thinking(
		&self,
		_c: &BackendCallContext,
		level: String,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcThinkingSetResult> {
		Ok(gjc_app_server::protocol::GjcThinkingSetResult { level })
	}

	async fn read_fast(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcFastReadResult> {
		Ok(gjc_app_server::protocol::GjcFastReadResult {
			enabled:        false,
			affected_roles: Some(vec!["default".into()]),
		})
	}

	async fn set_fast(
		&self,
		_c: &BackendCallContext,
		enabled: bool,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcFastSetResult> {
		Ok(gjc_app_server::protocol::GjcFastSetResult {
			enabled,
			affected_roles: Some(vec!["default".into()]),
		})
	}

	async fn set_model(
		&self,
		_c: &BackendCallContext,
		provider: &str,
		model_id: &str,
	) -> gjc_app_server::Result<serde_json::Value> {
		Ok(serde_json::json!({ "provider": provider, "modelId": model_id }))
	}

	async fn model_assign(
		&self,
		_c: &BackendCallContext,
		params: gjc_app_server::protocol::GjcModelAssignParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcModelAssignResult> {
		Ok(gjc_app_server::protocol::GjcModelAssignResult {
			ok:       true,
			role:     params.role,
			model_id: params.model_id,
		})
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

	async fn session_list(
		&self,
		_params: gjc_app_server::protocol::GjcSessionListParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionListResult> {
		Ok(gjc_app_server::protocol::GjcSessionListResult {
			sessions: vec![gjc_app_server::protocol::SessionIndexEntry {
				id:            "s1".into(),
				title:         Some("Title".into()),
				first_message: Some("First".into()),
				cwd:           "/tmp/project".into(),
				path:          "/tmp/project/session.jsonl".into(),
				modified_at:   "2026-01-01T00:00:00.000Z".into(),
				entry_count:   Some(2),
			}],
			total:    1,
		})
	}

	async fn session_search(
		&self,
		_params: gjc_app_server::protocol::GjcSessionSearchParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionSearchResult> {
		self
			.session_list(gjc_app_server::protocol::GjcSessionListParams::default())
			.await
	}

	async fn session_open(
		&self,
		_p: gjc_app_server::protocol::GjcSessionOpenParams,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(serde_json::Value::Null).await
	}

	async fn session_delete(
		&self,
		_p: gjc_app_server::protocol::GjcSessionDeleteParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionDeleteResult> {
		Ok(gjc_app_server::protocol::GjcSessionDeleteResult { ok: true })
	}

	async fn settings_schema(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSettingsSchemaResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"settings":[{"key":"autoResume","type":"boolean","default":false}]}),
		)
		.unwrap())
	}

	async fn settings_read(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSettingsReadResult> {
		Ok(serde_json::from_value(serde_json::json!({"values":{"autoResume":false}})).unwrap())
	}

	async fn settings_update(
		&self,
		params: gjc_app_server::protocol::GjcSettingsUpdateParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSettingsUpdateResult> {
		Ok(serde_json::from_value(serde_json::json!({"values":{params.key:params.value}})).unwrap())
	}

	async fn appearance_themes_list(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAppearanceThemesListResult> {
		Ok(serde_json::from_value(serde_json::json!({"themes":[{"id":"red-claw","kind":"dark","semanticPreview":{"bg":"#000000","bgElevated":"#111111","surface":"#181818","border":"#333333","text":"#eeeeee","textMuted":"#888888","accent":"#ff5555","success":"#22c55e","warning":"#f59e0b","danger":"#ef4444"},"builtin":true}]})).unwrap())
	}

	async fn appearance_read(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAppearanceReadResult> {
		Ok(serde_json::from_value(serde_json::json!({"dark":"red-claw","light":"blue-crab","symbolPreset":"unicode","colorBlindMode":false})).unwrap())
	}

	async fn appearance_set(
		&self,
		params: gjc_app_server::protocol::GjcAppearanceSetParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAppearanceSetResult> {
		Ok(serde_json::from_value(serde_json::json!({"dark":params.dark.unwrap_or_else(|| "red-claw".into()),"light":params.light.unwrap_or_else(|| "blue-crab".into()),"symbolPreset":params.symbol_preset.unwrap_or_else(|| "unicode".into()),"colorBlindMode":params.color_blind_mode.unwrap_or(false)})).unwrap())
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

	fn notes(&self) -> Vec<Notification> {
		self.notes.lock().clone()
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
async fn jobs_changed_event_emits_raw_and_typed_notifications() {
	let (server, sink) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;

	server.emit_backend_event(&ev(
		&thread,
		"jobs_changed",
		serde_json::json!({
			"kind": "monitor",
			"id": "monitor-1",
			"status": "running",
			"description": "Watch tests"
		}),
	));

	let notes = sink.notes();
	let methods: Vec<_> = notes.iter().map(|n| n.method.as_str()).collect();
	assert_eq!(methods, ["gjc/jobs/changed", "gjc/event"]);

	let typed = notes[0].params.as_ref().unwrap();
	assert_eq!(typed["threadId"], thread.0);
	assert_eq!(typed["generation"], 1);
	assert_eq!(typed["kind"], "monitor");
	assert_eq!(typed["id"], "monitor-1");
	assert_eq!(typed["status"], "running");
	assert_eq!(typed["description"], "Watch tests");
	assert_eq!(notes[1].params.as_ref().unwrap()["eventType"], "jobs_changed");
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

impl CapturingFactory {
	fn thread_id_for_open_or_resume(&self) -> ThreadId {
		self
			.resume_thread_id
			.lock()
			.clone()
			.unwrap_or_else(ThreadId::generate)
	}
}
#[async_trait]
impl BackendFactory for CapturingFactory {
	async fn create_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.created.lock().push(p);
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
		self.resumed.lock().push(p);
		let thread_id = self.thread_id_for_open_or_resume();
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

	async fn session_list(
		&self,
		_params: gjc_app_server::protocol::GjcSessionListParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionListResult> {
		Ok(gjc_app_server::protocol::GjcSessionListResult {
			sessions: vec![gjc_app_server::protocol::SessionIndexEntry {
				id:            "s1".into(),
				title:         Some("Title".into()),
				first_message: Some("First".into()),
				cwd:           "/tmp/project".into(),
				path:          "/tmp/project/session.jsonl".into(),
				modified_at:   "2026-01-01T00:00:00.000Z".into(),
				entry_count:   Some(2),
			}],
			total:    1,
		})
	}

	async fn session_search(
		&self,
		_params: gjc_app_server::protocol::GjcSessionSearchParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionSearchResult> {
		self
			.session_list(gjc_app_server::protocol::GjcSessionListParams::default())
			.await
	}

	async fn session_open(
		&self,
		_p: gjc_app_server::protocol::GjcSessionOpenParams,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		Ok((
			BackendHandleInfo {
				thread_id:        self.thread_id_for_open_or_resume(),
				generation:       BackendGeneration::FIRST,
				session_metadata: SessionMetadata::default(),
			},
			Arc::new(EchoBackend),
		))
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
	let req =
		parse_inbound(&format!(r#"{{"id":20,"method":"thread/start","params":{params}}}"#)).unwrap();
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
	let req =
		parse_inbound(&format!(r#"{{"id":21,"method":"thread/resume","params":{params}}}"#)).unwrap();
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
async fn duplicate_session_open_bumps_generation_and_rejects_stale() {
	let factory = CapturingFactory::default();
	let (server, sink) = build_capturing(factory.clone());
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	*factory.resume_thread_id.lock() = Some(thread.clone());

	let open = parse_inbound(
		r#"{"id":25,"method":"gjc/session/open","params":{"sessionPath":"/tmp/a.jsonl"}}"#,
	)
	.unwrap();
	let resp = server.dispatch(&conn, open).await.unwrap();
	assert!(resp.error.is_none());
	let result = resp.result.unwrap();
	assert_eq!(result["threadId"], thread.0);
	assert_eq!(result["generation"], 2);

	let first_turn = parse_inbound(&format!(
		r#"{{"id":26,"method":"turn/start","params":{{"threadId":"{}","input":"old"}}}}"#,
		thread.0
	))
	.unwrap();
	let first_turn_resp = server.dispatch(&conn, first_turn).await.unwrap();
	assert!(first_turn_resp.error.is_none());
	let first_turn_id = first_turn_resp.result.unwrap()["turn"]["id"]
		.as_str()
		.unwrap()
		.to_owned();
	assert!(sink.notes.lock().iter().any(|n| {
		n.method == "turn/started" && n.params.as_ref().unwrap()["turnId"] == first_turn_id
	}));

	let reopen = parse_inbound(
		r#"{"id":27,"method":"gjc/session/open","params":{"sessionPath":"/tmp/a.jsonl"}}"#,
	)
	.unwrap();
	let reopen_resp = server.dispatch(&conn, reopen).await.unwrap();
	assert!(reopen_resp.error.is_none());
	let reopen_result = reopen_resp.result.unwrap();
	assert_eq!(reopen_result["threadId"], thread.0);
	assert_eq!(reopen_result["generation"], 3);
	assert_eq!(server.active_turn_id(&thread).unwrap(), None);
	assert!(
		server
			.dispatch(
				&conn,
				parse_inbound(&format!(
					r#"{{"id":28,"method":"thread/read","params":{{"threadId":"{}"}}}}"#,
					thread.0
				))
				.unwrap(),
			)
			.await
			.unwrap()
			.result
			.unwrap()["thread"]["status"]
			== "idle"
	);
	sink.notes.lock().clear();

	let new_turn = parse_inbound(&format!(
		r#"{{"id":29,"method":"turn/start","params":{{"threadId":"{}","input":"new"}}}}"#,
		thread.0
	))
	.unwrap();
	let new_turn_resp = server.dispatch(&conn, new_turn).await.unwrap();
	assert!(new_turn_resp.error.is_none());
	let new_turn_id = new_turn_resp.result.unwrap()["turn"]["id"]
		.as_str()
		.unwrap()
		.to_owned();
	assert_ne!(new_turn_id, first_turn_id);
	server.emit_backend_event(&BackendEvent {
		thread_id:  thread.clone(),
		generation: BackendGeneration(3),
		event_type: "agent_end".into(),
		payload:    serde_json::json!({}),
	});
	let notes = sink.notes.lock();
	assert!(notes.iter().any(|n| {
		n.method == "turn/started" && n.params.as_ref().unwrap()["turnId"] == new_turn_id
	}));
	let completed = notes.iter().find(|n| n.method == "turn/completed").unwrap();
	assert_eq!(completed.params.as_ref().unwrap()["turnId"], new_turn_id);
	assert_ne!(completed.params.as_ref().unwrap()["turnId"], first_turn_id);
	drop(notes);
	sink.notes.lock().clear();
	let stale = BackendEvent {
		thread_id:  thread.clone(),
		generation: BackendGeneration::FIRST,
		event_type: "agent_start".into(),
		payload:    serde_json::json!({}),
	};
	assert_eq!(server.emit_backend_event(&stale), 0);
	assert!(sink.notes.lock().is_empty());

	let current = BackendEvent {
		thread_id:  thread,
		generation: BackendGeneration(3),
		event_type: "agent_start".into(),
		payload:    serde_json::json!({}),
	};
	assert!(server.emit_backend_event(&current) > 0);
}

#[derive(Clone)]
struct ReleasableFactory {
	thread_id:           ThreadId,
	releases:            Arc<Mutex<Vec<Arc<tokio::sync::Notify>>>>,
	started:             Arc<tokio::sync::Notify>,
	started_generations: Arc<Mutex<Vec<BackendGeneration>>>,
}

struct ReleasableBackend {
	release:             Arc<tokio::sync::Notify>,
	started:             Arc<tokio::sync::Notify>,
	started_generations: Arc<Mutex<Vec<BackendGeneration>>>,
}

#[async_trait]
impl AgentBackend for ReleasableBackend {
	async fn prompt(
		&self,
		c: &BackendCallContext,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<TurnId> {
		self.started_generations.lock().push(c.generation);
		self.started.notify_waiters();
		self.release.notified().await;
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
impl BackendFactory for ReleasableFactory {
	async fn create_thread(
		&self,
		_p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		let release = Arc::new(tokio::sync::Notify::new());
		self.releases.lock().push(Arc::clone(&release));
		Ok((
			BackendHandleInfo {
				thread_id:        self.thread_id.clone(),
				generation:       BackendGeneration::FIRST,
				session_metadata: SessionMetadata::default(),
			},
			Arc::new(ReleasableBackend {
				release,
				started: Arc::clone(&self.started),
				started_generations: Arc::clone(&self.started_generations),
			}),
		))
	}

	async fn resume_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(p).await
	}

	async fn session_open(
		&self,
		_p: gjc_app_server::protocol::GjcSessionOpenParams,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(serde_json::Value::Null).await
	}

	async fn fork_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.create_thread(p).await
	}
}

async fn wait_for_prompt_count(factory: &ReleasableFactory, count: usize) {
	let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
	loop {
		if factory.started_generations.lock().len() >= count {
			return;
		}
		assert!(tokio::time::Instant::now() < deadline, "timed out waiting for prompt {count}");
		factory.started.notified().await;
	}
}

#[tokio::test]
async fn stale_turn_completion_after_generation_bump_is_noop() {
	let sink = Arc::new(CollectingSink::default());
	let thread = ThreadId("thr_releasable".into());
	let factory = ReleasableFactory {
		thread_id:           thread.clone(),
		releases:            Arc::new(Mutex::new(Vec::new())),
		started:             Arc::new(tokio::sync::Notify::new()),
		started_generations: Arc::new(Mutex::new(Vec::new())),
	};
	let server = Arc::new(AppServer::new(
		Arc::new(factory.clone()),
		AppServerConfig { max_inflight_turns_per_thread: 1, ..AppServerConfig::default() },
		sink.clone(),
	));
	let conn = initialize(&server).await;
	let started =
		parse_inbound(r#"{"id":1025,"method":"thread/start","params":{"cwd":"/repo"}}"#).unwrap();
	assert!(
		server
			.dispatch(&conn, started)
			.await
			.unwrap()
			.error
			.is_none()
	);

	let turn_a = parse_inbound(&format!(
		r#"{{"id":1026,"method":"turn/start","params":{{"threadId":"{}","input":"old"}}}}"#,
		thread.0
	))
	.unwrap();
	let turn_a_resp = server.dispatch(&conn, turn_a).await.unwrap();
	assert!(turn_a_resp.error.is_none());
	let turn_a_id = turn_a_resp.result.unwrap()["turn"]["id"]
		.as_str()
		.unwrap()
		.to_owned();
	wait_for_prompt_count(&factory, 1).await;

	let reopen = parse_inbound(
		r#"{"id":1027,"method":"gjc/session/open","params":{"sessionPath":"/tmp/releasable.jsonl"}}"#,
	)
	.unwrap();
	let reopen_resp = server.dispatch(&conn, reopen).await.unwrap();
	assert!(reopen_resp.error.is_none());
	assert_eq!(reopen_resp.result.unwrap()["generation"], 2);

	let turn_b = parse_inbound(&format!(
		r#"{{"id":1028,"method":"turn/start","params":{{"threadId":"{}","input":"new"}}}}"#,
		thread.0
	))
	.unwrap();
	let turn_b_resp = server.dispatch(&conn, turn_b).await.unwrap();
	assert!(turn_b_resp.error.is_none());
	let turn_b_id = turn_b_resp.result.unwrap()["turn"]["id"]
		.as_str()
		.unwrap()
		.to_owned();
	assert_ne!(turn_a_id, turn_b_id);
	wait_for_prompt_count(&factory, 2).await;
	sink.notes.lock().clear();

	factory.releases.lock()[0].notify_waiters();
	tokio::time::sleep(std::time::Duration::from_millis(50)).await;

	let state = server
		.dispatch(
			&conn,
			parse_inbound(&format!(
				r#"{{"id":1029,"method":"thread/read","params":{{"threadId":"{}"}}}}"#,
				thread.0
			))
			.unwrap(),
		)
		.await
		.unwrap()
		.result
		.unwrap();
	assert_eq!(state["thread"]["status"], "running");
	assert_eq!(server.active_turn_id(&thread).unwrap(), Some(TurnId(turn_b_id.clone())));
	assert!(!sink.notes.lock().iter().any(|n| {
		n.method == "turn/completed" && n.params.as_ref().unwrap()["turnId"] == turn_a_id
	}));

	let turn_c = parse_inbound(&format!(
		r#"{{"id":1030,"method":"turn/start","params":{{"threadId":"{}","input":"extra"}}}}"#,
		thread.0
	))
	.unwrap();
	let turn_c_resp = server.dispatch(&conn, turn_c).await.unwrap();
	assert_eq!(turn_c_resp.error.unwrap().code, gjc_app_server::error::codes::SERVER_OVERLOADED);
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
async fn gjc_context_read_is_strict_and_token_safe() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let bad = parse_inbound(&format!(
		r#"{{"id":401,"method":"gjc/context/read","params":{{"threadId":"{}","bogus":1}}}}"#,
		thread.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, bad).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);

	let good = parse_inbound(&format!(
		r#"{{"id":402,"method":"gjc/context/read","params":{{"threadId":"{}"}}}}"#,
		thread.0
	))
	.unwrap();
	let resp = server.dispatch(&conn, good).await.unwrap();
	let result = resp.result.unwrap();
	assert_eq!(result["tokens"]["input"], 10);
	assert_eq!(result["tokens"]["total"], 20);
	assert_eq!(result["freshness"], "live");
	assert!(result.get("provider").is_none());
}

#[tokio::test]
async fn gjc_exec_state_reads_are_strict_registered_and_read_lane() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let methods = [
		("gjc/todos/read", "GjcTodosReadResult"),
		("gjc/usage/read", "GjcUsageReadResult"),
		("gjc/jobs/list", "GjcJobsListResult"),
		("gjc/agents/list", "GjcAgentsListResult"),
		("gjc/monitors/list", "GjcMonitorsListResult"),
		("gjc/compact/summary", "GjcCompactSummaryResult"),
	];
	let bundle = gjc_app_server::schema::schema_bundle();
	let catalog = bundle["methodCatalog"].as_array().unwrap();
	let definitions = bundle["definitions"].as_object().unwrap();
	let monitors_result = definitions["GjcMonitorsListResult"]["properties"]
		.as_object()
		.unwrap();
	assert!(monitors_result.contains_key("monitors"));
	assert!(monitors_result.contains_key("crons"));
	let monitor_entry = definitions["GjcMonitorEntry"]["properties"]
		.as_object()
		.unwrap();
	assert!(monitor_entry.contains_key("outputTail"));
	let cron_entry = definitions["GjcCronEntry"]["properties"]
		.as_object()
		.unwrap();
	for field in
		["id", "humanSchedule", "cronExpression", "prompt", "recurring", "nextFireAt", "createdAt"]
	{
		assert!(cron_entry.contains_key(field), "missing GjcCronEntry.{field}");
	}
	let monitors_bad = parse_inbound(&format!(
		r#"{{"id":499,"method":"gjc/monitors/list","params":{{"threadId":"{}","bogus":1}}}}"#,
		thread.0
	))
	.unwrap();
	assert_eq!(
		server
			.dispatch(&conn, monitors_bad)
			.await
			.unwrap()
			.error
			.unwrap()
			.code,
		gjc_app_server::error::codes::INVALID_PARAMS
	);
	for (idx, (method, result_def)) in methods.iter().enumerate() {
		assert_eq!(
			gjc_app_server::scheduler::classify(method),
			gjc_app_server::scheduler::Lane::Read
		);
		assert!(catalog.iter().any(|entry| entry["method"] == *method));
		assert!(definitions.contains_key(*result_def));
		let bad = parse_inbound(&format!(
			r#"{{"id":{},"method":"{}","params":{{"threadId":"{}","bogus":1}}}}"#,
			500 + idx,
			method,
			thread.0
		))
		.unwrap();
		assert_eq!(
			server
				.dispatch(&conn, bad)
				.await
				.unwrap()
				.error
				.unwrap()
				.code,
			gjc_app_server::error::codes::INVALID_PARAMS
		);
		let good = parse_inbound(&format!(
			r#"{{"id":{},"method":"{}","params":{{"threadId":"{}"}}}}"#,
			600 + idx,
			method,
			thread.0
		))
		.unwrap();
		assert!(server.dispatch(&conn, good).await.unwrap().error.is_none());
	}
}

#[tokio::test]
async fn gjc_g005_model_controls_are_strict_registered_and_laned() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	let cases = [
		(
			"gjc/model/catalog",
			"GjcThreadReadParams",
			"GjcModelCatalogResult",
			gjc_app_server::scheduler::Lane::Read,
			format!(r#"{{"threadId":"{}"}}"#, thread.0),
			format!(r#"{{"threadId":"{}","bogus":1}}"#, thread.0),
		),
		(
			"gjc/thinking/read",
			"GjcThreadReadParams",
			"GjcThinkingReadResult",
			gjc_app_server::scheduler::Lane::Read,
			format!(r#"{{"threadId":"{}"}}"#, thread.0),
			format!(r#"{{"threadId":"{}","bogus":1}}"#, thread.0),
		),
		(
			"gjc/thinking/set",
			"GjcThinkingSetParams",
			"GjcThinkingSetResult",
			gjc_app_server::scheduler::Lane::Mutating,
			format!(r#"{{"threadId":"{}","level":"high"}}"#, thread.0),
			format!(r#"{{"threadId":"{}","level":"high","bogus":1}}"#, thread.0),
		),
		(
			"gjc/fast/read",
			"GjcThreadReadParams",
			"GjcFastReadResult",
			gjc_app_server::scheduler::Lane::Read,
			format!(r#"{{"threadId":"{}"}}"#, thread.0),
			format!(r#"{{"threadId":"{}","bogus":1}}"#, thread.0),
		),
		(
			"gjc/fast/set",
			"GjcFastSetParams",
			"GjcFastSetResult",
			gjc_app_server::scheduler::Lane::Mutating,
			format!(r#"{{"threadId":"{}","enabled":true}}"#, thread.0),
			format!(r#"{{"threadId":"{}","enabled":true,"bogus":1}}"#, thread.0),
		),
		(
			"gjc/settings/schema",
			"GjcSettingsSchemaParams",
			"GjcSettingsSchemaResult",
			gjc_app_server::scheduler::Lane::Read,
			r"{}".to_string(),
			r#"{"bogus":1}"#.to_string(),
		),
		(
			"gjc/settings/read",
			"GjcSettingsReadParams",
			"GjcSettingsReadResult",
			gjc_app_server::scheduler::Lane::Read,
			r"{}".to_string(),
			r#"{"bogus":1}"#.to_string(),
		),
		(
			"gjc/settings/update",
			"GjcSettingsUpdateParams",
			"GjcSettingsUpdateResult",
			gjc_app_server::scheduler::Lane::Mutating,
			r#"{"key":"autoResume","value":true}"#.to_string(),
			r#"{"key":"autoResume","value":true,"bogus":1}"#.to_string(),
		),
		(
			"gjc/appearance/themes/list",
			"GjcAppearanceThemesListParams",
			"GjcAppearanceThemesListResult",
			gjc_app_server::scheduler::Lane::Read,
			r"{}".to_string(),
			r#"{"bogus":1}"#.to_string(),
		),
		(
			"gjc/appearance/read",
			"GjcAppearanceReadParams",
			"GjcAppearanceReadResult",
			gjc_app_server::scheduler::Lane::Read,
			r"{}".to_string(),
			r#"{"bogus":1}"#.to_string(),
		),
		(
			"gjc/appearance/set",
			"GjcAppearanceSetParams",
			"GjcAppearanceSetResult",
			gjc_app_server::scheduler::Lane::Mutating,
			r#"{"dark":"red-claw"}"#.to_string(),
			r#"{"dark":"red-claw","bogus":1}"#.to_string(),
		),
	];
	let bundle = gjc_app_server::schema::schema_bundle();
	let catalog = bundle["methodCatalog"].as_array().unwrap();
	let definitions = bundle["definitions"].as_object().unwrap();
	for (idx, (method, params_def, result_def, lane, good_params, bad_params)) in
		cases.iter().enumerate()
	{
		assert_eq!(gjc_app_server::scheduler::classify(method), *lane);
		assert!(catalog.iter().any(|entry| entry["method"] == *method
			&& entry["paramsDef"] == *params_def
			&& entry["resultDef"] == *result_def));
		assert!(definitions.contains_key(*params_def));
		assert!(definitions.contains_key(*result_def));
		let bad = parse_inbound(&format!(
			r#"{{"id":{},"method":"{}","params":{}}}"#,
			700 + idx,
			method,
			bad_params
		))
		.unwrap();
		assert_eq!(
			server
				.dispatch(&conn, bad)
				.await
				.unwrap()
				.error
				.unwrap()
				.code,
			gjc_app_server::error::codes::INVALID_PARAMS
		);
		let good = parse_inbound(&format!(
			r#"{{"id":{},"method":"{}","params":{}}}"#,
			800 + idx,
			method,
			good_params
		))
		.unwrap();
		assert!(server.dispatch(&conn, good).await.unwrap().error.is_none());
	}
	for (method, params) in [("gjc/settings/schema", "false"), ("gjc/settings/read", "[]")] {
		let req =
			parse_inbound(&format!(r#"{{"id":900,"method":"{method}","params":{params}}}"#)).unwrap();
		assert_eq!(
			server
				.dispatch(&conn, req)
				.await
				.unwrap()
				.error
				.unwrap()
				.code,
			gjc_app_server::error::codes::INVALID_PARAMS
		);
	}
}

#[test]
fn gjc_phase7_catalog_schema_and_lane_are_registered() {
	assert_eq!(
		gjc_app_server::scheduler::classify("gjc/context/read"),
		gjc_app_server::scheduler::Lane::Read
	);
	assert_eq!(
		gjc_app_server::scheduler::classify("gjc/goal/read"),
		gjc_app_server::scheduler::Lane::Read
	);
	assert_eq!(
		gjc_app_server::scheduler::classify("gjc/retry"),
		gjc_app_server::scheduler::Lane::Mutating
	);
	let bundle = gjc_app_server::schema::schema_bundle();
	let catalog = bundle["methodCatalog"].as_array().unwrap();
	let definitions = bundle["definitions"].as_object().unwrap();
	for (method, params, result) in [
		("gjc/context/read", "GjcContextReadParams", "GjcContextReadResult"),
		("gjc/goal/read", "GjcGoalReadParams", "GjcGoalReadResult"),
		("gjc/retry", "GjcRetryParams", "GjcRetryResult"),
	] {
		assert!(catalog.iter().any(|entry| entry["method"] == method));
		assert!(definitions.contains_key(params));
		assert!(definitions.contains_key(result));
	}
}

#[test]
fn gjc_command_and_extension_descriptor_schema_depth_is_registered() {
	let bundle = gjc_app_server::schema::schema_bundle();
	let definitions = bundle["definitions"].as_object().unwrap();
	let command = definitions["CommandDescriptor"]["properties"]
		.as_object()
		.unwrap();
	assert!(command.contains_key("classification"));
	let extension = definitions["ExtensionDescriptor"]["properties"]
		.as_object()
		.unwrap();
	for field in ["state", "disabledReason", "shadowedBy", "provider"] {
		assert!(extension.contains_key(field), "missing ExtensionDescriptor.{field}");
	}
	let json = serde_json::json!({
		"id": "slash-command:ship",
		"name": "ship",
		"kind": "slash-command",
		"source": "project",
		"status": "shadowed",
		"state": "shadowed",
		"disabledReason": "shadowed",
		"shadowedBy": "slash-command:ship",
		"provider": "gjc"
	});
	let descriptor: gjc_app_server::protocol::ExtensionDescriptor =
		serde_json::from_value(json).unwrap();
	assert_eq!(descriptor.state.as_deref(), Some("shadowed"));
	assert_eq!(descriptor.disabled_reason.as_deref(), Some("shadowed"));
	assert_eq!(descriptor.shadowed_by.as_deref(), Some("slash-command:ship"));
	assert_eq!(descriptor.provider.as_deref(), Some("gjc"));
}

#[tokio::test]
async fn gjc_session_reads_are_strict_and_registered_accept_cwd() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	for (id, method, params) in [
		(410, "gjc/session/list", r#"{"bogus":1}"#.to_string()),
		(411, "gjc/session/search", r#"{"query":"x","bogus":1}"#.to_string()),
		(412, "gjc/session/tree", format!(r#"{{"threadId":"{}","bogus":1}}"#, thread.0)),
	] {
		let req =
			parse_inbound(&format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#)).unwrap();
		let resp = server.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	}
	let empty =
		parse_inbound(r#"{"id":413,"method":"gjc/session/search","params":{"query":""}}"#).unwrap();
	let resp = server.dispatch(&conn, empty).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	let list =
		parse_inbound(r#"{"id":414,"method":"gjc/session/list","params":{"scope":"all"}}"#).unwrap();
	assert_eq!(server.dispatch(&conn, list).await.unwrap().result.unwrap()["total"], 1);
	let list_cwd = parse_inbound(
		r#"{"id":417,"method":"gjc/session/list","params":{"scope":"all","cwd":"/tmp/project"}}"#,
	)
	.unwrap();
	assert_eq!(
		server
			.dispatch(&conn, list_cwd)
			.await
			.unwrap()
			.result
			.unwrap()["total"],
		1
	);
	let search_cwd = parse_inbound(
		r#"{"id":418,"method":"gjc/session/search","params":{"query":"x","cwd":"/tmp/project"}}"#,
	)
	.unwrap();
	assert_eq!(
		server
			.dispatch(&conn, search_cwd)
			.await
			.unwrap()
			.result
			.unwrap()["total"],
		1
	);
}

#[tokio::test]
async fn gjc_session_rename_export_are_strict() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	for (id, method, params) in [
		(415, "gjc/session/rename", r#"{"sessionPath":"/tmp/a.jsonl","title":"x","bogus":1}"#),
		(416, "gjc/session/export", r#"{"sessionPath":"/tmp/a.jsonl","format":"json","bogus":1}"#),
		(419, "gjc/session/open", r#"{"sessionPath":"/tmp/a.jsonl","bogus":1}"#),
		(420, "gjc/session/delete", r#"{"sessionPath":"/tmp/a.jsonl","bogus":1}"#),
	] {
		let req =
			parse_inbound(&format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#)).unwrap();
		let resp = server.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	}
	let open_empty =
		parse_inbound(r#"{"id":421,"method":"gjc/session/open","params":{"sessionPath":""}}"#)
			.unwrap();
	let resp = server.dispatch(&conn, open_empty).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	let delete_empty =
		parse_inbound(r#"{"id":422,"method":"gjc/session/delete","params":{"sessionPath":""}}"#)
			.unwrap();
	let resp = server.dispatch(&conn, delete_empty).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	let open = parse_inbound(
		r#"{"id":428,"method":"gjc/session/open","params":{"sessionPath":"/tmp/a.jsonl"}}"#,
	)
	.unwrap();
	let open_result = server.dispatch(&conn, open).await.unwrap().result.unwrap();
	assert_eq!(open_result["resumed"], true);
	assert!(open_result["threadId"].as_str().is_some());
	let delete = parse_inbound(
		r#"{"id":429,"method":"gjc/session/delete","params":{"sessionPath":"/tmp/a.jsonl"}}"#,
	)
	.unwrap();
	assert_eq!(
		server
			.dispatch(&conn, delete)
			.await
			.unwrap()
			.result
			.unwrap()["ok"],
		true
	);
}

#[tokio::test]
async fn gjc_session_navigation_label_are_strict_dispatchable_and_validated() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	for (id, method, params) in [
		(
			423,
			"gjc/session/navigate",
			format!(r#"{{"threadId":"{}","entryId":"e1","bogus":1}}"#, thread.0),
		),
		(
			424,
			"gjc/session/label",
			format!(r#"{{"threadId":"{}","entryId":"e1","label":"x","bogus":1}}"#, thread.0),
		),
	] {
		let req =
			parse_inbound(&format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#)).unwrap();
		let resp = server.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	}
	let navigate = parse_inbound(&format!(
		r#"{{"id":425,"method":"gjc/session/navigate","params":{{"threadId":"{}","entryId":"e1","summarize":true}}}}"#,
		thread.0
	))
	.unwrap();
	assert_eq!(
		server
			.dispatch(&conn, navigate)
			.await
			.unwrap()
			.result
			.unwrap()["activeLeafId"],
		"leaf-1"
	);
	let label = parse_inbound(&format!(
		r#"{{"id":426,"method":"gjc/session/label","params":{{"threadId":"{}","entryId":"e1","label":""}}}}"#,
		thread.0
	))
	.unwrap();
	assert_eq!(server.dispatch(&conn, label).await.unwrap().result.unwrap()["ok"], true);
	let long_label = "x".repeat(201);
	let req = parse_inbound(&format!(
		r#"{{"id":427,"method":"gjc/session/label","params":{{"threadId":"{}","entryId":"e1","label":"{}"}}}}"#,
		thread.0, long_label
	))
	.unwrap();
	let resp = server.dispatch(&conn, req).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
}

#[test]
fn gjc_session_rename_export_catalog_schema_and_lane_are_registered() {
	let bundle = gjc_app_server::schema::schema_bundle();
	let catalog = bundle["methodCatalog"].as_array().unwrap();
	let definitions = bundle["definitions"].as_object().unwrap();
	for (method, params, result, lane) in [
		(
			"gjc/session/rename",
			"GjcSessionRenameParams",
			"GjcSessionRenameResult",
			gjc_app_server::scheduler::Lane::Mutating,
		),
		(
			"gjc/session/open",
			"GjcSessionOpenParams",
			"GjcSessionOpenResult",
			gjc_app_server::scheduler::Lane::Mutating,
		),
		(
			"gjc/session/delete",
			"GjcSessionDeleteParams",
			"GjcSessionDeleteResult",
			gjc_app_server::scheduler::Lane::Mutating,
		),
		(
			"gjc/session/export",
			"GjcSessionExportParams",
			"GjcSessionExportResult",
			gjc_app_server::scheduler::Lane::Read,
		),
		(
			"gjc/session/navigate",
			"GjcSessionNavigateParams",
			"GjcSessionNavigateResult",
			gjc_app_server::scheduler::Lane::Mutating,
		),
		(
			"gjc/session/label",
			"GjcSessionLabelParams",
			"GjcSessionLabelResult",
			gjc_app_server::scheduler::Lane::Mutating,
		),
	] {
		assert_eq!(gjc_app_server::scheduler::classify(method), lane);
		assert!(catalog.iter().any(|entry| entry["method"] == method));
		assert!(definitions.contains_key(params));
		assert!(definitions.contains_key(result));
	}
}

#[test]
fn gjc_session_reads_catalog_schema_and_lane_are_registered() {
	let bundle = gjc_app_server::schema::schema_bundle();
	let catalog = bundle["methodCatalog"].as_array().unwrap();
	let definitions = bundle["definitions"].as_object().unwrap();
	for (method, params, result) in [
		("gjc/session/list", "GjcSessionListParams", "GjcSessionListResult"),
		("gjc/session/search", "GjcSessionSearchParams", "GjcSessionSearchResult"),
		("gjc/session/tree", "GjcSessionTreeParams", "GjcSessionTreeResult"),
	] {
		assert_eq!(
			gjc_app_server::scheduler::classify(method),
			gjc_app_server::scheduler::Lane::Read
		);
		assert!(catalog.iter().any(|entry| entry["method"] == method));
		assert!(definitions.contains_key(params));
		assert!(definitions.contains_key(result));
	}
	assert!(definitions.contains_key("SessionIndexEntry"));
	assert!(definitions.contains_key("SessionTreeNodeDto"));
}

#[tokio::test]
async fn gjc_provider_auth_methods_are_strict() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	for (id, method, params) in [
		(430, "gjc/provider/list", r#"{"bogus":1}"#),
		(431, "gjc/auth/status", r#"{"bogus":1}"#),
		(432, "gjc/auth/logout", r#"{"providerId":"anthropic","bogus":1}"#),
	] {
		let req =
			parse_inbound(&format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#)).unwrap();
		let resp = server.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	}
	let missing = parse_inbound(r#"{"id":433,"method":"gjc/auth/logout","params":{}}"#).unwrap();
	let resp = server.dispatch(&conn, missing).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
}

#[test]
fn gjc_provider_auth_catalog_schema_and_lane_are_registered() {
	let bundle = gjc_app_server::schema::schema_bundle();
	let catalog = bundle["methodCatalog"].as_array().unwrap();
	let definitions = bundle["definitions"].as_object().unwrap();
	for (method, params, result, lane) in [
		(
			"gjc/provider/list",
			"GjcProviderListParams",
			"GjcProviderListResult",
			gjc_app_server::scheduler::Lane::Read,
		),
		(
			"gjc/auth/status",
			"GjcAuthStatusParams",
			"GjcAuthStatusResult",
			gjc_app_server::scheduler::Lane::Read,
		),
		(
			"gjc/auth/logout",
			"GjcAuthLogoutParams",
			"GjcAuthLogoutResult",
			gjc_app_server::scheduler::Lane::Mutating,
		),
	] {
		assert_eq!(gjc_app_server::scheduler::classify(method), lane);
		assert!(catalog.iter().any(|entry| entry["method"] == method
			&& entry["paramsDef"] == params
			&& entry["resultDef"] == result));
		assert!(definitions.contains_key(params));
		assert!(definitions.contains_key(result));
	}
	assert!(definitions.contains_key("GjcProviderListEntry"));
	assert!(definitions.contains_key("GjcAuthStatusEntry"));
}

#[tokio::test]
async fn gjc_stale_deferral_methods_are_strict() {
	let (server, _) = build();
	let conn = initialize(&server).await;
	let thread = start_thread(&server, &conn).await;
	for (id, method, params) in [
		(
			901,
			"gjc/session/move",
			format!(r#"{{"threadId":"{}","targetCwd":"/tmp","bogus":1}}"#, thread.0),
		),
		(902, "gjc/provider/add", r#"{"preset":"openai","apiKey":"raw"}"#.to_string()),
		(903, "gjc/auth/login/start", r#"{"providerId":"p","token":"x"}"#.to_string()),
		(904, "gjc/auth/login/poll", r#"{"flowId":"f","verifier":"x"}"#.to_string()),
		(
			905,
			"gjc/auth/login/complete",
			r#"{"flowId":"f","redirectUrl":"http://localhost","code":"x"}"#.to_string(),
		),
		(906, "gjc/auth/login/cancel", r#"{"flowId":"f","fingerprint":"x"}"#.to_string()),
		(
			907,
			"gjc/model/assign",
			format!(
				r#"{{"threadId":"{}","role":"main","provider":"p","modelId":"m","bogus":1}}"#,
				thread.0
			),
		),
		(
			908,
			"gjc/extensions/setEnabled",
			r#"{"extensionId":"e","enabled":true,"bogus":1}"#.to_string(),
		),
		(909, "gjc/skills/setEnabled", r#"{"skillId":"s","enabled":true,"bogus":1}"#.to_string()),
		(910, "gjc/plugins/setEnabled", r#"{"pluginId":"p","enabled":true,"bogus":1}"#.to_string()),
		(
			911,
			"gjc/plugins/setFeature",
			r#"{"pluginId":"p","feature":"f","enabled":true,"bogus":1}"#.to_string(),
		),
		(
			912,
			"gjc/plugins/setSetting",
			r#"{"pluginId":"p","key":"k","value":1,"bogus":1}"#.to_string(),
		),
	] {
		let req =
			parse_inbound(&format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#)).unwrap();
		let resp = server.dispatch(&conn, req).await.unwrap();
		assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
	}
	let missing_thread = parse_inbound(
		r#"{"id":913,"method":"gjc/model/assign","params":{"role":"main","provider":"p","modelId":"m"}}"#,
	)
	.unwrap();
	let resp = server.dispatch(&conn, missing_thread).await.unwrap();
	assert_eq!(resp.error.unwrap().code, gjc_app_server::error::codes::INVALID_PARAMS);
}

#[test]
fn gjc_stale_deferral_catalog_schema_lane_and_login_redaction_are_registered() {
	let bundle = gjc_app_server::schema::schema_bundle();
	let catalog = bundle["methodCatalog"].as_array().unwrap();
	let definitions = bundle["definitions"].as_object().unwrap();
	for (method, params, result) in [
		("gjc/session/move", "GjcSessionMoveParams", "GjcSessionMoveResult"),
		("gjc/provider/add", "GjcProviderAddParams", "GjcProviderAddResult"),
		("gjc/auth/login/start", "GjcAuthLoginStartParams", "GjcAuthLoginStartResult"),
		("gjc/auth/login/poll", "GjcAuthLoginPollParams", "GjcAuthLoginPollResult"),
		("gjc/auth/login/complete", "GjcAuthLoginCompleteParams", "GjcAuthLoginCompleteResult"),
		("gjc/auth/login/cancel", "GjcAuthLoginCancelParams", "GjcAuthLoginCancelResult"),
		("gjc/model/assign", "GjcModelAssignParams", "GjcModelAssignResult"),
		(
			"gjc/extensions/setEnabled",
			"GjcExtensionsSetEnabledParams",
			"GjcExtensionsSetEnabledResult",
		),
		("gjc/skills/setEnabled", "GjcSkillsSetEnabledParams", "GjcSkillsSetEnabledResult"),
		("gjc/plugins/setEnabled", "GjcPluginsSetEnabledParams", "GjcPluginsSetEnabledResult"),
		("gjc/plugins/setFeature", "GjcPluginsSetFeatureParams", "GjcPluginsSetFeatureResult"),
		("gjc/plugins/setSetting", "GjcPluginsSetSettingParams", "GjcPluginsSetSettingResult"),
	] {
		assert_eq!(
			gjc_app_server::scheduler::classify(method),
			gjc_app_server::scheduler::Lane::Mutating
		);
		assert!(catalog.iter().any(|entry| entry["method"] == method
			&& entry["paramsDef"] == params
			&& entry["resultDef"] == result));
		assert!(definitions.contains_key(params));
		assert!(definitions.contains_key(result));
	}
	let login_defs = serde_json::to_string(&serde_json::json!({
		"start": definitions.get("GjcAuthLoginStartResult"),
		"poll": definitions.get("GjcAuthLoginPollResult"),
		"complete": definitions.get("GjcAuthLoginCompleteResult"),
		"cancel": definitions.get("GjcAuthLoginCancelResult"),
	}))
	.unwrap();
	for forbidden in ["token", "verifier", "fingerprint", "code"] {
		assert!(!login_defs.contains(forbidden));
	}
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
			r#"{{"id":{id},"method":"gjc/hostTools/result","params":{params}}}"#
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

	async fn read_todos(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcTodosReadResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"todos":[{"id":"t1","content":"ship","status":"pending"}]}),
		)
		.unwrap())
	}

	async fn read_usage(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcUsageReadResult> {
		Ok(serde_json::from_value(serde_json::json!({"perModel":[{"modelId":"m","input":1,"output":2,"cost":0.1}],"totalCost":0.1,"source":"test","freshness":"live"})).unwrap())
	}

	async fn list_jobs(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcJobsListResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"jobs":[{"id":"j1","type":"monitor","status":"running"}]}),
		)
		.unwrap())
	}

	async fn list_agents(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAgentsListResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"agents":[{"id":"a1","agentType":"executor","status":"completed"}]}),
		)
		.unwrap())
	}

	async fn list_monitors(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcMonitorsListResult> {
		Ok(serde_json::from_value(
			serde_json::json!({"monitors":[{"id":"m1","kind":"monitor","status":"running","outputTail":"tail"}],"crons":[{"id":"cron-1","humanSchedule":"hourly","cronExpression":"0 * * * *","prompt":"ping","recurring":true,"nextFireAt":"2026-01-01T01:00:00Z","createdAt":"2026-01-01T00:00:00Z"}]}),
		)
		.unwrap())
	}

	async fn compact_summary(
		&self,
		_c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcCompactSummaryResult> {
		Ok(serde_json::from_value(serde_json::json!({"summaries":[{"id":"c1","summary":"sum","tokensBefore":3,"timestamp":"2026-01-01T00:00:00.000Z"}]})).unwrap())
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

	async fn session_list(
		&self,
		_params: gjc_app_server::protocol::GjcSessionListParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionListResult> {
		Ok(gjc_app_server::protocol::GjcSessionListResult {
			sessions: vec![gjc_app_server::protocol::SessionIndexEntry {
				id:            "s1".into(),
				title:         Some("Title".into()),
				first_message: Some("First".into()),
				cwd:           "/tmp/project".into(),
				path:          "/tmp/project/session.jsonl".into(),
				modified_at:   "2026-01-01T00:00:00.000Z".into(),
				entry_count:   Some(2),
			}],
			total:    1,
		})
	}

	async fn session_search(
		&self,
		_params: gjc_app_server::protocol::GjcSessionSearchParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionSearchResult> {
		self
			.session_list(gjc_app_server::protocol::GjcSessionListParams::default())
			.await
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
