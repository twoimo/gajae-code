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
	pub host:       String,
	pub port:       u16,
	pub token:      String,
	pub session_id: String,
	pub state_root: PathBuf,
}

#[derive(Debug)]
pub struct WsServerHandle {
	addr:        SocketAddr,
	session_id:  String,
	state_root:  PathBuf,
	cancel:      CancellationToken,
	accept_task: JoinHandle<()>,
	stopped:     AtomicBool,
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
	let accept_task = tokio::spawn(accept_loop(listener, core, config.token, cancel.clone()));
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
	cancel: CancellationToken,
) {
	loop {
		tokio::select! {
			 () = cancel.cancelled() => break,
			 accepted = listener.accept() => {
				  let Ok((stream, _peer)) = accepted else { continue };
				  tokio::spawn(handle_conn(stream, Arc::clone(&core), token.clone(), cancel.clone()));
			 }
		}
	}
}

#[allow(clippy::result_large_err, reason = "ErrorResponse is mandated by tokio-tungstenite")]
async fn handle_conn(
	stream: TcpStream,
	core: Arc<AppServer>,
	token: String,
	cancel: CancellationToken,
) {
	let auth =
		move |req: &Request, resp: HandshakeResponse| -> Result<HandshakeResponse, ErrorResponse> {
			if req.headers().contains_key("origin") {
				return Err(error_response(StatusCode::FORBIDDEN, "forbidden"));
			}
			if req.method() == "GET" && req.uri().path() == "/readyz" {
				return Err(error_response(StatusCode::OK, "ready"));
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
