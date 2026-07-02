//! Tokio durable event dispatcher with per-issue serialization.

use std::{
	collections::{HashMap, HashSet},
	future::Future,
	pin::Pin,
	sync::{Arc, Mutex},
	time::Duration,
};

use tokio::{
	sync::{Notify, Semaphore},
	task::JoinHandle,
};
use tracing::warn;

use crate::{
	cancellation::CancellationRegistry,
	db::{Database, DbResult, EventRow},
	slot_pool::SlotPool,
};

pub type TaskResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub type TaskFuture<'a> = Pin<Box<dyn Future<Output = TaskResult> + Send + 'a>>;

pub trait TaskWorker: Send + Sync + 'static {
	fn run_task<'a>(&'a self, row: EventRow, ctx: TaskContext) -> TaskFuture<'a>;
}

#[derive(Clone)]
pub struct TaskContext {
	pub slot_uid: Option<u32>,
	pub cancellations: CancellationRegistry,
}

pub type ReapSlot = Arc<dyn Fn(u32) + Send + Sync>;

pub struct WorkerPool<W: TaskWorker> {
	db: Arc<Database>,
	worker: Arc<W>,
	max_concurrency: usize,
	slot_pool: Option<SlotPool>,
	reap_slot: ReapSlot,
	inflight: Arc<Mutex<HashSet<String>>>,
	inflight_tasks: Arc<Mutex<HashMap<tokio::task::Id, (String, JoinHandle<()>)>>>,
	shutdown_cancelled: Arc<Mutex<HashSet<String>>>,
	cancellations: CancellationRegistry,
	stop: Arc<Notify>,
	wakeup: Arc<Notify>,
	dispatcher: Option<JoinHandle<()>>,
}

impl<W: TaskWorker> WorkerPool<W> {
	pub fn new(
		db: Arc<Database>,
		worker: Arc<W>,
		max_concurrency: usize,
		slot_pool: Option<SlotPool>,
	) -> Self {
		Self::with_reaper(db, worker, max_concurrency, slot_pool, Arc::new(|_| {}))
	}

	pub fn with_reaper(
		db: Arc<Database>,
		worker: Arc<W>,
		max_concurrency: usize,
		slot_pool: Option<SlotPool>,
		reap_slot: ReapSlot,
	) -> Self {
		Self {
			db,
			worker,
			max_concurrency: max_concurrency.max(1),
			slot_pool,
			reap_slot,
			inflight: Arc::new(Mutex::new(HashSet::new())),
			inflight_tasks: Arc::new(Mutex::new(HashMap::new())),
			shutdown_cancelled: Arc::new(Mutex::new(HashSet::new())),
			cancellations: CancellationRegistry::default(),
			stop: Arc::new(Notify::new()),
			wakeup: Arc::new(Notify::new()),
			dispatcher: None,
		}
	}

	pub fn cancellations(&self) -> CancellationRegistry {
		self.cancellations.clone()
	}
	pub fn wake(&self) {
		self.wakeup.notify_one();
	}
	pub fn inflight_snapshot(&self) -> Vec<String> {
		let mut keys: Vec<_> = self
			.inflight
			.lock()
			.expect("inflight poisoned")
			.iter()
			.cloned()
			.collect();
		keys.sort();
		keys
	}

	pub async fn start(&mut self) -> DbResult<()> {
		if let Some(pool) = &self.slot_pool {
			for uid in pool.slot_uids() {
				(self.reap_slot)(*uid);
			}
		}
		self.db.reset_stuck_running()?;
		let runner = Runner {
			db: self.db.clone(),
			worker: self.worker.clone(),
			slot_pool: self.slot_pool.clone(),
			semaphore: if self.slot_pool.is_none() {
				Some(Arc::new(Semaphore::new(self.max_concurrency)))
			} else {
				None
			},
			reap_slot: self.reap_slot.clone(),
			inflight: self.inflight.clone(),
			inflight_tasks: self.inflight_tasks.clone(),
			shutdown_cancelled: self.shutdown_cancelled.clone(),
			cancellations: self.cancellations.clone(),
			stop: self.stop.clone(),
			wakeup: self.wakeup.clone(),
		};
		self.dispatcher = Some(tokio::spawn(async move {
			runner.dispatch_loop().await;
		}));
		Ok(())
	}

