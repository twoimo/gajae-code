//! Phase 4: per-session outbound backpressure queue.
//!
//! Semantic frames are never dropped. Non-semantic frames use latest-wins
//! coalescing when the queue is under pressure. Replay resume is driven by the
//! last delivered `seq` cursor, so a reconnect receives retained gaps from the
//! replay store rather than whatever remains in the live queue.

use std::collections::VecDeque;

use crate::frame::GjcFrame;
use crate::replay_store::{ReplayOutcome, ReplayStore};
use crate::{Seq, SessionId};

/// Result of enqueueing a frame under pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueDecision {
	Queued,
	Coalesced,
}

#[derive(Debug, Clone)]
struct QueuedFrame {
	frame: GjcFrame,
	semantic: bool,
}

/// Bounded per-session outbound queue.
#[derive(Debug)]
pub struct BackpressureQueue {
	session: SessionId,
	capacity: usize,
	queue: VecDeque<QueuedFrame>,
	lag: usize,
}

impl BackpressureQueue {
	#[must_use]
	pub fn new(session: SessionId, capacity: usize) -> Self {
		Self { session, capacity: capacity.max(1), queue: VecDeque::new(), lag: 0 }
	}

	/// Enqueue a frame. Semantic frames are always retained; non-semantic frames
	/// are coalesced by `(kind,type,correlation)` when capacity is reached.
	pub fn enqueue(&mut self, frame: GjcFrame, semantic: bool) -> EnqueueDecision {
		debug_assert_eq!(frame.session_id, self.session, "frame session must match queue");
		if self.queue.len() < self.capacity || semantic {
			self.queue.push_back(QueuedFrame { frame, semantic });
			self.lag = self.queue.len().saturating_sub(self.capacity);
			return EnqueueDecision::Queued;
		}

		if let Some(existing) = self.queue.iter_mut().rev().find(|queued| {
			!queued.semantic
				&& queued.frame.kind == frame.kind
				&& queued.frame.r#type == frame.r#type
				&& queued.frame.correlation_id == frame.correlation_id
		}) {
			existing.frame = frame;
		} else if let Some(pos) = self.queue.iter().position(|queued| !queued.semantic) {
			self.queue.remove(pos);
			self.queue.push_back(QueuedFrame { frame, semantic: false });
		} else {
			self.queue.push_back(QueuedFrame { frame, semantic: false });
		}
		self.lag = self
			.lag
			.saturating_add(1)
			.max(self.queue.len().saturating_sub(self.capacity));
		EnqueueDecision::Coalesced
	}

	/// Drain live queued frames with `seq > cursor` in order. Frames at or below
	/// the acknowledged cursor are dropped so they do not inflate capacity.
	pub fn drain_to(&mut self, cursor: Seq) -> Vec<GjcFrame> {
		let mut out = Vec::new();
		while let Some(queued) = self.queue.pop_front() {
			if queued.frame.seq > cursor {
				out.push(queued.frame);
			}
		}
		self.lag = self.queue.len().saturating_sub(self.capacity);
		out
	}

	/// Drop frames at or below the acknowledged cursor while retaining newer live frames.
	pub fn acknowledge_to(&mut self, cursor: Seq) {
		self.queue.retain(|queued| queued.frame.seq > cursor);
		self.lag = self.queue.len().saturating_sub(self.capacity);
	}

	#[must_use]
	pub const fn current_lag(&self) -> usize {
		self.lag
	}

	/// Resume from the last delivered cursor via replay store.
	#[must_use]
	pub fn resume_from(&self, replay: &ReplayStore, cursor: Seq) -> ReplayOutcome {
		replay.replay_from(cursor)
	}

	#[must_use]
	pub fn len(&self) -> usize {
		self.queue.len()
	}

	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.queue.is_empty()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::frame::FrameKind;
	use crate::{Direction, FrameId, PROTOCOL_VERSION};

	fn frame(seq: u64, ty: &str) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(format!("f{seq}")),
			session_id: SessionId("s".into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind: FrameKind::Event,
			r#type: ty.into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({"n": seq}),
		}
	}

	#[test]
	fn backpressure_resume() {
		let mut q = BackpressureQueue::new(SessionId("s".into()), 3);
		let mut replay = ReplayStore::new(SessionId("s".into()), 10);
		for seq in 1..=6 {
			let f = frame(seq, if seq % 2 == 0 { "status" } else { "semantic" });
			replay.append(f.clone());
			let semantic = seq % 2 == 1;
			q.enqueue(f, semantic);
		}
		assert!(q.current_lag() > 0);
		let live = q.drain_to(Seq(0));
		let live_seq: Vec<u64> = live.iter().map(|f| f.seq.0).collect();
		assert!(live_seq.contains(&1) && live_seq.contains(&3) && live_seq.contains(&5));
		assert_eq!(
			live_seq
				.iter()
				.filter(|seq| **seq % 2 == 0)
				.copied()
				.collect::<Vec<_>>(),
			vec![6]
		);
		let ReplayOutcome::Frames(resumed) = q.resume_from(&replay, Seq(2)) else {
			panic!("expected replay frames");
		};
		assert_eq!(resumed.iter().map(|f| f.seq.0).collect::<Vec<_>>(), vec![3, 4, 5, 6]);
	}

	#[test]
	fn drain_drops_pre_acknowledged_frames() {
		let mut q = BackpressureQueue::new(SessionId("s".into()), 4);
		for seq in 1..=4 {
			q.enqueue(frame(seq, "semantic"), true);
		}
		let drained = q.drain_to(Seq(2));
		assert_eq!(drained.iter().map(|f| f.seq.0).collect::<Vec<_>>(), vec![3, 4]);
		assert!(q.is_empty(), "acked frames must not remain queued");
	}
}
