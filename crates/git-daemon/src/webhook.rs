//! Webhook signature verification.
//!
//! Webhook payloads are verified over the **raw request bytes before JSON
//! parsing**, using a timing-safe HMAC comparison. The signing secret is
//! machine-local (see [`crate::secrets`]); a missing, malformed, or mismatched
//! signature is rejected fail-closed so a forged payload never reaches the
//! ingestion dispatcher.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Why a webhook payload was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookError {
	/// No signature header was present.
	MissingSignature,
	/// The signature header was not the expected `sha256=<hex>` shape.
	MalformedSignature,
	/// The computed HMAC did not match the provided signature.
	SignatureMismatch,
	/// The signing secret was empty.
	EmptySecret,
}

impl core::fmt::Display for WebhookError {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		let s = match self {
			Self::MissingSignature => "missing_signature",
			Self::MalformedSignature => "malformed_signature",
			Self::SignatureMismatch => "signature_mismatch",
			Self::EmptySecret => "empty_secret",
		};
		f.write_str(s)
	}
}

impl core::error::Error for WebhookError {}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
	if !s.len().is_multiple_of(2) {
		return None;
	}
	let mut out = Vec::with_capacity(s.len() / 2);
	let bytes = s.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		let hi = (bytes[i] as char).to_digit(16)?;
		let lo = (bytes[i + 1] as char).to_digit(16)?;
		out.push(((hi << 4) | lo) as u8);
		i += 2;
	}
	Some(out)
}

/// Verify a GitHub-style `X-Hub-Signature-256: sha256=<hex>` header against the
/// raw request body using HMAC-SHA256 with `secret`.
///
/// The comparison is timing-safe (delegated to the MAC's constant-time verify).
///
/// # Errors
/// Returns [`WebhookError`] when the secret is empty, the header is absent or
/// malformed, or the HMAC does not match.
pub fn verify_github_signature(
	secret: &str,
	raw_body: &[u8],
	signature_header: Option<&str>,
) -> Result<(), WebhookError> {
	if secret.is_empty() {
		return Err(WebhookError::EmptySecret);
	}
	let header = signature_header.ok_or(WebhookError::MissingSignature)?;
	let hex = header
		.strip_prefix("sha256=")
		.ok_or(WebhookError::MalformedSignature)?;
	let provided = decode_hex(hex).ok_or(WebhookError::MalformedSignature)?;
	// `new_from_slice` accepts any key length; the unwrap path is unreachable.
	let mut mac =
		HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| WebhookError::EmptySecret)?;
	mac.update(raw_body);
	mac.verify_slice(&provided)
		.map_err(|_| WebhookError::SignatureMismatch)
}

/// Compute the `sha256=<hex>` signature for a body (used by tests and any
/// outbound relay that must sign a payload).
#[must_use]
pub fn sign_github(secret: &str, raw_body: &[u8]) -> String {
	let mut mac =
		HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
	mac.update(raw_body);
	let bytes = mac.finalize().into_bytes();
	let mut hex = String::with_capacity(bytes.len() * 2);
	for b in bytes {
		use core::fmt::Write as _;
		let _ = write!(hex, "{b:02x}");
	}
	format!("sha256={hex}")
}

#[cfg(test)]
mod tests {
	use super::*;

	const SECRET: &str = "topsecret";
	const BODY: &[u8] = br#"{"action":"opened","number":7}"#;

	#[test]
	fn valid_signature_passes() {
		let sig = sign_github(SECRET, BODY);
		assert!(verify_github_signature(SECRET, BODY, Some(&sig)).is_ok());
	}

	#[test]
	fn tampered_body_fails() {
		let sig = sign_github(SECRET, BODY);
		let tampered = br#"{"action":"opened","number":8}"#;
		assert_eq!(
			verify_github_signature(SECRET, tampered, Some(&sig)),
			Err(WebhookError::SignatureMismatch)
		);
	}

	#[test]
	fn wrong_secret_fails() {
		let sig = sign_github(SECRET, BODY);
		assert_eq!(
			verify_github_signature("other", BODY, Some(&sig)),
			Err(WebhookError::SignatureMismatch)
		);
	}

	#[test]
	fn missing_and_malformed_headers_fail() {
		assert_eq!(verify_github_signature(SECRET, BODY, None), Err(WebhookError::MissingSignature));
		assert_eq!(
			verify_github_signature(SECRET, BODY, Some("deadbeef")),
			Err(WebhookError::MalformedSignature)
		);
		assert_eq!(
			verify_github_signature(SECRET, BODY, Some("sha256=zz")),
			Err(WebhookError::MalformedSignature)
		);
		assert_eq!(
			verify_github_signature(SECRET, BODY, Some("sha256=abc")),
			Err(WebhookError::MalformedSignature)
		);
	}

	#[test]
	fn empty_secret_is_rejected() {
		let sig = sign_github(SECRET, BODY);
		assert_eq!(verify_github_signature("", BODY, Some(&sig)), Err(WebhookError::EmptySecret));
	}
}
