//! Dashboard static bundle helpers.

use std::{
	fs,
	io::{Read, Seek, SeekFrom},
	path::{Path, PathBuf},
};

use serde_json::{Value, json};

const TAIL_MAX_BYTES: u64 = 2 * 1024 * 1024;
const CONFIG_SENTINEL: &str = "__ROBGJC_CONFIG__";

pub fn static_dir() -> PathBuf {
	let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let candidates = [
		manifest.join("../../../python/robogjc/src/static"),
		manifest.join("../../python/robogjc/src/static"),
		PathBuf::from("python/robogjc/src/static"),
	];
	for candidate in candidates {
		if candidate.exists() {
			return candidate;
		}
	}
	manifest.join("../../../python/robogjc/src/static")
}

pub fn render_index(replay_enabled: bool) -> Result<String, String> {
	let index = static_dir().join("index.html");
	let template = fs::read_to_string(&index)
		.map_err(|err| format!("frontend bundle missing at {}: {err}", index.display()))?;
	if !template.contains(CONFIG_SENTINEL) {
		return Err(format!(
			"frontend bundle at {} is missing the {CONFIG_SENTINEL} sentinel",
			index.display()
		));
	}
	let payload = serde_json::to_string(&json!({ "replayEnabled": replay_enabled }))
		.map_err(|err| err.to_string())?
		.replace("</", "<\\/");
	Ok(template.replace(CONFIG_SENTINEL, &payload))
}

pub fn tail_jsonl(path: &Path, limit: usize) -> Vec<Value> {
	if limit == 0 || !path.exists() {
		return Vec::new();
	}
	let Ok(mut file) = fs::File::open(path) else {
		return Vec::new();
	};
	let Ok(size) = file.metadata().map(|m| m.len()) else {
		return Vec::new();
	};
	if size == 0 {
		return Vec::new();
	}
	let read_size = size.min(TAIL_MAX_BYTES);
	if file.seek(SeekFrom::Start(size - read_size)).is_err() {
		return Vec::new();
	}
	let mut bytes = Vec::with_capacity(read_size as usize);
	if file.take(read_size).read_to_end(&mut bytes).is_err() {
		return Vec::new();
	}
	if read_size < size {
		if let Some(pos) = bytes.iter().position(|b| *b == b'\n') {
			bytes = bytes[pos + 1..].to_vec();
		} else {
			return Vec::new();
		}
	}
	let text = String::from_utf8_lossy(&bytes);
	text
		.lines()
		.rev()
		.take(limit)
		.collect::<Vec<_>>()
		.into_iter()
		.rev()
		.filter_map(|line| {
			let line = line.trim();
			if line.is_empty() {
				return None;
			}
			match serde_json::from_str::<Value>(line) {
				Ok(Value::Object(map)) => Some(Value::Object(map)),
				_ => Some(json!({"level":"RAW","logger":"raw","msg":line})),
			}
		})
		.collect()
}

pub fn content_type(path: &Path) -> &'static str {
	match path.extension().and_then(|s| s.to_str()).unwrap_or("") {
		"html" => "text/html; charset=utf-8",
		"js" | "mjs" => "text/javascript; charset=utf-8",
		"css" => "text/css; charset=utf-8",
		"json" => "application/json",
		"svg" => "image/svg+xml",
		"png" => "image/png",
		"ico" => "image/x-icon",
		"wasm" => "application/wasm",
		_ => "application/octet-stream",
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dashboard_tail_jsonl_recovers_from_garbage_lines() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("robogjc.log.jsonl");
		fs::write(&path, "{\"msg\":\"ok\"}\n{not json}\n{\"level\":\"ERROR\",\"msg\":\"bang\"}\n")
			.unwrap();
		let rows = tail_jsonl(&path, 10);
		assert_eq!(rows.len(), 3);
		assert_eq!(rows[1]["level"], "RAW");
	}
}
