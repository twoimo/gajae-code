use std::{
	cell::RefCell,
	fs,
	path::{Path, PathBuf},
	time::Duration,
};

use robogjc::{
	git_ops::{self, CommandOutput, CommandRunner, CommandSpec, GitRunOptions},
	sandbox::{self, SandboxManager, Workspace},
	workspace_keys,
};

fn git(args: &[&str], cwd: &Path) {
	let out = std::process::Command::new("git")
		.args(args)
		.current_dir(cwd)
		.output()
		.unwrap();
	assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
}
fn seed_remote(tmp: &Path) -> PathBuf {
	let repo = tmp.join("upstream");
	fs::create_dir(&repo).unwrap();
	git(&["init", "--initial-branch", "main"], &repo);
	git(&["config", "user.email", "bot@example.com"], &repo);
	git(&["config", "user.name", "Bot"], &repo);
	fs::write(repo.join("README.md"), "hello\n").unwrap();
	git(&["add", "README.md"], &repo);
	git(&["commit", "-m", "init"], &repo);
	repo
}
fn head(repo: &Path) -> String {
	let out = std::process::Command::new("git")
		.args(["rev-parse", "HEAD"])
		.current_dir(repo)
		.output()
		.unwrap();
	String::from_utf8(out.stdout).unwrap().trim().to_string()
}

#[derive(Default)]
struct RecordingRunner {
	specs:   RefCell<Vec<CommandSpec>>,
	outputs: RefCell<Vec<CommandOutput>>,
}
impl CommandRunner for RecordingRunner {
	fn run(&self, spec: &CommandSpec) -> Result<CommandOutput, robogjc::git_ops::GitCommandError> {
		self.specs.borrow_mut().push(spec.clone());
		Ok(self.outputs.borrow_mut().pop().unwrap_or(CommandOutput {
			status: 0,
			stdout: String::new(),
			stderr: String::new(),
		}))
	}
}

#[test]
fn command_runner_records_safe_directory_identity_timeout_and_token() {
	let runner = RecordingRunner::default();
	let repo = PathBuf::from("/tmp/work/repo");
	git_ops::run_git_with(&runner, &["status"], Some(&repo), GitRunOptions {
		token: Some("secret".into()),
		safe_directory: Some(repo.clone()),
		user: Some(2001),
		group: Some(2001),
		extra_groups: vec![2000],
		umask: Some(0o002),
		timeout: Some(Duration::from_secs(7)),
		..Default::default()
	})
	.unwrap();
	let spec = &runner.specs.borrow()[0];
	assert_eq!(spec.program, "git");
	assert_eq!(spec.args[0], "--config-env");
	assert_eq!(spec.env.get("GIT_TERMINAL_PROMPT").unwrap(), "0");
	assert_eq!(spec.env.get("GIT_CONFIG_KEY_0").unwrap(), "safe.directory");
	assert_eq!(spec.env.get("GIT_CONFIG_VALUE_0").unwrap(), "/tmp/work/repo");
	assert_eq!(spec.user, Some(2001));
	assert_eq!(spec.group, Some(2001));
	assert_eq!(spec.extra_groups, vec![2000]);
	assert_eq!(spec.umask, Some(0o002));
	assert_eq!(spec.timeout, Duration::from_secs(7));
	assert!(
		spec
			.env
			.get(git_ops::AUTH_ENV_VAR)
			.unwrap()
			.starts_with("Authorization: Basic ")
	);
}

#[test]
fn bad_ref_fixture_parses_and_updates_refs_through_runner() {
	let output = include_str!("fixtures/phase4/bad-fetch-output.txt");
	assert_eq!(git_ops::bad_refs_from_fetch_output(output), vec![
		"refs/heads/farm/deadbeef/broken",
		"refs/remotes/origin/stale"
	]);
	let runner = RecordingRunner::default();
	git_ops::delete_bad_refs(Path::new("/pool"), output, &runner);
	let specs = runner.specs.borrow();
	assert!(
		specs
			.iter()
			.any(|s| s.args == ["worktree", "list", "--porcelain"])
	);
	assert!(
		specs
			.iter()
			.any(|s| s.args == ["update-ref", "-d", "refs/heads/farm/deadbeef/broken"])
	);
}

