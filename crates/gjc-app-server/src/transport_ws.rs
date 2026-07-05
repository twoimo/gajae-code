//! Loopback WebSocket transport for the app-server core.

use std::{
	net::SocketAddr,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use futures_util::{SinkExt, StreamExt};
use tokio::{
	net::{TcpListener, TcpStream},
	task::JoinHandle,
};
use tokio_tungstenite::{
	accept_hdr_async,
	tungstenite::{
		Message,
		handshake::server::{ErrorResponse, Request, Response as HandshakeResponse},
		http::StatusCode,
	},
};
use tokio_util::sync::CancellationToken;

use crate::{
	discovery::{DiscoveryRecord, discovery_path},
	jsonrpc::{RequestId, Response, parse_inbound},
	server::AppServer,
};

#[derive(Debug, Clone)]
pub struct WsServerConfig {
	pub host: String,
	pub port: u16,
	pub token: String,
	pub session_id: String,
	pub state_root: PathBuf,
	pub allowed_origins: Vec<String>,
}

#[derive(Debug)]
pub struct WsServerHandle {
	addr: SocketAddr,
	session_id: String,
	state_root: PathBuf,
	cancel: CancellationToken,
	accept_task: JoinHandle<()>,
	stopped: AtomicBool,
}

impl WsServerHandle {
	#[must_use]
	pub const fn addr(&self) -> SocketAddr {
		self.addr
	}

	#[must_use]
	pub fn url(&self) -> String {
		format!("ws://{}:{}", self.addr.ip(), self.addr.port())
	}

	#[allow(
		clippy::unused_async,
		reason = "shutdown is awaited by the N-API server teardown path and kept async for API \
		          symmetry"
	)]
	pub async fn shutdown(&self) -> std::io::Result<()> {
		if self.stopped.swap(true, Ordering::SeqCst) {
			return Ok(());
		}
		self.cancel.cancel();
		self.accept_task.abort();
		cleanup_discovery(&self.state_root, &self.session_id)
	}
}

pub async fn start_ws(
	core: Arc<AppServer>,
	config: WsServerConfig,
) -> std::io::Result<WsServerHandle> {
	let listener = TcpListener::bind(format!("{}:{}", config.host, config.port)).await?;
	let addr = listener.local_addr()?;
	let mut record = DiscoveryRecord::new(
		config.session_id.clone(),
		&config.host,
		addr.port(),
		config.token.clone(),
	);
	record.url = format!("ws://{}:{}", config.host, addr.port());
	record.write_atomic(&discovery_path(&config.state_root, &config.session_id))?;
	let cancel = CancellationToken::new();
	let allowed_origins = normalize_allowed_origins(config.allowed_origins);
	let accept_task =
		tokio::spawn(accept_loop(listener, core, config.token, allowed_origins, cancel.clone()));
	Ok(WsServerHandle {
		addr,
		session_id: config.session_id,
		state_root: config.state_root,
		cancel,
		accept_task,
		stopped: AtomicBool::new(false),
	})
}

async fn accept_loop(
	listener: TcpListener,
	core: Arc<AppServer>,
	token: String,
	allowed_origins: Arc<[String]>,
	cancel: CancellationToken,
) {
	loop {
		tokio::select! {
			 () = cancel.cancelled() => break,
			 accepted = listener.accept() => {
				  let Ok((stream, _peer)) = accepted else { continue };
				  tokio::spawn(handle_conn(
						stream,
						Arc::clone(&core),
						token.clone(),
						Arc::clone(&allowed_origins),
						cancel.clone(),
				  ));
			 }
		}
	}
}

