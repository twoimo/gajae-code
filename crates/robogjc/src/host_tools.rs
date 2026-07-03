//! Host-tool registration, invocation, and result boundary for app-server
//! calls.

use std::{
	collections::BTreeMap,
	env, fs,
	path::Path,
	process::{Command, Stdio},
	sync::{Arc, Mutex, RwLock},
	thread,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{
	config::Settings,
	db::{Database, iso_seconds_ago, issue_key},
	git_ops::{GitPushError, append_safe_directory, slot_subprocess_options},
	github::{GitHubBackend, GitHubError, IssueInfo, OpenPullRequest, RepoInfo},
	persona,
	redaction::redact_credentials,
	sandbox::{
		GitTransport, Workspace, prepare_slot_runtime_env, rename_workspace_branch,
		slot_permissions_active,
	},
	workspace_keys::{validate_branch_slug, workspace_key},
};

const PRE_PR_FIX_COMMAND: &[&str] = &["bun", "run", "fix"];
const PRE_PR_CHECK_COMMAND: &[&str] = &["bun", "check"];
const PRE_PUBLISH_BUN_TIMEOUT: Duration = Duration::from_mins(10);
const PRE_PR_FIX_COMMIT_SUBJECT: &str = "style: bun run fix";
const PRE_PR_CHECK_MAX_OUTPUT: usize = 12_000;
const SCRUBBED_ENV_KEYS: &[&str] =
	&["GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "ROBGJC_REPLAY_TOKEN", "ROBGJC_GH_PROXY_HMAC_KEY"];
const AGENT_HOME: &str = "/srv/agent-home";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostToolDescriptor {
	pub name:            String,
	pub description:     String,
	#[serde(rename = "inputSchema")]
	pub input_schema:    Value,
	#[serde(rename = "resultPolicy", skip_serializing_if = "Option::is_none")]
	pub result_policy:   Option<Value>,
	#[serde(rename = "redactionHints", skip_serializing_if = "Option::is_none")]
	pub redaction_hints: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostToolError {
	pub message: String,
}
impl std::fmt::Display for HostToolError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.message.fmt(f)
	}
}
impl std::error::Error for HostToolError {}
type Result<T> = std::result::Result<T, HostToolError>;
fn err<T>(msg: impl Into<String>) -> Result<T> {
	Err(HostToolError { message: msg.into() })
}

#[derive(Clone, Default)]
pub struct AbortController {
	inner: Arc<Mutex<AbortState>>,
}
#[derive(Default)]
struct AbortState {
	triggered: bool,
	reason:    String,
	stop:      Option<Arc<dyn Fn() + Send + Sync>>,
}
impl AbortController {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn set_stop<F: Fn() + Send + Sync + 'static>(&self, stop: F) {
		self.inner.lock().unwrap().stop = Some(Arc::new(stop));
	}

	pub fn signal(&self, reason: &str) {
		let stop = {
			let mut s = self.inner.lock().unwrap();
			if s.triggered {
				return;
			}
			s.triggered = true;
			reason.clone_into(&mut s.reason);
			s.stop.clone()
		};
		if let Some(stop) = stop {
			stop();
		}
	}

	pub fn triggered(&self) -> bool {
		self.inner.lock().unwrap().triggered
	}

	pub fn reason(&self) -> String {
		self.inner.lock().unwrap().reason.clone()
	}
}

#[derive(Clone)]
pub struct ToolBindings<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized> {
	pub db:                    Arc<Database>,
	pub github:                Arc<G>,
	pub git_transport:         Arc<T>,
	pub repo:                  RepoInfo,
	pub issue:                 IssueInfo,
	pub workspace:             Workspace,
	pub workspace_branch:      Arc<RwLock<String>>,
	pub author_name:           String,
	pub author_email:          String,
	pub settings:              Option<Settings>,
	pub inbound_thread_number: Option<i64>,
	pub inbound_is_pr:         bool,
	pub slot_uid:              Option<u32>,
	pub abort:                 Option<AbortController>,
}
impl<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized> ToolBindings<G, T> {
	pub fn issue_key(&self) -> String {
		issue_key(&self.issue.repo, self.issue.number)
	}

	pub fn default_comment_number(&self) -> i64 {
		self.inbound_thread_number.unwrap_or(self.issue.number)
	}

	pub fn workspace_branch(&self) -> String {
		self.workspace_branch.read().unwrap().clone()
	}

	pub fn set_workspace_branch(&self, branch: String) {
		*self.workspace_branch.write().unwrap() = branch;
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
	pub ok:   bool,
	pub text: String,
}

pub struct HostTool<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized> {
	pub descriptor: HostToolDescriptor,
	execute:        fn(&ToolBindings<G, T>, Value) -> Result<String>,
}
impl<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized> HostTool<G, T> {
	pub fn call(&self, bindings: &ToolBindings<G, T>, args: Value) -> ToolResult {
		match (self.execute)(bindings, args) {
			Ok(text) => ToolResult { ok: true, text: redact_credentials(Some(&text)) },
			Err(e) => ToolResult { ok: false, text: redact_credentials(Some(&e.message)) },
		}
	}
}

pub fn descriptors() -> Vec<HostToolDescriptor> {
	build::<crate::github::GitHubClient, crate::sandbox::LocalGitTransport>(None)
		.into_iter()
		.map(|t| t.descriptor)
		.collect()
}

pub fn build<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	_bindings: Option<&ToolBindings<G, T>>,
) -> Vec<HostTool<G, T>> {
	vec![
		tool(
			"classify_issue",
			classify_issue,
			schema(
				json!({"primary":{"type":"string","enum":PRIMARY_TYPES},"priority":{"type":"string","enum":PRIORITIES},"functional":{"type":"array","items":{"type":"string","enum":FUNCTIONAL}},"provider":{"type":"string"},"platform":{"type":"string","enum":PLATFORMS},"rationale":{"type":"string"},"branch_slug":{"type":"string"}}),
				&["primary", "rationale"],
			),
		),
		tool(
			"set_issue_labels",
			set_issue_labels,
			schema(
				json!({"labels":{"type":"array","items":{"type":"string"}},"number":{"type":"integer"}}),
				&["labels"],
			),
		),
		tool(
			"gh_post_comment",
			gh_post_comment,
			schema(json!({"body":{"type":"string"},"number":{"type":"integer"}}), &["body"]),
		),
		tool(
			"gh_push_branch",
			gh_push_branch,
			schema(json!({"branch":{"type":"string"},"skip_checks":{"type":"boolean"}}), &[]),
		),
		tool(
			"gh_open_pr",
			gh_open_pr,
			schema(
				json!({"title":{"type":"string"},"body":{"type":"string"},"base":{"type":"string"},"draft":{"type":"boolean","default":false},"skip_checks":{"type":"boolean"}}),
				&["title", "body"],
			),
		),
		tool(
			"gh_request_review",
			gh_request_review,
			schema(
				json!({"reviewers":{"type":"array","items":{"type":"string"}},"assignees":{"type":"array","items":{"type":"string"}}}),
				&[],
			),
		),
		tool(
			"repro_record",
			repro_record,
			schema(
				json!({"title":{"type":"string"},"command":{"type":"string"},"output":{"type":"string"},"exit_code":{"type":"integer"},"reproduced":{"type":"boolean"}}),
				&["title", "command", "output", "exit_code"],
			),
		),
		tool(
			"mark_unable_to_reproduce",
			mark_unable,
			schema(json!({"diagnosis":{"type":"string"},"info_needed":{"type":"string"}}), &[
				"diagnosis",
				"info_needed",
			]),
		),
		tool("abort_task", abort_task, schema(json!({"reason":{"type":"string"}}), &["reason"])),
		tool("fetch_issue_thread", fetch_issue_thread, schema(json!({}), &[])),
	]
}
fn tool<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	name: &str,
	execute: fn(&ToolBindings<G, T>, Value) -> Result<String>,
	input_schema: Value,
) -> HostTool<G, T> {
	HostTool {
		descriptor: HostToolDescriptor {
			name: name.into(),
			description: persona::host_tool_description(name).unwrap_or_else(|_| name.into()),
			input_schema,
			result_policy: Some(json!({"type":"text","redactCredentials":true})),
			redaction_hints: Some(json!({"credentials":true})),
		},
		execute,
	}
}
fn schema(props: Value, required: &[&str]) -> Value {
	json!({"type":"object","properties":props,"required":required,"additionalProperties":false})
}
fn args(v: &Value) -> &Map<String, Value> {
	v.as_object().expect("tool args must be object")
}
fn str_req<'a>(a: &'a Map<String, Value>, key: &str, tool: &str) -> Result<&'a str> {
	a.get(key)
		.and_then(Value::as_str)
		.filter(|s| !s.trim().is_empty())
		.ok_or_else(|| HostToolError { message: format!("{tool} requires a non-empty '{key}'.") })
}
fn bool_arg(a: &Map<String, Value>, key: &str) -> bool {
	a.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn audit<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	name: &str,
	args: &Value,
	result: Option<Value>,
	error: Option<&str>,
) {
	let _ = b
		.db
		.log_tool_call(&b.issue_key(), name, args, result.as_ref(), error);
}
fn block_on<F: std::future::Future>(f: F) -> F::Output {
	tokio::runtime::Runtime::new().unwrap().block_on(f)
}
fn gherr(prefix: &str, e: GitHubError) -> HostToolError {
	HostToolError { message: format!("{prefix}: {} {}", e.status, e.message) }
}

