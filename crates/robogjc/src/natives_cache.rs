//! Content-addressed cache of pre-built `packages/natives/native/` artifacts.

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CACHE_KEY_PATHS: &[&str] =
	&["crates", "Cargo.lock", "Cargo.toml", "rust-toolchain.toml", "packages/natives"];

const CACHED_NODE_PREFIX: &str = "pi_natives.";
const CACHED_NODE_SUFFIX: &str = ".node";
const CACHED_COMPANION_FILES: &[&str] = &["index.d.ts", "index.js", "embedded-addon.js"];
const MANIFEST_FILENAME: &str = "manifest.json";
const LOCKFILE_NAME: &str = ".lock";
const NULL_TREE_HASH: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheHit {
	pub cache_dir: PathBuf,
	pub files: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct NativesCache {
	pub root: PathBuf,
	max_entries_per_repo: usize,
	max_bytes: u64,
}

impl NativesCache {
	pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
		Self::with_limits(root, 8, 4 * 1024 * 1024 * 1024)
	}

	pub fn with_limits(
		root: impl Into<PathBuf>,
		max_entries_per_repo: usize,
		max_bytes: u64,
	) -> io::Result<Self> {
		let root = root.into();
		fs::create_dir_all(&root)?;
		Ok(Self { root, max_entries_per_repo: max_entries_per_repo.max(1), max_bytes })
	}

	pub fn repo_root(&self, repo: &str) -> PathBuf {
		self.root.join(repo_slug(repo))
	}

	pub fn entry_dir(&self, repo: &str, key: &str) -> PathBuf {
		self.repo_root(repo).join(key)
	}

	pub fn lockfile(&self, repo: &str) -> PathBuf {
		self.repo_root(repo).join(LOCKFILE_NAME)
	}

	pub fn lookup(&self, repo: &str, key: &str) -> Option<PathBuf> {
		let entry = self.entry_dir(repo, key);
		if !entry.join(MANIFEST_FILENAME).exists() || node_files(&entry).ok()?.is_empty() {
			return None;
		}
		if CACHED_COMPANION_FILES
			.iter()
			.any(|name| !entry.join(name).exists())
		{
			return None;
		}
		Some(entry)
	}

	pub fn populate_workspace(
		&self,
		repo: &str,
		key: &str,
		native_dir: &Path,
	) -> io::Result<Option<CacheHit>> {
		let Some(entry) = self.lookup(repo, key) else {
			return Ok(None);
		};
		fs::create_dir_all(native_dir)?;
		let mut copied = Vec::new();
		for src in node_files(&entry)? {
			let dst = native_dir.join(src.file_name().expect("node file name"));
			atomic_link(&src, &dst)?;
			copied.push(dst);
		}
		for name in CACHED_COMPANION_FILES {
			let dst = native_dir.join(name);
			atomic_copy(&entry.join(name), &dst)?;
			copied.push(dst);
		}
		Ok(Some(CacheHit { cache_dir: entry, files: copied }))
	}

	pub fn capture(
		&self,
		repo: &str,
		key: &str,
		native_dir: &Path,
		source_workspace: Option<&str>,
		commit: Option<&str>,
	) -> io::Result<Option<PathBuf>> {
		let nodes = node_files(native_dir)?;
		if nodes.is_empty()
			|| CACHED_COMPANION_FILES
				.iter()
				.any(|name| !native_dir.join(name).exists())
		{
			return Ok(None);
		}
		let repo_root = self.repo_root(repo);
		fs::create_dir_all(&repo_root)?;
		let _lock = FlockGuard::exclusive(&self.lockfile(repo))?;
		if self.lookup(repo, key).is_some() {
			return Ok(Some(self.entry_dir(repo, key)));
		}

		let final_dir = self.entry_dir(repo, key);
		let staging = repo_root.join(format!(".{key}.tmp.{}", std::process::id()));
		if staging.exists() {
			fs::remove_dir_all(&staging)?;
		}
		fs::create_dir_all(&staging)?;
		let result = (|| -> io::Result<()> {
			for src in &nodes {
				atomic_copy(src, &staging.join(src.file_name().expect("node file name")))?;
			}
			for name in CACHED_COMPANION_FILES {
				atomic_copy(&native_dir.join(name), &staging.join(name))?;
			}
			let manifest = Manifest {
				key,
				target: target_triple(),
				captured_at: now_secs(),
				source_workspace,
				commit,
				node_files: nodes
					.iter()
					.filter_map(|p| p.file_name())
					.map(|n| n.to_string_lossy().into_owned())
					.collect(),
			};
			write_json(&staging.join(MANIFEST_FILENAME), &manifest)?;
			fs::rename(&staging, &final_dir)?;
			Ok(())
		})();
		if let Err(err) = result {
			let _ = fs::remove_dir_all(&staging);
			return Err(err);
		}
		self.gc_locked(repo)?;
		Ok(Some(final_dir))
	}

	pub fn gc(&self, repo: Option<&str>) -> io::Result<usize> {
		if let Some(repo) = repo {
			let _lock = FlockGuard::exclusive(&self.lockfile(repo))?;
			return self.gc_locked(repo);
		}
		let mut total = 0;
		if !self.root.exists() {
			return Ok(0);
		}
		for child in fs::read_dir(&self.root)? {
			let child = child?;
			if !child.file_type()?.is_dir() {
				continue;
			}
			let repo_name = child.file_name().to_string_lossy().replacen("__", "/", 1);
			let _lock = FlockGuard::exclusive(&self.lockfile(&repo_name))?;
			total += self.gc_locked(&repo_name)?;
		}
		Ok(total)
	}

	fn gc_locked(&self, repo: &str) -> io::Result<usize> {
		let repo_root = self.repo_root(repo);
		if !repo_root.exists() {
			return Ok(0);
		}
		let mut entries = Vec::new();
		for child in fs::read_dir(&repo_root)? {
			let child = child?;
			let path = child.path();
			if !child.file_type()?.is_dir() {
				continue;
			}
			let name = child.file_name();
			if name.to_string_lossy().starts_with('.') {
				fs::remove_dir_all(path)?;
				continue;
			}
			let manifest_path = path.join(MANIFEST_FILENAME);
			if !manifest_path.exists() {
				fs::remove_dir_all(path)?;
				continue;
			}
			let captured_at = manifest_captured_at(&manifest_path)
				.unwrap_or_else(|_| mtime_secs(&manifest_path).unwrap_or(0.0));
			let size = dir_size(&path);
			entries.push((captured_at, size, path));
		}
		entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
		let mut evicted = 0;
		while entries.len() > self.max_entries_per_repo {
			let (_, _, victim) = entries.remove(0);
			fs::remove_dir_all(victim)?;
			evicted += 1;
		}
		if self.max_bytes > 0 {
			let mut total: u64 = entries.iter().map(|(_, size, _)| *size).sum();
			while total > self.max_bytes && entries.len() > 1 {
				let (_, size, victim) = entries.remove(0);
				fs::remove_dir_all(victim)?;
				total = total.saturating_sub(size);
				evicted += 1;
			}
		}
		Ok(evicted)
	}
}

