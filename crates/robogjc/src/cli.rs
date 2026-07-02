//! Command-line entry point wiring for the future robogjc binary.

/// Run the scaffolded command-line entry point.
pub fn run() {}

#[cfg(test)]
mod tests {
	#[test]
	fn module_scaffold_is_reachable() {
		assert_eq!(module_path!(), "robogjc::cli::tests");
	}
}
