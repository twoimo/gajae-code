//! Per-thread command scheduling and admission control (Phase 0A gate).
//!
//! Each thread owns a scheduler with three lanes, mirroring the old RPC
//! serial-chain + fast-lane design:
//! - **Mutating** (serial, ordered within a thread): turn/start, steer that
//!   changes state, setters, compact, handoff, login, registrations, todos,
//!   session switch/branch, destructive thread ops.
//! - **Cancel** (fast lane, bypasses the mutating queue): turn/interrupt,
//!   command/exec/terminate, bash abort, retry abort, backend dispose.
//! - **Read** (fast lane, snapshots live state): thread/read, loaded/list,
//!   gjc/state/read, gjc/messages/get, model list, session stats, etc.
//!
//! Cross-thread operations run concurrently; any shared resource they touch
//! must have passed the isolation contract in `docs/phase0-isolation-audit.md`.
//!
//! Inbound admission checks per-thread bounded queues BEFORE accepting a turn.
//! If capacity is unavailable, the request is rejected with `-32001` before the
//! backend is ever called.

use crate::error::AppServerError;

/// Which lane a method dispatches on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
	/// Serial, ordered per thread.
	Mutating,
	/// Fast lane, bypasses the mutating queue (cancellation/teardown).
	Cancel,
	/// Fast lane, snapshots live state (reads).
	Read,
}

/// Classify a method name into its scheduling lane.
///
/// Unknown methods default to [`Lane::Mutating`] (conservative: unknown effects
/// are treated as ordered mutations). Method-not-found is handled earlier by
/// the dispatcher; this only decides ordering for known/dispatchable methods.
#[must_use]
pub fn classify(method: &str) -> Lane {
	match method {
		// Cancel / teardown fast lane.
		"turn/interrupt"
		| "command/exec/terminate"
		| "gjc/bash/abort"
		| "gjc/retry/abort"
		| "thread/dispose"
		| "thread/unsubscribe" => Lane::Cancel,

		// Read fast lane (snapshot live state).
		"thread/read"
		| "thread/loaded/list"
		| "thread/list"
		| "gjc/state/read"
		| "gjc/context/read"
		| "gjc/goal/read"
		| "gjc/model/catalog"
		| "gjc/thinking/read"
		| "gjc/fast/read"
		| "gjc/settings/schema"
		| "gjc/settings/read"
		| "gjc/appearance/themes/list"
		| "gjc/appearance/read"
		| "gjc/provider/list"
		| "gjc/auth/status"
		| "gjc/todos/read"
		| "gjc/usage/read"
		| "gjc/jobs/list"
		| "gjc/agents/list"
		| "gjc/monitors/list"
		| "gjc/compact/summary"
		| "gjc/session/list"
		| "gjc/session/search"
		| "gjc/session/tree"
		| "gjc/session/export"
		| "gjc/tools/list"
		| "gjc/commands/list"
		| "gjc/skills/list"
		| "gjc/extensions/list"
		| "gjc/extensions/inspect"
		| "gjc/plugins/list"
		| "gjc/plugins/inspect"
		| "gjc/messages/get"
		| "gjc/model/list"
		| "gjc/session/stats"
		| "gjc/branch/messages"
		| "gjc/lastAssistantText"
		| "gjc/workflowGate/list" => Lane::Read,

		// Everything else (turn/start, steer, setters, compact, handoff, login,
		// registrations, todos, switch/branch, destructive ops, and unknowns).
		_ => Lane::Mutating,
	}
}

/// Per-thread bounded admission control. Turn-accepting requests must pass
///
/// [`Admission::try_admit_turn`] before the backend is called; cancel/read
/// lanes are never rejected for capacity (they must reach in-flight work).
#[derive(Debug)]
pub struct Admission {
	max_inflight_turns: usize,
	inflight_turns: usize,
	max_queued_mutations: usize,
	queued_mutations: usize,
}

impl Admission {
	#[must_use]
	pub const fn new(max_inflight_turns: usize, max_queued_mutations: usize) -> Self {
		Self { max_inflight_turns, inflight_turns: 0, max_queued_mutations, queued_mutations: 0 }
	}

