//! Ingestion dispatcher.
//!
//! Glues the pieces together for one ingested event: dedupe it in the store
//! (exactly-once across webhook + poll), acknowledge non-actionable events as a
//! first-class no-op (D1: broad intake, the action decides act-vs-ack), and for
//! actionable events record a work intent so follow-ups update the existing work
//! item instead of opening a duplicate PR.

use crate::forge::ForgeEvent;
use crate::keys::{DedupKey, EventSource, ItemRef};
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
	Ok(if created { IngestOutcome::WorkCreated { work_key: key } } else { IngestOutcome::FollowUp { work_key: key } })
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::forge::normalize_github;
	use serde_json::json;

	fn store() -> GitDaemonStateStore {
		GitDaemonStateStore::open_in_memory().unwrap()
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
}
