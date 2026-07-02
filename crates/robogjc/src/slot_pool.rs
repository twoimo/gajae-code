//! Async slot UID pool for subprocess identity assignment.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

#[derive(Debug, Clone)]
pub struct SlotPool {
	inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
	slot_uids: Vec<u32>,
	state: Mutex<State>,
	notify: Notify,
}

#[derive(Debug)]
struct State {
	available: VecDeque<u32>,
	checked_out: HashSet<u32>,
}

impl SlotPool {
	pub fn new(slot_uids: impl IntoIterator<Item = u32>) -> Result<Self, SlotPoolError> {
		let slot_uids: Vec<u32> = slot_uids.into_iter().collect();
		let unique: HashSet<u32> = slot_uids.iter().copied().collect();
		if unique.len() != slot_uids.len() {
			return Err(SlotPoolError::DuplicateSlots);
		}
		Ok(Self {
			inner: Arc::new(Inner {
				state: Mutex::new(State {
					available: slot_uids.iter().copied().collect(),
					checked_out: HashSet::new(),
				}),
				slot_uids,
				notify: Notify::new(),
			}),
		})
	}

	pub fn slot_uids(&self) -> &[u32] {
		&self.inner.slot_uids
	}

	pub async fn acquire(&self) -> Option<u32> {
		if self.inner.slot_uids.is_empty() {
			return None;
		}
		loop {
			let notified = {
				let mut state = self.inner.state.lock().expect("slot pool mutex poisoned");
				if let Some(slot_uid) = state.available.pop_front() {
					state.checked_out.insert(slot_uid);
					return Some(slot_uid);
				}
				self.inner.notify.notified()
			};
			notified.await;
		}
	}

	pub fn release(&self, slot_uid: Option<u32>) -> Result<(), SlotPoolError> {
		if self.inner.slot_uids.is_empty() && slot_uid.is_none() {
			return Ok(());
		}
		let slot_uid = slot_uid.ok_or(SlotPoolError::SlotNotAcquired)?;
		let mut state = self.inner.state.lock().expect("slot pool mutex poisoned");
		if !state.checked_out.remove(&slot_uid) {
			return Err(SlotPoolError::SlotNotAcquired);
		}
		state.available.push_back(slot_uid);
		drop(state);
		self.inner.notify.notify_one();
		Ok(())
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotPoolError {
	DuplicateSlots,
	SlotNotAcquired,
}

impl std::fmt::Display for SlotPoolError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::DuplicateSlots => write!(f, "slot UIDs must be unique"),
			Self::SlotNotAcquired => write!(f, "slot UID was not acquired"),
		}
	}
}

impl std::error::Error for SlotPoolError {}

#[cfg(test)]
mod tests {
	use super::*;
	use tokio::time::{Duration, sleep, timeout};

	#[tokio::test]
	async fn empty_pool_is_noop() {
		let pool = SlotPool::new([]).unwrap();
		assert_eq!(pool.acquire().await, None);
		pool.release(None).unwrap();
	}

	#[tokio::test]
	async fn acquire_release_reuses_uid() {
		let pool = SlotPool::new([2001]).unwrap();
		assert_eq!(pool.acquire().await, Some(2001));
		pool.release(Some(2001)).unwrap();
		assert_eq!(pool.acquire().await, Some(2001));
	}

	#[tokio::test]
	async fn double_release_rejected() {
		let pool = SlotPool::new([2001]).unwrap();
		let slot_uid = pool.acquire().await;
		pool.release(slot_uid).unwrap();
		assert_eq!(pool.release(slot_uid).unwrap_err(), SlotPoolError::SlotNotAcquired);
	}

	#[test]
	fn duplicate_slots_rejected() {
		assert_eq!(SlotPool::new([2001, 2001]).unwrap_err(), SlotPoolError::DuplicateSlots);
	}

	#[tokio::test]
	async fn concurrent_acquire_waits_until_release() {
		let pool = SlotPool::new([2001]).unwrap();
		let first_slot_uid = pool.acquire().await;
		let clone = pool.clone();
		let second_acquire = tokio::spawn(async move { clone.acquire().await });
		sleep(Duration::from_millis(10)).await;
		assert!(!second_acquire.is_finished());
		pool.release(first_slot_uid).unwrap();
		assert_eq!(
			timeout(Duration::from_secs(1), second_acquire)
				.await
				.unwrap()
				.unwrap(),
			Some(2001)
		);
	}
}
