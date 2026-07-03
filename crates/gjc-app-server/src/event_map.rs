//! Item-lifecycle event mapping: gjc `AgentEvent` → codex `item/*` + `turn/*`
//! notifications (Phase 1 core; resolves the plan's mechanical protocol
//! mapping).
//!
//! A [`ThreadStream`] holds per-thread streaming state (active turn, current
//! item, sequence counter, terminal latch) and turns each raw backend event
//! into ordered JSON-RPC notifications. Every consumed gjc event is also
//! preserved losslessly as a `gjc/event` notification so no gjc detail is
//! dropped and unmapped/future event types still reach detail-consuming
//! clients.

use crate::{
	backend::BackendEvent,
	ids::{ItemId, ThreadId, TurnId},
	item_state::{SeqCounter, TerminalCause, TerminalLatch},
	jsonrpc::Notification,
};

/// Kind of item a gjc tool/message maps to on the codex wire.
fn classify_tool_item(tool_name: &str) -> &'static str {
	match tool_name {
		"bash" | "monitor" => "commandExecution",
		"edit" | "write" | "delete" | "move" => "fileChange",
		name if name.contains("mcp") || name.contains("__") => "mcpToolCall",
		_ => "toolCall",
	}
}

/// Per-thread streaming state machine.
pub struct ThreadStream {
	thread_id:    ThreadId,
	seq:          SeqCounter,
	active_turn:  Option<TurnId>,
	/// The current assistant-message item, if streaming.
	message_item: Option<ItemId>,
	latch:        TerminalLatch,
}

impl ThreadStream {
	#[must_use]
	pub fn new(thread_id: ThreadId) -> Self {
		Self {
			thread_id,
			seq: SeqCounter::default(),
			active_turn: None,
			message_item: None,
			latch: TerminalLatch::new(),
		}
	}

	fn note(&mut self, method: &str, mut params: serde_json::Value) -> Notification {
		if let Some(obj) = params.as_object_mut() {
			obj.insert("threadId".into(), serde_json::Value::String(self.thread_id.0.clone()));
			obj.insert("seq".into(), serde_json::Value::from(self.seq.next()));
		}
		Notification::new(method, params)
	}

	/// The always-emitted lossless passthrough for a raw gjc event.
	fn raw(&mut self, ev: &BackendEvent) -> Notification {
		self.note("gjc/event", serde_json::json!({ "eventType": ev.event_type, "event": ev.payload }))
	}

	/// Finish the active assistant-message item if one is open.
	fn complete_message_item(&mut self, out: &mut Vec<Notification>) {
		if let Some(item) = self.message_item.take() {
			out.push(self.note(
				"item/completed",
				serde_json::json!({ "itemId": item.0, "itemType": "agentMessage" }),
			));
		}
	}

	/// Emit exactly one `turn/completed` with the coalesced terminal cause.
	fn flush_terminal(&mut self, out: &mut Vec<Notification>) {
		if let Some(cause) = self.latch.flush() {
			self.complete_message_item(out);
			let status = match cause {
				TerminalCause::Completed => "completed",
				TerminalCause::Interrupted => "interrupted",
				TerminalCause::Failed => "failed",
			};
			let turn_id = self.active_turn.take().map(|t| t.0);
			out.push(
				self.note("turn/completed", serde_json::json!({ "turnId": turn_id, "status": status })),
			);
			// NOTE: the latch is reset at the next turn's start, not here, so a
			// second terminal signal for an already-ended turn is ignored.
		}
	}

	/// Seed the app-server-owned turn id before the turn's backend events
	/// arrive, so `turn/started` uses the same id returned by `turn/start`.
	/// Idempotent: a later `agent_start`/`turn_start` will not re-open the turn.
	pub fn begin_turn(&mut self, turn_id: TurnId) -> Vec<Notification> {
		let mut out = Vec::new();
		if self.active_turn.is_none() {
			self.active_turn = Some(turn_id.clone());
			self.latch = TerminalLatch::new();
			out.push(self.note("turn/started", serde_json::json!({ "turnId": turn_id.0 })));
		}
		out
	}