#[derive(Serialize)]
struct Manifest<'a> {
	key: &'a str,
	target: String,
	captured_at: f64,
	source_workspace: Option<&'a str>,
	commit: Option<&'a str>,
	node_files: Vec<String>,
}

#[derive(Deserialize)]
struct ManifestForGc {
	captured_at: Option<f64>,
}

pub fn compute_key(repo_dir: &Path, target: Option<&str>) -> io::Result<String> {
	let target = target.map(ToOwned::to_owned).unwrap_or_else(target_triple);
	let mut child = Command::new("git")
		.args(["cat-file", "--batch-check"])
		.current_dir(repo_dir)
		.envs(git_safe_directory_env(repo_dir))
		.stdin(std::process::Stdio::piped())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.spawn()?;
	{
		let stdin = child.stdin.as_mut().expect("git stdin");
		for path in CACHE_KEY_PATHS {
			writeln!(stdin, "HEAD:{path}")?;
		}
	}
	let output = child.wait_with_output()?;
	if !output.status.success() {
		return Err(io::Error::other(format!(
			"git cat-file failed: {}",
			String::from_utf8_lossy(&output.stderr)
		)));
	}
	let stdout = String::from_utf8(output.stdout).map_err(io::Error::other)?;
	let lines: Vec<&str> = stdout.lines().collect();
	if lines.len() != CACHE_KEY_PATHS.len() {
		return Err(io::Error::other(format!(
			"git cat-file returned {} lines, expected {}",
			lines.len(),
			CACHE_KEY_PATHS.len()
		)));
	}
	let mut hasher = Sha256::new();
	for (path, line) in CACHE_KEY_PATHS.iter().zip(lines) {
		let stripped = line.trim();
		let tree_hash = if stripped.ends_with("missing") {
			NULL_TREE_HASH
		} else {
			stripped.split_whitespace().next().unwrap_or(NULL_TREE_HASH)
		};
		hasher.update(format!("{path}\t{tree_hash}\n").as_bytes());
	}
	hasher.update(format!("TARGET\t{target}\n").as_bytes());
	Ok(format!("{:x}", hasher.finalize()))
}

