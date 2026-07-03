//! Repository workspace and sandbox identity boundary.

use std::{
	collections::BTreeMap,
	fs, io,
	path::{Path, PathBuf},
	process::Command,
};

use crate::{
	git_ops::{self, CommandRunner, GitCommandError, GitPushError, PushResult, RealCommandRunner},
	natives_cache::{CacheHit, NativesCache},
	workspace_keys::validate_branch_slug,
};

const SHARED_GJC_GID: u32 = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
	pub root:           PathBuf,
	pub repo_dir:       PathBuf,
	pub session_dir:    PathBuf,
	pub context_dir:    PathBuf,
	pub artifacts_dir:  PathBuf,
	pub branch:         String,
	pub repo_full_name: String,
	pub issue_number:   u64,
}
impl Workspace {
	pub fn repro_dir(&self) -> PathBuf {
		self.context_dir.join("repro")
	}

	pub fn workspace_key(&self) -> String {
		workspace_key(&self.repo_full_name, self.issue_number)
	}
}

pub fn safe_directory_env(repo_dir: &Path) -> BTreeMap<String, String> {
	BTreeMap::from([
		("GIT_CONFIG_COUNT".into(), "1".into()),
		("GIT_CONFIG_KEY_0".into(), "safe.directory".into()),
		("GIT_CONFIG_VALUE_0".into(), repo_dir.display().to_string()),
	])
}
pub fn git_env_for_repo(repo_dir: &Path) -> BTreeMap<String, String> {
	let mut env = safe_directory_env(repo_dir);
	env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
	env
}

pub fn rename_workspace_branch(
	workspace: &mut Workspace,
	new_slug: &str,
	pr_number: Option<u64>,
	slot_uid: Option<u32>,
	runner: &impl CommandRunner,
) -> Result<String, GitCommandError> {
	validate_branch_slug(new_slug).map_err(|e| GitCommandError {
		cmd:        vec!["git".into(), "branch".into()],
		returncode: 128,
		stdout:     String::new(),
		stderr:     e,
	})?;
	let parts: Vec<_> = workspace.branch.splitn(3, '/').collect();
	if parts.len() != 3 || parts[0] != "farm" || parts[1].is_empty() {
		return Err(GitCommandError {
			cmd:        vec!["git".into(), "branch".into()],
			returncode: 128,
			stdout:     String::new(),
			stderr:     format!("refusing to rename non-farm branch {:?}", workspace.branch),
		});
	}
	let new_branch = format!("farm/{}/{new_slug}", parts[1]);
	if new_branch == workspace.branch {
		return Ok(new_branch);
	}
	if pr_number.is_some() {
		return Ok(workspace.branch.clone());
	}
	let env = git_env_for_repo(&workspace.repo_dir);
	let mut opts = git_ops::slot_subprocess_options(slot_uid);
	opts.extra_env = env;
	let old = workspace.branch.clone();
	let out = git_ops::run_git_with(
		runner,
		&["branch", "-m", &old, &new_branch],
		Some(&workspace.repo_dir),
		opts,
	)?;
	if out.status != 0 {
		return Err(GitCommandError {
			cmd:        vec!["git".into(), "branch".into(), "-m".into(), old, new_branch],
			returncode: out.status,
			stdout:     out.stdout,
			stderr:     out.stderr,
		});
	}
	share_git_metadata_with_slots(&workspace.repo_dir, slot_uid);
	workspace.branch.clone_from(&new_branch);
	Ok(new_branch)
}

pub trait GitTransport: Send + Sync {
	fn clone_pool(
		&self,
		repo: &str,
		clone_url: &str,
		default_branch: &str,
		target: &Path,
	) -> Result<(), GitCommandError>;
	fn fetch_pool(&self, repo: &str, pool_dir: &Path) -> Result<(), GitCommandError>;
	fn fetch_base_ref(&self, repo: &str, pool_dir: &Path, rf: &str) -> Result<(), GitCommandError>;
	fn push_branch(
		&self,
		repo: &str,
		workspace_key: &str,
		repo_dir: &Path,
		branch: &str,
		expected_head: &str,
		slot_uid: Option<u32>,
	) -> Result<PushResult, GitPushError>;
}
#[derive(Debug, Clone, Default)]
pub struct LocalGitTransport {
	token: Option<String>,
}
impl LocalGitTransport {
	pub const fn new(token: Option<String>) -> Self {
		Self { token }
	}
}
impl GitTransport for LocalGitTransport {
	fn clone_pool(
		&self,
		_: &str,
		clone_url: &str,
		default_branch: &str,
		target: &Path,
	) -> Result<(), GitCommandError> {
		git_ops::clone_pool(
			target,
			clone_url,
			default_branch,
			self.token.as_deref(),
			&RealCommandRunner,
		)
	}

