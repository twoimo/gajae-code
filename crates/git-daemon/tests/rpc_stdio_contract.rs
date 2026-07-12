#![cfg(unix)]

use std::{
	collections::HashSet,
	env, io,
	os::unix::process::CommandExt as _,
	path::{Path, PathBuf},
	pin::Pin,
	process::Stdio,
	sync::{Arc, Mutex},
	task::{Context, Poll},
	time::{SystemTime, UNIX_EPOCH},
};

use git_daemon::{
	RpcClient, SocketWorkRunner, StreamEvent, WorkRunner, parse_stream_event, reduce_run_events,
	unbounded_negotiation,
};
use serde_json::{Value, json};
use tokio::{
	io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf},
	process::{Child, ChildStdin, ChildStdout, Command},
	task::JoinHandle,
	time::{Duration, Instant, timeout},
};

const READINESS_TIMEOUT: Duration = Duration::from_secs(10);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(20);
const REPLAY_WINDOW: u64 = 16;
const AGENT_WIRE_PROTOCOL_VERSION: u64 = 2;
const PROMPT_REQUEST_ID: &str = "git-daemon-rpc-stdio-contract-prompt";

struct RecordingRead<R> {
	inner:    R,
	captured: Arc<Mutex<Vec<u8>>>,
}

impl<R> RecordingRead<R> {
	fn new(inner: R, captured: Arc<Mutex<Vec<u8>>>) -> Self {
		Self { inner, captured }
	}
}

impl<R: AsyncRead + Unpin> AsyncRead for RecordingRead<R> {
	fn poll_read(
		self: Pin<&mut Self>,
		cx: &mut Context<'_>,
		buf: &mut ReadBuf<'_>,
	) -> Poll<io::Result<()>> {
		let this = self.get_mut();
		let before = buf.filled().len();
		match Pin::new(&mut this.inner).poll_read(cx, buf) {
			Poll::Ready(Ok(())) => {
				let after = buf.filled().len();
				if after > before {
					this
						.captured
						.lock()
						.expect("stdout capture lock")
						.extend_from_slice(&buf.filled()[before..after]);
				}
				Poll::Ready(Ok(()))
			},
			other => other,
		}
	}
}

struct ProcessCapture {
	label:  String,
	stdout: Vec<u8>,
	stderr: Vec<u8>,
}

struct ManagedProcess {
	child:          Child,
	label:          String,
	stdout_capture: Arc<Mutex<Vec<u8>>>,
	stderr_task:    JoinHandle<io::Result<Vec<u8>>>,
}

impl ManagedProcess {
	async fn shutdown(mut self) -> ProcessCapture {
		let pid = self.child.id();
		if self.child.try_wait().ok().flatten().is_none() {
			let _ = signal_process_group(pid, "TERM").await;
			if timeout(Duration::from_secs(2), self.child.wait())
				.await
				.is_err()
			{
				let _ = signal_process_group(pid, "KILL").await;
				let _ = timeout(Duration::from_secs(2), self.child.wait()).await;
			}
		}

		let mut stderr_task = self.stderr_task;
		let stderr = match timeout(Duration::from_secs(2), &mut stderr_task).await {
			Ok(Ok(Ok(bytes))) => bytes,
			Ok(Ok(Err(error))) => format!("failed to capture stderr: {error}").into_bytes(),
			Ok(Err(error)) => format!("stderr task failed: {error}").into_bytes(),
			Err(_) => {
				stderr_task.abort();
				b"stderr capture timed out".to_vec()
			},
		};
		let stdout = self
			.stdout_capture
			.lock()
			.map_or_else(|_| b"stdout capture lock poisoned".to_vec(), |captured| captured.clone());
		ProcessCapture { label: self.label, stdout, stderr }
	}
}

struct SpawnedBun {
	process: ManagedProcess,
	stdin:   ChildStdin,
	stdout:  RecordingRead<ChildStdout>,
}

async fn signal_process_group(pid: Option<u32>, signal: &str) -> io::Result<()> {
	let Some(pid) = pid else {
		return Ok(());
	};
	let _status = Command::new("/bin/kill")
		.arg(format!("-{signal}"))
		.arg(format!("-{pid}"))
		.status()
		.await?;
	Ok(())
}

async fn collect_reader<R: AsyncRead + Unpin>(mut reader: R) -> io::Result<Vec<u8>> {
	let mut bytes = Vec::new();
	reader.read_to_end(&mut bytes).await?;
	Ok(bytes)
}

