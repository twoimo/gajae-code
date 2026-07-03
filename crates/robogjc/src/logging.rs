//! Tracing/logging setup and credential redaction helpers.
//!
//! Python uses a pretty stdout handler plus a size-rotating JSONL file handler
//! (`RotatingFileHandler`, 10 MiB, 5 backups). The Rust port maps that to a
//! pretty stdout `tracing_subscriber::fmt` layer and ensures the log directory
//! for the JSONL file sink path; exact byte-count rollover is documented as a
//! runtime mapping difference. The observable JSON helper preserves Python's
//! record shape: `ts`, `level`, `logger`, `msg`, optional `exc`, and
//! non-reserved extra fields only.

use std::{
	fs::{File, OpenOptions},
	io::Write,
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex, OnceLock,
		atomic::{AtomicBool, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use tracing::{
	Event, Level as TracingLevel, Subscriber,
	field::{Field, Visit},
};
use tracing_subscriber::{Layer, filter::EnvFilter, layer::Context, prelude::*};

static INITIALIZED: AtomicBool = AtomicBool::new(false);
static JSON_SINK: OnceLock<Arc<Mutex<Option<RotatingJsonSink>>>> = OnceLock::new();
const JSON_LOG_FILE: &str = "robogjc.log.jsonl";
const JSON_LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
const JSON_LOG_BACKUPS: usize = 5;
const ACCESS_MUTE_PATHS: &[&str] = &["/api/status", "/api/logs", "/healthz", "/readyz"];
const RESERVED_FIELDS: &[&str] = &[
	"args",
	"asctime",
	"created",
	"exc_info",
	"exc_text",
	"filename",
	"funcName",
	"levelname",
	"levelno",
	"lineno",
	"message",
	"module",
	"msecs",
	"msg",
	"name",
	"pathname",
	"process",
	"processName",
	"relativeCreated",
	"stack_info",
	"thread",
	"threadName",
	"taskName",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
	Debug,
	Info,
	Warning,
	Error,
	Critical,
}

impl Level {
	pub fn as_str(self) -> &'static str {
		match self {
			Self::Debug => "DEBUG",
			Self::Info => "INFO",
			Self::Warning => "WARNING",
			Self::Error => "ERROR",
			Self::Critical => "CRITICAL",
		}
	}
}

impl From<Level> for TracingLevel {
	fn from(value: Level) -> Self {
		match value {
			Level::Debug => Self::DEBUG,
			Level::Info => Self::INFO,
			Level::Warning => Self::WARN,
			Level::Error | Level::Critical => Self::ERROR,
		}
	}
}

pub fn redact_credentials(input: &str) -> String {
	let mut out = String::with_capacity(input.len());
	let bytes = input.as_bytes();
	let mut i = 0;
	while let Some(rel) = input[i..].find("://") {
		let scheme_end = i + rel;
		let after = scheme_end + 3;
		out.push_str(&input[i..after]);
		let host_end = input[after..]
			.find(['/', '?', '#', ' ', '\n', '\r', '\t'])
			.map_or(input.len(), |p| after + p);
		let authority = &input[after..host_end];
		if let Some(at) = authority.rfind('@') {
			let creds = &authority[..at];
			if creds.contains(':') && !creds.is_empty() {
				out.push_str("***:***@");
				out.push_str(&authority[at + 1..]);
			} else {
				out.push_str(authority);
			}
		} else {
			out.push_str(authority);
		}
		i = host_end;
		if i >= bytes.len() {
			break;
		}
	}
	out.push_str(&input[i..]);
	out
}

pub fn should_mute_dashboard_poll(method: &str, path: &str) -> bool {
	method == "GET" && ACCESS_MUTE_PATHS.contains(&path.split('?').next().unwrap_or(path))
}
fn is_reserved_extra(key: &str) -> bool {
	key.starts_with('_') || RESERVED_FIELDS.contains(&key)
}

pub fn pretty_record(logger: &str, level: Level, msg: &str, extras: &[(&str, &str)]) -> String {
	let logger = logger.strip_prefix("robogjc.").unwrap_or(logger);
	let mut line =
		format!("00:00:00  {:<8}  {:<22}  {}", level.as_str(), logger, redact_credentials(msg));
	let rendered: Vec<String> = extras
		.iter()
		.filter(|(key, _)| !is_reserved_extra(key))
		.map(|(key, value)| format!("{key}={}", redact_credentials(value)))
		.collect();
	if !rendered.is_empty() {
		line.push_str("  ");
		line.push_str(&rendered.join(" "));
	}
	line
}

pub fn json_record_with_exception(
	logger: &str,
	level: Level,
	msg: &str,
	extras: &[(&str, &str)],
	exception: Option<&str>,
) -> String {
	let mut payload = serde_json::Map::new();
	payload.insert("ts".to_owned(), serde_json::Value::String("1970-01-01T00:00:00Z".to_owned()));
	payload.insert("level".to_owned(), serde_json::Value::String(level.as_str().to_owned()));
	payload.insert("logger".to_owned(), serde_json::Value::String(logger.to_owned()));
	payload.insert("msg".to_owned(), serde_json::Value::String(redact_credentials(msg)));
	if let Some(exc) = exception {
		payload.insert("exc".to_owned(), serde_json::Value::String(redact_credentials(exc)));
	}
	for (key, value) in extras {
		if is_reserved_extra(key) {
			continue;
		}
		payload.insert((*key).to_owned(), serde_json::Value::String(redact_credentials(value)));
	}
	serde_json::Value::Object(payload).to_string()
}

pub fn json_record(logger: &str, level: Level, msg: &str, extras: &[(&str, &str)]) -> String {
	json_record_with_exception(logger, level, msg, extras, None)
}

fn json_sink() -> Arc<Mutex<Option<RotatingJsonSink>>> {
	JSON_SINK.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

struct RotatingJsonSink {
	path: PathBuf,
	max_bytes: u64,
	backups: usize,
	file: File,
}

impl RotatingJsonSink {
	fn new(dir: &Path) -> std::io::Result<Self> {
		std::fs::create_dir_all(dir)?;
		let path = dir.join(JSON_LOG_FILE);
		let file = OpenOptions::new().create(true).append(true).open(&path)?;
		Ok(Self { path, max_bytes: JSON_LOG_MAX_BYTES, backups: JSON_LOG_BACKUPS, file })
	}

	fn write_line(&mut self, line: &str) -> std::io::Result<()> {
		let current = self.file.metadata().map_or(0, |m| m.len());
		if current.saturating_add(line.len() as u64).saturating_add(1) > self.max_bytes {
			self.rotate()?;
		}
		self.file.write_all(line.as_bytes())?;
		self.file.write_all(b"\n")?;
		self.file.flush()
	}

	fn rotate(&mut self) -> std::io::Result<()> {
		self.file.flush()?;
		for index in (1..=self.backups).rev() {
			let src = if index == 1 {
				self.path.clone()
			} else {
				self.path.with_extension(format!("log.jsonl.{}", index - 1))
			};
			let dst = self.path.with_extension(format!("log.jsonl.{index}"));
			if src.exists() {
				let _ = std::fs::rename(src, dst);
			}
		}
		self.file = OpenOptions::new()
			.create(true)
			.write(true)
			.truncate(true)
			.open(&self.path)?;
		Ok(())
	}
}

#[derive(Default)]
struct JsonFields {
	message: Option<String>,
	extras: Vec<(String, serde_json::Value)>,
}

impl Visit for JsonFields {
	fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
		let rendered = format!("{value:?}");
		if field.name() == "message" {
			self.message = Some(rendered);
		} else if !is_reserved_extra(field.name()) {
			self.extras.push((
				field.name().to_owned(),
				serde_json::Value::String(redact_credentials(&rendered)),
			));
		}
	}

	fn record_str(&mut self, field: &Field, value: &str) {
		if field.name() == "message" {
			self.message = Some(value.to_owned());
		} else if !is_reserved_extra(field.name()) {
			self
				.extras
				.push((field.name().to_owned(), serde_json::Value::String(redact_credentials(value))));
		}
	}

	fn record_i64(&mut self, field: &Field, value: i64) {
		if !is_reserved_extra(field.name()) {
			self
				.extras
				.push((field.name().to_owned(), serde_json::Value::Number(value.into())));
		}
	}

	fn record_u64(&mut self, field: &Field, value: u64) {
		if !is_reserved_extra(field.name()) {
			self
				.extras
				.push((field.name().to_owned(), serde_json::Value::Number(value.into())));
		}
	}

	fn record_bool(&mut self, field: &Field, value: bool) {
		if !is_reserved_extra(field.name()) {
			self
				.extras
				.push((field.name().to_owned(), serde_json::Value::Bool(value)));
		}
	}
}

struct JsonFileLayer {
	sink: Arc<Mutex<Option<RotatingJsonSink>>>,
}

impl<S> Layer<S> for JsonFileLayer
where
	S: Subscriber,
{
	fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
		let mut fields = JsonFields::default();
		event.record(&mut fields);
		let metadata = event.metadata();
		let level = match *metadata.level() {
			TracingLevel::TRACE | TracingLevel::DEBUG => Level::Debug,
			TracingLevel::INFO => Level::Info,
			TracingLevel::WARN => Level::Warning,
			TracingLevel::ERROR => Level::Error,
		};
		let msg = fields.message.unwrap_or_default();
		let mut payload = serde_json::Map::new();
		payload.insert("ts".to_owned(), serde_json::Value::String(current_ts()));
		payload.insert("level".to_owned(), serde_json::Value::String(level.as_str().to_owned()));
		payload.insert("logger".to_owned(), serde_json::Value::String(metadata.target().to_owned()));
		payload.insert("msg".to_owned(), serde_json::Value::String(redact_credentials(&msg)));
		for (key, value) in fields.extras {
			payload.insert(key, value);
		}
		let line = serde_json::Value::Object(payload).to_string();
		if let Ok(mut guard) = self.sink.lock() {
			if let Some(sink) = guard.as_mut() {
				let _ = sink.write_line(&line);
			}
		}
	}
}