	fn fetch_pool(&self, _: &str, pool_dir: &Path) -> Result<(), GitCommandError> {
		git_ops::fetch_prune(pool_dir, self.token.as_deref(), &RealCommandRunner)
	}

	fn fetch_base_ref(&self, _: &str, pool_dir: &Path, rf: &str) -> Result<(), GitCommandError> {
		git_ops::fetch_ref(pool_dir, rf, self.token.as_deref(), &RealCommandRunner);
		Ok(())
	}

	fn push_branch(
		&self,
		repo: &str,
		workspace_key: &str,
		repo_dir: &Path,
		branch: &str,
		expected_head: &str,
		slot_uid: Option<u32>,
	) -> Result<PushResult, GitPushError> {
		let _ = (repo, workspace_key);
		git_ops::push(
			repo_dir,
			branch,
			Some(expected_head),
			self.token.as_deref(),
			slot_uid,
			None,
			&RealCommandRunner,
		)
	}
}

pub fn slot_permissions_active(slot_uid: Option<u32>) -> bool {
	git_ops::slot_permissions_active(slot_uid)
}
pub fn slot_pids(slot_uid: u32, proc_root: &Path) -> Vec<u32> {
	let Ok(entries) = fs::read_dir(proc_root) else {
		return vec![];
	};
	let mut pids = Vec::new();
	for e in entries.flatten() {
		let name = e.file_name();
		let Some(s) = name.to_str() else { continue };
		if !s.chars().all(|c| c.is_ascii_digit()) {
			continue;
		}
		let Ok(status) = fs::read_to_string(e.path().join("status")) else {
			continue;
		};
		let mut zombie = false;
		let mut owns = false;
		for line in status.lines() {
			if let Some(rest) = line.strip_prefix("State:") {
				zombie = rest.trim_start().starts_with('Z');
			}
			if let Some(rest) = line.strip_prefix("Uid:") {
				owns = rest
					.split_whitespace()
					.filter_map(|p| p.parse::<u32>().ok())
					.any(|u| u == slot_uid);
			}
		}
		if owns
			&& !zombie
			&& let Ok(pid) = s.parse()
		{
			pids.push(pid);
		}
	}
	pids
}
pub fn reap_slot(slot_uid: Option<u32>) {
	if !slot_permissions_active(slot_uid) {
		return;
	}
	for pid in slot_pids(slot_uid.unwrap(), Path::new("/proc")) {
		// SAFETY: `pid` comes from `/proc` entries owned by the slot uid, and `kill`
		// only receives the integer pid and SIGKILL to reap stale slot processes.
		unsafe {
			libc::kill(pid as i32, libc::SIGKILL);
		}
	}
}

pub fn prepare_slot_tmpdir(workspace: &Workspace, _slot_uid: Option<u32>) -> io::Result<PathBuf> {
	let tmp = workspace.root.join(".gjc-tmp");
	if let Ok(meta) = fs::symlink_metadata(&tmp)
		&& !meta.file_type().is_dir()
	{
		let _ = fs::remove_file(&tmp);
	}
	fs::create_dir_all(&tmp)?;
	Ok(tmp)
}
pub fn prepare_slot_runtime_env(
	workspace: &Workspace,
	slot_uid: Option<u32>,
) -> io::Result<BTreeMap<String, String>> {
	let tmp = prepare_slot_tmpdir(workspace, slot_uid)?;
	let root = workspace.root.join(".gjc-xdg");
	for sub in ["data", "state", "cache"] {
		fs::create_dir_all(root.join(sub).join("gjc"))?;
	}
	fs::create_dir_all(root.join("cache/bun-install"))?;
	Ok(BTreeMap::from([
		("TMPDIR".into(), tmp.display().to_string()),
		("TMP".into(), tmp.display().to_string()),
		("TEMP".into(), tmp.display().to_string()),
		("XDG_DATA_HOME".into(), root.join("data").display().to_string()),
		("XDG_STATE_HOME".into(), root.join("state").display().to_string()),
		("XDG_CACHE_HOME".into(), root.join("cache").display().to_string()),
		("BUN_INSTALL_CACHE_DIR".into(), root.join("cache/bun-install").display().to_string()),
	]))
}
pub fn provision_runtime_dirs(ws_root: &Path) -> io::Result<()> {
	let tmp = ws_root.join(".gjc-tmp");
	if let Ok(meta) = fs::symlink_metadata(&tmp)
		&& !meta.file_type().is_dir()
	{
		let _ = fs::remove_file(&tmp);
	}
	fs::create_dir_all(&tmp)?;
	for sub in ["data", "state", "cache"] {
		fs::create_dir_all(ws_root.join(".gjc-xdg").join(sub).join("gjc"))?;
	}
	fs::create_dir_all(ws_root.join(".gjc-xdg/cache/bun-install"))
}

