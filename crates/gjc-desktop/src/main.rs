mod discovery;
mod sidecar;

use std::sync::Arc;

use discovery::AppServerEndpoint;
use sidecar::{SharedSupervisor, SidecarSupervisor};
use tauri::State;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn get_app_server_endpoint(
	app: tauri::AppHandle,
	supervisor: State<'_, SharedSupervisor>,
) -> Result<AppServerEndpoint, String> {
	supervisor
		.endpoint(&app)
		.await
		.map_err(|error| error.to_string())
}

#[tauri::command]
async fn restart_app_server(
	app: tauri::AppHandle,
	supervisor: State<'_, SharedSupervisor>,
) -> Result<AppServerEndpoint, String> {
	supervisor
		.restart(&app)
		.await
		.map_err(|error| error.to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
	let selected = app.dialog().file().blocking_pick_folder();
	selected
		.map(|path| {
			path
				.into_path()
				.map(|path| path.to_string_lossy().into_owned())
				.map_err(|error| error.to_string())
		})
		.transpose()
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn pick_directory() -> Result<Option<String>, String> {
	Ok(None)
}

fn main() {
	hydrate_login_shell_env();
	apply_desktop_config_dir_override();
	let supervisor = Arc::new(SidecarSupervisor::new());
	let shutdown_supervisor = Arc::clone(&supervisor);

	let builder = tauri::Builder::default().manage(supervisor);
	#[cfg(not(target_os = "linux"))]
	let builder = builder.plugin(tauri_plugin_dialog::init());

	builder
		.invoke_handler(tauri::generate_handler![
			get_app_server_endpoint,
			restart_app_server,
			pick_directory
		])
		.on_window_event(move |_window, event| {
			if matches!(event, tauri::WindowEvent::Destroyed) {
				shutdown_supervisor.shutdown();
			}
		})
		.run(tauri::generate_context!())
		.expect("failed to run GJC desktop shell");
}

/// Finder/Launchpad-launched macOS apps do not inherit the user's interactive
/// shell environment, so `GJC_CONFIG_DIR` / `PI_CONFIG_DIR` (and `PATH`) set in
/// the login shell are missing and the bundled sidecar would fall back to the
/// default `~/.gjc` instead of the user's configured config dir. Recover them
/// from the login shell once at startup so the sidecar resolves the same
/// config/auth/sessions the CLI uses.
fn hydrate_login_shell_env() {
	let already_configured =
		std::env::var_os("GJC_CONFIG_DIR").is_some() || std::env::var_os("PI_CONFIG_DIR").is_some();
	let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
	let script = "printf '%s\\n%s\\n%s\\n' \"$GJC_CONFIG_DIR\" \"$PI_CONFIG_DIR\" \"$PATH\"";
	let Ok(output) = std::process::Command::new(&shell).args(["-lic", script]).output() else {
		return;
	};
	if !output.status.success() {
		return;
	}
	let stdout = String::from_utf8_lossy(&output.stdout);
	let mut lines = stdout.lines();
	let gjc_config = lines.next().unwrap_or("").trim();
	let pi_config = lines.next().unwrap_or("").trim();
	let path = lines.next().unwrap_or("").trim();
	if !already_configured {
		if !gjc_config.is_empty() {
			// SAFETY: set once at startup before Tauri spawns threads/children.
			unsafe { std::env::set_var("GJC_CONFIG_DIR", gjc_config) };
		}
		if !pi_config.is_empty() {
			// SAFETY: set once at startup before Tauri spawns threads/children.
			unsafe { std::env::set_var("PI_CONFIG_DIR", pi_config) };
		}
	}
	if !path.is_empty() {
		// SAFETY: set once at startup before Tauri spawns threads/children.
		unsafe { std::env::set_var("PATH", path) };
	}
}

/// Desktop-only config-dir override. When `GJC_DESKTOP_CONFIG_DIR` is set
/// (e.g. `launchctl setenv GJC_DESKTOP_CONFIG_DIR ~/.gjc1/.gjc` during
/// dogfooding), the bundled sidecar uses it as its `GJC_CONFIG_DIR` — keeping
/// the default `gjc` CLI on `~/.gjc` while the desktop app runs against a
/// separate config/auth/sessions dir. Takes precedence over login-shell
/// recovery; a no-op when unset.
fn apply_desktop_config_dir_override() {
	let Some(raw) = std::env::var_os("GJC_DESKTOP_CONFIG_DIR") else {
		return;
	};
	let value = raw.to_string_lossy();
	let trimmed = value.trim();
	if trimmed.is_empty() {
		return;
	}
	let expanded = if let Some(rest) = trimmed.strip_prefix("~/") {
		match std::env::var_os("HOME") {
			Some(home) => std::path::Path::new(&home).join(rest).to_string_lossy().into_owned(),
			None => trimmed.to_owned(),
		}
	} else {
		trimmed.to_owned()
	};
	// SAFETY: set once at startup before Tauri spawns threads/children.
	unsafe { std::env::set_var("GJC_CONFIG_DIR", &expanded) };
	// SAFETY: set once at startup before Tauri spawns threads/children.
	unsafe { std::env::remove_var("PI_CONFIG_DIR") };
}
