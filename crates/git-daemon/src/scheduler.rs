//! Concurrency-bounded work scheduling for the serve loop.
//!
//! Single-flight (one active run per item) is enforced by the store’s item
//! locks; this scheduler bounds the *total* number of concurrent runs across
//! items to `max_concurrency` and picks the next items to dispatch in FIFO
//! order. With budgets/caps disabled (D3/D4), concurrency is the only global
//! throttle, so it must be honored exactly.

/// How many new runs may start given the active count and the cap.
#[must_use]
pub const fn available_slots(active: u32, max_concurrency: u32) -> u32 {
	max_concurrency.saturating_sub(active)
}

/// Whether at least one new run may start.
#[must_use]
pub const fn can_start(active: u32, max_concurrency: u32) -> bool {
	available_slots(active, max_concurrency) > 0
}

/// Pick the next queued work keys to dispatch (FIFO), up to the available
/// slots.
///
/// Returns borrowed keys in queue order; the caller acquires per-item locks
/// (a lock conflict simply means that item is skipped this tick).
#[must_use]
pub fn pick_next(queue: &[String], active: u32, max_concurrency: u32) -> &[String] {
	let slots = available_slots(active, max_concurrency) as usize;
	let take = slots.min(queue.len());
	&queue[..take]
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn slots_respect_the_cap() {
		assert_eq!(available_slots(0, 3), 3);
		assert_eq!(available_slots(2, 3), 1);
		assert_eq!(available_slots(3, 3), 0);
		// Never negative / underflow.
		assert_eq!(available_slots(5, 3), 0);
	}

	#[test]
	fn can_start_only_with_free_slots() {
		assert!(can_start(0, 2));
		assert!(can_start(1, 2));
		assert!(!can_start(2, 2));
	}

	#[test]
	fn pick_next_takes_fifo_up_to_slots() {
		let queue = vec!["a".to_owned(), "b".to_owned(), "c".to_owned(), "d".to_owned()];
		// 1 active, cap 3 -> 2 free slots -> first two in order.
		assert_eq!(pick_next(&queue, 1, 3), &["a".to_owned(), "b".to_owned()]);
	}

	#[test]
	fn pick_next_empty_when_full() {
		let queue = vec!["a".to_owned()];
		assert!(pick_next(&queue, 3, 3).is_empty());
	}

	#[test]
	fn pick_next_bounded_by_queue_length() {
		let queue = vec!["a".to_owned()];
		// Plenty of slots but only one queued item.
		assert_eq!(pick_next(&queue, 0, 5), &["a".to_owned()]);
	}
}
