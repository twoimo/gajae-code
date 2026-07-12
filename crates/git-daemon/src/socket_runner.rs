//! gjc-rpc [`WorkRunner`] over an async byte stream.
//!
//! Turns the verified pieces — the [`RpcClient`] transport
//! ([`crate::rpc_socket`]), the negotiation builder ([`crate::runner`]), and
//! the engine-event reducer ([`crate::rpc_runner`]) — into a concrete
//! [`WorkRunner`]. It negotiates unbounded mode, sends a `prompt` that
//! instructs the coding agent to resolve the work item and open a PR on the
//! daemon's head-branch convention, then consumes the engine's `{type:"event",
//! seq, payload:{event_type, event}}` stream to a [`RunOutcome`]. PR discovery
//! and merge-gate signals are the orchestrator's forge observations, not engine
//! events. Generic over the stream so the flow is duplex-testable; the only
//! live seam is [`RpcClient::connect_unix`].

use serde_json::{Value, json};
use tokio::{
	io::{AsyncRead, AsyncWrite},
	sync::Mutex,
};

use crate::{
	orchestrator::{RunOutcome, WorkRunner},
	rpc_runner::{StreamEvent, reduce_run_events},
	rpc_socket::RpcClient,
	runner::unbounded_negotiation,
	spend_ledger::UsageObservation,
};

/// End-of-loop lifecycle event types (mirrors the reducer's terminal set): only
/// these end frame consumption. A mid-run `error` is not terminal.
const TERMINAL: [&str; 2] = ["completed", "agent_end"];

/// The agent-wire protocol version this consumer understands
/// (`AGENT_WIRE_PROTOCOL_VERSION` in the canonical TypeScript contract). Event
/// frames stamped with any other version are rejected — fail closed.
const SUPPORTED_PROTOCOL_VERSION: u64 = 2;

/// Correlates the prompt request with its acceptance response.
const PROMPT_REQUEST_ID: &str = "git-daemon-prompt";

/// Build the correlated `prompt` command that drives the unattended run.
#[must_use]
pub fn prompt_command(message: &str) -> Value {
	json!({ "id": PROMPT_REQUEST_ID, "type": "prompt", "message": message })
}

/// Parse one engine frame into a [`StreamEvent`].
///
/// Recognizes `{type:"event", seq, payload:{event_type, event}}` frames. A
/// frame that declares an unsupported `protocol_version` (anything other than
/// `2`) is rejected outright — fail closed, never reduce foreign-protocol
/// frames toward a success verdict. A canonical `message_end` usage payload at
/// `event.message.usage` maps its
/// `totalTokens` and `cost.total` fields into [`UsageObservation`]; legacy
/// `event.usage` observations remain supported. Tool execution end events
/// become a one-call [`UsageObservation`]; everything else becomes a
/// [`StreamEvent::Lifecycle`]. Non-event frames (`ready`, `response`, …)
/// return `None` and are skipped without losing the cursor.
#[must_use]
pub fn parse_stream_event(frame: &Value) -> Option<StreamEvent> {
	if frame.get("type")?.as_str()? != "event" {
		return None;
	}
	// Fail closed on the protocol envelope: the canonical producer stamps every
	// event frame with the supported agent-wire version. A missing or foreign
	// version must never influence the run verdict (an unknown protocol could
	// re-define terminal semantics).
	if frame.get("protocol_version").and_then(Value::as_u64) != Some(SUPPORTED_PROTOCOL_VERSION) {
		return None;
	}
	let seq = frame.get("seq")?.as_u64()?;
	let payload = frame.get("payload")?;
	let event_type = payload.get("event_type")?.as_str()?.to_owned();
	let stop_reason = if event_type == "agent_end" {
		payload
			.pointer("/event/stopReason")
			.and_then(Value::as_str)
			.map(str::to_owned)
	} else {
		None
	};
	let usage = if TERMINAL.contains(&event_type.as_str()) {
		None
	} else {
		if event_type == "message_end" {
			canonical_usage(payload)
		} else {
			None
		}
		.or_else(|| {
			payload
				.pointer("/event/usage")
				.and_then(|u| serde_json::from_value::<UsageObservation>(u.clone()).ok())
		})
	};
	if event_type == "tool_execution_end" {
		let mut usage = usage.unwrap_or_default();
		usage.tool_calls = usage.tool_calls.saturating_add(1);
		return Some(StreamEvent::Usage { seq, usage });
	}
	if let Some(usage) = usage {
		return Some(StreamEvent::Usage { seq, usage });
	}
	Some(StreamEvent::Lifecycle { seq, event_type, stop_reason })
}

