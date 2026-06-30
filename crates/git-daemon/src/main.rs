//! `git-daemon` binary entrypoint.
//!
//! Subcommands: `health`, `status`, `serve`, `stop`, `reload`, `once`.
//! `health`/`status` run against the verified library core. `serve`/`once` wire
//! the verified reconciliation loop to the live transports (GitHub HTTP via
//! `reqwest`, gjc-rpc over a Unix socket); they read non-secret config + the
//! socket path from the environment and fail closed with a precise message when
//! a required value or live endpoint is missing. `stop`/`reload` require IPC to
//! a running daemon and remain honest stubs until that control channel lands.

use std::path::PathBuf;
use std::time::Duration;

use git_daemon::config::MergePolicy;
use git_daemon::github_forge::GithubForge;
use git_daemon::observability::StatusReport;
use git_daemon::reqwest_transport::ReqwestTransport;
use git_daemon::rpc_socket::RpcClient;
use git_daemon::serve::{serve_forever, serve_pass};
use git_daemon::socket_runner::SocketWorkRunner;
use git_daemon::store::GitDaemonStateStore;

fn print_usage() {
	println!(
		"git-daemon <command>\n\nCommands:\n  health   Print readiness and exit.\n  status   Print a JSON status report.\n  serve    Run the always-on daemon (reads config + RPC socket from env).\n  once     Run a single reconciliation sweep.\n  stop     Signal a running daemon to drain and stop.\n  reload   Signal a running daemon to reload config.\n\nEnvironment (serve/once):\n  GIT_DAEMON_GITHUB_TOKEN     GitHub token (required)\n  GIT_DAEMON_REPO             owner/repo (required)\n  GIT_DAEMON_RPC_SOCKET       gjc-rpc Unix socket path (required)\n  GIT_DAEMON_STATE_DB         state DB path (default .gjc/git-daemon/state.sqlite)\n  GIT_DAEMON_DEV_BRANCHES     comma-separated (default dev)\n  GIT_DAEMON_PROTECTED_BRANCHES comma-separated (default main,master)\n  GIT_DAEMON_POLL_SECS        poll cadence seconds (default 30)\n  GIT_DAEMON_MAX_CONCURRENCY  max concurrent runs (default 2)"
	);
}

/// Non-secret daemon settings resolved from the environment.
struct DaemonEnv {
	token: String,
	repo: String,
	socket: String,
	state_db: PathBuf,
	policy: MergePolicy,
	poll: Duration,
	max_concurrency: u32,
}

fn env_required(key: &str) -> Result<String, String> {
	std::env::var(key).map_err(|_| format!("missing required env var {key}"))
}

fn csv_env(key: &str, default: &[&str]) -> Vec<String> {
	std::env::var(key).map_or_else(
		|_| default.iter().map(|s| (*s).to_owned()).collect(),
		|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect(),
	)
}

fn load_env() -> Result<DaemonEnv, String> {
	let token = env_required("GIT_DAEMON_GITHUB_TOKEN")?;
	let repo = env_required("GIT_DAEMON_REPO")?;
	let socket = env_required("GIT_DAEMON_RPC_SOCKET")?;
	let state_db = std::env::var("GIT_DAEMON_STATE_DB")
		.map_or_else(|_| PathBuf::from(".gjc/git-daemon/state.sqlite"), PathBuf::from);
	let poll_secs = std::env::var("GIT_DAEMON_POLL_SECS")
		.ok()
		.and_then(|v| v.parse::<u64>().ok())
		.unwrap_or(30);
	let max_concurrency = std::env::var("GIT_DAEMON_MAX_CONCURRENCY")
		.ok()
		.and_then(|v| v.parse::<u32>().ok())
		.unwrap_or(2);
	Ok(DaemonEnv {
		token,
		repo,
		socket,
		state_db,
		policy: MergePolicy {
			protected_branches: csv_env("GIT_DAEMON_PROTECTED_BRANCHES", &["main", "master"]),
			allowed_dev_branches: csv_env("GIT_DAEMON_DEV_BRANCHES", &["dev"]),
		},
		poll: Duration::from_secs(poll_secs),
		max_concurrency,
	})
}

