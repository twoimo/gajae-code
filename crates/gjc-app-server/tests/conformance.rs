//! app-server-conformance suite (integration).
//!
//! Exercises the public core end-to-end through the JSON-RPC surface: the
//! initialize handshake, thread lifecycle, a full streamed turn mapped from
//! backend events, concurrent two-thread streaming, stale-event rejection, and
//! gjc/* strict field rejection. This is the named acceptance suite referenced
//! by the plan; it grows as protocol surface is added.

use std::sync::Arc;

use async_trait::async_trait;
use gjc_app_server::backend::{
    AgentBackend, BackendCallContext, BackendEvent, BackendFactory, BackendHandleInfo,
};
use gjc_app_server::identity::SessionMetadata;
use gjc_app_server::ids::{BackendGeneration, ThreadId, TurnId};
use gjc_app_server::jsonrpc::{Notification, parse_inbound};
use gjc_app_server::server::{AppServer, AppServerConfig, EventSink};
use parking_lot::Mutex;

// ---- test doubles -----------------------------------------------------------

struct EchoBackend;

#[async_trait]
impl AgentBackend for EchoBackend {
    async fn prompt(&self, _c: &BackendCallContext, _p: serde_json::Value) -> gjc_app_server::Result<TurnId> {
        Ok(TurnId::generate())
    }
    async fn steer(&self, _c: &BackendCallContext, _p: serde_json::Value) -> gjc_app_server::Result<TurnId> {
        Ok(TurnId::generate())
    }
    async fn abort(&self, _c: &BackendCallContext, _t: &TurnId) -> gjc_app_server::Result<()> {
        Ok(())
    }
    async fn get_state(&self, _c: &BackendCallContext, _i: serde_json::Value) -> gjc_app_server::Result<serde_json::Value> {
        Ok(serde_json::json!({ "status": "idle" }))
    }
    async fn get_messages(&self, _c: &BackendCallContext) -> gjc_app_server::Result<serde_json::Value> {
        Ok(serde_json::json!([]))
    }
    async fn set_model(&self, _c: &BackendCallContext, provider: &str, model_id: &str) -> gjc_app_server::Result<serde_json::Value> {
        Ok(serde_json::json!({ "provider": provider, "modelId": model_id }))
    }
    async fn compact(&self, _c: &BackendCallContext, _ci: Option<&str>) -> gjc_app_server::Result<serde_json::Value> {
        Ok(serde_json::json!({ "compacted": true }))
    }
    async fn set_todos(&self, _c: &BackendCallContext, _p: serde_json::Value) -> gjc_app_server::Result<()> {
        Ok(())
    }
    async fn exec(&self, _c: &BackendCallContext, _p: serde_json::Value) -> gjc_app_server::Result<serde_json::Value> {
        Ok(serde_json::json!({ "exitCode": 0 }))
    }
    async fn dispose(&self, _c: &BackendCallContext) -> gjc_app_server::Result<()> {
        Ok(())
    }
}

struct EchoFactory;

#[async_trait]
impl BackendFactory for EchoFactory {
    async fn create_thread(&self, _p: serde_json::Value) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
        let info = BackendHandleInfo {
            thread_id: ThreadId::generate(),
            generation: BackendGeneration::FIRST,
            session_metadata: SessionMetadata::default(),
        };
        Ok((info, Arc::new(EchoBackend)))
    }
    async fn resume_thread(&self, p: serde_json::Value) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
        self.create_thread(p).await
    }
    async fn fork_thread(&self, p: serde_json::Value) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
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

impl CollectingSink {
    fn methods(&self) -> Vec<String> {
        self.notes.lock().iter().map(|n| n.method.clone()).collect()
    }
}

// ---- helpers ----------------------------------------------------------------

fn build() -> (Arc<AppServer>, Arc<CollectingSink>) {
    let sink = Arc::new(CollectingSink::default());
    let server = Arc::new(AppServer::new(Arc::new(EchoFactory), AppServerConfig::default(), sink.clone()));
    (server, sink)
}

async fn initialize(server: &AppServer) -> gjc_app_server::ConnectionId {
    let conn = server.open_connection();
    let init = parse_inbound(r#"{"id":0,"method":"initialize","params":{"clientInfo":{"name":"conf"}}}"#).unwrap();
    let resp = server.dispatch(&conn, init).await.unwrap();
    assert!(resp.error.is_none());
    let acked = parse_inbound(r#"{"method":"initialized"}"#).unwrap();
    assert!(server.dispatch(&conn, acked).await.is_none());
    conn
}

async fn start_thread(server: &AppServer, conn: &gjc_app_server::ConnectionId) -> ThreadId {
    let req = parse_inbound(r#"{"id":1,"method":"thread/start","params":{"cwd":"/repo"}}"#).unwrap();
    let resp = server.dispatch(conn, req).await.unwrap();
    ThreadId(resp.result.unwrap()["thread"]["id"].as_str().unwrap().to_string())
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
    let a_completed = notes.iter().filter(|n| n.method == "turn/completed" && n.params.as_ref().unwrap()["threadId"] == a.0).count();
    let b_completed = notes.iter().filter(|n| n.method == "turn/completed" && n.params.as_ref().unwrap()["threadId"] == b.0).count();
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
    let resp = gjc_app_server::jsonrpc::Response::err(gjc_app_server::jsonrpc::RequestId::Number(1), err);
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
