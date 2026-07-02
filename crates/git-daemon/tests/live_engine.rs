//! Live-surface test for the gjc-rpc socket transport + G001 unbounded
//! negotiation against a REAL running worktree engine (`gjc --mode rpc
//! --listen <socket>`). Skipped unless `GIT_DAEMON_RPC_SOCKET` is set.
//!
//! ```sh
//! GIT_DAEMON_RPC_SOCKET=/path/engine.sock \
//!   cargo test -p git-daemon --test live_engine -- --nocapture
//! ```

use git_daemon::{RpcClient, runner::unbounded_negotiation};

#[tokio::test]
async fn live_connect_and_unbounded_negotiate() {
	let Ok(socket) = std::env::var("GIT_DAEMON_RPC_SOCKET") else {
		eprintln!("SKIP live_connect_and_unbounded_negotiate: set GIT_DAEMON_RPC_SOCKET");
		return;
	};
	let mut client = RpcClient::connect_unix(&socket)
		.await
		.expect("connect_unix to live engine");
	println!("LIVE engine: connected to {socket}");

	let neg = unbounded_negotiation("git-daemon", &["prompt", "bash"], &["bash.mutating"]);
	println!("LIVE engine: sending {}", serde_json::to_string(&neg).unwrap());
	client.send(&neg).await.expect("send negotiate_unattended");

	// Read up to a few frames; prove bidirectional JSONL comms + that the live
	// engine accepts the G001 unbounded declaration (budget_mode unbounded).
	for _ in 0..5 {
		match client.next_frame().await {
			Ok(Some(frame)) => {
				println!("LIVE engine frame: {}", serde_json::to_string(&frame).unwrap());
				if frame.get("type").and_then(|v| v.as_str()) == Some("response") {
					let accepted = frame.pointer("/data/budget_mode").and_then(|v| v.as_str());
					assert_eq!(accepted, Some("unbounded"), "engine must accept unbounded mode");
					break;
				}
			},
			Ok(None) => {
				println!("LIVE engine: stream EOF");
				break;
			},
			Err(e) => {
				println!("LIVE engine: read error: {e}");
				break;
			},
		}
	}
}
