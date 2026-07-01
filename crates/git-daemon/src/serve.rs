//! Serve-loop reconciliation tick.
//!
//! The continuous daemon loop (tokio interval timer + webhook receiver +
//! heartbeat) is the thin live wrapper; its core is a single reconciliation
//! **tick** that composes the already-tested scheduler + orchestrator: pick up
//! to the available concurrency slots from the ready queue and drive each item
//! through lock -> run -> SHA-bound gate -> merge. The tick is generic over the
//! forge + runner so it is integration-tested with in-memory fakes.

use crate::config::MergePolicy;
use crate::forge_adapter::ForgeAdapter;
use crate::keys::{ItemRef, WorkIntentKey};
use crate::orchestrator::{DriveOutcome, WorkRunner, drive_to_merge};
use crate::scheduler::available_slots;
use crate::store::{GitDaemonStateStore, StoreError};
use std::time::Duration;
use tokio::sync::watch;

/// Run one reconciliation tick over the ready queue, bounded by free slots.
///
/// `ready` is the FIFO list of `(item, work_key)` pairs eligible to run. At most
/// `available_slots(active, max_concurrency)` are driven this tick; the rest wait
/// for a later tick (single-flight per item is enforced by the store locks).
///
/// # Errors
/// Returns [`StoreError`] if driving an item hits a store failure other than a
/// lock conflict (which surfaces as [`DriveOutcome::LockBusy`]).
#[allow(clippy::future_not_send, reason = "driven on the daemon task; no cross-thread Send boundary yet")]
#[allow(clippy::too_many_arguments, reason = "explicit deps keep the tick pure/testable without a god-struct")]
pub async fn run_tick<F: ForgeAdapter, R: WorkRunner>(
	store: &mut GitDaemonStateStore,
	forge: &F,
	runner: &R,
	ready: &[(ItemRef, String)],
	policy: &MergePolicy,
	active: u32,
	max_concurrency: u32,
	now: &str,
	lease_expires_at: &str,
) -> Result<Vec<(String, DriveOutcome)>, StoreError> {
	let slots = available_slots(active, max_concurrency) as usize;
	let mut outcomes = Vec::new();
	for (item, work_key) in ready.iter().take(slots) {
		let outcome =
			drive_to_merge(store, forge, runner, item, work_key, policy, now, lease_expires_at).await?;
		outcomes.push((work_key.clone(), outcome));
	}
	Ok(outcomes)
}

/// Run one reconciliation pass sourced from the store's ready queue.
///
/// Loads up to `limit` ready work items (state `seen`/`queued`, FIFO) from the
/// store, reconstructs each [`ItemRef`] from its work-intent key, and drives the
/// batch through [`run_tick`]. Work items whose key fails to parse are skipped
/// (they cannot be reconstructed into a forge fetch); every other invariant —
/// single-flight locks, the SHA-bound gate — is enforced downstream.
///
/// # Errors
/// Returns [`StoreError`] on a store failure while listing or driving work.
#[allow(clippy::future_not_send, reason = "driven on the daemon task; no cross-thread Send boundary yet")]
#[allow(clippy::too_many_arguments, reason = "explicit deps keep the pass pure/testable without a god-struct")]
pub async fn serve_pass<F: ForgeAdapter, R: WorkRunner>(
	store: &mut GitDaemonStateStore,
	forge: &F,
	runner: &R,
	policy: &MergePolicy,
	active: u32,
	max_concurrency: u32,
	limit: u32,
	now: &str,
	lease_expires_at: &str,
) -> Result<Vec<(String, DriveOutcome)>, StoreError> {
	let ready: Vec<(ItemRef, String)> = store
		.list_ready_work(limit)?
		.into_iter()
		.filter_map(|(work_key, _kind, _node)| {
			WorkIntentKey(work_key.clone()).parse().map(|(item, _action)| (item, work_key))
		})
		.collect();
	run_tick(store, forge, runner, &ready, policy, active, max_concurrency, now, lease_expires_at).await
}

