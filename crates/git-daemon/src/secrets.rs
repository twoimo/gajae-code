//! Secret resolution boundary.
//!
//! GitHub App private keys, installation tokens, webhook secrets, and relay
//! tokens are **machine-local only**. This module rejects any secret offered
//! from a project-scoped source (`.gjc`, committed files, worktree `.env`
//! overlays) and never returns raw material in a form intended for storage:
//! callers persist only the [`ResolvedSecret::fingerprint`].

use sha2::{Digest, Sha256};

/// The kind of secret being resolved (recorded for audit, never the value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
	GithubAppPrivateKey,
	InstallationToken,
	WebhookSecret,
	AppSecret,
	RelayToken,
}

/// Where a candidate secret came from. Machine-local sources are trusted;
/// project-scoped sources are rejected before any network bind or forge call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretSource {
	/// Process environment.
	Env,
	/// OS secret store / keychain.
	OsSecretStore,
	/// User- or machine-level agent config outside the project tree.
	UserAgentConfig,
	/// An explicitly configured auth broker.
	AuthBroker,
	/// Repo `.gjc` config (REJECTED).
	ProjectGjc,
	/// A committed file in the repo (REJECTED).
	CommittedFile,
	/// A worktree `.env` overlay (REJECTED).
	WorktreeEnv,
}

impl SecretSource {
	/// Machine-local sources are the only trusted origins for secret material.
	#[must_use]
	pub const fn is_machine_local(self) -> bool {
		matches!(self, Self::Env | Self::OsSecretStore | Self::UserAgentConfig | Self::AuthBroker)
	}

	#[must_use]
	pub const fn label(self) -> &'static str {
		match self {
			Self::Env => "env",
			Self::OsSecretStore => "os_secret_store",
			Self::UserAgentConfig => "user_agent_config",
			Self::AuthBroker => "auth_broker",
			Self::ProjectGjc => "project_gjc",
			Self::CommittedFile => "committed_file",
			Self::WorktreeEnv => "worktree_env",
		}
	}
}

/// A request to resolve a secret for a repo/provider.
#[derive(Debug, Clone)]
pub struct SecretRequest {
	pub kind: SecretKind,
	pub provider: String,
	pub repo_id: String,
	pub repo_full_name: String,
	pub installation_id: Option<String>,
}

/// A candidate secret offered to the resolver: the material plus its origin.
#[derive(Debug, Clone)]
pub struct SecretCandidate {
	pub material: String,
	pub source: SecretSource,
	/// Optional ISO-8601 expiry the caller already knows (e.g. installation token).
	pub expires_at: Option<String>,
}

/// The non-sensitive result. The raw material is intentionally absent; only the
/// fingerprint, source label, and optional expiry are safe to persist/audit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSecret {
	pub fingerprint: String,
	pub source_kind: &'static str,
	pub expires_at: Option<String>,
}

/// Why a secret could not be resolved (fail-closed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
	/// No candidate was offered.
	Missing,
	/// A candidate was offered from a project-scoped (non-machine-local) source.
	ProjectScopedRejected { source: &'static str },
	/// The material was empty or malformed.
	InvalidFormat,
	/// The candidate is already expired.
	Expired,
}

impl core::fmt::Display for SecretError {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		match self {
			Self::Missing => write!(f, "secret_missing"),
			Self::ProjectScopedRejected { source } => {
				write!(f, "secret_project_scoped_rejected: {source}")
			}
			Self::InvalidFormat => write!(f, "secret_invalid_format"),
			Self::Expired => write!(f, "secret_expired"),
		}
	}
}

impl core::error::Error for SecretError {}

/// Stable, non-reversible fingerprint of secret material (SHA-256 hex).
///
/// The same material yields the same fingerprint; different material yields a
/// different one. The raw value is never recoverable from it.
#[must_use]
pub fn fingerprint(material: &str) -> String {
	let mut hasher = Sha256::new();
	hasher.update(material.as_bytes());
	let digest = hasher.finalize();
	let mut out = String::with_capacity(digest.len() * 2);
	for byte in digest {
		use core::fmt::Write as _;
		// hex encode; write! to a String is infallible.
		let _ = write!(out, "{byte:02x}");
	}
	out
}