pub fn target_triple() -> String {
	let platform = if cfg!(target_os = "linux") {
		"linux"
	} else if cfg!(target_os = "macos") {
		"darwin"
	} else if cfg!(windows) {
		"win32"
	} else {
		std::env::consts::OS
	};
	let arch = match std::env::consts::ARCH {
		"x86_64" => "x64",
		"aarch64" => "arm64",
		other => other,
	};
	if arch != "x64" {
		return format!("{platform}-{arch}");
	}
	let variant = std::env::var("TARGET_VARIANT")
		.ok()
		.map(|v| v.trim().to_owned())
		.filter(|v| !v.is_empty())
		.unwrap_or_else(|| "host".to_owned());
	format!("{platform}-{arch}-{variant}")
}

pub fn atomic_link(src: &Path, dst: &Path) -> io::Result<()> {
	atomic_link_with(src, dst, |src, tmp| fs::hard_link(src, tmp))
}

fn atomic_link_with<F>(src: &Path, dst: &Path, link: F) -> io::Result<()>
where
	F: Fn(&Path, &Path) -> io::Result<()>,
{
	fs::create_dir_all(dst.parent().expect("destination parent"))?;
	let tmp = tmp_path(dst);
	let result = match link(src, &tmp) {
		Ok(()) => Ok(()),
		Err(err) if err.raw_os_error() == Some(libc::EXDEV) => fs::copy(src, &tmp).map(|_| ()),
		Err(err) => Err(err),
	}
	.and_then(|()| fs::rename(&tmp, dst));
	let _ = fs::remove_file(&tmp);
	result
}

pub fn atomic_copy(src: &Path, dst: &Path) -> io::Result<()> {
	fs::create_dir_all(dst.parent().expect("destination parent"))?;
	let tmp = tmp_path(dst);
	let result = fs::copy(src, &tmp)
		.map(|_| ())
		.and_then(|()| fs::rename(&tmp, dst));
	let _ = fs::remove_file(&tmp);
	result
}

fn node_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
	if !dir.exists() {
		return Ok(Vec::new());
	}
	let mut out = Vec::new();
	for entry in fs::read_dir(dir)? {
		let entry = entry?;
		if !entry.file_type()?.is_file() {
			continue;
		}
		let name = entry.file_name();
		let name = name.to_string_lossy();
		if name.starts_with(CACHED_NODE_PREFIX) && name.ends_with(CACHED_NODE_SUFFIX) {
			out.push(entry.path());
		}
	}
	out.sort();
	Ok(out)
}

fn repo_slug(repo: &str) -> String {
	repo.replace('/', "__")
}

fn git_safe_directory_env(repo_dir: &Path) -> Vec<(String, String)> {
	let mut count = std::env::var("GIT_CONFIG_COUNT")
		.ok()
		.and_then(|v| v.parse::<usize>().ok())
		.unwrap_or(0);
	let mut envs = Vec::new();
	envs.push((format!("GIT_CONFIG_KEY_{count}"), "safe.directory".to_owned()));
	envs.push((format!("GIT_CONFIG_VALUE_{count}"), repo_dir.to_string_lossy().into_owned()));
	count += 1;
	envs.push(("GIT_CONFIG_COUNT".to_owned(), count.to_string()));
	envs
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
	let body = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
	fs::write(path, format!("{body}\n"))
}