pub fn git_identity_env(author_name: &str, author_email: &str) -> BTreeMap<String, String> {
	BTreeMap::from([
		("GIT_AUTHOR_NAME".into(), author_name.into()),
		("GIT_AUTHOR_EMAIL".into(), author_email.into()),
		("GIT_COMMITTER_NAME".into(), author_name.into()),
		("GIT_COMMITTER_EMAIL".into(), author_email.into()),
	])
}
pub fn repo_command_env<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
) -> BTreeMap<String, String> {
	let mut envs: BTreeMap<String, String> = env::vars().collect();
	for k in SCRUBBED_ENV_KEYS {
		envs.insert((*k).into(), String::new());
	}
	if Path::new(AGENT_HOME).is_dir() {
		envs.insert("HOME".into(), AGENT_HOME.into());
	}
	if let Ok(rt) = prepare_slot_runtime_env(&b.workspace, b.slot_uid) {
		envs.extend(rt);
	}
	append_safe_directory(&mut envs, &b.workspace.repo_dir);
	envs.extend(git_identity_env(&b.author_name, &b.author_email));
	envs.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
	envs
}
#[cfg(test)]
thread_local! {
	static FAKE_REPO_COMMANDS: std::cell::RefCell<Vec<(Vec<String>, ProcOut)>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn take_fake_repo_command(cmd: &[&str]) -> Option<ProcOut> {
	FAKE_REPO_COMMANDS.with(|commands| {
		let mut commands = commands.borrow_mut();
		let wanted: Vec<String> = cmd.iter().map(|s| (*s).to_owned()).collect();
		commands
			.iter()
			.position(|(c, _)| *c == wanted)
			.map(|pos| commands.remove(pos).1)
	})
}

#[derive(Debug, Clone)]
struct ProcOut {
	code:   i32,
	stdout: String,
	stderr: String,
}
fn run_repo_command<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	cmd: &[&str],
) -> std::io::Result<ProcOut> {
	run_repo_command_with_timeout(b, cmd, None)
}
fn run_repo_command_with_timeout<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	cmd: &[&str],
	timeout: Option<Duration>,
) -> std::io::Result<ProcOut> {
	#[cfg(test)]
	if let Some(out) = take_fake_repo_command(cmd) {
		return Ok(out);
	}
	let opts = slot_subprocess_options(b.slot_uid);
	let mut c = Command::new(cmd[0]);
	c.args(&cmd[1..])
		.current_dir(&b.workspace.repo_dir)
		.env_clear()
		.envs(repo_command_env(b))
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	#[cfg(unix)]
	{
		use std::os::unix::process::CommandExt;
		if let Some(uid) = opts.user {
			c.uid(uid);
		}
		if let Some(gid) = opts.group {
			c.gid(gid);
		}
	}
	let mut child = c.spawn()?;
	if let Some(timeout) = timeout {
		let start = Instant::now();
		loop {
			if child.try_wait()?.is_some() {
				let out = child.wait_with_output()?;
				return Ok(ProcOut {
					code:   out.status.code().unwrap_or(-1),
					stdout: String::from_utf8_lossy(&out.stdout).into(),
					stderr: String::from_utf8_lossy(&out.stderr).into(),
				});
			}
			if start.elapsed() >= timeout {
				let _ = child.kill();
				let out = child.wait_with_output()?;
				return Ok(ProcOut {
					code:   124,
					stdout: String::from_utf8_lossy(&out.stdout).into(),
					stderr: format!(
						"command timed out after {}s: {}\n{}",
						timeout.as_secs(),
						cmd.join(" "),
						String::from_utf8_lossy(&out.stderr)
					),
				});
			}
			thread::sleep(Duration::from_millis(25));
		}
	}
	let out = child.wait_with_output()?;
	Ok(ProcOut {
		code:   out.status.code().unwrap_or(-1),
		stdout: String::from_utf8_lossy(&out.stdout).into(),
		stderr: String::from_utf8_lossy(&out.stderr).into(),
	})
}
fn has_bun_script(repo: &Path, name: &str) -> bool {
	let Ok(s) = fs::read_to_string(repo.join("package.json")) else {
		return false;
	};
	let Ok(v) = serde_json::from_str::<Value>(&s) else {
		return true;
	};
	v.get("scripts")
		.and_then(|s| s.get(name))
		.and_then(Value::as_str)
		.is_some()
}
fn fmt_out(o: &ProcOut) -> String {
	let mut s = [o.stdout.trim(), o.stderr.trim()]
		.into_iter()
		.filter(|x| !x.is_empty())
		.collect::<Vec<_>>()
		.join("\n");
	if s.is_empty() {
		s = "(no output)".into();
	}
	if s.len() > PRE_PR_CHECK_MAX_OUTPUT {
		s = format!(
			"... output truncated to last {PRE_PR_CHECK_MAX_OUTPUT} characters ...\n{}",
			&s[s.len() - PRE_PR_CHECK_MAX_OUTPUT..]
		);
	}
	s
}
fn pre_publish_fix<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: &Value,
	tool: &str,
	stage: &str,
	skip: bool,
) -> Result<()> {
	if !has_bun_script(&b.workspace.repo_dir, "fix") {
		return Ok(());
	}
	let st = run_repo_command(b, &["git", "status", "--porcelain", "--untracked-files=normal"])
		.map_err(|e| HostToolError { message: e.to_string() })?;
	if !st.stdout.trim().is_empty() {
		let msg = format!(
			"refusing to {stage}: dirty worktree before `bun run fix`.\n  {}",
			st.stdout.trim().replace('\n', "\n  ")
		);
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	if skip {
		audit(b, tool, av, Some(json!({"skipped":"bun_run_fix","reason":"skip_checks=true"})), None);
		return Ok(());
	}
	let p = match run_repo_command_with_timeout(b, PRE_PR_FIX_COMMAND, Some(PRE_PUBLISH_BUN_TIMEOUT))
	{
		Ok(p) => p,
		Err(e) => {
			let msg = format!(
				"refusing to {stage}: `bun run fix` is required before {stage}, but it could not be \
				 spawned: {e}"
			);
			audit(b, tool, av, None, Some(&msg));
			return err(msg);
		},
	};
	if p.code != 0 {
		let msg = format!(
			"refusing to {stage}: `bun run fix` failed before {stage} (exit {}).\n{}",
			p.code,
			fmt_out(&p)
		);
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	let st = run_repo_command(b, &["git", "status", "--porcelain", "--untracked-files=normal"])
		.map_err(|e| HostToolError { message: e.to_string() })?;
	if st.stdout.trim().is_empty() {
		return Ok(());
	}
	let add = run_repo_command(b, &["git", "add", "-A"])
		.map_err(|e| HostToolError { message: e.to_string() })?;
	if add.code != 0 {
		let msg =
			format!("refusing to {stage}: `git add -A` failed after `bun run fix`: {}", fmt_out(&add));
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	let commit = run_repo_command(b, &[
		"git",
		"-c",
		&format!("user.email={}", b.author_email),
		"-c",
		&format!("user.name={}", b.author_name),
		"commit",
		"-m",
		PRE_PR_FIX_COMMIT_SUBJECT,
	])
	.map_err(|e| HostToolError { message: e.to_string() })?;
	if commit.code != 0 {
		let msg = format!(
			"refusing to {stage}: failed to commit `bun run fix` changes: {}",
			fmt_out(&commit)
		);
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	Ok(())
}
fn pre_publish_check<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: &Value,
	tool: &str,
	stage: &str,
	skip: bool,
) -> Result<()> {
	if skip {
		audit(b, tool, av, Some(json!({"skipped":"bun_check","reason":"skip_checks=true"})), None);
		return Ok(());
	}
	if !has_bun_script(&b.workspace.repo_dir, "check") {
		return Ok(());
	}
	let p =
		match run_repo_command_with_timeout(b, PRE_PR_CHECK_COMMAND, Some(PRE_PUBLISH_BUN_TIMEOUT)) {
			Ok(p) => p,
			Err(e) => {
				let msg = format!(
					"refusing to {stage}: `bun check` is required before {stage}, but it could not be \
					 spawned: {e}"
				);
				audit(b, tool, av, None, Some(&msg));
				return err(msg);
			},
		};
	if p.code != 0 {
		let msg = format!(
			"refusing to {stage}: `bun check` failed before {stage} (exit {}).\n{}",
			p.code,
			fmt_out(&p)
		);
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	Ok(())
}

fn guarded_push<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: &Value,
	tool: &str,
	branch: &str,
) -> Result<String> {
	let workspace_branch = b.workspace_branch();
	if branch != workspace_branch {
		return err(format!(
			"refusing to push: branch={branch:?} does not match workspace branch \
			 {workspace_branch:?}."
		));
	}
	let _ = run_repo_command(b, &["git", "config", "user.email", &b.author_email]);
	let _ = run_repo_command(b, &["git", "config", "user.name", &b.author_name]);
	let head = run_repo_command(b, &["git", "rev-parse", "HEAD"])
		.map_err(|e| HostToolError { message: e.to_string() })?;
	if head.code != 0 {
		let msg = format!("git rev-parse failed: {}", fmt_out(&head));
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	let head_sha = head.stdout.trim().to_owned();
	let range = format!("origin/{}..HEAD", b.repo.default_branch);
	let ids = run_repo_command(b, &["git", "log", "--format=%H%x09%ae%x09%an", &range])
		.map_err(|e| HostToolError { message: e.to_string() })?;
	if ids.code != 0 {
		let msg = format!(
			"refusing to push: could not inspect commit authors for {range}: {}",
			fmt_out(&ids)
		);
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	let bad: Vec<String> = ids
		.stdout
		.lines()
		.filter_map(|l| {
			let p: Vec<_> = l.split('\t').collect();
			if p.len() >= 3 && (p[1] != b.author_email || p[2] != b.author_name) {
				Some(format!("{} {} <{}>", &p[0][..p[0].len().min(12)], p[2], p[1]))
			} else {
				None
			}
		})
		.collect();
	if !bad.is_empty() {
		let msg = format!(
			"refusing to push: commit author identity mismatch. Expected `{} <{}>`. Offending \
			 commits:\n  {}",
			b.author_name,
			b.author_email,
			bad.join("\n  ")
		);
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	let st = run_repo_command(b, &["git", "status", "--porcelain", "--untracked-files=normal"])
		.map_err(|e| HostToolError { message: e.to_string() })?;
	if !st.stdout.trim().is_empty() {
		let msg = format!(
			"refusing to push: working tree is dirty.\n  {}",
			st.stdout.trim().replace('\n', "\n  ")
		);
		audit(b, tool, av, None, Some(&msg));
		return err(msg);
	}
	match b.git_transport.push_branch(
		&b.repo.full_name,
		&workspace_key(&b.repo.full_name, b.issue.number as u64),
		&b.workspace.repo_dir,
		branch,
		&head_sha,
		b.slot_uid,
	) {
		Ok(r) => {
			audit(b, tool, av, Some(json!({"head":r.head,"branch":r.branch})), None);
			Ok(r.head)
		},
		Err(GitPushError::HeadDrift(_)) => {
			let msg = "refusing to push: HEAD changed between preflight and push (another commit \
			           landed; rerun the gate by re-issuing the push).";
			audit(b, tool, av, None, Some(msg));
			err(msg)
		},
		Err(e) => {
			let msg = format!("git push failed: {e}");
			audit(b, tool, av, None, Some(&msg));
			err(msg)
		},
	}
}

fn gh_post_comment<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let a = args(&av);
	let body = str_req(a, "body", "gh_post_comment")?;
	let n = a
		.get("number")
		.and_then(Value::as_i64)
		.unwrap_or_else(|| b.default_comment_number());
	let mut body2 = body.to_owned();
	let mut scheduled_close_at = None;
	if let Some(h) = should_autoclose(b, n)
		&& let Ok(s) = persona::question_autoclose_suffix(h)
	{
		body2 = format!("{}\n\n{}", body.trim_end(), s);
	}
	let c = block_on(b.github.post_comment(&b.repo.full_name, n, &body2))
		.map_err(|e| gherr("GitHub rejected comment", e))?;
	if let Some(h) = should_autoclose(b, n) {
		let close_at = iso_seconds_ago(-h * 3600.0);
		let _ = b.db.upsert_pending_closure(
			&b.issue_key(),
			&b.repo.full_name,
			n,
			c.id,
			&b.issue.author,
			&close_at,
		);
		scheduled_close_at = Some(close_at);
	}
	audit(
		b,
		"gh_post_comment",
		&av,
		Some(json!({"comment_id":c.id,"scheduled_close_at":scheduled_close_at})),
		None,
	);
	Ok(format!("comment posted: id={}", c.id))
}
fn should_autoclose<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	n: i64,
) -> Option<f64> {
	let s = b.settings.as_ref()?;
	if !s.question_autoclose_enabled
		|| s.question_autoclose_hours <= 0.0
		|| n != b.issue.number
		|| b.inbound_is_pr
	{
		return None;
	}
	let row = b.db.get_issue(&b.issue_key()).ok()??;
	if row.classification.as_deref() == Some("question")
		&& !["closed", "merged", "abandoned"].contains(&row.state.as_str())
	{
		Some(s.question_autoclose_hours)
	} else {
		None
	}
}
fn gh_push_branch<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let a = args(&av);
	let branch = a
		.get("branch")
		.and_then(Value::as_str)
		.map_or_else(|| b.workspace_branch(), str::to_owned);
	let skip = bool_arg(a, "skip_checks");
	pre_publish_fix(b, &av, "gh_push_branch", "push", skip)?;
	pre_publish_check(b, &av, "gh_push_branch", "push", skip)?;
	let head = guarded_push(b, &av, "gh_push_branch", &branch)?;
	Ok(format!(
		"pushed {branch} at {} as {} <{}>{}",
		&head[..head.len().min(12)],
		b.author_name,
		b.author_email,
		if skip {
			" (pre-push checks skipped)"
		} else {
			""
		}
	))
}
fn gh_open_pr<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let a = args(&av);
	let title = str_req(a, "title", "gh_open_pr")?;
	let body = str_req(a, "body", "gh_open_pr")?;
	for r in ["## Repro", "## Cause", "## Fix", "## Verification"] {
		if !body.contains(r) {
			return err(format!(
				"PR body missing required section header {r:?}. Follow the template in the system \
				 prompt verbatim."
			));
		}
	}
	let n = b.issue.number;
	if !["Fixes", "Closes", "Resolves", "fixes", "closes", "resolves"]
		.iter()
		.any(|kw| body.contains(&format!("{kw} #{n}")))
	{
		return err(format!(
			"PR body must include `Fixes #{n}` (or `Closes #{n}` / `Resolves #{n}`) so GitHub \
			 auto-closes the issue when the PR merges. Put it at the end of the Verification section \
			 per the template."
		));
	}
	let skip = bool_arg(a, "skip_checks");
	pre_publish_fix(b, &av, "gh_open_pr", "open PR", skip)?;
	pre_publish_check(b, &av, "gh_open_pr", "open PR", skip)?;
	let branch = b.workspace_branch();
	guarded_push(b, &av, "gh_open_pr", &branch)?;
	let base = a
		.get("base")
		.and_then(Value::as_str)
		.unwrap_or(&b.repo.default_branch);
	let pr = block_on(b.github.open_pull_request(OpenPullRequest {
		repo: &b.repo.full_name,
		head: &branch,
		base,
		title,
		body,
		draft: bool_arg(a, "draft"),
		maintainer_can_modify: true,
	}))
	.map_err(|e| gherr("GitHub rejected PR", e))?;
	let _ = b.db.set_issue_pr(&b.issue_key(), pr.number);
	let _ = b.db.set_issue_state(&b.issue_key(), "opened");
	let _ = fs::create_dir_all(&b.workspace.artifacts_dir);
	let _=fs::write(b.workspace.artifacts_dir.join("pr.json"), serde_json::to_string_pretty(&json!({"repo":pr.repo,"number":pr.number,"url":pr.html_url,"head":pr.head_ref,"base":pr.base_ref})).unwrap());
	audit(b, "gh_open_pr", &av, Some(json!({"pr_number":pr.number,"url":pr.html_url})), None);
	Ok(format!("opened #{}: {}", pr.number, pr.html_url))
}
fn gh_request_review<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let a = args(&av);
	let reviewers = str_array_req(a.get("reviewers"), "reviewers", "gh_request_review")?;
	let assignees = str_array_req(a.get("assignees"), "assignees", "gh_request_review")?;
	let pr = b
		.db
		.get_issue(&b.issue_key())
		.ok()
		.flatten()
		.and_then(|r| r.pr_number)
		.ok_or_else(|| HostToolError {
			message: "no PR recorded for this issue yet; call gh_open_pr first.".into(),
		})?;
	if !reviewers.is_empty() {
		block_on(
			b.github
				.request_reviewers(&b.repo.full_name, pr, &reviewers, &[]),
		)
		.map_err(|e| gherr("GitHub rejected review request", e))?;
	}
	if !assignees.is_empty() {
		block_on(b.github.add_assignees(&b.repo.full_name, pr, &assignees))
			.map_err(|e| gherr("GitHub rejected review request", e))?;
	}
	audit(b, "gh_request_review", &av, Some(json!({"pr":pr})), None);
	Ok(format!("updated review/assignees on #{pr}"))
}
fn str_array(v: Option<&Value>) -> Vec<String> {
	v.and_then(Value::as_array)
		.map(|xs| {
			xs.iter()
				.filter_map(Value::as_str)
				.map(str::trim)
				.filter(|s| !s.is_empty())
				.map(str::to_owned)
				.collect()
		})
		.unwrap_or_default()
}
fn str_array_req(v: Option<&Value>, key: &str, tool: &str) -> Result<Vec<String>> {
	match v {
		None => Ok(vec![]),
		Some(Value::Array(_)) => Ok(str_array(v)),
		Some(_) => err(format!("{tool} '{key}' must be an array of strings.")),
	}
}
fn repro_record<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let a = args(&av);
	let title = str_req(a, "title", "repro_record")?;
	let command = str_req(a, "command", "repro_record")?;
	let output = a
		.get("output")
		.and_then(Value::as_str)
		.ok_or_else(|| HostToolError {
			message: "repro_record requires 'output' (may be empty string).".into(),
		})?;
	let exit = a
		.get("exit_code")
		.and_then(Value::as_i64)
		.ok_or_else(|| HostToolError {
			message: "repro_record requires an integer 'exit_code'.".into(),
		})?;
	fs::create_dir_all(b.workspace.repro_dir())
		.map_err(|e| HostToolError { message: e.to_string() })?;
	let slug = title
		.to_lowercase()
		.chars()
		.map(|c| if c.is_alphanumeric() { c } else { '-' })
		.collect::<String>()
		.trim_matches('-')
		.chars()
		.take(48)
		.collect::<String>();
	let ts = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap()
		.as_secs();
	let target = b.workspace.repro_dir().join(format!(
		"{}-{}.md",
		ts,
		if slug.is_empty() { "repro" } else { &slug }
	));
	fs::write(
		&target,
		format!(
			"# {title}\n\n- exit_code: {exit}\n- command:\n\n```\n{command}\n```\n\n## \
			 Output\n\n```\n{output}\n```\n"
		),
	)
	.map_err(|e| HostToolError { message: e.to_string() })?;
	#[cfg(unix)]
	if slot_permissions_active(b.slot_uid)
		&& let Some(uid) = b.slot_uid
	{
		// SAFETY: `target` was just created by this process, the CString is NUL-free
		// and lives for the duration of the call, and slot uid ownership is only
		// adjusted when slot permissions are active on Unix.
		unsafe {
			libc::chown(
				std::ffi::CString::new(target.to_string_lossy().as_bytes())
					.unwrap()
					.as_ptr(),
				uid,
				uid,
			);
		}
	}
	audit(
		b,
		"repro_record",
		&av,
		Some(
			json!({"path":target.strip_prefix(&b.workspace.root).unwrap_or(&target).to_string_lossy()}),
		),
		None,
	);
	Ok("recorded".into())
}
fn mark_unable<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let a = args(&av);
	let diagnosis = str_req(a, "diagnosis", "mark_unable_to_reproduce")?;
	let needed = str_req(a, "info_needed", "mark_unable_to_reproduce")?;
	let body = persona::unable_to_reproduce_comment(diagnosis, needed).unwrap_or_else(|_| {
		format!("Unable to reproduce.\n\nDiagnosis: {diagnosis}\n\nNeeded: {needed}")
	});
	let c = block_on(
		b.github
			.post_comment(&b.repo.full_name, b.issue.number, &body),
	)
	.map_err(|e| gherr("GitHub rejected comment", e))?;
	let _ = b.db.set_issue_state(&b.issue_key(), "abandoned");
	audit(b, "mark_unable_to_reproduce", &av, Some(json!({"comment_id":c.id})), None);
	Ok(format!("posted abandonment comment id={}", c.id))
}
fn abort_task<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let reason = str_req(args(&av), "reason", "abort_task")?
		.trim()
		.to_owned();
	audit(b, "abort_task", &av, Some(json!({"reason":reason})), None);
	let _ = b.db.set_issue_state(&b.issue_key(), "abandoned");
	if let Some(c) = &b.abort {
		c.signal(&reason);
	}
	Ok("aborted".into())
}
fn fetch_issue_thread<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let issue = block_on(b.github.get_issue(&b.repo.full_name, b.issue.number))
		.map_err(|e| gherr("GitHub fetch failed", e))?;
	let comments = block_on(b.github.list_comments(&b.repo.full_name, b.issue.number))
		.map_err(|e| gherr("GitHub fetch failed", e))?;
	let mut lines = vec![
		format!("# {}#{} ({})", issue.repo, issue.number, issue.state),
		format!("title: {}", issue.title),
		format!("author: @{}", issue.author),
		format!(
			"labels: {}",
			if issue.labels.is_empty() {
				"(none)".into()
			} else {
				issue.labels.join(", ")
			}
		),
		String::new(),
		"## Body".into(),
		if issue.body.trim().is_empty() {
			"(empty)".into()
		} else {
			issue.body.trim().into()
		},
		String::new(),
		format!("## Comments ({})", comments.len()),
	];
	for c in &comments {
		lines.extend([
			String::new(),
			format!("### @{} at {}", c.author, c.created_at),
			c.body.trim().into(),
		]);
	}
	audit(b, "fetch_issue_thread", &av, Some(json!({"comments":comments.len()})), None);
	Ok(lines.join("\n"))
}
const PRIMARY_TYPES: &[&str] =
	&["bug", "enhancement", "question", "proposal", "documentation", "invalid", "duplicate"];