#[cfg(unix)]
fn chown_path(path: &Path, uid: Option<u32>, gid: Option<u32>) {
	use std::os::unix::ffi::OsStrExt;
	let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
	// SAFETY: `c` is a NUL-free CString built from `path`; `lchown` does not retain
	// the pointer, and `!0` is the documented sentinel for unchanged uid/gid.
	unsafe {
		libc::lchown(
			c.as_ptr(),
			uid.map_or(!0, |u| u as libc::uid_t),
			gid.map_or(!0, |g| g as libc::gid_t),
		);
	}
}
#[cfg(unix)]
fn chmod_or(path: &Path, bits: u32) {
	use std::os::unix::fs::PermissionsExt;
	if let Ok(meta) = fs::symlink_metadata(path) {
		if meta.file_type().is_symlink() {
			return;
		}
		let mode = meta.permissions().mode();
		let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode | bits));
	}
}
fn grant_group_bits(path: &Path, gid: u32, bits: u32) {
	#[cfg(unix)]
	{
		chown_path(path, None, Some(gid));
		chmod_or(path, bits);
	}
}
fn grant_tree(path: &Path, gid: u32, files_group_writable: bool) {
	if !path.exists() {
		return;
	}
	if path.is_file() {
		grant_group_bits(path, gid, 0o040 | if files_group_writable { 0o020 } else { 0 });
		return;
	}
	let Ok(rd) = fs::read_dir(path) else { return };
	grant_group_bits(path, gid, 0o2770);
	for e in rd.flatten() {
		let p = e.path();
		if p.is_dir() {
			grant_tree(&p, gid, files_group_writable);
		} else {
			grant_group_bits(&p, gid, 0o040 | if files_group_writable { 0o020 } else { 0 });
		}
	}
}
pub fn resolve_worktree_git_dirs(repo_dir: &Path) -> Option<(PathBuf, PathBuf)> {
	let marker = repo_dir.join(".git");
	if marker.is_dir() {
		return Some((marker.clone(), marker));
	}
	let text = fs::read_to_string(marker).ok()?;
	let raw = text.trim().strip_prefix("gitdir:")?.trim();
	let git = if Path::new(raw).is_absolute() {
		PathBuf::from(raw)
	} else {
		repo_dir.join(raw)
	};
	let common = fs::read_to_string(git.join("commondir")).ok().map_or_else(
		|| git.clone(),
		|s| {
			let r = s.trim().to_string();
			if Path::new(&r).is_absolute() {
				PathBuf::from(r)
			} else {
				git.join(r)
			}
		},
	);
	Some((git, common))
}
pub fn share_git_metadata_with_slots(repo_dir: &Path, slot_uid: Option<u32>) {
	if !slot_permissions_active(slot_uid) {
		return;
	}
	let Some((git, common)) = resolve_worktree_git_dirs(repo_dir) else {
		return;
	};
	grant_tree(&git, SHARED_GJC_GID, true);
	grant_group_bits(&common, SHARED_GJC_GID, 0o2770);
	for (rel, w) in [("objects", false), ("refs", true), ("logs", true), ("worktrees", true)] {
		grant_tree(&common.join(rel), SHARED_GJC_GID, w);
	}
	for rel in ["config", "packed-refs", "HEAD", "FETCH_HEAD", "ORIG_HEAD"] {
		grant_tree(&common.join(rel), SHARED_GJC_GID, true);
	}
}
pub fn chown_workspace(ws_root: &Path, slot_uid: Option<u32>) -> io::Result<()> {
	// SAFETY: `geteuid` takes no pointers and is used only to skip root-only
	// ownership changes when not privileged.
	let is_root = unsafe { libc::geteuid() == 0 };
	if !cfg!(target_os = "linux") || !is_root {
		return Ok(());
	}
	// SAFETY: `geteuid` takes no pointers and returns the current effective uid
	// used as the default chown target.
	let current_uid = unsafe { libc::geteuid() };
	// SAFETY: `getegid` takes no pointers and returns the current effective gid
	// used as the default chown target.
	let current_gid = unsafe { libc::getegid() };
	let uid = slot_uid.unwrap_or(current_uid);
	let gid = slot_uid.unwrap_or(current_gid);
	let chown = Command::new("chown")
		.args(["-R", &format!("{uid}:{gid}"), &ws_root.display().to_string()])
		.status()?;
	if !chown.success() {
		return Err(io::Error::other(format!(
			"chown -R {uid}:{gid} {} failed with {chown}",
			ws_root.display()
		)));
	}
	let chmod = Command::new("chmod")
		.args(["-R", "u=rwX,g=rwX,o=", &ws_root.display().to_string()])
		.status()?;
	if !chmod.success() {
		return Err(io::Error::other(format!(
			"chmod -R u=rwX,g=rwX,o= {} failed with {chmod}",
			ws_root.display()
		)));
	}
	Ok(())
}

