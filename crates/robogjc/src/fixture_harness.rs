use std::path::PathBuf;

use serde::de::DeserializeOwned;

pub fn load_fixture<T: DeserializeOwned>(relative: &str) -> T {
	let path = fixture_path(relative);
	let text = std::fs::read_to_string(&path)
		.unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()));
	serde_json::from_str(&text)
		.unwrap_or_else(|err| panic!("failed to parse {}: {err}", path.display()))
}

fn fixture_path(relative: &str) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests/fixtures")
		.join(relative)
}
