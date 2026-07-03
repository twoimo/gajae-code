//! Credential redaction helpers ported from Python `robogjc.git_ops`.

use std::sync::LazyLock;

use regex::Regex;

static CRED_URL: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(https?://)([^:/@\s]+):([^@/\s]+)@").unwrap());

pub fn redact_credentials(text: Option<&str>) -> String {
	let Some(text) = text else {
		return String::new();
	};
	if text.is_empty() {
		return String::new();
	}
	CRED_URL.replace_all(text, "$1***@").into_owned()
}

#[cfg(test)]
mod tests {
	use serde::Deserialize;

	use super::*;

	#[derive(Debug, Deserialize)]
	struct RedactionFixture {
		cases: Vec<RedactionCase>,
	}

	#[derive(Debug, Deserialize)]
	struct RedactionCase {
		input:    Option<String>,
		expected: String,
	}

	#[test]
	fn redaction_vectors_match_python() {
		let fixture: RedactionFixture =
			crate::fixture_harness::load_fixture("phase1/redaction-vectors.json");
		for case in fixture.cases {
			assert_eq!(redact_credentials(case.input.as_deref()), case.expected);
		}
	}

	#[test]
	fn differential_redaction_edge_cases_match_python() {
		for (input, expected) in [
			("https://user:p@ss@example.com/repo", "https://***@ss@example.com/repo"),
			(
				"clone https://u:p@a/x and https://u2:p2@b/y",
				"clone https://***@a/x and https://***@b/y",
			),
			(
				"https://example.com/path?token=user:pass@secret",
				"https://example.com/path?token=user:pass@secret",
			),
			("https://user:pass@[2001:db8::1]/repo", "https://***@[2001:db8::1]/repo"),
			("ssh://user:pass@example.com/repo", "ssh://user:pass@example.com/repo"),
		] {
			assert_eq!(redact_credentials(Some(input)), expected);
		}
	}
}