fn manifest_captured_at(path: &Path) -> io::Result<f64> {
	let body = fs::read_to_string(path)?;
	let manifest: ManifestForGc = serde_json::from_str(&body).map_err(io::Error::other)?;
	Ok(manifest.captured_at.unwrap_or(0.0))
}

fn dir_size(path: &Path) -> u64 {
	fn walk(path: &Path, total: &mut u64) {
		let Ok(entries) = fs::read_dir(path) else {
			return;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			if let Ok(meta) = fs::symlink_metadata(&path) {
				if meta.is_dir() {
					walk(&path, total);
				} else {
					*total = total.saturating_add(meta.len());
				}
			}
		}
	}
	let mut total = 0;
	walk(path, &mut total);
	total
}

fn now_secs() -> f64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs_f64()
}

fn mtime_secs(path: &Path) -> io::Result<f64> {
	Ok(fs::metadata(path)?
		.modified()?
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs_f64())
}

fn tmp_path(dst: &Path) -> PathBuf {
	let suffix = dst
		.extension()
		.and_then(OsStr::to_str)
		.map(|ext| format!(".{ext}.tmp.{}", std::process::id()))
		.unwrap_or_else(|| format!(".tmp.{}", std::process::id()));
	dst.with_extension(suffix.trim_start_matches('.'))
}

struct FlockGuard {
	file: File,
}

impl FlockGuard {
	fn exclusive(path: &Path) -> io::Result<Self> {
		fs::create_dir_all(path.parent().expect("lock parent"))?;
		let file = OpenOptions::new()
			.create(true)
			.append(true)
			.read(true)
			.open(path)?;
		let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
		if rc != 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(Self { file })
	}
}