	pub async fn stop(&mut self, drain_timeout: Duration, kill_timeout: Duration) {
		self.stop.notify_waiters();
		self.wakeup.notify_waiters();
		if let Some(dispatcher) = self.dispatcher.take() {
			dispatcher.abort();
			let _ = dispatcher.await;
		}
		let handles: Vec<_> = self
			.inflight_tasks
			.lock()
			.expect("tasks poisoned")
			.values()
			.map(|(_, h)| h.abort_handle())
			.collect();
		if handles.is_empty() {
			return;
		}
		let tasks = self.inflight_tasks.clone();
		let drained = tokio::time::timeout(drain_timeout, async move {
			loop {
				if tasks.lock().expect("tasks poisoned").is_empty() {
					break;
				}
				tokio::time::sleep(Duration::from_millis(5)).await;
			}
		})
		.await
		.is_ok();
		if drained {
			return;
		}
		let pending: Vec<_> = self
			.inflight_tasks
			.lock()
			.expect("tasks poisoned")
			.drain()
			.map(|(_, (d, h))| (d, h))
			.collect();
		for (delivery, handle) in pending {
			self
				.shutdown_cancelled
				.lock()
				.expect("shutdown set poisoned")
				.insert(delivery.clone());
			let _ = self.cancellations.cancel(delivery);
			handle.abort();
			let _ = tokio::time::timeout(kill_timeout, handle).await;
		}
	}

	pub fn cancel_event(&self, delivery_id: &str) -> bool {
		self.cancellations.cancel(delivery_id.to_owned())
	}
	pub async fn run_event_for_test(&self, row: EventRow) {
		self.runner().run_event(row).await;
	}
	fn runner(&self) -> Runner<W> {
		Runner {
			db: self.db.clone(),
			worker: self.worker.clone(),
			slot_pool: self.slot_pool.clone(),
			semaphore: None,
			reap_slot: self.reap_slot.clone(),
			inflight: self.inflight.clone(),
			inflight_tasks: self.inflight_tasks.clone(),
			shutdown_cancelled: self.shutdown_cancelled.clone(),
			cancellations: self.cancellations.clone(),
			stop: self.stop.clone(),
			wakeup: self.wakeup.clone(),
		}
	}
}

struct Runner<W: TaskWorker> {
	db: Arc<Database>,
	worker: Arc<W>,
	slot_pool: Option<SlotPool>,
	semaphore: Option<Arc<Semaphore>>,
	reap_slot: ReapSlot,
	inflight: Arc<Mutex<HashSet<String>>>,
	inflight_tasks: Arc<Mutex<HashMap<tokio::task::Id, (String, JoinHandle<()>)>>>,
	shutdown_cancelled: Arc<Mutex<HashSet<String>>>,
	cancellations: CancellationRegistry,
	stop: Arc<Notify>,
	wakeup: Arc<Notify>,
}

struct EventGuard {
	key: String,
	delivery_id: String,
	slot: Option<u32>,
	slot_pool: Option<SlotPool>,
	reap_slot: ReapSlot,
	inflight: Arc<Mutex<HashSet<String>>>,
	shutdown_cancelled: Arc<Mutex<HashSet<String>>>,
	cancellations: CancellationRegistry,
}

impl EventGuard {
	fn set_slot(&mut self, slot: Option<u32>) {
		self.slot = slot;
	}
}

impl Drop for EventGuard {
	fn drop(&mut self) {
		self.cancellations.clear(&self.delivery_id);
		self
			.shutdown_cancelled
			.lock()
			.expect("shutdown poisoned")
			.remove(&self.delivery_id);
		if let Some(uid) = self.slot.take() {
			(self.reap_slot)(uid);
			if let Some(pool) = &self.slot_pool {
				let _ = pool.release(Some(uid));
			}
		}
		self
			.inflight
			.lock()
			.expect("inflight poisoned")
			.remove(&self.key);
	}
}

impl<W: TaskWorker> Clone for Runner<W> {
	fn clone(&self) -> Self {
		Self {
			db: self.db.clone(),
			worker: self.worker.clone(),
			slot_pool: self.slot_pool.clone(),
			semaphore: self.semaphore.clone(),
			reap_slot: self.reap_slot.clone(),
			inflight: self.inflight.clone(),
			inflight_tasks: self.inflight_tasks.clone(),
			shutdown_cancelled: self.shutdown_cancelled.clone(),
			cancellations: self.cancellations.clone(),
			stop: self.stop.clone(),
			wakeup: self.wakeup.clone(),
		}
	}
}

impl<W: TaskWorker> Runner<W> {
	fn prune_completed_tasks(&self) {
		self
			.inflight_tasks
			.lock()
			.expect("tasks poisoned")
			.retain(|_, (_, handle)| !handle.is_finished());
	}

