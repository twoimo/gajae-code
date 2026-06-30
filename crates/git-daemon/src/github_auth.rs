//! GitHub App JWT construction (auth groundwork).
//!
//! GitHub App authentication signs a short-lived RS256 JWT whose claims are
//! `iss` (app id), `iat`, and `exp`. This module builds the canonical signing
//! input (`base64url(header).base64url(payload)`) deterministically; the RS256
//! signature itself is applied by the caller with the machine-local private key
//! resolved via [`crate::secrets`]. Keeping the claim/encoding logic pure makes
//! it unit-testable without a key or a network.

use serde_json::{Value, json};

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encode bytes as base64url **without padding** (JWT requirement).
#[must_use]
pub fn base64url_nopad(input: &[u8]) -> String {
	let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
	for chunk in input.chunks(3) {
		let b0 = chunk[0];
		let b1 = chunk.get(1).copied();
		let b2 = chunk.get(2).copied();
		out.push(B64URL[(b0 >> 2) as usize] as char);
		let i1 = ((b0 & 0b11) << 4) | (b1.unwrap_or(0) >> 4);
		out.push(B64URL[i1 as usize] as char);
		if let Some(b1) = b1 {
			let i2 = ((b1 & 0b1111) << 2) | (b2.unwrap_or(0) >> 6);
			out.push(B64URL[i2 as usize] as char);
			if let Some(b2) = b2 {
				out.push(B64URL[(b2 & 0b111111) as usize] as char);
			}
		}
	}
	out
}

/// Build the App JWT claim set: `iss` = app id, plus `iat`/`exp` (unix seconds).
#[must_use]
pub fn app_jwt_claims(app_id: &str, iat: u64, exp: u64) -> Value {
	json!({ "iat": iat, "exp": exp, "iss": app_id })
}

/// Build the JWT signing input `base64url(header).base64url(payload)` for an
/// App JWT. The caller signs this with RS256 and appends `.base64url(sig)`.
#[must_use]
pub fn app_jwt_signing_input(app_id: &str, iat: u64, exp: u64) -> String {
	let header = json!({ "alg": "RS256", "typ": "JWT" });
	let claims = app_jwt_claims(app_id, iat, exp);
	// serde_json is deterministic for these flat objects (preserve_order on).
	let h = base64url_nopad(header.to_string().as_bytes());
	let p = base64url_nopad(claims.to_string().as_bytes());
	format!("{h}.{p}")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn b64url_decode(s: &str) -> Vec<u8> {
		let lookup = |c: u8| B64URL.iter().position(|&x| x == c).unwrap() as u8;
		let bytes: Vec<u8> = s.bytes().collect();
		let mut out = Vec::new();
		for chunk in bytes.chunks(4) {
			let n = chunk.len();
			let c0 = lookup(chunk[0]);
			let c1 = lookup(chunk[1]);
			out.push((c0 << 2) | (c1 >> 4));
			if n >= 3 {
				let c2 = lookup(chunk[2]);
				out.push((c1 << 4) | (c2 >> 2));
				if n == 4 {
					let c3 = lookup(chunk[3]);
					out.push((c2 << 6) | c3);
				}
			}
		}
		out
	}

	#[test]
	fn base64url_round_trips_arbitrary_bytes() {
		for sample in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
			let enc = base64url_nopad(sample);
			assert!(!enc.contains('='), "no padding");
			assert!(!enc.contains('+') && !enc.contains('/'), "url-safe alphabet");
			assert_eq!(b64url_decode(&enc), sample);
		}
	}

	#[test]
	fn claims_have_iss_iat_exp() {
		let c = app_jwt_claims("12345", 100, 700);
		assert_eq!(c["iss"], "12345");
		assert_eq!(c["iat"], 100);
		assert_eq!(c["exp"], 700);
	}

	#[test]
	fn signing_input_is_two_b64url_segments_decoding_to_json() {
		let si = app_jwt_signing_input("app-1", 100, 700);
		let parts: Vec<&str> = si.split('.').collect();
		assert_eq!(parts.len(), 2);
		let header: Value = serde_json::from_slice(&b64url_decode(parts[0])).unwrap();
		assert_eq!(header["alg"], "RS256");
		assert_eq!(header["typ"], "JWT");
		let payload: Value = serde_json::from_slice(&b64url_decode(parts[1])).unwrap();
		assert_eq!(payload["iss"], "app-1");
		assert_eq!(payload["exp"], 700);
	}
}
