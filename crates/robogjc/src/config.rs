//! Configuration loading and validation boundary for robogjc.

use std::{
	collections::{BTreeMap, BTreeSet},
	env, fmt, fs,
	path::{Path, PathBuf},
	sync::atomic::{AtomicUsize, Ordering},
};

pub type ThinkingLevel = String;
const THINKING_LEVELS: &[&str] = &["off", "low", "medium", "high", "xhigh"];

#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
	pub fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}

	pub fn expose(&self) -> &str {
		&self.0
	}
}

impl fmt::Debug for SecretString {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("[redacted]")
	}
}
impl fmt::Display for SecretString {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("[redacted]")
	}
}

static MODEL_PICK_COUNTER: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
	pub github_token: Option<SecretString>,
	pub github_webhook_secret: SecretString,
	pub bot_login: String,
	pub git_author_name: Option<String>,
	pub git_author_email: String,
	pub repo_allowlist_raw: String,
	pub gh_proxy_url: Option<String>,
	pub gh_proxy_hmac_key: Option<SecretString>,
	pub gh_proxy_bind_host: String,
	pub gh_proxy_bind_port: u16,
	pub gh_proxy_max_body_bytes: usize,
	pub gh_proxy_git_timeout_seconds: f64,
	pub model: String,
	pub provider: Option<String>,
	pub thinking_level: ThinkingLevel,
	pub max_concurrency: usize,
	pub task_timeout_seconds: f64,
	pub task_timeout_hard_grace_seconds: f64,
	pub request_timeout_seconds: f64,
	pub task_completion_max_reminders: usize,
	pub gjc_command: String,
	pub shutdown_drain_timeout_seconds: f64,
	pub shutdown_kill_timeout_seconds: f64,
	pub workspace_root: PathBuf,
	pub sqlite_path: PathBuf,
	pub log_dir: PathBuf,
	pub bind_host: String,
	pub bind_port: u16,
	pub replay_token: Option<SecretString>,
	pub rate_limit_window_seconds: f64,
	pub rate_limit_default: usize,
	pub rate_limit_contributor: usize,
	pub rate_limit_unlimited_raw: String,
	pub maintainer_logins_raw: String,
	pub reviewer_bots_raw: String,
	pub question_autoclose_enabled: bool,
	pub question_autoclose_hours: f64,
	pub question_autoclose_scan_seconds: f64,
	pub natives_cache_enabled: bool,
	pub natives_cache_root: PathBuf,
	pub natives_cache_max_entries_per_repo: usize,
	pub natives_cache_max_bytes: u64,
	pub natives_cache_gc_interval_seconds: f64,
}

#[derive(Debug, Clone)]
struct EnvSource {
	values: BTreeMap<String, String>,
}

impl EnvSource {
	fn load() -> Result<Self, String> {
		Self::load_from(Path::new(".env"))
	}

	fn load_from(env_file: &Path) -> Result<Self, String> {
		let mut values = BTreeMap::new();
		if env_file.exists() {
			let content =
				fs::read_to_string(env_file).map_err(|e| format!("{}: {e}", env_file.display()))?;
			for line in content.lines() {
				let trimmed = line.trim();
				if trimmed.is_empty() || trimmed.starts_with('#') {
					continue;
				}
				let Some((key, value)) = trimmed.split_once('=') else {
					continue;
				};
				values.insert(key.trim().to_ascii_uppercase(), unquote_env_value(value.trim()));
			}
		}
		for (key, value) in env::vars() {
			values.insert(key.to_ascii_uppercase(), value);
		}
		Ok(Self { values })
	}

	fn get(&self, name: &str) -> Option<&str> {
		self
			.values
			.get(&name.to_ascii_uppercase())
			.map(String::as_str)
	}
}

