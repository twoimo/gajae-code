//! Phase 3 (G004): supervised persistent TS-worker subprocess (headless only).
//!
//! The Rust daemon spawns one persistent worker process and talks to it over a
//! TWO-LANE channel: stdin carries runtime input (ordered + fast-lane), stdout
//! carries the protocol output stream, and stderr is kept SEPARATE from the
//! protocol (diagnostics only). Supervision adds: a sanitized environment, a
//! bounded restart policy, graceful drain, and crash detection. On crash the
//! caller fails the affected sessions (via the registry + broker) — never blind
//! replay. Unix/headless only; this is NOT the native zero-serialization path.

#![allow(
	clippy::duration_suboptimal_units,
	reason = "Duration::from_mins is unstable on stable Rust"
)]
#![allow(
	clippy::implicit_hasher,
	reason = "the worker env map is internal and always a std HashMap"
)]

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

/// Bounded restart policy: at most `max_restarts` within `window`.
#[derive(Debug, Clone, Copy)]
pub struct RestartPolicy {
	pub max_restarts: u32,
	pub window: Duration,
}

impl Default for RestartPolicy {
	fn default() -> Self {
		Self { max_restarts: 3, window: Duration::from_secs(60) }
	}
}

impl RestartPolicy {
	/// Whether another restart is allowed given how many restarts already happened
	/// inside the current window.
	#[must_use]
	pub const fn should_restart(&self, restarts_in_window: u32) -> bool {
		restarts_in_window < self.max_restarts
	}
}

/// Enforces the bounded [`RestartPolicy`] within a sliding time window.
///
/// The supervisor calls [`RestartTracker::record_restart`] after each crash; it
/// returns whether another restart is still permitted.
#[derive(Debug)]
pub struct RestartTracker {
	policy: RestartPolicy,
	window_start: std::time::Instant,
	restarts_in_window: u32,
}

impl RestartTracker {
	#[must_use]
	pub fn new(policy: RestartPolicy) -> Self {
		Self { policy, window_start: std::time::Instant::now(), restarts_in_window: 0 }
	}

	/// Record a restart; resets the counter when the window has elapsed. Returns
	/// `true` if another restart is still within policy, `false` once the bound is
	/// exceeded (the supervisor then fails the worker permanently).
	pub fn record_restart(&mut self) -> bool {
		let now = std::time::Instant::now();
		if now.duration_since(self.window_start) > self.policy.window {
			self.window_start = now;
			self.restarts_in_window = 0;
		}
		self.restarts_in_window += 1;
		self.policy.should_restart(self.restarts_in_window - 1)
	}
}

/// Build a minimal, sanitized environment for the worker: only an allowlist of
/// safe variables is forwarded, so the worker never inherits ambient secrets.
#[must_use]
pub fn sanitized_env(parent: &HashMap<String, String>) -> HashMap<String, String> {
	const ALLOW: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
	parent
		.iter()
		.filter(|(k, _)| ALLOW.contains(&k.as_str()))
		.map(|(k, v)| (k.clone(), v.clone()))
		.collect()
}

/// Why supervision reported a non-clean outcome.
#[derive(Debug)]
pub enum WorkerError {
	Spawn(std::io::Error),
	Io(std::io::Error),
}

impl std::fmt::Display for WorkerError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Spawn(e) => write!(f, "worker spawn failed: {e}"),
			Self::Io(e) => write!(f, "worker io error: {e}"),
		}
	}
}

impl std::error::Error for WorkerError {}

/// A supervised worker process with two-lane stdio.
pub struct Worker {
	child: Child,
	stdin: Option<ChildStdin>,
	stdout: Option<BufReader<tokio::process::ChildStdout>>,
	/// Diagnostics lane, captured SEPARATELY so it can never corrupt the protocol
	/// stream on stdout.
	stderr: Option<BufReader<tokio::process::ChildStderr>>,
}

