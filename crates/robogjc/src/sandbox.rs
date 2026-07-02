//! Repository workspace and sandbox identity boundary.

#[cfg(test)]
mod tests {
	#[test]
	fn module_scaffold_is_reachable() {
		assert_eq!(module_path!(), "robogjc::sandbox::tests");
	}
}