fn safe_path() -> Result<String, String> {
	env::var("PATH").map_err(|error| format!("PATH is required to spawn Bun: {error}"))
}

fn sanitize_environment(command: &mut Command, home: &Path) -> Result<(), String> {
	command.env_clear();
	command
		.env("PATH", safe_path()?)
		.env("HOME", home)
		.env("TMPDIR", home)
		.env("XDG_CONFIG_HOME", home.join("config"))
		.env("XDG_CACHE_HOME", home.join("cache"))
		.env("CI", "1")
		.env("NO_COLOR", "1")
		.env("PI_NOTIFICATIONS", "off");
	Ok(())
}

async fn spawn_bun(
	label: &str,
	args: &[String],
	current_dir: &Path,
	home: &Path,
	extra_env: &[(&str, PathBuf)],
) -> Result<SpawnedBun, String> {
	let mut command = Command::new("bun");
	command
		.args(args)
		.current_dir(current_dir)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	sanitize_environment(&mut command, home)?;
	for (name, value) in extra_env {
		command.env(name, value);
	}
	command.as_std_mut().process_group(0);

	let mut child = command
		.spawn()
		.map_err(|error| format!("spawn {label}: {error}"))?;
	let stdin = child
		.stdin
		.take()
		.ok_or_else(|| format!("{label} stdin was not piped"))?;
	let stdout = child
		.stdout
		.take()
		.ok_or_else(|| format!("{label} stdout was not piped"))?;
	let stderr = child
		.stderr
		.take()
		.ok_or_else(|| format!("{label} stderr was not piped"))?;
	let stdout_capture = Arc::new(Mutex::new(Vec::new()));
	let stderr_task = tokio::spawn(collect_reader(stderr));
	Ok(SpawnedBun {
		process: ManagedProcess {
			child,
			label: label.to_owned(),
			stdout_capture: Arc::clone(&stdout_capture),
			stderr_task,
		},
		stdin,
		stdout: RecordingRead::new(stdout, stdout_capture),
	})
}

fn unique_temp_dir(label: &str) -> Result<PathBuf, String> {
	let nanos = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_err(|error| format!("clock before epoch: {error}"))?
		.as_nanos();
	let dir = env::temp_dir().join(format!("git-daemon-{label}-{}-{nanos}", std::process::id()));
	std::fs::create_dir_all(&dir).map_err(|error| format!("create {}: {error}", dir.display()))?;
	Ok(dir)
}

fn repo_root() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../..")
		.canonicalize()
		.expect("repo root")
}

fn models_yaml(port: u16) -> String {
	format!(
		"providers:\n  git-daemon-fixture:\n    auth: none\n    api: openai-responses\n    baseUrl: http://127.0.0.1:{port}/v1\n    models:\n      - id: git-daemon-fixture-model\n        contextWindow: 100000\n        maxTokens: 4096\n        cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }}\n"
	)
}

fn prepare_workspace(workspace: &Path, port: u16) -> Result<(PathBuf, PathBuf), String> {
	let agent_dir = workspace.join(".gjc/agent");
	let state_root = workspace.join("harness-state");
	std::fs::create_dir_all(&agent_dir).map_err(|error| format!("create agent dir: {error}"))?;
	std::fs::create_dir_all(&state_root).map_err(|error| format!("create state root: {error}"))?;
	std::fs::write(agent_dir.join("models.yml"), models_yaml(port))
		.map_err(|error| format!("write fixture models.yml: {error}"))?;
	Ok((agent_dir, state_root))
}

fn as_event(frame: &Value) -> Option<&Value> {
	(frame.get("type").and_then(Value::as_str) == Some("event")).then_some(frame)
}

fn response_is(frame: &Value, command: &str, id: Option<&str>) -> bool {
	frame.get("type").and_then(Value::as_str) == Some("response")
		&& frame.get("command").and_then(Value::as_str) == Some(command)
		&& id.is_none_or(|expected| frame.get("id").and_then(Value::as_str) == Some(expected))
}

