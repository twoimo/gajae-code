//! N-API bridge for the codex-compatible app-server.
//!
//! Hosts the [`gjc_app_server`] core in-process and connects it to the
//! TypeScript `AgentSession` using the repo's inverted-control napi pattern
//! (mirrors [`crate::notifications`]): Rust owns protocol/registry/dispatch, and
//! backend/factory calls are forwarded to TS via a fire-and-forget
//! `ThreadsafeFunction`. TS satisfies each call and reports the result back
//! through [`AppServer::resolve_call`], which completes a tokio `oneshot` the
//! core is awaiting. Streamed frames are pushed to TS via the `on_frame`
//! callback.
//!
//! Call shape (JSON string on the `on_call` TSFN):
//! `{ "callId", "kind": "factory.create|factory.resume|factory.fork|backend.<method>",
//!    "threadId"?, "params" }`. TS resolves with
//! `resolveCall(callId, ok, json)`.

use std::{path::PathBuf, sync::{Arc, Mutex}};

use dashmap::DashMap;
use gjc_app_server::backend::{
    AgentBackend, BackendCallContext, BackendEvent, BackendFactory, BackendHandleInfo,
};
use gjc_app_server::ids::{BackendGeneration, ThreadId, TurnId};
use gjc_app_server::server::{AppServer as CoreAppServer, AppServerConfig, EventSink};
use gjc_app_server::{AppServerError, jsonrpc};
use gjc_app_server::transport_ws::{start_ws, WsServerConfig, WsServerHandle};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::oneshot;

/// Return the Rust-derived JSON Schema bundle string for the wire protocol.
#[napi]
#[must_use]
pub fn app_server_schema_json() -> String {
    gjc_app_server::schema::schema_bundle_string()
}

/// Classify a JSON-RPC method into its scheduling lane (`"mutating"`,
/// `"cancel"`, or `"read"`).
#[napi]
#[must_use]
pub fn app_server_method_lane(method: String) -> String {
    match gjc_app_server::scheduler::classify(&method) {
        gjc_app_server::scheduler::Lane::Mutating => "mutating".to_string(),
        gjc_app_server::scheduler::Lane::Cancel => "cancel".to_string(),
        gjc_app_server::scheduler::Lane::Read => "read".to_string(),
    }
}

/// Shared bridge state: the outbound call TSFN and the pending-call table.
struct Bridge {
    on_call: ThreadsafeFunction<String>,
    pending: DashMap<String, oneshot::Sender<std::result::Result<serde_json::Value, AppServerError>>>,
    next_call_id: std::sync::atomic::AtomicU64,
}

impl Bridge {
    fn new_call_id(&self) -> String {
        let n = self.next_call_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("call_{n:016x}")
    }

