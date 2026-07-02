//! App-server core: connection handshake gate, thread registry, and the
//! transport-agnostic request dispatcher that ties together identity,
//! scheduling/admission, the field policy, and the `AgentBackend` seam.
//!
//! This is transport-agnostic: transports (stdio/ws/unix, in pi-natives) parse
//! frames and call [`AppServer::dispatch`]/[`AppServer::handle_connection_*`].
//! Full concurrent running turns are supported — each thread has its own backend
//! and admission slots, and dispatch does not hold a global lock across backend
//! calls.

use std::sync::Arc;

use dashmap::DashMap;
use parking_lot::Mutex;

use crate::backend::{AgentBackend, BackendCallContext, BackendEvent, BackendFactory};
use crate::error::{AppServerError, Result};
use crate::event_map::ThreadStream;
use crate::identity::{ThreadIdentity, ThreadStatus};
use crate::ids::{ConnectionId, ThreadId, TurnId};
use crate::jsonrpc::{Inbound, Notification, Response};
use crate::scheduler::{Admission, Lane};

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
}



/// Per-connection handshake state.
#[derive(Default)]
struct ConnectionState {
    /// Set once the `initialize` request has been answered.
    initialize_seen: bool,
    /// Set once the `initialized` notification acks the handshake.
    initialized: bool,
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
}

impl AppServer {
    #[must_use]
    pub fn new(factory: Arc<dyn BackendFactory>, config: AppServerConfig, sink: Arc<dyn EventSink>) -> Self {
        Self { factory, threads: DashMap::new(), connections: DashMap::new(), config, sink }
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
        if !entry.value().identity.lock().accepts_event(&ev.thread_id, ev.generation) {
            return 0;
        }
        let notes = entry.value().stream.lock().on_event(ev);
        let n = notes.len();
        for note in notes {
            self.sink.emit(note);
        }
        n
    }

    pub fn open_connection(&self) -> ConnectionId {
        let id = ConnectionId::generate();
        self.connections.insert(id.clone(), Mutex::new(ConnectionState::default()));
        id
    }

    pub fn close_connection(&self, conn: &ConnectionId) {
        self.connections.remove(conn);
    }

    fn require_initialized(&self, conn: &ConnectionId) -> Result<()> {
        let entry = self
            .connections
            .get(conn)
            .ok_or_else(|| AppServerError::new(crate::error::codes::INVALID_REQUEST, "unknown connection"))?;
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
    pub async fn dispatch(&self, conn: &ConnectionId, inbound: Inbound) -> Option<Response> {
        match inbound {
            Inbound::Notification(note) => {
                // The only bootstrap notification is `initialized`.
                if note.method == "initialized"
                    && let Some(c) = self.connections.get(conn) {
                        c.value().lock().initialized = true;
                    }
                None
            }
            Inbound::Request(req) => {
                let id = req.id.clone();
                let result = self.dispatch_request(conn, &req.method, req.params).await;
                Some(match result {
                    Ok(value) => Response::ok(id, value),
                    Err(err) => Response::err(id, err),
                })
            }
        }
    }

    async fn dispatch_request(
        &self,
        conn: &ConnectionId,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        // The initialize handshake is the only request allowed pre-init.
        if method == "initialize" {
            return self.handle_initialize(conn);
        }
        self.require_initialized(conn)?;

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
            "gjc/state/read" => self.handle_gjc_state_read(params).await,
            "gjc/messages/get" => self.handle_gjc_messages_get(params).await,
            "gjc/model/set" => self.handle_gjc_model_set(method, params).await,
            "gjc/todos/set" => self.handle_gjc_todos_set(method, params).await,
            "gjc/compact" => self.handle_gjc_compact(method, params).await,
            other => Err(AppServerError::method_not_found(other)),
        }
    }

    /// Resolve a thread's backend + a call context on the given lane, without
    /// holding the registry lock across the returned backend (so calls run
    /// concurrently across threads).
    fn backend_and_ctx(&self, thread_id: &ThreadId, lane: Lane) -> Result<(Arc<dyn AgentBackend>, BackendCallContext)> {
        let entry = self.threads.get(thread_id).ok_or_else(|| AppServerError::not_found("thread not found"))?;
        let generation = entry.value().identity.lock().generation;
        let ctx = BackendCallContext { thread_id: thread_id.clone(), generation, request_id: None, lane };
        Ok((Arc::clone(&entry.value().backend), ctx)
        )
    }

