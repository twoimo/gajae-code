//! Advisory repo memory: trust model, directive precedence, document ids.
//!
//! Hindsight memory is **advisory only**: it influences prioritization,
//! scrutiny, and communication, but it can never authorize a merge, override a
//! committed maintainer rule, or supply branch protection. Committed files,
//! `SQLite` state, and live forge data remain authoritative. This module is the
//! pure schema/precedence logic; the async Hindsight HTTP client is a later
//! slice.

/// Default trust scores for newly-seen contributors.
pub const TRUST_UNKNOWN: f64 = 0.50;
pub const TRUST_RECOGNIZED_MAINTAINER: f64 = 0.70;
pub const TRUST_NEW_EXTERNAL: f64 = 0.35;
pub const TRUST_KNOWN_ABUSE: f64 = 0.20;

/// Trust band a score falls into. Bands inform scrutiny/prioritization only;
/// they never gate whether work is attempted (D1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustBand {
	High,
	Normal,
	Cautious,
	Blocked,
}

impl TrustBand {
	/// Classify a 0.0..=1.0 trust score. high >=0.80, normal 0.50-0.79,
	/// cautious 0.25-0.49, blocked <0.25.
	#[must_use]
	pub fn from_score(score: f64) -> Self {
		if score >= 0.80 {
			Self::High
		} else if score >= 0.50 {
			Self::Normal
		} else if score >= 0.25 {
			Self::Cautious
		} else {
			Self::Blocked
		}
	}
}

/// Effective trust = a committed maintainer clamp when present, else the base
/// score. The clamp is deterministic (from committed rules / live allowlist),
/// never from advisory Hindsight recall.
#[must_use]
pub fn effective_trust(base_score: f64, maintainer_clamp: Option<f64>) -> f64 {
	maintainer_clamp.unwrap_or(base_score).clamp(0.0, 1.0)
}

/// Source of a maintainer directive, in precedence order (committed rules win).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectiveSource {
	CommittedRules,
	MaintainerComment,
	RepoSettings,
	InferredConvention,
	OtherMemory,
}

impl DirectiveSource {
	/// Precedence rank (higher wins). Committed rules are authoritative.
	#[must_use]
	pub const fn rank(self) -> u8 {
		match self {
			Self::CommittedRules => 100,
			Self::MaintainerComment => 80,
			Self::RepoSettings => 60,
			Self::InferredConvention => 40,
			Self::OtherMemory => 20,
		}
	}
}

/// Pick the authoritative directive content from a candidate set: the highest
/// rank wins; ties keep the first occurrence (deterministic).
#[must_use]
pub fn authoritative_directive<'a>(directives: &[(DirectiveSource, &'a str)]) -> Option<&'a str> {
	// First-wins on ties: only replace the leader when a strictly higher rank
	// appears (`max_by_key` would instead keep the LAST maximum).
	let mut best: Option<(u8, &'a str)> = None;
	for (src, content) in directives {
		let rank = src.rank();
		match best {
			Some((best_rank, _)) if rank <= best_rank => {}
			_ => best = Some((rank, content)),
		}
	}
	best.map(|(_, content)| content)
}

/// Deterministic Hindsight document id for a contributor.
#[must_use]
pub fn contributor_doc_id(repo_id: &str, provider: &str, account: &str) -> String {
	format!("gitdaemon:repo:{repo_id}:contributor:{provider}:{account}")
}

/// Deterministic Hindsight document id for an issue.
#[must_use]
pub fn issue_doc_id(repo_id: &str, issue_node_id: &str) -> String {
	format!("gitdaemon:repo:{repo_id}:issue:{issue_node_id}")
}

/// Deterministic Hindsight document id for a PR.
#[must_use]
pub fn pr_doc_id(repo_id: &str, pr_node_id: &str) -> String {
	format!("gitdaemon:repo:{repo_id}:pr:{pr_node_id}")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn trust_bands_match_thresholds() {
		assert_eq!(TrustBand::from_score(0.90), TrustBand::High);
		assert_eq!(TrustBand::from_score(0.80), TrustBand::High);
		assert_eq!(TrustBand::from_score(TRUST_RECOGNIZED_MAINTAINER), TrustBand::Normal);
		assert_eq!(TrustBand::from_score(TRUST_UNKNOWN), TrustBand::Normal);
		assert_eq!(TrustBand::from_score(TRUST_NEW_EXTERNAL), TrustBand::Cautious);
		assert_eq!(TrustBand::from_score(TRUST_KNOWN_ABUSE), TrustBand::Blocked);
	}

	#[test]
	fn maintainer_clamp_overrides_base_and_is_bounded() {
		assert!((effective_trust(0.9, Some(0.2)) - 0.2).abs() < 1e-9);
		assert!((effective_trust(0.4, None) - 0.4).abs() < 1e-9);
		// Out-of-range clamp is bounded to [0,1].
		assert!((effective_trust(0.5, Some(5.0)) - 1.0).abs() < 1e-9);
	}

	#[test]
	fn committed_rules_outrank_everything() {
		let directives = [
			(DirectiveSource::OtherMemory, "use tabs"),
			(DirectiveSource::MaintainerComment, "use 2 spaces"),
			(DirectiveSource::CommittedRules, "use 4 spaces"),
			(DirectiveSource::RepoSettings, "use spaces"),
		];
		assert_eq!(authoritative_directive(&directives), Some("use 4 spaces"));
	}

	#[test]
	fn authoritative_is_none_when_empty() {
		assert_eq!(authoritative_directive(&[]), None);
	}

	#[test]
	fn equal_rank_keeps_first_occurrence() {
		// Two MaintainerComment directives (same rank) -> the first wins.
		let directives = [
			(DirectiveSource::MaintainerComment, "first"),
			(DirectiveSource::MaintainerComment, "second"),
		];
		assert_eq!(authoritative_directive(&directives), Some("first"));
	}

	#[test]
	fn doc_ids_are_deterministic_and_namespaced() {
		assert_eq!(contributor_doc_id("R_1", "github", "u9"), "gitdaemon:repo:R_1:contributor:github:u9");
		assert_eq!(issue_doc_id("R_1", "I_42"), "gitdaemon:repo:R_1:issue:I_42");
		assert_eq!(pr_doc_id("R_1", "PR_7"), "gitdaemon:repo:R_1:pr:PR_7");
	}
}
