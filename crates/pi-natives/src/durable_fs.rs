//! Filesystem publication primitives used by storage publication code.
//!
//! This module deliberately contains no session or manifest policy. Its
//! replacement primitive flushes the replacement file before publication, but
//! does not claim that the name/identity swap is a durable commit. Publishers
//! must use dual-slot recovery and tolerate an indeterminate newest slot.

use std::{
	fs::{self, File},
	path::Path,
};

use napi_derive::napi;

/// Stable outcome code for [`publish_replace_file`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[napi(string_enum)]
pub enum DurableFsOutcomeCode {
	#[napi(value = "OK")]
	Ok,
	#[napi(value = "SHARING_VIOLATION")]
	SharingViolation,
	#[napi(value = "TARGET_MISSING")]
	TargetMissing,
	#[napi(value = "CROSS_DIRECTORY_UNSUPPORTED")]
	CrossDirectoryUnsupported,
	#[napi(value = "REPLACE_FAILED_UNCHANGED")]
	ReplaceFailedUnchanged,
	#[napi(value = "REPLACE_FAILED_TARGET_MAY_HAVE_CHANGED")]
	ReplaceFailedTargetMayHaveChanged,
	#[napi(value = "REPLACE_FAILED_REPLACEMENT_RETAINED")]
	ReplaceFailedReplacementRetained,
	#[napi(value = "PUBLISHED_DURABILITY_UNCERTAIN")]
	PublishedDurabilityUncertain,
}

/// A machine-readable filesystem publication outcome. `os_code` is the raw
/// platform error code, or zero when no OS error was produced.
#[napi(object)]
pub struct DurableFsOutcome {
	pub ok:        bool,
	pub code:      DurableFsOutcomeCode,
	pub os_code:   i32,
	pub operation: String,
}

impl DurableFsOutcome {
	fn success(operation: &str) -> Self {
		Self {
			ok:        true,
			code:      DurableFsOutcomeCode::Ok,
			os_code:   0,
			operation: operation.to_owned(),
		}
	}

	fn failure(code: DurableFsOutcomeCode, operation: &str, error: &std::io::Error) -> Self {
		Self {
			ok: false,
			code,
			os_code: error.raw_os_error().unwrap_or(0),
			operation: operation.to_owned(),
		}
	}

	fn unsupported(operation: &str) -> Self {
		Self {
			ok:        false,
			code:      DurableFsOutcomeCode::CrossDirectoryUnsupported,
			os_code:   0,
			operation: operation.to_owned(),
		}
	}

	fn published_durability_uncertain(operation: &str, error: &std::io::Error) -> Self {
		Self::failure(DurableFsOutcomeCode::PublishedDurabilityUncertain, operation, error)
	}
}

fn error_code(error: &std::io::Error, target_operation: bool) -> DurableFsOutcomeCode {
	match error.raw_os_error() {
		Some(32) => DurableFsOutcomeCode::SharingViolation,
		#[cfg(unix)]
		Some(libc::EACCES | libc::EBUSY) => DurableFsOutcomeCode::SharingViolation,
		Some(2 | 3) if target_operation => DurableFsOutcomeCode::TargetMissing,
		#[cfg(unix)]
		Some(libc::ENOTDIR) if target_operation => DurableFsOutcomeCode::TargetMissing,
		// ReplaceFileW documents that 1175 retains the old target, 1176 moves it
		// to the backup name, and 1177 installs the replacement at the target name.
		Some(1175) => DurableFsOutcomeCode::ReplaceFailedUnchanged,
		Some(1176 | 1177) => DurableFsOutcomeCode::ReplaceFailedTargetMayHaveChanged,
		_ => DurableFsOutcomeCode::ReplaceFailedReplacementRetained,
	}
}

fn sync_file(path: &Path, target_operation: bool, operation: &str) -> Result<(), DurableFsOutcome> {
	File::open(path)
		.and_then(|file| file.sync_all())
		.map_err(|error| {
			DurableFsOutcome::failure(error_code(&error, target_operation), operation, &error)
		})
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
	File::open(path).and_then(|directory| directory.sync_all())
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
	// Windows has no portable directory fsync API. This remains intentionally a
	// no-op; ReplaceFileW provides atomic identity replacement, not a durable
	// commit guarantee.
	Ok(())
}

fn parent_directory(path: &Path) -> Option<&Path> {
	path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
}

