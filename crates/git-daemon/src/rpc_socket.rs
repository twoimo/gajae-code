//! gjc-rpc client over an async byte stream.
//!
//! Generic over any `AsyncRead + AsyncWrite` so the send/receive + JSONL
//! buffering logic is fully testable with an in-memory `tokio::io::duplex` pipe
//! (no real socket needed). The only live-only piece is
//! [`RpcClient::connect_unix`], a one-line `UnixStream::connect`. Commands are
//! framed via [`crate::rpc_framing`]; inbound bytes are buffered and split into
//! JSON frames.

use std::collections::VecDeque;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{
	forge_adapter::ForgeError,
	rpc_framing::{decode_frames, encode_frame},
};

/// A JSONL gjc-rpc client over a duplex byte stream.
pub struct RpcClient<S> {
	stream:  S,
	/// Raw byte buffer: bytes are only UTF-8-decoded once a full line is
	/// present, so a multi-byte character split across two socket reads is
	/// never corrupted.
	buf:     Vec<u8>,
	pending: VecDeque<Value>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> RpcClient<S> {
	/// Wrap an existing connected stream.
	pub const fn new(stream: S) -> Self {
		Self { stream, buf: Vec::new(), pending: VecDeque::new() }
	}

	/// Send a command as one JSONL frame.
	///
	/// # Errors
	/// Returns [`ForgeError::Transient`] on a write failure.
	pub async fn send(&mut self, command: &Value) -> Result<(), ForgeError> {
		let frame = encode_frame(command);
		self
			.stream
			.write_all(frame.as_bytes())
			.await
			.map_err(|e| ForgeError::Transient(format!("rpc write: {e}")))?;
		self
			.stream
			.flush()
			.await
			.map_err(|e| ForgeError::Transient(format!("rpc flush: {e}")))
	}

	/// Read the next JSON frame, buffering partial reads. Returns `None` at EOF.
	///
	/// # Errors
	/// Returns [`ForgeError::Transient`] on a read or frame-decode failure.
	pub async fn next_frame(&mut self) -> Result<Option<Value>, ForgeError> {
		loop {
			if let Some(frame) = self.pending.pop_front() {
				return Ok(Some(frame));
			}
			let mut chunk = [0u8; 4096];
			let n = self
				.stream
				.read(&mut chunk)
				.await
				.map_err(|e| ForgeError::Transient(format!("rpc read: {e}")))?;
			if n == 0 {
				return Ok(None); // EOF
			}
			self.buf.extend_from_slice(&chunk[..n]);
			// Only decode up to the last complete line so a multi-byte character
			// split across reads is never truncated mid-decode.
			if let Some(pos) = self.buf.iter().rposition(|&b| b == b'\n') {
				let complete = std::str::from_utf8(&self.buf[..=pos])
					.map_err(|e| ForgeError::Transient(format!("rpc utf8: {e}")))?;
				let (frames, _leftover) = decode_frames(complete).map_err(ForgeError::Transient)?;
				self.pending.extend(frames);
				self.buf.drain(..=pos);
			}
		}
	}
}

impl RpcClient<tokio::net::UnixStream> {
	/// Connect to a gjc-rpc Unix socket. (Live-only; no offline test.)
	///
	/// # Errors
	/// Returns [`ForgeError::Transient`] if the socket cannot be connected.
	pub async fn connect_unix(path: &str) -> Result<Self, ForgeError> {
		let stream = tokio::net::UnixStream::connect(path)
			.await
			.map_err(|e| ForgeError::Transient(format!("rpc connect {path}: {e}")))?;
		Ok(Self::new(stream))
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;
	use tokio::io::{AsyncReadExt, AsyncWriteExt};

	use super::*;

	#[tokio::test]
	async fn send_writes_a_jsonl_frame() {
		let (client_side, mut peer) = tokio::io::duplex(1024);
		let mut client = RpcClient::new(client_side);
		client.send(&json!({ "type": "abort" })).await.unwrap();
		let mut buf = [0u8; 128];
		let n = peer.read(&mut buf).await.unwrap();
		let got = String::from_utf8_lossy(&buf[..n]);
		assert!(got.ends_with('\n'));
		let parsed: Value = serde_json::from_str(got.trim()).unwrap();
		assert_eq!(parsed["type"], "abort");
	}

	#[tokio::test]
	async fn next_frame_reads_split_and_multiple_frames() {
		let (client_side, mut peer) = tokio::io::duplex(1024);
		let mut client = RpcClient::new(client_side);
		// Peer writes two frames, the first split across two writes.
		peer.write_all(b"{\"id\":\"1\",\"ty").await.unwrap();
		peer
			.write_all(b"pe\":\"response\"}\n{\"id\":\"2\"}\n")
			.await
			.unwrap();
		let f1 = client.next_frame().await.unwrap().unwrap();
		assert_eq!(f1["id"], "1");
		assert_eq!(f1["type"], "response");
		let f2 = client.next_frame().await.unwrap().unwrap();
		assert_eq!(f2["id"], "2");
	}

	#[tokio::test]
	async fn next_frame_handles_multibyte_char_split_across_reads() {
		let (client_side, mut peer) = tokio::io::duplex(1024);
		let mut client = RpcClient::new(client_side);
		// A frame whose JSON string contains a multi-byte char (Korean + emoji),
		// with the byte stream split THROUGH a multi-byte char boundary.
		let frame =
			serde_json::to_vec(&json!({ "type": "response", "msg": "한국어 🦀 ok" })).unwrap();
		let mut bytes = frame.clone();
		bytes.push(b'\n');
		// Find a split point in the middle of the multi-byte content.
		let split = frame.len() / 2;
		peer.write_all(&bytes[..split]).await.unwrap();
		peer.flush().await.unwrap();
		peer.write_all(&bytes[split..]).await.unwrap();
		peer.flush().await.unwrap();
		let f = client.next_frame().await.unwrap().unwrap();
		assert_eq!(f["type"], "response");
		assert_eq!(f["msg"], "한국어 🦀 ok", "split multi-byte UTF-8 must decode intact");
	}

	#[tokio::test]
	async fn next_frame_returns_none_at_eof() {
		let (client_side, peer) = tokio::io::duplex(1024);
		let mut client = RpcClient::new(client_side);
		drop(peer); // close the far end
		assert_eq!(client.next_frame().await.unwrap(), None);
	}

	#[tokio::test]
	async fn round_trips_a_command_then_response() {
		let (client_side, mut peer) = tokio::io::duplex(1024);
		let mut client = RpcClient::new(client_side);
		client
			.send(&json!({ "id": "x", "type": "get_session_stats" }))
			.await
			.unwrap();
		// Peer reads the command and replies with a framed response.
		let mut buf = [0u8; 256];
		let n = peer.read(&mut buf).await.unwrap();
		assert!(String::from_utf8_lossy(&buf[..n]).contains("get_session_stats"));
		peer
			.write_all(b"{\"id\":\"x\",\"type\":\"response\",\"success\":true}\n")
			.await
			.unwrap();
		let resp = client.next_frame().await.unwrap().unwrap();
		assert_eq!(resp["success"], true);
	}
}
