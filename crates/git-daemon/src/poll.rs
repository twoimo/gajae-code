//! Poll reconciliation logic.
//!
//! Polling is the at-least-once safety net behind webhooks: if a webhook is
//! lost, a periodic sweep re-discovers the item so it is never missed. Re-seen
//! items dedupe in the store (same synthetic [`crate::keys::EventSource::Poll`]
//! token), so the overlap window can be generous without causing duplicate
//! work.

/// Build the observable state token for a poll-discovered item.
///
/// The token is stable for an unchanged observable state (so re-polling the
/// same state reproduces the same dedupe key) and changes when the item
/// changes.
#[must_use]
pub fn poll_state_token(updated_at: &str, state: &str) -> String {
	format!("{updated_at}:{state}")
}

/// Advance a poll cursor watermark to the newest `observed` `updated_at`.
///
/// ISO-8601 timestamps in a fixed zone (GitHub uses UTC `Z`) order
/// lexicographically, so the watermark is simply the max seen.
#[must_use]
pub fn advance_watermark(current: Option<&str>, observed: &str) -> String {
	match current {
		Some(cur) if cur >= observed => cur.to_owned(),
		_ => observed.to_owned(),
	}
}

/// Whether a polled item falls within the reconciliation window.
///
/// `cutoff` is the watermark minus the overlap window, computed by the caller
/// (which owns the clock). Using `>=` means an item exactly at the boundary is
/// re-seen rather than skipped — eventual-pickup over false-negative.
#[must_use]
pub fn needs_processing(item_updated_at: &str, cutoff: &str) -> bool {
	item_updated_at >= cutoff
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::keys::{DedupKey, EventSource, ItemKind, ItemRef};

	#[test]
	fn state_token_is_stable_for_same_state() {
		let a = poll_state_token("2026-01-01T00:00:00Z", "open:sha9");
		let b = poll_state_token("2026-01-01T00:00:00Z", "open:sha9");
		assert_eq!(a, b);
		let changed = poll_state_token("2026-01-01T00:05:00Z", "open:sha9");
		assert_ne!(a, changed);
	}

	#[test]
	fn watermark_advances_to_newest() {
		assert_eq!(advance_watermark(None, "2026-01-01T00:00:00Z"), "2026-01-01T00:00:00Z");
		assert_eq!(
			advance_watermark(Some("2026-01-01T00:00:00Z"), "2026-01-02T00:00:00Z"),
			"2026-01-02T00:00:00Z"
		);
		// An older observation never moves the watermark backwards.
		assert_eq!(
			advance_watermark(Some("2026-01-02T00:00:00Z"), "2026-01-01T00:00:00Z"),
			"2026-01-02T00:00:00Z"
		);
	}

	#[test]
	fn boundary_item_is_reprocessed_not_missed() {
		// Item exactly at the cutoff is processed (>=) so nothing slips through.
		assert!(needs_processing("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"));
		assert!(needs_processing("2026-01-01T00:05:00Z", "2026-01-01T00:00:00Z"));
		assert!(!needs_processing("2025-12-31T23:00:00Z", "2026-01-01T00:00:00Z"));
	}

	#[test]
	fn poll_token_feeds_a_stable_dedupe_key() {
		// The poll token threads into the same DedupKey shape webhooks use, so the
		// store dedupes a webhook + a later poll of the same state.
		let item = ItemRef::new("github", "R_1", ItemKind::Issue, "I_9");
		let token = poll_state_token("2026-01-01T00:00:00Z", "open");
		let k1 = DedupKey::new(
			&item,
			"issues",
			&EventSource::Poll { resource: "issue".into(), state_token: token.clone() },
			"r1",
		);
		let k2 = DedupKey::new(
			&item,
			"issues",
			&EventSource::Poll { resource: "issue".into(), state_token: token },
			"r1",
		);
		assert_eq!(k1, k2);
	}
}