async fn next_frame<S>(
	client: &mut RpcClient<S>,
	deadline: Instant,
	label: &str,
) -> Result<Value, String>
where
	S: AsyncRead + tokio::io::AsyncWrite + Unpin,
{
	let remaining = deadline
		.checked_duration_since(Instant::now())
		.ok_or_else(|| format!("{label} timed out"))?;
	let frame = timeout(remaining, client.next_frame())
		.await
		.map_err(|_| format!("{label} timed out"))?
		.map_err(|error| format!("{label} transport error: {error}"))?
		.ok_or_else(|| format!("{label} reached EOF"))?;
	Ok(frame)
}

async fn await_ready<S>(client: &mut RpcClient<S>) -> Result<(), String>
where
	S: AsyncRead + tokio::io::AsyncWrite + Unpin,
{
	let deadline = Instant::now() + READINESS_TIMEOUT;
	loop {
		let frame = next_frame(client, deadline, "ready frame").await?;
		if frame.get("type").and_then(Value::as_str) == Some("ready") {
			return Ok(());
		}
	}
}

async fn drive_to_gate<S>(
	client: &mut RpcClient<S>,
	events: &mut Vec<Value>,
) -> Result<Value, String>
where
	S: AsyncRead + tokio::io::AsyncWrite + Unpin,
{
	client
		.send(&unbounded_negotiation("git-daemon", &["prompt", "control"], &["command.control"]))
		.await
		.map_err(|error| format!("send negotiation: {error}"))?;
	let negotiation_deadline = Instant::now() + OPERATION_TIMEOUT;
	loop {
		let frame = next_frame(client, negotiation_deadline, "negotiate_unattended response").await?;
		if let Some(event) = as_event(&frame) {
			events.push(event.clone());
		}
		if response_is(&frame, "negotiate_unattended", None) {
			if frame.get("success").and_then(Value::as_bool) != Some(true) {
				return Err(format!("unbounded negotiation was rejected: {frame}"));
			}
			break;
		}
	}

	client
		.send(&json!({ "id": PROMPT_REQUEST_ID, "type": "prompt", "message": "Run the deterministic workflow-gate fixture." }))
		.await
		.map_err(|error| format!("send prompt: {error}"))?;
	let prompt_deadline = Instant::now() + OPERATION_TIMEOUT;
	let mut prompt_acknowledged = false;
	loop {
		let frame =
			next_frame(client, prompt_deadline, "prompt acknowledgement or workflow gate").await?;
		if let Some(event) = as_event(&frame) {
			events.push(event.clone());
		}
		if response_is(&frame, "prompt", Some(PROMPT_REQUEST_ID)) {
			if frame.get("success").and_then(Value::as_bool) != Some(true) {
				return Err(format!("prompt was rejected: {frame}"));
			}
			prompt_acknowledged = true;
		}
		if frame.get("type").and_then(Value::as_str) == Some("workflow_gate") {
			if !prompt_acknowledged {
				return Err(format!("workflow gate arrived before prompt acknowledgement: {frame}"));
			}
			return Ok(frame);
		}
	}
}

async fn answer_gate<S>(
	client: &mut RpcClient<S>,
	gate: &Value,
	answer: Value,
	response_id: &str,
	events: &mut Vec<Value>,
	wait_for_terminal: bool,
) -> Result<(), String>
where
	S: AsyncRead + tokio::io::AsyncWrite + Unpin,
{
	let gate_id = gate
		.get("gate_id")
		.and_then(Value::as_str)
		.ok_or_else(|| format!("workflow gate has no gate_id: {gate}"))?;
	client
		.send(&json!({
			"id": response_id,
			"type": "workflow_gate_response",
			"gate_id": gate_id,
			"answer": answer,
		}))
		.await
		.map_err(|error| format!("send workflow_gate_response: {error}"))?;

	let deadline = Instant::now() + OPERATION_TIMEOUT;
	let mut answered = false;
	loop {
		let frame = next_frame(client, deadline, "workflow gate resolution").await?;
		if let Some(event) = as_event(&frame) {
			events.push(event.clone());
			if wait_for_terminal
				&& event.pointer("/payload/event_type").and_then(Value::as_str) == Some("agent_end")
			{
				if !answered {
					return Err("agent ended before workflow_gate_response was acknowledged".to_owned());
				}
				return Ok(());
			}
		}
		if response_is(&frame, "workflow_gate_response", Some(response_id)) {
			if frame.get("success").and_then(Value::as_bool) != Some(true)
				|| frame.pointer("/data/status").and_then(Value::as_str) != Some("accepted")
			{
				return Err(format!("workflow gate answer was not accepted: {frame}"));
			}
			answered = true;
			if !wait_for_terminal {
				return Ok(());
			}
		}
	}
}

