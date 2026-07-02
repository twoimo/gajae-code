//! Discovery records for locating a per-session app-server endpoint.
//!
//! Each running app-server writes `<state_root>/app-server/<sessionId>.json`
//! describing its loopback endpoint and bearer token. Clients read this file to
//! discover the server for a session. Writes are atomic and private on Unix.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

/// On-disk app-server discovery descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRecord {
    /// Schema version.
    pub version: u32,
    /// The session id this endpoint serves.
    pub session_id: String,
    /// The OS process id hosting the server (for dead-PID stale cleanup).
    pub pid: u32,
    /// Bind host (always loopback in practice).
    pub host: String,
    /// Bound port.
    pub port: u16,
    /// The per-session token. Required by clients; never log it raw.
    pub token: String,
    /// Full `http://host:port` URL.
    pub url: String,
    /// Epoch-millis when the server started.
    pub started_at_ms: u64,
    /// Epoch-millis of the last update.
    pub updated_at_ms: u64,
    /// Set true when the server stopped but the file could not be removed.
    #[serde(default)]
    pub stale: bool,
}

impl DiscoveryRecord {
    /// Build a fresh record for a just-bound app-server.
    #[must_use]
    pub fn new(session_id: impl Into<String>, host: &str, port: u16, token: impl Into<String>) -> Self {
        let now = now_ms();
        let host = host.to_owned();
        Self {
            version: 1,
            session_id: session_id.into(),
            pid: std::process::id(),
            url: format!("http://{host}:{port}"),
            host,
            port,
            token: token.into(),
            started_at_ms: now,
            updated_at_ms: now,
            stale: false,
        }
    }

    /// Serialize in the canonical on-disk form.
    ///
    /// # Errors
    /// Propagates JSON serialization failures.
    pub fn to_canonical_json(&self) -> serde_json::Result<String> {
        serde_json::to_string_pretty(self)
    }

    /// Atomically write this record to `path`.
    ///
    /// Creates the parent directory, writes a temp file in the same directory,
    /// fsyncs it, applies `0600` on Unix, and renames into place.
    ///
    /// # Errors
    /// Propagates filesystem and JSON serialization errors.
    pub fn write_atomic(&self, path: &Path) -> std::io::Result<()> {
        let parent = path.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "discovery path has no parent"))?;
        fs::create_dir_all(parent)?;
        harden_dir(parent)?;

        let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
        let json = self.to_canonical_json().map_err(std::io::Error::other)?;
        {
            let mut file = create_private_file(&tmp)?;
            file.write_all(json.as_bytes())?;
            file.write_all(b"\n")?;
            file.sync_all()?;
        }
        harden_file(&tmp)?;
        fs::rename(&tmp, path)?;
        harden_file(path)?;
        Ok(())
    }

    /// Return whether this record should be treated as stale.
    #[must_use]
    pub const fn is_stale(&self, now_ms: u64, ttl_ms: u64, pid_alive: bool) -> bool {
        self.stale || !pid_alive || now_ms.saturating_sub(self.updated_at_ms) > ttl_ms
    }
}

/// Path of the discovery file for a given session.
#[must_use]
pub fn discovery_path(state_root: &Path, session_id: &str) -> PathBuf {
    state_root.join("app-server").join(format!("{session_id}.json"))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

#[cfg(unix)]
fn harden_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn harden_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn harden_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn harden_file(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "gjc-app-server-discovery-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }

    #[test]
    fn discovery_path_uses_app_server_session_file() {
        let path = discovery_path(Path::new("/state"), "session-1");
        assert_eq!(path, PathBuf::from("/state/app-server/session-1.json"));
    }

    #[test]
    fn discovery_record_round_trips_with_camel_case_fields() {
        let record = DiscoveryRecord::new("session-1", "127.0.0.1", 3456, "tok");
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["startedAtMs"], record.started_at_ms);
        assert_eq!(value["updatedAtMs"], record.updated_at_ms);
        assert!(value.get("session_id").is_none());

        let decoded: DiscoveryRecord = serde_json::from_value(value).unwrap();
        assert_eq!(decoded, record);
    }

    #[test]
    fn stale_detection_covers_dead_pid_ttl_and_explicit_flag() {
        let mut record = DiscoveryRecord::new("session-1", "127.0.0.1", 3456, "tok");
        record.updated_at_ms = 1_000;
        assert!(record.is_stale(1_001, 10_000, false));
        assert!(record.is_stale(12_001, 10_000, true));
        assert!(!record.is_stale(11_000, 10_000, true));

        record.stale = true;
        assert!(record.is_stale(1_001, 10_000, true));
    }

    #[test]
    fn atomic_write_persists_readable_record() {
        let root = unique_temp_root("atomic");
        let path = discovery_path(&root, "session-1");
        let record = DiscoveryRecord::new("session-1", "127.0.0.1", 3456, "tok");

        record.write_atomic(&path).unwrap();

        let data = fs::read_to_string(&path).unwrap();
        let decoded: DiscoveryRecord = serde_json::from_str(&data).unwrap();
        assert_eq!(decoded, record);

        fs::remove_dir_all(root).unwrap();
    }
}
