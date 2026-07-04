use std::{
	io::{BufRead, BufReader},
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	sync::{Arc, Mutex},
	time::Duration,
};

use anyhow::{Context, Result, bail};
use tauri::{AppHandle, Manager};

use crate::discovery::{AppServerEndpoint, wait_for_ready};

pub const DEV_ORIGIN: &str = "http://localhost:5173";
pub const PACKAGED_ORIGIN: &str = "tauri://localhost";
const READINESS_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone)]
pub struct SidecarEnv {
	pub session_id:      String,
	pub state_root:      PathBuf,
	pub allowed_origins: Vec<String>,
}

impl SidecarEnv {
	pub fn new(app_data_dir: &Path) -> Self {
		Self {
			session_id:      format!("desktop-{}", uuid::Uuid::new_v4()),
			state_root:      app_data_dir.join("app-server-state"),
			allowed_origins: vec![DEV_ORIGIN.to_owned(), PACKAGED_ORIGIN.to_owned()],
		}
	}

	pub fn env_pairs(&self) -> Vec<(String, String)> {
		vec![
			("GJC_APP_SERVER_WS".to_owned(), "1".to_owned()),
			("GJC_SESSION_ID".to_owned(), self.session_id.clone()),
			("GJC_APP_SERVER_STATE_ROOT".to_owned(), self.state_root.to_string_lossy().into_owned()),
			("GJC_APP_SERVER_ALLOWED_ORIGINS".to_owned(), self.allowed_origins.join(",")),
		]
	}
}

#[derive(Debug)]
pub struct SidecarSupervisor {
	inner: Mutex<Option<RunningSidecar>>,
	/// Serializes spawn/readiness so concurrent `endpoint()` callers (e.g. the
	/// frontend's cold-start auto-retry loop) await one in-flight cold spawn
	/// instead of each launching a duplicate sidecar.
	start_lock: tokio::sync::Mutex<()>,
}

#[derive(Debug)]
struct RunningSidecar {
	child:    Child,
	env:      SidecarEnv,
	endpoint: AppServerEndpoint,
}

impl SidecarSupervisor {
	pub fn new() -> Self {
		Self { inner: Mutex::new(None), start_lock: tokio::sync::Mutex::new(()) }
	}

	pub async fn endpoint(&self, app: &AppHandle) -> Result<AppServerEndpoint> {
		if let Some(endpoint) = self.current_endpoint()? {
			return Ok(endpoint);
		}
		let _guard = self.start_lock.lock().await;
		// Re-check under the lock: a concurrent caller may have started the
		// sidecar while we awaited the lock.
		if let Some(endpoint) = self.current_endpoint()? {
			return Ok(endpoint);
		}
		self.restart(app).await
	}

	pub async fn restart(&self, app: &AppHandle) -> Result<AppServerEndpoint> {
		self.kill_current();
		let app_data_dir = app
			.path()
			.app_data_dir()
			.context("failed to resolve app data directory")?;
		std::fs::create_dir_all(&app_data_dir).context("failed to create app data directory")?;
		let env = SidecarEnv::new(&app_data_dir);
		std::fs::create_dir_all(&env.state_root).context("failed to create app-server state root")?;

		let mut command = command_for_sidecar(app)?;
		for (key, value) in env.env_pairs() {
			command.env(key, value);
		}
		command.arg("app-server");
		command.stdin(Stdio::piped());
		command.stdout(Stdio::piped());
		command.stderr(Stdio::piped());

		let mut child = command
			.spawn()
			.context("failed to spawn app-server sidecar")?;
		spawn_stderr_forwarder(child.stderr.take());
		spawn_stdout_drain(child.stdout.take());

		let endpoint = wait_for_ready(&env.state_root, &env.session_id, READINESS_TIMEOUT).await?;
		let mut guard = self
			.inner
			.lock()
			.expect("sidecar supervisor mutex poisoned");
		*guard = Some(RunningSidecar { child, env, endpoint: endpoint.clone() });
		Ok(endpoint)
	}

	pub fn shutdown(&self) {
		self.kill_current();
	}

	fn current_endpoint(&self) -> Result<Option<AppServerEndpoint>> {
		let mut guard = self
			.inner
			.lock()
			.expect("sidecar supervisor mutex poisoned");
		let Some(running) = guard.as_mut() else {
			return Ok(None);
		};
		if running.child.try_wait()?.is_some() {
			*guard = None;
			return Ok(None);
		}
		Ok(Some(running.endpoint.clone()))
	}