fn io_to_git_error(err: io::Error) -> GitCommandError {
	GitCommandError {
		cmd:        vec!["sandbox".into()],
		returncode: 127,
		stdout:     String::new(),
		stderr:     err.to_string(),
	}
}

#[cfg(unix)]
fn chown_natives_for_slot(native_dir: &Path, hit: &CacheHit, slot_uid: u32) {
	use std::os::unix::ffi::OsStrExt;
	let c = std::ffi::CString::new(native_dir.as_os_str().as_bytes()).unwrap();
	// SAFETY: `c` is a NUL-free CString for `native_dir`; `chown` does not retain
	// the pointer and failures are intentionally best-effort here.
	unsafe {
		libc::chown(c.as_ptr(), slot_uid as libc::uid_t, slot_uid as libc::gid_t);
	}
	let node_names: std::collections::BTreeSet<_> = hit
		.files
		.iter()
		.filter_map(|p| p.file_name())
		.filter(|n| n.to_string_lossy().ends_with(".node"))
		.map(|n| n.to_owned())
		.collect();
	let Ok(rd) = fs::read_dir(native_dir) else {
		return;
	};
	for e in rd.flatten() {
		if node_names.contains(&e.file_name()) {
			continue;
		}
		let c = std::ffi::CString::new(e.path().as_os_str().as_bytes()).unwrap();
		// SAFETY: `c` is a NUL-free CString for this directory entry; `lchown` does not
		// retain the pointer and failures are intentionally best-effort here.
		unsafe {
			libc::lchown(c.as_ptr(), slot_uid as libc::uid_t, slot_uid as libc::gid_t);
		}
	}
}
#[cfg(not(unix))]
fn chown_natives_for_slot(_native_dir: &Path, _hit: &CacheHit, _slot_uid: u32) {}

pub struct SandboxManager<T: GitTransport = LocalGitTransport> {
	pub root:          PathBuf,
	pub pool:          PathBuf,
	pub transport:     T,
	pub natives_cache: Option<NativesCache>,
}
impl SandboxManager<LocalGitTransport> {
	pub fn new(root: PathBuf) -> Self {
		Self::with_transport(root, LocalGitTransport::default())
	}

	pub fn with_natives_cache(root: PathBuf, natives_cache: NativesCache) -> Self {
		Self::with_transport_and_natives_cache(
			root,
			LocalGitTransport::default(),
			Some(natives_cache),
		)
	}
}
impl<T: GitTransport> SandboxManager<T> {
	pub fn with_transport(root: PathBuf, transport: T) -> Self {
		Self::with_transport_and_natives_cache(root, transport, None)
	}

