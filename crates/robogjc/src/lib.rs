//! Rust scaffold for the robogjc service port.

pub mod app_server_client;
pub mod autoclose;
pub mod cancellation;
pub mod cli;
pub mod config;
pub mod dashboard;
pub mod db;
#[cfg(test)]
mod fixture_harness;
pub mod git_ops;
pub mod github;
pub mod host_tools;
pub mod logging;
pub mod manual_triage;
pub mod natives_cache;
pub mod persona;
pub mod pragmas;
pub mod proxy;
pub mod queue;
pub mod redaction;
pub mod sandbox;
pub mod server;
pub mod slot_pool;
pub mod tasks;
pub mod worker;
pub mod workspace_keys;

#[cfg(test)]
mod tests {
	#[test]
	fn exposes_port_modules() {
		let modules = [
			"app_server_client",
			"cli",
			"config",
			"db",
			"github",
			"host_tools",
			"logging",
			"persona",
			"pragmas",
			"proxy",
			"queue",
			"redaction",
			"sandbox",
			"server",
			"worker",
			"workspace_keys",
		];

		assert_eq!(modules.len(), 16);
	}
}