fn unquote_env_value(value: &str) -> String {
	if value.len() >= 2 {
		let bytes = value.as_bytes();
		if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
			|| (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
		{
			return value[1..value.len() - 1].to_owned();
		}
	}
	value.to_owned()
}

fn env_string(source: &EnvSource, name: &str, default: Option<&str>) -> Result<String, String> {
	match source.get(name) {
		Some(value) => Ok(value.to_owned()),
		None => default
			.map(str::to_owned)
			.ok_or_else(|| format!("{name} is required")),
	}
}

fn env_optional_nonblank(source: &EnvSource, name: &str) -> Option<String> {
	match source.get(name) {
		Some(value) if value.trim().is_empty() => None,
		Some(value) => Some(value.to_owned()),
		None => None,
	}
}

fn parse_env<T: std::str::FromStr>(
	source: &EnvSource,
	name: &str,
	default: &str,
) -> Result<T, String> {
	env_string(source, name, Some(default))?
		.parse()
		.map_err(|_| format!("{name} must parse as {}", std::any::type_name::<T>()))
}

fn parse_bool(source: &EnvSource, name: &str, default: bool) -> Result<bool, String> {
	let default_str = if default { "true" } else { "false" };
	match env_string(source, name, Some(default_str))?
		.trim()
		.to_ascii_lowercase()
		.as_str()
	{
		"1" | "true" | "yes" | "on" => Ok(true),
		"0" | "false" | "no" | "off" => Ok(false),
		_ => Err(format!("{name} must be a boolean")),
	}
}

fn csv_set(raw: &str, strip_at: bool) -> BTreeSet<String> {
	raw.split(',')
		.map(str::trim)
		.map(|piece| {
			if strip_at {
				piece.trim_start_matches('@')
			} else {
				piece
			}
		})
		.map(str::to_ascii_lowercase)
		.filter(|piece| !piece.is_empty())
		.collect()
}

fn parse_thinking(value: String) -> Result<ThinkingLevel, String> {
	if THINKING_LEVELS.contains(&value.as_str()) {
		Ok(value)
	} else {
		Err(format!("ROBGJC_THINKING must be one of {}", THINKING_LEVELS.join(", ")))
	}
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProxySettings {
	pub github_token: SecretString,
	pub gh_proxy_hmac_key: SecretString,
	pub gh_proxy_bind_host: String,
	pub gh_proxy_bind_port: u16,
	pub workspace_root: PathBuf,
	pub log_dir: PathBuf,
	pub gh_proxy_max_body_bytes: usize,
	pub gh_proxy_git_timeout_seconds: f64,
}

pub fn load_proxy_settings() -> Result<ProxySettings, String> {
	let source = EnvSource::load()?;
	let github_token = env_optional_nonblank(&source, "GITHUB_TOKEN")
		.ok_or_else(|| "GITHUB_TOKEN is required".to_owned())
		.map(SecretString::new)?;
	let gh_proxy_hmac_key = env_optional_nonblank(&source, "ROBGJC_GH_PROXY_HMAC_KEY")
		.ok_or_else(|| "ROBGJC_GH_PROXY_HMAC_KEY is required".to_owned())
		.map(SecretString::new)?;
	Ok(ProxySettings {
		github_token,
		gh_proxy_hmac_key,
		gh_proxy_bind_host: env_string(&source, "ROBGJC_GH_PROXY_BIND_HOST", Some("0.0.0.0"))?,
		gh_proxy_bind_port: parse_env(&source, "ROBGJC_GH_PROXY_BIND_PORT", "8081")?,
		workspace_root: PathBuf::from(env_string(
			&source,
			"ROBGJC_WORKSPACE_ROOT",
			Some("./data/workspaces"),
		)?),
		log_dir: PathBuf::from(env_string(&source, "ROBGJC_LOG_DIR", Some("./data/logs"))?),
		gh_proxy_max_body_bytes: parse_env(&source, "ROBGJC_GH_PROXY_MAX_BODY_BYTES", "1048576")?,
		gh_proxy_git_timeout_seconds: parse_env(
			&source,
			"ROBGJC_GH_PROXY_GIT_TIMEOUT_SECONDS",
			"60.0",
		)?,
	})
}

impl Settings {
	pub fn from_env() -> Result<Self, String> {
		Self::from_source(&EnvSource::load()?)
	}

	fn from_source(source: &EnvSource) -> Result<Self, String> {
		let github_token = env_optional_nonblank(source, "GITHUB_TOKEN").map(SecretString::new);
		let gh_proxy_url = env_optional_nonblank(source, "ROBGJC_GH_PROXY_URL");
		let gh_proxy_hmac_key =
			env_optional_nonblank(source, "ROBGJC_GH_PROXY_HMAC_KEY").map(SecretString::new);
		let has_token = github_token.is_some();
		let has_url = gh_proxy_url.is_some();
		let has_key = gh_proxy_hmac_key.is_some();
		if has_token && has_url {
			return Err(
				"GITHUB_TOKEN and ROBGJC_GH_PROXY_URL are mutually exclusive — set ONE to choose \
				 between direct-PAT and gh-proxy modes."
					.to_owned(),
			);
		}
		if has_url != has_key {
			return Err(
				"ROBGJC_GH_PROXY_URL and ROBGJC_GH_PROXY_HMAC_KEY must both be set together (or both \
				 empty)."
					.to_owned(),
			);
		}
		if !has_token && !has_url {
			return Err(
				"no GitHub access configured: set GITHUB_TOKEN, or set ROBGJC_GH_PROXY_URL + \
				 ROBGJC_GH_PROXY_HMAC_KEY to use gh-proxy."
					.to_owned(),
			);
		}

		let bot_login = env_string(source, "ROBGJC_BOT_LOGIN", None)?
			.trim()
			.to_owned();
		if bot_login.is_empty() {
			return Err("ROBGJC_BOT_LOGIN must be a non-empty GitHub login".to_owned());
		}

		Ok(Self {
			github_token,
			github_webhook_secret: SecretString::new(env_string(
				source,
				"GITHUB_WEBHOOK_SECRET",
				None,
			)?),
			bot_login,
			git_author_name: env_optional_nonblank(source, "ROBGJC_GIT_AUTHOR_NAME"),
			git_author_email: env_string(source, "ROBGJC_GIT_AUTHOR_EMAIL", None)?,
			repo_allowlist_raw: env_string(source, "ROBGJC_REPO_ALLOWLIST", Some(""))?,
			gh_proxy_url,
			gh_proxy_hmac_key,
			gh_proxy_bind_host: env_string(source, "ROBGJC_GH_PROXY_BIND_HOST", Some("0.0.0.0"))?,
			gh_proxy_bind_port: parse_env(source, "ROBGJC_GH_PROXY_BIND_PORT", "8081")?,
			gh_proxy_max_body_bytes: parse_env(source, "ROBGJC_GH_PROXY_MAX_BODY_BYTES", "1048576")?,
			gh_proxy_git_timeout_seconds: parse_env(
				source,
				"ROBGJC_GH_PROXY_GIT_TIMEOUT_SECONDS",
				"60.0",
			)?,
			model: env_string(source, "ROBGJC_MODEL", Some("anthropic/claude-sonnet-4-6"))?,
			provider: env_optional_nonblank(source, "ROBGJC_PROVIDER"),
			thinking_level: parse_thinking(env_string(source, "ROBGJC_THINKING", Some("high"))?)?,
			max_concurrency: parse_env(source, "ROBGJC_MAX_CONCURRENCY", "8")?,
			task_timeout_seconds: parse_env(source, "ROBGJC_TASK_TIMEOUT_SECONDS", "2400.0")?,
			task_timeout_hard_grace_seconds: parse_env(
				source,
				"ROBGJC_TASK_TIMEOUT_HARD_GRACE_SECONDS",
				"60.0",
			)?,
			request_timeout_seconds: parse_env(source, "ROBGJC_REQUEST_TIMEOUT_SECONDS", "120.0")?,
			task_completion_max_reminders: parse_env(
				source,
				"ROBGJC_TASK_COMPLETION_MAX_REMINDERS",
				"2",
			)?,
			gjc_command: env_string(source, "ROBGJC_GJC_COMMAND", Some("gjc"))?,
			shutdown_drain_timeout_seconds: parse_env(
				source,
				"ROBGJC_SHUTDOWN_DRAIN_TIMEOUT_SECONDS",
				"25.0",
			)?,
			shutdown_kill_timeout_seconds: parse_env(
				source,
				"ROBGJC_SHUTDOWN_KILL_TIMEOUT_SECONDS",
				"5.0",
			)?,
			workspace_root: PathBuf::from(env_string(
				source,
				"ROBGJC_WORKSPACE_ROOT",
				Some("./data/workspaces"),
			)?),
			sqlite_path: PathBuf::from(env_string(
				source,
				"ROBGJC_SQLITE_PATH",
				Some("./data/robogjc.sqlite"),
			)?),
			log_dir: PathBuf::from(env_string(source, "ROBGJC_LOG_DIR", Some("./data/logs"))?),
			bind_host: env_string(source, "ROBGJC_BIND_HOST", Some("0.0.0.0"))?,
			bind_port: parse_env(source, "ROBGJC_BIND_PORT", "8080")?,
			replay_token: env_optional_nonblank(source, "ROBGJC_REPLAY_TOKEN").map(SecretString::new),
			rate_limit_window_seconds: parse_env(
				source,
				"ROBGJC_RATE_LIMIT_WINDOW_SECONDS",
				"3600.0",
			)?,
			rate_limit_default: parse_env(source, "ROBGJC_RATE_LIMIT_DEFAULT", "3")?,
			rate_limit_contributor: parse_env(source, "ROBGJC_RATE_LIMIT_CONTRIBUTOR", "10")?,
			rate_limit_unlimited_raw: env_string(source, "ROBGJC_RATE_LIMIT_UNLIMITED", Some(""))?,
			maintainer_logins_raw: env_string(source, "ROBGJC_MAINTAINER_LOGINS", Some(""))?,
			reviewer_bots_raw: env_string(source, "ROBGJC_REVIEWER_BOTS", Some(""))?,
			question_autoclose_enabled: parse_bool(source, "ROBGJC_QUESTION_AUTOCLOSE_ENABLED", true)?,
			question_autoclose_hours: parse_env(source, "ROBGJC_QUESTION_AUTOCLOSE_HOURS", "4.0")?,
			question_autoclose_scan_seconds: parse_env(
				source,
				"ROBGJC_QUESTION_AUTOCLOSE_SCAN_SECONDS",
				"60.0",
			)?,
			natives_cache_enabled: parse_bool(source, "ROBGJC_NATIVES_CACHE_ENABLED", true)?,
			natives_cache_root: PathBuf::from(env_string(
				source,
				"ROBGJC_NATIVES_CACHE_ROOT",
				Some("/data/cache/pi-natives"),
			)?),
			natives_cache_max_entries_per_repo: parse_env(
				source,
				"ROBGJC_NATIVES_CACHE_MAX_ENTRIES_PER_REPO",
				"8",
			)?,
			natives_cache_max_bytes: parse_env(
				source,
				"ROBGJC_NATIVES_CACHE_MAX_BYTES",
				"4294967296",
			)?,
			natives_cache_gc_interval_seconds: parse_env(
				source,
				"ROBGJC_NATIVES_CACHE_GC_INTERVAL_SECONDS",
				"3600.0",
			)?,
		})
	}

	pub fn repo_allowlist(&self) -> BTreeSet<String> {
		csv_set(&self.repo_allowlist_raw, false)
	}

	pub fn rate_limit_unlimited(&self) -> BTreeSet<String> {
		csv_set(&self.rate_limit_unlimited_raw, true)
	}

	pub fn maintainer_logins(&self) -> BTreeSet<String> {
		csv_set(&self.maintainer_logins_raw, true)
	}

	pub fn reviewer_bots(&self) -> BTreeSet<String> {
		csv_set(&self.reviewer_bots_raw, true)
	}

	pub fn allows(&self, full_name: &str) -> bool {
		self
			.repo_allowlist()
			.contains(&full_name.to_ascii_lowercase())
	}

	pub fn model_pool(&self) -> Vec<String> {
		let items: Vec<String> = self
			.model
			.split(',')
			.map(str::trim)
			.filter(|s| !s.is_empty())
			.map(str::to_owned)
			.collect();
		if items.is_empty() {
			vec![self.model.clone()]
		} else {
			items
		}
	}

	pub fn pick_model(&self) -> String {
		let pool = self.model_pool();
		let idx = MODEL_PICK_COUNTER.fetch_add(1, Ordering::Relaxed) % pool.len();
		pool[idx].clone()
	}

	pub fn resolved_author_name(&self) -> String {
		self
			.git_author_name
			.clone()
			.unwrap_or_else(|| self.bot_login.clone())
			.trim()
			.to_owned()
	}

	pub fn ensure_paths(&self) -> std::io::Result<()> {
		std::fs::create_dir_all(&self.workspace_root)?;
		if let Some(parent) = self.sqlite_path.parent() {
			std::fs::create_dir_all(parent)?;
		}
		std::fs::create_dir_all(&self.log_dir)
	}
}

#[cfg(test)]
mod tests {
	use std::sync::{Mutex, OnceLock};

	use super::*;

	static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
	const KEYS: &[&str] = &[
		"GITHUB_TOKEN",
		"GITHUB_WEBHOOK_SECRET",
		"ROBGJC_BOT_LOGIN",
		"ROBGJC_GIT_AUTHOR_NAME",
		"ROBGJC_GIT_AUTHOR_EMAIL",
		"ROBGJC_REPO_ALLOWLIST",
		"ROBGJC_GH_PROXY_URL",
		"ROBGJC_GH_PROXY_HMAC_KEY",
		"ROBGJC_REPLAY_TOKEN",
		"ROBGJC_MODEL",
		"ROBGJC_TASK_TIMEOUT_HARD_GRACE_SECONDS",
		"ROBGJC_MAX_CONCURRENCY",
		"ROBGJC_THINKING",
		"ROBGJC_GH_PROXY_BIND_HOST",
		"ROBGJC_GH_PROXY_BIND_PORT",
		"ROBGJC_WORKSPACE_ROOT",
		"ROBGJC_LOG_DIR",
		"ROBGJC_GH_PROXY_MAX_BODY_BYTES",
		"ROBGJC_GH_PROXY_GIT_TIMEOUT_SECONDS",
	];

	fn set_env(key: &str, value: &str) {
		// SAFETY: Tests serialize all environment mutations with ENV_LOCK, so no
		// concurrent test in this module can read or mutate the process environment.
		unsafe { env::set_var(key, value) };
	}

	fn remove_env(key: &str) {
		// SAFETY: Tests serialize all environment mutations with ENV_LOCK, so no
		// concurrent test in this module can read or mutate the process environment.
		unsafe { env::remove_var(key) };
	}

	fn with_env(f: impl FnOnce()) {
		let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
		for key in KEYS {
			remove_env(key);
		}
		set_env("GITHUB_WEBHOOK_SECRET", "secret");
		set_env("ROBGJC_BOT_LOGIN", "robogjc-bot");
		set_env("ROBGJC_GIT_AUTHOR_NAME", "Robo GJC");
		set_env("ROBGJC_GIT_AUTHOR_EMAIL", "bot@example.com");
		set_env("ROBGJC_REPO_ALLOWLIST", "octo/widget");
		set_env("ROBGJC_GH_PROXY_URL", "http://gh-proxy.invalid:8081");
		set_env("ROBGJC_GH_PROXY_HMAC_KEY", "test-hmac-key");
		f();
		for key in KEYS {
			remove_env(key);
		}
	}

	#[test]
	fn settings_load_from_env() {
		with_env(|| {
			let cfg = Settings::from_env().unwrap();
			assert_eq!(cfg.bot_login, "robogjc-bot");
			assert_eq!(cfg.repo_allowlist(), BTreeSet::from(["octo/widget".to_owned()]));
			assert!(cfg.allows("Octo/Widget"));
			assert!(!cfg.allows("other/widget"));
		});
	}
	#[test]
	fn missing_required_github_access() {
		with_env(|| {
			set_env("ROBGJC_GH_PROXY_URL", "");
			set_env("ROBGJC_GH_PROXY_HMAC_KEY", "");
			assert!(
				Settings::from_env()
					.unwrap_err()
					.contains("no GitHub access configured")
			);
		});
	}
	#[test]
	fn orchestrator_mode_loads_proxy_config() {
		with_env(|| {
			let cfg = Settings::from_env().unwrap();
			assert!(cfg.github_token.is_none());
			assert_eq!(cfg.gh_proxy_url.as_deref(), Some("http://gh-proxy.invalid:8081"));
			assert!(
				cfg.gh_proxy_hmac_key
					.unwrap()
					.expose()
					.starts_with("test-hmac-key")
			);
		});
	}
	#[test]
	fn rejects_token_and_proxy_together() {
		with_env(|| {
			set_env("GITHUB_TOKEN", "x");
			assert!(Settings::from_env().is_err());
		});
	}
	#[test]
	fn rejects_proxy_url_without_key() {
		with_env(|| {
			set_env("ROBGJC_GH_PROXY_HMAC_KEY", "");
			assert!(Settings::from_env().is_err());
		});
	}
	#[test]
	fn proxy_mode_loads_pat() {
		with_env(|| {
			set_env("GITHUB_TOKEN", "ghp_test_token_value_xxxxxxxxxxxxxxxx");
			remove_env("ROBGJC_GH_PROXY_URL");
			remove_env("ROBGJC_GH_PROXY_HMAC_KEY");
			let cfg = Settings::from_env().unwrap();
			assert_eq!(
				cfg.github_token.as_ref().map(SecretString::expose),
				Some("ghp_test_token_value_xxxxxxxxxxxxxxxx")
			);
			assert!(cfg.gh_proxy_url.is_none());
		});
	}
	#[test]
	fn proxy_serve_config_from_env_requires_pat_key_and_builds_bind_addr() {
		with_env(|| {
			set_env("GITHUB_TOKEN", "ghp_proxy_token");
			set_env("ROBGJC_GH_PROXY_HMAC_KEY", "proxy-hmac-key");
			set_env("ROBGJC_GH_PROXY_BIND_HOST", "127.0.0.1");
			set_env("ROBGJC_GH_PROXY_BIND_PORT", "18081");
			set_env("ROBGJC_WORKSPACE_ROOT", "/tmp/robogjc-proxy-workspaces");
			set_env("ROBGJC_GH_PROXY_MAX_BODY_BYTES", "2048");
			set_env("ROBGJC_GH_PROXY_GIT_TIMEOUT_SECONDS", "12.2");
			let cfg = crate::proxy::serve_config_from_env().unwrap();
			assert_eq!(cfg.bind_addr.to_string(), "127.0.0.1:18081");
			assert_eq!(cfg.server.github_token, "ghp_proxy_token");
			assert_eq!(cfg.server.hmac_key, b"proxy-hmac-key".to_vec());
			assert_eq!(cfg.server.max_body_bytes, 2048);
			assert_eq!(cfg.server.git_timeout_seconds, 13);

			remove_env("GITHUB_TOKEN");
			assert!(
				crate::proxy::serve_config_from_env()
					.unwrap_err()
					.to_string()
					.contains("GITHUB_TOKEN")
			);

			set_env("GITHUB_TOKEN", "ghp_proxy_token");
			remove_env("ROBGJC_GH_PROXY_HMAC_KEY");
			assert!(
				crate::proxy::serve_config_from_env()
					.unwrap_err()
					.to_string()
					.contains("ROBGJC_GH_PROXY_HMAC_KEY")
			);
		});
	}
	#[test]
	fn allowlist_csv_parsing() {
		with_env(|| {
			set_env("ROBGJC_REPO_ALLOWLIST", "  alpha/one ,beta/two, ,gamma/three ");
			let cfg = Settings::from_env().unwrap();
			assert_eq!(
				cfg.repo_allowlist(),
				BTreeSet::from([
					"alpha/one".to_owned(),
					"beta/two".to_owned(),
					"gamma/three".to_owned()
				])
			);
		});
	}
	#[test]
	fn replay_token_blank_or_real() {
		with_env(|| {
			set_env("ROBGJC_REPLAY_TOKEN", "   ");
			assert!(Settings::from_env().unwrap().replay_token.is_none());
			set_env("ROBGJC_REPLAY_TOKEN", "abc");
			assert_eq!(
				Settings::from_env()
					.unwrap()
					.replay_token
					.as_ref()
					.map(SecretString::expose),
				Some("abc")
			);
		});
	}
	#[test]
	fn blank_bot_login_rejected() {
		with_env(|| {
			set_env("ROBGJC_BOT_LOGIN", "   ");
			assert!(Settings::from_env().is_err());
		});
	}
	#[test]
	fn model_pool_single() {
		with_env(|| {
			let cfg = Settings::from_env().unwrap();
			assert_eq!(cfg.model_pool(), vec![cfg.model.clone()]);
			assert_eq!(cfg.pick_model(), cfg.model);
		});
	}
	#[test]
	fn model_pool_csv_parses() {
		with_env(|| {
			set_env(
				"ROBGJC_MODEL",
				" codex/gpt-5.4 , anthropic/claude-sonnet-4-6 ,, anthropic/claude-opus-4-7 ",
			);
			let cfg = Settings::from_env().unwrap();
			assert_eq!(cfg.model_pool(), vec![
				"codex/gpt-5.4",
				"anthropic/claude-sonnet-4-6",
				"anthropic/claude-opus-4-7"
			]);
		});
	}
	#[test]
	fn pick_model_covers_full_pool() {
		with_env(|| {
			set_env("ROBGJC_MODEL", "a,b,c");
			let cfg = Settings::from_env().unwrap();
			let seen: BTreeSet<String> = (0..500).map(|_| cfg.pick_model()).collect();
			assert_eq!(seen, BTreeSet::from(["a".to_owned(), "b".to_owned(), "c".to_owned()]));
		});
	}
	#[test]
	fn max_concurrency_default_is_8() {
		with_env(|| assert_eq!(Settings::from_env().unwrap().max_concurrency, 8));
	}
	#[test]
	fn task_timeout_hard_grace_env_parses() {
		with_env(|| {
			set_env("ROBGJC_TASK_TIMEOUT_HARD_GRACE_SECONDS", "12.5");
			assert_eq!(
				Settings::from_env()
					.unwrap()
					.task_timeout_hard_grace_seconds,
				12.5
			);
		});
	}
	#[test]
	fn differential_invalid_env_values_match_python() {
		with_env(|| {
			set_env("ROBGJC_MAX_CONCURRENCY", "nope");
			assert!(
				Settings::from_env()
					.unwrap_err()
					.contains("ROBGJC_MAX_CONCURRENCY")
			);
		});

		with_env(|| {
			set_env("ROBGJC_REPO_ALLOWLIST", "owner/repo,, other/repo, ");
			assert_eq!(
				Settings::from_env().unwrap().repo_allowlist(),
				BTreeSet::from(["owner/repo".to_owned(), "other/repo".to_owned()])
			);
		});

		with_env(|| {
			set_env("ROBGJC_REPO_ALLOWLIST", "not a repo,Owner/Repo,evil//repo");
			assert_eq!(
				Settings::from_env().unwrap().repo_allowlist(),
				BTreeSet::from([
					"not a repo".to_owned(),
					"owner/repo".to_owned(),
					"evil//repo".to_owned(),
				])
			);
		});
	}
	#[test]
	fn secrets_redact_debug_and_display() {
		with_env(|| {
			set_env("GITHUB_TOKEN", "ghp_super_secret");
			remove_env("ROBGJC_GH_PROXY_URL");
			remove_env("ROBGJC_GH_PROXY_HMAC_KEY");
			set_env("ROBGJC_REPLAY_TOKEN", "replay_secret");
			let cfg = Settings::from_env().unwrap();
			let debug = format!("{cfg:?}");
			assert!(!debug.contains("ghp_super_secret"));
			assert!(!debug.contains("replay_secret"));
			assert!(debug.contains("[redacted]"));
			assert_eq!(cfg.github_token.as_ref().unwrap().to_string(), "[redacted]");
		});
	}

	#[test]
	fn invalid_thinking_rejected() {
		with_env(|| {
			set_env("ROBGJC_THINKING", "maximum");
			assert!(
				Settings::from_env()
					.unwrap_err()
					.contains("ROBGJC_THINKING")
			);
		});
	}

	#[test]
	fn env_source_loads_dotenv_case_insensitively_and_process_wins() {
		let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
		set_env("ROBGJC_BOT_LOGIN", "from-process");
		let dir = std::env::temp_dir().join(format!("robogjc-env-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join(".env");
		std::fs::write(&path, "robgjc_bot_login=from-file\nGITHUB_TOKEN=file-token\n").unwrap();
		let source = EnvSource::load_from(&path).unwrap();
		assert_eq!(source.get("ROBGJC_BOT_LOGIN"), Some("from-process"));
		assert_eq!(source.get("github_token"), Some("file-token"));
		remove_env("ROBGJC_BOT_LOGIN");
	}
}
