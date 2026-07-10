//! N-API bridge for the codex-compatible app-server.
//!
//! Hosts the [`gjc_app_server`] core in-process and connects it to the
//! TypeScript `AgentSession` using the repo's inverted-control napi pattern
//! (mirrors [`crate::notifications`]): Rust owns protocol/registry/dispatch,
//! and backend/factory calls are forwarded to TS via a fire-and-forget
//! `ThreadsafeFunction`. TS satisfies each call and reports the result back
//! through [`AppServer::resolve_call`], which completes a tokio `oneshot` the
//! core is awaiting. Streamed frames are pushed to TS via the `on_frame`
//! callback.
//!
//! Call shape (JSON string on the `on_call` TSFN):
//! `{ "callId", "kind":
//! "factory.create|factory.resume|factory.fork|backend.<method>",    "threadId"
//! ?, "params" }`. TS resolves with `resolveCall(callId, ok, json)`.

use std::{
	path::PathBuf,
	sync::{Arc, Mutex},
};

use dashmap::DashMap;
use gjc_app_server::{
	AppServerError,
	backend::{AgentBackend, BackendCallContext, BackendEvent, BackendFactory, BackendHandleInfo},
	ids::{BackendGeneration, ThreadId, TurnId},
	jsonrpc,
	server::{AppServer as CoreAppServer, AppServerConfig, EventSink},
	transport_ws::{WsServerConfig, WsServerHandle, start_ws},
};
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
	pending:
		DashMap<String, oneshot::Sender<std::result::Result<serde_json::Value, AppServerError>>>,
	next_call_id: std::sync::atomic::AtomicU64,
}

impl Bridge {
	fn new_call_id(&self) -> String {
		let n = self
			.next_call_id
			.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
		format!("call_{n:016x}")
	}

	/// Forward one call to TS and await the resolution reported via
	/// `resolveCall`.
	async fn call(
		&self,
		kind: &str,
		thread_id: Option<&ThreadId>,
		generation: Option<BackendGeneration>,
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
			 "generation": generation.map(|g| g.0),
		});
		let status = self
			.on_call
			.call(Ok(payload.to_string()), ThreadsafeFunctionCallMode::NonBlocking);
		if status != napi::Status::Ok {
			// The JS callback queue is closed/full: fail fast instead of hanging
			// on a resolution that will never arrive.
			self.pending.remove(&call_id);
			return Err(AppServerError::new(
				gjc_app_server::error::codes::INTERNAL_ERROR,
				"host call could not be enqueued",
			));
		}
		let Ok(result) = rx.await else {
			self.pending.remove(&call_id);
			return Err(AppServerError::new(
				gjc_app_server::error::codes::INTERNAL_ERROR,
				"backend call dropped by host",
			));
		};
		result
	}
}

/// A backend that routes every method to the TS host through the bridge.
struct TsBackend {
	thread_id: ThreadId,
	bridge: Arc<Bridge>,
}

impl TsBackend {
	async fn call(
		&self,
		ctx: &BackendCallContext,
		method: &str,
		params: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		self
			.bridge
			.call(&format!("backend.{method}"), Some(&self.thread_id), Some(ctx.generation), params)
			.await
	}

	async fn typed_call<T: serde::de::DeserializeOwned>(
		&self,
		ctx: &BackendCallContext,
		method: &str,
	) -> gjc_app_server::Result<T> {
		let value = self.call(ctx, method, serde_json::Value::Null).await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
}

#[async_trait::async_trait]
impl AgentBackend for TsBackend {
	async fn prompt(
		&self,
		c: &BackendCallContext,
		params: serde_json::Value,
	) -> gjc_app_server::Result<TurnId> {
		let v = self.call(c, "prompt", params).await?;
		let turn_id = v
			.get("turnId")
			.and_then(|s| s.as_str())
			.filter(|s| !s.is_empty())
			.ok_or_else(|| {
				AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, "host omitted turnId")
			})?;
		Ok(TurnId(turn_id.to_string()))
	}

