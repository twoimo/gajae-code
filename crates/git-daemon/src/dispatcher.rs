//! Ingestion dispatcher.
//!
//! Glues the pieces together for one ingested event: dedupe it in the store
//! (exactly-once across webhook + poll), acknowledge non-actionable events as a
//! first-class no-op (D1: broad intake, the action decides act-vs-ack), and for
//! actionable events record a work intent so follow-ups update the existing work
//! item instead of opening a duplicate PR.

use crate::forge::ForgeEvent;
use crate::forge_adapter::ForgeAdapter;
use crate::keys::{DedupKey, EventSource, ItemRef};
use crate::poll::poll_state_token;
use crate::store::{GitDaemonStateStore, StoreError};

/// What the dispatcher decided for an ingested event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestOutcome {
	/// The event's dedupe key was already present (duplicate webhook/poll).
	Duplicate,
	/// New, non-actionable event: acknowledged, no work scheduled.
	AckedNoOp,
	/// New, actionable event that created a fresh work item.
	WorkCreated { work_key: String },
	/// New, actionable event for an item that already has a work intent
	/// (follow-up): the existing item is reused — no second PR.
	FollowUp { work_key: String },
}

/// The normalized work action for an item kind. Issue and PR events each
/// collapse to a single action so every follow-up on the same item shares one
/// work intent.
const fn normalized_action(item_kind: crate::keys::ItemKind) -> &'static str {
	match item_kind {
		crate::keys::ItemKind::Issue => "resolve",
		crate::keys::ItemKind::Pr => "revise",
	}
}

/// Ingest a single canonical event against the store.
///
/// # Errors
/// Returns [`StoreError`] on a `SQLite` failure.
pub fn ingest(
	store: &GitDaemonStateStore,
	event: &ForgeEvent,
	source: &EventSource,
	now: &str,
) -> Result<IngestOutcome, StoreError> {
	let item = ItemRef::new(
		event.provider.clone(),
		event.repo_node_id.clone(),
		event.item_kind,
		event.item_node_id.clone(),
	);
	let dedup = DedupKey::new(&item, &event.event_family, source, &event.event_revision);
	let inserted = store.insert_event(
		&dedup,
		event.item_kind.as_str(),
		&event.item_node_id,
		&event.event_family,
		now,
	)?;
	if !inserted {
		return Ok(IngestOutcome::Duplicate);
	}
	if !event.actionable {
		return Ok(IngestOutcome::AckedNoOp);
	}
	let work_key = item.work_intent_key(normalized_action(event.item_kind));
	let created = store.record_work_intent(&work_key, event.item_kind.as_str(), &event.item_node_id, now)?;
	let key = work_key.as_str().to_owned();
	if created {
		return Ok(IngestOutcome::WorkCreated { work_key: key });
	}
	// Follow-up on an existing item: re-queue it (CAS, no second work key) so the
	// reconciler schedules it again even if it had settled (e.g. escalated,
	// stream_lost, merged) — a follow-up must never be silently dropped.
	store.requeue_work(&key, now)?;
	Ok(IngestOutcome::FollowUp { work_key: key })
}

