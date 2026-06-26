#![cfg(unix)]

use std::path::PathBuf;

use gjc_rpc_sdk::authz::{GrantAudit, GrantLimits, GrantRecord, Principal, RedactionPolicy, Scope};
use gjc_rpc_sdk::daemon_server::DaemonState;
use gjc_rpc_sdk::uds_transport::secure_bind;

fn default_socket_path() -> PathBuf {
	if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
		return PathBuf::from(runtime_dir).join("gjc/rpc-sdk/daemon.sock");
	}
	PathBuf::from(".gjc/state/rpc-sdk/daemon.sock")
}

fn socket_path() -> PathBuf {
	std::env::args_os()
		.nth(1)
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("GJC_RPC_DAEMON_SOCKET").map(PathBuf::from))
		.unwrap_or_else(default_socket_path)
}

fn now_utc() -> String {
	// Keep the host dependency-light; the authorizer only needs a lexicographically
	// comparable ISO-8601 value and daemon grants below expire far in the future.
	"2026-01-01T00:00:00Z".to_string()
}

fn self_grant(now: &str) -> GrantRecord {
	// SAFETY: getuid is always-successful, thread-safe, side-effect-free.
	let uid = unsafe { libc::getuid() };
	// SAFETY: getgid is always-successful, thread-safe, side-effect-free.
	let gid = unsafe { libc::getgid() };
	GrantRecord {
		version: 1,
		grant_id: "daemon-host-self".to_string(),
		principal_binding: Principal::Unix { uid, gid, pid: None },
		bearer_hash: None,
		issued_at: now.to_string(),
		expires_at: "2099-01-01T00:00:00Z".to_string(),
		renewable_until: "2099-01-02T00:00:00Z".to_string(),
		revoked_at: None,
		issuer: "admin".to_string(),
		purpose: "daemon host local UDS owner bootstrap".to_string(),
		sessions: vec!["all".to_string()],
		scopes: vec![
			Scope::Subscribe,
			Scope::Read,
			Scope::Control,
			Scope::GateAnswer,
			Scope::HostToolResult,
			Scope::HostUriResult,
			Scope::HostToolRegister,
			Scope::HostUriRegister,
			Scope::Enumerate,
			Scope::Admin,
		],
		redaction_policy: RedactionPolicy::Full,
		limits: GrantLimits::default(),
		audit: GrantAudit::default(),
	}
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
	let path = socket_path();
	if let Some(parent) = path.parent() {
		std::fs::create_dir_all(parent)?;
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
		}
	}
	let listener = secure_bind(&path)?;
	let now = now_utc();
	loop {
		let (mut stream, _addr) = listener.accept().await?;
		let mut state = DaemonState::new(vec![self_grant(&now)], now.clone()).with_worker_hosting();
		tokio::spawn(async move {
			if let Err(error) = state.serve_session(&mut stream).await {
				eprintln!("gjc-rpc-daemon connection ended: {error}");
			}
		});
	}
}