impl Drop for FlockGuard {
	fn drop(&mut self) {
		let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::os::unix::fs::MetadataExt;
	use std::sync::{Arc, Barrier, Mutex};
	use std::thread;
	use tempfile::TempDir;

	const REPO: &str = "octo/widget";

	fn git(args: &[&str], cwd: &Path) {
		let status = Command::new("git")
			.args(args)
			.current_dir(cwd)
			.env("GIT_AUTHOR_NAME", "t")
			.env("GIT_AUTHOR_EMAIL", "t@t")
			.env("GIT_COMMITTER_NAME", "t")
			.env("GIT_COMMITTER_EMAIL", "t@t")
			.status()
			.unwrap();
		assert!(status.success(), "git command failed: {args:?}");
	}

	fn seed_repo(root: &Path, with_all_inputs: bool) -> PathBuf {
		fs::create_dir_all(root).unwrap();
		git(&["init", "--initial-branch=main", root.to_str().unwrap()], root.parent().unwrap());
		fs::write(root.join("Cargo.lock"), "# lock v1\n").unwrap();
		if with_all_inputs {
			fs::write(root.join("Cargo.toml"), "[workspace]\nmembers = ['crates/*']\n").unwrap();
			fs::write(root.join("rust-toolchain.toml"), "[toolchain]\nchannel = \"1.85.0\"\n")
				.unwrap();
			fs::create_dir_all(root.join("crates/pi-natives")).unwrap();
			fs::write(root.join("crates/pi-natives/Cargo.toml"), "[package]\nname = \"pi-natives\"\n")
				.unwrap();
			fs::write(root.join("crates/pi-natives/src.rs"), "// source\n").unwrap();
			fs::create_dir_all(root.join("packages/natives/scripts")).unwrap();
			fs::write(
				root.join("packages/natives/package.json"),
				"{\"name\":\"@gajae-code/natives\"}\n",
			)
			.unwrap();
			fs::write(root.join("packages/natives/scripts/build-native.ts"), "// build script\n")
				.unwrap();
			fs::create_dir_all(root.join("packages/natives/native")).unwrap();
			fs::write(root.join("packages/natives/native/index.d.ts"), "// initial typings\n")
				.unwrap();
		}
		git(&["-C", root.to_str().unwrap(), "add", "."], root.parent().unwrap());
		git(&["-C", root.to_str().unwrap(), "commit", "-m", "init"], root.parent().unwrap());
		root.to_path_buf()
	}

	fn populate_built_artifacts(repo_dir: &Path, body: &[u8]) -> PathBuf {
		let native_dir = repo_dir.join("packages/natives/native");
		fs::create_dir_all(&native_dir).unwrap();
		fs::write(native_dir.join("pi_natives.linux-arm64.node"), body).unwrap();
		fs::write(native_dir.join("index.d.ts"), "export const X: number;\n").unwrap();
		fs::write(native_dir.join("index.js"), "export const X = 1;\n").unwrap();
		fs::write(native_dir.join("embedded-addon.js"), "export const embeddedAddon = null;\n")
			.unwrap();
		native_dir
	}

	fn cache(tmp: &TempDir) -> NativesCache {
		NativesCache::new(tmp.path().join("natives-cache")).unwrap()
	}

	#[test]
	fn compute_key_deterministic_across_clones() {
		let tmp = TempDir::new().unwrap();
		let a = seed_repo(&tmp.path().join("a"), true);
		let b = tmp.path().join("b");
		git(&["clone", a.to_str().unwrap(), b.to_str().unwrap()], tmp.path());
		assert_eq!(
			compute_key(&a, Some("linux-arm64")).unwrap(),
			compute_key(&b, Some("linux-arm64")).unwrap()
		);
	}

	#[test]
	fn compute_key_changes_when_each_input_changes() {
		let tmp = TempDir::new().unwrap();
		let base = seed_repo(&tmp.path().join("base"), true);
		let base_key = compute_key(&base, Some("linux-arm64")).unwrap();
		let mutations = [
			("crates", "crates/pi-natives/src.rs", "// new comment\n"),
			("Cargo.lock", "Cargo.lock", "# lock v2\n"),
			("Cargo.toml", "Cargo.toml", "[workspace]\nmembers = ['crates/*', 'extra']\n"),
			("rust-toolchain.toml", "rust-toolchain.toml", "[toolchain]\nchannel = \"1.86.0\"\n"),
			("packages/natives", "packages/natives/scripts/build-native.ts", "// edited\n"),
		];
		for (label, rel, body) in mutations {
			let clone = tmp
				.path()
				.join(format!("clone-{}", label.replace('/', "-")));
			git(&["clone", base.to_str().unwrap(), clone.to_str().unwrap()], tmp.path());
			let target = clone.join(rel);
			fs::create_dir_all(target.parent().unwrap()).unwrap();
			fs::write(&target, body).unwrap();
			git(&["-C", clone.to_str().unwrap(), "add", "."], tmp.path());
			git(
				&["-C", clone.to_str().unwrap(), "commit", "-m", &format!("mutate {label}")],
				tmp.path(),
			);
			assert_ne!(compute_key(&clone, Some("linux-arm64")).unwrap(), base_key, "{label}");
		}
	}

	#[test]
	fn compute_key_target_triple_changes_key() {
		let tmp = TempDir::new().unwrap();
		let repo = seed_repo(&tmp.path().join("repo"), true);
		assert_ne!(
			compute_key(&repo, Some("linux-arm64")).unwrap(),
			compute_key(&repo, Some("linux-x64-modern")).unwrap()
		);
	}

	#[test]
	fn compute_key_handles_missing_inputs() {
		let tmp = TempDir::new().unwrap();
		let repo = seed_repo(&tmp.path().join("repo"), false);
		let before = compute_key(&repo, Some("linux-arm64")).unwrap();
		fs::create_dir_all(repo.join("crates/pi-natives")).unwrap();
		fs::write(repo.join("crates/pi-natives/lib.rs"), "// new\n").unwrap();
		git(&["-C", repo.to_str().unwrap(), "add", "."], tmp.path());
		git(&["-C", repo.to_str().unwrap(), "commit", "-m", "add crates"], tmp.path());
		assert_ne!(before, compute_key(&repo, Some("linux-arm64")).unwrap());
	}

	#[test]
	fn compute_key_uses_all_documented_paths() {
		assert_eq!(
			CACHE_KEY_PATHS,
			&["crates", "Cargo.lock", "Cargo.toml", "rust-toolchain.toml", "packages/natives"]
		);
	}

	#[test]
	fn compute_key_raises_on_non_repo() {
		let tmp = TempDir::new().unwrap();
		assert!(compute_key(tmp.path(), Some("linux-arm64")).is_err());
	}

	#[test]
	fn populate_workspace_miss_is_noop() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let repo_dir = seed_repo(&tmp.path().join("ws/repo"), true);
		let native_dir = repo_dir.join("packages/natives/native");
		let before = sorted_names(&native_dir);
		assert!(
			cache
				.populate_workspace(REPO, "deadbeef", &native_dir)
				.unwrap()
				.is_none()
		);
		assert_eq!(before, sorted_names(&native_dir));
	}

