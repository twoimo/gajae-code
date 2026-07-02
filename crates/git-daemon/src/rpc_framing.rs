//! gjc-rpc JSONL frame encode/decode.
//!
//! The gjc-rpc wire format is one JSON object per line terminated by `\n`
//! (see docs/rpc.md). This module is the pure framing layer used by the socket
//! transport: it encodes a command value to a single newline-terminated frame
//! and decodes inbound lines into JSON values, skipping blank lines. The actual
//! socket read/write loop is the thin live piece layered on top.

use serde_json::Value;

/// Encode a command value as a single JSONL frame (compact JSON + trailing LF).
#[must_use]
pub fn encode_frame(command: &Value) -> String {
	format!("{command}\n")
}

/// Decode one inbound line into a JSON value. Blank lines yield `None`; a
/// malformed line yields `Err` (the caller decides whether to skip or fail).
///
/// # Errors
/// Returns the parse error message when `line` is non-blank but not valid JSON.
pub fn decode_line(line: &str) -> Result<Option<Value>, String> {
	let trimmed = line.trim();
	if trimmed.is_empty() {
		return Ok(None);
	}
	serde_json::from_str(trimmed)
		.map(Some)
		.map_err(|e| e.to_string())
}

/// Split a buffer of `\n`-delimited frames into decoded values.
///
/// Skips blank lines. A trailing partial (no newline) line is returned as the
/// leftover the caller should retain for the next read.
///
/// # Errors
/// Returns the parse error message on the first malformed complete frame.
pub fn decode_frames(buffer: &str) -> Result<(Vec<Value>, String), String> {
	let mut out = Vec::new();
	let has_trailing_newline = buffer.ends_with('\n');
	let mut lines: Vec<&str> = buffer.split('\n').collect();
	// If the buffer ends with a newline, the final split element is "" (complete);
	// otherwise the final element is an incomplete partial frame to retain.
	let leftover = if has_trailing_newline {
		String::new()
	} else {
		lines.pop().unwrap_or("").to_owned()
	};
	for line in lines {
		if let Some(v) = decode_line(line)? {
			out.push(v);
		}
	}
	Ok((out, leftover))
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	#[test]
	fn encode_is_compact_with_trailing_newline() {
		let frame = encode_frame(&json!({ "type": "prompt", "message": "hi" }));
		assert!(frame.ends_with('\n'));
		assert_eq!(frame.matches('\n').count(), 1);
		let back: Value = serde_json::from_str(frame.trim()).unwrap();
		assert_eq!(back["type"], "prompt");
	}

	#[test]
	fn decode_line_handles_blank_and_valid_and_malformed() {
		assert_eq!(decode_line("   ").unwrap(), None);
		assert_eq!(decode_line(r#"{"a":1}"#).unwrap().unwrap()["a"], 1);
		assert!(decode_line("{not json").is_err());
	}

	#[test]
	fn decode_frames_splits_complete_lines_and_retains_partial() {
		let buf = "{\"a\":1}\n{\"b\":2}\n{\"c\":3";
		let (frames, leftover) = decode_frames(buf).unwrap();
		assert_eq!(frames.len(), 2);
		assert_eq!(frames[0]["a"], 1);
		assert_eq!(frames[1]["b"], 2);
		// The incomplete third frame is retained for the next read.
		assert_eq!(leftover, "{\"c\":3");
	}

	#[test]
	fn decode_frames_no_leftover_when_newline_terminated() {
		let (frames, leftover) = decode_frames("{\"a\":1}\n\n{\"b\":2}\n").unwrap();
		assert_eq!(frames.len(), 2); // blank line skipped
		assert!(leftover.is_empty());
	}

	#[test]
	fn decode_frames_round_trips_encoded_frames() {
		let a = encode_frame(&json!({ "id": "1", "type": "abort" }));
		let b = encode_frame(&json!({ "id": "2", "type": "get_session_stats" }));
		let (frames, leftover) = decode_frames(&format!("{a}{b}")).unwrap();
		assert_eq!(frames.len(), 2);
		assert_eq!(frames[1]["type"], "get_session_stats");
		assert!(leftover.is_empty());
	}
}
