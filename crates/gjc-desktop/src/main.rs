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