fn assert_canonical_event_sequence(events: &[Value]) -> Result<(), String> {
	if events.is_empty() {
		return Err("the real RPC server emitted no canonical event frames".to_owned());
	}
	let mut session_id: Option<&str> = None;
	let mut previous_seq = 0;
	let mut frame_ids = HashSet::new();
	let mut event_types = Vec::new();
	for frame in events {
		if frame.get("type").and_then(Value::as_str) != Some("event") {
			return Err(format!("non-event stored as canonical event: {frame}"));
		}
		if frame.get("protocol_version").and_then(Value::as_u64) != Some(AGENT_WIRE_PROTOCOL_VERSION)
		{
			return Err(format!("event has wrong protocol version: {frame}"));
		}
		let current_session = frame
			.get("session_id")
			.and_then(Value::as_str)
			.ok_or_else(|| format!("event has no session_id: {frame}"))?;
		if let Some(expected) = session_id {
			if expected != current_session {
				return Err(format!("event session changed from {expected} to {current_session}"));
			}
		} else {
			session_id = Some(current_session);
		}
		let seq = frame
			.get("seq")
			.and_then(Value::as_u64)
			.ok_or_else(|| format!("event has no seq: {frame}"))?;
		if seq <= previous_seq {
			return Err(format!("event sequence is not monotonic: {previous_seq} then {seq}"));
		}
		previous_seq = seq;
		let frame_id = frame
			.get("frame_id")
			.and_then(Value::as_str)
			.ok_or_else(|| format!("event has no frame_id: {frame}"))?;
		if !frame_ids.insert(frame_id) {
			return Err(format!("duplicate event frame_id: {frame_id}"));
		}
		let event_type = frame
			.pointer("/payload/event_type")
			.and_then(Value::as_str)
			.ok_or_else(|| format!("event has no payload.event_type: {frame}"))?;
		if frame.pointer("/payload/event/type").and_then(Value::as_str) != Some(event_type) {
			return Err(format!("event_type does not match inner event type: {frame}"));
		}
		event_types.push(event_type);
	}
	let mut lifecycle_state = 0;
	for event_type in event_types {
		match (lifecycle_state, event_type) {
			(_, "message_start") => lifecycle_state = 1,
			(1, "message_update") => lifecycle_state = 2,
			(2, "message_end") => return Ok(()),
			_ => {},
		}
	}
	Err("missing an ordered message_start -> message_update -> message_end lifecycle".to_owned())
}

fn event_message_contains(events: &[Value], needle: &str) -> bool {
	events.iter().any(|frame| {
		frame.pointer("/payload/event_type").and_then(Value::as_str) == Some("message_end")
			&& frame
				.pointer("/payload/event/message/content/0/text")
				.and_then(Value::as_str)
				.is_some_and(|text| text.contains(needle))
	})
}

fn ask_tool_execution_count(events: &[Value]) -> usize {
	events
		.iter()
		.filter(|frame| {
			frame.pointer("/payload/event_type").and_then(Value::as_str)
				== Some("tool_execution_start")
				&& frame
					.pointer("/payload/event/toolName")
					.and_then(Value::as_str)
					== Some("ask")
		})
		.count()
}

fn captured_process_output(captures: &[ProcessCapture]) -> String {
	captures
		.iter()
		.map(|capture| {
			format!(
				"\n--- {} stdout ---\n{}\n--- {} stderr ---\n{}\n",
				capture.label,
				String::from_utf8_lossy(&capture.stdout),
				capture.label,
				String::from_utf8_lossy(&capture.stderr),
			)
		})
		.collect()
}

