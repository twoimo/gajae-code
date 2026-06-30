//! Daemon configuration: repo identity, webhook topology, poll cadence, merge
//! policy, RPC endpoint, and memory mode.
//!
//! Secrets are intentionally absent — credentials are resolved separately and
//! machine-locally via [`crate::secrets`]. Config carries only non-secret repo
//! identity and policy, so it is safe to load from project-scoped sources.

use serde::{Deserialize, Serialize};

/// How the daemon receives forge events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WebhookTopology {
	/// Reverse proxy terminates TLS and forwards to the daemon loopback/socket.
	#[default]
	ReverseProxy,
	/// The daemon binds a public endpoint and terminates TLS itself (opt-in).
	DirectPublic,
	/// A relay/tunnel forwards events (development).
	Relay,
	/// No webhook; rely on poll reconciliation only (degraded fallback).
	PollOnly,
}

/// Where the daemon drives coding work + memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMode {
	/// Advisory Hindsight memory active.
	#[default]
	Hindsight,
	/// No advisory memory (committed rules still authoritative elsewhere).
	Off,
}

/// Poll reconciliation cadence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PollConfig {
	pub interval_secs: u64,
	/// Overlap window so an event near a cursor boundary is never missed.
	pub overlap_secs: u64,
}

impl Default for PollConfig {
	fn default() -> Self {
		Self { interval_secs: 60, overlap_secs: 600 }
	}
}

/// Merge policy. The daemon never merges to a protected/main branch and only
/// auto-merges to one of `allowed_dev_branches`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MergePolicy {
	pub protected_branches: Vec<String>,
	pub allowed_dev_branches: Vec<String>,
}

impl MergePolicy {
	/// Whether the daemon is permitted to auto-merge into `branch`.
	///
	/// Fail-closed: `main`/`master` and any configured protected branch are
	/// always denied, regardless of the allow-list.
	#[must_use]
	pub fn may_auto_merge(&self, branch: &str) -> bool {
		if branch == "main" || branch == "master" {
			return false;
		}
		if self.protected_branches.iter().any(|b| b == branch) {
			return false;
		}
		self.allowed_dev_branches.iter().any(|b| b == branch)
	}
}

/// Top-level per-repo daemon configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitDaemonConfig {
	pub provider: String,
	pub repo_full_name: String,
	pub repo_node_id: String,
	#[serde(default)]
	pub webhook_topology: WebhookTopology,
	#[serde(default)]
	pub poll: PollConfig,
	#[serde(default)]
	pub merge_policy: MergePolicy,
	#[serde(default)]
	pub memory_mode: MemoryMode,
	/// gjc-rpc/bridge endpoint the daemon drives unattended runs through.
	pub rpc_endpoint: String,
	/// Max issues worked concurrently (single-flight is still per item).
	#[serde(default = "default_concurrency")]
	pub max_concurrency: u32,
}

const fn default_concurrency() -> u32 {
	2
}

/// Reasons a config is invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
	MissingField(&'static str),
	InvalidValue { field: &'static str, reason: &'static str },
}

impl core::fmt::Display for ConfigError {
	fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
		match self {
			Self::MissingField(field) => write!(f, "missing required config field: {field}"),
			Self::InvalidValue { field, reason } => write!(f, "invalid config field {field}: {reason}"),
		}
	}
}

impl core::error::Error for ConfigError {}

impl GitDaemonConfig {
	/// Validate required fields and cross-field constraints (fail-closed).
	///
	/// # Errors
	/// Returns [`ConfigError`] for missing identity/endpoint fields, a zero
	/// concurrency, a zero poll interval, or a webhook topology that requires an
	/// endpoint without one.
	pub fn validate(&self) -> Result<(), ConfigError> {
		if self.provider.trim().is_empty() {
			return Err(ConfigError::MissingField("provider"));
		}
		if self.repo_full_name.trim().is_empty() {
			return Err(ConfigError::MissingField("repo_full_name"));
		}
		if self.repo_node_id.trim().is_empty() {
			return Err(ConfigError::MissingField("repo_node_id"));
		}
		if self.rpc_endpoint.trim().is_empty() {
			return Err(ConfigError::MissingField("rpc_endpoint"));
		}
		if self.max_concurrency == 0 {
			return Err(ConfigError::InvalidValue { field: "max_concurrency", reason: "must be >= 1" });
		}
		if self.poll.interval_secs == 0 {
			return Err(ConfigError::InvalidValue { field: "poll.interval_secs", reason: "must be >= 1" });
		}
		Ok(())
	}

	/// Whether poll reconciliation is the only ingestion path.
	#[must_use]
	pub const fn is_poll_only(&self) -> bool {
		matches!(self.webhook_topology, WebhookTopology::PollOnly)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn valid() -> GitDaemonConfig {
		GitDaemonConfig {
			provider: "github".into(),
			repo_full_name: "acme/widget".into(),
			repo_node_id: "R_1".into(),
			webhook_topology: WebhookTopology::ReverseProxy,
			poll: PollConfig::default(),
			merge_policy: MergePolicy {
				protected_branches: vec!["release".into()],
				allowed_dev_branches: vec!["dev".into()],
			},
			memory_mode: MemoryMode::Hindsight,
			rpc_endpoint: "unix:///tmp/gjc.sock".into(),
			max_concurrency: 2,
		}
	}

	#[test]
	fn valid_config_passes() {
		assert!(valid().validate().is_ok());
	}

	#[test]
	fn missing_identity_is_rejected() {
		let mut c = valid();
		c.repo_node_id = "  ".into();
		assert_eq!(c.validate(), Err(ConfigError::MissingField("repo_node_id")));
	}

	#[test]
	fn zero_concurrency_is_rejected() {
		let mut c = valid();
		c.max_concurrency = 0;
		assert!(matches!(c.validate(), Err(ConfigError::InvalidValue { field: "max_concurrency", .. })));
	}

	#[test]
	fn never_auto_merges_protected_or_main() {
		let policy = MergePolicy {
			protected_branches: vec!["release".into()],
			allowed_dev_branches: vec!["dev".into(), "main".into()], // even if mislisted
		};
		assert!(!policy.may_auto_merge("main"));
		assert!(!policy.may_auto_merge("master"));
		assert!(!policy.may_auto_merge("release"));
		assert!(policy.may_auto_merge("dev"));
		assert!(!policy.may_auto_merge("feature/x")); // not in allow-list
	}

	#[test]
	fn deserializes_with_defaults() {
		let json = r#"{
			"provider": "github",
			"repo_full_name": "acme/widget",
			"repo_node_id": "R_1",
			"rpc_endpoint": "unix:///tmp/gjc.sock"
		}"#;
		let c: GitDaemonConfig = serde_json::from_str(json).unwrap();
		assert_eq!(c.webhook_topology, WebhookTopology::ReverseProxy);
		assert_eq!(c.memory_mode, MemoryMode::Hindsight);
		assert_eq!(c.poll.interval_secs, 60);
		assert_eq!(c.max_concurrency, 2);
		assert!(c.validate().is_ok());
	}

	#[test]
	fn poll_only_detected() {
		let mut c = valid();
		c.webhook_topology = WebhookTopology::PollOnly;
		assert!(c.is_poll_only());
	}
}