#[test]
fn sandbox_lifecycle_branch_rename_dirty_and_force_with_lease() {
	let tmp = tempfile::tempdir().unwrap();
	let remote = seed_remote(tmp.path());
	let mgr = SandboxManager::new(tmp.path().join("workspaces"));
	let mut ws = mgr
		.ensure_workspace(
			"octo/widget",
			43,
			"Fix JSON BOM",
			remote.to_str().unwrap(),
			"main",
			None,
			"Robo",
			"robo@example.com",
			None,
		)
		.unwrap();
	assert!(ws.repo_dir.join(".git").exists());
	assert!(ws.session_dir.is_dir());
	assert!(ws.context_dir.join("repro").is_dir());
	assert!(ws.artifacts_dir.is_dir());
	let renamed = sandbox::rename_workspace_branch(
		&mut ws,
		"fix-json-bom",
		None,
		None,
		&git_ops::RealCommandRunner,
	)
	.unwrap();
	assert!(renamed.ends_with("/fix-json-bom"));
	fs::write(ws.repo_dir.join("change.txt"), "one\n").unwrap();
	let dirty = git_ops::inspect_dirty_state(&ws.repo_dir, None, None, &git_ops::RealCommandRunner);
	assert_eq!(dirty.uncommitted, 1);
	assert!(dirty.summary.contains("Uncommitted changes"));
	git(&["add", "change.txt"], &ws.repo_dir);
	git(&["commit", "-m", "change"], &ws.repo_dir);
	let local = head(&ws.repo_dir);
	let pushed = git_ops::push(
		&ws.repo_dir,
		&ws.branch,
		Some(&local),
		None,
		None,
		None,
		&git_ops::RealCommandRunner,
	)
	.unwrap();
	assert_eq!(pushed.head, local);
	fs::write(ws.repo_dir.join("change.txt"), "two\n").unwrap();
	git(&["add", "change.txt"], &ws.repo_dir);
	git(&["commit", "--amend", "--no-edit"], &ws.repo_dir);
	let amended = head(&ws.repo_dir);
	git_ops::push(
		&ws.repo_dir,
		&ws.branch,
		Some(&amended),
		None,
		None,
		None,
		&git_ops::RealCommandRunner,
	)
	.unwrap();
	let origin_head = String::from_utf8(
		std::process::Command::new("git")
			.args(["rev-parse", &format!("refs/heads/{}", ws.branch)])
			.current_dir(&remote)
			.output()
			.unwrap()
			.stdout,
	)
	.unwrap();
	assert_eq!(origin_head.trim(), amended);
	mgr.remove_workspace("octo/widget", 43);
	assert!(!ws.root.exists());
}

#[test]
fn runtime_dirs_and_slot_proc_scan_match_python_contract() {
	let tmp = tempfile::tempdir().unwrap();
	let ws = Workspace {
		root:           tmp.path().join("ws"),
		repo_dir:       tmp.path().join("ws/repo"),
		session_dir:    tmp.path().join("ws/.gjc-session"),
		context_dir:    tmp.path().join("ws/context"),
		artifacts_dir:  tmp.path().join("ws/artifacts"),
		branch:         "farm/abc/old".into(),
		repo_full_name: "octo/widget".into(),
		issue_number:   1,
	};
	let env = sandbox::prepare_slot_runtime_env(&ws, Some(2001)).unwrap();
	assert!(Path::new(env.get("TMPDIR").unwrap()).is_dir());
	assert!(Path::new(env.get("BUN_INSTALL_CACHE_DIR").unwrap()).is_dir());
	let proc = tmp.path().join("proc");
	fs::create_dir_all(proc.join("123")).unwrap();
	fs::write(proc.join("123/status"), "State:\tS (sleeping)\nUid:\t1000\t2001\t1000\t1000\n")
		.unwrap();
	fs::create_dir_all(proc.join("456")).unwrap();
	fs::write(proc.join("456/status"), "State:\tZ (zombie)\nUid:\t2001\t2001\t2001\t2001\n")
		.unwrap();
	assert_eq!(sandbox::slot_pids(2001, &proc), vec![123]);
	assert_eq!(workspace_keys::workspace_key("octo/widget", 1), ws.workspace_key());
}

fn git_status(args: &[&str], cwd: &Path) -> std::process::Output {
	std::process::Command::new("git")
		.args(args)
		.current_dir(cwd)
		.output()
		.unwrap()
}

