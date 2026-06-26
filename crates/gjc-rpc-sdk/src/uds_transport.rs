//! Phase 3 (G004): tokio UDS transport binding the length-delimited frame codec.
//!
//! Provides a securely-bound `UnixListener`, async frame read/write over a
//! `UnixStream` using [`crate::uds_codec`], and peer-credential principal
//! derivation for an accepted connection. This is the concrete external transport
//! edge; the daemon (registry/hello/authz/redaction) layers on top. Unix-only.

use std::os::unix::io::AsRawFd;
use std::path::Path;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use crate::authz::Principal;
use crate::frame::GjcFrame;
use crate::peer_cred::{self, PeerCredError};
use crate::uds_codec::{CodecError, FrameDecoder, encode};

/// UDS transport failure modes.
#[derive(Debug)]
pub enum TransportError {
	Io(std::io::Error),
	Codec(CodecError),
	/// The peer closed mid-frame, leaving buffered bytes that never completed a
	/// frame — a protocol error, not a clean close.
	TruncatedFrame {
		buffered: usize,
	},
	/// Refused to bind: the socket path or its parent directory is not safely owned.
	InsecureSocketPath(String),
}

impl std::fmt::Display for TransportError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Io(e) => write!(f, "uds io error: {e}"),
			Self::Codec(e) => write!(f, "uds codec error: {e}"),
			Self::TruncatedFrame { buffered } => {
				write!(f, "uds peer closed mid-frame with {buffered} buffered bytes")
			},
			Self::InsecureSocketPath(why) => write!(f, "refusing to bind insecure socket path: {why}"),
		}
	}
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
	fn from(e: std::io::Error) -> Self {
		Self::Io(e)
	}
}
impl From<CodecError> for TransportError {
	fn from(e: CodecError) -> Self {
		Self::Codec(e)
	}
}

/// Securely bind a private UDS listener at `path`.
///
/// Validates the path and its parent directory are safely owned (owner-only, no
/// group/other access) and that an existing path is a stale SOCKET (never
/// clobbering a regular file). The bound socket is restricted to owner-only
/// (`0o600`).
pub fn secure_bind(path: &Path) -> Result<UnixListener, TransportError> {
	use std::os::unix::fs::{MetadataExt, PermissionsExt};

	// SAFETY: getuid() is always-successful and thread-safe; it returns the real uid.
	let me = unsafe { libc::getuid() };

	// Parent directory must exist, be owned by us, and grant no group/other access.
	let parent = path
		.parent()
		.ok_or_else(|| TransportError::InsecureSocketPath("no parent dir".into()))?;
	let pmeta = std::fs::metadata(parent).map_err(TransportError::Io)?;
	if !pmeta.is_dir() {
		return Err(TransportError::InsecureSocketPath("parent is not a directory".into()));
	}
	if pmeta.uid() != me {
		return Err(TransportError::InsecureSocketPath(
			"parent dir not owned by current user".into(),
		));
	}
	if pmeta.permissions().mode() & 0o077 != 0 {
		return Err(TransportError::InsecureSocketPath(
			"parent dir is group/other accessible".into(),
		));
	}

	// Only unlink a pre-existing path if it is actually a socket (a stale endpoint),
	// owned by us — never clobber a regular file or another user's node.
	match std::fs::symlink_metadata(path) {
		Ok(meta) => {
			let is_socket = (meta.mode() & u32::from(libc::S_IFMT)) == u32::from(libc::S_IFSOCK);
			if !is_socket {
				return Err(TransportError::InsecureSocketPath("existing path is not a socket".into()));
			}
			if meta.uid() != me {
				return Err(TransportError::InsecureSocketPath(
					"existing socket not owned by current user".into(),
				));
			}
			std::fs::remove_file(path).map_err(TransportError::Io)?;
		},
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
		Err(e) => return Err(TransportError::Io(e)),
	}

	let listener = UnixListener::bind(path).map_err(TransportError::Io)?;
	std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
		.map_err(TransportError::Io)?;
	Ok(listener)
}

/// Derive the calling principal from an accepted connection's peer credentials.
/// Fails closed when the platform has no peer-credential API.
pub fn peer_principal(stream: &UnixStream) -> Result<Principal, PeerCredError> {
	let peer = peer_cred::peer_identity_from_fd(stream.as_raw_fd())?;
	peer_cred::derive_principal(peer, false)
}

/// Write a single frame to the stream (length-delimited JSON).
pub async fn write_frame<W: AsyncWriteExt + Unpin>(
	w: &mut W,
	frame: &GjcFrame,
) -> Result<(), TransportError> {
	let bytes = encode(frame)?;
	w.write_all(&bytes).await?;
	w.flush().await?;
	Ok(())
}

