use std::{
	path::PathBuf,
	sync::Once,
	time::{SystemTime, UNIX_EPOCH},
};

use napi_derive::napi;

static INIT: Once = Once::new();
const ENABLE_ENV: &str = "GJC_NATIVE_CRASH_DIAGNOSTICS";
const DIR_ENV: &str = "GJC_CRASH_DIAGNOSTICS_DIR";

/// Installs a Rust panic hook only when `GJC_NATIVE_CRASH_DIAGNOSTICS` is set.
///
/// This is an opt-in structured panic report, not a minidump/signal handler.
/// It intentionally avoids always-on work and does not attempt to recover from
/// panics crossing N-API boundaries.
#[napi(js_name = "initNativeCrashDiagnostics")]
pub fn init_native_crash_diagnostics() -> bool {
	if !enabled() {
		return false;
	}

	INIT.call_once(|| {
		let previous = std::panic::take_hook();
		std::panic::set_hook(Box::new(move |info| {
			write_panic_report(info);
			previous(info);
		}));
	});

	true
}

/// Verifies that a panic raised by native code unwinds to its Rust boundary and
/// is converted to a normal N-API result rather than aborting the host.
#[napi(js_name = "nativePanicUnwindProbe")]
pub fn native_panic_unwind_probe() -> bool {
	std::panic::catch_unwind(|| panic!("native unwind probe")).is_err()
}

/// Captures a symbolized Rust backtrace while the debug sidecar is loaded.
#[napi(js_name = "nativeDebugSidecarBacktraceProbe")]
pub fn native_debug_sidecar_backtrace_probe() -> String {
	std::backtrace::Backtrace::force_capture().to_string()
}

fn enabled() -> bool {
	matches!(std::env::var(ENABLE_ENV).ok().as_deref(), Some("1" | "true" | "yes"))
}

fn write_panic_report(info: &std::panic::PanicHookInfo<'_>) {
	let dir = std::env::var_os(DIR_ENV)
		.map_or_else(|| std::env::temp_dir().join("gjc-crash-diagnostics"), PathBuf::from);
	if std::fs::create_dir_all(&dir).is_err() {
		return;
	}

	let now_ms = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| duration.as_millis());
	let path = dir.join(format!("{now_ms}-native-panic-{}.json", std::process::id()));
	let payload = panic_payload(info);
	let location = info.location().map_or_else(
		|| "<unknown>".to_string(),
		|location| format!("{}:{}:{}", location.file(), location.line(), location.column()),
	);
	let report = serde_json::json!({
		"schemaVersion": 1,
		"kind": "native",
		"class": "native_panic",
		"crashed": true,
		"pid": std::process::id(),
		"payload": payload,
		"location": location,
	});
	let _ = std::fs::write(path, format!("{report}\n"));
}

fn panic_payload(info: &std::panic::PanicHookInfo<'_>) -> String {
	if let Some(value) = info.payload().downcast_ref::<&str>() {
		return (*value).to_string();
	}
	if let Some(value) = info.payload().downcast_ref::<String>() {
		return value.clone();
	}
	"<non-string panic payload>".to_string()
}
