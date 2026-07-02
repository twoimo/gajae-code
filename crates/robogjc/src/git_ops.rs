//! Low-level git primitives ported from Python `robogjc.git_ops`.

use std::{
	collections::{BTreeMap, BTreeSet},
	fs, io,
	path::{Path, PathBuf},
	process::{Command, Output, Stdio},
	sync::LazyLock,
	time::Duration,
};

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

use regex::Regex;

use crate::redaction::redact_credentials;

pub const AUTH_ENV_VAR: &str = "ROBGJC_GIT_HTTP_AUTH";
pub const DEFAULT_GIT_TIMEOUT_SECONDS: u64 = 120;
const FETCH_PRUNE_REPAIR_ATTEMPTS: usize = 8;
const SHARED_GJC_GID: u32 = 2000;

static BAD_OBJECT_REF_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?:fatal: bad object (?P<bad>refs/[^\s]+)|error: (?P<invalid>refs/[^\s]+) does not point to a valid object!)").unwrap()
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommandError {
	pub cmd: Vec<String>,
	pub returncode: i32,
	pub stdout: String,
	pub stderr: String,
}
impl std::fmt::Display for GitCommandError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let msg = if !self.stderr.trim().is_empty() {
			self.stderr.trim()
		} else if !self.stdout.trim().is_empty() {
			self.stdout.trim()
		} else {
			return write!(
				f,
				"git {} failed: exit {}",
				self
					.cmd
					.iter()
					.skip(1)
					.cloned()
					.collect::<Vec<_>>()
					.join(" "),
				self.returncode
			);
		};
		write!(
			f,
			"git {} failed: {}",
			self
				.cmd
				.iter()
				.skip(1)
				.cloned()
				.collect::<Vec<_>>()
				.join(" "),
			msg
		)
	}
}
impl std::error::Error for GitCommandError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResult {
	pub head: String,
	pub branch: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtyState {
	pub uncommitted: usize,
	pub unpushed: usize,
	pub summary: String,
}
impl DirtyState {
	pub fn is_dirty(&self) -> bool {
		self.uncommitted > 0 || self.unpushed > 0
	}
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadDriftError(pub GitCommandError);
impl std::fmt::Display for HeadDriftError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.0.fmt(f)
	}
}
impl std::error::Error for HeadDriftError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitPushError {
	Git(GitCommandError),
	HeadDrift(HeadDriftError),
}
impl std::fmt::Display for GitPushError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Git(err) => err.fmt(f),
			Self::HeadDrift(err) => err.fmt(f),
		}
	}
}
impl std::error::Error for GitPushError {}
impl From<GitCommandError> for GitPushError {
	fn from(value: GitCommandError) -> Self {
		Self::Git(value)
	}
}
impl From<HeadDriftError> for GitPushError {
	fn from(value: HeadDriftError) -> Self {
		Self::HeadDrift(value)
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
	pub program: String,
	pub args: Vec<String>,
	pub cwd: Option<PathBuf>,
	pub env: BTreeMap<String, String>,
	pub timeout: Duration,
	pub user: Option<u32>,
	pub group: Option<u32>,
	pub extra_groups: Vec<u32>,
	pub umask: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
	pub status: i32,
	pub stdout: String,
	pub stderr: String,
}
pub trait CommandRunner {
	fn run(&self, spec: &CommandSpec) -> Result<CommandOutput, GitCommandError>;
}
#[derive(Debug, Default, Clone, Copy)]
pub struct RealCommandRunner;
impl CommandRunner for RealCommandRunner {
	fn run(&self, spec: &CommandSpec) -> Result<CommandOutput, GitCommandError> {
		run_real(spec)
	}
}

fn run_real(spec: &CommandSpec) -> Result<CommandOutput, GitCommandError> {
	let mut cmd = Command::new(&spec.program);
	cmd.args(&spec.args)
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.env("GIT_TERMINAL_PROMPT", "0");
	if let Some(cwd) = &spec.cwd {
		cmd.current_dir(cwd);
	}
	for (k, v) in &spec.env {
		cmd.env(k, v);
	}
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt;
		// Precompute the group vector BEFORE registering the hook: pre_exec
		// runs post-fork where allocation is not async-signal-safe.
		let groups: Vec<libc::gid_t> = spec
			.extra_groups
			.iter()
			.map(|g| *g as libc::gid_t)
			.collect();
		let umask = spec.umask;
		let group = spec.group;
		let user = spec.user;
		// The full identity transition happens in ONE async-signal-safe child
		// hook: setgroups -> setgid -> setuid -> umask. Supplementary groups
		// must be installed BEFORE the uid drop or setgroups fails with EPERM
		// (CommandExt::gid/uid would run before pre_exec, so they are not used).
		unsafe {
			cmd.pre_exec(move || {
				if !groups.is_empty()
					&& libc::setgroups(groups.len() as libc::c_int, groups.as_ptr()) != 0
				{
					return Err(io::Error::last_os_error());
				}
				if let Some(gid) = group {
					if libc::setgid(gid as libc::gid_t) != 0 {
						return Err(io::Error::last_os_error());
					}
				}
				if let Some(uid) = user {
					if libc::setuid(uid as libc::uid_t) != 0 {
						return Err(io::Error::last_os_error());
					}
				}
				if let Some(mask) = umask {
					libc::umask(mask as libc::mode_t);
				}
				Ok(())
			});
		}
	}
	let child = cmd
		.spawn()
		.map_err(|e| git_error(cmd_vec(spec), 127, "", &e.to_string()))?;
	match wait_with_timeout(child, spec.timeout)
		.map_err(|e| git_error(cmd_vec(spec), 127, "", &e.to_string()))?
	{
		WaitOutcome::Completed(out) => Ok(output_to_command(out)),
		WaitOutcome::TimedOut(out) => Err(git_error(
			cmd_vec(spec),
			124,
			&String::from_utf8_lossy(&out.stdout),
			&format!("git timed out after {}s: {}", spec.timeout.as_secs(), cmd_vec(spec).join(" ")),
		)),
	}
}
enum WaitOutcome {
	Completed(Output),
	TimedOut(Output),
}