#[test]
fn dirty_state_counts_staged_untracked_and_submodule_changes() {
	let tmp = tempfile::tempdir().unwrap();
	let remote = seed_remote(tmp.path());
	let mgr = SandboxManager::new(tmp.path().join("workspaces"));
	let ws = mgr
		.ensure_workspace(
			"octo/dirty",
			1,
			"Dirty",
			remote.to_str().unwrap(),
			"main",
			None,
			"Robo",
			"robo@example.com",
			None,
		)
		.unwrap();
	fs::write(ws.repo_dir.join("staged.txt"), "staged\n").unwrap();
	git(&["add", "staged.txt"], &ws.repo_dir);
	let dirty = git_ops::inspect_dirty_state(&ws.repo_dir, None, None, &git_ops::RealCommandRunner);
	assert!(dirty.uncommitted >= 1);
	assert!(dirty.summary.contains("A  staged.txt"));

	git(&["commit", "-m", "staged"], &ws.repo_dir);
	fs::write(ws.repo_dir.join("untracked.txt"), "new\n").unwrap();
	let dirty = git_ops::inspect_dirty_state(&ws.repo_dir, None, None, &git_ops::RealCommandRunner);
	assert!(dirty.uncommitted >= 1);
	assert!(dirty.summary.contains("?? untracked.txt"));

	git(&["config", "protocol.file.allow", "always"], &ws.repo_dir);
	let sub_parent = tmp.path().join("sub");
	fs::create_dir(&sub_parent).unwrap();
	let sub = seed_remote(&sub_parent);
	git(
		&["-c", "protocol.file.allow=always", "submodule", "add", sub.to_str().unwrap(), "deps/sub"],
		&ws.repo_dir,
	);
	git(&["commit", "-am", "add submodule"], &ws.repo_dir);
	fs::write(ws.repo_dir.join("deps/sub/subchange.txt"), "sub\n").unwrap();
	let dirty = git_ops::inspect_dirty_state(&ws.repo_dir, None, None, &git_ops::RealCommandRunner);
	assert!(dirty.uncommitted >= 1);
	assert!(dirty.summary.contains("deps/sub"));
}

#[test]
fn force_with_lease_rejects_moved_remote_head_and_redacts_credentials() {
	let tmp = tempfile::tempdir().unwrap();
	let remote = seed_remote(tmp.path());
	let mgr = SandboxManager::new(tmp.path().join("workspaces"));
	let ws = mgr
		.ensure_workspace(
			"octo/lease",
			2,
			"Lease",
			remote.to_str().unwrap(),
			"main",
			None,
			"Robo",
			"robo@example.com",
			None,
		)
		.unwrap();
	fs::write(ws.repo_dir.join("a.txt"), "a\n").unwrap();
	git(&["add", "a.txt"], &ws.repo_dir);
	git(&["commit", "-m", "a"], &ws.repo_dir);
	let local = head(&ws.repo_dir);
	git_ops::push(
		&ws.repo_dir,
		&ws.branch,
		Some(&local),
		None,
		None,
		None,
		&git_ops::RealCommandRunner,
	)
	.unwrap();
	let mover = tmp.path().join("mover");
	git(&["clone", remote.to_str().unwrap(), mover.to_str().unwrap()], tmp.path());
	git(&["checkout", &ws.branch], &mover);
	fs::write(mover.join("b.txt"), "b\n").unwrap();
	git(&["add", "b.txt"], &mover);
	git(&["commit", "-m", "move"], &mover);
	git(&["push", "origin", &ws.branch], &mover);
	fs::write(ws.repo_dir.join("a.txt"), "amended\n").unwrap();
	git(&["add", "a.txt"], &ws.repo_dir);
	git(&["commit", "--amend", "--no-edit"], &ws.repo_dir);
	let amended = head(&ws.repo_dir);
	let err = git_ops::push(
		&ws.repo_dir,
		&ws.branch,
		Some(&amended),
		None,
		None,
		None,
		&git_ops::RealCommandRunner,
	)
	.unwrap_err();
	let remote_head = head(&mover);
	let actual = String::from_utf8(
		git_status(&["rev-parse", &format!("refs/heads/{}", ws.branch)], &remote).stdout,
	)
	.unwrap();
	assert_eq!(actual.trim(), remote_head);
	let err_text = err.to_string();
	assert!(
		err_text.contains("stale") || err_text.contains("rejected") || err_text.contains("failed")
	);

	let credentialed = "https://user:super-secret@example.invalid/repo.git";
	let err = git_ops::clone_pool(
		&tmp.path().join("bad"),
		credentialed,
		"main",
		Some("token-secret"),
		&git_ops::RealCommandRunner,
	)
	.unwrap_err();
	let combined = format!("{err} {:?} {} {}", err.cmd, err.stdout, err.stderr);
	assert!(!combined.contains("super-secret"));
	assert!(!combined.contains("token-secret"));
}

