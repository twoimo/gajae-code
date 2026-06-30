//! gjc-rpc [`WorkRunner`] over an async byte stream.
//!
//! This is the glue that turns the verified pieces — the [`RpcClient`] transport
//! ([`crate::rpc_socket`]), the negotiation builder ([`crate::runner`]), and the
//! event-stream reducer ([`crate::rpc_runner`]) — into a concrete
//! [`WorkRunner`] the orchestrator can drive. It is generic over any
//! `AsyncRead + AsyncWrite` stream, so the whole send-negotiation /
//! read-frames / reduce-to-result flow is testable against an in-memory
//! `tokio::io::duplex` pipe that scripts engine frames per the wire contract.
//! The only live-only seam is [`RpcClient::connect_unix`].

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;

use crate::orchestrator::{RunResult, WorkRunner};
use crate::rpc_runner::{StreamEvent, reduce_run_events};
use crate::rpc_socket::RpcClient;
use crate::runner::unbounded_negotiation;

/// Build the command that starts an unbounded run for one work item.
///
/// The engine resolves `work_key` to the issue/PR it tracks and streams back
/// ordered events terminated by a `terminal` frame.
#[must_use]
pub fn start_run_command(work_key: &str) -> Value {
	json!({
		"type": "start_unattended_run",
		"work_key": work_key,
	})
}

/// Parse one engine frame into a [`StreamEvent`].
///
/// Returns `None` for frames that are not part of the run event stream (e.g.
/// the negotiation acknowledgement or unrelated control frames), so the caller
/// can skip them without losing the sequence cursor.
#[must_use]
pub fn parse_stream_event(frame: &Value) -> Option<StreamEvent> {
	let seq = frame.get("seq")?.as_u64()?;
	match frame.get("type")?.as_str()? {
		"pr_opened" => Some(StreamEvent::PrOpened {
			seq,
			pr_id: frame.get("pr_id")?.as_str()?.to_owned(),
			head_sha: frame.get("head_sha")?.as_str()?.to_owned(),
			base_branch: frame.get("base_branch").and_then(Value::as_str).unwrap_or_default().to_owned(),
		}),
		"gate_signals" => Some(StreamEvent::GateSignals {
			seq,
			ci_green: frame.get("ci_green").and_then(Value::as_bool).unwrap_or(false),
			ultragoal_pass: frame.get("ultragoal_pass").and_then(Value::as_bool).unwrap_or(false),
			reviews_resolved: frame.get("reviews_resolved").and_then(Value::as_bool).unwrap_or(false),
			diff_within_budget: frame.get("diff_within_budget").and_then(Value::as_bool).unwrap_or(false),
			diff_in_scope: frame.get("diff_in_scope").and_then(Value::as_bool).unwrap_or(false),
		}),
		"usage_observed" => {
			let usage = serde_json::from_value(frame.get("usage")?.clone()).ok()?;
			Some(StreamEvent::UsageObserved { seq, usage })
		}
		"terminal" => Some(StreamEvent::Terminal {
			seq,
			succeeded: frame.get("succeeded").and_then(Value::as_bool).unwrap_or(false),
		}),
		_ => None,
	}
}

/// A [`WorkRunner`] that drives an unbounded run over a gjc-rpc stream.
pub struct SocketWorkRunner<S> {
	client: Mutex<RpcClient<S>>,
	actor: String,
	scopes: Vec<String>,
	action_allowlist: Vec<String>,
	replay_window: u64,
}

impl<S: AsyncRead + AsyncWrite + Unpin> SocketWorkRunner<S> {
	/// Wrap a connected [`RpcClient`].
	///
	/// `replay_window` bounds how large a sequence gap the bridge can replay
	/// before the stream is declared lost (no false terminal success).
	#[must_use]
	pub fn new(
		client: RpcClient<S>,
		actor: impl Into<String>,
		scopes: Vec<String>,
		action_allowlist: Vec<String>,
		replay_window: u64,
	) -> Self {
		Self {
			client: Mutex::new(client),
			actor: actor.into(),
			scopes,
			action_allowlist,
			replay_window,
		}
	}

