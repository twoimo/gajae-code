//! Phase 3 (G004): UDS peer-credential principal derivation.
//!
//! Derives a `Principal::Unix` from a connected unix-domain socket using
//! `SO_PEERCRED` (Linux) or `getpeereid` (macOS/BSD). Platforms without a
//! supported peer-credential API FAIL CLOSED — they never fall through to an
//! unauthenticated principal — and the local bearer fallback is OFF by default
//! (`authz.md`). The syscall layer is isolated so the mapping + fail-closed policy
//! are unit-testable without a live socket.

use crate::authz::Principal;

/// Peer credentials read from a connected UDS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerIdentity {
	pub uid: u32,
	pub gid: u32,
	/// Present on Linux (`SO_PEERCRED`); absent on macOS/BSD (`getpeereid`).
	pub pid: Option<u32>,
}

/// Why peer-credential authentication failed (always denies — fail closed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerCredError {
	/// The platform has no supported peer-credential API and bearer fallback is off.
	UnsupportedPlatformFailClosed,
	/// The peer-credential syscall failed for a connected socket.
	Syscall(String),
}

impl std::fmt::Display for PeerCredError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::UnsupportedPlatformFailClosed => {
				f.write_str("peer credentials unsupported on this platform; failing closed")
			},
			Self::Syscall(e) => write!(f, "peer-credential syscall failed: {e}"),
		}
	}
}

impl std::error::Error for PeerCredError {}

/// Map verified peer credentials to a `Principal`.
#[must_use]
pub const fn principal_from_peer(peer: PeerIdentity) -> Principal {
	Principal::Unix { uid: peer.uid, gid: peer.gid, pid: peer.pid }
}

/// Policy gate: turn a (possibly absent) peer identity into a principal.
///
/// Fails closed when no peer identity is available and the bearer fallback is
/// disabled. This is the single decision point the daemon calls after the syscall
/// layer. Bearer fallback is an explicit opt-in (default off); even when enabled,
/// the caller must supply a verified bearer principal separately, so absence of
/// peer credentials here always denies.
pub const fn derive_principal(
	peer: Option<PeerIdentity>,
	bearer_fallback_enabled: bool,
) -> Result<Principal, PeerCredError> {
	let _ = bearer_fallback_enabled;
	if let Some(p) = peer {
		Ok(principal_from_peer(p))
	} else {
		Err(PeerCredError::UnsupportedPlatformFailClosed)
	}
}

/// Read peer credentials from a connected unix socket file descriptor.
///
/// Returns `Ok(Some(..))` on a supported platform, `Ok(None)` on an unsupported
/// platform (so the caller fails closed via [`derive_principal`]), and `Err` only
/// when a supported syscall itself fails.
#[cfg(all(unix, target_os = "linux"))]
pub fn peer_identity_from_fd(
	fd: std::os::unix::io::RawFd,
) -> Result<Option<PeerIdentity>, PeerCredError> {
	// SAFETY: ucred is a POD struct; getsockopt fills it for a connected AF_UNIX socket.
	use std::mem;
	let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
	let mut len = mem::size_of::<libc::ucred>() as libc::socklen_t;
	let rc = unsafe {
		libc::getsockopt(
			fd,
			libc::SOL_SOCKET,
			libc::SO_PEERCRED,
			std::ptr::from_mut(&mut cred).cast::<libc::c_void>(),
			&mut len,
		)
	};
	if rc != 0 {
		return Err(PeerCredError::Syscall(std::io::Error::last_os_error().to_string()));
	}
	Ok(Some(PeerIdentity { uid: cred.uid, gid: cred.gid, pid: Some(cred.pid as u32) }))
}

#[cfg(all(
	unix,
	any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "openbsd")
))]
pub fn peer_identity_from_fd(
	fd: std::os::unix::io::RawFd,
) -> Result<Option<PeerIdentity>, PeerCredError> {
	let mut uid: libc::uid_t = 0;
	let mut gid: libc::gid_t = 0;
	// SAFETY: getpeereid writes uid/gid for a connected AF_UNIX socket.
	let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
	if rc != 0 {
		return Err(PeerCredError::Syscall(std::io::Error::last_os_error().to_string()));
	}
	Ok(Some(PeerIdentity { uid, gid, pid: None }))
}

#[cfg(not(all(
	unix,
	any(
		target_os = "linux",
		target_os = "macos",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "openbsd"
	)
)))]
pub fn peer_identity_from_fd(
	_fd: std::os::unix::io::RawFd,
) -> Result<Option<PeerIdentity>, PeerCredError> {
	// Unsupported platform (e.g. Windows): no peer-credential API. Fail closed.
	Ok(None)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn peer_cred_linux_so_peercred_maps_uid_gid_pid() {
		let p = principal_from_peer(PeerIdentity { uid: 501, gid: 20, pid: Some(4242) });
		assert_eq!(p, Principal::Unix { uid: 501, gid: 20, pid: Some(4242) });
	}

	#[test]
	fn peer_cred_macos_getpeereid_maps_uid_gid_no_pid() {
		let p = principal_from_peer(PeerIdentity { uid: 501, gid: 20, pid: None });
		assert_eq!(p, Principal::Unix { uid: 501, gid: 20, pid: None });
	}

	#[test]
	fn peer_cred_unsupported_platform_fails_closed_before_grant_lookup() {
		// No peer identity (unsupported platform / syscall returned None) -> deny.
		assert_eq!(derive_principal(None, false), Err(PeerCredError::UnsupportedPlatformFailClosed));
	}

	#[test]
	fn peer_cred_bearer_fallback_disabled_by_default_fails_closed() {
		// Even with the flag toggled, absent peer creds + no separately-verified
		// bearer principal still denies here (fail closed).
		assert_eq!(derive_principal(None, true), Err(PeerCredError::UnsupportedPlatformFailClosed));
	}

	#[test]
	fn supported_peer_identity_derives_principal() {
		let got = derive_principal(Some(PeerIdentity { uid: 7, gid: 8, pid: Some(9) }), false);
		assert_eq!(got, Ok(Principal::Unix { uid: 7, gid: 8, pid: Some(9) }));
	}
}