#[test]
fn branch_rename_collision_invalid_slug_and_workspace_resume_after_pool_refresh() {
	let tmp = tempfile::tempdir().unwrap();
	let remote = seed_remote(tmp.path());
	let mgr = SandboxManager::new(tmp.path().join("workspaces"));
	let mut ws = mgr
		.ensure_workspace(
			"octo/resume",
			3,
			"Resume",
			remote.to_str().unwrap(),
			"main",
			None,
			"Robo",
			"robo@example.com",
			None,
		)
		.unwrap();
	assert!(
		sandbox::rename_workspace_branch(
			&mut ws,
			"bad slug",
			None,
			None,
			&git_ops::RealCommandRunner
		)
		.is_err()
	);
	let taken = format!("farm/{}/taken", ws.branch.split('/').nth(1).unwrap());
	git(&["branch", &taken], &ws.repo_dir);
	assert!(
		sandbox::rename_workspace_branch(&mut ws, "taken", None, None, &git_ops::RealCommandRunner)
			.is_err()
	);
	let pool = mgr.pool_path("octo/resume");
	git(&["fetch", "--prune", "origin"], &pool);
	let resumed = mgr
		.ensure_workspace(
			"octo/resume",
			3,
			"Ignored",
			remote.to_str().unwrap(),
			"main",
			None,
			"Robo",
			"robo@example.com",
			None,
		)
		.unwrap();
	assert_eq!(resumed.repo_dir, ws.repo_dir);
	assert_eq!(resumed.branch, ws.branch);
}

#[test]
fn safe_directory_env_is_scoped_to_git_commands_only() {
	let runner = RecordingRunner::default();
	let repo = PathBuf::from("/tmp/safe/repo");
	git_ops::run_git_with(&runner, &["status"], Some(&repo), GitRunOptions::default()).unwrap();
	assert!(
		!runner.specs.borrow()[0]
			.env
			.contains_key("GIT_CONFIG_COUNT")
	);
	let env = sandbox::safe_directory_env(&repo);
	assert_eq!(env.get("GIT_CONFIG_KEY_0").map(String::as_str), Some("safe.directory"));
}

#[test]
fn real_command_runner_timeout_is_git_error_124() {
	let spec = CommandSpec {
		program:      "sh".into(),
		args:         vec!["-c".into(), "sleep 1".into()],
		cwd:          None,
		env:          Default::default(),
		timeout:      Duration::from_millis(20),
		user:         None,
		group:        None,
		extra_groups: vec![],
		umask:        None,
	};
	let err = git_ops::RealCommandRunner.run(&spec).unwrap_err();
	assert_eq!(err.returncode, 124);
	assert!(err.stderr.contains("timed out"));
}

#[test]
fn head_drift_uses_typed_error() {
	let tmp = tempfile::tempdir().unwrap();
	let remote = seed_remote(tmp.path());
	let mgr = SandboxManager::new(tmp.path().join("workspaces"));
	let ws = mgr
		.ensure_workspace(
			"octo/drift",
			4,
			"Drift",
			remote.to_str().unwrap(),
			"main",
			None,
			"Robo",
			"robo@example.com",
			None,
		)
		.unwrap();
	fs::write(ws.repo_dir.join("drift.txt"), "one\n").unwrap();
	git(&["add", "drift.txt"], &ws.repo_dir);
	git(&["commit", "-m", "drift"], &ws.repo_dir);
	let err = git_ops::push(
		&ws.repo_dir,
		&ws.branch,
		Some("0000000000000000000000000000000000000000"),
		None,
		None,
		None,
		&git_ops::RealCommandRunner,
	)
	.unwrap_err();
	assert!(matches!(err, git_ops::GitPushError::HeadDrift(_)));
}