impl Worker {
	/// Spawn `program args` with a sanitized environment and piped two-lane stdio.
	pub fn spawn(
		program: &str,
		args: &[&str],
		env: &HashMap<String, String>,
	) -> Result<Self, WorkerError> {
		let mut cmd = Command::new(program);
		cmd.args(args)
			.env_clear()
			.envs(sanitized_env(env))
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped()); // separate from protocol
		let mut child = cmd.spawn().map_err(WorkerError::Spawn)?;
		let stdin = child.stdin.take();
		let stdout = child.stdout.take().map(BufReader::new);
		let stderr = child.stderr.take().map(BufReader::new);
		Ok(Self { child, stdin, stdout, stderr })
	}

	/// Write a runtime-input line (the IPC lane carrying commands).
	pub async fn write_line(&mut self, line: &str) -> Result<(), WorkerError> {
		let stdin = self
			.stdin
			.as_mut()
			.ok_or_else(|| WorkerError::Io(broken_pipe()))?;
		stdin
			.write_all(line.as_bytes())
			.await
			.map_err(WorkerError::Io)?;
		stdin.write_all(b"\n").await.map_err(WorkerError::Io)?;
		stdin.flush().await.map_err(WorkerError::Io)?;
		Ok(())
	}

	/// Read one protocol-output line from stdout (`Ok(None)` on EOF).
	pub async fn read_protocol_line(&mut self) -> Result<Option<String>, WorkerError> {
		let stdout = self
			.stdout
			.as_mut()
			.ok_or_else(|| WorkerError::Io(broken_pipe()))?;
		let mut line = String::new();
		let n = stdout.read_line(&mut line).await.map_err(WorkerError::Io)?;
		if n == 0 {
			return Ok(None);
		}
		if line.ends_with('\n') {
			line.pop();
		}
		Ok(Some(line))
	}

	/// Detach the protocol stdout lane so a daemon-owned pump can drain it continuously.
	pub const fn take_stdout(&mut self) -> Option<BufReader<tokio::process::ChildStdout>> {
		self.stdout.take()
	}

	/// Read one diagnostics line from the separate stderr lane (`Ok(None)` on EOF).
	/// Never interleaves with the stdout protocol stream.
	pub async fn read_stderr_line(&mut self) -> Result<Option<String>, WorkerError> {
		let stderr = self
			.stderr
			.as_mut()
			.ok_or_else(|| WorkerError::Io(broken_pipe()))?;
		let mut line = String::new();
		let n = stderr.read_line(&mut line).await.map_err(WorkerError::Io)?;
		if n == 0 {
			return Ok(None);
		}
		if line.ends_with('\n') {
			line.pop();
		}
		Ok(Some(line))
	}

	/// Graceful drain: close stdin (EOF to the worker) and wait for clean exit.
	/// Returns the exit code (None if killed by signal).
	pub async fn drain(mut self) -> Result<Option<i32>, WorkerError> {
		self.stdin.take(); // drop -> EOF on the worker's stdin
		let status = self.child.wait().await.map_err(WorkerError::Io)?;
		Ok(status.code())
	}

	/// Wait for the process to exit and report whether it was a clean (code 0) exit.
	/// A non-zero/signal exit is a crash the caller must contain.
	pub async fn wait_crash(mut self) -> Result<bool, WorkerError> {
		let status = self.child.wait().await.map_err(WorkerError::Io)?;
		Ok(!status.success())
	}
}

fn broken_pipe() -> std::io::Error {
	std::io::Error::new(std::io::ErrorKind::BrokenPipe, "worker stdio closed")
}

/// How to (re)spawn the worker — the supervisor holds this so it can respawn after
/// a crash.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
	pub program: String,
	pub args: Vec<String>,
	pub env: HashMap<String, String>,
}

impl WorkerSpec {
	/// Spawn a fresh worker from this spec.
	pub fn spawn(&self) -> Result<Worker, WorkerError> {
		let args: Vec<&str> = self.args.iter().map(String::as_str).collect();
		Worker::spawn(&self.program, &args, &self.env)
	}
}

