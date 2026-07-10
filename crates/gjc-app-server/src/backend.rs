//! The `AgentBackend` seam (Phase 0A/1 boundary).
//!
//! The trait mirrors the TS `AgentSession` method surface rather than a
//! codex-shaped contract, so the future 1:1 Rust port drops in by implementing
//! the same trait. Today the implementor is a TS-callback bridge (pi-natives
//! threadsafe functions); later it is a native Rust `AgentSession`.
//!
//! Every call carries a [`BackendCallContext`] with `thread_id`, `generation`,
//! `request_id`, `lane`, and a cancellation token. Every backend event carries
//! `(thread_id, generation)` so
//! [`crate::identity::ThreadIdentity::accepts_event`] can reject stale events.
//! Payloads are `serde_json::Value` at the seam so the Rust core and the TS
//! bridge share one wire shape; typed accessors live in the protocol modules.

use async_trait::async_trait;

fn unsupported<T>(method: &str) -> crate::error::Result<T> {
	Err(crate::AppServerError::new(
		crate::error::codes::METHOD_NOT_FOUND,
		format!("{method} is not supported by this backend"),
	))
}
use crate::{
	error::Result,
	ids::{BackendGeneration, ThreadId, TurnId},
	scheduler::Lane,
};

/// Context threaded through every backend call.
#[derive(Debug, Clone)]
pub struct BackendCallContext {
	pub thread_id: ThreadId,
	pub generation: BackendGeneration,
	pub request_id: Option<crate::jsonrpc::RequestId>,
	pub lane: Lane,
}

/// A normalized event pushed from the backend (TS `AgentEvent` today) up into
///
/// the item-lifecycle state machine. The `payload` is the raw gjc event value,
/// preserved so no gjc detail is lost; the state machine classifies it into
/// codex `item/*` lifecycle notifications.
#[derive(Debug, Clone)]
pub struct BackendEvent {
	pub thread_id: ThreadId,
	pub generation: BackendGeneration,
	/// The gjc `AgentEvent` `type` discriminator (e.g. `agent_start`,
	/// `text_delta`, `tool_execution_start`, `agent_end`).
	pub event_type: String,
	/// The full raw event value (lossless gjc detail).
	pub payload: serde_json::Value,
}

/// Metadata returned when a thread's backend is created/resumed/forked.
#[derive(Debug, Clone)]
pub struct BackendHandleInfo {
	pub thread_id: ThreadId,
	pub generation: BackendGeneration,
	pub session_metadata: crate::identity::SessionMetadata,
}

/// The seam the app-server drives. Mirrors `AgentSession`'s surface; grouped by
/// concern. Payloads are `Value` to keep one wire shape across the TS bridge
/// and the future Rust implementor.
#[async_trait]
pub trait AgentBackend: Send + Sync {
	// -- prompt / turn lifecycle --
	async fn prompt(&self, ctx: &BackendCallContext, params: serde_json::Value) -> Result<TurnId>;
	async fn steer(&self, ctx: &BackendCallContext, params: serde_json::Value) -> Result<TurnId>;
	async fn abort(&self, ctx: &BackendCallContext, turn_id: &TurnId) -> Result<()>;
	async fn retry(&self, _ctx: &BackendCallContext) -> Result<TurnId> {
		unsupported("gjc/retry")
	}

