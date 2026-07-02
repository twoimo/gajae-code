//! Live gjc-rpc socket verification against a real worktree engine (G007).
//!
//! Gated by `GIT_DAEMON_LIVE_RPC_SOCK=<socket path>` (offline-skips in CI).
//! Verifies the live seam: `RpcClient::connect_unix` connects to a real engine
//! and the G001 unbounded `negotiate_unattended` handshake round-trips.

use git_daemon::{RpcClient, runner::unbounded_negotiation};

#[tokio::test]
async fn live_rpc_connect_and_unbounded_negotiate() {
	let Some(sock) = std::env::var("GIT_DAEMON_LIVE_RPC_SOCK")
		.ok()
		.filter(|s| !s.is_empty())
	else {
		eprintln!("live_rpc: skipped (set GIT_DAEMON_LIVE_RPC_SOCK=<socket> to run)");
		return;
	};

	// Live seam: the only offline-untestable line — connect to a real UDS.
	let mut client = RpcClient::connect_unix(&sock)
		.await
		.expect("connect_unix to live engine");
	eprintln!("live_rpc: connected to {sock}");

	// G001 unbounded negotiation (D3): no numeric budget.
	let cmd =
		unbounded_negotiation("git-daemon", &["prompt", "bash", "control"], &["bash.mutating"]);
	client.send(&cmd).await.expect("send negotiate_unattended");
	eprintln!("live_rpc: sent unbounded negotiate_unattended");

	// Read frames until we see the response to our negotiation (the engine may
	// emit unrelated control/status frames first).
	let mut saw_response = false;
	for _ in 0..50 {
		match client.next_frame().await.expect("read frame") {
			Some(frame) => {
				let ty = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
				eprintln!("live_rpc: frame type={ty}");
				if ty == "response" {
					let cmd_echo = frame.get("command").and_then(|v| v.as_str()).unwrap_or("");
					if cmd_echo == "negotiate_unattended" {
						let success = frame
							.get("success")
							.and_then(|v| v.as_bool())
							.unwrap_or(false);
						assert!(success, "unbounded negotiation must be accepted, got {frame}");
						let mode = frame.pointer("/data/budget_mode").and_then(|v| v.as_str());
						assert_eq!(
							mode,
							Some("unbounded"),
							"engine must echo budget_mode=unbounded, got {frame}"
						);
						saw_response = true;
						break;
					}
				}
			},
			None => break,
		}
	}
	assert!(saw_response, "did not observe a negotiate_unattended response from the live engine");
	eprintln!("live_rpc: unbounded negotiation accepted by the live engine ✔");
}