    /// Forward one call to TS and await the resolution reported via
    /// `resolveCall`.
    async fn call(
        &self,
        kind: &str,
        thread_id: Option<&ThreadId>,
        params: serde_json::Value,
    ) -> gjc_app_server::Result<serde_json::Value> {
        let call_id = self.new_call_id();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(call_id.clone(), tx);
        let payload = serde_json::json!({
            "callId": call_id,
            "kind": kind,
            "threadId": thread_id.map(|t| t.0.clone()),
            "params": params,
        });
        self.on_call.call(Ok(payload.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
        match rx.await {
            Ok(result) => result,
            Err(_) => {
                self.pending.remove(&call_id);
                Err(AppServerError::new(
                    gjc_app_server::error::codes::INTERNAL_ERROR,
                    "backend call dropped by host",
                ))
            }
        }
    }
}

/// A backend that routes every method to the TS host through the bridge.
struct TsBackend {
    thread_id: ThreadId,
    bridge: Arc<Bridge>,
}

impl TsBackend {
    async fn call(&self, method: &str, params: serde_json::Value) -> gjc_app_server::Result<serde_json::Value> {
        self.bridge.call(&format!("backend.{method}"), Some(&self.thread_id), params).await
    }
}

#[async_trait::async_trait]
impl AgentBackend for TsBackend {
    async fn prompt(&self, _c: &BackendCallContext, params: serde_json::Value) -> gjc_app_server::Result<TurnId> {
        let v = self.call("prompt", params).await?;
        Ok(TurnId(v.get("turnId").and_then(|s| s.as_str()).unwrap_or_default().to_string()))
    }
    async fn steer(&self, _c: &BackendCallContext, params: serde_json::Value) -> gjc_app_server::Result<TurnId> {
        let v = self.call("steer", params).await?;
        Ok(TurnId(v.get("turnId").and_then(|s| s.as_str()).unwrap_or_default().to_string()))
    }
    async fn abort(&self, _c: &BackendCallContext, turn_id: &TurnId) -> gjc_app_server::Result<()> {
        self.call("abort", serde_json::json!({ "turnId": turn_id.0 })).await.map(|_| ())
    }
    async fn get_state(&self, _c: &BackendCallContext, include: serde_json::Value) -> gjc_app_server::Result<serde_json::Value> {
        self.call("getState", serde_json::json!({ "include": include })).await
    }
    async fn get_messages(&self, _c: &BackendCallContext) -> gjc_app_server::Result<serde_json::Value> {
        self.call("getMessages", serde_json::Value::Null).await
    }
    async fn set_model(&self, _c: &BackendCallContext, provider: &str, model_id: &str) -> gjc_app_server::Result<serde_json::Value> {
        self.call("setModel", serde_json::json!({ "provider": provider, "modelId": model_id })).await
    }
    async fn compact(&self, _c: &BackendCallContext, custom: Option<&str>) -> gjc_app_server::Result<serde_json::Value> {
        self.call("compact", serde_json::json!({ "customInstructions": custom })).await
    }
    async fn set_todos(&self, _c: &BackendCallContext, phases: serde_json::Value) -> gjc_app_server::Result<()> {
        self.call("setTodos", phases).await.map(|_| ())
    }
    async fn exec(&self, _c: &BackendCallContext, params: serde_json::Value) -> gjc_app_server::Result<serde_json::Value> {
        self.call("exec", params).await
    }
    async fn dispose(&self, _c: &BackendCallContext) -> gjc_app_server::Result<()> {
        self.call("dispose", serde_json::Value::Null).await.map(|_| ())
    }
}

/// A factory that asks the TS host to create/resume/fork an `AgentSession`.
struct TsFactory {
    bridge: Arc<Bridge>,
}

impl TsFactory {
    async fn make(&self, kind: &str, params: serde_json::Value) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
        let v = self.bridge.call(kind, None, params).await?;
        let thread_id = ThreadId(
            v.get("threadId")
                .and_then(|s| s.as_str())
                .ok_or_else(|| AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, "host omitted threadId"))?
                .to_string(),
        );
        let session_metadata = v
            .get("sessionMetadata")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();
        let info = BackendHandleInfo { thread_id: thread_id.clone(), generation: BackendGeneration::FIRST, session_metadata };
        let backend: Arc<dyn AgentBackend> = Arc::new(TsBackend { thread_id, bridge: Arc::clone(&self.bridge) });
        Ok((info, backend))
    }
}

#[async_trait::async_trait]
impl BackendFactory for TsFactory {
    async fn create_thread(&self, p: serde_json::Value) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
        self.make("factory.create", p).await
    }
    async fn resume_thread(&self, p: serde_json::Value) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
        self.make("factory.resume", p).await
    }
    async fn fork_thread(&self, p: serde_json::Value) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
        self.make("factory.fork", p).await
    }
}

/// EventSink that forwards mapped frames to TS as JSON strings.
struct TsSink {
    on_frame: ThreadsafeFunction<String>,
}