	// -- state / reads --
	async fn get_state(
		&self,
		ctx: &BackendCallContext,
		include: serde_json::Value,
	) -> Result<serde_json::Value>;
	async fn get_messages(&self, ctx: &BackendCallContext) -> Result<serde_json::Value>;
	async fn read_context(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcContextReadResult> {
		Err(crate::AppServerError::new(
			crate::error::codes::METHOD_NOT_FOUND,
			"gjc/context/read is not supported by this backend",
		))
	}
	async fn read_goal(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcGoalReadResult> {
		unsupported("gjc/goal/read")
	}
	async fn session_tree(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcSessionTreeResult> {
		unsupported("gjc/session/tree")
	}
	async fn session_navigate(
		&self,
		_ctx: &BackendCallContext,
		_params: crate::protocol::GjcSessionNavigateParams,
	) -> Result<crate::protocol::GjcSessionNavigateResult> {
		unsupported("gjc/session/navigate")
	}
	async fn session_label(
		&self,
		_ctx: &BackendCallContext,
		_params: crate::protocol::GjcSessionLabelParams,
	) -> Result<crate::protocol::GjcSessionLabelResult> {
		unsupported("gjc/session/label")
	}
	async fn session_move(
		&self,
		_ctx: &BackendCallContext,
		_params: crate::protocol::GjcSessionMoveParams,
	) -> Result<crate::protocol::GjcSessionMoveResult> {
		unsupported("gjc/session/move")
	}
	async fn model_catalog(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcModelCatalogResult> {
		unsupported("gjc/model/catalog")
	}
	async fn read_thinking(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcThinkingReadResult> {
		unsupported("gjc/thinking/read")
	}
	async fn set_thinking(
		&self,
		_ctx: &BackendCallContext,
		_level: String,
	) -> Result<crate::protocol::GjcThinkingSetResult> {
		unsupported("gjc/thinking/set")
	}
	async fn read_fast(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcFastReadResult> {
		unsupported("gjc/fast/read")
	}
	async fn set_fast(
		&self,
		_ctx: &BackendCallContext,
		_enabled: bool,
	) -> Result<crate::protocol::GjcFastSetResult> {
		unsupported("gjc/fast/set")
	}
	async fn read_todos(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcTodosReadResult> {
		unsupported("gjc/todos/read")
	}
	async fn read_usage(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcUsageReadResult> {
		unsupported("gjc/usage/read")
	}
	async fn list_jobs(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcJobsListResult> {
		unsupported("gjc/jobs/list")
	}
	async fn list_agents(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcAgentsListResult> {
		unsupported("gjc/agents/list")
	}
	async fn list_monitors(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcMonitorsListResult> {
		unsupported("gjc/monitors/list")
	}
	async fn compact_summary(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<crate::protocol::GjcCompactSummaryResult> {
		unsupported("gjc/compact/summary")
	}

	// -- gjc management (mirrors old RPC catalog) --
	async fn set_model(
		&self,
		ctx: &BackendCallContext,
		provider: &str,
		model_id: &str,
	) -> Result<serde_json::Value>;
	async fn model_assign(
		&self,
		_ctx: &BackendCallContext,
		_params: crate::protocol::GjcModelAssignParams,
	) -> Result<crate::protocol::GjcModelAssignResult> {
		unsupported("gjc/model/assign")
	}
	async fn compact(
		&self,
		ctx: &BackendCallContext,
		custom_instructions: Option<&str>,
	) -> Result<serde_json::Value>;
	async fn set_todos(&self, ctx: &BackendCallContext, phases: serde_json::Value) -> Result<()>;

	// -- command execution (codex command/exec + gjc bash parity) --
	async fn exec(
		&self,
		ctx: &BackendCallContext,
		params: serde_json::Value,
	) -> Result<serde_json::Value>;
	async fn usage_snapshot(
		&self,
		_ctx: &BackendCallContext,
	) -> Result<Option<crate::unattended::UsageSnapshot>> {
		Ok(None)
	}

	// -- lifecycle --
	async fn dispose(&self, ctx: &BackendCallContext) -> Result<()>;
}

/// Factory that materializes backends for new/resumed/forked threads. The
/// app-server owns the registry; the factory is implemented by the TS bridge
/// (or the native Rust core later).
#[async_trait]
pub trait BackendFactory: Send + Sync {
	async fn create_thread(
		&self,
		params: serde_json::Value,
	) -> Result<(BackendHandleInfo, std::sync::Arc<dyn AgentBackend>)>;
	async fn resume_thread(
		&self,
		params: serde_json::Value,
	) -> Result<(BackendHandleInfo, std::sync::Arc<dyn AgentBackend>)>;
	async fn fork_thread(
		&self,
		params: serde_json::Value,
	) -> Result<(BackendHandleInfo, std::sync::Arc<dyn AgentBackend>)>;
	async fn settings_schema(&self) -> Result<crate::protocol::GjcSettingsSchemaResult> {
		unsupported("gjc/settings/schema")
	}
	async fn settings_read(&self) -> Result<crate::protocol::GjcSettingsReadResult> {
		unsupported("gjc/settings/read")
	}
	async fn settings_update(
		&self,
		_params: crate::protocol::GjcSettingsUpdateParams,
	) -> Result<crate::protocol::GjcSettingsUpdateResult> {
		unsupported("gjc/settings/update")
	}
	async fn appearance_themes_list(
		&self,
	) -> Result<crate::protocol::GjcAppearanceThemesListResult> {
		unsupported("gjc/appearance/themes/list")
	}
	async fn appearance_read(&self) -> Result<crate::protocol::GjcAppearanceReadResult> {
		unsupported("gjc/appearance/read")
	}
	async fn appearance_set(
		&self,
		_params: crate::protocol::GjcAppearanceSetParams,
	) -> Result<crate::protocol::GjcAppearanceSetResult> {
		unsupported("gjc/appearance/set")
	}
	async fn provider_list(&self) -> Result<crate::protocol::GjcProviderListResult> {
		unsupported("gjc/provider/list")
	}
	async fn auth_status(&self) -> Result<crate::protocol::GjcAuthStatusResult> {
		unsupported("gjc/auth/status")
	}

	async fn provider_add(
		&self,
		_params: crate::protocol::GjcProviderAddParams,
	) -> Result<crate::protocol::GjcProviderAddResult> {
		unsupported("gjc/provider/add")
	}
	async fn auth_login_start(
		&self,
		_params: crate::protocol::GjcAuthLoginStartParams,
	) -> Result<crate::protocol::GjcAuthLoginStartResult> {
		unsupported("gjc/auth/login/start")
	}
	async fn auth_login_poll(
		&self,
		_params: crate::protocol::GjcAuthLoginPollParams,
	) -> Result<crate::protocol::GjcAuthLoginPollResult> {
		unsupported("gjc/auth/login/poll")
	}
	async fn auth_login_complete(
		&self,
		_params: crate::protocol::GjcAuthLoginCompleteParams,
	) -> Result<crate::protocol::GjcAuthLoginCompleteResult> {
		unsupported("gjc/auth/login/complete")
	}
	async fn auth_login_cancel(
		&self,
		_params: crate::protocol::GjcAuthLoginCancelParams,
	) -> Result<crate::protocol::GjcAuthLoginCancelResult> {
		unsupported("gjc/auth/login/cancel")
	}
	async fn auth_logout(
		&self,
		_params: crate::protocol::GjcAuthLogoutParams,
	) -> Result<crate::protocol::GjcAuthLogoutResult> {
		unsupported("gjc/auth/logout")
	}
	async fn session_list(
		&self,
		_params: crate::protocol::GjcSessionListParams,
	) -> Result<crate::protocol::GjcSessionListResult> {
		Err(crate::AppServerError::new(
			crate::error::codes::METHOD_NOT_FOUND,
			"gjc/session/list is not supported by this backend",
		))
	}
	async fn session_search(
		&self,
		_params: crate::protocol::GjcSessionSearchParams,
	) -> Result<crate::protocol::GjcSessionSearchResult> {
		Err(crate::AppServerError::new(
			crate::error::codes::METHOD_NOT_FOUND,
			"gjc/session/search is not supported by this backend",
		))
	}
	async fn session_open(
		&self,
		_params: crate::protocol::GjcSessionOpenParams,
	) -> Result<(crate::backend::BackendHandleInfo, std::sync::Arc<dyn AgentBackend>)> {
		unsupported("gjc/session/open")
	}
	async fn session_delete(
		&self,
		_params: crate::protocol::GjcSessionDeleteParams,
	) -> Result<crate::protocol::GjcSessionDeleteResult> {
		unsupported("gjc/session/delete")
	}
	async fn session_rename(
		&self,
		_params: crate::protocol::GjcSessionRenameParams,
	) -> Result<crate::protocol::GjcSessionRenameResult> {
		Err(crate::AppServerError::new(
			crate::error::codes::METHOD_NOT_FOUND,
			"gjc/session/rename is not supported by this backend",
		))
	}
	async fn session_export(
		&self,
		_params: crate::protocol::GjcSessionExportParams,
	) -> Result<crate::protocol::GjcSessionExportResult> {
		Err(crate::AppServerError::new(
			crate::error::codes::METHOD_NOT_FOUND,
			"gjc/session/export is not supported by this backend",
		))
	}

	async fn extensions_set_enabled(
		&self,
		_params: crate::protocol::GjcExtensionsSetEnabledParams,
	) -> Result<crate::protocol::GjcExtensionsSetEnabledResult> {
		unsupported("gjc/extensions/setEnabled")
	}
	async fn skills_set_enabled(
		&self,
		_params: crate::protocol::GjcSkillsSetEnabledParams,
	) -> Result<crate::protocol::GjcSkillsSetEnabledResult> {
		unsupported("gjc/skills/setEnabled")
	}
	async fn plugins_set_enabled(
		&self,
		_params: crate::protocol::GjcPluginsSetEnabledParams,
	) -> Result<crate::protocol::GjcPluginsSetEnabledResult> {
		unsupported("gjc/plugins/setEnabled")
	}
	async fn plugins_set_feature(
		&self,
		_params: crate::protocol::GjcPluginsSetFeatureParams,
	) -> Result<crate::protocol::GjcPluginsSetFeatureResult> {
		unsupported("gjc/plugins/setFeature")
	}
	async fn plugins_set_setting(
		&self,
		_params: crate::protocol::GjcPluginsSetSettingParams,
	) -> Result<crate::protocol::GjcPluginsSetSettingResult> {
		unsupported("gjc/plugins/setSetting")
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::ids::ThreadId;

	struct FakeBackend;

	#[async_trait]
	impl AgentBackend for FakeBackend {
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
			Ok(serde_json::json!({"idle": true}))
		}

		async fn get_messages(&self, _c: &BackendCallContext) -> Result<serde_json::Value> {
			Ok(serde_json::json!([]))
		}

		async fn set_model(
			&self,
			_c: &BackendCallContext,
			provider: &str,
			model_id: &str,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({"provider": provider, "modelId": model_id}))
		}

		async fn compact(
			&self,
			_c: &BackendCallContext,
			_ci: Option<&str>,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({"compacted": true}))
		}

		async fn set_todos(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<()> {
			Ok(())
		}

		async fn exec(
			&self,
			_c: &BackendCallContext,
			_p: serde_json::Value,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({"exitCode": 0}))
		}

		async fn dispose(&self, _c: &BackendCallContext) -> Result<()> {
			Ok(())
		}
	}

	fn ctx() -> BackendCallContext {
		BackendCallContext {
			thread_id: ThreadId("thr_1".into()),
			generation: BackendGeneration::FIRST,
			request_id: None,
			lane: Lane::Mutating,
		}
	}

	#[tokio::test]
	async fn fake_backend_is_object_safe_and_drivable() {
		let b: std::sync::Arc<dyn AgentBackend> = std::sync::Arc::new(FakeBackend);
		let turn = b
			.prompt(&ctx(), serde_json::json!({"input": "hi"}))
			.await
			.unwrap();
		assert!(turn.0.starts_with("turn_"));
		let model = b.set_model(&ctx(), "anthropic", "claude").await.unwrap();
		assert_eq!(model["modelId"], "claude");
		b.dispose(&ctx()).await.unwrap();
	}

	#[test]
	fn backend_event_preserves_raw_payload() {
		let ev = BackendEvent {
			thread_id: ThreadId("thr_1".into()),
			generation: BackendGeneration::FIRST,
			event_type: "text_delta".into(),
			payload: serde_json::json!({"type": "text_delta", "delta": "hello", "contentIndex": 0}),
		};
		assert_eq!(ev.payload["delta"], "hello");
	}
}