const PRIORITIES: &[&str] = &["prio:p0", "prio:p1", "prio:p2", "prio:p3"];
const FUNCTIONAL: &[&str] =
	&["agent", "tool", "tui", "cli", "prompting", "sdk", "auth", "setup", "ux", "providers"];
const PLATFORMS: &[&str] =
	&["platform:linux", "platform:macos", "platform:windows", "platform:wsl"];
fn set_issue_labels<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	if b.inbound_is_pr {
		audit(b, "set_issue_labels", &av, Some(json!({"skipped":"pr_thread"})), None);
		return Ok("no-op: set_issue_labels is not applicable on PR threads — PR labels are not \
		           used for triage. Proceed with the requested change."
			.into());
	}
	let a = args(&av);
	let labels = str_array(a.get("labels"));
	if labels.is_empty() {
		return err(
			"set_issue_labels requires a non-empty 'labels' array with at least one non-whitespace \
			 label.",
		);
	}
	let n = a
		.get("number")
		.and_then(Value::as_i64)
		.unwrap_or(b.issue.number);
	let applied = block_on(b.github.add_issue_labels(&b.repo.full_name, n, &labels))
		.map_err(|e| gherr("GitHub rejected labels", e))?;
	audit(b, "set_issue_labels", &av, Some(json!({"labels":applied})), None);
	Ok(format!("labels now: {}", applied.join(", ")))
}
fn classify_issue<G: GitHubBackend + ?Sized, T: GitTransport + ?Sized>(
	b: &ToolBindings<G, T>,
	av: Value,
) -> Result<String> {
	let a = args(&av);
	let existing = b.db.get_issue(&b.issue_key()).ok().flatten();
	if b.inbound_is_pr {
		audit(b, "classify_issue", &av, Some(json!({"skipped":"pr_thread"})), None);
		return Ok("no-op: classify_issue is not applicable on PR threads. Proceed with the \
		           requested change (amend the branch and push, or post a comment)."
			.into());
	}
	if existing
		.as_ref()
		.and_then(|r| r.classification.as_ref())
		.is_some()
	{
		audit(b, "classify_issue", &av, Some(json!({"skipped":"already_classified"})), None);
		return Ok(format!(
			"no-op: issue #{} is already classified as {:?}. Continue with that workflow; do not \
			 re-classify.",
			b.issue.number,
			existing.unwrap().classification.unwrap()
		));
	}
	let primary = a
		.get("primary")
		.and_then(Value::as_str)
		.ok_or_else(|| HostToolError { message: "classify_issue 'primary' is required.".into() })?;
	if !PRIMARY_TYPES.contains(&primary) {
		let msg =
			format!("classify_issue 'primary' must be one of {PRIMARY_TYPES:?}; got {primary:?}.");
		audit(b, "classify_issue", &av, None, Some(&msg));
		return err(msg);
	}
	let rationale = str_req(a, "rationale", "classify_issue")?;
	let mut priority = a.get("priority").and_then(Value::as_str);
	if primary == "bug" && !priority.is_some_and(|p| PRIORITIES.contains(&p)) {
		let msg =
			format!("classify_issue requires 'priority' in {PRIORITIES:?} when primary=='bug'.");
		audit(b, "classify_issue", &av, None, Some(&msg));
		return err(msg);
	}
	if primary != "bug" {
		priority = None;
	}
	let mut labels = vec![primary.to_owned()];
	if let Some(p) = priority {
		labels.push(p.into());
	}
	for f in str_array(a.get("functional")) {
		if FUNCTIONAL.contains(&f.as_str()) {
			labels.push(f);
		}
	}
	if let Some(p) = a
		.get("provider")
		.and_then(Value::as_str)
		.filter(|p| p.starts_with("provider:"))
	{
		labels.push("providers".into());
		labels.push(p.into());
	}
	if let Some(p) = a
		.get("platform")
		.and_then(Value::as_str)
		.filter(|p| PLATFORMS.contains(p))
	{
		labels.push(p.into());
	}
	labels.push("triaged".into());
	let renamed = if let Some(slug) = a
		.get("branch_slug")
		.and_then(Value::as_str)
		.filter(|s| !s.trim().is_empty())
	{
		let valid = validate_branch_slug(slug).map_err(|e| HostToolError {
			message: format!("classify_issue rejected branch_slug: {e}"),
		})?;
		let mut ws = b.workspace.clone();
		ws.branch = b.workspace_branch();
		let r = rename_workspace_branch(
			&mut ws,
			valid,
			existing
				.as_ref()
				.and_then(|x| x.pr_number)
				.map(|x| x as u64),
			b.slot_uid,
			&crate::git_ops::RealCommandRunner,
		)
		.map_err(|e| HostToolError {
			message: format!("classify_issue could not rename branch: {e}"),
		})?;
		let _ = b.db.set_issue_branch(&b.issue_key(), &r);
		b.set_workspace_branch(r.clone());
		Some(r)
	} else {
		None
	};
	let applied = block_on(
		b.github
			.add_issue_labels(&b.repo.full_name, b.issue.number, &labels),
	)
	.map_err(|e| gherr("GitHub rejected labels", e))?;
	let _ = b.db.set_issue_classification(&b.issue_key(), primary);
	audit(
		b,
		"classify_issue",
		&av,
		Some(json!({"primary":primary,"labels":applied,"rationale":rationale,"branch":renamed})),
		None,
	);
	let next = persona::classify_next_step(primary).unwrap_or_default();
	Ok(format!(
		"classified as {primary}; labels applied: {}.{} Next: {next}.",
		applied.join(", "),
		renamed
			.as_ref()
			.map(|r| format!(" Branch renamed to `{r}`."))
			.unwrap_or_default()
	))
}