fn canonical_usage(payload: &Value) -> Option<UsageObservation> {
	let usage = payload.pointer("/event/message/usage")?;
	Some(UsageObservation {
		tokens:       usage.get("totalTokens")?.as_u64()?,
		tool_calls:   0,
		cost_usd:     usage.pointer("/cost/total")?.as_f64()?,
		wall_time_ms: 0,
	})
}

/// A [`WorkRunner`] that drives an unbounded run over a gjc-rpc stream.
pub struct SocketWorkRunner<S> {
	client:            Mutex<RpcClient<S>>,
	actor:             String,
	scopes:            Vec<String>,
	action_allowlist:  Vec<String>,
	prompt:            String,
	replay_window:     u64,
	idle_timeout_secs: u64,
}

impl<S: AsyncRead + AsyncWrite + Unpin> SocketWorkRunner<S> {
	/// Wrap a connected [`RpcClient`]. `prompt` is the instruction sent to the
	/// engine (the work-item key is appended); `replay_window` bounds the
	/// tolerable event-sequence gap before the stream is declared lost.
	#[must_use]
	pub fn new(
		client: RpcClient<S>,
		actor: impl Into<String>,
		scopes: Vec<String>,
		action_allowlist: Vec<String>,
		prompt: impl Into<String>,
		replay_window: u64,
	) -> Self {
		Self {
			client: Mutex::new(client),
			actor: actor.into(),
			scopes,
			action_allowlist,
			prompt: prompt.into(),
			replay_window,
			idle_timeout_secs: 300,
		}
	}

	/// Override the idle timeout (seconds) for the run event stream.
	#[must_use]
	pub const fn with_idle_timeout(mut self, secs: u64) -> Self {
		self.idle_timeout_secs = secs;
		self
	}

	/// Negotiate, prompt, and consume the engine event stream into a
	/// [`RunOutcome`]. A lost stream, an EOF before a terminal event, or a
	/// transport error yields a failed outcome (never a false success), so the
	/// SHA-bound merge gate downstream fails closed.
	async fn drive(&self, work_key: &str) -> RunOutcome {
		let mut client = self.client.lock().await;
		let scopes: Vec<&str> = self.scopes.iter().map(String::as_str).collect();
		let allow: Vec<&str> = self.action_allowlist.iter().map(String::as_str).collect();

		if client
			.send(&unbounded_negotiation(&self.actor, &scopes, &allow))
			.await
			.is_err()
		{
			return failed_outcome();
		}
		// Fail closed unless the engine ACCEPTS the unbounded negotiation: an
		// unaccepted run would not have its mutating actions auto-authorized, so
		// proceeding would silently produce a run that cannot complete the work.
		if !self.await_negotiation_accepted(&mut client).await {
			return failed_outcome();
		}
		// Bind the run to its work item: the agent MUST push exactly this branch,
		// so daemon-side PR/branch discovery attributes the PR to this run.
		let branch = crate::keys::work_branch_ref(work_key);
		let message = format!(
			"{}\n\nWork item key: {work_key}\nUse EXACTLY this git branch name for your work and PR \
			 head: {branch}",
			self.prompt
		);
		let mut events: Vec<StreamEvent> = Vec::new();
		if client.send(&prompt_command(&message)).await.is_err() {
			return failed_outcome();
		}
		// Fail closed unless the engine accepts this exact prompt request. Event
		// frames can race the response, so retain them for normal reduction below.
		if !self.await_prompt_accepted(&mut client, &mut events).await {
			return failed_outcome();
		}

		// A terminal event may have raced (and been buffered before) the prompt
		// acknowledgement; reduce it immediately instead of idling on a stream
		// that will never emit another terminal.
		let already_terminal = events.iter().any(|event| {
			matches!(event, StreamEvent::Lifecycle { event_type, .. } if TERMINAL.contains(&event_type.as_str()))
		});

		let idle = std::time::Duration::from_secs(self.idle_timeout_secs);
		if !already_terminal {
			loop {
				// Fail closed if the engine stalls (no frame within the idle
				// window): an unattended daemon must not hang forever on a
				// dead/stuck engine.
				let Ok(next) = tokio::time::timeout(idle, client.next_frame()).await else {
					return failed_outcome();
				};
				match next {
					Ok(Some(frame)) => {
						if let Some(event) = parse_stream_event(&frame) {
							let terminal = matches!(&event, StreamEvent::Lifecycle { event_type, .. } if TERMINAL.contains(&event_type.as_str()));
							events.push(event);
							if terminal {
								break;
							}
						}
					},
					Ok(None) => break, // EOF before terminal -> failure below
					Err(_) => return failed_outcome(),
				}
			}
		}

		reduce_run_events(&events, self.replay_window)
			.outcome
			.unwrap_or_else(failed_outcome)
	}

