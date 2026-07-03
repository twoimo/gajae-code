//! JSON-RPC NDJSON client for `gjc app-server`.

use std::{
	collections::BTreeMap, future::Future, pin::Pin, process::Stdio, sync::Arc, time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::{
	io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
	process::{Child, Command},
	sync::{Mutex as AsyncMutex, mpsc, oneshot},
};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, BoxError>;

pub type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

pub trait AppServerTransport: Send + Sync + 'static {
	fn send<'a>(&'a self, frame: Value) -> TransportFuture<'a, Value>;
	fn next_notification<'a>(&'a self) -> TransportFuture<'a, Option<Value>>;
	fn close<'a>(&'a self) -> TransportFuture<'a, ()>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ThreadRef {
	pub id: String,
	#[serde(default)]
	pub generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResumeThreadRef {
	pub thread: ThreadRef,
	pub resumed: bool,
}

pub struct TurnRef {
	pub id: Option<String>,
	pub raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostToolSpec {
	pub name: String,
	pub description: String,
	#[serde(rename = "inputSchema")]
	pub input_schema: Value,
	#[serde(rename = "resultPolicy", skip_serializing_if = "Option::is_none")]
	pub result_policy: Option<Value>,
	#[serde(rename = "redactionHints", skip_serializing_if = "Option::is_none")]
	pub redaction_hints: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AppServerNotification {
	TurnStarted(Value),
	ItemStarted(Value),
	AgentMessageDelta(Value),
	ItemCompleted(Value),
	TurnCompleted(Value),
	GjcEvent(Value),
	HostToolCall {
		thread_id: String,
		generation: u64,
		turn_id: String,
		call_id: String,
		tool: String,
		args: Value,
	},
	HostToolCancel {
		thread_id: String,
		generation: u64,
		turn_id: Option<String>,
		call_id: String,
	},
	Unknown(Value),
}

pub fn parse_notification(payload: Value) -> AppServerNotification {
	let method = payload
		.get("method")
		.and_then(Value::as_str)
		.unwrap_or_default();
	let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
	match method {
		"turn/started" | "turn_started" => AppServerNotification::TurnStarted(params),
		"item/started" | "item_started" => AppServerNotification::ItemStarted(params),
		"item/agentMessage/delta" | "agent/message/delta" | "agent_message_delta" => {
			AppServerNotification::AgentMessageDelta(params)
		},
		"item/completed" | "item_completed" => AppServerNotification::ItemCompleted(params),
		"turn/completed" | "turn_completed" => AppServerNotification::TurnCompleted(params),
		"gjc/event" => AppServerNotification::GjcEvent(params),
		"gjc/hostTools/call" => AppServerNotification::HostToolCall {
			thread_id: str_field(&params, "threadId"),
			generation: params
				.get("generation")
				.and_then(Value::as_u64)
				.unwrap_or(0),
			turn_id: str_field(&params, "turnId"),
			call_id: str_field(&params, "callId"),
			tool: str_field(&params, "tool"),
			args: params.get("args").cloned().unwrap_or_else(|| json!({})),
		},
		"gjc/hostTools/cancel" => AppServerNotification::HostToolCancel {
			thread_id: str_field(&params, "threadId"),
			generation: params
				.get("generation")
				.and_then(Value::as_u64)
				.unwrap_or(0),
			turn_id: params
				.get("turnId")
				.and_then(Value::as_str)
				.map(str::to_owned),
			call_id: str_field(&params, "callId"),
		},
		_ => AppServerNotification::Unknown(payload),
	}
}

fn str_field(params: &Value, key: &str) -> String {
	params
		.get(key)
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_owned()
}
fn parse_thread(result: &Value) -> Result<ThreadRef> {
	let thread = result
		.get("thread")
		.ok_or("thread response missing thread")?;
	let id = thread
		.get("id")
		.and_then(Value::as_str)
		.ok_or("thread.id missing")?
		.to_owned();
	let generation = thread.get("generation").and_then(Value::as_u64);
	Ok(ThreadRef { id, generation })
}

pub struct AppServerClient<T: AppServerTransport = StdioTransport> {
	transport: Arc<T>,
}

impl<T: AppServerTransport> Clone for AppServerClient<T> {
	fn clone(&self) -> Self {
		Self { transport: Arc::clone(&self.transport) }
	}
}

impl AppServerClient<StdioTransport> {
	pub async fn spawn(
		command: &[String],
		cwd: Option<std::path::PathBuf>,
		env: BTreeMap<String, String>,
	) -> Result<Self> {
		let transport = StdioTransport::spawn(command, cwd, env).await?;
		Ok(Self::new(transport))
	}
}

impl<T: AppServerTransport> AppServerClient<T> {
	pub fn new(transport: T) -> Self {
		Self { transport: Arc::new(transport) }
	}

	pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
		let mut frame = Map::new();
		frame.insert("method".to_owned(), Value::String(method.to_owned()));
		frame.insert("params".to_owned(), params);
		let response = self.transport.send(Value::Object(frame)).await?;
		if let Some(error) = response.get("error") {
			return Err(format!("app-server {method} error: {error}").into());
		}
		Ok(response.get("result").cloned().unwrap_or_else(|| json!({})))
	}

	pub async fn notify_initialized(&self) -> Result<()> {
		let _ = self
			.transport
			.send(json!({"method":"initialized","params":{}}))
			.await?;
		Ok(())
	}
	pub async fn initialize(&self, params: Value) -> Result<Value> {
		self.request("initialize", params).await
	}
	pub async fn start_thread(&self, params: Value) -> Result<ThreadRef> {
		self.thread_request("thread/start", params).await
	}
	pub async fn resume_thread(
		&self,
		thread_id: &str,
		mut params: Value,
	) -> Result<ResumeThreadRef> {
		params
			.as_object_mut()
			.ok_or("thread/resume params must be an object")?
			.insert("threadId".into(), thread_id.into());
		let result = self.request("thread/resume", params).await?;
		let thread = parse_thread(&result)?;
		let resumed = result
			.get("resumed")
			.and_then(Value::as_bool)
			.unwrap_or(true);
		Ok(ResumeThreadRef { thread, resumed })
	}
	async fn thread_request(&self, method: &str, params: Value) -> Result<ThreadRef> {
		let result = self.request(method, params).await?;
		parse_thread(&result)
	}

	pub async fn start_turn(
		&self,
		thread_id: &str,
		input: &str,
		mut params: Value,
	) -> Result<TurnRef> {
		let obj = params
			.as_object_mut()
			.ok_or("turn/start params must be an object")?;
		obj.insert("threadId".into(), thread_id.into());
		obj.insert("input".into(), input.into());
		let result = self.request("turn/start", params).await?;
		let turn = result
			.get("turn")
			.cloned()
			.ok_or("turn/start response missing turn")?;
		Ok(TurnRef { id: turn.get("id").and_then(Value::as_str).map(str::to_owned), raw: turn })
	}
	pub async fn steer(&self, thread_id: &str, input: &str, mut params: Value) -> Result<Value> {
		let obj = params
			.as_object_mut()
			.ok_or("turn/steer params must be an object")?;
		obj.insert("threadId".into(), thread_id.into());
		obj.insert("input".into(), input.into());
		self.request("turn/steer", params).await
	}
	pub async fn interrupt(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
		self
			.request("turn/interrupt", json!({"threadId":thread_id,"turnId":turn_id}))
			.await
	}
	pub async fn set_host_tools(&self, thread_id: &str, tools: Vec<HostToolSpec>) -> Result<Value> {
		self
			.request("gjc/hostTools/set", json!({"threadId":thread_id,"tools":tools}))
			.await
	}
	pub async fn send_host_tool_result(
		&self,
		thread_id: &str,
		call_id: &str,
		ok: bool,
		body: Value,
	) -> Result<Value> {
		let payload = if ok {
			json!({"threadId":thread_id,"callId":call_id,"ok":true,"result":body})
		} else {
			json!({"threadId":thread_id,"callId":call_id,"ok":false,"error":body})
		};
		self.request("gjc/hostTools/result", payload).await
	}
	pub async fn set_todos(&self, thread_id: &str, phases: Value) -> Result<Value> {
		self
			.request("gjc/todos/set", json!({"threadId":thread_id,"phases":phases}))
			.await
	}
	pub async fn next_notification(&self) -> Result<Option<AppServerNotification>> {
		Ok(self
			.transport
			.next_notification()
			.await?
			.map(parse_notification))
	}
	pub async fn close(&self) -> Result<()> {
		self.transport.close().await
	}
}

pub struct StdioTransport {
	writer: AsyncMutex<tokio::process::ChildStdin>,
	pending: Arc<AsyncMutex<BTreeMap<String, oneshot::Sender<Value>>>>,
	notifications: AsyncMutex<mpsc::UnboundedReceiver<Value>>,
	request_id: AsyncMutex<u64>,
	child: Arc<AsyncMutex<Child>>,
	stderr: Arc<AsyncMutex<String>>,
}

impl StdioTransport {
	pub async fn spawn(
		command: &[String],
		cwd: Option<std::path::PathBuf>,
		env: BTreeMap<String, String>,
	) -> Result<Self> {
		let (exe, args) = command
			.split_first()
			.ok_or("app-server command must not be empty")?;
		let mut cmd = Command::new(exe);
		cmd.args(args)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		if let Some(cwd) = cwd {
			cmd.current_dir(cwd);
		}
		cmd.envs(env);
		let mut child = cmd.spawn()?;
		let stdin = child.stdin.take().ok_or("app-server stdin unavailable")?;
		let stdout = child.stdout.take().ok_or("app-server stdout unavailable")?;
		let pending: Arc<AsyncMutex<BTreeMap<String, oneshot::Sender<Value>>>> =
			Arc::new(AsyncMutex::new(BTreeMap::new()));
		let (note_tx, note_rx) = mpsc::unbounded_channel();
		let reader_pending = Arc::clone(&pending);
		let reader_stderr = Arc::new(AsyncMutex::new(String::new()));
		let stderr_for_reader = Arc::clone(&reader_stderr);
		let stderr = child.stderr.take().ok_or("app-server stderr unavailable")?;
		let child_status = Arc::new(AsyncMutex::new(child));
		let child_for_reader = Arc::clone(&child_status);
		let stderr_capture = Arc::clone(&reader_stderr);
		tokio::spawn(async move {
			let mut buf = String::new();
			let mut reader = BufReader::new(stderr);
			let _ = reader.read_to_string(&mut buf).await;
			*stderr_capture.lock().await = buf;
		});
		tokio::spawn(async move {
			let mut lines = BufReader::new(stdout).lines();
			loop {
				match lines.next_line().await {
					Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
						Ok(payload)
							if payload.get("id").is_some()
								&& (payload.get("result").is_some() || payload.get("error").is_some()) =>
						{
							if let Some(id) = payload.get("id").and_then(Value::as_str) {
								if let Some(tx) = reader_pending.lock().await.remove(id) {
									let _ = tx.send(payload);
								}
							}
						},
						Ok(payload) => {
							let _ = note_tx.send(payload);
						},
						Err(err) => {
							let mut pending = reader_pending.lock().await;
							let message = reader_diagnostic(
								&stderr_for_reader,
								&child_for_reader,
								&format!("app-server emitted invalid JSON: {err}"),
							)
							.await;
							for (_, tx) in std::mem::take(&mut *pending) {
								let _ = tx.send(json!({"error":{"message":message}}));
							}
							break;
						},
					},
					Ok(None) => {
						let mut pending = reader_pending.lock().await;
						let message = reader_diagnostic(
							&stderr_for_reader,
							&child_for_reader,
							"app-server stdout closed",
						)
						.await;
						for (_, tx) in std::mem::take(&mut *pending) {
							let _ = tx.send(json!({"error":{"message":message}}));
						}
						break;
					},
					Err(err) => {
						let mut pending = reader_pending.lock().await;
						let message = reader_diagnostic(
							&stderr_for_reader,
							&child_for_reader,
							&format!("app-server stdout read failed: {err}"),
						)
						.await;
						for (_, tx) in std::mem::take(&mut *pending) {
							let _ = tx.send(json!({"error":{"message":message}}));
						}
						break;
					},
				}
			}
		});
		Ok(Self {
			writer: AsyncMutex::new(stdin),
			pending,
			notifications: AsyncMutex::new(note_rx),
			request_id: AsyncMutex::new(0),
			child: child_status,
			stderr: reader_stderr,
		})
	}
}