	/// Negotiate, start the run, and collect its event stream into a result.
	///
	/// A lost stream or a stream that ends (EOF) before a terminal event yields
	/// a failed [`RunResult`] — never a clean success — so the SHA-bound merge
	/// gate downstream fails closed.
	async fn drive(&self, work_key: &str) -> RunResult {
		let mut client = self.client.lock().await;
		let scopes: Vec<&str> = self.scopes.iter().map(String::as_str).collect();
		let allow: Vec<&str> = self.action_allowlist.iter().map(String::as_str).collect();

		if client.send(&unbounded_negotiation(&self.actor, &scopes, &allow)).await.is_err() {
			return failed_result();
		}
		if client.send(&start_run_command(work_key)).await.is_err() {
			return failed_result();
		}

		let mut events: Vec<StreamEvent> = Vec::new();
		loop {
			match client.next_frame().await {
				Ok(Some(frame)) => {
					if let Some(event) = parse_stream_event(&frame) {
						let terminal = matches!(event, StreamEvent::Terminal { .. });
						events.push(event);
						if terminal {
							break;
						}
					}
				}
				Ok(None) => break, // EOF before terminal -> treated as failure below
				Err(_) => return failed_result(),
			}
		}

		reduce_run_events(&events, self.replay_window).result.unwrap_or_else(failed_result)
	}
}

impl<S: AsyncRead + AsyncWrite + Unpin> WorkRunner for SocketWorkRunner<S> {
	async fn run(&self, work_key: &str) -> RunResult {
		self.drive(work_key).await
	}
}

/// A failed run result with no PR and every gate signal false.
const fn failed_result() -> RunResult {
	RunResult {
		succeeded: false,
		pr_id: String::new(),
		head_sha: String::new(),
		base_branch: String::new(),
		ci_green: false,
		ultragoal_pass: false,
		reviews_resolved: false,
		diff_within_budget: false,
		diff_in_scope: false,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use tokio::io::AsyncWriteExt;

	fn frame(v: &Value) -> String {
		crate::rpc_framing::encode_frame(v)
	}

	#[test]
	fn parses_each_event_kind() {
		assert!(matches!(
			parse_stream_event(&json!({"type":"pr_opened","seq":1,"pr_id":"PR_1","head_sha":"sha1"})),
			Some(StreamEvent::PrOpened { .. })
		));
		assert!(matches!(
			parse_stream_event(&json!({"type":"terminal","seq":9,"succeeded":true})),
			Some(StreamEvent::Terminal { seq: 9, succeeded: true })
		));
		assert!(parse_stream_event(&json!({"type":"handshake_ack"})).is_none());
		assert!(parse_stream_event(&json!({"type":"pr_opened"})).is_none()); // missing seq
	}

	#[tokio::test]
	async fn drives_a_successful_run_from_scripted_frames() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		// Script the engine's event stream, then close the write half (EOF).
		let script = [
			frame(&json!({"type":"pr_opened","seq":1,"pr_id":"PR_7","head_sha":"sha1"})),
			frame(&json!({
				"type":"gate_signals","seq":2,
				"ci_green":true,"ultragoal_pass":true,"reviews_resolved":true,
				"diff_within_budget":true,"diff_in_scope":true
			})),
			frame(&json!({"type":"terminal","seq":3,"succeeded":true})),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();

		let runner = SocketWorkRunner::new(
			RpcClient::new(client_side),
			"git-daemon",
			vec!["prompt".to_owned()],
			vec!["bash.mutating".to_owned()],
			128,
		);
		let result = runner.run("github:R_1:issue:I_1:resolve").await;
		assert!(result.succeeded);
		assert_eq!(result.pr_id, "PR_7");
		assert_eq!(result.head_sha, "sha1");
		assert!(result.ci_green && result.ultragoal_pass && result.reviews_resolved);
	}

	#[tokio::test]
	async fn eof_before_terminal_is_a_failed_result() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		let script = frame(&json!({"type":"pr_opened","seq":1,"pr_id":"PR_7","head_sha":"sha1"}));
		engine.write_all(script.as_bytes()).await.unwrap();
		drop(engine); // EOF with no terminal frame
		let runner = SocketWorkRunner::new(
			RpcClient::new(client_side),
			"git-daemon",
			vec!["prompt".to_owned()],
			Vec::new(),
			128,
		);
		let result = runner.run("wk").await;
		assert!(!result.succeeded, "no terminal event must not yield success");
	}

	#[tokio::test]
	async fn lost_stream_is_not_a_success() {
		let (mut engine, client_side) = tokio::io::duplex(8192);
		// Gap beyond the replay window between seq 1 and seq 50 -> stream lost.
		let script = [
			frame(&json!({"type":"pr_opened","seq":1,"pr_id":"PR_7","head_sha":"sha1"})),
			frame(&json!({"type":"terminal","seq":50,"succeeded":true})),
		]
		.concat();
		engine.write_all(script.as_bytes()).await.unwrap();
		engine.flush().await.unwrap();
		let runner = SocketWorkRunner::new(
			RpcClient::new(client_side),
			"git-daemon",
			vec!["prompt".to_owned()],
			Vec::new(),
			4,
		);
		let result = runner.run("wk").await;
		assert!(!result.succeeded, "a lost stream must never reduce to success");
	}
}