	fn kill_current(&self) {
		let mut guard = self
			.inner
			.lock()
			.expect("sidecar supervisor mutex poisoned");
		if let Some(mut running) = guard.take() {
			let _ = running.child.kill();
			let _ = running.child.wait();
			let path = gjc_app_server::discovery::discovery_path(
				&running.env.state_root,
				&running.env.session_id,
			);
			let _ = std::fs::remove_file(path);
		}
	}
}

fn command_for_sidecar(app: &AppHandle) -> Result<Command> {
	#[cfg(all(debug_assertions, feature = "dev-bun-sidecar"))]
	{
		let mut command = Command::new("bun");
		command.arg("../../packages/coding-agent/bin/gjc.js");
		return Ok(command);
	}

	#[cfg(not(all(debug_assertions, feature = "dev-bun-sidecar")))]
	{
		// Tauri v2 `bundle.externalBin` places the sidecar next to the app
		// executable (Contents/MacOS/gjc on macOS), so prefer that location.
		if let Ok(exe) = std::env::current_exe()
			&& let Some(dir) = exe.parent()
		{
			let sibling = dir.join("gjc");
			if sibling.is_file() {
				return Ok(Command::new(sibling));
			}
		}
		if let Ok(path) = app
			.path()
			.resolve("gjc", tauri::path::BaseDirectory::Resource)
		{
			return Ok(Command::new(path));
		}
		if let Ok(path) = app
			.path()
			.resolve("bin/gjc", tauri::path::BaseDirectory::Resource)
		{
			return Ok(Command::new(path));
		}
		bail!("bundled gjc sidecar not found");
	}
}

fn spawn_stderr_forwarder(stderr: Option<std::process::ChildStderr>) {
	if let Some(stderr) = stderr {
		std::thread::spawn(move || {
			for line in BufReader::new(stderr).lines().map_while(Result::ok) {
				tracing::warn!(target: "gjc_desktop::sidecar", "{}", redact_tokens(&line));
			}
		});
	}
}

fn spawn_stdout_drain(stdout: Option<std::process::ChildStdout>) {
	if let Some(stdout) = stdout {
		std::thread::spawn(move || {
			let mut reader = BufReader::new(stdout);
			let mut buffer = String::new();
			while reader.read_line(&mut buffer).unwrap_or(0) != 0 {
				buffer.clear();
			}
		});
	}
}

pub fn redact_tokens(line: &str) -> String {
	if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(line) {
		redact_json_tokens(&mut value);
		return value.to_string();
	}

	let mut redacted = String::with_capacity(line.len());
	for segment in line.split('&') {
		if !redacted.is_empty() {
			redacted.push('&');
		}
		if let Some((prefix, _)) = segment.split_once("token=") {
			redacted.push_str(prefix);
			redacted.push_str("token=<redacted>");
		} else {
			redacted.push_str(segment);
		}
	}
	redacted
}

fn redact_json_tokens(value: &mut serde_json::Value) {
	match value {
		serde_json::Value::Object(map) => {
			for (key, nested) in map {
				if key == "token" {
					*nested = serde_json::Value::String("<redacted>".to_owned());
				} else {
					redact_json_tokens(nested);
				}
			}
		},
		serde_json::Value::Array(items) => {
			for nested in items {
				redact_json_tokens(nested);
			}
		},
		_ => {},
	}
}

pub type SharedSupervisor = Arc<SidecarSupervisor>;

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn env_contains_sidecar_contract() {
		let env = SidecarEnv {
			session_id:      "desktop-test".to_owned(),
			state_root:      PathBuf::from("/tmp/gjc-state"),
			allowed_origins: vec![DEV_ORIGIN.to_owned(), PACKAGED_ORIGIN.to_owned()],
		};
		let pairs = env.env_pairs();
		assert!(pairs.contains(&("GJC_APP_SERVER_WS".to_owned(), "1".to_owned())));
		assert!(pairs.contains(&("GJC_SESSION_ID".to_owned(), "desktop-test".to_owned())));
		assert!(pairs.contains(&(
			"GJC_APP_SERVER_ALLOWED_ORIGINS".to_owned(),
			"http://localhost:5173,tauri://localhost".to_owned(),
		)));
	}

	#[test]
	fn redacts_query_tokens() {
		assert_eq!(
			redact_tokens("ws://127.0.0.1:1?token=secret&x=1"),
			"ws://127.0.0.1:1?token=<redacted>&x=1",
		);
	}

	#[test]
	fn redacts_json_tokens() {
		assert_eq!(
			redact_tokens(r#"{"url":"ws://x","token":"secret"}"#),
			r#"{"url":"ws://x","token":"<redacted>"}"#,
		);
	}
}