fn current_ts() -> String {
	let secs = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| d.as_secs());
	format_unix_ts(secs)
}

fn format_unix_ts(secs: u64) -> String {
	let days = secs / 86_400;
	let second_of_day = secs % 86_400;
	let (year, month, day) = civil_from_days(days as i64);
	format!(
		"{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
		second_of_day / 3600,
		second_of_day / 60 % 60,
		second_of_day % 60
	)
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u64, u64) {
	let z = days_since_epoch + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = mp + if mp < 10 { 3 } else { -9 };
	(y + i64::from(m <= 2), m as u64, d as u64)
}

fn target_filter(level: Level) -> EnvFilter {
	let default = match level {
		Level::Debug => "debug",
		Level::Info => "info",
		Level::Warning => "warn",
		Level::Error | Level::Critical => "error",
	};
	EnvFilter::builder()
		.parse_lossy(format!("{default},httpx=warn,httpcore=warn,uvicorn.access={default}"))
}

pub fn configure_logging(log_dir: Option<&Path>, level: Level) -> std::io::Result<bool> {
	let sink = json_sink();
	if let Some(dir) = log_dir {
		*sink.lock().expect("json log sink mutex poisoned") = Some(RotatingJsonSink::new(dir)?);
	}
	if INITIALIZED.swap(true, Ordering::SeqCst) {
		return Ok(false);
	}
	let pretty = tracing_subscriber::fmt::layer()
		.with_ansi(true)
		.with_target(true);
	let subscriber = tracing_subscriber::registry()
		.with(target_filter(level))
		.with(pretty)
		.with(JsonFileLayer { sink });
	let _ = tracing::subscriber::set_global_default(subscriber);
	Ok(true)
}