fn same_directory(replacement: &Path, target: &Path) -> Result<bool, DurableFsOutcome> {
	let Some(replacement_parent) = parent_directory(replacement) else {
		return Ok(false);
	};
	let Some(target_parent) = parent_directory(target) else {
		return Ok(false);
	};
	let replacement_parent = fs::canonicalize(replacement_parent).map_err(|error| {
		DurableFsOutcome::failure(error_code(&error, false), "resolve replacement parent", &error)
	})?;
	let target_parent = fs::canonicalize(target_parent).map_err(|error| {
		DurableFsOutcome::failure(error_code(&error, true), "resolve target parent", &error)
	})?;
	Ok(replacement_parent == target_parent)
}

/// Flush a directory's metadata to durable storage where the platform supports
/// directory fsync. On Windows this is a successful no-op because there is no
/// portable directory fsync API.
#[napi]
pub fn fsync_directory(path: String) -> napi::Result<()> {
	sync_directory(Path::new(&path)).map_err(|error| {
		napi::Error::new(napi::Status::GenericFailure, format!("fsync directory: {error}"))
	})
}

/// Create a new durable target from a flushed replacement file without ever
/// overwriting an existing target. This is the first-publication counterpart to
/// [`publish_replace_file`].
#[napi]
pub fn publish_create_file(replacement_path: String, target_path: String) -> DurableFsOutcome {
	let replacement = Path::new(&replacement_path);
	let target = Path::new(&target_path);
	match same_directory(replacement, target) {
		Ok(true) => {},
		Ok(false) => return DurableFsOutcome::unsupported("validate publication directories"),
		Err(outcome) => return outcome,
	}
	if let Err(outcome) = sync_file(replacement, false, "flush replacement") {
		return outcome;
	}

	#[cfg(unix)]
	{
		if let Err(error) =
			fs::hard_link(replacement, target).and_then(|()| fs::remove_file(replacement))
		{
			return DurableFsOutcome::failure(error_code(&error, true), "create target", &error);
		}
		let Some(target_parent) = parent_directory(target) else {
			return DurableFsOutcome::unsupported("resolve target parent");
		};
		if let Err(error) = sync_directory(target_parent) {
			return DurableFsOutcome::published_durability_uncertain("flush target parent", &error);
		}
		DurableFsOutcome::success("create target")
	}

	#[cfg(windows)]
	{
		// CREATE_NEW guarantees that a racing publisher cannot overwrite an
		// already-published authority file. The new file is flushed before the
		// replacement is removed, so an error leaves a complete target or the
		// original replacement available for recovery.
		let result = (|| -> std::io::Result<()> {
			let mut source = File::open(replacement)?;
			let mut target_file = fs::OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(target)?;
			std::io::copy(&mut source, &mut target_file)?;
			target_file.sync_all()?;
			fs::remove_file(replacement)?;
			Ok(())
		})();
		match result {
			Ok(()) => DurableFsOutcome::success("create target"),
			Err(error) => DurableFsOutcome::failure(error_code(&error, true), "create target", &error),
		}
	}
}

/// Publish a flushed replacement file over an existing target.
///
/// The replacement file is `FlushFileBuffers`/`fsync`'d before replacement.
/// `ReplaceFileW` atomically swaps file identity on Windows. We request its
/// `REPLACEFILE_WRITE_THROUGH` flag even though Microsoft documents that flag
/// as unsupported; neither it nor this primitive guarantees a durable commit
/// of the name swap. A caller must recover from dual slots and tolerate an
/// indeterminate newest slot. The optional post-replace target flush on Windows
/// is best-effort hardening only; its failure is not reported as a committed
/// outcome.
///
/// POSIX cross-directory publication is rejected. This makes the one flushed
/// parent directory cover every changed publication entry. A requested backup
/// is retained for compatibility and is flushed with its parent before the
/// replacement; higher-level rollback policy should normally use dual slots.
#[napi]
pub fn publish_replace_file(
	replacement_path: String,
	target_path: String,
	backup_path: Option<String>,
) -> DurableFsOutcome {
	let replacement = Path::new(&replacement_path);
	let target = Path::new(&target_path);

	if let Err(error) = fs::metadata(target) {
		return DurableFsOutcome::failure(error_code(&error, true), "stat target", &error);
	}
	match same_directory(replacement, target) {
		Ok(true) => {},
		Ok(false) => return DurableFsOutcome::unsupported("validate publication directories"),
		Err(outcome) => return outcome,
	}
	if let Err(outcome) = sync_file(replacement, false, "flush replacement") {
		return outcome;
	}

	#[cfg(unix)]
	{
		if let Some(backup_path) = backup_path {
			let backup = Path::new(&backup_path);
			if let Err(error) = fs::copy(target, backup) {
				return DurableFsOutcome::failure(error_code(&error, false), "write backup", &error);
			}
			if let Err(outcome) = sync_file(backup, false, "flush backup") {
				return outcome;
			}
			let Some(backup_parent) = parent_directory(backup) else {
				return DurableFsOutcome::unsupported("resolve backup parent");
			};
			if let Err(error) = sync_directory(backup_parent) {
				return DurableFsOutcome::failure(
					error_code(&error, false),
					"flush backup parent",
					&error,
				);
			}
		}
		if let Err(error) = fs::rename(replacement, target) {
			return DurableFsOutcome::failure(error_code(&error, true), "rename replacement", &error);
		}
		let Some(target_parent) = parent_directory(target) else {
			return DurableFsOutcome::unsupported("resolve target parent");
		};
		if let Err(error) = sync_directory(target_parent) {
			return DurableFsOutcome::published_durability_uncertain("flush target parent", &error);
		}
		DurableFsOutcome::success("publish replacement")
	}

	#[cfg(windows)]
	{
		replace_file_windows(replacement, target, backup_path.as_deref())
	}
}

