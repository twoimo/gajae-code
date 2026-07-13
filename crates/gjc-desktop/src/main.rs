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
	let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
	// Dump the full interactive login-shell environment so the sidecar resolves
	// config, provider credentials (API-key env vars), PATH, and model defaults
	// exactly like the `gjc` CLI does from a terminal.
	let Ok(output) = std::process::Command::new(&shell)
		.args(["-lic", "env"])
		.output()
	else {
		return;
	};
	if !output.status.success() {
		return;
	}
	let stdout = String::from_utf8_lossy(&output.stdout);
	for line in stdout.lines() {
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		// Only accept real env identifiers; this skips continuation lines of any
		// multi-line value instead of importing garbage.
		if !is_env_identifier(key) {
			continue;
		}
		// PATH always wins from the login shell; everything else only fills gaps
		// so an explicitly-set (launchd/terminal) value is preserved.
		if key == "PATH" || std::env::var_os(key).is_none() {
			// SAFETY: set once at startup before Tauri spawns threads/children.
			unsafe { std::env::set_var(key, value) };
		}
	}
}

fn is_env_identifier(key: &str) -> bool {
	let mut chars = key.chars();
	match chars.next() {
		Some(c) if c.is_ascii_alphabetic() || c == '_' => {},
		_ => return false,
	}
	chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