/// Wall-clock timestamps for a reconciliation tick: `(now, lease_expires_at)`
/// as unix-millis strings (the store compares them lexically as opaque tokens).
fn system_clock() -> (String, String) {
	let now = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis();
	(now.to_string(), (now + 300_000).to_string())
}

/// Connect the gjc-rpc socket and build the work runner. Live-only.
async fn build_runner(
	socket: &str,
) -> Result<SocketWorkRunner<tokio::net::UnixStream>, String> {
	let client = RpcClient::connect_unix(socket).await.map_err(|e| format!("rpc connect: {e}"))?;
	Ok(SocketWorkRunner::new(
		client,
		"git-daemon",
		vec!["prompt".to_owned(), "bash".to_owned(), "edit".to_owned()],
		vec!["bash.mutating".to_owned()],
		256,
	))
}

fn build_forge(cfg: &DaemonEnv) -> Result<GithubForge<ReqwestTransport>, String> {
	let transport = ReqwestTransport::new().map_err(|e| format!("transport: {e}"))?;
	Ok(GithubForge::new(transport, cfg.token.clone(), cfg.repo.clone()))
}

async fn cmd_once() -> Result<(), String> {
	let cfg = load_env()?;
	let mut store = GitDaemonStateStore::open(&cfg.state_db).map_err(|e| format!("open state db: {e}"))?;
	let forge = build_forge(&cfg)?;
	let runner = build_runner(&cfg.socket).await?;
	let (now, lease) = system_clock();
	let out = serve_pass(&mut store, &forge, &runner, &cfg.policy, 0, cfg.max_concurrency, 64, &now, &lease)
		.await
		.map_err(|e| format!("reconciliation pass: {e}"))?;
	println!("git-daemon: once drove {} item(s)", out.len());
	Ok(())
}

async fn cmd_serve() -> Result<(), String> {
	let cfg = load_env()?;
	let store = GitDaemonStateStore::open(&cfg.state_db).map_err(|e| format!("open state db: {e}"))?;
	let forge = build_forge(&cfg)?;
	let runner = build_runner(&cfg.socket).await?;
	let (tx, rx) = tokio::sync::watch::channel(false);
	tokio::spawn(async move {
		if tokio::signal::ctrl_c().await.is_ok() {
			let _ = tx.send(true);
		}
	});
	let ticks = serve_forever(store, forge, runner, cfg.policy, cfg.max_concurrency, 64, cfg.poll, rx, system_clock)
		.await
		.map_err(|e| format!("serve loop: {e}"))?;
	println!("git-daemon: drained and stopped after {ticks} tick(s)");
	Ok(())
}

#[tokio::main]
async fn main() {
	let args: Vec<String> = std::env::args().collect();
	let cmd = args.get(1).map_or("help", String::as_str);
	match cmd {
		"health" => println!("git-daemon: ok"),
		"status" => {
			let repo = args.get(2).map_or("<unconfigured>", String::as_str);
			let report = StatusReport::starting("local", std::process::id(), repo);
			match serde_json::to_string_pretty(&report) {
				Ok(json) => println!("{json}"),
				Err(e) => {
					eprintln!("git-daemon: failed to render status: {e}");
					std::process::exit(1);
				}
			}
		}
		"once" => {
			if let Err(e) = cmd_once().await {
				eprintln!("git-daemon: once failed: {e}");
				std::process::exit(1);
			}
		}
		"serve" => {
			if let Err(e) = cmd_serve().await {
				eprintln!("git-daemon: serve failed: {e}");
				std::process::exit(1);
			}
		}
		"stop" | "reload" => {
			eprintln!(
				"git-daemon: '{cmd}' requires a control channel to a running daemon, which is not implemented in this build yet."
			);
			std::process::exit(1);
		}
		"help" | "--help" | "-h" => print_usage(),
		other => {
			eprintln!("git-daemon: unknown command '{other}'");
			print_usage();
			std::process::exit(2);
		}
	}
}