#[test]
fn file_remote_safe_directory_rejects_non_local_netloc() {
	let runner = RecordingRunner::default();
	*runner.outputs.borrow_mut() = vec![
		CommandOutput { status: 0, stdout: String::new(), stderr: String::new() },
		CommandOutput {
			status: 0,
			stdout: "file://example.com/tmp/remote.git\n".into(),
			stderr: String::new(),
		},
		CommandOutput { status: 1, stdout: String::new(), stderr: String::new() },
		CommandOutput {
			status: 0,
			stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n".into(),
			stderr: String::new(),
		},
	];
	git_ops::push(
		Path::new("/tmp/repo"),
		"farm/x/y",
		Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
		None,
		None,
		None,
		&runner,
	)
	.unwrap();
	let specs = runner.specs.borrow();
	let push_spec = specs.last().unwrap();
	assert_eq!(push_spec.args[0], "push");
	assert!(
		!push_spec
			.env
			.values()
			.any(|v| v == "example.com/tmp/remote.git" || v == "/tmp/remote.git")
	);
	assert_eq!(push_spec.env.get("GIT_CONFIG_COUNT"), None);
}

#[test]
fn sandbox_manager_populates_natives_cache_on_workspace_creation() {
	let tmp = tempfile::tempdir().unwrap();
	let remote = seed_remote(tmp.path());
	let native_dir = remote.join("packages/natives/native");
	fs::create_dir_all(&native_dir).unwrap();
	fs::write(native_dir.join("pi_natives.linux-arm64.node"), "node\n").unwrap();
	fs::write(native_dir.join("index.d.ts"), "types\n").unwrap();
	fs::write(native_dir.join("index.js"), "js\n").unwrap();
	fs::write(native_dir.join("embedded-addon.js"), "addon\n").unwrap();
	git(&["add", "packages"], &remote);
	git(&["commit", "-m", "native"], &remote);
	let cache = robogjc::natives_cache::NativesCache::new(tmp.path().join("cache")).unwrap();
	let source = tmp.path().join("source");
	git(&["clone", remote.to_str().unwrap(), source.to_str().unwrap()], tmp.path());
	let native_dir = source.join("packages/natives/native");
	let key = robogjc::natives_cache::compute_key(&source, None).unwrap();
	cache
		.capture("octo/native", &key, &native_dir, Some("source"), None)
		.unwrap()
		.unwrap();
	let mgr = SandboxManager::with_natives_cache(tmp.path().join("workspaces"), cache);
	let ws = mgr
		.ensure_workspace(
			"octo/native",
			5,
			"Native",
			remote.to_str().unwrap(),
			"main",
			None,
			"Robo",
			"robo@example.com",
			None,
		)
		.unwrap();
	let populated = ws.repo_dir.join("packages/natives/native");
	assert_eq!(fs::read_to_string(populated.join("index.js")).unwrap(), "js\n");
	assert_eq!(fs::read_to_string(populated.join("pi_natives.linux-arm64.node")).unwrap(), "node\n");
}

#[test]
fn chown_workspace_missing_path_returns_error_when_active() {
	let tmp = tempfile::tempdir().unwrap();
	let missing = tmp.path().join("missing");
	let result = sandbox::chown_workspace(&missing, None);
	// SAFETY: `geteuid` is a side-effect-free libc query that does not dereference
	// pointers.
	let is_root = unsafe { libc::geteuid() == 0 };
	if cfg!(target_os = "linux") && is_root {
		assert!(result.is_err());
	} else {
		assert!(result.is_ok());
	}
}

#[test]
#[ignore = "requires Linux root and ROBGJC_PERMISSIONS_E2E=1"]
fn permissions_e2e_real_runner_applies_extra_groups() {
	// SAFETY: `geteuid` is a side-effect-free libc query that does not dereference
	// pointers.
	let is_root = unsafe { libc::geteuid() == 0 };
	if std::env::var("ROBGJC_PERMISSIONS_E2E").ok().as_deref() != Some("1")
		|| !cfg!(target_os = "linux")
		|| !is_root
	{
		return;
	}
	let spec = CommandSpec {
		program:      "id".into(),
		args:         vec!["-G".into()],
		cwd:          None,
		env:          Default::default(),
		timeout:      Duration::from_secs(5),
		user:         Some(2001),
		group:        Some(2001),
		extra_groups: vec![2000],
		umask:        Some(0o002),
	};
	let out = git_ops::RealCommandRunner.run(&spec).unwrap();
	assert_eq!(out.status, 0);
	assert!(out.stdout.split_whitespace().any(|g| g == "2000"), "groups: {}", out.stdout);
}
