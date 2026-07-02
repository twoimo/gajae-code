//! Generate or drift-check the committed app-server JSON Schema artifact.
//!
//! Usage:
//!   gjc-app-server-schema            # write schemas/app-server.schema.json
//!   gjc-app-server-schema --check    # exit non-zero if the committed file drifts
//!
//! Wired into the repo `generate-schemas` / `check:schemas` gate so the
//! Rust-derived schema is the source of truth and CI catches drift.

use std::path::PathBuf;
use std::process::ExitCode;

fn output_path() -> PathBuf {
	// CARGO_MANIFEST_DIR = crates/gjc-app-server; repo root is two levels up.
	let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	manifest
		.join("..")
		.join("..")
		.join("schemas")
		.join("app-server.schema.json")
}

fn main() -> ExitCode {
	let check = std::env::args().any(|a| a == "--check");
	let generated = gjc_app_server::schema::schema_bundle_string();
	let path = output_path();

	if check {
		let existing = std::fs::read_to_string(&path).unwrap_or_default();
		if existing == generated {
			println!("app-server schema up to date: {}", path.display());
			ExitCode::SUCCESS
		} else {
			eprintln!(
				"app-server schema DRIFT: {} is out of date. Run `cargo run -p gjc-app-server --bin gjc-app-server-schema` to regenerate.",
				path.display()
			);
			ExitCode::FAILURE
		}
	} else {
		if let Some(parent) = path.parent() {
			std::fs::create_dir_all(parent).expect("create schemas dir");
		}
		std::fs::write(&path, &generated).expect("write schema");
		println!("wrote {}", path.display());
		ExitCode::SUCCESS
	}
}