#[cfg(unix)]
fn wait_with_timeout(mut child: std::process::Child, timeout: Duration) -> io::Result<WaitOutcome> {
	let start = std::time::Instant::now();
	loop {
		if child.try_wait()?.is_some() {
			return child.wait_with_output().map(WaitOutcome::Completed);
		}
		if start.elapsed() >= timeout {
			let _ = child.kill();
			return child.wait_with_output().map(WaitOutcome::TimedOut);
		}
		std::thread::sleep(Duration::from_millis(10));
	}
}
#[cfg(not(unix))]
fn wait_with_timeout(child: std::process::Child, _timeout: Duration) -> io::Result<WaitOutcome> {
	child.wait_with_output().map(WaitOutcome::Completed)
}

fn output_to_command(out: Output) -> CommandOutput {
	CommandOutput {
		status: out.status.code().unwrap_or_else(|| {
			#[cfg(unix)]
			{
				128 + out.status.signal().unwrap_or(1)
			}
			#[cfg(not(unix))]
			{
				1
			}
		}),
		stdout: redact_credentials(Some(&String::from_utf8_lossy(&out.stdout))),
		stderr: redact_credentials(Some(&String::from_utf8_lossy(&out.stderr))),
	}
}
fn cmd_vec(spec: &CommandSpec) -> Vec<String> {
	std::iter::once(spec.program.clone())
		.chain(spec.args.clone())
		.map(|s| redact_credentials(Some(&s)))
		.collect()
}
fn git_error(cmd: Vec<String>, returncode: i32, stdout: &str, stderr: &str) -> GitCommandError {
	GitCommandError {
		cmd: cmd
			.into_iter()
			.map(|s| redact_credentials(Some(&s)))
			.collect(),
		returncode,
		stdout: redact_credentials(Some(stdout)),
		stderr: redact_credentials(Some(stderr)),
	}
}
fn basic_auth_header(token: &str) -> String {
	use base64::Engine;
	format!(
		"Authorization: Basic {}",
		base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
	)
}

