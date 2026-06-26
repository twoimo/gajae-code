//! Phase 3 (G004): length-delimited JSON frame codec for the UDS transport.
//!
//! Each `GjcFrame` is encoded as a 4-byte big-endian length prefix followed by the
//! UTF-8 JSON body (`protocol.md` A1). The decoder is a sync accumulator: it
//! handles partial reads, multiple frames per buffer, and rejects an oversized
//! length prefix BEFORE allocating (DoS guard). Transport I/O (tokio) layers on
//! top; keeping the codec sync makes it fully unit-testable without a socket.

use crate::frame::GjcFrame;

/// Max encoded frame body size (8 MiB). A length prefix above this is rejected
/// before any allocation, so a hostile peer cannot force a huge buffer.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

const LEN_PREFIX: usize = 4;

/// Codec failure modes.
#[derive(Debug)]
pub enum CodecError {
	/// A length prefix exceeded `MAX_FRAME_BYTES` (rejected before allocation).
	Oversized { declared: usize, max: usize },
	/// The frame body was not valid JSON for a `GjcFrame`.
	Json(serde_json::Error),
}

impl std::fmt::Display for CodecError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Oversized { declared, max } => {
				write!(f, "frame length {declared} exceeds max {max}")
			},
			Self::Json(e) => write!(f, "frame JSON error: {e}"),
		}
	}
}

impl std::error::Error for CodecError {}

/// Encode a frame into `[u32 BE length][json body]`.
pub fn encode(frame: &GjcFrame) -> Result<Vec<u8>, CodecError> {
	let body = serde_json::to_vec(frame).map_err(CodecError::Json)?;
	if body.len() > MAX_FRAME_BYTES {
		return Err(CodecError::Oversized { declared: body.len(), max: MAX_FRAME_BYTES });
	}
	let mut out = Vec::with_capacity(LEN_PREFIX + body.len());
	out.extend_from_slice(&(body.len() as u32).to_be_bytes());
	out.extend_from_slice(&body);
	Ok(out)
}

/// Streaming decoder: push bytes as they arrive, pull whole frames out.
#[derive(Debug, Default)]
pub struct FrameDecoder {
	buf: Vec<u8>,
}

impl FrameDecoder {
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Append freshly-read bytes (may contain zero, partial, one, or many frames).
	pub fn push(&mut self, bytes: &[u8]) {
		self.buf.extend_from_slice(bytes);
	}

	/// Pull the next complete frame, or `Ok(None)` if more bytes are needed.
	/// Rejects an oversized declared length before allocating the body.
	pub fn next_frame(&mut self) -> Result<Option<GjcFrame>, CodecError> {
		if self.buf.len() < LEN_PREFIX {
			return Ok(None);
		}
		let declared =
			u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
		if declared > MAX_FRAME_BYTES {
			return Err(CodecError::Oversized { declared, max: MAX_FRAME_BYTES });
		}
		if self.buf.len() < LEN_PREFIX + declared {
			return Ok(None); // partial body; wait for more bytes
		}
		let body = self.buf[LEN_PREFIX..LEN_PREFIX + declared].to_vec();
		self.buf.drain(..LEN_PREFIX + declared);
		let frame: GjcFrame = serde_json::from_slice(&body).map_err(CodecError::Json)?;
		Ok(Some(frame))
	}

	/// Bytes currently buffered (not yet a complete frame).
	#[must_use]
	pub const fn buffered(&self) -> usize {
		self.buf.len()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::frame::{FrameKind, GjcFrame};
	use crate::{Direction, FrameId, PROTOCOL_VERSION, Seq, SessionId};

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
			payload: serde_json::json!({"n": seq}),
		}
	}

	#[test]
	fn encode_decode_round_trip() {
		let f = frame(1);
		let bytes = encode(&f).unwrap();
		let mut d = FrameDecoder::new();
		d.push(&bytes);
		assert_eq!(d.next_frame().unwrap(), Some(f));
		assert_eq!(d.next_frame().unwrap(), None);
		assert_eq!(d.buffered(), 0);
	}

	#[test]
	fn multiple_frames_in_one_buffer() {
		let mut bytes = encode(&frame(1)).unwrap();
		bytes.extend(encode(&frame(2)).unwrap());
		let mut d = FrameDecoder::new();
		d.push(&bytes);
		assert_eq!(d.next_frame().unwrap().unwrap().seq, Seq(1));
		assert_eq!(d.next_frame().unwrap().unwrap().seq, Seq(2));
		assert_eq!(d.next_frame().unwrap(), None);
	}

	#[test]
	fn partial_reads_are_reassembled() {
		let bytes = encode(&frame(7)).unwrap();
		let mut d = FrameDecoder::new();
		// Feed one byte at a time: no frame until the last byte arrives.
		for (i, b) in bytes.iter().enumerate() {
			d.push(&[*b]);
			let got = d.next_frame().unwrap();
			if i + 1 < bytes.len() {
				assert!(got.is_none(), "frame emitted early at byte {i}");
			} else {
				assert_eq!(got.unwrap().seq, Seq(7));
			}
		}
	}

	#[test]
	fn oversized_length_prefix_rejected_before_alloc() {
		let mut d = FrameDecoder::new();
		// Declare a length above the max with only the 4-byte prefix present:
		// must reject without waiting for (or allocating) the body.
		let huge = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
		d.push(&huge);
		match d.next_frame() {
			Err(CodecError::Oversized { declared, max }) => {
				assert_eq!(declared, MAX_FRAME_BYTES + 1);
				assert_eq!(max, MAX_FRAME_BYTES);
			},
			other => panic!("expected Oversized, got {other:?}"),
		}
	}

	#[test]
	fn malformed_json_body_rejected() {
		let mut d = FrameDecoder::new();
		let body = b"not json";
		d.push(&(body.len() as u32).to_be_bytes());
		d.push(body);
		assert!(matches!(d.next_frame(), Err(CodecError::Json(_))));
	}
}