#[tokio::test]
async fn real_stdio_server_completes_after_approved_or_denied_workflow_gate() {
	let root = repo_root();
	let workspace = unique_temp_dir("rpc-stdio-contract").expect("temporary workspace");
	let provider_script = root.join("crates/git-daemon/tests/fixtures/fake-provider.ts");
	let provider_args = vec![provider_script.display().to_string()];
	let provider = spawn_bun("fake provider", &provider_args, &root, &workspace, &[])
		.await
		.expect("spawn fake provider");
	let mut processes = vec![provider.process];
	let mut provider_stdout = tokio::io::BufReader::new(provider.stdout);
	let mut provider_port_line = String::new();
	let provider_port_result =
		timeout(READINESS_TIMEOUT, provider_stdout.read_line(&mut provider_port_line)).await;
	let result = async {
		let bytes = provider_port_result
			.map_err(|_| "fake provider did not announce a port".to_owned())?
			.map_err(|error| format!("read fake provider port: {error}"))?;
		if bytes == 0 {
			return Err("fake provider closed stdout before announcing a port".to_owned());
		}
		let provider_port = provider_port_line
			.trim()
			.parse::<u16>()
			.map_err(|error| format!("invalid fake-provider port {provider_port_line:?}: {error}"))?;
		let (agent_dir, state_root) = prepare_workspace(&workspace, provider_port)?;
		let cli_args = vec![
			root
				.join("packages/coding-agent/src/cli.ts")
				.display()
				.to_string(),
			"--mode".to_owned(),
			"rpc-ui".to_owned(),
			"--provider".to_owned(),
			"git-daemon-fixture".to_owned(),
			"--model".to_owned(),
			"git-daemon-fixture-model".to_owned(),
			"--tools".to_owned(),
			"ask".to_owned(),
		];
		let first = spawn_bun("real rpc-ui server (approval)", &cli_args, &workspace, &workspace, &[
			("GJC_CODING_AGENT_DIR", agent_dir.clone()),
			("PI_CODING_AGENT_DIR", agent_dir.clone()),
			("GJC_HARNESS_STATE_ROOT", state_root.clone()),
		])
		.await?;
		processes.push(first.process);
		let mut client = RpcClient::new(tokio::io::join(first.stdout, first.stdin));
		await_ready(&mut client).await?;
		let mut events = Vec::new();
		let gate = drive_to_gate(&mut client, &mut events).await?;
		if gate.pointer("/options/1/label").and_then(Value::as_str) != Some("Deny") {
			return Err(format!("fixture gate did not advertise the deny path: {gate}"));
		}
		answer_gate(
			&mut client,
			&gate,
			json!({ "selected": ["Approve"] }),
			"approve-gate",
			&mut events,
			true,
		)
		.await?;
		assert_canonical_event_sequence(&events)?;
		let terminal = events
			.iter()
			.rev()
			.find(|frame| {
				frame.pointer("/payload/event_type").and_then(Value::as_str) == Some("agent_end")
			})
			.ok_or_else(|| "approved run has no agent_end frame".to_owned())?;
		let stop_reason = terminal
			.pointer("/payload/event/stopReason")
			.and_then(Value::as_str);
		if !matches!(stop_reason, None | Some("completed")) {
			return Err(format!("approved run ended with unexpected stop reason: {terminal}"));
		}
		let stream_events: Vec<StreamEvent> = events.iter().filter_map(parse_stream_event).collect();
		let reduction = reduce_run_events(&stream_events, REPLAY_WINDOW);
		let outcome = match reduction.outcome {
			Some(outcome) => outcome,
			None => return Err("approved run did not reduce to an outcome".to_owned()),
		};
		if !outcome.succeeded || outcome.usage.tokens == 0 {
			return Err(format!("approved run did not yield successful observed usage: {outcome:?}"));
		}
		drop(client);

		let denied_state_root = workspace.join("harness-state-denied");
		std::fs::create_dir_all(&denied_state_root)
			.map_err(|error| format!("create denied state root: {error}"))?;
		let denied = spawn_bun("real rpc-ui server (denial)", &cli_args, &workspace, &workspace, &[
			("GJC_CODING_AGENT_DIR", agent_dir.clone()),
			("PI_CODING_AGENT_DIR", agent_dir),
			("GJC_HARNESS_STATE_ROOT", denied_state_root),
		])
		.await?;
		processes.push(denied.process);
		let mut denied_client = RpcClient::new(tokio::io::join(denied.stdout, denied.stdin));
		await_ready(&mut denied_client).await?;
		let mut denied_events = Vec::new();
		let denied_gate = drive_to_gate(&mut denied_client, &mut denied_events).await?;
		answer_gate(
			&mut denied_client,
			&denied_gate,
			json!({ "selected": ["Deny"] }),
			"deny-gate",
			&mut denied_events,
			true,
		)
		.await?;

		assert_canonical_event_sequence(&denied_events)?;
		let denied_terminal = denied_events
			.iter()
			.rev()
			.find(|frame| {
				frame.pointer("/payload/event_type").and_then(Value::as_str) == Some("agent_end")
			})
			.ok_or_else(|| "denied run has no agent_end frame".to_owned())?;
		let denied_stop_reason = denied_terminal
			.pointer("/payload/event/stopReason")
			.and_then(Value::as_str);
		if !matches!(denied_stop_reason, None | Some("completed")) {
			return Err(format!("denied run ended with unexpected stop reason: {denied_terminal}"));
		}
		if !event_message_contains(&denied_events, "denied") {
			return Err(format!(
				"denied gate answer did not round-trip in final text: {denied_events:?}"
			));
		}
		if ask_tool_execution_count(&denied_events) != 1 {
			return Err(format!(
				"denied run produced an unexpected additional ask side effect: {denied_events:?}"
			));
		}
		let denied_stream_events: Vec<StreamEvent> = denied_events
			.iter()
			.filter_map(parse_stream_event)
			.collect();
		let denied_outcome = reduce_run_events(&denied_stream_events, REPLAY_WINDOW)
			.outcome
			.ok_or_else(|| "denied run did not reduce to an outcome".to_owned())?;
		if !denied_outcome.succeeded {
			return Err(format!(
				"denied gate answer must still complete the agent turn: {denied_outcome:?}"
			));
		}
		Ok(())
	}
	.await;
	drop(provider_stdout);
	let mut captures = Vec::new();
	for process in processes.into_iter().rev() {
		captures.push(process.shutdown().await);
	}
	let _ = std::fs::remove_dir_all(&workspace);
	if let Err(error) = result {
		panic!("real stdio RPC contract failed: {error}\n{}", captured_process_output(&captures));
	}
}