/// Resolve a candidate secret, rejecting project-scoped sources and returning
/// only a fingerprint + metadata.
///
/// # Errors
/// - [`SecretError::Missing`] when `candidate` is `None`.
/// - [`SecretError::ProjectScopedRejected`] when the source is not machine-local.
/// - [`SecretError::InvalidFormat`] when the material is empty.
/// - [`SecretError::Expired`] when `now` is past the candidate's `expires_at`.
pub fn resolve_secret(
	_request: &SecretRequest,
	candidate: Option<&SecretCandidate>,
	now: &str,
) -> Result<ResolvedSecret, SecretError> {
	let candidate = candidate.ok_or(SecretError::Missing)?;
	if !candidate.source.is_machine_local() {
		return Err(SecretError::ProjectScopedRejected { source: candidate.source.label() });
	}
	if candidate.material.trim().is_empty() {
		return Err(SecretError::InvalidFormat);
	}
	if let Some(expiry) = &candidate.expires_at {
		// ISO-8601 timestamps in the same zone sort lexicographically.
		if expiry.as_str() <= now {
			return Err(SecretError::Expired);
		}
	}
	Ok(ResolvedSecret {
		fingerprint: fingerprint(&candidate.material),
		source_kind: candidate.source.label(),
		expires_at: candidate.expires_at.clone(),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn request() -> SecretRequest {
		SecretRequest {
			kind: SecretKind::WebhookSecret,
			provider: "github".into(),
			repo_id: "R_1".into(),
			repo_full_name: "acme/widget".into(),
			installation_id: None,
		}
	}

	fn candidate(material: &str, source: SecretSource) -> SecretCandidate {
		SecretCandidate { material: material.into(), source, expires_at: None }
	}

	#[test]
	fn rejects_project_scoped_sources() {
		for src in [SecretSource::ProjectGjc, SecretSource::CommittedFile, SecretSource::WorktreeEnv] {
			let err = resolve_secret(&request(), Some(&candidate("s3cr3t", src)), "2026-01-01T00:00:00Z")
				.unwrap_err();
			assert!(matches!(err, SecretError::ProjectScopedRejected { .. }), "src {src:?}");
		}
	}

	#[test]
	fn accepts_machine_local_and_returns_only_fingerprint() {
		let resolved =
			resolve_secret(&request(), Some(&candidate("s3cr3t", SecretSource::Env)), "2026-01-01T00:00:00Z")
				.unwrap();
		assert_eq!(resolved.source_kind, "env");
		// fingerprint is hex SHA-256 and does not contain the raw material.
		assert_eq!(resolved.fingerprint.len(), 64);
		assert!(!resolved.fingerprint.contains("s3cr3t"));
	}

	#[test]
	fn fingerprint_is_stable_and_distinct() {
		assert_eq!(fingerprint("a"), fingerprint("a"));
		assert_ne!(fingerprint("a"), fingerprint("b"));
	}

	#[test]
	fn missing_candidate_is_fail_closed() {
		assert_eq!(resolve_secret(&request(), None, "2026-01-01T00:00:00Z"), Err(SecretError::Missing));
	}

	#[test]
	fn empty_material_is_invalid() {
		let err = resolve_secret(&request(), Some(&candidate("  ", SecretSource::Env)), "2026-01-01T00:00:00Z")
			.unwrap_err();
		assert_eq!(err, SecretError::InvalidFormat);
	}

	#[test]
	fn expired_candidate_is_rejected() {
		let cand = SecretCandidate {
			material: "tok".into(),
			source: SecretSource::OsSecretStore,
			expires_at: Some("2025-01-01T00:00:00Z".into()),
		};
		let err = resolve_secret(&request(), Some(&cand), "2026-01-01T00:00:00Z").unwrap_err();
		assert_eq!(err, SecretError::Expired);
	}
}
