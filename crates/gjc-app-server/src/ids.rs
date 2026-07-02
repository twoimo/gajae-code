//! Stable identity types for the app-server.
//!
//! `ThreadId` is the immutable, Rust-owned codex thread identity (see the
//! Phase 0A identity model). `TurnId`/`ItemId` scope streaming lifecycle
//! events. `BackendGeneration` is the monotonic attachment counter used to
//! reject stale backend events after a resume/switch/unload/dispose.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

/// Immutable codex thread identity, owned by Rust for the lifetime of the app
/// server. TS `sessionId`/`sessionFile` are mutable metadata that never change
/// this value (see [`crate::identity`]).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct ThreadId(pub String);

/// One turn within a thread.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct TurnId(pub String);

/// One item (user message, agent message, reasoning, command execution, …)
/// within a turn.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct ItemId(pub String);

/// A transport connection to the app server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(transparent)]
pub struct ConnectionId(pub String);

/// Monotonic backend-attachment generation. Every callback and every
/// `emitBackendEvent` carries the generation for its thread; a mismatch means
/// the event is from a superseded backend attachment and must be rejected.
#[derive(
	Debug,
	Clone,
	Copy,
	PartialEq,
	Eq,
	PartialOrd,
	Ord,
	Hash,
	Serialize,
	Deserialize,
	schemars::JsonSchema,
)]
#[serde(transparent)]
pub struct BackendGeneration(pub u64);

impl BackendGeneration {
	/// The first generation assigned when a thread's backend is first attached.
	pub const FIRST: Self = Self(1);

	#[must_use]
	pub const fn next(self) -> Self {
		Self(self.0 + 1)
	}
}

/// Process-wide monotonic counter used to mint unique id suffixes without
/// coordination between threads/connections.
static COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_suffix() -> u64 {
	COUNTER.fetch_add(1, Ordering::Relaxed)
}

impl ThreadId {
	#[must_use]
	pub fn generate() -> Self {
		Self(format!("thr_{:016x}", next_suffix()))
	}
}

impl TurnId {
	#[must_use]
	pub fn generate() -> Self {
		Self(format!("turn_{:016x}", next_suffix()))
	}
}

impl ItemId {
	#[must_use]
	pub fn generate() -> Self {
		Self(format!("item_{:016x}", next_suffix()))
	}
}

impl ConnectionId {
	#[must_use]
	pub fn generate() -> Self {
		Self(format!("conn_{:016x}", next_suffix()))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn generated_thread_ids_are_unique() {
		let a = ThreadId::generate();
		let b = ThreadId::generate();
		assert_ne!(a, b);
	}

	#[test]
	fn generation_advances_monotonically() {
		let g1 = BackendGeneration::FIRST;
		let g2 = g1.next();
		assert!(g2 > g1);
		assert_eq!(g2, BackendGeneration(2));
	}

	#[test]
	fn ids_serialize_transparently() {
		let id = ThreadId("thr_x".into());
		assert_eq!(serde_json::to_string(&id).unwrap(), "\"thr_x\"");
	}
}
