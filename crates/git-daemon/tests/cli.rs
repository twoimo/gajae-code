//! Integration tests for the `git-daemon` binary CLI.

use std::process::Command;

fn bin() -> Command {
	Command::new(env!("CARGO_BIN_EXE_git-daemon"))
}

#[test]
fn health_reports_ok_and_exits_zero() {
	let out = bin().arg("health").output().unwrap();
	assert!(out.status.success());
	assert!(String::from_utf8_lossy(&out.stdout).contains("ok"));
}

#[test]
fn status_prints_valid_json() {
	let out = bin().args(["status", "acme/widget"]).output().unwrap();
	assert!(out.status.success());
	let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
	assert_eq!(json["repo_full_name"], "acme/widget");
	assert_eq!(json["status"], "starting");
}

#[test]
fn serve_fails_closed_without_config() {
	let out = bin()
		.arg("serve")
		.env_remove("GIT_DAEMON_GITHUB_TOKEN")
		.env_remove("GIT_DAEMON_REPO")
		.env_remove("GIT_DAEMON_RPC_SOCKET")
		.output()
		.unwrap();
	assert!(!out.status.success());
	assert!(String::from_utf8_lossy(&out.stderr).contains("missing required env var"));
}

#[test]
fn once_fails_closed_without_config() {
	let out = bin()
		.arg("once")
		.env_remove("GIT_DAEMON_GITHUB_TOKEN")
		.env_remove("GIT_DAEMON_REPO")
		.env_remove("GIT_DAEMON_RPC_SOCKET")
		.output()
		.unwrap();
	assert!(!out.status.success());
	assert!(String::from_utf8_lossy(&out.stderr).contains("missing required env var"));
}

#[test]
fn stop_fails_closed_without_control_channel() {
	let out = bin().arg("stop").output().unwrap();
	assert!(!out.status.success());
	assert!(String::from_utf8_lossy(&out.stderr).contains("control channel"));
}

#[test]
fn unknown_command_exits_nonzero() {
	let out = bin().arg("frobnicate").output().unwrap();
	assert!(!out.status.success());
}
