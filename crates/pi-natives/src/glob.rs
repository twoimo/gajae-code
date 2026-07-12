//! Filesystem discovery with glob patterns, ignore semantics, and shared scan
//! caching.
//!
//! # Overview
//! Resolves a search root, obtains scanned entries via [`fs_cache`], applies
//! glob matching plus optional file-type filtering, and optionally streams each
//! accepted match through a callback.
//!
//! The walker always skips `.git`, and skips `node_modules` unless explicitly
//! requested.
//!
//! # Example
//! ```ignore
//! // JS: await native.glob({ pattern: "*.rs", path: "." })
//! ```

use std::{borrow::Cow, cmp::Ordering, collections::BinaryHeap, path::Path};

use globset::GlobSet;
use napi::{
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

// Re-export entry types so existing `glob::FileType` / `glob::GlobMatch` paths still work.
pub use crate::fs_cache::{FileType, GlobMatch};
use crate::{fs_cache, glob_util, task};

/// Input options for `glob`, including traversal, filtering, and cancellation.
#[napi(object)]
pub struct GlobOptions<'env> {
	/// Glob pattern to match (e.g., "*.ts").
	pub pattern:              String,
	/// Directory to search.
	pub path:                 String,
	/// Filter by file type: "file", "dir", or "symlink". Symlinks are
	/// matched for file/dir filters based on their target type.
	pub file_type:            Option<FileType>,
	/// Match simple patterns recursively by default (`*.ts` -> recursive).
	pub recursive:            Option<bool>,
	/// Include hidden files (default: false).
	pub hidden:               Option<bool>,
	/// Maximum number of results to return.
	pub max_results:          Option<u32>,
	/// Respect .gitignore files (default: true).
	pub gitignore:            Option<bool>,
	/// Enable shared filesystem scan cache (default: false).
	pub cache:                Option<bool>,
	/// Sort results by mtime (most recent first) before applying limit.
	pub sort_by_mtime:        Option<bool>,
	/// Include `node_modules` entries when the pattern does not explicitly
	/// mention them.
	pub include_node_modules: Option<bool>,
	/// Abort signal for cancelling the operation.
	pub signal:               Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:           Option<u32>,
}

/// Result payload returned by a glob operation.
#[napi(object)]
pub struct GlobResult {
	/// Matched filesystem entries.
	pub matches:       Vec<GlobMatch>,
	/// Number of returned matches (`matches.len()`), clamped to `u32::MAX`.
	pub total_matches: u32,
}

/// Internal runtime config for a single glob execution.
struct GlobConfig {
	root:                  std::path::PathBuf,
	pattern:               String,
	recursive:             bool,
	include_hidden:        bool,
	file_type_filter:      Option<FileType>,
	max_results:           usize,
	use_gitignore:         bool,
	mentions_node_modules: bool,
	sort_by_mtime:         bool,
	use_cache:             bool,
}

fn resolve_symlink_target_type(root: &Path, relative_path: &str) -> Option<FileType> {
	let target_path = root.join(relative_path);
	let metadata = std::fs::metadata(target_path).ok()?;
	if metadata.is_dir() {
		Some(FileType::Dir)
	} else if metadata.is_file() {
		Some(FileType::File)
	} else {
		None
	}
}

fn apply_file_type_filter(entry: &GlobMatch, config: &GlobConfig) -> Option<FileType> {
	let Some(filter) = config.file_type_filter else {
		return Some(entry.file_type);
	};
	if entry.file_type == filter {
		return Some(entry.file_type);
	}
	if entry.file_type != FileType::Symlink {
		return None;
	}
	match filter {
		FileType::File | FileType::Dir => {
			let resolved = resolve_symlink_target_type(&config.root, &entry.path)?;
			if resolved == filter {
				Some(resolved)
			} else {
				None
			}
		},
		FileType::Symlink => None,
	}
}

/// Return the forward-slash form used by the scanner for deterministic
/// ordering.
fn normalized_path(path: &str) -> Cow<'_, str> {
	if path.contains('\\') {
		Cow::Owned(path.replace('\\', "/"))
	} else {
		Cow::Borrowed(path)
	}
}

/// Order matches from newest to oldest, breaking mtime ties by normalized path.
///
/// This is intentionally a total ordering so heap replacement and final output
/// cannot disagree on a tie.
fn match_rank(left: &GlobMatch, right: &GlobMatch) -> Ordering {
	right
		.mtime
		.unwrap_or(0.0)
		.total_cmp(&left.mtime.unwrap_or(0.0))
		.then_with(|| normalized_path(&left.path).cmp(&normalized_path(&right.path)))
}