	/// Read frames until the `negotiate_unattended` response, returning whether
	/// it was accepted. EOF/decode error => not accepted (fail closed).
	async fn await_negotiation_accepted(&self, client: &mut RpcClient<S>) -> bool {
		loop {
			match client.next_frame().await {
				Ok(Some(frame)) => {
					if frame.get("type").and_then(Value::as_str) == Some("response")
						&& frame.get("command").and_then(Value::as_str) == Some("negotiate_unattended")
					{
						return frame
							.get("success")
							.and_then(Value::as_bool)
							.unwrap_or(false);
					}
				},
				Ok(None) | Err(_) => return false,
			}
		}
	}

	/// Read frames until the correlated `prompt` response, retaining any event
	/// frames that arrive first. EOF/decode error or rejection => fail closed.
	async fn await_prompt_accepted(
		&self,
		client: &mut RpcClient<S>,
		events: &mut Vec<StreamEvent>,
	) -> bool {
		loop {
			match client.next_frame().await {
				Ok(Some(frame)) => {
					if let Some(event) = parse_stream_event(&frame) {
						events.push(event);
					}
					if frame.get("type").and_then(Value::as_str) == Some("response")
						&& frame.get("command").and_then(Value::as_str) == Some("prompt")
						&& frame.get("id").and_then(Value::as_str) == Some(PROMPT_REQUEST_ID)
					{
						return frame
							.get("success")
							.and_then(Value::as_bool)
							.unwrap_or(false);
					}
				},
				Ok(None) | Err(_) => return false,
			}
		}
	}
}

impl<S: AsyncRead + AsyncWrite + Unpin> WorkRunner for SocketWorkRunner<S> {
	async fn run(&self, work_key: &str) -> RunOutcome {
		self.drive(work_key).await
	}
}

/// A failed run outcome with no observed usage.
fn failed_outcome() -> RunOutcome {
	RunOutcome { succeeded: false, usage: UsageObservation::default() }
}

#[cfg(test)]
mod tests {
	use tokio::io::AsyncWriteExt;

	use super::*;

	fn frame(v: &Value) -> String {
		crate::rpc_framing::encode_frame(v)
	}

	fn event(seq: u64, event_type: &str, inner: Value) -> Value {
		json!({
			"type": "event",
			"protocol_version": SUPPORTED_PROTOCOL_VERSION,
			"seq": seq,
			"payload": { "event_type": event_type, "event": inner },
		})
	}

	/// The engine's `negotiate_unattended` acceptance response frame.
	fn accept() -> String {
		frame(&json!({ "type": "response", "command": "negotiate_unattended", "success": true }))
	}

	fn prompt_response(success: bool) -> String {
		frame(&json!({
			"id": PROMPT_REQUEST_ID,
			"type": "response",
			"command": "prompt",
			"success": success,
		}))
	}

	#[test]
	fn prompt_command_includes_a_correlation_id() {
		assert_eq!(prompt_command("resolve")["id"], PROMPT_REQUEST_ID);
	}