/// Poll reconciliation over the forge's open issues.
///
/// Lists open issues and ingests each as a poll-sourced event, so lost webhooks
/// (or poll-only deployments) still discover work. Each item dedupes against
/// prior webhook/poll deliveries via its observable revision + state token;
/// `repo_node_id` must match the value the webhook path uses so the two sources
/// collapse onto one work item.
///
/// Returns the per-item ingest outcomes.
///
/// # Errors
/// Returns [`StoreError`] on a store failure. Forge errors abort the sweep and
/// are surfaced as [`StoreError::MigrationFailed`] (transient; retried next tick).
#[allow(clippy::future_not_send, reason = "driven on the daemon task; no cross-thread Send boundary yet")]
pub async fn reconcile_poll<F: ForgeAdapter>(
	store: &GitDaemonStateStore,
	forge: &F,
	repo_node_id: &str,
	now: &str,
) -> Result<Vec<IngestOutcome>, StoreError> {
	let items = forge
		.list_open_issues()
		.await
		.map_err(|e| StoreError::MigrationFailed(format!("poll list_open_issues: {e}")))?;
	let mut outcomes = Vec::with_capacity(items.len());
	for item in items {
		let event = ForgeEvent {
			provider: "github".to_owned(),
			repo_node_id: repo_node_id.to_owned(),
			item_kind: item.item_kind,
			item_node_id: item.node_id.clone(),
			event_family: "issues".to_owned(),
			action: "poll_discovered".to_owned(),
			actor_login: None,
			event_revision: item.updated_at.clone(),
			actionable: true,
		};
		let source = EventSource::Poll {
			resource: "issues".to_owned(),
			state_token: poll_state_token(&item.updated_at, &item.state),
		};
		outcomes.push(ingest(store, &event, &source, now)?);
	}
	Ok(outcomes)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::forge::normalize_github;
	use serde_json::json;

	fn store() -> GitDaemonStateStore {
		GitDaemonStateStore::open_in_memory().unwrap()
	}

	#[tokio::test]
	async fn reconcile_poll_ingests_open_issues_and_dedupes() {
		use crate::forge_adapter::{FakeForge, PolledItem};
		use crate::keys::ItemKind;
		let s = store();
		let forge = FakeForge::new();
		forge.put_open_issue(PolledItem { node_id: "I_1".into(), item_kind: ItemKind::Issue, updated_at: "2026-01-01T00:00:00Z".into(), state: "open".into() });
		forge.put_open_issue(PolledItem { node_id: "I_2".into(), item_kind: ItemKind::Issue, updated_at: "2026-01-01T00:00:01Z".into(), state: "open".into() });
		let out = reconcile_poll(&s, &forge, "R_1", "t0").await.unwrap();
		assert_eq!(out.len(), 2);
		assert!(out.iter().all(|o| matches!(o, IngestOutcome::WorkCreated { .. })));
		assert_eq!(s.list_ready_work(10).unwrap().len(), 2, "both issues become ready work");
		// Re-polling the same unchanged issues dedupes (no new work).
		let again = reconcile_poll(&s, &forge, "R_1", "t1").await.unwrap();
		assert!(again.iter().all(|o| matches!(o, IngestOutcome::Duplicate | IngestOutcome::FollowUp { .. })));
		assert_eq!(s.list_ready_work(10).unwrap().len(), 2, "no duplicate work items");
	}

	fn issue_opened() -> ForgeEvent {
		normalize_github(
			"issues",
			&json!({
				"action": "opened",
				"repository": { "node_id": "R_1" },
				"issue": { "node_id": "I_42", "updated_at": "2026-01-01T00:00:00Z" }
			}),
		)
		.unwrap()
	}

	#[test]
	fn actionable_event_creates_work() {
		let s = store();
		let ev = issue_opened();
		let src = EventSource::Webhook { delivery_id: "d1".into() };
		assert!(matches!(ingest(&s, &ev, &src, "t0").unwrap(), IngestOutcome::WorkCreated { .. }));
	}

	#[test]
	fn duplicate_delivery_is_deduped() {
		let s = store();
		let ev = issue_opened();
		let src = EventSource::Webhook { delivery_id: "d1".into() };
		ingest(&s, &ev, &src, "t0").unwrap();
		// Same event id again (e.g. webhook retry) -> dropped.
		assert_eq!(ingest(&s, &ev, &src, "t1").unwrap(), IngestOutcome::Duplicate);
	}

	#[test]
	fn webhook_then_poll_race_yields_one_work_item_no_dup_pr() {
		let s = store();
		let ev = issue_opened();
		// Webhook delivery creates the work item.
		let wh = ingest(&s, &ev, &EventSource::Webhook { delivery_id: "d1".into() }, "t0").unwrap();
		assert!(matches!(wh, IngestOutcome::WorkCreated { .. }));
		// Poll later rediscovers the same issue (distinct dedupe key, same item):
		// it is a NEW event row but the work intent already exists -> FollowUp,
		// not a second PR.
		let poll_src =
			EventSource::Poll { resource: "issue".into(), state_token: "I_42:open".into() };
		let poll = ingest(&s, &ev, &poll_src, "t1").unwrap();
		assert!(matches!(poll, IngestOutcome::FollowUp { .. }));
	}

	#[test]
	fn non_actionable_event_is_acked_noop() {
		let s = store();
		let ev = normalize_github(
			"pull_request",
			&json!({
				"action": "closed",
				"repository": { "node_id": "R_1" },
				"pull_request": { "node_id": "PR_7", "head": { "sha": "z9" } }
			}),
		)
		.unwrap();
		let src = EventSource::Webhook { delivery_id: "d2".into() };
		assert_eq!(ingest(&s, &ev, &src, "t0").unwrap(), IngestOutcome::AckedNoOp);
	}

	#[test]
	fn comment_follow_up_reuses_work_item() {
		let s = store();
		// Open the issue (creates work).
		ingest(&s, &issue_opened(), &EventSource::Webhook { delivery_id: "d1".into() }, "t0").unwrap();
		// A later comment on the same issue is a distinct event but shares the
		// issue's work intent -> FollowUp.
		let comment = normalize_github(
			"issue_comment",
			&json!({
				"repository": { "node_id": "R_1" },
				"issue": { "node_id": "I_42" },
				"comment": { "updated_at": "2026-02-02T00:00:00Z" }
			}),
		)
		.unwrap();
		let out = ingest(&s, &comment, &EventSource::Webhook { delivery_id: "d2".into() }, "t1").unwrap();
		assert!(matches!(out, IngestOutcome::FollowUp { .. }));
	}

	#[test]
	fn follow_up_requeues_a_settled_work_item() {
		use crate::keys::{ItemKind, ItemRef};
		use crate::state_machine::WorkItemState;
		let s = store();
		// Create the work item, then settle it (e.g. escalated) so it is no longer
		// in the ready set.
		ingest(&s, &issue_opened(), &EventSource::Webhook { delivery_id: "d1".into() }, "t0").unwrap();
		let work_key = ItemRef::new("github", "R_1", ItemKind::Issue, "I_42").work_intent_key("resolve");
		assert!(s.set_work_state(work_key.as_str(), WorkItemState::Escalated, "t1").unwrap());
		assert!(s.list_ready_work(10).unwrap().is_empty(), "settled item is not ready");
		// A later comment (distinct event, same item) must re-queue it.
		let comment = normalize_github(
			"issue_comment",
			&json!({
				"repository": { "node_id": "R_1" },
				"issue": { "node_id": "I_42" },
				"comment": { "updated_at": "2026-02-02T00:00:00Z" }
			}),
		)
		.unwrap();
		let out = ingest(&s, &comment, &EventSource::Webhook { delivery_id: "d2".into() }, "t2").unwrap();
		assert!(matches!(out, IngestOutcome::FollowUp { .. }));
		let ready: Vec<String> = s.list_ready_work(10).unwrap().into_iter().map(|(k, _, _)| k).collect();
		assert_eq!(ready, vec![work_key.as_str().to_owned()], "follow-up must re-queue the existing item");
	}
}
