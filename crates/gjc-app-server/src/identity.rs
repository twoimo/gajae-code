//! Thread identity model and stale-event rejection (Phase 0A gate).
//!
//! Rust owns an immutable [`ThreadId`]. The TS `sessionId`/`sessionFile` are
//! mutable metadata that change on switch/branch without changing the thread
//! identity. Every backend attachment bumps [`BackendGeneration`]; every event
//! carries `(thread_id, generation)` so events from a superseded attachment are
//! rejected instead of corrupting a freshly resumed/forked thread.

use serde::{Deserialize, Serialize};

use crate::ids::{BackendGeneration, ThreadId};

/// Lifecycle status of a thread in the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadStatus {
	Idle,
	Running,
	Archived,
	Deleted,
}

/// Mutable TS-side session metadata attached to an immutable thread identity.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub session_id:           Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub session_file:         Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cwd:                  Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub session_dir:          Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub system_prompt_append: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub model:                Option<serde_json::Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub model_config:         Option<serde_json::Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub thinking:             Option<serde_json::Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub todos:                Option<serde_json::Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub forked_from_id:       Option<ThreadId>,
}

/// Immutable identity + mutable metadata + current backend generation.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ThreadIdentity {
	pub thread_id:  ThreadId,
	pub status:     ThreadStatus,
	pub generation: BackendGeneration,
	pub metadata:   SessionMetadata,
}

impl ThreadIdentity {
	/// Start a brand-new thread at generation 1.
	#[must_use]
	pub const fn new(thread_id: ThreadId, metadata: SessionMetadata) -> Self {
		Self { thread_id, status: ThreadStatus::Idle, generation: BackendGeneration::FIRST, metadata }
	}

	/// Reattach the backend (resume/switch/unload→resume): bumps the generation
	/// so any in-flight events from the previous attachment become stale.
	pub const fn reattach(&mut self) -> BackendGeneration {
		self.generation = self.generation.next();
		self.generation
	}

	/// Whether an event tagged with `(thread_id, generation)` is current and
	/// should be delivered. Stale, unknown-thread, or deleted-thread events are
	/// rejected (returns `false`).
	#[must_use]
	pub fn accepts_event(&self, thread_id: &ThreadId, generation: BackendGeneration) -> bool {
		self.status != ThreadStatus::Deleted
			&& &self.thread_id == thread_id
			&& generation == self.generation
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ident() -> ThreadIdentity {
		ThreadIdentity::new(ThreadId("thr_1".into()), SessionMetadata::default())
	}

	#[test]
	fn accepts_current_generation_event() {
		let id = ident();
		assert!(id.accepts_event(&ThreadId("thr_1".into()), BackendGeneration::FIRST));
	}

	#[test]
	fn rejects_stale_generation_after_reattach() {
		let mut id = ident();
		let old = id.generation;
		id.reattach();
		assert!(!id.accepts_event(&ThreadId("thr_1".into()), old));
		assert!(id.accepts_event(&ThreadId("thr_1".into()), id.generation));
	}

	#[test]
	fn rejects_events_for_other_threads() {
		let id = ident();
		assert!(!id.accepts_event(&ThreadId("thr_other".into()), BackendGeneration::FIRST));
	}

	#[test]
	fn rejects_events_after_delete() {
		let mut id = ident();
		id.status = ThreadStatus::Deleted;
		assert!(!id.accepts_event(&ThreadId("thr_1".into()), id.generation));
	}
}