	#[test]
	fn parses_lifecycle_and_skips_non_events() {
		assert!(matches!(
			parse_stream_event(&event(1, "agent_start", json!({}))),
			Some(StreamEvent::Lifecycle { seq: 1, stop_reason: None, .. })
		));
		assert!(parse_stream_event(&json!({ "type": "ready" })).is_none());
		assert!(parse_stream_event(&json!({ "type": "response", "command": "x" })).is_none());
	}

	#[test]
	fn rejects_missing_or_foreign_protocol_versions() {
		// Version 2 is accepted (the `event` helper stamps it).
		assert!(parse_stream_event(&event(1, "agent_end", json!({ "messages": [] }))).is_some());
		// A missing protocol_version fails closed.
		let unversioned = json!({
			"type": "event",
			"seq": 1,
			"payload": { "event_type": "agent_end", "event": { "messages": [] } },
		});
		assert!(parse_stream_event(&unversioned).is_none());
		// Foreign and non-numeric versions fail closed.
		let mut foreign = event(1, "agent_end", json!({ "messages": [] }));
		foreign["protocol_version"] = json!(999);
		assert!(parse_stream_event(&foreign).is_none());
		foreign["protocol_version"] = json!("2");
		assert!(parse_stream_event(&foreign).is_none());
	}

	#[test]
	fn parses_canonical_message_end_usage() {
		let parsed = parse_stream_event(&event(
			2,
			"message_end",
			json!({
				"message": {
					"usage": {
						"input": 50,
						"output": 60,
						"cacheRead": 5,
						"cacheWrite": 5,
						"totalTokens": 120,
						"cost": { "input": 0.001, "output": 0.002, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.003 }
					}
				}
			}),
		));
		assert_eq!(
			parsed,
			Some(StreamEvent::Usage {
				seq:   2,
				usage: UsageObservation {
					tokens:       120,
					tool_calls:   0,
					cost_usd:     0.003,
					wall_time_ms: 0,
				},
			})
		);
	}

	#[test]
	fn parses_legacy_event_usage() {
		let parsed = parse_stream_event(&event(
			2,
			"message",
			json!({ "usage": { "tokens": 5, "tool_calls": 1, "cost_usd": 0.0, "wall_time_ms": 0 } }),
		));
		assert_eq!(
			parsed,
			Some(StreamEvent::Usage {
				seq:   2,
				usage: UsageObservation {
					tokens:       5,
					tool_calls:   1,
					cost_usd:     0.0,
					wall_time_ms: 0,
				},
			})
		);
	}

	#[test]
	fn parses_tool_execution_end_as_a_tool_call_observation() {
		let parsed = parse_stream_event(&event(2, "tool_execution_end", json!({})));
		assert_eq!(
			parsed,
			Some(StreamEvent::Usage {
				seq:   2,
				usage: UsageObservation {
					tokens:       0,
					tool_calls:   1,
					cost_usd:     0.0,
					wall_time_ms: 0,
				},
			})
		);
	}

	#[test]
	fn parses_paused_agent_end_stop_reason() {
		let parsed = parse_stream_event(&event(
			2,
			"agent_end",
			json!({ "messages": [], "stopReason": "paused" }),
		));
		assert_eq!(
			parsed,
			Some(StreamEvent::Lifecycle {
				seq:         2,
				event_type:  "agent_end".to_owned(),
				stop_reason: Some("paused".to_owned()),
			})
		);
	}

	fn runner(
		client_side: tokio::io::DuplexStream,
		replay_window: u64,
	) -> SocketWorkRunner<tokio::io::DuplexStream> {
		SocketWorkRunner::new(
			RpcClient::new(client_side),
			"git-daemon",
			vec!["prompt".to_owned()],
			Vec::new(),
			"resolve",
			replay_window,
		)
	}

	#[tokio::test]
	async fn drives_a_successful_run_from_scripted_events() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let script = [
			accept(),
			frame(&event(1, "agent_start", json!({}))),
			frame(&event(
				2,
				"message_end",
				json!({
					"message": {
						"usage": {
							"input": 50,
							"output": 60,
							"cacheRead": 5,
							"cacheWrite": 5,
							"totalTokens": 120,
							"cost": { "input": 0.001, "output": 0.002, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.003 }
						}
					}
				}),
			)),
			prompt_response(true),
			frame(&event(3, "agent_end", json!({ "messages": [] }))),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let out = runner(client_side, 128)
			.run("github:R_1:issue:I_1:resolve")
			.await;
		assert!(out.succeeded);
		assert_eq!(out.usage.tokens, 120);
	}