	/// Map one backend event to ordered notifications.
	pub fn on_event(&mut self, ev: &BackendEvent) -> Vec<Notification> {
		let mut out = Vec::new();
		match ev.event_type.as_str() {
			"agent_start" | "turn_start" if self.active_turn.is_none() => {
				let turn = TurnId::generate();
				self.active_turn = Some(turn.clone());
				self.latch = TerminalLatch::new();
				out.push(self.note("turn/started", serde_json::json!({ "turnId": turn.0 })));
			},
			"message_start" => {
				let item = ItemId::generate();
				self.message_item = Some(item.clone());
				out.push(self.note(
					"item/started",
					serde_json::json!({ "itemId": item.0, "itemType": "agentMessage" }),
				));
			},
			"message_update" | "text_delta" => {
				// gjc nests the delta under assistantMessageEvent.delta; accept
				// either the wrapped or flat shape.
				let delta = ev
					.payload
					.get("assistantMessageEvent")
					.and_then(|e| e.get("delta"))
					.or_else(|| ev.payload.get("delta"))
					.and_then(|d| d.as_str())
					.unwrap_or("");
				if let Some(item) = self.message_item.clone() {
					out.push(self.note(
						"item/agentMessage/delta",
						serde_json::json!({ "itemId": item.0, "delta": delta }),
					));
				}
			},
			"message_end" => self.complete_message_item(&mut out),
			"thinking_start" | "reasoning" => {
				let item = ev
					.payload
					.get("itemId")
					.and_then(|v| v.as_str())
					.map_or_else(|| ItemId::generate().0, String::from);
				let mut params = serde_json::json!({ "itemId": item, "itemType": "reasoning" });
				if !ev
					.payload
					.get("redacted")
					.and_then(|v| v.as_bool())
					.unwrap_or(false)
					&& let Some(content) = ev
						.payload
						.get("content")
						.or_else(|| ev.payload.get("reasoning"))
						.or_else(|| ev.payload.get("text"))
						.cloned()
				{
					params["content"] = content;
				}
				out.push(self.note("item/started", params));
			},
			"auto_compaction_start" => {
				let item = ev
					.payload
					.get("itemId")
					.and_then(|v| v.as_str())
					.map_or_else(|| ItemId::generate().0, String::from);
				out.push(self.note(
					"item/started",
					serde_json::json!({ "itemId": item, "itemType": "contextCompaction" }),
				));
			},
			"tool_execution_start" => {
				let tool = ev
					.payload
					.get("toolName")
					.and_then(|v| v.as_str())
					.unwrap_or("");
				let call_id = ev
					.payload
					.get("toolCallId")
					.and_then(|v| v.as_str())
					.map(String::from);
				let item = call_id.unwrap_or_else(|| ItemId::generate().0);
				out.push(self.note(
					"item/started",
					serde_json::json!({ "itemId": item, "itemType": classify_tool_item(tool), "toolName": tool }),
				));
			},
			"tool_execution_end" => {
				let call_id = ev
					.payload
					.get("toolCallId")
					.and_then(|v| v.as_str())
					.unwrap_or("");
				out.push(self.note(
					"item/completed",
					serde_json::json!({ "itemId": call_id, "itemType": "toolCall" }),
				));
			},
			"agent_end" | "turn_end" if self.active_turn.is_some() => {
				self.latch.record(TerminalCause::Completed);
				self.flush_terminal(&mut out);
			},
			"abort" | "turn_aborted" if self.active_turn.is_some() => {
				self.latch.record(TerminalCause::Interrupted);
				self.flush_terminal(&mut out);
			},
			"error" | "agent_error" if self.active_turn.is_some() => {
				self.latch.record(TerminalCause::Failed);
				self.flush_terminal(&mut out);
			},
			_ => { /* unmapped: only the raw passthrough below */ },
		}
		// Lossless raw detail always follows the mapped notifications.
		let raw = self.raw(ev);
		out.push(raw);
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::ids::BackendGeneration;

	fn ev(kind: &str, payload: serde_json::Value) -> BackendEvent {
		BackendEvent {
			thread_id: ThreadId("thr_1".into()),
			generation: BackendGeneration::FIRST,
			event_type: kind.into(),
			payload,
		}
	}

	fn methods(ns: &[Notification]) -> Vec<&str> {
		ns.iter().map(|n| n.method.as_str()).collect()
	}

	#[test]
	fn happy_path_text_turn() {
		let mut stream = ThreadStream::new(ThreadId("thr_1".into()));
		let started = stream.on_event(&ev("agent_start", serde_json::json!({"type": "agent_start"})));
		assert_eq!(methods(&started), ["turn/started", "gjc/event"]);

		let message_started =
			stream.on_event(&ev("message_start", serde_json::json!({"type": "message_start"})));
		assert_eq!(methods(&message_started), ["item/started", "gjc/event"]);

		let delta = stream.on_event(&ev(
			"message_update",
			serde_json::json!({"assistantMessageEvent": {"type": "text_delta", "delta": "hi"}}),
		));
		assert_eq!(methods(&delta), ["item/agentMessage/delta", "gjc/event"]);
		assert_eq!(delta[0].params.as_ref().unwrap()["delta"], "hi");

		let completed = stream.on_event(&ev("agent_end", serde_json::json!({"type": "agent_end"})));
		// item/completed (message) then exactly one turn/completed, then raw.
		assert_eq!(methods(&completed), ["item/completed", "turn/completed", "gjc/event"]);
		assert_eq!(completed[1].params.as_ref().unwrap()["status"], "completed");
	}

	#[test]
	fn terminal_coalesces_to_single_turn_completed() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		s.on_event(&ev("agent_start", serde_json::json!({})));
		let first = s.on_event(&ev("agent_end", serde_json::json!({})));
		assert!(methods(&first).contains(&"turn/completed"));
		// A second terminal signal must NOT emit another turn/completed.
		let second = s.on_event(&ev("turn_end", serde_json::json!({})));
		assert!(!methods(&second).contains(&"turn/completed"));
	}