/// Live supervised restart loop: (re)spawn the worker, and on a crash record it
/// against the bounded [`RestartPolicy`].
///
/// Respawns while still permitted; stops permanently once the policy is exhausted
/// (no blind infinite restarts) or on a clean exit. Returns the total number of
/// spawns performed.
pub async fn supervise_crashing(
	spec: &WorkerSpec,
	policy: RestartPolicy,
) -> Result<u32, WorkerError> {
	let mut tracker = RestartTracker::new(policy);
	let mut spawns = 0u32;
	loop {
		let worker = spec.spawn()?;
		spawns += 1;
		let crashed = worker.wait_crash().await?;
		if !crashed {
			return Ok(spawns); // clean exit — nothing to restart
		}
		if !tracker.record_restart() {
			return Ok(spawns); // bounded policy exhausted — stop permanently
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn restart_policy_bounds_restarts() {
		let p = RestartPolicy { max_restarts: 3, window: Duration::from_secs(60) };
		assert!(p.should_restart(0));
		assert!(p.should_restart(2));
		assert!(!p.should_restart(3));
		assert!(!p.should_restart(9));
	}

	#[test]
	fn sanitized_env_drops_non_allowlisted_vars() {
		let mut parent = HashMap::new();
		parent.insert("PATH".to_string(), "/usr/bin".to_string());
		parent.insert("AWS_SECRET_ACCESS_KEY".to_string(), "shh".to_string());
		parent.insert("HOME".to_string(), "/home/u".to_string());
		let env = sanitized_env(&parent);
		assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
		assert_eq!(env.get("HOME").map(String::as_str), Some("/home/u"));
		assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"));
	}

	fn min_env() -> HashMap<String, String> {
		let mut e = HashMap::new();
		if let Ok(path) = std::env::var("PATH") {
			e.insert("PATH".to_string(), path);
		}
		e
	}

	#[tokio::test]
	async fn worker_two_lane_echo_and_graceful_drain() {
		// /bin/cat is a faithful stub: stdin (command lane) -> stdout (protocol lane).
		let mut w = Worker::spawn("/bin/cat", &[], &min_env()).expect("spawn cat");
		w.write_line("{\"ping\":1}").await.expect("write");
		let line = w.read_protocol_line().await.expect("read").expect("a line");
		assert_eq!(line, "{\"ping\":1}");
		// Drain: closing stdin gives cat EOF -> clean exit 0.
		let code = w.drain().await.expect("drain");
		assert_eq!(code, Some(0));
	}

	#[tokio::test]
	async fn worker_crash_is_detected() {
		// A worker that exits non-zero is a crash the daemon must contain.
		let w = Worker::spawn("/bin/sh", &["-c", "exit 7"], &min_env()).expect("spawn sh");
		let crashed = w.wait_crash().await.expect("wait");
		assert!(crashed, "non-zero exit must be reported as a crash");
	}

	#[tokio::test]
	async fn stderr_is_isolated_from_stdout_protocol() {
		// The worker writes to BOTH stdout (protocol) and stderr (diagnostics);
		// the protocol read must see only the stdout line, with stderr captured
		// separately on its own lane.
		let mut w =
			Worker::spawn("/bin/sh", &["-c", "echo OUT; echo ERR 1>&2"], &min_env()).expect("spawn");
		let out = w
			.read_protocol_line()
			.await
			.expect("read out")
			.expect("out line");
		assert_eq!(out, "OUT");
		let err = w
			.read_stderr_line()
			.await
			.expect("read err")
			.expect("err line");
		assert_eq!(err, "ERR");
	}

	#[test]
	fn restart_tracker_enforces_bounded_policy() {
		let mut t =
			RestartTracker::new(RestartPolicy { max_restarts: 2, window: Duration::from_secs(60) });
		// First two restarts are within policy; the third exceeds the bound.
		assert!(t.record_restart(), "1st restart allowed");
		assert!(t.record_restart(), "2nd restart allowed");
		assert!(!t.record_restart(), "3rd restart exceeds max -> permanent failure");
	}

	#[test]
	fn restart_tracker_resets_after_window() {
		let mut t =
			RestartTracker::new(RestartPolicy { max_restarts: 1, window: Duration::from_nanos(1) });
		assert!(t.record_restart(), "1st allowed");
		std::thread::sleep(Duration::from_millis(2)); // exceed the tiny window
		assert!(t.record_restart(), "window elapsed -> counter reset, restart allowed again");
	}

	#[tokio::test]
	async fn supervise_crashing_respawns_then_stops_at_policy_bound() {
		let spec = WorkerSpec {
			program: "/bin/sh".into(),
			args: vec!["-c".into(), "exit 1".into()],
			env: min_env(),
		};
		let spawns = supervise_crashing(
			&spec,
			RestartPolicy { max_restarts: 2, window: Duration::from_secs(60) },
		)
		.await
		.expect("supervise");
		assert_eq!(spawns, 3);
	}
}