/// A `BinaryHeap` whose root is the least desirable retained match.
struct TopMatch(GlobMatch);

impl Ord for TopMatch {
	fn cmp(&self, other: &Self) -> Ordering {
		match_rank(&self.0, &other.0)
	}
}

impl PartialOrd for TopMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl PartialEq for TopMatch {
	fn eq(&self, other: &Self) -> bool {
		self.cmp(other) == Ordering::Equal
	}
}

impl Eq for TopMatch {}

/// Filter matching entries, retaining at most `max_results` newest entries when
/// mtime sorting is enabled. The scan/cache vector remains outside this bounded
/// selection; this function never builds an all-match vector in sorted mode.
fn filter_entries(
	entries: &[GlobMatch],
	glob_set: &GlobSet,
	config: &GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: &task::CancelToken,
) -> Result<Vec<GlobMatch>> {
	let mut matches = Vec::new();
	let mut newest = BinaryHeap::new();
	if config.max_results == 0 {
		return Ok(matches);
	}

	for entry in entries {
		ct.heartbeat()?;
		if fs_cache::should_skip_path(Path::new(&entry.path), config.mentions_node_modules) {
			// Apply post-scan node_modules policy before glob matching.
			continue;
		}
		if !glob_set.is_match(&entry.path) {
			continue;
		}
		let Some(effective_file_type) = apply_file_type_filter(entry, config) else {
			continue;
		};
		let mut matched_entry = entry.clone();
		matched_entry.file_type = effective_file_type;
		if let Some(callback) = on_match {
			callback.call(Ok(matched_entry.clone()), ThreadsafeFunctionCallMode::NonBlocking);
		}

		if config.sort_by_mtime {
			if newest.len() < config.max_results {
				newest.push(TopMatch(matched_entry));
			} else if newest
				.peek()
				.is_some_and(|worst| match_rank(&matched_entry, &worst.0).is_lt())
			{
				// The root is the oldest (or lexically last tied) retained match.
				newest.pop();
				newest.push(TopMatch(matched_entry));
			}
		} else {
			matches.push(matched_entry);
			if matches.len() >= config.max_results {
				break;
			}
		}
	}

	if config.sort_by_mtime {
		matches = newest.into_iter().map(|entry| entry.0).collect();
		matches.sort_by(match_rank);
	}
	Ok(matches)
}

/// Executes matching/filtering over scanned entries and optionally streams each
/// hit.
fn run_glob(
	config: GlobConfig,
	on_match: Option<&ThreadsafeFunction<GlobMatch>>,
	ct: task::CancelToken,
) -> Result<GlobResult> {
	let glob_set = glob_util::compile_glob(&config.pattern, config.recursive)?;
	if config.max_results == 0 {
		return Ok(GlobResult { matches: Vec::new(), total_matches: 0 });
	}

	let skip_node_modules = !config.mentions_node_modules;
	let scan_options = fs_cache::ScanOptions {
		include_hidden: config.include_hidden,
		use_gitignore: config.use_gitignore,
		skip_node_modules,
		follow_links: false,
		detail: if config.sort_by_mtime {
			fs_cache::ScanDetail::Full
		} else {
			fs_cache::ScanDetail::Minimal
		},
	};
	let matches = if config.use_cache {
		let scan = fs_cache::get_or_scan(&config.root, scan_options, &ct)?;
		let mut matches = filter_entries(&scan.entries, &glob_set, &config, on_match, &ct)?;
		// Empty-result recheck: if we got zero matches from a cached scan that's old
		// enough, force a rescan and try once more before returning empty.
		if matches.is_empty() && scan.cache_age_ms >= fs_cache::empty_recheck_ms() {
			let fresh = fs_cache::force_rescan(&config.root, scan_options, true, &ct)?;
			matches = filter_entries(&fresh, &glob_set, &config, on_match, &ct)?;
		}
		matches
	} else {
		let fresh = fs_cache::force_rescan(&config.root, scan_options, false, &ct)?;
		filter_entries(&fresh, &glob_set, &config, on_match, &ct)?
	};

	// `filter_entries` already returns the bounded, deterministic top-K when
	// sorting by mtime, so no full-match sort is retained here.
	let total_matches = matches.len().min(u32::MAX as usize) as u32;
	Ok(GlobResult { matches, total_matches })
}