    async fn handle_turn_steer(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let (backend, ctx) = {
            let entry = self.threads.get(&thread_id).ok_or_else(|| AppServerError::not_found("thread not found"))?;
            Self::check_expected_turn(entry.value(), &params)?;
            let identity = entry.value().identity.lock();
            let ctx = BackendCallContext {
                thread_id: thread_id.clone(),
                generation: identity.generation,
                request_id: None,
                lane: Lane::Mutating,
            };
            (Arc::clone(&entry.value().backend), ctx)
        };
        let turn_id = backend.steer(&ctx, params.unwrap_or(serde_json::Value::Null)).await?;
        Ok(serde_json::json!({ "turnId": turn_id.0 }))
    }
    fn check_expected_turn(entry: &ThreadEntry, params: &Option<serde_json::Value>) -> Result<()> {
        let expected = params
            .as_ref()
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


    async fn handle_gjc_state_read(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
        let include = params.as_ref().and_then(|p| p.get("include")).cloned().unwrap_or(serde_json::Value::Null);
        backend.get_state(&ctx, include).await
    }

    async fn handle_gjc_messages_get(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Read)?;
        backend.get_messages(&ctx).await
    }

    async fn handle_gjc_model_set(&self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        // gjc/* is strict: reject unknown fields.
        crate::field_policy::enforce(method, params.as_ref(), &["threadId", "provider", "modelId"])?;
        let thread_id = extract_thread_id(&params)?;
        let provider = extract_str(&params, "provider")?;
        let model_id = extract_str(&params, "modelId")?;
        let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
        backend.set_model(&ctx, &provider, &model_id).await
    }

    async fn handle_gjc_todos_set(&self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        crate::field_policy::enforce(method, params.as_ref(), &["threadId", "phases"])?;
        let thread_id = extract_thread_id(&params)?;
        let phases = params.as_ref().and_then(|p| p.get("phases")).cloned().unwrap_or(serde_json::Value::Null);
        let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
        backend.set_todos(&ctx, phases).await?;
        Ok(serde_json::json!({}))
    }

    async fn handle_command_exec(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
        backend.exec(&ctx, params.unwrap_or(serde_json::Value::Null)).await
    }

    async fn handle_thread_shell_command(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let command = params.as_ref().and_then(|p| p.get("command")).cloned().unwrap_or(serde_json::Value::Null);
        let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
        backend.exec(&ctx, command).await
    }

    async fn handle_gjc_compact(&self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        crate::field_policy::enforce(method, params.as_ref(), &["threadId", "customInstructions"])?;
        let thread_id = extract_thread_id(&params)?;
        let custom = params.as_ref().and_then(|p| p.get("customInstructions")).and_then(|v| v.as_str());
        let (backend, ctx) = self.backend_and_ctx(&thread_id, Lane::Mutating)?;
        backend.compact(&ctx, custom).await
    }

    fn handle_initialize(&self, conn: &ConnectionId) -> Result<serde_json::Value> {
        // Lenient: unknown initialize fields are ignored. A second initialize
        // request on the same connection is rejected ("Already initialized").
        let entry = self
            .connections
            .get(conn)
            .ok_or_else(|| AppServerError::new(crate::error::codes::INVALID_REQUEST, "unknown connection"))?;
        {
            let mut state = entry.value().lock();
            if state.initialize_seen {
                return Err(AppServerError::new(crate::error::codes::INVALID_REQUEST, "Already initialized"));
            }
            state.initialize_seen = true;
        }
        Ok(serde_json::json!({
            "userAgent": concat!("gjc-app-server/", env!("CARGO_PKG_VERSION")),
            "platformOs": std::env::consts::OS,
            "platformFamily": std::env::consts::FAMILY,
        }))
    }

