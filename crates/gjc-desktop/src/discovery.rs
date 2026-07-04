use std::{fs, path::Path, time::Duration};

use anyhow::{Context, Result, bail};
use gjc_app_server::discovery::{DiscoveryRecord, discovery_path};

pub const DISCOVERY_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppServerEndpoint {
	pub url:   String,
	pub token: String,
}

pub fn read_record(state_root: &Path, session_id: &str) -> Result<DiscoveryRecord> {
	let path = discovery_path(state_root, session_id);
	let contents = fs::read_to_string(&path)
		.with_context(|| format!("failed to read discovery record at {}", path.display()))?;
	serde_json::from_str(&contents).context("failed to parse discovery record")
}

pub fn validate_record(
	record: &DiscoveryRecord,
	session_id: &str,
	now_ms: u64,
) -> Result<AppServerEndpoint> {
	if record.version != 1 {
		bail!("unsupported discovery version");
	}
	if record.session_id != session_id {
		bail!("discovery session mismatch");
	}
	if record.pid == 0 {
		bail!("discovery pid is missing");
	}
	if record.port == 0 {
		bail!("discovery port is missing");
	}
	if record.stale || now_ms.saturating_sub(record.updated_at_ms) > DISCOVERY_TTL.as_millis() as u64
	{
		bail!("discovery record is stale");
	}
	if record.host != "127.0.0.1" && record.host != "localhost" {
		bail!("discovery host is not loopback");
	}
	// The WS sidecar writes `ws://{host}:{port}` into the discovery record
	// (crates/gjc-app-server/src/transport_ws.rs); readiness is polled over
	// HTTP on the same port. Accept both schemes and normalize to ws://.
	let expected_ws = format!("ws://{}:{}", record.host, record.port);
	let expected_http = format!("http://{}:{}", record.host, record.port);
	if record.url != expected_ws && record.url != expected_http {
		bail!("discovery url does not match host and port");
	}
	if record.token.is_empty() {
		bail!("discovery token is missing");
	}
	Ok(AppServerEndpoint { url: expected_ws, token: record.token.clone() })
}

pub async fn wait_for_ready(
	state_root: &Path,
	session_id: &str,
	timeout: Duration,
) -> Result<AppServerEndpoint> {
	let started = tokio::time::Instant::now();
	loop {
		if let Ok(record) = read_record(state_root, session_id) {
			let endpoint = validate_record(&record, session_id, now_ms())?;
			let ready_url = format!("http://{}/readyz", endpoint.url.trim_start_matches("ws://"));
			if let Ok(response) = reqwest::get(&ready_url).await
				&& response.status().is_success()
			{
				return Ok(endpoint);
			}
		}
		if started.elapsed() >= timeout {
			bail!("timed out waiting for app-server readiness");
		}
		tokio::time::sleep(Duration::from_millis(100)).await;
	}
}

fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis() as u64
}

#[cfg(test)]
mod tests {
	use super::*;

	fn record() -> DiscoveryRecord {
		let mut record = DiscoveryRecord::new("session", "127.0.0.1", 44123, "secret");
		record.pid = 42;
		record.updated_at_ms = 1_000;
		record
	}

	#[test]
	fn validates_matching_record() {
		let endpoint = validate_record(&record(), "session", 1_001).unwrap();
		assert_eq!(endpoint.url, "ws://127.0.0.1:44123");
		assert_eq!(endpoint.token, "secret");
	}

	#[test]
	fn accepts_ws_scheme_discovery_url() {
		// The real WS sidecar writes ws:// into the record (transport_ws.rs).
		let mut record = record();
		record.url = "ws://127.0.0.1:44123".to_owned();
		let endpoint = validate_record(&record, "session", 1_001).unwrap();
		assert_eq!(endpoint.url, "ws://127.0.0.1:44123");
	}

	#[test]
	fn rejects_stale_record() {
		let mut record = record();
		record.stale = true;
		assert!(validate_record(&record, "session", 1_001).is_err());
	}

	#[test]
	fn rejects_mismatched_session() {
		assert!(validate_record(&record(), "other", 1_001).is_err());
	}

	#[test]
	fn rejects_non_loopback_host() {
		let mut record = record();
		record.host = "0.0.0.0".to_owned();
		record.url = "http://0.0.0.0:44123".to_owned();
		assert!(validate_record(&record, "session", 1_001).is_err());
	}
}