	pub fn with_transport_and_natives_cache(
		root: PathBuf,
		transport: T,
		natives_cache: Option<NativesCache>,
	) -> Self {
		let pool = root.join("_pool");
		fs::create_dir_all(&pool).unwrap();
		Self { root, pool, transport, natives_cache }
	}

	pub fn pool_path(&self, repo: &str) -> PathBuf {
		self.pool.join(repo.replace('/', "__"))
	}

	pub fn workspace_root(&self, repo: &str, number: u64) -> PathBuf {
		self.root.join(workspace_key(repo, number))
	}

	pub fn ensure_clone(
		&self,
		repo: &str,
		clone_url: &str,
		default_branch: &str,
	) -> Result<PathBuf, GitCommandError> {
		let target = self.pool_path(repo);
		if target.join(".git").exists() || target.join("HEAD").exists() {
			Self::reset_origin_url(&target, clone_url);
			self.transport.fetch_pool(repo, &target)?;
			return Ok(target);
		}
		fs::create_dir_all(&target).map_err(|e| GitCommandError {
			cmd:        vec!["git".into(), "clone".into()],
			returncode: 127,
			stdout:     String::new(),
			stderr:     e.to_string(),
		})?;
		self
			.transport
			.clone_pool(repo, clone_url, default_branch, &target)?;
		Ok(target)
	}

	fn reset_origin_url(repo_dir: &Path, clone_url: &str) {
		let out =
			git_ops::run_git(&["remote", "get-url", "origin"], Some(repo_dir), Default::default());
		if let Ok(o) = out
			&& o.status == 0
			&& o.stdout.trim() != clone_url
		{
			let _ = git_ops::run_git(
				&["remote", "set-url", "origin", clone_url],
				Some(repo_dir),
				Default::default(),
			);
		}
	}

