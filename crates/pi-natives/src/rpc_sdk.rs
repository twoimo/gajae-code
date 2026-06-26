//! N-API surface for the unified RPC SDK (`gjc-rpc-sdk`).
//!
//! This is the native binding layer through which the native TUI process reaches
//! the in-process Rust SDK core with no serialization (see
//! `docs/rpc-sdk/topology.md`, `runtime-port.md`). It exposes read-only
//! introspection of the generated command classification (single source of truth)
//! plus an in-process `RuntimePort` handle (`RpcSdkPipeline`) that the TS side drives
//! with submit/dispatch; emit/replay over N-API land in a subsequent Phase 2 step.

use gjc_rpc_sdk::authz::{GrantRecord, Principal, RedactionPolicy};
use gjc_rpc_sdk::authz_eval::CapabilityAuthorizer;
use gjc_rpc_sdk::classifier::ManifestCommandClassifier;
use gjc_rpc_sdk::frame::GjcFrame;
use gjc_rpc_sdk::in_process::{InProcessPipeline, PipelineError};
use gjc_rpc_sdk::replay_store::ReplayOutcome;
use gjc_rpc_sdk::scheduler::{CommandClassifier, Lane};
use gjc_rpc_sdk::session_scheduler::Dispatch;
use gjc_rpc_sdk::{PROTOCOL_VERSION, Seq, SessionId};
use napi_derive::napi;

/// The stable unified-boundary protocol version exposed by the native core.
#[napi]
pub fn rpc_sdk_protocol_version() -> u32 {
	PROTOCOL_VERSION
}

/// Number of commands in the embedded generated classification manifest.
#[napi]
pub fn rpc_sdk_command_count() -> u32 {
	u32::try_from(ManifestCommandClassifier::from_embedded().len()).unwrap_or(u32::MAX)
}

/// Classify a command into its scheduling lane, or `null` if the command is not in
/// the generated manifest (the TS side must treat `null` as fail-closed/unknown).
#[napi]
pub fn rpc_sdk_classify_command(command: String) -> Option<String> {
	ManifestCommandClassifier::from_embedded()
		.lane_for(&command)
		.ok()
		.map(|lane| match lane {
			Lane::FastLaneCancellation => "fast_lane_cancellation".to_string(),
			Lane::FastLaneSafeRead => "fast_lane_safe_read".to_string(),
			Lane::Ordered => "ordered".to_string(),
		})
}

/// In-process `RuntimePort` handle exposed to the native TUI process.
///
/// Wraps a single-session `InProcessPipeline`. The TS side constructs one per
/// session and submits runtime-input commands; authorization runs before
/// scheduling and the two-lane causality contract is enforced in Rust. Grants and
/// the calling principal cross the boundary as JSON (small control metadata, not
/// runtime payloads); the runtime command/event payloads themselves stay typed.
#[napi]
pub struct RpcSdkPipeline {
	inner: InProcessPipeline,
}

#[napi]
impl RpcSdkPipeline {
	/// Build a session pipeline. `grants_json` is a JSON array of `GrantRecord`;
	/// `redaction_policy` is one of `full` | `redacted` | `metadata_only`.
	#[napi(constructor)]
	pub fn new(
		session_id: String,
		grants_json: String,
		now: String,
		replay_capacity: u32,
		redaction_policy: String,
	) -> napi::Result<Self> {
		let grants: Vec<GrantRecord> = serde_json::from_str(&grants_json)
			.map_err(|e| napi::Error::from_reason(format!("invalid grants_json: {e}")))?;
		let policy = match redaction_policy.as_str() {
			"full" => RedactionPolicy::Full,
			"metadata_only" => RedactionPolicy::MetadataOnly,
			_ => RedactionPolicy::Redacted,
		};
		let authorizer = CapabilityAuthorizer::new(grants, now);
		let inner = InProcessPipeline::new(
			SessionId(session_id),
			authorizer,
			replay_capacity as usize,
			policy,
		);
		Ok(Self { inner })
	}

	/// Submit a runtime-input command for `principal_json` (a JSON Principal).
	/// Returns `immediate` or `queued:<n>`; an authorization denial or unknown
	/// command is surfaced as a JS error (fail closed).
	#[napi]
	pub fn submit(&mut self, principal_json: String, command: String) -> napi::Result<String> {
		let principal: Principal = serde_json::from_str(&principal_json)
			.map_err(|e| napi::Error::from_reason(format!("invalid principal_json: {e}")))?;
		match self.inner.submit(&principal, &command) {
			Ok(Dispatch::Immediate) => Ok("immediate".to_string()),
			Ok(Dispatch::Queued(n)) => Ok(format!("queued:{n}")),
			Err(PipelineError::Denied(reason)) => {
				Err(napi::Error::from_reason(format!("denied: {reason}")))
			},
			Err(PipelineError::UnknownCommand(cmd)) => {
				Err(napi::Error::from_reason(format!("unknown command: {cmd}")))
			},
		}
	}

	/// Mark the current ordered command complete and return the next promoted command, if any.
	#[napi]
	pub fn complete_ordered(&mut self) -> Option<String> {
		self.inner.complete_ordered()
	}

	/// Emit a runtime-output frame (JSON `GjcFrame`): persists it for replay and
	/// returns the redaction-applied frame JSON for live fanout. Note: emit/replay
	/// over N-API serialize the frame as JSON at the boundary (the TS-driven path);
	/// the zero-serialization native path is the in-process Rust pipeline.
	#[napi]
	pub fn emit(&mut self, frame_json: String) -> napi::Result<String> {
		let frame: GjcFrame = serde_json::from_str(&frame_json)
			.map_err(|e| napi::Error::from_reason(format!("invalid frame_json: {e}")))?;
		let fanned = self.inner.emit(frame);
		serde_json::to_string(&fanned)
			.map_err(|e| napi::Error::from_reason(format!("serialize: {e}")))
	}

	/// Replay frames after `cursor`. Returns JSON `{"kind":"frames","frames":[...]}`
	/// (redaction applied, `replay:true`) or `{"kind":"reset","floor":n}` when the
	/// cursor predates the retained floor.
	#[napi]
	pub fn replay_from(&self, cursor: u32) -> napi::Result<String> {
		let outcome = self.inner.replay_from(Seq(u64::from(cursor)));
		let value = match outcome {
			ReplayOutcome::ResetRequired { floor } => {
				serde_json::json!({ "kind": "reset", "floor": floor.0 })
			},
			ReplayOutcome::Frames(frames) => serde_json::json!({ "kind": "frames", "frames": frames }),
		};
		serde_json::to_string(&value).map_err(|e| napi::Error::from_reason(format!("serialize: {e}")))
	}

	/// Whether the underlying pipeline serializes runtime payloads (false: the
	/// in-process core is zero-serialization; the JSON emit/replay above are the
	/// N-API edge convenience, not the native in-process path).
	#[napi]
	pub const fn is_zero_serialization(&self) -> bool {
		self.inner.is_zero_serialization()
	}
}