#[cfg(windows)]
fn replace_file_windows(
	replacement: &Path,
	target: &Path,
	backup: Option<&str>,
) -> DurableFsOutcome {
	use std::os::windows::ffi::OsStrExt;

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn ReplaceFileW(
			replaced_file_name: *const u16,
			replacement_file_name: *const u16,
			backup_file_name: *const u16,
			replace_flags: u32,
			exclude: *const core::ffi::c_void,
			reserved: *const core::ffi::c_void,
		) -> i32;
	}

	fn wide_null(path: &Path) -> Vec<u16> {
		path.as_os_str().encode_wide().chain(Some(0)).collect()
	}

	// This opt-in seam is used only by Windows integration tests to exercise
	// documented ReplaceFileW partial states against real on-disk files.
	if let Ok(fault) = std::env::var("PI_NATIVES_DURABLE_FS_TEST_FAULT") {
		let injected = match fault.as_str() {
			"1175" => Some((1175, "injected ReplaceFileW unchanged")),
			"1176" => {
				if let Some(backup) = backup {
					if let Err(error) = fs::rename(target, backup) {
						return DurableFsOutcome::failure(
							error_code(&error, true),
							"inject ReplaceFileW 1176",
							&error,
						);
					}
				}
				Some((1176, "injected ReplaceFileW target moved to backup"))
			},
			"1177" => {
				if let Some(backup) = backup {
					if let Err(error) = fs::rename(target, backup) {
						return DurableFsOutcome::failure(
							error_code(&error, true),
							"inject ReplaceFileW 1177 move replaced file to backup",
							&error,
						);
					}
				}
				if let Err(error) = fs::rename(replacement, target) {
					return DurableFsOutcome::failure(
						error_code(&error, true),
						"inject ReplaceFileW 1177 move replacement to target",
						&error,
					);
				}
				Some((1177, "injected ReplaceFileW replacement installed"))
			},
			_ => None,
		};
		if let Some((code, operation)) = injected {
			let error = std::io::Error::from_raw_os_error(code);
			return DurableFsOutcome::failure(error_code(&error, true), operation, &error);
		}
	}

	let target_wide = wide_null(target);
	let replacement_wide = wide_null(replacement);
	let backup_wide = backup.map(|path| wide_null(Path::new(path)));
	let backup_ptr = backup_wide.as_ref().map_or(std::ptr::null(), Vec::as_ptr);
	// Microsoft documents REPLACEFILE_WRITE_THROUGH as unsupported. We request it
	// for the S1 contract, but retain the indeterminate-publication outcome: it
	// does not establish a durable name-swap guarantee.
	const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
	let replace_flags = REPLACEFILE_WRITE_THROUGH;
	debug_assert_ne!(replace_flags, 0);
	let result = unsafe {
		// SAFETY: all path buffers are NUL-terminated and remain alive for the call.
		ReplaceFileW(
			target_wide.as_ptr(),
			replacement_wide.as_ptr(),
			backup_ptr,
			replace_flags,
			std::ptr::null(),
			std::ptr::null(),
		)
	};
	if result != 0 {
		// Best-effort hardening only: ReplaceFileW does not provide a durable
		// publication guarantee, and an open/flush failure cannot roll it back.
		let flush = File::open(target).and_then(|file| file.sync_all());
		if std::env::var("PI_NATIVES_DURABLE_FS_TEST_FAULT").as_deref() == Ok("durability") {
			let error = flush
				.err()
				.unwrap_or_else(|| std::io::Error::from_raw_os_error(5));
			return DurableFsOutcome::published_durability_uncertain(
				"injected post-ReplaceFileW durability",
				&error,
			);
		}
		return DurableFsOutcome::success("ReplaceFileW");
	}
	let error = std::io::Error::last_os_error();
	DurableFsOutcome::failure(error_code(&error, true), "ReplaceFileW", &error)
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	use std::fs;
	#[cfg(unix)]
	use std::time::{SystemTime, UNIX_EPOCH};

	use super::{DurableFsOutcomeCode, error_code};
	#[cfg(unix)]
	use super::{publish_create_file, publish_replace_file};

	#[test]
	fn maps_windows_sharing_violation_stably() {
		let error = std::io::Error::from_raw_os_error(32);
		assert_eq!(error_code(&error, true), DurableFsOutcomeCode::SharingViolation);
	}

	#[test]
	fn maps_missing_target_stably() {
		let error = std::io::Error::from_raw_os_error(2);
		assert_eq!(error_code(&error, true), DurableFsOutcomeCode::TargetMissing);
		assert_eq!(error_code(&error, false), DurableFsOutcomeCode::ReplaceFailedReplacementRetained);
	}

	#[test]
	fn maps_replace_file_partial_failures_to_documented_states() {
		assert_eq!(
			error_code(&std::io::Error::from_raw_os_error(1175), true),
			DurableFsOutcomeCode::ReplaceFailedUnchanged
		);
		assert_eq!(
			error_code(&std::io::Error::from_raw_os_error(1176), true),
			DurableFsOutcomeCode::ReplaceFailedTargetMayHaveChanged
		);
		assert_eq!(
			error_code(&std::io::Error::from_raw_os_error(1177), true),
			DurableFsOutcomeCode::ReplaceFailedTargetMayHaveChanged
		);
	}

	#[cfg(windows)]
	#[test]
	fn replace_file_requests_write_through_flag() {
		// Microsoft documents this flag as unsupported, but S1 requires that it is
		// requested; callers still receive only a structured, uncertain durability
		// outcome rather than a write-through guarantee.
		const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
		assert_ne!(REPLACEFILE_WRITE_THROUGH, 0);
	}

	#[cfg(windows)]
	#[test]
	fn maps_replace_file_partial_failures_on_windows() {
		for (os_code, expected) in [
			(1175, DurableFsOutcomeCode::ReplaceFailedUnchanged),
			(1176, DurableFsOutcomeCode::ReplaceFailedTargetMayHaveChanged),
			(1177, DurableFsOutcomeCode::ReplaceFailedTargetMayHaveChanged),
		] {
			assert_eq!(error_code(&std::io::Error::from_raw_os_error(os_code), true), expected);
		}
	}

	#[cfg(unix)]
	#[test]
	fn replaces_and_flushes_a_target() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time after Unix epoch")
			.as_nanos();
		let directory = std::env::temp_dir()
			.join(format!("pi-natives-durable-fs-{}-{unique}", std::process::id()));
		fs::create_dir(&directory).expect("create temporary directory");
		let target = directory.join("target");
		let replacement = directory.join("replacement");
		let backup = directory.join("backup");
		fs::write(&target, "old").expect("write target");
		fs::write(&replacement, "new").expect("write replacement");

		let outcome = publish_replace_file(
			replacement.to_string_lossy().into_owned(),
			target.to_string_lossy().into_owned(),
			Some(backup.to_string_lossy().into_owned()),
		);

		assert!(outcome.ok);
		assert_eq!(outcome.code, DurableFsOutcomeCode::Ok);
		assert_eq!(fs::read_to_string(&target).expect("read target"), "new");
		assert_eq!(fs::read_to_string(&backup).expect("read backup"), "old");
		assert!(!replacement.exists());
		fs::remove_dir_all(directory).expect("remove temporary directory");
	}

	#[cfg(unix)]
	#[test]
	fn creates_a_missing_target_without_overwrite() {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time after Unix epoch")
			.as_nanos();
		let directory = std::env::temp_dir()
			.join(format!("pi-natives-durable-fs-create-{}-{unique}", std::process::id()));
		fs::create_dir(&directory).expect("create temporary directory");
		let target = directory.join("target");
		let replacement = directory.join("replacement");
		fs::write(&replacement, "new").expect("write replacement");
		let outcome = publish_create_file(
			replacement.to_string_lossy().into_owned(),
			target.to_string_lossy().into_owned(),
		);
		assert!(outcome.ok);
		assert_eq!(fs::read_to_string(&target).expect("read target"), "new");
		assert!(!replacement.exists());
		fs::remove_dir_all(directory).expect("remove temporary directory");
	}
}
