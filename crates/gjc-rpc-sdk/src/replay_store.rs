//! Phase 2: concrete in-memory replay store.
//!
//! A bounded per-session ring of frames keyed by `seq`, supporting resume from a
//! cursor (`runtime-port.md`, `protocol.md`). Semantic frames are never silently
//! lost: when the ring is full the oldest frame is evicted and the floor cursor
//! advances, so a resuming client whose cursor predates the floor is told to reset
//! (via `ReplayOutcome::ResetRequired`) instead of receiving a gap.

use std::collections::VecDeque;

use crate::frame::GjcFrame;
use crate::{Seq, SessionId};

/// Result of a replay request.
#[derive(Debug, Clone, PartialEq)]
pub enum ReplayOutcome {
	/// Frames with `seq > cursor`, in order. `replay` is set true on each.
	Frames(Vec<GjcFrame>),
	/// The cursor is older than the retained floor; the client must resubscribe
	/// from scratch (a `reset` frame) rather than receive a gap.
	ResetRequired { floor: Seq },
}

/// Bounded per-session replay ring.
#[derive(Debug)]
pub struct ReplayStore {
	session: SessionId,
	capacity: usize,
	frames: VecDeque<GjcFrame>,
}

impl ReplayStore {
	/// Create a store for `session` retaining at most `capacity` frames (min 1).
	#[must_use]
	pub fn new(session: SessionId, capacity: usize) -> Self {
		Self { session, capacity: capacity.max(1), frames: VecDeque::new() }
	}

	/// Append a live frame. Frames must arrive in strictly increasing `seq`.
	/// Evicts the oldest frame when at capacity (advancing the retained floor).
	pub fn append(&mut self, frame: GjcFrame) {
		debug_assert_eq!(frame.session_id, self.session, "frame session must match store");
		if let Some(last) = self.frames.back() {
			debug_assert!(frame.seq > last.seq, "frames must be appended in increasing seq");
		}
		if self.frames.len() == self.capacity {
			self.frames.pop_front();
		}
		self.frames.push_back(frame);
	}

	/// Lowest retained `seq`, if any.
	#[must_use]
	pub fn floor(&self) -> Option<Seq> {
		self.frames.front().map(|f| f.seq)
	}

	/// Replay frames strictly after `cursor`. If `cursor` is older than the floor
	/// (i.e. some frames after it were already evicted), require a reset.
	#[must_use]
	pub fn replay_from(&self, cursor: Seq) -> ReplayOutcome {
		if let Some(floor) = self.floor() {
			// A gap exists only when the very next frame the client needs (cursor+1)
			// is below the retained floor.
			if floor > Seq(cursor.0.saturating_add(1)) {
				return ReplayOutcome::ResetRequired { floor };
			}
		}
		let frames: Vec<GjcFrame> = self
			.frames
			.iter()
			.filter(|f| f.seq > cursor)
			.cloned()
			.map(|mut f| {
				f.replay = true;
				f
			})
			.collect();
		ReplayOutcome::Frames(frames)
	}

	/// Number of retained frames.
	#[must_use]
	pub fn len(&self) -> usize {
		self.frames.len()
	}

	/// Whether the store has no retained frames.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.frames.is_empty()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::frame::{FrameKind, GjcFrame};
	use crate::{Direction, FrameId, PROTOCOL_VERSION};

	fn frame(session: &str, seq: u64) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(format!("f{seq}")),
			session_id: SessionId(session.into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind: FrameKind::Event,
			r#type: "message_update".into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({"n": seq}),
		}
	}

	#[test]
	fn replays_frames_after_cursor_marked_replay() {
		let mut s = ReplayStore::new(SessionId("s".into()), 8);
		for i in 1..=4 {
			s.append(frame("s", i));
		}
		let ReplayOutcome::Frames(out) = s.replay_from(Seq(2)) else {
			panic!("expected frames");
		};
		assert_eq!(out.iter().map(|f| f.seq.0).collect::<Vec<_>>(), vec![3, 4]);
		assert!(out.iter().all(|f| f.replay));
	}

	#[test]
	fn eviction_advances_floor_and_requires_reset_on_gap() {
		let mut s = ReplayStore::new(SessionId("s".into()), 3);
		for i in 1..=5 {
			s.append(frame("s", i)); // retains seq 3,4,5
		}
		assert_eq!(s.len(), 3);
		assert_eq!(s.floor(), Some(Seq(3)));
		// A client resuming from seq 1 needs seq 2 (evicted) -> reset.
		assert_eq!(s.replay_from(Seq(1)), ReplayOutcome::ResetRequired { floor: Seq(3) });
		// A client resuming from seq 2 needs seq 3 (retained) -> no gap.
		let ReplayOutcome::Frames(out) = s.replay_from(Seq(2)) else {
			panic!("expected frames");
		};
		assert_eq!(out.iter().map(|f| f.seq.0).collect::<Vec<_>>(), vec![3, 4, 5]);
	}

	#[test]
	fn empty_store_replays_nothing() {
		let s = ReplayStore::new(SessionId("s".into()), 4);
		assert!(s.is_empty());
		assert_eq!(s.replay_from(Seq(0)), ReplayOutcome::Frames(vec![]));
	}
}