/// Read the next whole frame from the stream, reassembling partial reads via
/// `decoder`. Returns `Ok(None)` on clean EOF before a full frame.
pub async fn read_frame<R: AsyncReadExt + Unpin>(
	r: &mut R,
	decoder: &mut FrameDecoder,
) -> Result<Option<GjcFrame>, TransportError> {
	loop {
		if let Some(frame) = decoder.next_frame()? {
			return Ok(Some(frame));
		}
		let mut chunk = [0u8; 8192];
		let n = r.read(&mut chunk).await?;
		if n == 0 {
			// Clean EOF only when nothing is half-buffered. Buffered bytes that
			// never formed a frame mean the peer closed mid-frame -> protocol error.
			if decoder.buffered() > 0 {
				return Err(TransportError::TruncatedFrame { buffered: decoder.buffered() });
			}
			return Ok(None);
		}
		decoder.push(&chunk[..n]);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::frame::{FrameKind, GjcFrame};
	use crate::logical_equality::logically_equal;
	use crate::{Direction, FrameId, PROTOCOL_VERSION, Seq, SessionId};
	use std::os::unix::fs::PermissionsExt;

	fn frame(seq: u64) -> GjcFrame {
		GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId(format!("f{seq}")),
			session_id: SessionId("s".into()),
			seq: Seq(seq),
			direction: Direction::ServerToClient,
			kind: FrameKind::Event,
			r#type: "message_update".into(),
			correlation_id: None,
			replay: false,
			capability_scope: None,
			payload: serde_json::json!({"hello": "uds"}),
		}
	}

	fn temp_sock_path() -> std::path::PathBuf {
		let mut p = std::env::temp_dir();
		let uniq = format!("gjc-rpc-sdk-test-{}.sock", std::process::id());
		p.push(uniq);
		p
	}

	#[test]
	fn secure_bind_refuses_insecure_parent_dir() {
		let mut dir = std::env::temp_dir();
		dir.push(format!("gjc-rpc-sdk-test-insecure-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir(&dir).expect("create temp dir");
		std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777))
			.expect("chmod temp dir");
		let path = dir.join("daemon.sock");

		let got = secure_bind(&path);
		assert!(matches!(got, Err(TransportError::InsecureSocketPath(_))));

		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn secure_bind_refuses_regular_file_at_path() {
		let mut dir = std::env::temp_dir();
		dir.push(format!("gjc-rpc-sdk-test-regular-file-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir(&dir).expect("create temp dir");
		std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
			.expect("chmod temp dir");
		let path = dir.join("daemon.sock");
		std::fs::write(&path, b"").expect("create regular file");

		let got = secure_bind(&path);
		assert!(matches!(got, Err(TransportError::InsecureSocketPath(_))));

		let _ = std::fs::remove_dir_all(&dir);
	}

	#[tokio::test]
	async fn uds_round_trip_and_peer_principal() {
		let path = temp_sock_path();
		let listener = secure_bind(&path).expect("bind");

		// Server: accept one connection, derive the peer principal, echo one frame.
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let principal = peer_principal(&stream).expect("peer principal");
			let mut dec = FrameDecoder::new();
			let got = read_frame(&mut stream, &mut dec)
				.await
				.expect("read")
				.expect("frame");
			write_frame(&mut stream, &got).await.expect("echo");
			principal
		});

		// Client: connect, send a frame, read the echo.
		let mut client = UnixStream::connect(&path).await.expect("connect");
		let sent = frame(42);
		write_frame(&mut client, &sent).await.expect("send");
		let mut dec = FrameDecoder::new();
		let echoed = read_frame(&mut client, &mut dec)
			.await
			.expect("read echo")
			.expect("echoed frame");

		assert!(logically_equal(&sent, &echoed));

		let principal = server.await.expect("server task");
		// On a real unix host the peer principal is our own uid (Unix principal).
		match principal {
			Principal::Unix { uid, .. } => {
				// SAFETY: getuid is always-succeeds and thread-safe.
				let me = unsafe { libc::getuid() };
				assert_eq!(uid, me);
			},
			other => panic!("expected Unix principal, got {other:?}"),
		}

		let _ = std::fs::remove_file(&path);
	}

	#[tokio::test]
	async fn clean_eof_returns_none() {
		let path = temp_sock_path();
		let path = path.with_extension("eof.sock");
		let listener = secure_bind(&path).expect("bind");
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let mut dec = FrameDecoder::new();
			read_frame(&mut stream, &mut dec).await.expect("read")
		});
		// Client connects then immediately closes without sending a frame.
		let client = UnixStream::connect(&path).await.expect("connect");
		drop(client);
		let got = server.await.expect("server task");
		assert!(got.is_none());
		let _ = std::fs::remove_file(&path);
	}

	#[tokio::test]
	async fn truncated_frame_at_eof_is_protocol_error() {
		let path = temp_sock_path().with_extension("trunc.sock");
		let listener = secure_bind(&path).expect("bind");
		let server = tokio::spawn(async move {
			let (mut stream, _addr) = listener.accept().await.expect("accept");
			let mut dec = FrameDecoder::new();
			read_frame(&mut stream, &mut dec).await
		});
		// Send a 4-byte length prefix declaring a body, then close before the body.
		let mut client = UnixStream::connect(&path).await.expect("connect");
		client
			.write_all(&16u32.to_be_bytes())
			.await
			.expect("write prefix");
		client.flush().await.expect("flush");
		drop(client);
		let got = server.await.expect("server task");
		assert!(matches!(got, Err(TransportError::TruncatedFrame { buffered: 4 })));
		let _ = std::fs::remove_file(&path);
	}
}