#[tokio::test]
async fn paused_fixture_reduces_to_non_success_with_canonical_usage() {
	let frames: Vec<Value> = include_str!("fixtures/paused-run.jsonl")
		.lines()
		.map(|line| serde_json::from_str(line).expect("TS-validated paused fixture JSON"))
		.collect();
	assert_eq!(
		frames
			.first()
			.and_then(|frame| frame.get("type"))
			.and_then(Value::as_str),
		Some("ready")
	);
	let events: Vec<StreamEvent> = frames.iter().filter_map(parse_stream_event).collect();
	assert!(matches!(
		events.last(),
		Some(StreamEvent::Lifecycle { event_type, stop_reason: Some(reason), .. })
			if event_type == "agent_end" && reason == "paused"
	));
	let reduction = reduce_run_events(&events, REPLAY_WINDOW);
	assert!(!reduction.stream_lost, "the shared fixture is contiguous");
	assert_eq!(reduction.usage.tokens, 17, "canonical message_end usage must be observed");
	assert_eq!(reduction.usage.cost_usd, 0.0003, "canonical message_end cost must be observed");
	let outcome = reduction.outcome.expect("paused agent_end is terminal");
	assert!(!outcome.succeeded, "a paused terminal must never create a merge-success signal");
	assert_eq!(outcome.usage.tokens, 17);
}

fn frame(value: Value) -> String {
	git_daemon::encode_frame(&value)
}

fn canonical_event(seq: u64, event_type: &str, event: Value) -> String {
	frame(json!({
		"protocol_version": AGENT_WIRE_PROTOCOL_VERSION,
		"session_id": "fault-fixture-session",
		"seq": seq,
		"frame_id": format!("fault-{seq}"),
		"type": "event",
		"payload": { "event_type": event_type, "event": event },
	}))
}

fn accepted_negotiation() -> String {
	frame(json!({ "type": "response", "command": "negotiate_unattended", "success": true }))
}

fn accepted_prompt() -> String {
	frame(
		json!({ "id": "git-daemon-prompt", "type": "response", "command": "prompt", "success": true }),
	)
}

async fn run_scripted_runner(script: String, replay_window: u64) -> git_daemon::RunOutcome {
	let (mut peer, client_side) = tokio::io::duplex(16 * 1024);
	let peer_task = tokio::spawn(async move {
		peer
			.write_all(script.as_bytes())
			.await
			.expect("write scripted peer frames");
		tokio::time::sleep(Duration::from_millis(100)).await;
	});
	let runner = SocketWorkRunner::new(
		RpcClient::new(client_side),
		"git-daemon",
		vec!["prompt".to_owned(), "control".to_owned()],
		Vec::new(),
		"resolve fixture",
		replay_window,
	)
	.with_idle_timeout(2);
	let outcome = timeout(OPERATION_TIMEOUT, runner.run("fixture-work-item"))
		.await
		.expect("scripted runner operation timeout");
	peer_task.await.expect("scripted peer task");
	outcome
}

