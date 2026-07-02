//! GitHub proxy client and server boundary for isolated credentials.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub const HEADER_TIMESTAMP: &str = "X-Robogjc-Timestamp";
pub const HEADER_SIGNATURE: &str = "X-Robogjc-Sig";
pub const DEFAULT_SKEW_SECONDS: i64 = 30;

type HmacSha256 = Hmac<Sha256>;

fn hex_encode(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut out = String::with_capacity(bytes.len() * 2);
	for &byte in bytes {
		out.push(HEX[(byte >> 4) as usize] as char);
		out.push(HEX[(byte & 0x0f) as usize] as char);
	}
	out
}

fn string_to_sign(method: &str, path: &str, timestamp: &str, body: &[u8]) -> Vec<u8> {
	let body_hash = hex_encode(&Sha256::digest(body));
	[method.to_ascii_uppercase(), path.to_owned(), timestamp.to_owned(), body_hash]
		.join("\n")
		.into_bytes()
}

pub fn sign(method: &str, path: &str, body: &[u8], key: &[u8], timestamp: &str) -> String {
	let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts keys of any size");
	mac.update(&string_to_sign(method, path, timestamp, body));
	hex_encode(&mac.finalize().into_bytes())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyResult {
	pub ok: bool,
	pub reason: String,
}

impl VerifyResult {
	fn ok() -> Self {
		Self { ok: true, reason: String::new() }
	}

	fn err(reason: &str) -> Self {
		Self { ok: false, reason: reason.to_owned() }
	}
}

pub fn verify(
	method: &str,
	path: &str,
	body: &[u8],
	timestamp: Option<&str>,
	signature: Option<&str>,
	key: &[u8],
	now: i64,
	skew: i64,
) -> VerifyResult {
	let (Some(timestamp), Some(signature)) = (timestamp, signature) else {
		return VerifyResult::err("missing signature headers");
	};
	let Ok(ts_int) = timestamp.parse::<i64>() else {
		return VerifyResult::err("malformed timestamp");
	};
	if (now - ts_int).abs() > skew {
		return VerifyResult::err("timestamp outside skew window");
	}
	let expected = sign(method, path, body, key, timestamp);
	if !constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
		return VerifyResult::err("signature mismatch");
	}
	VerifyResult::ok()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
	if left.len() != right.len() {
		return false;
	}
	let mut diff = 0u8;
	for (a, b) in left.iter().zip(right.iter()) {
		diff |= a ^ b;
	}
	diff == 0
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde::Deserialize;

	#[derive(Debug, Deserialize)]
	struct HmacFixture {
		cases: Vec<HmacCase>,
	}

	#[derive(Debug, Deserialize)]
	struct HmacCase {
		method: String,
		path: String,
		body: String,
		key: String,
		timestamp: String,
		expected_signature: String,
		expected_timestamp: String,
		verify_ok: bool,
	}

	#[test]
	fn proxy_hmac_vectors() {
		let fixture: HmacFixture = crate::fixture_harness::load_fixture("phase1/hmac-vectors.json");
		for case in fixture.cases {
			let signature = sign(
				&case.method,
				&case.path,
				case.body.as_bytes(),
				case.key.as_bytes(),
				&case.timestamp,
			);
			assert_eq!(signature, case.expected_signature);
			assert_eq!(case.timestamp, case.expected_timestamp);

			let result = verify(
				&case.method,
				&case.path,
				case.body.as_bytes(),
				Some(&case.timestamp),
				Some(&case.expected_signature),
				case.key.as_bytes(),
				case.timestamp.parse().unwrap(),
				DEFAULT_SKEW_SECONDS,
			);
			assert_eq!(result.ok, case.verify_ok, "{}", result.reason);
		}
	}

	#[test]
	fn verify_rejects_failure_modes() {
		let signature = sign("GET", "/x", b"", b"k", "100");
		assert_eq!(
			verify("GET", "/x", b"", None, Some(&signature), b"k", 100, 30).reason,
			"missing signature headers"
		);
		assert_eq!(
			verify("GET", "/x", b"", Some("nope"), Some(&signature), b"k", 100, 30).reason,
			"malformed timestamp"
		);
		assert_eq!(
			verify("GET", "/x", b"", Some("69"), Some(&signature), b"k", 100, 30).reason,
			"timestamp outside skew window"
		);
		assert_eq!(
			verify("GET", "/x", b"changed", Some("100"), Some(&signature), b"k", 100, 30).reason,
			"signature mismatch"
		);
	}

	#[test]
	fn differential_boundary_hmac_cases_match_python() {
		let key = b"k";
		let path = "/unicodé/路径?q=✓";
		for (timestamp, expected_signature, now, ok, reason) in [
			(
				"970",
				"a820c17e3afb0c013aaf0b357c3d9049f542dc95febbc2f64a61c2f881c54add",
				1000,
				true,
				"",
			),
			(
				"1030",
				"3172124bc3c62a56e80e01ec4efcaf9c80706b4e1574d0978a7581854ab26823",
				1000,
				true,
				"",
			),
			(
				"969",
				"1f3830ecbf345eef286a9d2b18c20be1d943c4a4a9386128e117d3dd97d7a8b0",
				1000,
				false,
				"timestamp outside skew window",
			),
		] {
			assert_eq!(sign("GET", path, b"", key, timestamp), expected_signature);
			let result = verify(
				"GET",
				path,
				b"",
				Some(timestamp),
				Some(expected_signature),
				key,
				now,
				DEFAULT_SKEW_SECONDS,
			);
			assert_eq!((result.ok, result.reason.as_str()), (ok, reason));
		}

		let signature = sign("POST", "/x", b"", key, "1000");
		for bad_signature in [&signature[..signature.len() - 1], &"z".repeat(64)] {
			let result = verify(
				"POST",
				"/x",
				b"",
				Some("1000"),
				Some(bad_signature),
				key,
				1000,
				DEFAULT_SKEW_SECONDS,
			);
			assert_eq!((result.ok, result.reason.as_str()), (false, "signature mismatch"));
		}
	}
}