	#[test]
	fn capture_then_populate_shares_node_inode_but_copies_companions() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let src_repo = seed_repo(&tmp.path().join("src/repo"), true);
		let native_dir = populate_built_artifacts(&src_repo, b"\x7fELF...native");
		let key = compute_key(&src_repo, Some("linux-arm64")).unwrap();
		let stored = cache
			.capture(REPO, &key, &native_dir, Some("src__001"), None)
			.unwrap()
			.unwrap();
		let manifest = fs::read_to_string(stored.join("manifest.json")).unwrap();
		assert!(manifest.contains(&key));
		assert!(manifest.contains("pi_natives.linux-arm64.node"));

		let dst_repo = tmp.path().join("dst/repo");
		fs::create_dir_all(dst_repo.parent().unwrap()).unwrap();
		git(
			&["clone", src_repo.to_str().unwrap(), dst_repo.to_str().unwrap()],
			dst_repo.parent().unwrap(),
		);
		let dst_native = dst_repo.join("packages/natives/native");
		fs::create_dir_all(&dst_native).unwrap();
		let hit = cache
			.populate_workspace(REPO, &key, &dst_native)
			.unwrap()
			.unwrap();
		let names: Vec<_> = hit
			.files
			.iter()
			.map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
			.collect();
		for name in ["pi_natives.linux-arm64.node", "index.d.ts", "index.js", "embedded-addon.js"] {
			assert!(names.iter().any(|n| n == name));
		}
		let cached_node = stored.join("pi_natives.linux-arm64.node");
		let workspace_node = dst_native.join("pi_natives.linux-arm64.node");
		assert_eq!(cached_node.metadata().unwrap().ino(), workspace_node.metadata().unwrap().ino());
		assert!(cached_node.metadata().unwrap().nlink() >= 2);
		for name in ["index.d.ts", "index.js", "embedded-addon.js"] {
			let cached = stored.join(name);
			let ws = dst_native.join(name);
			assert_ne!(cached.metadata().unwrap().ino(), ws.metadata().unwrap().ino(), "{name}");
			let original = fs::read_to_string(&cached).unwrap();
			fs::write(ws, "rewritten\n").unwrap();
			assert_eq!(fs::read_to_string(cached).unwrap(), original);
		}
	}

	#[test]
	fn capture_skips_when_artifacts_incomplete() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let repo = seed_repo(&tmp.path().join("ws/repo"), true);
		let native_dir = repo.join("packages/natives/native");
		fs::write(native_dir.join("pi_natives.linux-arm64.node"), b"x").unwrap();
		assert!(
			cache
				.capture(REPO, "k", &native_dir, None, None)
				.unwrap()
				.is_none()
		);
		assert!(!cache.entry_dir(REPO, "k").exists());
	}

	#[test]
	fn capture_is_idempotent_under_lock() {
		let tmp = TempDir::new().unwrap();
		let cache = Arc::new(cache(&tmp));
		let src_repo = seed_repo(&tmp.path().join("src/repo"), true);
		populate_built_artifacts(&src_repo, b"\x7fELF...native");
		let key = compute_key(&src_repo, Some("linux-arm64")).unwrap();
		let native_dir = src_repo.join("packages/natives/native");
		let results = Arc::new(Mutex::new(Vec::new()));
		let barrier = Arc::new(Barrier::new(2));
		let mut threads = Vec::new();
		for _ in 0..2 {
			let cache = cache.clone();
			let key = key.clone();
			let native_dir = native_dir.clone();
			let barrier = barrier.clone();
			let results = results.clone();
			threads.push(thread::spawn(move || {
				barrier.wait();
				results
					.lock()
					.unwrap()
					.push(cache.capture(REPO, &key, &native_dir, None, None).unwrap());
			}));
		}
		for thread in threads {
			thread.join().unwrap();
		}
		assert!(results.lock().unwrap().iter().all(Option::is_some));
		let final_dirs: Vec<_> = fs::read_dir(cache.repo_root(REPO))
			.unwrap()
			.map(|e| e.unwrap().path())
			.filter(|p| p.is_dir() && !p.file_name().unwrap().to_string_lossy().starts_with('.'))
			.collect();
		assert_eq!(final_dirs.len(), 1);
		assert_eq!(final_dirs[0].file_name().unwrap(), key.as_str());
	}

	#[test]
	fn populate_cross_device_falls_back_to_copy() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let src_repo = seed_repo(&tmp.path().join("src/repo"), true);
		populate_built_artifacts(&src_repo, b"\x7fELF...native");
		let key = compute_key(&src_repo, Some("linux-arm64")).unwrap();
		cache
			.capture(REPO, &key, &src_repo.join("packages/natives/native"), None, None)
			.unwrap();
		let dst_native = tmp.path().join("ws2/packages/natives/native");
		fs::create_dir_all(&dst_native).unwrap();
		let cached_node = cache
			.entry_dir(REPO, &key)
			.join("pi_natives.linux-arm64.node");
		let copied_node = dst_native.join("pi_natives.linux-arm64.node");
		atomic_link_with(&cached_node, &copied_node, |_, _| {
			Err(io::Error::from_raw_os_error(libc::EXDEV))
		})
		.unwrap();
		assert!(copied_node.exists());
		assert_ne!(cached_node.metadata().unwrap().ino(), copied_node.metadata().unwrap().ino());
	}

	#[test]
	fn populate_replaces_existing_file_atomically() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let src_repo = seed_repo(&tmp.path().join("src/repo"), true);
		populate_built_artifacts(&src_repo, b"\x7fELF.A");
		let key = compute_key(&src_repo, Some("linux-arm64")).unwrap();
		cache
			.capture(REPO, &key, &src_repo.join("packages/natives/native"), None, None)
			.unwrap();
		let dst_native = tmp.path().join("dst/packages/natives/native");
		fs::create_dir_all(&dst_native).unwrap();
		let target = dst_native.join("pi_natives.linux-arm64.node");
		fs::write(&target, b"old-stub").unwrap();
		assert!(
			cache
				.populate_workspace(REPO, &key, &dst_native)
				.unwrap()
				.is_some()
		);
		assert_eq!(fs::read(target).unwrap(), b"\x7fELF.A");
	}

	fn stamp_entry(cache: &NativesCache, key: &str, captured_at: f64) -> PathBuf {
		let entry = cache.entry_dir(REPO, key);
		fs::create_dir_all(&entry).unwrap();
		fs::write(entry.join("pi_natives.linux-arm64.node"), vec![b'x'; 1024]).unwrap();
		fs::write(entry.join("index.d.ts"), "").unwrap();
		fs::write(entry.join("index.js"), "").unwrap();
		fs::write(entry.join("embedded-addon.js"), "").unwrap();
		fs::write(entry.join("manifest.json"), serde_json::json!({"key": key, "captured_at": captured_at, "node_files": ["pi_natives.linux-arm64.node"]}).to_string()).unwrap();
		entry
	}

	#[test]
	fn gc_evicts_oldest_beyond_entry_cap() {
		let tmp = TempDir::new().unwrap();
		let cache = NativesCache::with_limits(tmp.path().join("natives-cache"), 2, 0).unwrap();
		let now = now_secs();
		stamp_entry(&cache, "k1", now - 300.0);
		stamp_entry(&cache, "k2", now - 200.0);
		stamp_entry(&cache, "k3", now - 100.0);
		assert_eq!(cache.gc(Some(REPO)).unwrap(), 1);
		assert_eq!(remaining_dirs(&cache), ["k2".to_owned(), "k3".to_owned()].into_iter().collect());
	}

	#[test]
	fn gc_evicts_for_byte_cap() {
		let tmp = TempDir::new().unwrap();
		let cache = NativesCache::with_limits(tmp.path().join("natives-cache"), 8, 2500).unwrap();
		let now = now_secs();
		stamp_entry(&cache, "k1", now - 300.0);
		stamp_entry(&cache, "k2", now - 200.0);
		stamp_entry(&cache, "k3", now - 100.0);
		cache.gc(Some(REPO)).unwrap();
		let remaining = remaining_dirs(&cache);
		assert!(!remaining.contains("k1"));
		assert!(remaining.iter().all(|k| k == "k2" || k == "k3"));
		assert!(!remaining.is_empty());
	}

	#[test]
	fn gc_preserves_workspace_hardlinks() {
		let tmp = TempDir::new().unwrap();
		let cache = NativesCache::with_limits(tmp.path().join("natives-cache"), 1, 0).unwrap();
		let now = now_secs();
		let entry = stamp_entry(&cache, "k1", now - 500.0);
		stamp_entry(&cache, "k2", now - 100.0);
		let ws_node = tmp.path().join("ws/pi_natives.linux-arm64.node");
		fs::create_dir_all(ws_node.parent().unwrap()).unwrap();
		fs::hard_link(entry.join("pi_natives.linux-arm64.node"), &ws_node).unwrap();
		cache.gc(Some(REPO)).unwrap();
		assert!(!entry.exists());
		assert_eq!(fs::read(ws_node).unwrap(), vec![b'x'; 1024]);
	}

	#[test]
	fn gc_clears_stale_staging_dirs() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let stale = cache.repo_root(REPO).join(".aabb.tmp.99999");
		fs::create_dir_all(&stale).unwrap();
		fs::write(stale.join("leaked"), "from a crashed capture").unwrap();
		cache.gc(Some(REPO)).unwrap();
		assert!(!stale.exists());
	}

	#[test]
	fn gc_drops_entry_with_missing_manifest() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let incomplete = cache.entry_dir(REPO, "bogus");
		fs::create_dir_all(&incomplete).unwrap();
		fs::write(incomplete.join("pi_natives.linux-arm64.node"), b"x").unwrap();
		cache.gc(Some(REPO)).unwrap();
		assert!(!incomplete.exists());
	}

	#[test]
	fn lookup_rejects_incomplete_entry() {
		let tmp = TempDir::new().unwrap();
		let cache = cache(&tmp);
		let entry = cache.entry_dir(REPO, "partial");
		fs::create_dir_all(&entry).unwrap();
		fs::write(entry.join("manifest.json"), "{}").unwrap();
		assert!(cache.lookup(REPO, "partial").is_none());
	}

	#[test]
	fn atomic_link_replaces_existing_target() {
		let tmp = TempDir::new().unwrap();
		let src = tmp.path().join("src");
		fs::write(&src, b"new").unwrap();
		let dst = tmp.path().join("dst");
		fs::write(&dst, b"old").unwrap();
		atomic_link(&src, &dst).unwrap();
		assert_eq!(fs::read(&dst).unwrap(), b"new");
		assert_eq!(dst.metadata().unwrap().ino(), src.metadata().unwrap().ino());
	}

	fn sorted_names(dir: &Path) -> Vec<String> {
		let mut names: Vec<_> = fs::read_dir(dir)
			.unwrap()
			.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
			.collect();
		names.sort();
		names
	}

	fn remaining_dirs(cache: &NativesCache) -> std::collections::HashSet<String> {
		fs::read_dir(cache.repo_root(REPO))
			.unwrap()
			.map(|e| e.unwrap().path())
			.filter(|p| p.is_dir() && !p.file_name().unwrap().to_string_lossy().starts_with('.'))
			.map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
			.collect()
	}
}