	/// Admit a turn if capacity allows, otherwise reject with `-32001` before
	/// any backend call. On success the caller owns one in-flight slot until
	/// [`Admission::complete_turn`].
	pub fn try_admit_turn(&mut self) -> crate::error::Result<()> {
		if self.inflight_turns >= self.max_inflight_turns {
			return Err(AppServerError::overloaded());
		}
		self.inflight_turns += 1;
		Ok(())
	}

	/// Release a previously admitted turn slot.
	pub const fn complete_turn(&mut self) {
		self.inflight_turns = self.inflight_turns.saturating_sub(1);
	}

	/// Enqueue a mutating (non-turn) command; rejected with `-32001` when the
	/// per-thread mutation queue is saturated.
	pub fn try_enqueue_mutation(&mut self) -> crate::error::Result<()> {
		if self.queued_mutations >= self.max_queued_mutations {
			return Err(AppServerError::overloaded());
		}
		self.queued_mutations += 1;
		Ok(())
	}

	pub const fn dequeue_mutation(&mut self) {
		self.queued_mutations = self.queued_mutations.saturating_sub(1);
	}

	#[must_use]
	pub const fn inflight_turns(&self) -> usize {
		self.inflight_turns
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::error::codes;

	#[test]
	fn classifies_lanes() {
		assert_eq!(classify("turn/start"), Lane::Mutating);
		assert_eq!(classify("turn/interrupt"), Lane::Cancel);
		assert_eq!(classify("thread/read"), Lane::Read);
		assert_eq!(classify("gjc/state/read"), Lane::Read);
		assert_eq!(classify("gjc/session/list"), Lane::Read);
		assert_eq!(classify("gjc/session/search"), Lane::Read);
		assert_eq!(classify("gjc/session/tree"), Lane::Read);
		assert_eq!(classify("gjc/tools/list"), Lane::Read);
		assert_eq!(classify("gjc/commands/list"), Lane::Read);
		assert_eq!(classify("gjc/skills/list"), Lane::Read);
		assert_eq!(classify("gjc/extensions/list"), Lane::Read);
		assert_eq!(classify("gjc/plugins/list"), Lane::Read);
		assert_eq!(classify("gjc/provider/list"), Lane::Read);
		assert_eq!(classify("gjc/auth/status"), Lane::Read);
		assert_eq!(classify("gjc/auth/logout"), Lane::Mutating);
		assert_eq!(classify("gjc/session/open"), Lane::Mutating);
		assert_eq!(classify("gjc/session/delete"), Lane::Mutating);
		assert_eq!(classify("gjc/session/navigate"), Lane::Mutating);
		assert_eq!(classify("gjc/session/label"), Lane::Mutating);
		assert_eq!(classify("gjc/model/set"), Lane::Mutating);
		// Unknown methods are conservatively treated as ordered mutations.
		assert_eq!(classify("gjc/some/futureMethod"), Lane::Mutating);
	}

	#[test]
	fn admits_turns_up_to_capacity_then_overloads() {
		let mut a = Admission::new(2, 8);
		assert!(a.try_admit_turn().is_ok());
		assert!(a.try_admit_turn().is_ok());
		let e = a.try_admit_turn().unwrap_err();
		assert_eq!(e.code, codes::SERVER_OVERLOADED);
		// Freeing a slot re-admits.
		a.complete_turn();
		assert!(a.try_admit_turn().is_ok());
	}

	#[test]
	fn concurrent_turns_are_allowed_up_to_limit() {
		// Full concurrency: multiple in-flight turns coexist (no cap-to-one).
		let mut a = Admission::new(4, 8);
		for _ in 0..4 {
			a.try_admit_turn().unwrap();
		}
		assert_eq!(a.inflight_turns(), 4);
	}

	#[test]
	fn mutation_queue_saturation_overloads() {
		let mut a = Admission::new(1, 1);
		assert!(a.try_enqueue_mutation().is_ok());
		assert_eq!(a.try_enqueue_mutation().unwrap_err().code, codes::SERVER_OVERLOADED);
		a.dequeue_mutation();
		assert!(a.try_enqueue_mutation().is_ok());
	}
}