#[derive(Debug, Clone, Default)]
pub struct GitRunOptions {
	pub token: Option<String>,
	pub extra_env: BTreeMap<String, String>,
	pub safe_directory: Option<PathBuf>,
	pub user: Option<u32>,
	pub group: Option<u32>,
	pub extra_groups: Vec<u32>,
	pub umask: Option<u32>,
	pub timeout: Option<Duration>,
}

pub fn append_safe_directory(env: &mut BTreeMap<String, String>, repo_dir: &Path) {
	let count = env
		.get("GIT_CONFIG_COUNT")
		.and_then(|s| s.parse::<usize>().ok())
		.unwrap_or(0);
	env.insert(format!("GIT_CONFIG_KEY_{count}"), "safe.directory".into());
	env.insert(format!("GIT_CONFIG_VALUE_{count}"), repo_dir.display().to_string());
	env.insert("GIT_CONFIG_COUNT".into(), (count + 1).to_string());
}

pub fn slot_permissions_active(slot_uid: Option<u32>) -> bool {
	slot_uid.is_some() && cfg!(target_os = "linux") && unsafe { libc::geteuid() == 0 }
}
pub fn slot_subprocess_options(slot_uid: Option<u32>) -> GitRunOptions {
	if slot_permissions_active(slot_uid) {
		let uid = slot_uid.unwrap();
		GitRunOptions {
			user: Some(uid),
			group: Some(uid),
			extra_groups: vec![SHARED_GJC_GID],
			umask: Some(0o002),
			..Default::default()
		}
	} else {
		GitRunOptions::default()
	}
}

pub fn run_git_with<R: CommandRunner>(
	runner: &R,
	args: &[&str],
	cwd: Option<&Path>,
	opts: GitRunOptions,
) -> Result<CommandOutput, GitCommandError> {
	let mut env = opts.extra_env.clone();
	env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
	if let Some(safe) = &opts.safe_directory {
		append_safe_directory(&mut env, safe);
	}
	let mut cmd_args = Vec::new();
	if let Some(token) = &opts.token {
		env.insert(AUTH_ENV_VAR.into(), basic_auth_header(token));
		cmd_args.push("--config-env".into());
		cmd_args.push(format!("http.extraHeader={AUTH_ENV_VAR}"));
	}
	cmd_args.extend(args.iter().map(|s| s.to_string()));
	runner.run(&CommandSpec {
		program: "git".into(),
		args: cmd_args,
		cwd: cwd.map(Path::to_path_buf),
		env,
		timeout: opts
			.timeout
			.unwrap_or(Duration::from_secs(DEFAULT_GIT_TIMEOUT_SECONDS)),
		user: opts.user,
		group: opts.group,
		extra_groups: opts.extra_groups,
		umask: opts.umask,
	})
}
pub fn run_git(
	args: &[&str],
	cwd: Option<&Path>,
	opts: GitRunOptions,
) -> Result<CommandOutput, GitCommandError> {
	run_git_with(&RealCommandRunner, args, cwd, opts)
}
fn check(out: CommandOutput, cmd: Vec<String>) -> Result<CommandOutput, GitCommandError> {
	if out.status == 0 {
		Ok(out)
	} else {
		Err(git_error(cmd, out.status, &out.stdout, &out.stderr))
	}
}