	async fn dispatch_loop(self) {
		loop {
			self.prune_completed_tasks();
			tokio::select! { _ = self.stop.notified() => break, _ = async {} => {} }
			match self.claim_next_unique().await {
				Ok(Some(row)) => {
					let delivery = row.delivery_id.clone();
					let runner = self.clone();
					let tasks = runner.inflight_tasks.clone();
					let handle = tokio::spawn(async move {
						runner.run_event(row).await;
						let id = tokio::task::id();
						tasks.lock().expect("tasks poisoned").remove(&id);
					});
					let id = handle.id();
					self
						.inflight_tasks
						.lock()
						.expect("tasks poisoned")
						.insert(id, (delivery, handle));
					self.prune_completed_tasks();
				},
				Ok(None) => {
					tokio::select! { _ = self.stop.notified() => break, _ = self.wakeup.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(25)) => {} }
				},
				Err(e) => {
					warn!(error=%e, "claim failed");
					tokio::time::sleep(Duration::from_millis(25)).await;
				},
			}
		}
	}

	async fn claim_next_unique(&self) -> DbResult<Option<EventRow>> {
		let row = self.db.claim_next_event()?;
		let Some(row) = row else {
			return Ok(None);
		};
		let key = row
			.issue_key
			.clone()
			.unwrap_or_else(|| row.delivery_id.clone());
		let already = {
			let mut inflight = self.inflight.lock().expect("inflight poisoned");
			!inflight.insert(key)
		};
		if already {
			self
				.db
				.requeue_event(&row.delivery_id, Some(&["running"]))?;
			Ok(None)
		} else {
			Ok(Some(row))
		}
	}

	async fn run_event(self, row: EventRow) {
		let key = row
			.issue_key
			.clone()
			.unwrap_or_else(|| row.delivery_id.clone());
		let mut guard = EventGuard {
			key: key.clone(),
			delivery_id: row.delivery_id.clone(),
			slot: None,
			slot_pool: self.slot_pool.clone(),
			reap_slot: self.reap_slot.clone(),
			inflight: self.inflight.clone(),
			shutdown_cancelled: self.shutdown_cancelled.clone(),
			cancellations: self.cancellations.clone(),
		};
		let result = async {
			if let Some(pool) = &self.slot_pool {
				let acquired = pool.acquire().await;
				guard.set_slot(acquired);
				self.dispatch_and_mark(row.clone(), guard.slot).await
			} else if let Some(semaphore) = &self.semaphore {
				let _permit = semaphore
					.acquire()
					.await
					.map_err(|e| format!("semaphore closed: {e}"))?;
				self.dispatch_and_mark(row.clone(), None).await
			} else {
				self.dispatch_and_mark(row.clone(), None).await
			}
		}
		.await;
		if let Err(e) = result {
			let shutdown = self
				.shutdown_cancelled
				.lock()
				.expect("shutdown poisoned")
				.contains(&row.delivery_id);
			if shutdown {
				// Preserve running for reset_stuck_running().
			} else if self.cancellations.is_cancelled(&row.delivery_id) {
				let _ = self
					.db
					.mark_event(&row.delivery_id, "failed", Some("cancelled by operator"));
			} else {
				let _ = self
					.db
					.mark_event(&row.delivery_id, "failed", Some(&e.to_string()));
			}
		}
	}

	async fn dispatch_and_mark(&self, row: EventRow, slot_uid: Option<u32>) -> TaskResult {
		self
			.worker
			.run_task(row.clone(), TaskContext { slot_uid, cancellations: self.cancellations.clone() })
			.await?;
		if self.cancellations.is_cancelled(&row.delivery_id) {
			self
				.db
				.mark_event(&row.delivery_id, "failed", Some("cancelled by operator"))?;
		} else {
			self.db.mark_event(&row.delivery_id, "done", None)?;
		}
		Ok(())
	}
}

#[cfg(test)]
mod queue_tests {
	use super::*;
	use serde_json::json;
	use std::sync::atomic::{AtomicUsize, Ordering};
	use tempfile::tempdir;
	use tokio::sync::Mutex as AsyncMutex;