    async fn handle_thread_start(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let (info, backend) = self.factory.create_thread(params.unwrap_or(serde_json::Value::Null)).await?;
        Ok(serde_json::json!({ "thread": self.register(info, backend) }))
    }

    async fn handle_thread_resume(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let (info, backend) = self.factory.resume_thread(params.unwrap_or(serde_json::Value::Null)).await?;
        Ok(serde_json::json!({ "thread": self.register(info, backend) }))
    }

    async fn handle_thread_fork(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let (info, backend) = self.factory.fork_thread(params.unwrap_or(serde_json::Value::Null)).await?;
        Ok(serde_json::json!({ "thread": self.register(info, backend) }))
    }

    /// Register a freshly created/resumed/forked backend in the thread registry
    /// and return the `thread` object for the response.
    fn register(&self, info: crate::backend::BackendHandleInfo, backend: Arc<dyn AgentBackend>) -> serde_json::Value {
        let identity = ThreadIdentity::new(info.thread_id.clone(), info.session_metadata.clone());
        let forked_from = identity.metadata.forked_from_id.as_ref().map(|t| t.0.clone());
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
            },
        );
        let mut thread = serde_json::json!({ "id": info.thread_id.0, "status": "idle", "turns": [] });
        if let Some(from) = forked_from {
            thread["forkedFromId"] = serde_json::Value::String(from);
        }
        thread
    }

    async fn handle_thread_delete(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let (backend, ctx) = {
            let entry = self.threads.get(&thread_id).ok_or_else(|| AppServerError::not_found("thread not found"))?;
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
        self.threads.remove(&thread_id);
        Ok(serde_json::json!({}))
    }

    fn handle_thread_archive(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let entry = self.threads.get(&thread_id).ok_or_else(|| AppServerError::not_found("thread not found"))?;
        let mut identity = entry.value().identity.lock();
        if identity.status == ThreadStatus::Running {
            return Err(AppServerError::conflict("cannot archive a thread with an active turn"));
        }
        identity.status = ThreadStatus::Archived;
        Ok(serde_json::json!({}))
    }

    fn handle_thread_read(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let entry = self.threads.get(&thread_id).ok_or_else(|| AppServerError::not_found("thread not found"))?;
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

    async fn handle_turn_start(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        // Snapshot backend + context, admit a turn slot, then call the backend
        // WITHOUT holding any registry lock (enables concurrent turns).
        let (backend, ctx) = {
            let entry = self.threads.get(&thread_id).ok_or_else(|| AppServerError::not_found("thread not found"))?;
            Self::check_expected_turn(entry.value(), &params)?;
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

        let turn_result = backend.prompt(&ctx, params.unwrap_or(serde_json::Value::Null)).await;

        // Release the admission slot regardless of outcome (a real impl releases
        // on turn/completed; here the fake completes synchronously).
        if let Some(entry) = self.threads.get(&thread_id) {
            entry.value().admission.lock().complete_turn();
        }
        let turn_id = turn_result?;
        if let Some(entry) = self.threads.get(&thread_id) {
            *entry.value().active_turn.lock() = Some(turn_id.clone());
            entry.value().identity.lock().status = ThreadStatus::Running;
        }
        Ok(serde_json::json!({ "turn": { "id": turn_id.0, "status": "inProgress" } }))
    }

    async fn handle_turn_interrupt(&self, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
        let thread_id = extract_thread_id(&params)?;
        let turn_id = params
            .as_ref()
            .and_then(|p| p.get("turnId"))
            .and_then(|v| v.as_str())
            .map(|s| crate::ids::TurnId(s.to_string()))
            .ok_or_else(|| AppServerError::invalid_params("missing turnId"))?;
        let (backend, ctx) = {
            let entry = self.threads.get(&thread_id).ok_or_else(|| AppServerError::not_found("thread not found"))?;
            let identity = entry.value().identity.lock();
            let ctx = BackendCallContext {
                thread_id: thread_id.clone(),
                generation: identity.generation,
                request_id: None,
                lane: Lane::Cancel,
            };
            (Arc::clone(&entry.value().backend), ctx)
        };
        backend.abort(&ctx, &turn_id).await?;
        Ok(serde_json::json!({}))
    }
}

fn extract_thread_id(params: &Option<serde_json::Value>) -> Result<ThreadId> {
    params
        .as_ref()
        .and_then(|p| p.get("threadId"))
        .and_then(|v| v.as_str())
        .map(|s| ThreadId(s.to_string()))
        .ok_or_else(|| AppServerError::invalid_params("missing threadId"))
}

fn extract_str(params: &Option<serde_json::Value>, key: &str) -> Result<String> {
    params
        .as_ref()
        .and_then(|p| p.get(key))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| AppServerError::invalid_params(format!("missing `{key}`")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::BackendHandleInfo;
    use crate::identity::SessionMetadata;
    use crate::ids::BackendGeneration;
    use async_trait::async_trait;
    use std::time::Duration;

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
        async fn get_state(&self, _c: &BackendCallContext, _i: serde_json::Value) -> Result<serde_json::Value> {
            Ok(serde_json::json!({}))
        }
        async fn get_messages(&self, _c: &BackendCallContext) -> Result<serde_json::Value> {
            Ok(serde_json::json!([]))
        }
        async fn set_model(&self, _c: &BackendCallContext, _p: &str, _m: &str) -> Result<serde_json::Value> {
            Ok(serde_json::json!({}))
        }
        async fn compact(&self, _c: &BackendCallContext, _ci: Option<&str>) -> Result<serde_json::Value> {
            Ok(serde_json::json!({}))
        }
        async fn set_todos(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<()> {
            Ok(())
        }
        async fn exec(&self, c: &BackendCallContext, p: serde_json::Value) -> Result<serde_json::Value> {
            Ok(serde_json::json!({ "lane": format!("{:?}", c.lane), "params": p }))
        }
        async fn dispose(&self, _c: &BackendCallContext) -> Result<()> {
            Ok(())
        }
    }

    struct SlowFactory;

    #[async_trait]
    impl BackendFactory for SlowFactory {
        async fn create_thread(&self, _p: serde_json::Value) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
            let info = BackendHandleInfo {
                thread_id: ThreadId::generate(),
                generation: BackendGeneration::FIRST,
                session_metadata: SessionMetadata::default(),
            };
            Ok((info, Arc::new(SlowBackend)))
        }
        async fn resume_thread(&self, p: serde_json::Value) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
            self.create_thread(p).await
        }
        async fn fork_thread(&self, p: serde_json::Value) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
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
        Arc::new(AppServer::new(Arc::new(SlowFactory), AppServerConfig::default(), Arc::new(CollectingSink::default())))
    }

    fn server_with_sink() -> (Arc<AppServer>, Arc<CollectingSink>) {
        let sink = Arc::new(CollectingSink::default());
        let s = Arc::new(AppServer::new(Arc::new(SlowFactory), AppServerConfig::default(), sink.clone()));
        (s, sink)
    }

    async fn init_conn(s: &AppServer) -> ConnectionId {
        let conn = s.open_connection();
        let init = crate::jsonrpc::parse_inbound(r#"{"id":0,"method":"initialize","params":{"unknownField":1}}"#).unwrap();
        let resp = s.dispatch(&conn, init).await.unwrap();
        assert!(resp.error.is_none(), "initialize should ignore unknown fields");
        let acked = crate::jsonrpc::parse_inbound(r#"{"method":"initialized"}"#).unwrap();
        assert!(s.dispatch(&conn, acked).await.is_none());
        conn
    }

    async fn start_thread(s: &AppServer, conn: &ConnectionId) -> ThreadId {
        let req = crate::jsonrpc::parse_inbound(r#"{"id":1,"method":"thread/start","params":{"cwd":"/p"}}"#).unwrap();
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
            thread_id: t.clone(),
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
        assert!(resp.result.unwrap()["turnId"].as_str().unwrap().starts_with("turn_"));
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
        let turn_id = resp.result.unwrap()["turn"]["id"].as_str().unwrap().to_string();
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
        let turn_id = start_resp.result.unwrap()["turn"]["id"].as_str().unwrap().to_string();
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
            assert!(resp.result.unwrap()["thread"]["id"].as_str().unwrap().starts_with("thr_"));
        }
    }
}