	#[tokio::test]
	async fn paused_agent_end_is_a_failed_outcome() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let script = [
			accept(),
			prompt_response(true),
			frame(&event(1, "agent_start", json!({}))),
			frame(&event(2, "agent_end", json!({ "messages": [], "stopReason": "paused" }))),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let out = runner(client_side, 128).run("wk").await;
		assert!(!out.succeeded, "a paused agent_end must fail closed");
	}

	#[tokio::test]
	async fn error_without_terminal_is_a_failed_outcome() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		// A mid-run error that never reaches a terminal, then EOF -> failed.
		let script = [
			accept(),
			prompt_response(true),
			frame(&event(1, "agent_start", json!({}))),
			frame(&event(2, "error", json!({}))),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		drop(engine); // EOF: no end-of-loop terminal
		let out = runner(client_side, 128).run("wk").await;
		assert!(!out.succeeded);
	}

	#[tokio::test]
	async fn eof_before_terminal_is_a_failed_outcome() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let script =
			[accept(), prompt_response(true), frame(&event(1, "agent_start", json!({})))].concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		drop(engine); // EOF with no terminal event
		let out = runner(client_side, 128).run("wk").await;
		assert!(!out.succeeded, "no terminal event must not yield success");
	}

	#[tokio::test]
	async fn lost_stream_is_not_a_success() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		// Gap beyond the replay window (seq 1 -> 50) before terminal.
		let script = [
			accept(),
			prompt_response(true),
			frame(&event(1, "agent_start", json!({}))),
			frame(&event(50, "completed", json!({}))),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let out = runner(client_side, 4).run("wk").await;
		assert!(!out.succeeded, "a lost stream must never reduce to success");
	}

	#[tokio::test]
	async fn rejected_correlated_prompt_fails_closed_even_if_agent_ends() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let script = [
			accept(),
			frame(&event(1, "agent_start", json!({}))),
			prompt_response(false),
			frame(&event(2, "agent_end", json!({ "messages": [] }))),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let out = runner(client_side, 128).run("wk").await;
		assert!(!out.succeeded, "a rejected prompt must never yield a successful run");
	}

	#[tokio::test]
	async fn terminal_buffered_before_prompt_ack_reduces_without_idling() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		// The full run (including the terminal agent_end) races AHEAD of the
		// prompt acknowledgement, and the peer then stays OPEN: the runner must
		// reduce the buffered terminal immediately instead of idling out.
		let script = [
			accept(),
			frame(&event(1, "agent_start", json!({}))),
			frame(&event(2, "agent_end", json!({ "messages": [] }))),
			prompt_response(true),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let out = tokio::time::timeout(
			std::time::Duration::from_secs(5),
			runner(client_side, 128).run("wk"),
		)
		.await
		.expect("must reduce the buffered terminal without waiting for the idle timeout");
		assert!(out.succeeded, "a terminal buffered before prompt ack must reduce normally");
		drop(engine); // keep the peer open until after the run resolves
	}

	#[tokio::test]
	async fn ignores_an_unrelated_prompt_response_until_the_correlated_response_arrives() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let script = [
			accept(),
			frame(
				&json!({ "id": "other-prompt", "type": "response", "command": "prompt", "success": false }),
			),
			prompt_response(true),
			frame(&event(1, "agent_start", json!({}))),
			frame(&event(2, "agent_end", json!({ "messages": [] }))),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		assert!(runner(client_side, 128).run("wk").await.succeeded);
	}

	#[tokio::test]
	async fn rejected_negotiation_fails_closed() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		// Engine REJECTS the negotiation; the runner must fail closed and never
		// consume a run (even if events were to follow).
		let reject = frame(
			&json!({ "type": "response", "command": "negotiate_unattended", "success": false, "error": { "code": "invalid_unattended_declaration" } }),
		);
		engine.write_all(reject.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let out = runner(client_side, 128).run("wk").await;
		assert!(!out.succeeded, "a rejected negotiation must never yield a successful run");
	}
}