pub fn clone_pool(
	target: &Path,
	clone_url: &str,
	default_branch: &str,
	token: Option<&str>,
	runner: &impl CommandRunner,
) -> Result<(), GitCommandError> {
	fs::create_dir_all(target.parent().unwrap_or_else(|| Path::new(".")))
		.map_err(|e| git_error(vec!["git".into(), "clone".into()], 127, "", &e.to_string()))?;
	let t = target.display().to_string();
	let args =
		["clone", "--filter=blob:none", "--no-tags", "--branch", default_branch, clone_url, &t];
	check(
		run_git_with(
			runner,
			&args,
			None,
			GitRunOptions { token: token.map(str::to_string), ..Default::default() },
		)?,
		std::iter::once("git".into())
			.chain(args.iter().map(|s| s.to_string()))
			.collect(),
	)
	.map(|_| ())
}
pub fn fetch_ref(repo_dir: &Path, rf: &str, token: Option<&str>, runner: &impl CommandRunner) {
	let _ = run_git_with(
		runner,
		&["fetch", "origin", rf],
		Some(repo_dir),
		GitRunOptions { token: token.map(str::to_string), ..Default::default() },
	);
}
pub fn fetch_prune(
	repo_dir: &Path,
	token: Option<&str>,
	runner: &impl CommandRunner,
) -> Result<(), GitCommandError> {
	let _ = prune_missing_alternates(repo_dir);
	let args = ["fetch", "--prune", "origin"];
	let mut last = None;
	for _ in 0..FETCH_PRUNE_REPAIR_ATTEMPTS {
		let out = run_git_with(
			runner,
			&args,
			Some(repo_dir),
			GitRunOptions { token: token.map(str::to_string), ..Default::default() },
		)?;
		if out.status == 0 {
			return Ok(());
		}
		let combined = format!("{}\n{}", out.stderr, out.stdout);
		if !repair_fetch_prune_failure(repo_dir, &combined, runner) {
			return check(out, vec!["git".into(), "fetch".into(), "--prune".into(), "origin".into()])
				.map(|_| ());
		}
		last = Some(out);
	}
	check(last.unwrap(), vec!["git".into(), "fetch".into(), "--prune".into(), "origin".into()])
		.map(|_| ())
}

fn git_dir(repo_dir: &Path) -> Option<PathBuf> {
	let dot = repo_dir.join(".git");
	if dot.is_dir() {
		return Some(dot);
	};
	if dot.is_file() {
		let text = fs::read_to_string(dot).ok()?;
		let raw = text.trim().strip_prefix("gitdir:")?.trim();
		let p = PathBuf::from(raw);
		return Some(if p.is_absolute() {
			p
		} else {
			repo_dir.join(p).canonicalize().ok()?
		});
	}
	if repo_dir.join("HEAD").exists() && repo_dir.join("objects").is_dir() {
		Some(repo_dir.to_path_buf())
	} else {
		None
	}
}
fn resolve_alternate(objects: &Path, raw: &str) -> PathBuf {
	let p = PathBuf::from(raw);
	if p.is_absolute() { p } else { objects.join(p) }
}
pub fn prune_missing_alternates(repo_dir: &Path) -> bool {
	let Some(git) = git_dir(repo_dir) else {
		return false;
	};
	let objects = git.join("objects");
	let path = objects.join("info/alternates");
	let Ok(text) = fs::read_to_string(&path) else {
		return false;
	};
	let mut kept = Vec::new();
	let mut changed = false;
	for line in text.lines() {
		let raw = line.trim();
		if raw.is_empty() {
			changed = true;
			continue;
		}
		if resolve_alternate(&objects, raw).is_dir() {
			kept.push(line.to_string())
		} else {
			changed = true
		}
	}
	if !changed {
		return false;
	}
	if kept.is_empty() {
		fs::remove_file(path).is_ok()
	} else {
		fs::write(path, kept.join("\n") + "\n").is_ok()
	}
}
fn is_safe_ref_name(r: &str) -> bool {
	r.starts_with("refs/")
		&& !r
			.chars()
			.any(|c| matches!(c, '\0' | '\r' | '\n' | '\t' | ' '))
		&& r.split('/').all(|p| !matches!(p, "" | "." | ".."))
}
pub fn bad_refs_from_fetch_output(output: &str) -> Vec<String> {
	let mut seen = BTreeSet::new();
	let mut refs = Vec::new();
	for cap in BAD_OBJECT_REF_RE.captures_iter(output) {
		let r = cap
			.name("bad")
			.or_else(|| cap.name("invalid"))
			.map(|m| m.as_str())
			.unwrap_or("");
		if is_safe_ref_name(r) && seen.insert(r.to_string()) {
			refs.push(r.to_string())
		}
	}
	refs
}
pub fn worktrees_holding_refs(
	repo_dir: &Path,
	refs: &[String],
	runner: &impl CommandRunner,
) -> BTreeMap<String, Vec<String>> {
	if refs.is_empty() {
		return BTreeMap::new();
	}
	let Ok(out) = run_git_with(
		runner,
		&["worktree", "list", "--porcelain"],
		Some(repo_dir),
		GitRunOptions::default(),
	) else {
		return BTreeMap::new();
	};
	if out.status != 0 {
		return BTreeMap::new();
	}
	let set: BTreeSet<_> = refs.iter().cloned().collect();
	let mut current = BTreeMap::new();
	let mut by = BTreeMap::<String, Vec<String>>::new();
	let mut flush = |cur: &mut BTreeMap<String, String>| {
		if let (Some(branch), Some(path)) = (cur.get("branch"), cur.get("worktree")) {
			if set.contains(branch) {
				by.entry(branch.clone()).or_default().push(path.clone())
			}
		}
		cur.clear();
	};
	for line in out.stdout.lines() {
		if line.trim().is_empty() {
			flush(&mut current);
			continue;
		}
		if let Some((k, v)) = line.split_once(' ') {
			current.insert(k.to_string(), v.to_string());
		}
	}
	flush(&mut current);
	by
}
pub fn delete_bad_refs(repo_dir: &Path, output: &str, runner: &impl CommandRunner) -> bool {
	let bad = bad_refs_from_fetch_output(output);
	if bad.is_empty() {
		return false;
	}
	let holding = worktrees_holding_refs(repo_dir, &bad, runner);
	let mut changed = false;
	for rf in bad {
		if let Some(paths) = holding.get(&rf) {
			for p in paths {
				if run_git_with(
					runner,
					&["worktree", "remove", "--force", p],
					Some(repo_dir),
					GitRunOptions::default(),
				)
				.map(|o| o.status == 0)
				.unwrap_or(false)
				{
					changed = true;
				}
			}
			let _ =
				run_git_with(runner, &["worktree", "prune"], Some(repo_dir), GitRunOptions::default());
		}
		if run_git_with(runner, &["update-ref", "-d", &rf], Some(repo_dir), GitRunOptions::default())
			.map(|o| o.status == 0)
			.unwrap_or(false)
		{
			changed = true;
		}
	}
	changed
}
fn repair_fetch_prune_failure(repo_dir: &Path, output: &str, runner: &impl CommandRunner) -> bool {
	prune_missing_alternates(repo_dir) | delete_bad_refs(repo_dir, output, runner)
}

