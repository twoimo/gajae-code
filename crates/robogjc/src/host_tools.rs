//! Host-tool registration, invocation, and result boundary for app-server calls.

#[cfg(test)]
mod tests {
	#[test]
	fn module_scaffold_is_reachable() {
		assert_eq!(module_path!(), "robogjc::host_tools::tests");
	}
}