	#[allow(
		clippy::too_many_arguments,
		reason = "workspace provisioning needs the explicit repo, issue, git, author, and slot \
		          inputs"
	)]
	pub fn ensure_workspace(
		&self,
		repo: &str,
		number: u64,
		title: &str,
		clone_url: &str,
		default_branch: &str,
		existing_branch: Option<&str>,
		author_name: &str,
		author_email: &str,
		slot_uid: Option<u32>,
	) -> Result<Workspace, GitCommandError> {
		let pool = self.ensure_clone(repo, clone_url, default_branch)?;
		let ws_root = self.workspace_root(repo, number);
		let repo_dir = ws_root.join("repo");
		let session_dir = ws_root.join(".gjc-session");
		let context_dir = ws_root.join("context");
		let artifacts_dir = ws_root.join("artifacts");
		let repro_dir = context_dir.join("repro");
		for p in [&ws_root, &session_dir, &context_dir, &repro_dir, &artifacts_dir] {
			fs::create_dir_all(p).map_err(|e| GitCommandError {
				cmd:        vec!["mkdir".into()],
				returncode: 127,
				stdout:     String::new(),
				stderr:     e.to_string(),
			})?;
		}
		let mut branch = existing_branch.map_or_else(
			|| make_branch(number, title, Some(&format!("{repo}#{number}"))),
			str::to_string,
		);
		let repo_exists = repo_dir.join(".git").exists();
		let mut prepared = false;
		let mut slot_opts = git_ops::slot_subprocess_options(slot_uid);
		if repo_exists {
			share_git_metadata_with_slots(&repo_dir, slot_uid);
			let _ = provision_runtime_dirs(&ws_root);
			chown_workspace(&ws_root, slot_uid).map_err(io_to_git_error)?;
			prepared = true;
		}
		if repo_exists {
			slot_opts.extra_env = git_env_for_repo(&repo_dir);
			let cur = git_ops::run_git_with(
				&RealCommandRunner,
				&["symbolic-ref", "--quiet", "--short", "HEAD"],
				Some(&repo_dir),
				slot_opts.clone(),
			)?;
			if cur.status == 0 && !cur.stdout.trim().is_empty() {
				branch = cur.stdout.trim().to_string();
			}
		} else {
			self
				.transport
				.fetch_base_ref(repo, &pool, existing_branch.unwrap_or(default_branch))?;
			let check = git_ops::run_git(
				&["rev-parse", "--verify", &format!("refs/heads/{branch}")],
				Some(&pool),
				Default::default(),
			)?;
			if check.status == 0 {
				let r = repo_dir.display().to_string();
				let out = git_ops::run_git(
					&["worktree", "add", &r, &branch],
					Some(&pool),
					Default::default(),
				)?;
				if out.status != 0 {
					return Err(GitCommandError {
						cmd:        vec!["git".into(), "worktree".into(), "add".into(), r, branch],
						returncode: out.status,
						stdout:     out.stdout,
						stderr:     out.stderr,
					});
				}
			} else {
				let mut start = format!("origin/{default_branch}");
				if let Some(ex) = existing_branch {
					let remote = git_ops::run_git(
						&["rev-parse", "--verify", &format!("refs/remotes/origin/{ex}")],
						Some(&pool),
						Default::default(),
					)?;
					if remote.status == 0 {
						start = format!("origin/{ex}");
					}
				}
				let r = repo_dir.display().to_string();
				let out = git_ops::run_git(
					&["worktree", "add", "-b", &branch, &r, &start],
					Some(&pool),
					Default::default(),
				)?;
				if out.status != 0 {
					return Err(GitCommandError {
						cmd:        vec!["git".into(), "worktree".into(), "add".into()],
						returncode: out.status,
						stdout:     out.stdout,
						stderr:     out.stderr,
					});
				}
			}
		}
		if !prepared {
			share_git_metadata_with_slots(&repo_dir, slot_uid);
			let _ = provision_runtime_dirs(&ws_root);
			chown_workspace(&ws_root, slot_uid).map_err(io_to_git_error)?;
		}
		slot_opts.extra_env = git_env_for_repo(&repo_dir);
		for (k, v) in [("user.email", author_email), ("user.name", author_name)] {
			let out = git_ops::run_git_with(
				&RealCommandRunner,
				&["config", k, v],
				Some(&repo_dir),
				slot_opts.clone(),
			)?;
			if out.status != 0 {
				return Err(GitCommandError {
					cmd:        vec!["git".into(), "config".into(), k.into(), v.into()],
					returncode: out.status,
					stdout:     out.stdout,
					stderr:     out.stderr,
				});
			}
		}
		share_git_metadata_with_slots(&repo_dir, slot_uid);
		let workspace = Workspace {
			root: ws_root,
			repo_dir,
			session_dir,
			context_dir,
			artifacts_dir,
			branch,
			repo_full_name: repo.into(),
			issue_number: number,
		};
		self.populate_natives_cache(&workspace, slot_uid);
		Ok(workspace)
	}

	fn populate_natives_cache(&self, workspace: &Workspace, slot_uid: Option<u32>) {
		let Some(cache) = &self.natives_cache else {
			return;
		};
		let native_dir = workspace.repo_dir.join("packages/natives/native");
		// Cache population is best-effort like Python (sandbox.py logs and
		// continues), but failures are logged instead of silently swallowed.
		let key = match crate::natives_cache::compute_key(&workspace.repo_dir, None) {
			Ok(key) => key,
			Err(err) => {
				tracing::warn!(repo = %workspace.repo_full_name, error = %err, "natives cache key derivation failed");
				return;
			},
		};
		let hit = match cache.populate_workspace(&workspace.repo_full_name, &key, &native_dir) {
			Ok(hit) => hit,
			Err(err) => {
				tracing::warn!(repo = %workspace.repo_full_name, error = %err, "natives cache populate failed");
				return;
			},
		};
		if let (Some(hit), Some(uid)) = (hit, slot_uid)
			&& slot_permissions_active(slot_uid)
		{
			chown_natives_for_slot(&native_dir, &hit, uid);
		}
	}

	pub fn remove_workspace(&self, repo: &str, number: u64) {
		let ws_root = self.workspace_root(repo, number);
		let repo_dir = ws_root.join("repo");
		if repo_dir.exists() {
			let pool = self.pool_path(repo);
			let _ = git_ops::run_git(
				&["worktree", "remove", "--force", &repo_dir.display().to_string()],
				Some(&pool),
				Default::default(),
			);
			if repo_dir.exists() {
				let _ = fs::remove_dir_all(&repo_dir);
			}
		}
		if ws_root.exists() {
			let _ = fs::remove_dir_all(ws_root);
		}
	}
}

pub use crate::{
	redaction::redact_credentials,
	workspace_keys::{
		make_branch as make_workspace_branch, make_branch, workspace_key as make_workspace_key,
		workspace_key,
	},
};

#[cfg(test)]
mod tests {}
