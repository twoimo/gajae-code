//! Item/turn lifecycle state machine core (Phase 0A gate).
//!
//! This is the deterministic core the full `event_map` builds on: item/turn
//! state enums, a monotonic per-thread sequence counter, and the terminal
//! coalescing latch. The coalescing rule guarantees exactly one `turn/completed`
//! per turn: `message_end`, `turn_end`, `agent_end`, `abort`, and backend errors
//! all race into one latch, and the highest-priority cause wins
//! (`Failed` > `Interrupted` > `Completed`) unless a later fatal error arrives
//! before the terminal flush.

use serde::{Deserialize, Serialize};

/// Item lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ItemState {
    New,
    Started,
    Streaming,
    Completing,
    Completed,
    Failed,
    Interrupted,
}

/// Turn lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnState {
    Idle,
    Accepted,
    Started,
    Completing,
    Completed,
    Failed,
    Interrupted,
}

/// Terminal cause for a turn. Priority: `Failed` > `Interrupted` > `Completed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCause {
    Completed,
    Interrupted,
    Failed,
}

impl TerminalCause {
    #[must_use]
    const fn priority(self) -> u8 {
        match self {
            Self::Completed => 0,
            Self::Interrupted => 1,
            Self::Failed => 2,
        }
    }
}

/// Coalesces multiple terminal signals for a single turn into one final cause.
///
/// The first flush emits exactly one `turn/completed`; higher-priority causes
/// arriving before the flush upgrade the recorded cause.
#[derive(Debug, Default)]
pub struct TerminalLatch {
    cause: Option<TerminalCause>,
    flushed: bool,
}

impl TerminalLatch {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a terminal signal. Returns `true` if this call changed the
    /// pending cause (newly set or upgraded by priority). Ignored after flush.
    pub const fn record(&mut self, cause: TerminalCause) -> bool {
        if self.flushed {
            return false;
        }
        match self.cause {
            Some(existing) if existing.priority() >= cause.priority() => false,
            _ => {
                self.cause = Some(cause);
                true
            }
        }
    }

    /// Whether a terminal cause has been recorded and not yet flushed.
    #[must_use]
    pub const fn is_pending(&self) -> bool {
        self.cause.is_some() && !self.flushed
    }

    /// Flush exactly once, returning the winning cause. Subsequent calls return
    /// `None` (the single `turn/completed` guarantee).
    pub const fn flush(&mut self) -> Option<TerminalCause> {
        if self.flushed {
            return None;
        }
        self.flushed = true;
        self.cause
    }

    #[must_use]
    pub const fn map_turn_state(cause: TerminalCause) -> TurnState {
        match cause {
            TerminalCause::Completed => TurnState::Completed,
            TerminalCause::Interrupted => TurnState::Interrupted,
            TerminalCause::Failed => TurnState::Failed,
        }
    }
}

/// Monotonic per-thread notification sequence number.
#[derive(Debug, Default)]
pub struct SeqCounter(u64);

impl SeqCounter {
    pub const fn next(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }

    #[must_use]
    pub const fn current(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_end_then_agent_end_coalesces_one_completed() {
        let mut latch = TerminalLatch::new();
        assert!(latch.record(TerminalCause::Completed)); // message_end
        assert!(!latch.record(TerminalCause::Completed)); // agent_end — no change
        assert_eq!(latch.flush(), Some(TerminalCause::Completed));
        assert_eq!(latch.flush(), None); // exactly one turn/completed
    }

    #[test]
    fn failed_beats_completed() {
        let mut latch = TerminalLatch::new();
        latch.record(TerminalCause::Completed);
        assert!(latch.record(TerminalCause::Failed)); // upgrade
        assert_eq!(latch.flush(), Some(TerminalCause::Failed));
    }

    #[test]
    fn failed_beats_interrupted_and_completed_regardless_of_order() {
        let mut latch = TerminalLatch::new();
        latch.record(TerminalCause::Failed);
        assert!(!latch.record(TerminalCause::Interrupted)); // lower priority, no change
        assert!(!latch.record(TerminalCause::Completed));
        assert_eq!(latch.flush(), Some(TerminalCause::Failed));
    }

    #[test]
    fn late_error_before_flush_wins_over_interrupted() {
        let mut latch = TerminalLatch::new();
        latch.record(TerminalCause::Interrupted);
        assert!(latch.record(TerminalCause::Failed)); // backend error before flush
        assert_eq!(latch.flush(), Some(TerminalCause::Failed));
    }

    #[test]
    fn record_after_flush_is_ignored() {
        let mut latch = TerminalLatch::new();
        latch.record(TerminalCause::Completed);
        latch.flush();
        assert!(!latch.record(TerminalCause::Failed));
        assert_eq!(latch.flush(), None);
    }

    #[test]
    fn seq_counter_is_monotonic() {
        let mut s = SeqCounter::default();
        assert_eq!(s.next(), 1);
        assert_eq!(s.next(), 2);
        assert_eq!(s.current(), 2);
    }
}