pub fn rev_parse_head(
	repo_dir: &Path,
	opts: GitRunOptions,
	runner: &impl CommandRunner,
) -> Result<String, GitCommandError> {
	let out = run_git_with(runner, &["rev-parse", "HEAD"], Some(repo_dir), opts)?;
	check(out, vec!["git".into(), "rev-parse".into(), "HEAD".into()])
		.map(|o| o.stdout.trim().to_string())
}
pub fn inspect_dirty_state(
	repo_dir: &Path,
	slot_uid: Option<u32>,
	safe_directory: Option<&Path>,
	runner: &impl CommandRunner,
) -> DirtyState {
	let mut opts = slot_subprocess_options(slot_uid);
	opts.safe_directory = safe_directory.map(Path::to_path_buf);
	let status = run_git_with(
		runner,
		&["status", "--porcelain=v1", "--untracked-files=normal"],
		Some(repo_dir),
		opts.clone(),
	)
	.ok();
	let lines: Vec<String> = status
		.filter(|o| o.status == 0)
		.map(|o| o.stdout.lines().map(str::to_string).collect())
		.unwrap_or_default();
	let uncommitted = lines.len();
	let count = run_git_with(
		runner,
		&["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
		Some(repo_dir),
		opts.clone(),
	)
	.ok();
	let unpushed = count
		.filter(|o| o.status == 0)
		.and_then(|o| o.stdout.trim().parse::<usize>().ok())
		.unwrap_or(0);
	let mut logs = Vec::new();
	if unpushed > 0 {
		let max = format!("--max-count={}", unpushed.min(5));
		if let Ok(out) = run_git_with(
			runner,
			&["log", &max, "--oneline", "HEAD", "--not", "--remotes=origin"],
			Some(repo_dir),
			opts,
		) {
			if out.status == 0 {
				logs = out
					.stdout
					.lines()
					.filter(|l| !l.trim().is_empty())
					.map(str::to_string)
					.collect();
			}
		}
	}
	if uncommitted == 0 && unpushed == 0 {
		return DirtyState { uncommitted: 0, unpushed: 0, summary: String::new() };
	}
	let mut parts = Vec::new();
	if uncommitted > 0 {
		let sample = lines
			.iter()
			.take(10)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n");
		let more = if uncommitted > 10 {
			format!("\n… and {} more", uncommitted - 10)
		} else {
			String::new()
		};
		parts.push(format!("Uncommitted changes ({uncommitted}):\n{sample}{more}"));
	}
	if unpushed > 0 {
		parts.push(format!(
			"Unpushed commits ({unpushed}):\n{}",
			if logs.is_empty() {
				"(no log available)".into()
			} else {
				logs.join("\n")
			}
		));
	}
	DirtyState { uncommitted, unpushed, summary: parts.join("\n\n") }
}

pub fn push(
	repo_dir: &Path,
	branch: &str,
	expected_head: Option<&str>,
	token: Option<&str>,
	slot_uid: Option<u32>,
	safe_directory: Option<&Path>,
	runner: &impl CommandRunner,
) -> Result<PushResult, GitPushError> {
	let mut opts = slot_subprocess_options(slot_uid);
	if safe_directory.is_some() {
		opts.safe_directory = safe_directory.map(Path::to_path_buf)
	} else if opts.user.is_some() {
		opts.safe_directory = Some(repo_dir.to_path_buf())
	}
	let head = rev_parse_head(repo_dir, opts.clone(), runner)?;
	if let Some(exp) = expected_head {
		if exp != head {
			return Err(
				HeadDriftError(git_error(
					vec!["git".into(), "push".into()],
					128,
					"",
					&format!(
						"HEAD changed since preflight ({} → {}); aborting push.",
						&exp[..exp.len().min(12)],
						&head[..head.len().min(12)]
					),
				))
				.into(),
			);
		}
	}
	let probe = run_git_with(
		runner,
		&["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")],
		Some(repo_dir),
		opts.clone(),
	)?;
	let expected_remote = if probe.status == 0 {
		probe.stdout.trim().to_string()
	} else {
		String::new()
	};
	let mut push_opts = opts.clone();
	push_opts.token = token.map(str::to_string);
	let origin = run_git_with(runner, &["remote", "get-url", "origin"], Some(repo_dir), opts).ok();
	if let Some(local) = origin
		.filter(|o| o.status == 0)
		.and_then(|o| local_remote_safe_directory(o.stdout.trim(), repo_dir))
	{
		append_safe_directory(&mut push_opts.extra_env, &local);
	}
	let lease = format!("--force-with-lease=refs/heads/{branch}:{expected_remote}");
	check(
		run_git_with(
			runner,
			&["push", &lease, "--set-upstream", "origin", branch],
			Some(repo_dir),
			push_opts,
		)?,
		vec![
			"git".into(),
			"push".into(),
			lease,
			"--set-upstream".into(),
			"origin".into(),
			branch.into(),
		],
	)?;
	Ok(PushResult { head, branch: branch.into() })
}
fn local_remote_safe_directory(raw: &str, cwd: &Path) -> Option<PathBuf> {
	let s = raw.trim();
	if s.is_empty() {
		return None;
	}
	if let Some(rest) = s.strip_prefix("file://") {
		let (netloc, path) = rest
			.split_once('/')
			.map(|(host, path)| (host, format!("/{path}")))
			.unwrap_or((rest, String::new()));
		if !matches!(netloc, "" | "localhost") {
			return None;
		}
		return Some(PathBuf::from(path));
	}
	if s.contains("://") || Regex::new(r"^[^/\\\s]+:").unwrap().is_match(s) {
		return None;
	}
	let p = PathBuf::from(s);
	Some(if p.is_absolute() { p } else { cwd.join(p) })
}