#[allow(clippy::result_large_err, reason = "ErrorResponse is mandated by tokio-tungstenite")]
async fn handle_conn(
	stream: TcpStream,
	core: Arc<AppServer>,
	token: String,
	allowed_origins: Arc<[String]>,
	cancel: CancellationToken,
) {
	let auth =
		move |req: &Request, resp: HandshakeResponse| -> Result<HandshakeResponse, ErrorResponse> {
			if req.method() == "GET" && req.uri().path() == "/readyz" {
				return Err(error_response(StatusCode::OK, "ready"));
			}
			if !origin_allowed(req, &allowed_origins) {
				return Err(error_response(StatusCode::FORBIDDEN, "forbidden"));
			}
			if token_from_query(req.uri().query()).is_some_and(|t| tokens_match(&t, &token)) {
				Ok(resp)
			} else {
				Err(error_response(StatusCode::UNAUTHORIZED, "unauthorized"))
			}
		};
	let Ok(ws) = accept_hdr_async(stream, auth).await else {
		return;
	};
	let conn = core.open_connection();
	let (mut write, mut read) = ws.split();
	let mut events = core.subscribe_events();
	loop {
		tokio::select! {
			 () = cancel.cancelled() => break,
			 event = events.recv() => match event {
				  Ok(note) => {
						if !core.should_forward(&conn, &note) { continue; }
						let Ok(text) = serde_json::to_string(&note) else { continue };
						if write.send(Message::Text(text)).await.is_err() { break; }
				  }
				  Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
				  Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
			 },
			 incoming = read.next() => match incoming {
				  Some(Ok(Message::Text(text))) => {
						let resp = match parse_inbound(text.as_str()) {
							 Ok(inbound) => core.dispatch(&conn, inbound).await,
							 Err(err) => Some(Response::err(RequestId::Number(0), err)),
						};
						if let Some(resp) = resp {
							 let Ok(text) = serde_json::to_string(&resp) else { break };
							 if write.send(Message::Text(text)).await.is_err() { break; }
						}
				  }
				  Some(Ok(Message::Ping(payload))) => { if write.send(Message::Pong(payload)).await.is_err() { break; } }
				  Some(Ok(Message::Close(_))) | None => break,
				  Some(Ok(_)) => {}
				  Some(Err(_)) => break,
			 }
		}
	}
	core.close_connection(&conn);
}

fn error_response(status: StatusCode, body: &str) -> ErrorResponse {
	let body = ErrorResponse::new(Some(body.to_owned()));
	let (mut parts, body) = body.into_parts();
	parts.status = status;
	ErrorResponse::from_parts(parts, body)
}

fn normalize_allowed_origins(origins: Vec<String>) -> Arc<[String]> {
	origins
		.into_iter()
		.filter_map(|origin| normalize_origin(origin.trim()))
		.collect::<Vec<_>>()
		.into()
}

fn origin_allowed(req: &Request, allowed_origins: &[String]) -> bool {
	let Some(origin) = req.headers().get("origin") else {
		return true;
	};
	let Ok(origin) = origin.to_str() else {
		return false;
	};
	let Some(origin) = normalize_origin(origin) else {
		return false;
	};
	allowed_origins.iter().any(|allowed| allowed == &origin)
}

fn normalize_origin(origin: &str) -> Option<String> {
	let origin = origin.trim();
	if origin.is_empty() || origin.contains('*') {
		return None;
	}
	let (scheme, rest) = origin.split_once("://")?;
	if scheme.is_empty()
		|| rest.is_empty()
		|| rest.contains('/')
		|| rest.contains('?')
		|| rest.contains('#')
	{
		return None;
	}
	Some(format!("{}://{}", scheme.to_ascii_lowercase(), rest.to_ascii_lowercase()))
}
fn cleanup_discovery(state_root: &Path, session_id: &str) -> std::io::Result<()> {
	let path = discovery_path(state_root, session_id);
	match std::fs::remove_file(&path) {
		Ok(()) => Ok(()),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
		Err(remove_err) => {
			let data = std::fs::read_to_string(&path)?;
			let mut record: DiscoveryRecord =
				serde_json::from_str(&data).map_err(std::io::Error::other)?;
			record.stale = true;
			record.write_atomic(&path).map_err(|write_err| {
				std::io::Error::new(
					write_err.kind(),
					format!(
						"failed to remove discovery record ({remove_err}); also failed to mark stale: \
						 {write_err}"
					),
				)
			})
		},
	}
}

#[must_use]
pub fn token_from_query(query: Option<&str>) -> Option<String> {
	query?.split('&').find_map(|part| {
		let (key, value) = part.split_once('=')?;
		(key == "token").then(|| value.to_owned())
	})
}