/// Find filesystem entries matching a glob pattern.
///
/// Resolves the search root, scans entries, applies glob and optional file-type
/// filters, and optionally streams each accepted match through `on_match`.
/// If `sortByMtime` is enabled, returns the bounded newest `maxResults` matches
/// using deterministic mtime/path ordering.
///
/// # Errors
/// Returns an error when the search path cannot be resolved, the path is not a
/// directory, the glob pattern is invalid, or cancellation/timeout is
/// triggered.
#[napi]
pub fn glob(
	options: GlobOptions<'_>,
	#[napi(ts_arg_type = "((error: Error | null, match: GlobMatch) => void) | undefined | null")]
	on_match: Option<ThreadsafeFunction<GlobMatch>>,
) -> task::Promise<GlobResult> {
	let GlobOptions {
		pattern,
		path,
		file_type,
		recursive,
		hidden,
		max_results,
		gitignore,
		sort_by_mtime,
		cache,
		include_node_modules,
		timeout_ms,
		signal,
	} = options;

	let pattern = pattern.trim();
	let pattern = if pattern.is_empty() { "*" } else { pattern };
	let pattern = pattern.to_string();

	let ct = task::CancelToken::new(timeout_ms, signal);

	task::blocking("glob", ct, move |ct| {
		run_glob(
			GlobConfig {
				root: fs_cache::resolve_search_path(&path)?,
				include_hidden: hidden.unwrap_or(false),
				file_type_filter: file_type,
				recursive: recursive.unwrap_or(true),
				max_results: max_results.map_or(usize::MAX, |value| value as usize),
				use_gitignore: gitignore.unwrap_or(true),
				mentions_node_modules: include_node_modules
					.unwrap_or_else(|| pattern.contains("node_modules")),
				sort_by_mtime: sort_by_mtime.unwrap_or(false),
				use_cache: cache.unwrap_or(false),
				pattern,
			},
			on_match.as_ref(),
			ct,
		)
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn entry(path: &str, mtime: Option<f64>) -> GlobMatch {
		GlobMatch { path: path.to_string(), file_type: FileType::File, mtime, size: None }
	}

	fn top_k(mut entries: Vec<GlobMatch>, limit: usize) -> Vec<GlobMatch> {
		let mut heap = BinaryHeap::new();
		for entry in entries.drain(..) {
			if heap.len() < limit {
				heap.push(TopMatch(entry));
			} else if heap
				.peek()
				.is_some_and(|worst| match_rank(&entry, &worst.0).is_lt())
			{
				heap.pop();
				heap.push(TopMatch(entry));
			}
		}
		let mut selected: Vec<_> = heap.into_iter().map(|entry| entry.0).collect();
		selected.sort_by(match_rank);
		selected
	}

	#[test]
	fn top_k_matches_full_sort_for_ties_unicode_and_missing_mtime() {
		let entries = vec![
			entry("zeta.rs", Some(10.0)),
			entry("alpha.rs", Some(10.0)),
			entry("über.rs", Some(10.0)),
			entry("nested\\beta.rs", Some(11.0)),
			entry("none.rs", None),
		];
		let mut oracle = entries.clone();
		oracle.sort_by(match_rank);
		oracle.truncate(4);
		let actual = top_k(entries, 4);
		assert_eq!(
			actual.into_iter().map(|item| item.path).collect::<Vec<_>>(),
			oracle.into_iter().map(|item| item.path).collect::<Vec<_>>(),
		);
	}

	#[test]
	fn top_k_handles_zero_and_fewer_than_limit() {
		let entries = vec![entry("a", Some(1.0)), entry("b", Some(2.0))];
		assert!(top_k(entries.clone(), 0).is_empty());
		assert_eq!(
			top_k(entries, 10)
				.into_iter()
				.map(|item| item.path)
				.collect::<Vec<_>>(),
			["b", "a"]
		);
	}

	#[test]
	fn top_k_has_exact_one_million_entry_parity() {
		let mut state = 0x6a09_e667_u32;
		let entries = (0..1_000_000)
			.map(|index| {
				state ^= state << 13;
				state ^= state >> 17;
				state ^= state << 5;
				entry(
					&format!("dir-{}/file-{index:07}.rs", state % 4096),
					Some(f64::from(state % 10_000)),
				)
			})
			.collect::<Vec<_>>();
		let mut oracle = entries.clone();
		oracle.sort_by(match_rank);
		oracle.truncate(100);
		assert_eq!(
			top_k(entries, 100)
				.into_iter()
				.map(|item| item.path)
				.collect::<Vec<_>>(),
			oracle.into_iter().map(|item| item.path).collect::<Vec<_>>(),
		);
	}
}
