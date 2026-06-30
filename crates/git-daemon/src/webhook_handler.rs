//! Webhook request handler: verify → normalize → ingest.
//!
//! This is the full webhook ingestion pipeline as a pure, testable function,
//! independent of any HTTP server. A live deployment wraps it in an HTTP
//! listener that hands over the raw body, the `X-Hub-Signature-256` header, and
//! the `X-GitHub-Event` / `X-GitHub-Delivery` headers; the signature is verified
//! over the **raw bytes before parsing** (fail-closed), recognized events are
//! normalized to a canonical [`ForgeEvent`] and ingested (exactly-once across
//! webhook + poll), and unrecognized events are acknowledged as a no-op.

use crate::dispatcher::{IngestOutcome, ingest};
use crate::forge::normalize_github;
use crate::keys::EventSource;
use crate::store::{GitDaemonStateStore, StoreError};
use crate::webhook::{WebhookError, verify_github_signature};

/// Why a webhook request could not be ingested.
#[derive(Debug)]
pub enum WebhookHandleError {
	/// Signature verification failed (fail-closed; payload never parsed/acted).
	Unauthorized(WebhookError),
	/// The body was not valid JSON.
	BadPayload(String),
	/// A store failure during dedupe/work-intent recording.
	Store(StoreError),
}

impl core::fmt::Display for WebhookHandleError {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		match self {
			Self::Unauthorized(e) => write!(f, "webhook unauthorized: {e}"),
			Self::BadPayload(e) => write!(f, "webhook bad payload: {e}"),
			Self::Store(e) => write!(f, "webhook store error: {e}"),
		}
	}
}

impl core::error::Error for WebhookHandleError {}

/// Handle one GitHub webhook delivery end-to-end.
///
/// Verifies the signature over `raw_body`, parses + normalizes the payload for
/// `event_name`, and ingests the canonical event keyed by `delivery_id`.
/// Unrecognized event types are acknowledged as [`IngestOutcome::AckedNoOp`]
/// (D1: broad intake; the normalizer decides what is actionable).
///
/// # Errors
/// Returns [`WebhookHandleError`] when the signature is invalid, the body is not
/// JSON, or the store fails.
pub fn handle_github_webhook(
	secret: &str,
	raw_body: &[u8],
	signature_header: Option<&str>,
	event_name: &str,
	delivery_id: &str,
	store: &GitDaemonStateStore,
	now: &str,
) -> Result<IngestOutcome, WebhookHandleError> {
	verify_github_signature(secret, raw_body, signature_header).map_err(WebhookHandleError::Unauthorized)?;
	let payload: serde_json::Value =
		serde_json::from_slice(raw_body).map_err(|e| WebhookHandleError::BadPayload(e.to_string()))?;
	let Some(event) = normalize_github(event_name, &payload) else {
		return Ok(IngestOutcome::AckedNoOp);
	};
	let source = EventSource::Webhook { delivery_id: delivery_id.to_owned() };
	ingest(store, &event, &source, now).map_err(WebhookHandleError::Store)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::webhook::sign_github;
	use serde_json::json;

	const SECRET: &str = "shhh";

	fn issue_payload() -> Vec<u8> {
		serde_json::to_vec(&json!({
			"action": "opened",
			"repository": { "node_id": "R_kgDO1" },
			"sender": { "login": "octocat" },
			"issue": { "node_id": "I_kwDO9", "updated_at": "2026-01-01T00:00:00Z" }
		}))
		.unwrap()
	}

	#[test]
	fn valid_signature_ingests_a_work_item() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let body = issue_payload();
		let sig = sign_github(SECRET, &body);
		let out =
			handle_github_webhook(SECRET, &body, Some(&sig), "issues", "d-1", &store, "t0").unwrap();
		assert!(matches!(out, IngestOutcome::WorkCreated { .. }));
	}

	#[test]
	fn invalid_signature_is_rejected_before_parsing() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let body = issue_payload();
		let out = handle_github_webhook(SECRET, &body, Some("sha256=deadbeef"), "issues", "d-1", &store, "t0");
		assert!(matches!(out, Err(WebhookHandleError::Unauthorized(_))));
	}

	#[test]
	fn replayed_delivery_dedupes() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let body = issue_payload();
		let sig = sign_github(SECRET, &body);
		let first = handle_github_webhook(SECRET, &body, Some(&sig), "issues", "d-1", &store, "t0").unwrap();
		assert!(matches!(first, IngestOutcome::WorkCreated { .. }));
		// Same delivery + same revision -> deduped to one work item.
		let second = handle_github_webhook(SECRET, &body, Some(&sig), "issues", "d-1", &store, "t1").unwrap();
		assert_eq!(second, IngestOutcome::Duplicate);
	}

	#[test]
	fn unrecognized_event_is_acked_noop() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let body = serde_json::to_vec(&json!({ "repository": { "node_id": "R_1" } })).unwrap();
		let sig = sign_github(SECRET, &body);
		let out = handle_github_webhook(SECRET, &body, Some(&sig), "ping", "d-9", &store, "t0").unwrap();
		assert_eq!(out, IngestOutcome::AckedNoOp);
	}

	#[test]
	fn malformed_json_with_valid_signature_is_bad_payload() {
		let store = GitDaemonStateStore::open_in_memory().unwrap();
		let body = b"not json".to_vec();
		let sig = sign_github(SECRET, &body);
		let out = handle_github_webhook(SECRET, &body, Some(&sig), "issues", "d-1", &store, "t0");
		assert!(matches!(out, Err(WebhookHandleError::BadPayload(_))));
	}
}
