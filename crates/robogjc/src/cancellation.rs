//! Per-event cancellation registry with pre-arm and late-arm semantics.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub type CancelHook = Box<dyn FnOnce() + Send + 'static>;

#[derive(Debug, Clone, Default)]
pub struct CancellationRegistry {
	inner: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
	cancelled: HashSet<String>,
	hooks: HashMap<String, CancelHook>,
}

impl std::fmt::Debug for State {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("State")
			.field("cancelled", &self.cancelled)
			.field("hooks", &self.hooks.keys().collect::<Vec<_>>())
			.finish()
	}
}

impl CancellationRegistry {
	pub fn arm(&self, delivery_id: impl Into<String>, hook: impl FnOnce() + Send + 'static) -> bool {
		let delivery_id = delivery_id.into();
		let hook: CancelHook = Box::new(hook);
		let hook = {
			let mut state = self.inner.lock().expect("cancellation registry poisoned");
			if state.cancelled.contains(&delivery_id) {
				Some(hook)
			} else {
				state.hooks.insert(delivery_id, hook);
				None
			}
		};
		if let Some(hook) = hook {
			hook();
			true
		} else {
			false
		}
	}

	pub fn disarm(&self, delivery_id: &str) {
		self
			.inner
			.lock()
			.expect("cancellation registry poisoned")
			.hooks
			.remove(delivery_id);
	}

	pub fn cancel(&self, delivery_id: impl Into<String>) -> bool {
		let delivery_id = delivery_id.into();
		let hook = {
			let mut state = self.inner.lock().expect("cancellation registry poisoned");
			state.cancelled.insert(delivery_id.clone());
			state.hooks.remove(&delivery_id)
		};
		if let Some(hook) = hook {
			hook();
			true
		} else {
			false
		}
	}

	pub fn is_cancelled(&self, delivery_id: &str) -> bool {
		self
			.inner
			.lock()
			.expect("cancellation registry poisoned")
			.cancelled
			.contains(delivery_id)
	}

	pub fn clear(&self, delivery_id: &str) {
		let mut state = self.inner.lock().expect("cancellation registry poisoned");
		state.cancelled.remove(delivery_id);
		state.hooks.remove(delivery_id);
	}

	pub fn has_hook(&self, delivery_id: &str) -> bool {
		self
			.inner
			.lock()
			.expect("cancellation registry poisoned")
			.hooks
			.contains_key(delivery_id)
	}
}

#[cfg(test)]
mod cancellation_tests {
	use super::*;
	use std::sync::Arc;
	use std::sync::atomic::{AtomicUsize, Ordering};

	#[test]
	fn cancellation_pre_arm_cancel_fires_immediately_on_registration() {
		let reg = CancellationRegistry::default();
		assert!(!reg.cancel("d1"));
		let calls = Arc::new(AtomicUsize::new(0));
		let seen = calls.clone();
		assert!(reg.arm("d1", move || {
			seen.fetch_add(1, Ordering::SeqCst);
		}));
		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert!(!reg.has_hook("d1"));
	}

	#[test]
	fn cancellation_late_arm_cancel_interrupts_once_and_is_idempotent() {
		let reg = CancellationRegistry::default();
		let calls = Arc::new(AtomicUsize::new(0));
		let seen = calls.clone();
		assert!(!reg.arm("d1", move || {
			seen.fetch_add(1, Ordering::SeqCst);
		}));
		assert!(reg.cancel("d1"));
		assert!(!reg.cancel("d1"));
		assert_eq!(calls.load(Ordering::SeqCst), 1);
		assert!(reg.is_cancelled("d1"));
	}

	#[test]
	fn cancellation_disarm_is_idempotent() {
		let reg = CancellationRegistry::default();
		reg.disarm("missing");
		reg.arm("d1", || {});
		reg.disarm("d1");
		reg.disarm("d1");
		assert!(!reg.has_hook("d1"));
	}
}