	async fn steer(
		&self,
		c: &BackendCallContext,
		params: serde_json::Value,
	) -> gjc_app_server::Result<TurnId> {
		let v = self.call(c, "steer", params).await?;
		let turn_id = v
			.get("turnId")
			.and_then(|s| s.as_str())
			.filter(|s| !s.is_empty())
			.ok_or_else(|| {
				AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, "host omitted turnId")
			})?;
		Ok(TurnId(turn_id.to_string()))
	}

	async fn abort(&self, c: &BackendCallContext, turn_id: &TurnId) -> gjc_app_server::Result<()> {
		self
			.call(c, "abort", serde_json::json!({ "turnId": turn_id.0 }))
			.await
			.map(|_| ())
	}

	async fn retry(&self, c: &BackendCallContext) -> gjc_app_server::Result<TurnId> {
		let v = self.call(c, "retry", serde_json::Value::Null).await?;
		let turn_id = v
			.get("turnId")
			.and_then(|s| s.as_str())
			.filter(|s| !s.is_empty())
			.ok_or_else(|| {
				AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, "host omitted turnId")
			})?;
		Ok(TurnId(turn_id.to_string()))
	}
	async fn get_state(
		&self,
		c: &BackendCallContext,
		include: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		self
			.call(c, "getState", serde_json::json!({ "include": include }))
			.await
	}

	async fn read_context(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcContextReadResult> {
		let value = self.call(c, "readContext", serde_json::Value::Null).await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn read_goal(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcGoalReadResult> {
		self.typed_call(c, "readGoal").await
	}

	async fn model_catalog(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcModelCatalogResult> {
		self.typed_call(c, "modelCatalog").await
	}
	async fn read_thinking(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcThinkingReadResult> {
		self.typed_call(c, "readThinking").await
	}
	async fn set_thinking(
		&self,
		c: &BackendCallContext,
		level: String,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcThinkingSetResult> {
		let value = self
			.call(c, "setThinking", serde_json::json!({"level": level}))
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn read_fast(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcFastReadResult> {
		self.typed_call(c, "readFast").await
	}
	async fn set_fast(
		&self,
		c: &BackendCallContext,
		enabled: bool,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcFastSetResult> {
		let value = self
			.call(c, "setFast", serde_json::json!({"enabled": enabled}))
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn read_todos(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcTodosReadResult> {
		self.typed_call(c, "readTodos").await
	}
	async fn read_usage(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcUsageReadResult> {
		self.typed_call(c, "readUsage").await
	}
	async fn list_jobs(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcJobsListResult> {
		self.typed_call(c, "listJobs").await
	}
	async fn list_agents(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAgentsListResult> {
		self.typed_call(c, "listAgents").await
	}
	async fn list_monitors(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcMonitorsListResult> {
		self.typed_call(c, "listMonitors").await
	}
	async fn compact_summary(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcCompactSummaryResult> {
		self.typed_call(c, "compactSummary").await
	}

	async fn session_tree(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionTreeResult> {
		let value = self.call(c, "sessionTree", serde_json::Value::Null).await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn session_navigate(
		&self,
		c: &BackendCallContext,
		params: gjc_app_server::protocol::GjcSessionNavigateParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionNavigateResult> {
		let value = self
			.call(
				c,
				"sessionNavigate",
				serde_json::to_value(params).unwrap_or(serde_json::Value::Null),
			)
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn session_move(
		&self,
		c: &BackendCallContext,
		params: gjc_app_server::protocol::GjcSessionMoveParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionMoveResult> {
		let value = self
			.call(c, "sessionMove", serde_json::to_value(params).unwrap_or(serde_json::Value::Null))
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn get_messages(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<serde_json::Value> {
		self.call(c, "getMessages", serde_json::Value::Null).await
	}

	async fn set_model(
		&self,
		c: &BackendCallContext,
		provider: &str,
		model_id: &str,
	) -> gjc_app_server::Result<serde_json::Value> {
		self
			.call(c, "setModel", serde_json::json!({ "provider": provider, "modelId": model_id }))
			.await
	}

	async fn model_assign(
		&self,
		c: &BackendCallContext,
		params: gjc_app_server::protocol::GjcModelAssignParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcModelAssignResult> {
		let value = self
			.call(c, "modelAssign", serde_json::to_value(params).unwrap_or(serde_json::Value::Null))
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn compact(
		&self,
		c: &BackendCallContext,
		custom: Option<&str>,
	) -> gjc_app_server::Result<serde_json::Value> {
		self
			.call(c, "compact", serde_json::json!({ "customInstructions": custom }))
			.await
	}

	async fn set_todos(
		&self,
		c: &BackendCallContext,
		phases: serde_json::Value,
	) -> gjc_app_server::Result<()> {
		self.call(c, "setTodos", phases).await.map(|_| ())
	}

	async fn exec(
		&self,
		c: &BackendCallContext,
		params: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		self.call(c, "exec", params).await
	}

	async fn usage_snapshot(
		&self,
		c: &BackendCallContext,
	) -> gjc_app_server::Result<Option<gjc_app_server::unattended::UsageSnapshot>> {
		let value = self
			.call(c, "usageSnapshot", serde_json::Value::Null)
			.await?;
		if value.is_null() {
			Ok(None)
		} else {
			serde_json::from_value(value).map(Some).map_err(|err| {
				AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
			})
		}
	}

	async fn dispose(&self, c: &BackendCallContext) -> gjc_app_server::Result<()> {
		self
			.call(c, "dispose", serde_json::Value::Null)
			.await
			.map(|_| ())
	}
}

/// A factory that asks the TS host to create/resume/fork an `AgentSession`.
struct TsFactory {
	bridge: Arc<Bridge>,
}

impl TsFactory {
	async fn make(
		&self,
		kind: &str,
		params: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		let v = self.bridge.call(kind, None, None, params).await?;
		let thread_id = ThreadId(
			v.get("threadId")
				.and_then(|s| s.as_str())
				.ok_or_else(|| {
					AppServerError::new(
						gjc_app_server::error::codes::INTERNAL_ERROR,
						"host omitted threadId",
					)
				})?
				.to_string(),
		);
		let session_metadata = match v.get("sessionMetadata") {
			Some(metadata) => serde_json::from_value(metadata.clone()).map_err(|err| {
				AppServerError::new(
					gjc_app_server::error::codes::INTERNAL_ERROR,
					format!("host returned malformed sessionMetadata: {err}"),
				)
			})?,
			None => Default::default(),
		};
		let info = BackendHandleInfo {
			thread_id: thread_id.clone(),
			generation: BackendGeneration::FIRST,
			session_metadata,
		};
		let backend: Arc<dyn AgentBackend> =
			Arc::new(TsBackend { thread_id, bridge: Arc::clone(&self.bridge) });
		Ok((info, backend))
	}

	async fn typed_call<T: serde::de::DeserializeOwned, P: serde::Serialize>(
		&self,
		kind: &str,
		params: P,
	) -> gjc_app_server::Result<T> {
		let params = serde_json::to_value(params).unwrap_or(serde_json::Value::Null);
		let value = self.bridge.call(kind, None, None, params).await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
}

#[async_trait::async_trait]
impl BackendFactory for TsFactory {
	async fn create_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.make("factory.create", p).await
	}

	async fn resume_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.make("factory.resume", p).await
	}

	async fn fork_thread(
		&self,
		p: serde_json::Value,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		self.make("factory.fork", p).await
	}

	async fn session_open(
		&self,
		p: gjc_app_server::protocol::GjcSessionOpenParams,
	) -> gjc_app_server::Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
		let params = serde_json::to_value(p).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})?;
		self.make("factory.sessionOpen", params).await
	}

	async fn session_delete(
		&self,
		p: gjc_app_server::protocol::GjcSessionDeleteParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionDeleteResult> {
		let params = serde_json::to_value(p).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})?;
		let value = self
			.bridge
			.call("factory.sessionDelete", None, None, params)
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn settings_schema(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSettingsSchemaResult> {
		let v = self
			.bridge
			.call("factory.settingsSchema", None, None, serde_json::Value::Null)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn settings_read(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSettingsReadResult> {
		let v = self
			.bridge
			.call("factory.settingsRead", None, None, serde_json::Value::Null)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn settings_update(
		&self,
		params: gjc_app_server::protocol::GjcSettingsUpdateParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSettingsUpdateResult> {
		let v = self
			.bridge
			.call(
				"factory.settingsUpdate",
				None,
				None,
				serde_json::to_value(params).unwrap_or(serde_json::Value::Null),
			)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn appearance_themes_list(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAppearanceThemesListResult> {
		let v = self
			.bridge
			.call("factory.appearanceThemesList", None, None, serde_json::Value::Null)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn appearance_read(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAppearanceReadResult> {
		let v = self
			.bridge
			.call("factory.appearanceRead", None, None, serde_json::Value::Null)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn appearance_set(
		&self,
		params: gjc_app_server::protocol::GjcAppearanceSetParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAppearanceSetResult> {
		let v = self
			.bridge
			.call(
				"factory.appearanceSet",
				None,
				None,
				serde_json::to_value(params).unwrap_or(serde_json::Value::Null),
			)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn provider_add(
		&self,
		params: gjc_app_server::protocol::GjcProviderAddParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcProviderAddResult> {
		self.typed_call("factory.providerAdd", params).await
	}

	async fn auth_login_start(
		&self,
		params: gjc_app_server::protocol::GjcAuthLoginStartParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAuthLoginStartResult> {
		self.typed_call("factory.authLoginStart", params).await
	}

	async fn auth_login_poll(
		&self,
		params: gjc_app_server::protocol::GjcAuthLoginPollParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAuthLoginPollResult> {
		self.typed_call("factory.authLoginPoll", params).await
	}

	async fn auth_login_complete(
		&self,
		params: gjc_app_server::protocol::GjcAuthLoginCompleteParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAuthLoginCompleteResult> {
		self.typed_call("factory.authLoginComplete", params).await
	}

	async fn auth_login_cancel(
		&self,
		params: gjc_app_server::protocol::GjcAuthLoginCancelParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAuthLoginCancelResult> {
		self.typed_call("factory.authLoginCancel", params).await
	}
	async fn provider_list(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcProviderListResult> {
		let v = self
			.bridge
			.call("factory.providerList", None, None, serde_json::Value::Null)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn auth_status(
		&self,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAuthStatusResult> {
		let v = self
			.bridge
			.call("factory.authStatus", None, None, serde_json::Value::Null)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}
	async fn auth_logout(
		&self,
		params: gjc_app_server::protocol::GjcAuthLogoutParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcAuthLogoutResult> {
		let v = self
			.bridge
			.call(
				"factory.authLogout",
				None,
				None,
				serde_json::to_value(params).unwrap_or(serde_json::Value::Null),
			)
			.await?;
		serde_json::from_value(v).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn session_list(
		&self,
		p: gjc_app_server::protocol::GjcSessionListParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionListResult> {
		let params = serde_json::to_value(p).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})?;
		let value = self
			.bridge
			.call("factory.sessionList", None, None, params)
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn session_search(
		&self,
		p: gjc_app_server::protocol::GjcSessionSearchParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionSearchResult> {
		let params = serde_json::to_value(p).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})?;
		let value = self
			.bridge
			.call("factory.sessionSearch", None, None, params)
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn session_rename(
		&self,
		p: gjc_app_server::protocol::GjcSessionRenameParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionRenameResult> {
		let params = serde_json::to_value(p).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})?;
		let value = self
			.bridge
			.call("factory.sessionRename", None, None, params)
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn session_export(
		&self,
		p: gjc_app_server::protocol::GjcSessionExportParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSessionExportResult> {
		let params = serde_json::to_value(p).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})?;
		let value = self
			.bridge
			.call("factory.sessionExport", None, None, params)
			.await?;
		serde_json::from_value(value).map_err(|err| {
			AppServerError::new(gjc_app_server::error::codes::INTERNAL_ERROR, err.to_string())
		})
	}

	async fn extensions_set_enabled(
		&self,
		params: gjc_app_server::protocol::GjcExtensionsSetEnabledParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcExtensionsSetEnabledResult> {
		self
			.typed_call("factory.extensionsSetEnabled", params)
			.await
	}

	async fn skills_set_enabled(
		&self,
		params: gjc_app_server::protocol::GjcSkillsSetEnabledParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcSkillsSetEnabledResult> {
		self.typed_call("factory.skillsSetEnabled", params).await
	}

	async fn plugins_set_enabled(
		&self,
		params: gjc_app_server::protocol::GjcPluginsSetEnabledParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcPluginsSetEnabledResult> {
		self.typed_call("factory.pluginsSetEnabled", params).await
	}

	async fn plugins_set_feature(
		&self,
		params: gjc_app_server::protocol::GjcPluginsSetFeatureParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcPluginsSetFeatureResult> {
		self.typed_call("factory.pluginsSetFeature", params).await
	}

	async fn plugins_set_setting(
		&self,
		params: gjc_app_server::protocol::GjcPluginsSetSettingParams,
	) -> gjc_app_server::Result<gjc_app_server::protocol::GjcPluginsSetSettingResult> {
		self.typed_call("factory.pluginsSetSetting", params).await
	}
}

struct TsNotificationHost {
	bridge: Arc<Bridge>,
}

#[async_trait::async_trait]
impl gjc_app_server::notifications::NotificationHost for TsNotificationHost {
	async fn notification_call(
		&self,
		kind: &str,
		params: serde_json::Value,
	) -> gjc_app_server::Result<serde_json::Value> {
		self.bridge.call(kind, None, None, params).await
	}
}

/// `EventSink` that forwards mapped frames to TS as JSON strings.
struct TsSink {
	on_frame: ThreadsafeFunction<String>,
}

impl EventSink for TsSink {
	fn emit(&self, note: jsonrpc::Notification) {
		if let Ok(s) = serde_json::to_string(&note) {
			self
				.on_frame
				.call(Ok(s), ThreadsafeFunctionCallMode::NonBlocking);
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
	#[napi(
		constructor,
		ts_args_type = "onFrame: (err: null | Error, frame: string) => void, onCall: (err: null | \
		                Error, call: string) => void, maxInflightTurnsPerThread?: number"
	)]
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
		let notification_host: Arc<dyn gjc_app_server::notifications::NotificationHost> =
			Arc::new(TsNotificationHost { bridge: Arc::clone(&bridge) });
		let sink: Arc<dyn EventSink> = Arc::new(TsSink { on_frame });
		let core = Arc::new(CoreAppServer::new_with_notification_host(
			factory,
			config,
			sink,
			notification_host,
		));
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
		self
			.core
			.close_connection(&gjc_app_server::ids::ConnectionId(connection_id));
	}

	/// Dispatch one newline-delimited JSON-RPC frame. Returns the response JSON
	/// string for requests, or `null` for notifications.
	#[napi]
	pub async fn dispatch(&self, connection_id: String, line: String) -> Option<String> {
		let outbound_request: Option<serde_json::Value> =
			serde_json::from_str::<serde_json::Value>(&line).ok();
		let conn = gjc_app_server::ids::ConnectionId(connection_id);
		let inbound = match jsonrpc::parse_inbound(&line) {
			Ok(inbound) => inbound,
			Err(err) => {
				// Malformed frames without an id cannot be correlated; emit a
				// best-effort error response with a null id.
				let resp = jsonrpc::Response::err(jsonrpc::RequestId::Number(0), err);
				return serde_json::to_string(&resp).ok();
			},
		};
		let resp = self.core.dispatch(&conn, inbound).await;
		if let Some(request) = outbound_request.as_ref()
			&& request.get("method").and_then(|m| m.as_str()) == Some("gjc/hostUriSchemes/set")
			&& resp.as_ref().is_some_and(|r| r.error.is_none())
			&& let Some(params) = request.get("params")
		{
			let _ = self
				.bridge
				.call("hostUriSchemes.set", None, None, params.clone())
				.await;
		}
		resp.and_then(|r| serde_json::to_string(&r).ok())
	}

	/// Start a loopback WebSocket transport for this app-server; returns the
	/// bound ws:// URL.
	#[napi]
	pub async fn listen_ws(
		&self,
		host: String,
		port: u32,
		token: String,
		session_id: String,
		state_root: Option<String>,
		allowed_origins: Option<Vec<String>>,
	) -> napi::Result<String> {
		let port = u16::try_from(port)
			.map_err(|_| napi::Error::from_reason("port must be between 0 and 65535"))?;
		let state_root = state_root.map_or_else(std::env::temp_dir, PathBuf::from);
		let old = self
			.ws_handle
			.lock()
			.map_err(|_| napi::Error::from_reason("websocket handle lock poisoned"))?
			.take();
		if let Some(handle) = old {
			handle
				.shutdown()
				.await
				.map_err(|err| napi::Error::from_reason(err.to_string()))?;
		}
		let handle = start_ws(
			Arc::clone(&self.core),
			WsServerConfig {
				host,
				port,
				token,
				session_id,
				state_root,
				allowed_origins: allowed_origins.unwrap_or_default(),
			},
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
	pub fn resolve_call(&self, call_id: String, ok: bool, json: String) -> napi::Result<()> {
		let Some((_, tx)) = self.bridge.pending.remove(&call_id) else {
			return Ok(());
		};
		let value: serde_json::Value = serde_json::from_str(&json)
			.map_err(|err| napi::Error::from_reason(format!("invalid resolveCall JSON: {err}")))?;
		let result = if ok {
			Ok(value)
		} else {
			let code = value
				.get("code")
				.and_then(serde_json::Value::as_i64)
				.unwrap_or(-32603) as i32;
			let message = value
				.get("message")
				.and_then(|m| m.as_str())
				.unwrap_or("host error")
				.to_string();
			Err(AppServerError::new(code, message))
		};
		let _ = tx.send(result);
		Ok(())
	}

	/// Push a backend event (a gjc `AgentEvent`) for a thread. Returns the
	/// number of notifications emitted (0 if rejected as stale/unknown).
	#[napi]
	pub fn emit_backend_event(
		&self,
		thread_id: String,
		generation: i64,
		event_type: String,
		payload_json: String,
	) -> napi::Result<u32> {
		let payload: serde_json::Value = serde_json::from_str(&payload_json).map_err(|err| {
			napi::Error::from_reason(format!("invalid backend event payload JSON: {err}"))
		})?;
		let ev = BackendEvent {
			thread_id: ThreadId(thread_id),
			generation: BackendGeneration(generation.max(0) as u64),
			event_type,
			payload,
		};
		Ok(self.core.emit_backend_event(&ev) as u32)
	}

	/// Return the host tool names registered for a thread.
	#[napi(js_name = "hostToolNames")]
	pub fn host_tool_names(&self, thread_id: String) -> napi::Result<Vec<String>> {
		self
			.core
			.host_tool_names(&ThreadId(thread_id))
			.map_err(|err| napi::Error::from_reason(err.to_string()))
	}

	/// Call a client-registered host tool and resolve to the JSON result
	/// payload.
	#[napi(js_name = "callHostTool")]
	pub async fn call_host_tool(
		&self,
		thread_id: String,
		turn_id: Option<String>,
		tool: String,
		args_json: String,
	) -> napi::Result<String> {
		let args: serde_json::Value = serde_json::from_str(&args_json)
			.map_err(|err| napi::Error::from_reason(format!("invalid argsJson: {err}")))?;
		let turn = TurnId(turn_id.ok_or_else(|| napi::Error::from_reason("missing turnId"))?);
		let result = self
			.core
			.call_host_tool(&ThreadId(thread_id), &turn, &tool, args)
			.await
			.map_err(|err| napi::Error::from_reason(err.to_string()))?;
		if result.ok {
			serde_json::to_string(&result.result.unwrap_or(serde_json::Value::Null))
				.map_err(|err| napi::Error::from_reason(err.to_string()))
		} else {
			let error = result
				.error
				.unwrap_or_else(|| serde_json::json!({ "message": "host tool failed" }));
			Err(napi::Error::from_reason(error.to_string()))
		}
	}

	/// Return the currently accepted active turn id for a thread, if any.
	#[napi(js_name = "activeTurnId")]
	pub fn active_turn_id(&self, thread_id: String) -> napi::Result<Option<String>> {
		self
			.core
			.active_turn_id(&ThreadId(thread_id))
			.map(|turn| turn.map(|t| t.0))
			.map_err(|err| napi::Error::from_reason(err.to_string()))
	}

	#[napi(js_name = "readHostUri")]
	pub async fn read_host_uri(&self, thread_id: String, url_json: String) -> napi::Result<String> {
		let url_value: serde_json::Value = serde_json::from_str(&url_json)
			.map_err(|err| napi::Error::from_reason(format!("invalid urlJson: {err}")))?;
		let url = url_value
			.get("url")
			.or_else(|| url_value.get("href"))
			.and_then(|v| v.as_str())
			.ok_or_else(|| napi::Error::from_reason("urlJson must include url"))?;
		let thread = ThreadId(thread_id);
		let turn = self
			.core
			.active_turn_id(&thread)
			.map_err(|err| napi::Error::from_reason(err.to_string()))?
			.unwrap_or_else(|| TurnId("host-uri".to_string()));
		let resource = self
			.core
			.read_host_uri(&thread, &turn, url)
			.await
			.map_err(|err| napi::Error::from_reason(err.to_string()))?;
		serde_json::to_string(&resource).map_err(|err| napi::Error::from_reason(err.to_string()))
	}

	#[napi(js_name = "writeHostUri")]
	pub async fn write_host_uri(
		&self,
		thread_id: String,
		url_json: String,
		content: String,
	) -> napi::Result<()> {
		let url_value: serde_json::Value = serde_json::from_str(&url_json)
			.map_err(|err| napi::Error::from_reason(format!("invalid urlJson: {err}")))?;
		let url = url_value
			.get("url")
			.or_else(|| url_value.get("href"))
			.and_then(|v| v.as_str())
			.ok_or_else(|| napi::Error::from_reason("urlJson must include url"))?;
		let thread = ThreadId(thread_id);
		let turn = self
			.core
			.active_turn_id(&thread)
			.map_err(|err| napi::Error::from_reason(err.to_string()))?
			.unwrap_or_else(|| TurnId("host-uri".to_string()));
		self
			.core
			.write_host_uri(&thread, &turn, url, content)
			.await
			.map_err(|err| napi::Error::from_reason(err.to_string()))
	}

	#[napi(js_name = "openWorkflowGate")]
	pub async fn open_workflow_gate(
		&self,
		thread_id: String,
		input_json: String,
	) -> napi::Result<String> {
		let input: gjc_app_server::workflow_gate::OpenWorkflowGateInput =
			serde_json::from_str(&input_json).map_err(|err| {
				napi::Error::from_reason(format!("invalid workflow gate input JSON: {err}"))
			})?;
		let answer = self
			.core
			.open_workflow_gate(&ThreadId(thread_id), input)
			.await
			.map_err(|err| napi::Error::from_reason(err.to_string()))?;
		serde_json::to_string(&answer).map_err(|err| napi::Error::from_reason(err.to_string()))
	}

	#[napi(js_name = "isWorkflowGateUnattended")]
	pub fn is_workflow_gate_unattended(&self, _thread_id: String) -> bool {
		true
	}

	/// Push an opaque `gjc/notifications` frame to connected clients.
	#[napi(js_name = "pushNotification")]
	pub fn push_notification(&self, frame_json: String) -> napi::Result<()> {
		let frame: serde_json::Value = serde_json::from_str(&frame_json)
			.map_err(|err| napi::Error::from_reason(format!("invalid notification JSON: {err}")))?;
		self.core.push_notification(frame);
		Ok(())
	}

	/// The wire protocol schema bundle string.
	#[napi]
	#[must_use]
	pub fn schema_json(&self) -> String {
		app_server_schema_json()
	}
}