impl AppServerTransport for StdioTransport {
	fn send<'a>(&'a self, mut frame: Value) -> TransportFuture<'a, Value> {
		Box::pin(async move {
			let is_notification = frame.get("id").is_none()
				&& frame.get("method").and_then(Value::as_str) == Some("initialized");
			let (rx, id) = if is_notification {
				(None, String::new())
			} else {
				let mut next = self.request_id.lock().await;
				*next += 1;
				let id = format!("req_{}", *next);
				frame
					.as_object_mut()
					.ok_or("frame must be object")?
					.insert("id".into(), id.clone().into());
				let (tx, rx) = oneshot::channel();
				self.pending.lock().await.insert(id.clone(), tx);
				(Some(rx), id)
			};
			let mut writer = self.writer.lock().await;
			writer
				.write_all(serde_json::to_string(&frame)?.as_bytes())
				.await?;
			writer.write_all(b"\n").await?;
			writer.flush().await?;
			drop(writer);
			if let Some(rx) = rx {
				match tokio::time::timeout(Duration::from_secs(30), rx).await {
					Ok(Ok(v)) => Ok(v),
					Ok(Err(_)) => Err(
						self
							.with_stderr_status("app-server response channel closed")
							.await
							.into(),
					),
					Err(_) => {
						self.pending.lock().await.remove(&id);
						Err(
							self
								.with_stderr_status("app-server request timed out")
								.await
								.into(),
						)
					},
				}
			} else {
				Ok(json!({"result":{}}))
			}
		})
	}
	fn next_notification<'a>(&'a self) -> TransportFuture<'a, Option<Value>> {
		Box::pin(async move {
			match self.notifications.lock().await.recv().await {
				Some(value) => Ok(Some(value)),
				None => Err(
					self
						.with_stderr_status("app-server stdout closed before terminal notification")
						.await
						.into(),
				),
			}
		})
	}
	fn close<'a>(&'a self) -> TransportFuture<'a, ()> {
		Box::pin(async move {
			let _ = self.child.lock().await.kill().await;
			Ok(())
		})
	}
}
impl StdioTransport {
	async fn with_stderr_status(&self, message: &str) -> String {
		let stderr = self.stderr.lock().await.trim().to_owned();
		let status = match self.child.lock().await.try_wait() {
			Ok(Some(status)) => format!("; exit status: {status}"),
			Ok(None) => String::new(),
			Err(err) => format!("; exit status unavailable: {err}"),
		};
		if stderr.is_empty() {
			format!("{message}{status}")
		} else {
			format!("{message}; stderr: {stderr}{status}")
		}
	}
}
async fn reader_diagnostic(
	stderr: &Arc<AsyncMutex<String>>,
	child: &Arc<AsyncMutex<Child>>,
	message: &str,
) -> String {
	let status = {
		let mut child = child.lock().await;
		match child.try_wait() {
			Ok(Some(status)) => format!("; exit status: {status}"),
			Ok(None) => match tokio::time::timeout(Duration::from_millis(50), child.wait()).await {
				Ok(Ok(status)) => format!("; exit status: {status}"),
				Ok(Err(err)) => format!("; exit status unavailable: {err}"),
				Err(_) => String::new(),
			},
			Err(err) => format!("; exit status unavailable: {err}"),
		}
	};
	let stderr = stderr.lock().await.trim().to_owned();
	if stderr.is_empty() {
		format!("{message}{status}")
	} else {
		format!("{message}; stderr: {stderr}{status}")
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::Mutex;

	#[derive(Default)]
	struct FakeTransport {
		frames: Mutex<Vec<Value>>,
		notes: Mutex<Vec<Value>>,
	}
	impl AppServerTransport for FakeTransport {
		fn send<'a>(&'a self, frame: Value) -> TransportFuture<'a, Value> {
			Box::pin(async move {
				self.frames.lock().unwrap().push(frame.clone());
				let method = frame["method"].as_str().unwrap();
				Ok(match method {
					"thread/start" => json!({"result":{"thread":{"id":"thr","generation":0}}}),
					"turn/start" => json!({"result":{"turn":{"id":"turn"}}}),
					_ => json!({"result":{}}),
				})
			})
		}
		fn next_notification<'a>(&'a self) -> TransportFuture<'a, Option<Value>> {
			Box::pin(async move { Ok(self.notes.lock().unwrap().pop()) })
		}
		fn close<'a>(&'a self) -> TransportFuture<'a, ()> {
			Box::pin(async { Ok(()) })
		}
	}

	#[tokio::test]
	async fn app_server_client_sends_typed_requests() {
		let client = AppServerClient::new(FakeTransport::default());
		let thread = client.start_thread(json!({"cwd":"/repo"})).await.unwrap();
		assert_eq!(thread.id, "thr");
		let turn = client
			.start_turn(&thread.id, "hello", json!({}))
			.await
			.unwrap();
		assert_eq!(turn.id.as_deref(), Some("turn"));
	}

	#[test]
	fn app_server_client_parses_host_tool_call() {
		let parsed = parse_notification(
			json!({"method":"gjc/hostTools/call","params":{"threadId":"t","generation":2,"turnId":"u","callId":"c","tool":"lookup","args":{"q":1}}}),
		);
		assert!(matches!(parsed, AppServerNotification::HostToolCall { generation: 2, .. }));
	}

	#[test]
	fn app_server_client_parses_agent_message_delta_spelling() {
		let parsed =
			parse_notification(json!({"method":"item/agentMessage/delta","params":{"delta":"hi"}}));
		assert!(
			matches!(parsed, AppServerNotification::AgentMessageDelta(params) if params["delta"] == "hi")
		);
	}

	#[tokio::test]
	async fn stdio_pending_request_error_includes_stderr_and_status() {
		let command = vec![
			"/bin/sh".to_owned(),
			"-c".to_owned(),
			"printf 'boom\\n' >&2; printf 'not-json\\n'".to_owned(),
		];
		let client = AppServerClient::spawn(&command, None, BTreeMap::new())
			.await
			.unwrap();
		let err = client.initialize(json!({})).await.unwrap_err().to_string();
		assert!(err.contains("invalid JSON"));
		assert!(err.contains("stderr: boom"));
		assert!(err.contains("exit status"));
	}
}
