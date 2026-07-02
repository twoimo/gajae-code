//! App-server client boundary for future JSON-RPC and host-tool integration.

#[cfg(test)]
mod tests {
	#[test]
	fn module_scaffold_is_reachable() {
		assert_eq!(module_path!(), "robogjc::app_server_client::tests");
	}
}