#[cfg(test)]
mod tests {
	use std::{future::Future, pin::Pin};

	use rusqlite::Connection;
	use tempfile::TempDir;

	use super::*;
	use crate::github::{
		CommentInfo, IssueSummary, PullRequestInfo, PullRequestReviewInfo, ReactionInfo,
		ReviewCommentInfo,
	};
	#[derive(Default)]
	struct FakeGh {
		posted_bodies: Mutex<Vec<String>>,
	}
	macro_rules! fut {
		($e:expr) => {
			Box::pin(async move { $e })
		};
	}
	impl GitHubBackend for FakeGh {
		fn get_repo<'a>(
			&'a self,
			_: &'a str,
		) -> Pin<Box<dyn Future<Output = std::result::Result<RepoInfo, GitHubError>> + Send + 'a>> {
			fut!(unimplemented!())
		}

		fn get_issue<'a>(
			&'a self,
			repo: &'a str,
			number: i64,
		) -> Pin<Box<dyn Future<Output = std::result::Result<IssueInfo, GitHubError>> + Send + 'a>>
		{
			fut!(Ok(IssueInfo {
				repo: repo.into(),
				number,
				title: "bug".into(),
				author: "alice".into(),
				body: "body".into(),
				labels: vec!["bug".into()],
				state: "open".into(),
				is_pull_request: false
			}))
		}

		fn list_closing_pull_requests<'a>(
			&'a self,
			_: &'a str,
			_: i64,
		) -> Pin<Box<dyn Future<Output = std::result::Result<Vec<i64>, GitHubError>> + Send + 'a>> {
			fut!(Ok(vec![]))
		}

		fn get_pull_request<'a>(
			&'a self,
			_: &'a str,
			_: i64,
		) -> Pin<
			Box<dyn Future<Output = std::result::Result<PullRequestInfo, GitHubError>> + Send + 'a>,
		> {
			fut!(unimplemented!())
		}

		fn list_issues<'a>(
			&'a self,
			_: &'a str,
			_: &'a str,
			_: i64,
		) -> Pin<
			Box<dyn Future<Output = std::result::Result<Vec<IssueSummary>, GitHubError>> + Send + 'a>,
		> {
			fut!(Ok(vec![]))
		}

		fn list_comments<'a>(
			&'a self,
			_: &'a str,
			_: i64,
		) -> Pin<
			Box<dyn Future<Output = std::result::Result<Vec<CommentInfo>, GitHubError>> + Send + 'a>,
		> {
			fut!(Ok(vec![CommentInfo {
				id:         1,
				author:     "bob".into(),
				body:       "still broken".into(),
				created_at: "now".into(),
			}]))
		}

		fn list_review_comments<'a>(
			&'a self,
			_: &'a str,
			_: i64,
		) -> Pin<
			Box<
				dyn Future<Output = std::result::Result<Vec<ReviewCommentInfo>, GitHubError>>
					+ Send
					+ 'a,
			>,
		> {
			fut!(Ok(vec![]))
		}

		fn list_pr_reviews<'a>(
			&'a self,
			_: &'a str,
			_: i64,
		) -> Pin<
			Box<
				dyn Future<Output = std::result::Result<Vec<PullRequestReviewInfo>, GitHubError>>
					+ Send
					+ 'a,
			>,
		> {
			fut!(Ok(vec![]))
		}

		fn get_authenticated_login<'a>(
			&'a self,
		) -> Pin<Box<dyn Future<Output = std::result::Result<String, GitHubError>> + Send + 'a>> {
			fut!(Ok("bot".into()))
		}

		fn post_comment<'a>(
			&'a self,
			_: &'a str,
			_: i64,
			body: &'a str,
		) -> Pin<Box<dyn Future<Output = std::result::Result<CommentInfo, GitHubError>> + Send + 'a>>
		{
			self.posted_bodies.lock().unwrap().push(body.to_owned());
			fut!(Ok(CommentInfo {
				id:         42,
				author:     "bot".into(),
				body:       body.into(),
				created_at: "now".into(),
			}))
		}

		fn open_pull_request<'a>(
			&'a self,
			_: OpenPullRequest<'a>,
		) -> Pin<
			Box<dyn Future<Output = std::result::Result<PullRequestInfo, GitHubError>> + Send + 'a>,
		> {
			fut!(Ok(PullRequestInfo {
				repo:      "octo/widget".into(),
				number:    7,
				html_url:  "https://x/pr/7".into(),
				head_ref:  "b".into(),
				base_ref:  "main".into(),
				state:     "open".into(),
				author:    "bot".into(),
				head_repo: "octo/widget".into(),
			}))
		}

		fn request_reviewers<'a>(
			&'a self,
			_: &'a str,
			_: i64,
			_: &'a [String],
			_: &'a [String],
		) -> Pin<Box<dyn Future<Output = std::result::Result<(), GitHubError>> + Send + 'a>> {
			fut!(Ok(()))
		}

		fn add_issue_labels<'a>(
			&'a self,
			_: &'a str,
			_: i64,
			labels: &'a [String],
		) -> Pin<Box<dyn Future<Output = std::result::Result<Vec<String>, GitHubError>> + Send + 'a>>
		{
			fut!(Ok(labels.to_vec()))
		}

		fn add_assignees<'a>(
			&'a self,
			_: &'a str,
			_: i64,
			_: &'a [String],
		) -> Pin<Box<dyn Future<Output = std::result::Result<(), GitHubError>> + Send + 'a>> {
			fut!(Ok(()))
		}

		fn list_comment_reactions<'a>(
			&'a self,
			_: &'a str,
			_: i64,
		) -> Pin<
			Box<dyn Future<Output = std::result::Result<Vec<ReactionInfo>, GitHubError>> + Send + 'a>,
		> {
			fut!(Ok(vec![]))
		}

		fn close_issue<'a>(
			&'a self,
			_: &'a str,
			_: i64,
			_: &'a str,
		) -> Pin<Box<dyn Future<Output = std::result::Result<(), GitHubError>> + Send + 'a>> {
			fut!(Ok(()))
		}
	}
	#[derive(Default)]
	struct FakeGit;
	impl GitTransport for FakeGit {
		fn clone_pool(
			&self,
			_: &str,
			_: &str,
			_: &str,
			_: &Path,
		) -> std::result::Result<(), crate::git_ops::GitCommandError> {
			Ok(())
		}

		fn fetch_pool(
			&self,
			_: &str,
			_: &Path,
		) -> std::result::Result<(), crate::git_ops::GitCommandError> {
			Ok(())
		}

		fn fetch_base_ref(
			&self,
			_: &str,
			_: &Path,
			_: &str,
		) -> std::result::Result<(), crate::git_ops::GitCommandError> {
			Ok(())
		}

		fn push_branch(
			&self,
			_: &str,
			_: &str,
			_: &Path,
			branch: &str,
			expected_head: &str,
			_: Option<u32>,
		) -> std::result::Result<crate::git_ops::PushResult, GitPushError> {
			Ok(crate::git_ops::PushResult { branch: branch.into(), head: expected_head.into() })
		}
	}
	fn test_settings(root: &Path) -> Settings {
		Settings {
			github_token: Some(crate::config::SecretString::new("token")),
			github_webhook_secret: crate::config::SecretString::new("secret"),
			bot_login: "bot".into(),
			git_author_name: Some("gjc-bot".into()),
			git_author_email: "bot@example.com".into(),
			repo_allowlist_raw: "octo/widget".into(),
			gh_proxy_url: None,
			gh_proxy_hmac_key: None,
			gh_proxy_bind_host: "127.0.0.1".into(),
			gh_proxy_bind_port: 8081,
			gh_proxy_max_body_bytes: 1_048_576,
			gh_proxy_git_timeout_seconds: 60.0,
			model: "test".into(),
			provider: None,
			thinking_level: "off".into(),
			max_concurrency: 1,
			task_timeout_seconds: 60.0,
			task_timeout_hard_grace_seconds: 5.0,
			request_timeout_seconds: 30.0,
			task_completion_max_reminders: 1,
			gjc_command: "gjc".into(),
			shutdown_drain_timeout_seconds: 1.0,
			shutdown_kill_timeout_seconds: 1.0,
			workspace_root: root.join("workspaces"),
			sqlite_path: root.join("db.sqlite"),
			log_dir: root.join("logs"),
			bind_host: "127.0.0.1".into(),
			bind_port: 8080,
			replay_token: None,
			rate_limit_window_seconds: 3600.0,
			rate_limit_default: 3,
			rate_limit_contributor: 10,
			rate_limit_unlimited_raw: String::new(),
			maintainer_logins_raw: String::new(),
			reviewer_bots_raw: String::new(),
			question_autoclose_enabled: true,
			question_autoclose_hours: 2.0,
			question_autoclose_scan_seconds: 60.0,
			natives_cache_enabled: false,
			natives_cache_root: root.join("natives"),
			natives_cache_max_entries_per_repo: 8,
			natives_cache_max_bytes: 1024,
			natives_cache_gc_interval_seconds: 3600.0,
		}
	}
	fn bindings(td: &TempDir) -> ToolBindings<FakeGh, FakeGit> {
		let db = Arc::new(Database::open(td.path().join("db.sqlite")).unwrap());
		db.upsert_issue("octo/widget#1", "octo/widget", 1, "reproducing", Some("farm/x"), None, None)
			.unwrap();
		let root = td.path().join("ws");
		fs::create_dir_all(root.join("repo")).unwrap();
		ToolBindings {
			db,
			github: Arc::new(FakeGh::default()),
			git_transport: Arc::new(FakeGit),
			repo: RepoInfo {
				full_name:      "octo/widget".into(),
				default_branch: "main".into(),
				clone_url:      String::new(),
				private:        false,
			},
			issue: IssueInfo {
				repo:            "octo/widget".into(),
				number:          1,
				title:           "t".into(),
				author:          "alice".into(),
				body:            "b".into(),
				labels:          vec![],
				state:           "open".into(),
				is_pull_request: false,
			},
			workspace: Workspace {
				root:           root.clone(),
				repo_dir:       root.join("repo"),
				session_dir:    root.join("session"),
				context_dir:    root.join("context"),
				artifacts_dir:  root.join("artifacts"),
				branch:         "farm/x".into(),
				repo_full_name: "octo/widget".into(),
				issue_number:   1,
			},
			workspace_branch: Arc::new(RwLock::new("farm/x".into())),
			author_name: "gjc-bot".into(),
			author_email: "bot@example.com".into(),
			settings: None,
			inbound_thread_number: None,
			inbound_is_pr: false,
			slot_uid: None,
			abort: None,
		}
	}
	fn fake_out(code: i32, stdout: &str, stderr: &str) -> ProcOut {
		ProcOut { code, stdout: stdout.into(), stderr: stderr.into() }
	}
	fn set_fake_commands(commands: Vec<(&[&str], ProcOut)>) {
		FAKE_REPO_COMMANDS.with(|slot| {
			let mut slot = slot.borrow_mut();
			slot.clear();
			slot.extend(
				commands
					.into_iter()
					.map(|(cmd, out)| (cmd.iter().map(|s| (*s).to_owned()).collect(), out)),
			);
		});
	}
	fn tool_call_rows(db: &Database, tool: &str) -> Vec<(Option<String>, Option<String>)> {
		let conn = Connection::open(db.path()).unwrap();
		let mut stmt = conn
			.prepare("SELECT result_json, error FROM tool_calls WHERE tool = ? ORDER BY id")
			.unwrap();
		stmt
			.query_map([tool], |row| Ok((row.get(0)?, row.get(1)?)))
			.unwrap()
			.map(|r| r.unwrap())
			.collect()
	}
	fn valid_pr_body() -> String {
		"## Repro\nsteps\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nchecked\n\nFixes #1"
			.into()
	}
	#[test]
	fn descriptors_match_app_server_contract_fields() {
		let ds = descriptors();
		assert_eq!(ds.len(), 10);
		let v = serde_json::to_value(&ds[0]).unwrap();
		assert!(
			v.get("name").is_some()
				&& v.get("description").is_some()
				&& v.get("inputSchema").is_some()
				&& v.get("resultPolicy").is_some()
				&& v.get("redactionHints").is_some()
		);
		let fixture: Value = serde_json::from_str(include_str!(
			"../tests/fixtures/phase5/host-tool-descriptors.snapshot.json"
		))
		.unwrap();
		let fixture_names: Vec<String> = fixture
			.as_array()
			.unwrap()
			.iter()
			.map(|v| v["name"].as_str().unwrap().to_owned())
			.collect();
		let descriptor_names: Vec<String> = ds.iter().map(|d| d.name.clone()).collect();
		assert_eq!(fixture_names, descriptor_names);
	}
	#[test]
	fn host_tool_closure_redacts_comment_result() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		let tools = build(Some(&b));
		let t = tools
			.iter()
			.find(|t| t.descriptor.name == "gh_post_comment")
			.unwrap();
		let r = t.call(&b, json!({"body":"hello token ghp_secret"}));
		assert!(r.ok);
		assert!(r.text.contains("comment posted"));
		assert!(!r.text.contains("ghp_secret"));
	}
	#[test]
	fn abort_task_signals_controller_once() {
		let c = AbortController::new();
		let seen = Arc::new(Mutex::new(0));
		let s = seen.clone();
		c.set_stop(move || *s.lock().unwrap() += 1);
		c.signal("bad");
		c.signal("worse");
		assert!(c.triggered());
		assert_eq!(c.reason(), "bad");
		assert_eq!(*seen.lock().unwrap(), 1);
	}
	#[test]
	fn repro_record_writes_transcript() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		let tools = build(Some(&b));
		let t = tools
			.iter()
			.find(|t| t.descriptor.name == "repro_record")
			.unwrap();
		let r = t
			.call(&b, json!({"title":"Bad Thing","command":"bun test","output":"boom","exit_code":1}));
		assert!(r.ok);
		assert!(
			fs::read_dir(b.workspace.repro_dir())
				.unwrap()
				.next()
				.is_some()
		);
	}
	#[test]
	fn classify_requires_bug_priority() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "classify_issue")
			.unwrap();
		let r = t.call(&b, json!({"primary":"bug","rationale":"because"}));
		assert!(!r.ok);
		assert!(r.text.contains("priority"));
	}
	#[test]
	fn phase5_tool_name_fixture_matches_descriptors() {
		let fixture: Value = serde_json::from_str(include_str!(
			"../tests/fixtures/phase5/host-tool-names.snapshot.json"
		))
		.unwrap();
		let names: Vec<String> = descriptors().into_iter().map(|d| d.name).collect();
		assert_eq!(fixture["tools"], json!(names));
		assert_eq!(fixture["count"], json!(names.len()));
	}

	#[test]
	fn gh_post_comment_schedules_autoclose_for_question() {
		let td = TempDir::new().unwrap();
		let mut b = bindings(&td);
		b.settings = Some(test_settings(td.path()));
		b.db
			.set_issue_classification(&b.issue_key(), "question")
			.unwrap();
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_post_comment")
			.unwrap();
		let r = t.call(&b, json!({"body":"answer"}));
		assert!(r.ok, "{}", r.text);
		let row = b.db.get_pending_closure(&b.issue_key()).unwrap().unwrap();
		assert_eq!(row.comment_id, 42);
		assert_eq!(row.state, "pending");
		assert_eq!(row.issue_author, "alice");
		assert!(row.close_at.contains('T'));
		let body = b
			.github
			.posted_bodies
			.lock()
			.unwrap()
			.last()
			.unwrap()
			.clone();
		assert!(body.starts_with("answer\n\n"));
		assert!(body.contains("auto-close"));
		let rows = tool_call_rows(&b.db, "gh_post_comment");
		let result = rows.last().unwrap().0.as_deref().unwrap();
		assert!(result.contains("scheduled_close_at"));
		assert!(!result.contains("\"scheduled_close_at\":null"));
	}

	#[test]
	fn labels_trim_and_reject_whitespace_only() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "set_issue_labels")
			.unwrap();
		let r = t.call(&b, json!({"labels":["  "," bug "]}));
		assert!(r.ok, "{}", r.text);
		assert!(r.text.contains("bug"));
		assert!(!r.text.contains("  "));
		let r = t.call(&b, json!({"labels":["  ", "\t"]}));
		assert!(!r.ok);
	}

	#[test]
	fn gh_request_review_rejects_non_array_reviewers_and_assignees() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		b.db.set_issue_pr(&b.issue_key(), 7).unwrap();
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_request_review")
			.unwrap();
		let r = t.call(&b, json!({"reviewers":"alice"}));
		assert!(!r.ok);
		assert!(r.text.contains("reviewers"));
		let r = t.call(&b, json!({"assignees":"alice"}));
		assert!(!r.ok);
		assert!(r.text.contains("assignees"));
	}
	#[test]
	fn gh_push_branch_dirty_tree_pre_fix_gate_blocks_push() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		fs::write(b.workspace.repo_dir.join("package.json"), r#"{"scripts":{"fix":"true"}}"#)
			.unwrap();
		set_fake_commands(vec![(
			&["git", "status", "--porcelain", "--untracked-files=normal"],
			fake_out(0, " M src/lib.rs\n", ""),
		)]);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_push_branch")
			.unwrap();
		let r = t.call(&b, json!({}));
		assert!(!r.ok);
		assert!(r.text.contains("dirty worktree before `bun run fix`"));
		assert!(
			tool_call_rows(&b.db, "gh_push_branch")
				.last()
				.unwrap()
				.1
				.as_deref()
				.unwrap()
				.contains("dirty worktree")
		);
	}

	#[test]
	fn gh_open_pr_dirty_tree_gate_blocks_pr() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		set_fake_commands(vec![
			(&["git", "config", "user.email", "bot@example.com"], fake_out(0, "", "")),
			(&["git", "config", "user.name", "gjc-bot"], fake_out(0, "", "")),
			(&["git", "rev-parse", "HEAD"], fake_out(0, "abc123\n", "")),
			(&["git", "log", "--format=%H%x09%ae%x09%an", "origin/main..HEAD"], fake_out(0, "", "")),
			(
				&["git", "status", "--porcelain", "--untracked-files=normal"],
				fake_out(0, "?? scratch\n", ""),
			),
		]);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_open_pr")
			.unwrap();
		let r = t.call(&b, json!({"title":"Fix","body":valid_pr_body()}));
		assert!(!r.ok);
		assert!(r.text.contains("working tree is dirty"));
		assert!(
			tool_call_rows(&b.db, "gh_open_pr")
				.last()
				.unwrap()
				.1
				.as_deref()
				.unwrap()
				.contains("working tree is dirty")
		);
	}

	#[test]
	fn gh_push_branch_commit_author_scan_gate_rejects_wrong_identity() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		set_fake_commands(vec![
			(&["git", "config", "user.email", "bot@example.com"], fake_out(0, "", "")),
			(&["git", "config", "user.name", "gjc-bot"], fake_out(0, "", "")),
			(&["git", "rev-parse", "HEAD"], fake_out(0, "abc123\n", "")),
			(
				&["git", "log", "--format=%H%x09%ae%x09%an", "origin/main..HEAD"],
				fake_out(0, "deadbeef\tevil@example.com\tMallory\n", ""),
			),
		]);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_push_branch")
			.unwrap();
		let r = t.call(&b, json!({}));
		assert!(!r.ok);
		assert!(r.text.contains("commit author identity mismatch"));
		assert!(r.text.contains("Mallory <evil@example.com>"));
	}

	#[test]
	fn gh_push_branch_bun_check_failure_blocks_with_audit_row() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		fs::write(b.workspace.repo_dir.join("package.json"), r#"{"scripts":{"check":"bun test"}}"#)
			.unwrap();
		set_fake_commands(vec![(&["bun", "check"], fake_out(2, "", "type error"))]);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_push_branch")
			.unwrap();
		let r = t.call(&b, json!({}));
		assert!(!r.ok);
		assert!(r.text.contains("`bun check` failed"));
		assert!(
			tool_call_rows(&b.db, "gh_push_branch")
				.last()
				.unwrap()
				.1
				.as_deref()
				.unwrap()
				.contains("type error")
		);
	}

	#[test]
	fn gh_push_branch_bun_fix_timeout_path_is_audited_without_sleeping() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		fs::write(b.workspace.repo_dir.join("package.json"), r#"{"scripts":{"fix":"bun fmt"}}"#)
			.unwrap();
		set_fake_commands(vec![
			(&["git", "status", "--porcelain", "--untracked-files=normal"], fake_out(0, "", "")),
			(&["bun", "run", "fix"], fake_out(124, "", "command timed out after 600s: bun run fix")),
		]);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_push_branch")
			.unwrap();
		let r = t.call(&b, json!({}));
		assert!(!r.ok);
		assert!(r.text.contains("`bun run fix` failed"));
		assert!(
			tool_call_rows(&b.db, "gh_push_branch")
				.last()
				.unwrap()
				.1
				.as_deref()
				.unwrap()
				.contains("timed out")
		);
	}

	#[test]
	fn gh_push_branch_skip_checks_audit_row_recorded() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		set_fake_commands(vec![
			(&["git", "config", "user.email", "bot@example.com"], fake_out(0, "", "")),
			(&["git", "config", "user.name", "gjc-bot"], fake_out(0, "", "")),
			(&["git", "rev-parse", "HEAD"], fake_out(0, "abc123\n", "")),
			(&["git", "log", "--format=%H%x09%ae%x09%an", "origin/main..HEAD"], fake_out(0, "", "")),
			(&["git", "status", "--porcelain", "--untracked-files=normal"], fake_out(0, "", "")),
		]);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_push_branch")
			.unwrap();
		let r = t.call(&b, json!({"skip_checks":true}));
		assert!(r.ok, "{}", r.text);
		assert!(
			tool_call_rows(&b.db, "gh_push_branch")
				.iter()
				.any(|(result, _)| result.as_deref().unwrap_or("").contains("bun_check"))
		);
	}

	#[test]
	fn gh_open_pr_template_validation_rejects_missing_sections_and_close_keyword() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "gh_open_pr")
			.unwrap();
		let r = t.call(&b, json!({"title":"Fix","body":"## Repro\nonly"}));
		assert!(!r.ok);
		assert!(r.text.contains("missing required section"));
		let body = "## Repro\nsteps\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nchecked";
		let r = t.call(&b, json!({"title":"Fix","body":body}));
		assert!(!r.ok);
		assert!(r.text.contains("must include `Fixes #1`"));
	}

	#[test]
	fn classify_issue_branch_slug_updates_live_binding_branch() {
		let td = TempDir::new().unwrap();
		let b = bindings(&td);
		b.set_workspace_branch("farm/x/old".into());
		b.db.set_issue_branch(&b.issue_key(), "farm/x/old").unwrap();
		let repo = &b.workspace.repo_dir;
		let init = |args: &[&str]| {
			let out = Command::new("git")
				.args(args)
				.current_dir(repo)
				.output()
				.unwrap();
			assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
		};
		init(&["init", "-b", "main"]);
		fs::write(repo.join("README.md"), "x").unwrap();
		init(&["add", "README.md"]);
		init(&[
			"-c",
			"user.email=bot@example.com",
			"-c",
			"user.name=gjc-bot",
			"commit",
			"-m",
			"init",
		]);
		init(&["checkout", "-b", "farm/x/old"]);
		let t = build(Some(&b))
			.into_iter()
			.find(|t| t.descriptor.name == "classify_issue")
			.unwrap();
		let r = t.call(
			&b,
			json!({"primary":"question","rationale":"answerable","branch_slug":"new-topic"}),
		);
		assert!(r.ok, "{}", r.text);
		assert_eq!(b.workspace_branch(), "farm/x/new-topic");
		assert_eq!(
			b.db
				.get_issue(&b.issue_key())
				.unwrap()
				.unwrap()
				.branch
				.as_deref(),
			Some("farm/x/new-topic")
		);
	}
}