	#[test]
	fn abort_maps_to_interrupted() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		s.on_event(&ev("agent_start", serde_json::json!({})));
		let out = s.on_event(&ev("abort", serde_json::json!({})));
		let tc = out.iter().find(|n| n.method == "turn/completed").unwrap();
		assert_eq!(tc.params.as_ref().unwrap()["status"], "interrupted");
	}

	#[test]
	fn tool_events_map_to_items() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		s.on_event(&ev("agent_start", serde_json::json!({})));
		let start = s.on_event(&ev(
			"tool_execution_start",
			serde_json::json!({"toolCallId": "t1", "toolName": "bash"}),
		));
		assert_eq!(start[0].method, "item/started");
		assert_eq!(start[0].params.as_ref().unwrap()["itemType"], "commandExecution");
		let end = s.on_event(&ev("tool_execution_end", serde_json::json!({"toolCallId": "t1"})));
		assert_eq!(end[0].method, "item/completed");
	}

	#[test]
	fn reasoning_item_emitted_with_content() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		let out = s.on_event(&ev("reasoning", serde_json::json!({"content": "thinking"})));
		assert_eq!(out[0].method, "item/started");
		assert_eq!(out[0].params.as_ref().unwrap()["itemType"], "reasoning");
		assert_eq!(out[0].params.as_ref().unwrap()["content"], "thinking");
	}

	#[test]
	fn redacted_reasoning_omits_content() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		let out = s.on_event(&ev(
			"thinking_start",
			serde_json::json!({"content": "secret", "redacted": true}),
		));
		let params = out[0].params.as_ref().unwrap();
		assert_eq!(params["itemType"], "reasoning");
		assert!(params.get("content").is_none());
	}

	#[test]
	fn file_change_and_mcp_tool_classification() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		let edit = s.on_event(&ev(
			"tool_execution_start",
			serde_json::json!({"toolCallId": "edit1", "toolName": "write"}),
		));
		assert_eq!(edit[0].params.as_ref().unwrap()["itemType"], "fileChange");

		let mcp = s.on_event(&ev(
			"tool_execution_start",
			serde_json::json!({"toolCallId": "mcp1", "toolName": "server__tool"}),
		));
		assert_eq!(mcp[0].params.as_ref().unwrap()["itemType"], "mcpToolCall");
	}

	#[test]
	fn auto_compaction_start_emits_context_compaction_without_turn_completed() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		s.on_event(&ev("agent_start", serde_json::json!({})));
		let out = s.on_event(&ev("auto_compaction_start", serde_json::json!({})));
		assert_eq!(out[0].method, "item/started");
		assert_eq!(out[0].params.as_ref().unwrap()["itemType"], "contextCompaction");
		assert!(!methods(&out).contains(&"turn/completed"));
	}

	#[test]
	fn unmapped_event_still_yields_raw_passthrough() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		let out = s.on_event(&ev("todo_reminder", serde_json::json!({"todos": []})));
		assert_eq!(methods(&out), ["gjc/event"]);
		assert_eq!(out[0].params.as_ref().unwrap()["eventType"], "todo_reminder");
	}

	#[test]
	fn every_notification_carries_thread_id_and_monotonic_seq() {
		let mut s = ThreadStream::new(ThreadId("thr_1".into()));
		let mut all = Vec::new();
		all.extend(s.on_event(&ev("agent_start", serde_json::json!({}))));
		all.extend(s.on_event(&ev("agent_end", serde_json::json!({}))));
		let mut last = 0u64;
		for n in &all {
			let p = n.params.as_ref().unwrap();
			assert_eq!(p["threadId"], "thr_1");
			let seq = p["seq"].as_u64().unwrap();
			assert!(seq > last, "seq must be monotonic");
			last = seq;
		}
	}
}