pub fn reset_logging_for_tests() {
	INITIALIZED.store(false, Ordering::SeqCst);
	if let Ok(mut guard) = json_sink().lock() {
		*guard = None;
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	static TEST_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

	fn log_test_guard() -> std::sync::MutexGuard<'static, ()> {
		TEST_LOG_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
	}
	#[test]
	fn redacts_user_password_in_urls() {
		assert_eq!(
			redact_credentials("clone https://user:pass@example.com/repo.git"),
			"clone https://***:***@example.com/repo.git"
		);
	}
	#[test]
	fn redacts_multiple_urls_and_preserves_tokenless() {
		let input = "https://a:b@one.invalid/x and https://two.invalid/y";
		assert_eq!(
			redact_credentials(input),
			"https://***:***@one.invalid/x and https://two.invalid/y"
		);
	}
	#[test]
	fn mutes_dashboard_polling_gets_only() {
		assert!(should_mute_dashboard_poll("GET", "/api/status?x=1"));
		assert!(should_mute_dashboard_poll("GET", "/healthz"));
		assert!(!should_mute_dashboard_poll("POST", "/healthz"));
		assert!(!should_mute_dashboard_poll("GET", "/api/other"));
	}
	#[test]
	fn json_record_redacts_message_and_extras() {
		let out = json_record(
			"robogjc.test",
			Level::Info,
			"https://u:p@host/x",
			&[("remote", "https://u:p@host/y")],
		);
		assert!(out.contains("***:***@host"));
		assert!(!out.contains("u:p@"));
	}
	#[test]
	fn configure_logging_is_idempotent() {
		let _guard = log_test_guard();
		reset_logging_for_tests();
		assert!(configure_logging(None, Level::Info).unwrap());
		assert!(!configure_logging(None, Level::Info).unwrap());
		reset_logging_for_tests();
	}
	#[test]
	fn configure_logging_stdout_only_first_call_succeeds() {
		let _guard = log_test_guard();
		reset_logging_for_tests();
		assert_eq!(configure_logging(None, Level::Info).unwrap(), true);
		reset_logging_for_tests();
	}
	#[test]
	fn configure_logging_writes_python_shaped_jsonl() {
		let _guard = log_test_guard();
		reset_logging_for_tests();
		let dir = std::env::temp_dir().join(format!("robogjc-log-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		let _ = configure_logging(Some(&dir), Level::Info).unwrap();
		let subscriber = tracing_subscriber::registry().with(JsonFileLayer { sink: json_sink() });
		tracing::subscriber::with_default(subscriber, || {
			tracing::info!(target: "robogjc.test", path = "/x", msg = "reserved", _private = "hidden", "hello https://u:p@host/x");
		});
		let text = std::fs::read_to_string(dir.join(JSON_LOG_FILE)).unwrap();
		let parsed: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
		assert!(parsed["ts"].as_str().unwrap().ends_with('Z'));
		assert_eq!(parsed["level"], "INFO");
		assert_eq!(parsed["logger"], "robogjc.test");
		assert_eq!(parsed["msg"], "hello https://***:***@host/x");
		assert_eq!(parsed["path"], "/x");
		assert!(parsed.get("_private").is_none());
		assert!(parsed.get("msg").is_some());
		let _ = std::fs::remove_dir_all(&dir);
	}
	#[test]
	fn json_record_matches_python_shape_and_filters_reserved() {
		let out = json_record_with_exception(
			"robogjc.test",
			Level::Error,
			"boom https://u:p@host/x",
			&[("path", "/x"), ("msg", "reserved"), ("_private", "hidden")],
			Some("Traceback https://u:p@host/y"),
		);
		let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
		assert_eq!(parsed["ts"], "1970-01-01T00:00:00Z");
		assert_eq!(parsed["level"], "ERROR");
		assert_eq!(parsed["logger"], "robogjc.test");
		assert_eq!(parsed["path"], "/x");
		assert!(
			parsed
				.get("exc")
				.unwrap()
				.as_str()
				.unwrap()
				.contains("***:***@host")
		);
		assert!(parsed.get("_private").is_none());
		assert!(!out.contains("u:p@"));
	}

	#[test]
	fn pretty_record_strips_package_prefix_and_filters_reserved() {
		let out = pretty_record(
			"robogjc.worker",
			Level::Info,
			"hello",
			&[("event", "done"), ("msg", "reserved")],
		);
		assert!(out.contains("worker"));
		assert!(out.contains("event=done"));
		assert!(!out.contains("msg=reserved"));
	}
}