#[tokio::test]
async fn transport_faults_and_prompt_rejections_fail_closed() {
	let malformed = format!("{}{}{{not-json\n", accepted_negotiation(), accepted_prompt());
	assert!(
		!run_scripted_runner(malformed, REPLAY_WINDOW)
			.await
			.succeeded,
		"malformed JSON must fail closed"
	);

	let non_envelope = format!(
		"{}{}{}",
		accepted_negotiation(),
		accepted_prompt(),
		frame(json!({ "type": "ready" }))
	);
	assert!(
		!run_scripted_runner(non_envelope, REPLAY_WINDOW)
			.await
			.succeeded,
		"a valid non-envelope frame followed by EOF must not become success"
	);

	let gap_beyond_replay = format!(
		"{}{}{}{}",
		accepted_negotiation(),
		accepted_prompt(),
		canonical_event(1, "agent_start", json!({ "type": "agent_start" })),
		canonical_event(100, "agent_end", json!({ "type": "agent_end", "messages": [] })),
	);
	assert!(
		!run_scripted_runner(gap_beyond_replay, 4).await.succeeded,
		"a sequence gap beyond the replay window must fail closed"
	);
	let gapped_events: Vec<StreamEvent> = [
		canonical_event(1, "agent_start", json!({ "type": "agent_start" })),
		canonical_event(100, "agent_end", json!({ "type": "agent_end", "messages": [] })),
	]
	.iter()
	.map(|line| serde_json::from_str::<Value>(line.trim()).expect("canonical gapped frame JSON"))
	.filter_map(|frame| parse_stream_event(&frame))
	.collect();
	let gapped_reduction = reduce_run_events(&gapped_events, 4);
	assert!(gapped_reduction.stream_lost, "a replay-window breach must report stream_lost");
	assert!(gapped_reduction.outcome.is_none(), "a lost stream cannot produce an outcome");

	let eof_before_terminal = format!(
		"{}{}{}",
		accepted_negotiation(),
		accepted_prompt(),
		canonical_event(1, "agent_start", json!({ "type": "agent_start" })),
	);
	assert!(
		!run_scripted_runner(eof_before_terminal, REPLAY_WINDOW)
			.await
			.succeeded,
		"EOF before agent_end must fail closed"
	);

	let server_error_then_end = format!(
		"{}{}{}{}{}",
		accepted_negotiation(),
		accepted_prompt(),
		canonical_event(1, "agent_start", json!({ "type": "agent_start" })),
		frame(json!({ "type": "error", "error": "recoverable server warning" })),
		canonical_event(2, "agent_end", json!({ "type": "agent_end", "messages": [] })),
	);
	assert!(
		run_scripted_runner(server_error_then_end, REPLAY_WINDOW)
			.await
			.succeeded,
		"a flat server error is non-terminal when a valid agent_end follows"
	);

	let rejected_prompt_then_end = format!(
		"{}{}{}{}",
		accepted_negotiation(),
		canonical_event(1, "agent_start", json!({ "type": "agent_start" })),
		frame(
			json!({ "id": "git-daemon-prompt", "type": "response", "command": "prompt", "success": false, "error": { "code": "rejected" } })
		),
		canonical_event(2, "agent_end", json!({ "type": "agent_end", "messages": [] })),
	);
	assert!(
		!run_scripted_runner(rejected_prompt_then_end, REPLAY_WINDOW)
			.await
			.succeeded,
		"a rejected correlated prompt must fail even when a later agent_end arrives"
	);
	let unsupported_protocol = format!(
		"{}{}{}{}",
		accepted_negotiation(),
		accepted_prompt(),
		canonical_event(1, "agent_start", json!({ "type": "agent_start" })),
		frame(json!({
			"protocol_version": 999,
			"session_id": "fault-fixture-session",
			"seq": 2,
			"frame_id": "fault-unsupported",
			"type": "event",
			"payload": { "event_type": "agent_end", "event": { "type": "agent_end", "messages": [] } },
		})),
	);
	assert!(
		!run_scripted_runner(unsupported_protocol, REPLAY_WINDOW)
			.await
			.succeeded,
		"unsupported protocol_version must not contribute a terminal success"
	);
}