#[must_use]
pub fn tokens_match(a: &str, b: &str) -> bool {
	if a.len() != b.len() {
		return false;
	}
	a.bytes()
		.zip(b.bytes())
		.fold(0_u8, |acc, (x, y)| acc | (x ^ y))
		== 0
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use async_trait::async_trait;
	use tokio::{
		io::{AsyncReadExt, AsyncWriteExt},
		net::TcpStream,
	};

	use super::*;
	use crate::{
		backend::{AgentBackend, BackendCallContext, BackendFactory, BackendHandleInfo},
		error::Result,
		identity::SessionMetadata,
		ids::{BackendGeneration, ThreadId, TurnId},
		server::{AppServer, AppServerConfig, EventSink},
	};

	struct FakeBackend;

	#[async_trait]
	impl AgentBackend for FakeBackend {
		async fn prompt(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<TurnId> {
			Ok(TurnId::generate())
		}

		async fn steer(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<TurnId> {
			Ok(TurnId::generate())
		}

		async fn abort(&self, _c: &BackendCallContext, _t: &TurnId) -> Result<()> {
			Ok(())
		}

		async fn get_state(
			&self,
			_c: &BackendCallContext,
			_i: serde_json::Value,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn get_messages(&self, _c: &BackendCallContext) -> Result<serde_json::Value> {
			Ok(serde_json::json!([]))
		}

		async fn set_model(
			&self,
			_c: &BackendCallContext,
			_p: &str,
			_m: &str,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn compact(
			&self,
			_c: &BackendCallContext,
			_i: Option<&str>,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn set_todos(&self, _c: &BackendCallContext, _p: serde_json::Value) -> Result<()> {
			Ok(())
		}

		async fn exec(
			&self,
			_c: &BackendCallContext,
			_p: serde_json::Value,
		) -> Result<serde_json::Value> {
			Ok(serde_json::json!({}))
		}

		async fn dispose(&self, _c: &BackendCallContext) -> Result<()> {
			Ok(())
		}
	}

	struct FakeFactory;

	#[async_trait]
	impl BackendFactory for FakeFactory {
		async fn create_thread(
			&self,
			_p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			Ok((handle_info(), Arc::new(FakeBackend)))
		}

		async fn resume_thread(
			&self,
			p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			self.create_thread(p).await
		}

		async fn fork_thread(
			&self,
			p: serde_json::Value,
		) -> Result<(BackendHandleInfo, Arc<dyn AgentBackend>)> {
			self.create_thread(p).await
		}
	}

	fn handle_info() -> BackendHandleInfo {
		BackendHandleInfo {
			thread_id: ThreadId::generate(),
			generation: BackendGeneration::FIRST,
			session_metadata: SessionMetadata::default(),
		}
	}

	struct NullSink;

	impl EventSink for NullSink {
		fn emit(&self, _note: crate::jsonrpc::Notification) {}
	}

	fn server() -> Arc<AppServer> {
		Arc::new(AppServer::new(
			Arc::new(FakeFactory),
			AppServerConfig::default(),
			Arc::new(NullSink),
		))
	}

	fn state_root(name: &str) -> PathBuf {
		std::env::temp_dir().join(format!("gjc-app-server-ws-test-{name}-{}", std::process::id()))
	}

	async fn start(allowed_origins: Vec<String>) -> WsServerHandle {
		let session_id = format!("sess-{}", unique_suffix());
		let state_root = state_root(&session_id);
		std::fs::create_dir_all(&state_root).unwrap();
		start_ws(
			server(),
			WsServerConfig {
				host: "127.0.0.1".to_owned(),
				port: 0,
				token: "secret".to_owned(),
				session_id,
				state_root,
				allowed_origins,
			},
		)
		.await
		.unwrap()
	}

	fn unique_suffix() -> String {
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos()
			.to_string()
	}

	async fn handshake_status(handle: &WsServerHandle, path: &str, origin: Option<&str>) -> String {
		let mut stream = TcpStream::connect(handle.addr()).await.unwrap();
		let origin = origin
			.map(|value| format!("Origin: {value}\r\n"))
			.unwrap_or_default();
		let request = format!(
			"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: \
			 Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: \
			 13\r\n{origin}\r\n"
		);
		stream.write_all(request.as_bytes()).await.unwrap();
		let mut buf = vec![0; 1024];
		let n = stream.read(&mut buf).await.unwrap();
		String::from_utf8_lossy(&buf[..n]).into_owned()
	}

	#[tokio::test]
	async fn origin_and_token_matrix_is_enforced() {
		let handle = start(vec!["TAURI://LOCALHOST".to_owned()]).await;
		assert!(
			handshake_status(&handle, "/?token=secret", None)
				.await
				.starts_with("HTTP/1.1 101")
		);
		assert!(
			handshake_status(&handle, "/?token=secret", Some("tauri://localhost"))
				.await
				.starts_with("HTTP/1.1 101")
		);
		assert!(
			handshake_status(&handle, "/?token=secret", Some("http://evil.local"))
				.await
				.contains(" 403 ")
		);
		assert!(
			handshake_status(&handle, "/", Some("tauri://localhost"))
				.await
				.contains(" 401 ")
		);
		assert!(
			handshake_status(&handle, "/?token=wrong", Some("tauri://localhost"))
				.await
				.contains(" 401 ")
		);
		handle.shutdown().await.unwrap();
	}

	#[tokio::test]
	async fn readyz_does_not_leak_token() {
		let handle = start(vec!["tauri://localhost".to_owned()]).await;
		let response = handshake_status(&handle, "/readyz", None).await;
		assert!(!response.contains("secret"));
		handle.shutdown().await.unwrap();
	}
}
