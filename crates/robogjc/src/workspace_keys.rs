//! Pure workspace key and branch helpers ported from Python `robogjc.sandbox`.

use std::sync::LazyLock;

use regex::Regex;
use sha1::{Digest, Sha1};

static SLUG_CLEAN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
static BRANCH_SLUG_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^[a-z0-9]+(?:-[a-z0-9]+)*$").unwrap());

pub fn workspace_key(repo: &str, number: u64) -> String {
	format!("{}__{}", repo.replace('/', "__"), number)
}

pub fn slug(text: &str, length: usize) -> String {
	let lower = text.to_lowercase();
	let cleaned = SLUG_CLEAN_RE.replace_all(&lower, "-");
	let cleaned = cleaned.trim_matches('-');
	let cleaned = if cleaned.is_empty() { "issue" } else { cleaned };
	cleaned.chars().take(length).collect()
}

pub fn short_hex(seed: &str) -> String {
	let digest = Sha1::digest(seed.as_bytes());
	let mut out = String::with_capacity(8);
	for byte in digest.iter().take(4) {
		out.push_str(&format!("{byte:02x}"));
	}
	out
}

pub fn make_branch(issue_number: u64, title: &str, seed: Option<&str>) -> String {
	let fallback_seed;
	let seed = match seed {
		Some(seed) => seed,
		None => {
			fallback_seed = format!("{issue_number}-{title}");
			&fallback_seed
		},
	};
	let fallback_title;
	let title = if title.is_empty() {
		fallback_title = format!("issue-{issue_number}");
		&fallback_title
	} else {
		title
	};
	format!("farm/{}/{}", short_hex(seed), slug(title, 40))
}

pub fn validate_branch_slug(slug: &str) -> Result<&str, String> {
	if !BRANCH_SLUG_RE.is_match(slug) || slug.len() > 50 {
		return Err(format!(
			"invalid branch slug {slug:?}: expected kebab-case [a-z0-9-], 1-50 chars, no \
			 leading/trailing/double hyphen"
		));
	}
	Ok(slug)
}

#[cfg(test)]
mod tests {
	use serde::Deserialize;

	use super::*;

	#[derive(Debug, Deserialize)]
	struct WorkspaceFixture {
		workspace_keys: Vec<WorkspaceCase>,
		branch_slug_validation: Vec<BranchSlugCase>,
	}

	#[derive(Debug, Deserialize)]
	struct WorkspaceCase {
		repo: String,
		number: u64,
		expected_key: String,
		branch_title: String,
		branch_seed: String,
		expected_branch: String,
	}

	#[derive(Debug, Deserialize)]
	struct BranchSlugCase {
		slug: String,
		ok: bool,
		error_contains: String,
	}

	#[test]
	fn workspace_key_vectors_match_python() {
		let fixture: WorkspaceFixture =
			crate::fixture_harness::load_fixture("phase1/workspace-key-vectors.json");
		for case in fixture.workspace_keys {
			assert_eq!(workspace_key(&case.repo, case.number), case.expected_key);
			assert_eq!(
				make_branch(case.number, &case.branch_title, Some(&case.branch_seed)),
				case.expected_branch
			);
		}
	}

	#[test]
	fn branch_slug_validation_matches_python() {
		let fixture: WorkspaceFixture =
			crate::fixture_harness::load_fixture("phase1/workspace-key-vectors.json");
		for case in fixture.branch_slug_validation {
			let result = validate_branch_slug(&case.slug);
			assert_eq!(result.is_ok(), case.ok, "{}", case.slug);
			if !case.ok {
				assert!(result.unwrap_err().contains(&case.error_contains));
			}
		}
	}

	#[test]
	fn differential_workspace_branch_boundaries_match_python() {
		assert_eq!(
			make_branch(7, "Fix café 漢字 bug 🚀", Some("7-Fix café 漢字 bug 🚀")),
			"farm/6e0cc4f1/fix-caf-bug"
		);
		assert_eq!(
			make_branch(8, &"a".repeat(120), Some("seed-long")),
			"farm/5850597f/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		);
		assert_eq!(make_branch(9, "First title", Some("collision")), "farm/925d7ad7/first-title");
		assert_eq!(make_branch(10, "Second title", Some("collision")), "farm/925d7ad7/second-title");
	}
}