/// Run the always-on reconciliation loop until shutdown is signalled.
///
/// Ticks on a fixed `period`: each tick runs one [`serve_pass`] (locks enforce
/// single-flight, so passing `active = 0` is safe — items already running this
/// cycle surface as [`DriveOutcome::LockBusy`]). `clock` yields the
/// `(now, lease_expires_at)` timestamps for the tick. The loop exits when
/// `shutdown` flips to `true`, returning the number of ticks executed (drain
/// before stop: an in-progress tick always completes).
///
/// # Errors
/// Returns [`StoreError`] if a tick hits a store failure.
#[allow(clippy::future_not_send, reason = "owns the daemon state; driven on a single daemon task")]
#[allow(clippy::too_many_arguments, reason = "explicit deps keep the loop testable without a god-struct")]
pub async fn serve_forever<F: ForgeAdapter, R: WorkRunner>(
	mut store: GitDaemonStateStore,
	forge: F,
	runner: R,
	policy: MergePolicy,
	repo_node_id: String,
	max_concurrency: u32,
	limit: u32,
	period: Duration,
	mut shutdown: watch::Receiver<bool>,
	clock: fn() -> (String, String),
) -> Result<u64, StoreError> {
	let mut interval = tokio::time::interval(period);
	let mut ticks = 0u64;
	loop {
		tokio::select! {
			_ = interval.tick() => {
				let (now, lease) = clock();
				// Poll phase: discover issues from the forge and ingest them so
				// the ready queue reflects live work (poll is the at-least-once
				// safety net; a forge error is transient and skips this tick's
				// discovery without aborting the loop).
				let _ = crate::dispatcher::reconcile_poll(&store, &forge, &repo_node_id, &now).await;
				serve_pass(&mut store, &forge, &runner, &policy, 0, max_concurrency, limit, &now, &lease).await?;
				ticks += 1;
			}
			result = shutdown.changed() => {
				// Sender dropped or value flipped to true -> drain and stop.
				if result.is_err() || *shutdown.borrow() {
					break;
				}
			}
		}
	}
	Ok(ticks)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::forge_adapter::{FakeForge, ForgePr};
	use crate::keys::ItemKind;
	use crate::orchestrator::RunResult;

	struct FakeRunner;
	impl WorkRunner for FakeRunner {
		async fn run(&self, _work_key: &str) -> RunResult {
			RunResult {
				succeeded: true,
				pr_id: "PR_7".into(),
				head_sha: "sha1".into(),
				base_branch: "dev".into(),
				ci_green: true,
				ultragoal_pass: true,
				reviews_resolved: true,
				diff_within_budget: true,
				diff_in_scope: true,
			}
		}
	}

	fn ready_items(n: usize) -> Vec<(ItemRef, String)> {
		(0..n)
			.map(|i| {
				let item = ItemRef::new("github", "R_1", ItemKind::Issue, format!("I_{i}"));
				let key = item.work_intent_key("resolve").as_str().to_owned();
				(item, key)
			})
			.collect()
	}

	fn policy() -> MergePolicy {
		MergePolicy { protected_branches: vec![], allowed_dev_branches: vec!["dev".into()] }
	}

	fn forge_with_prs(n: usize) -> FakeForge {
		let forge = FakeForge::new();
		// All items share PR_7 in this fake; one merge per driven item is fine for
		// the concurrency-bound assertion.
		for _ in 0..n {
			forge.put_pr(ForgePr { id: "PR_7".into(), number: 7, head_sha: "sha1".into(), base_branch: "dev".into() });
		}
		forge
	}

	#[tokio::test]
	async fn tick_drives_up_to_available_slots() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = forge_with_prs(1);
		let ready = ready_items(3);
		// cap 2, active 0 -> 2 driven this tick.
		let out = run_tick(&mut store, &forge, &FakeRunner, &ready, &policy(), 0, 2, "t0", "t9").await.unwrap();
		assert_eq!(out.len(), 2);
		assert!(out.iter().all(|(_, o)| matches!(o, DriveOutcome::Merged { .. })));
	}

	#[tokio::test]
	async fn tick_does_nothing_when_at_capacity() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = forge_with_prs(1);
		let ready = ready_items(3);
		// active == cap -> no free slots.
		let out = run_tick(&mut store, &forge, &FakeRunner, &ready, &policy(), 2, 2, "t0", "t9").await.unwrap();
		assert!(out.is_empty());
		assert!(forge.merged().is_empty());
	}

	#[tokio::test]
	async fn tick_with_empty_queue_is_noop() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = forge_with_prs(1);
		let out = run_tick(&mut store, &forge, &FakeRunner, &[], &policy(), 0, 4, "t0", "t9").await.unwrap();
		assert!(out.is_empty());
	}

	#[tokio::test]
	async fn serve_pass_sources_ready_work_from_the_store() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = forge_with_prs(2);
		// Record two ready work intents; serve_pass should reconstruct + drive them.
		for i in 0..2 {
			let item = ItemRef::new("github", "R_1", ItemKind::Issue, format!("I_{i}"));
			let key = item.work_intent_key("resolve");
			store.record_work_intent(&key, "issue", &format!("I_{i}"), "t0").unwrap();
		}
		let out = serve_pass(&mut store, &forge, &FakeRunner, &policy(), 0, 4, 10, "t0", "t9").await.unwrap();
		assert_eq!(out.len(), 2);
		assert!(out.iter().all(|(_, o)| matches!(o, DriveOutcome::Merged { .. })));
	}

	#[tokio::test]
	async fn serve_pass_with_no_ready_work_is_noop() {
		let mut store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = forge_with_prs(1);
		let out = serve_pass(&mut store, &forge, &FakeRunner, &policy(), 0, 4, 10, "t0", "t9").await.unwrap();
		assert!(out.is_empty());
	}

	fn fixed_clock() -> (String, String) {
		("t0".to_owned(), "t9".to_owned())
	}

	#[tokio::test(start_paused = true)]
	async fn serve_forever_ticks_until_shutdown() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		// One ready item; once merged it leaves the ready set, so later ticks are
		// no-ops — we are asserting the loop cadence, not repeated merges.
		let item = ItemRef::new("github", "R_1", ItemKind::Issue, "I_0");
		store.record_work_intent(&item.work_intent_key("resolve"), "issue", "I_0", "t0").unwrap();
		let forge = forge_with_prs(1);

		let (tx, rx) = watch::channel(false);
		// Flip shutdown after ~3.5 periods of paused time.
		tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(3500)).await;
			let _ = tx.send(true);
		});

		let ticks = serve_forever(
			store,
			forge,
			FakeRunner,
			policy(),
			"R_1".to_owned(),
			4,
			10,
			Duration::from_secs(1),
			rx,
			fixed_clock,
		)
		.await
		.unwrap();
		// Immediate first tick + ticks at 1s/2s/3s before the 3.5s shutdown.
		assert!(ticks >= 3, "expected at least 3 ticks, got {ticks}");
	}

	#[tokio::test(start_paused = true)]
	async fn serve_forever_stops_when_sender_dropped() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let forge = forge_with_prs(0);
		let (tx, rx) = watch::channel(false);
		drop(tx); // sender gone -> changed() errors -> loop must exit
		let ticks =
			serve_forever(store, forge, FakeRunner, policy(), "R_1".to_owned(), 4, 10, Duration::from_secs(1), rx, fixed_clock)
				.await
				.unwrap();
		// The immediate first interval tick may run before the dropped-sender
		// branch wins the select; either way the loop terminates.
		assert!(ticks <= 1, "dropped sender must stop the loop promptly, got {ticks}");
	}
}