	struct FakeWorker {
		calls: Arc<AsyncMutex<Vec<(String, Option<u32>)>>>,
		fail: Option<&'static str>,
		park: Option<Arc<Notify>>,
		cancel_mid: bool,
	}
	impl TaskWorker for FakeWorker {
		fn run_task<'a>(&'a self, row: EventRow, ctx: TaskContext) -> TaskFuture<'a> {
			Box::pin(async move {
				self
					.calls
					.lock()
					.await
					.push((row.delivery_id.clone(), ctx.slot_uid));
				if self.cancel_mid {
					ctx.cancellations.cancel(row.delivery_id.clone());
					return Err("subprocess died".into());
				}
				if let Some(p) = &self.park {
					p.notified().await;
				}
				if let Some(e) = self.fail {
					Err(e.into())
				} else {
					Ok(())
				}
			})
		}
	}
	fn db() -> (tempfile::TempDir, Arc<Database>) {
		let d = tempdir().unwrap();
		let db = Arc::new(Database::open(d.path().join("t.sqlite")).unwrap());
		(d, db)
	}
	fn row(id: &str, key: &str) -> EventRow {
		EventRow {
			delivery_id: id.into(),
			event_type: "issues".into(),
			repo: Some("octo/widget".into()),
			issue_key: Some(key.into()),
			payload: json!({"action":"opened"}),
			received_at: "now".into(),
			state: "running".into(),
			attempts: 1,
			last_error: None,
		}
	}

	#[tokio::test]
	async fn queue_cancel_marks_failed_with_marker_and_clears_state() {
		let (_d, db) = db();
		db.record_event(
			"d",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#1"),
			&json!({}),
			"running",
			None,
		)
		.unwrap();
		let worker = Arc::new(FakeWorker {
			calls: Arc::new(AsyncMutex::new(vec![])),
			fail: None,
			park: None,
			cancel_mid: true,
		});
		let pool = WorkerPool::new(db.clone(), worker, 1, None);
		pool.run_event_for_test(row("d", "octo/widget#1")).await;
		let stored = db.get_event("d").unwrap().unwrap();
		assert_eq!(stored.state, "failed");
		assert_eq!(stored.last_error.as_deref(), Some("cancelled by operator"));
		assert!(!pool.cancellations().is_cancelled("d"));
	}

	#[tokio::test]
	async fn queue_shutdown_intentional_interrupt_leaves_running_but_unrelated_failure_fails() {
		let (_d, db) = db();
		for id in ["shutdown", "bug"] {
			db.record_event(
				id,
				"issues",
				Some("octo/widget"),
				Some("octo/widget#1"),
				&json!({}),
				"running",
				None,
			)
			.unwrap();
		}
		let worker = Arc::new(FakeWorker {
			calls: Arc::new(AsyncMutex::new(vec![])),
			fail: Some("boom"),
			park: None,
			cancel_mid: false,
		});
		let pool = WorkerPool::new(db.clone(), worker, 1, None);
		pool
			.shutdown_cancelled
			.lock()
			.unwrap()
			.insert("shutdown".into());
		pool
			.run_event_for_test(row("shutdown", "octo/widget#1"))
			.await;
		pool.run_event_for_test(row("bug", "octo/widget#1")).await;
		assert_eq!(db.get_event("shutdown").unwrap().unwrap().state, "running");
		assert_eq!(db.get_event("bug").unwrap().unwrap().state, "failed");
	}

	#[tokio::test]
	async fn queue_serialization_per_issue_and_pr_derived_key() {
		let (_d, db) = db();
		let calls = Arc::new(AsyncMutex::new(vec![]));
		let park = Arc::new(Notify::new());
		for (id, key) in [("d1", "octo/widget#1"), ("d3", "octo/widget#2"), ("d2", "octo/widget#1")] {
			db.record_event(
				id,
				"issue_comment",
				Some("octo/widget"),
				Some(key),
				&json!({}),
				"queued",
				None,
			)
			.unwrap();
		}
		let worker = Arc::new(FakeWorker {
			calls: calls.clone(),
			fail: None,
			park: Some(park.clone()),
			cancel_mid: false,
		});
		let mut pool = WorkerPool::new(db.clone(), worker, 3, None);
		pool.start().await.unwrap();
		tokio::time::sleep(Duration::from_millis(100)).await;
		let started = calls.lock().await.clone();
		assert_eq!(started.len(), 2);
		assert!(started.iter().any(|(d, _)| d == "d1"));
		assert!(started.iter().any(|(d, _)| d == "d3"));
		assert_eq!(db.get_event("d2").unwrap().unwrap().state, "queued");
		park.notify_waiters();
		tokio::time::sleep(Duration::from_millis(100)).await;
		pool.stop(Duration::ZERO, Duration::ZERO).await;
	}

	#[tokio::test]
	async fn queue_slot_reaped_before_release() {
		let (_d, db) = db();
		db.record_event(
			"d",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#1"),
			&json!({}),
			"running",
			None,
		)
		.unwrap();
		let order = Arc::new(Mutex::new(Vec::new()));
		let order2 = order.clone();
		let pool_slots = SlotPool::new([2001]).unwrap();
		let worker = Arc::new(FakeWorker {
			calls: Arc::new(AsyncMutex::new(vec![])),
			fail: None,
			park: None,
			cancel_mid: false,
		});
		let pool = WorkerPool::with_reaper(
			db.clone(),
			worker,
			1,
			Some(pool_slots.clone()),
			Arc::new(move |uid| order2.lock().unwrap().push(("reap", uid))),
		);
		pool.run_event_for_test(row("d", "octo/widget#1")).await;
		order
			.lock()
			.unwrap()
			.push(("acquire_after", pool_slots.acquire().await.unwrap()));
		assert_eq!(&order.lock().unwrap()[0], &("reap", 2001));
	}

	#[test]
	fn queue_start_reaps_configured_slot_uids_before_release_path() {
		let calls = Arc::new(AtomicUsize::new(0));
		let c = calls.clone();
		let (_d, db) = db();
		let worker = Arc::new(FakeWorker {
			calls: Arc::new(AsyncMutex::new(vec![])),
			fail: None,
			park: None,
			cancel_mid: false,
		});
		let rt = tokio::runtime::Runtime::new().unwrap();
		rt.block_on(async {
			let mut pool = WorkerPool::with_reaper(
				db,
				worker,
				1,
				Some(SlotPool::new([2001, 2002]).unwrap()),
				Arc::new(move |_| {
					c.fetch_add(1, Ordering::SeqCst);
				}),
			);
			pool.start().await.unwrap();
			pool.stop(Duration::ZERO, Duration::ZERO).await;
		});
		assert_eq!(calls.load(Ordering::SeqCst), 2);
	}

	#[tokio::test]
	async fn queue_completed_handles_are_pruned_before_stop() {
		let (_d, db) = db();
		db.record_event(
			"d",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#1"),
			&json!({}),
			"queued",
			None,
		)
		.unwrap();
		let worker = Arc::new(FakeWorker {
			calls: Arc::new(AsyncMutex::new(vec![])),
			fail: None,
			park: None,
			cancel_mid: false,
		});
		let mut pool = WorkerPool::new(db.clone(), worker, 1, None);
		pool.start().await.unwrap();
		for _ in 0..20 {
			pool.runner().prune_completed_tasks();
			if pool.inflight_tasks.lock().unwrap().is_empty()
				&& db.get_event("d").unwrap().unwrap().state == "done"
			{
				break;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		assert_eq!(db.get_event("d").unwrap().unwrap().state, "done");
		assert!(pool.inflight_tasks.lock().unwrap().is_empty());
		pool
			.stop(Duration::from_millis(1), Duration::from_millis(1))
			.await;
	}

	#[tokio::test]
	async fn queue_hookless_abort_releases_slot_and_inflight_state() {
		let (_d, db) = db();
		db.record_event(
			"d",
			"issues",
			Some("octo/widget"),
			Some("octo/widget#1"),
			&json!({}),
			"queued",
			None,
		)
		.unwrap();
		let park = Arc::new(Notify::new());
		let calls = Arc::new(AsyncMutex::new(vec![]));
		let reaped = Arc::new(AtomicUsize::new(0));
		let reaped2 = reaped.clone();
		let slots = SlotPool::new([2001]).unwrap();
		let worker = Arc::new(FakeWorker {
			calls: calls.clone(),
			fail: None,
			park: Some(park),
			cancel_mid: false,
		});
		let mut pool = WorkerPool::with_reaper(
			db.clone(),
			worker,
			1,
			Some(slots.clone()),
			Arc::new(move |_| {
				reaped2.fetch_add(1, Ordering::SeqCst);
			}),
		);
		pool.start().await.unwrap();
		for _ in 0..20 {
			if !calls.lock().await.is_empty() {
				break;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		pool.stop(Duration::ZERO, Duration::from_millis(100)).await;
		assert!(pool.inflight_snapshot().is_empty());
		assert!(!pool.cancellations().is_cancelled("d"));
		assert!(reaped.load(Ordering::SeqCst) >= 1);
		assert_eq!(slots.acquire().await, Some(2001));
	}
}
