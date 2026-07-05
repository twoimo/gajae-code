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

	// -- state / reads --
	async fn get_state(
		&self,
		ctx: &BackendCallContext,
		include: serde_json::Value,
	) -> Result<serde_json::Value>;
	async fn get_messages(&self, ctx: &BackendCallContext) -> Result<serde_json::Value>;

	// -- gjc management (mirrors old RPC catalog) --
	async fn set_model(
		&self,
		ctx: &BackendCallContext,
		provider: &str,
		model_id: &str,
	) -> Result<serde_json::Value>;
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