impl EventSink for TsSink {
    fn emit(&self, note: jsonrpc::Notification) {
        if let Ok(s) = serde_json::to_string(&note) {
            self.on_frame.call(Ok(s), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

/// In-process app-server hosted in the Bun runtime and driven by the TS
/// `AgentSession` through the bridge callbacks.
#[napi]
pub struct AppServer {
    core: Arc<CoreAppServer>,
    bridge: Arc<Bridge>,
    ws_handle: Mutex<Option<WsServerHandle>>,
}

#[napi]
impl AppServer {
    /// Create the app-server. `onFrame(frameJson)` receives outbound JSON-RPC
    /// notifications; `onCall(callJson)` receives backend/factory calls that the
    /// host must satisfy and resolve via `resolveCall`.
    #[napi(constructor, ts_args_type = "onFrame: (err: null | Error, frame: string) => void, onCall: (err: null | Error, call: string) => void, maxInflightTurnsPerThread?: number")]
    pub fn new(
        on_frame: ThreadsafeFunction<String>,
        on_call: ThreadsafeFunction<String>,
        max_inflight_turns_per_thread: Option<u32>,
    ) -> Self {
        let bridge = Arc::new(Bridge {
            on_call,
            pending: DashMap::new(),
            next_call_id: std::sync::atomic::AtomicU64::new(1),
        });
        let config = AppServerConfig {
            max_inflight_turns_per_thread: max_inflight_turns_per_thread.unwrap_or(8) as usize,
            ..AppServerConfig::default()
        };
        let factory: Arc<dyn BackendFactory> = Arc::new(TsFactory { bridge: Arc::clone(&bridge) });
        let sink: Arc<dyn EventSink> = Arc::new(TsSink { on_frame });
        let core = Arc::new(CoreAppServer::new(factory, config, sink));
        Self { core, bridge, ws_handle: Mutex::new(None) }
    }

    /// Open a transport connection; returns its id.
    #[napi]
    pub fn open_connection(&self) -> String {
        self.core.open_connection().0
    }

    /// Close a transport connection.
    #[napi]
    pub fn close_connection(&self, connection_id: String) {
        self.core.close_connection(&gjc_app_server::ids::ConnectionId(connection_id));
    }

    /// Dispatch one newline-delimited JSON-RPC frame. Returns the response JSON
    /// string for requests, or `null` for notifications.
    #[napi]
    pub async fn dispatch(&self, connection_id: String, line: String) -> Option<String> {
        let conn = gjc_app_server::ids::ConnectionId(connection_id);
        let inbound = match jsonrpc::parse_inbound(&line) {
            Ok(inbound) => inbound,
            Err(err) => {
                // Malformed frames without an id cannot be correlated; emit a
                // best-effort error response with a null id.
                let resp = jsonrpc::Response::err(jsonrpc::RequestId::Number(0), err);
                return serde_json::to_string(&resp).ok();
            }
        };
        let resp = self.core.dispatch(&conn, inbound).await;
        resp.and_then(|r| serde_json::to_string(&r).ok())
    }

    /// Start a loopback WebSocket transport for this app-server; returns the bound ws:// URL.
    #[napi]
    pub async fn listen_ws(
        &self,
        host: String,
        port: u32,
        token: String,
        session_id: String,
        state_root: Option<String>,
    ) -> napi::Result<String> {
        let port = u16::try_from(port).map_err(|_| napi::Error::from_reason("port must be between 0 and 65535"))?;
        let state_root = state_root.map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let old = self
            .ws_handle
            .lock()
            .map_err(|_| napi::Error::from_reason("websocket handle lock poisoned"))?
            .take();
        if let Some(handle) = old {
            handle.shutdown().await.map_err(|err| napi::Error::from_reason(err.to_string()))?;
        }
        let handle = start_ws(
            Arc::clone(&self.core),
            WsServerConfig { host, port, token, session_id, state_root },
        )
        .await
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let url = handle.url();
        *self
            .ws_handle
            .lock()
            .map_err(|_| napi::Error::from_reason("websocket handle lock poisoned"))? = Some(handle);
        Ok(url)
    }

    /// Resolve a pending backend/factory call reported through `onCall`.
    /// `ok=true` treats `json` as the result value; `ok=false` treats `json` as
    /// `{code,message}` for a JSON-RPC error.
    #[napi]
    pub fn resolve_call(&self, call_id: String, ok: bool, json: String) {
        let Some((_, tx)) = self.bridge.pending.remove(&call_id) else {
            return;
        };
        let value: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
        let result = if ok {
            Ok(value)
        } else {
            let code = value.get("code").and_then(serde_json::Value::as_i64).unwrap_or(-32603) as i32;
            let message = value.get("message").and_then(|m| m.as_str()).unwrap_or("host error").to_string();
            Err(AppServerError::new(code, message))
        };
        let _ = tx.send(result);
    }

    /// Push a backend event (a gjc `AgentEvent`) for a thread. Returns the
    /// number of notifications emitted (0 if rejected as stale/unknown).
    #[napi]
    pub fn emit_backend_event(&self, thread_id: String, generation: i64, event_type: String, payload_json: String) -> u32 {
        let payload: serde_json::Value = serde_json::from_str(&payload_json).unwrap_or(serde_json::Value::Null);
        let ev = BackendEvent {
            thread_id: ThreadId(thread_id),
            generation: BackendGeneration(generation.max(0) as u64),
            event_type,
            payload,
        };
        self.core.emit_backend_event(&ev) as u32
    }

    /// The wire protocol schema bundle string.
    #[napi]
    #[must_use]
    pub fn schema_json(&self) -> String {
        app_server_schema_json()
    }
}
