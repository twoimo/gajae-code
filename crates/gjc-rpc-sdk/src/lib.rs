//! # gjc-rpc-sdk
//!
//! The unified GJC runtime I/O boundary (the "RPC SDK"). Phase 1 scaffold:
//! interfaces and data types only — transport, scheduler, authz, broker, replay,
//! and redaction *implementations* land in Phases 2-4. See `docs/rpc-sdk/`:
//! `protocol.md`, `topology.md`, `runtime-port.md`, `authz.md`, and the generated
//! `runtime-io-inventory.json` / `command-classification-manifest.json`.
//!
//! Boundaries (see `topology.md`):
//!   A external client transport (UDS, serialized)
//!   B Rust SDK/daemon core (this crate)
//!   C internal Rust<->TS `RuntimePort` (typed in-memory for native TUI; IPC for headless)

use serde::{Deserialize, Serialize};

/// Stable wire protocol major version for the unified boundary (see `protocol.md`).
pub const PROTOCOL_VERSION: u32 = 1;

/// Concrete manifest-backed command classifier (Phase 2).
pub mod classifier;

/// Concrete two-lane per-session scheduler (Phase 2).
pub mod session_scheduler;

/// Concrete fail-closed capability authorizer (Phase 2).
pub mod authz_eval;

/// Concrete bounded per-session replay store (Phase 2).
pub mod replay_store;

/// Concrete authoritative broker correlation tracker (Phase 2).
pub mod broker_correlation;

/// Concrete daemon-side redactor (Phase 2).
pub mod redactor;

/// Concrete per-session outbound backpressure queue (Phase 4).
pub mod backpressure;

/// Concrete broker and notification action lifecycles (Phase 4).
pub mod brokers;

/// Structured observability helpers (Phase 4).
pub mod observability_ext;

/// In-process pipeline composing the Boundary-B core (Phase 2).
pub mod in_process;

/// Cross-transport logical-frame equality (in_process vs uds) for the surrogate/conformance.
pub mod logical_equality;

/// UDS peer-credential principal derivation (Phase 3 / G004).
pub mod peer_cred;

/// Length-delimited JSON frame codec for the UDS transport (Phase 3 / G004).
pub mod uds_codec;

/// Tokio UDS transport (listener, frame read/write, peer principal) (Phase 3 / G004). Unix-only.
#[cfg(unix)]
pub mod uds_transport;

/// Daemon session registry + correlation->session ownership (Phase 3 / G004).
pub mod registry;

/// Daemon decision/routing core: hello negotiation, authz, per-subscriber redaction (Phase 3 / G004).
pub mod daemon;

/// Supervised persistent TS-worker subprocess over two-lane IPC (Phase 3 / G004). Unix/headless only.
#[cfg(unix)]
pub mod worker_supervisor;

/// Cross-transport equality gate test vector (Phase 3 / G004). Unix-only.
#[cfg(unix)]
pub mod cross_transport;

/// End-to-end UDS accept handler: peer-cred + hello + authz (Phase 3 / G004,G010). Unix-only.
#[cfg(unix)]
pub mod daemon_server;

// ---------------------------------------------------------------------------
// Core identifiers
// ---------------------------------------------------------------------------

/// A runtime session id (target/source of frames).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

/// Per-session monotonic sequence number — ordering and replay cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Seq(pub u64);

/// Unique per-frame id (ULID/snowflake).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FrameId(pub String);

/// Correlates a response/broker-result with its originating request.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CorrelationId(pub String);

/// Frame travel direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
	ServerToClient,
	ClientToServer,
}

// ---------------------------------------------------------------------------
// frame: the GjcFrame envelope (protocol.md)
// ---------------------------------------------------------------------------
pub mod frame {
	use super::{CorrelationId, Direction, FrameId, Seq, SessionId};
	use serde::{Deserialize, Serialize};
	use serde_json::Value;

	/// Top-level frame category. Mirrors `AgentWireFrameType` plus the control and
	/// notification surfaces folded into the unified boundary.
	#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
	#[serde(rename_all = "snake_case")]
	pub enum FrameKind {
		Ready,
		Hello,
		Command,
		Response,
		Event,
		UiRequest,
		PermissionRequest,
		HostToolCall,
		HostUriRequest,
		WorkflowGate,
		Notification,
		Reset,
		Error,
	}

	/// The universal envelope carried over every transport. `payload` is a
	/// generated v1 payload schema for `(kind, type)`; Phase 2+ replaces the
	/// `Value` with generated typed payloads.
	#[allow(
		clippy::derive_partial_eq_without_eq,
		reason = "payload Value is a temporary v1 carrier replaced by generated typed payloads in Phase 2; the public envelope must not advertise a stronger Eq contract yet"
	)]
	#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
	#[serde(rename_all = "camelCase")]
	pub struct GjcFrame {
		pub protocol_version: u32,
		pub frame_id: FrameId,
		pub session_id: SessionId,
		pub seq: Seq,
		pub direction: Direction,
		pub kind: FrameKind,
		/// v1 payload discriminator within `kind` (see runtime-io-inventory.json).
		pub r#type: String,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub correlation_id: Option<CorrelationId>,
		pub replay: bool,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub capability_scope: Option<super::authz::Scope>,
		pub payload: Value,
	}
}

// ---------------------------------------------------------------------------
// scheduler: two-lane causal ordering (runtime-port.md)
// ---------------------------------------------------------------------------
pub mod scheduler {
	use serde::{Deserialize, Serialize};

	/// Scheduling lane derived from the generated command-classification manifest.
	/// Preserves `rpc-mode.ts:83-169` semantics exactly.
	#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
	#[serde(rename_all = "snake_case")]
	pub enum Lane {
		/// Cancellation commands: bypass the ordered chain (`abort/abort_bash/abort_retry`).
		FastLaneCancellation,
		/// Pure synchronous snapshot reads: bypass the ordered chain.
		FastLaneSafeRead,
		/// Mutating/async commands: per-session serial chain.
		Ordered,
	}

	/// Classifies a command into its lane from the single generated manifest.
	///
	/// Implementations MUST load `docs/rpc-sdk/command-classification-manifest.json`;
	/// an unknown command is a hard error (fail closed), never a default lane.
	pub trait CommandClassifier {
		type Error;
		fn lane_for(&self, command: &str) -> Result<Lane, Self::Error>;
	}

	/// Per-session scheduler: ordered commands run serially; fast-lane messages MUST
	/// be serviced while an ordered command awaits (no single FIFO mailbox).
	pub trait Scheduler {
		type Error;
		fn submit(&self, command: &str, lane: Lane) -> Result<(), Self::Error>;
	}
}

// ---------------------------------------------------------------------------
// authz: capability-scoped authorization (authz.md)
// ---------------------------------------------------------------------------
pub mod authz {
	use super::SessionId;
	use serde::{Deserialize, Serialize};

	/// Capability scopes. See the scope matrix in `authz.md`.
	#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
	#[serde(rename_all = "snake_case")]
	pub enum Scope {
		Subscribe,
		Read,
		Control,
		GateAnswer,
		HostToolResult,
		HostUriResult,
		HostToolRegister,
		HostUriRegister,
		Enumerate,
		Admin,
	}

	/// Daemon-side redaction policy applied before replay and live fanout.
	#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
	#[serde(rename_all = "snake_case")]
	pub enum RedactionPolicy {
		Full,
		Redacted,
		MetadataOnly,
	}

	/// The authenticated caller. Derived from UDS peer credentials, native-TUI self,
	/// or an opt-in bearer fallback (see `authz.md`).
	#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
	#[serde(tag = "kind", rename_all = "snake_case")]
	pub enum Principal {
		Unix { uid: u32, gid: u32, pid: Option<u32> },
		NativeTuiSelf,
		Bearer { bearer_hash: String },
	}

	/// Optional resource limits on a grant (see `authz.md`).
	#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
	#[serde(rename_all = "camelCase")]
	pub struct GrantLimits {
		#[serde(skip_serializing_if = "Option::is_none")]
		pub max_sessions: Option<u32>,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub max_queue: Option<u32>,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub max_replay: Option<u32>,
	}

	/// Grant usage audit counters (see `authz.md`).
	#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
	#[serde(rename_all = "camelCase")]
	pub struct GrantAudit {
		#[serde(skip_serializing_if = "Option::is_none")]
		pub last_used_at: Option<String>,
		#[serde(default)]
		pub denial_count: u32,
		#[serde(default)]
		pub renewal_count: u32,
	}

	/// A persisted capability grant (`.gjc/state/rpc-sdk/grants/<grantId>.json`).
	/// Field shape mirrors the `GrantRecord` in `docs/rpc-sdk/authz.md` exactly.
	#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
	#[serde(rename_all = "camelCase")]
	pub struct GrantRecord {
		pub version: u32,
		pub grant_id: String,
		pub principal_binding: Principal,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub bearer_hash: Option<String>,
		pub issued_at: String,
		pub expires_at: String,
		pub renewable_until: String,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub revoked_at: Option<String>,
		pub issuer: String,
		pub purpose: String,
		/// Explicit session ids, or the single reserved value `"all"` (admin issuer only).
		pub sessions: Vec<String>,
		pub scopes: Vec<Scope>,
		pub redaction_policy: RedactionPolicy,
		#[serde(default)]
		pub limits: GrantLimits,
		#[serde(default)]
		pub audit: GrantAudit,
	}

	/// The decision point. All checks fail closed and run before any side effect,
	/// in the order documented in `authz.md` (schedule, broker reply, replay, fanout).
	pub trait Authorizer {
		type Error;
		fn authorize(
			&self,
			principal: &Principal,
			session: &SessionId,
			scope: Scope,
		) -> Result<(), Self::Error>;
	}
}

// ---------------------------------------------------------------------------
// transport: pluggable binding (in-process + UDS), same logical contract
// ---------------------------------------------------------------------------
pub mod transport {
	use super::frame::GjcFrame;

	/// A bound transport. The native TUI binds an in-process transport (zero
	/// serialization); external/headless clients bind a UDS transport. Both carry
	/// the identical `GjcFrame` contract.
	pub trait Transport {
		type Error;
		fn send(&self, frame: GjcFrame) -> Result<(), Self::Error>;
	}
}

// ---------------------------------------------------------------------------
// runtime_port: the narrow Rust<->TS seam (Boundary C)
// ---------------------------------------------------------------------------
pub mod runtime_port {
	use super::frame::GjcFrame;
	use super::scheduler::Lane;

	/// Drives and observes the TS agent runtime.
	///
	/// Two bindings share this contract: a typed in-memory binding (native TUI, no
	/// serialization) and a two-lane IPC binding (headless worker). The fast lane
	/// MUST be serviced while an ordered command awaits.
	pub trait RuntimePort {
		type Error;
		/// Forward a runtime-input frame on its scheduling lane.
		fn dispatch(&self, frame: GjcFrame, lane: Lane) -> Result<(), Self::Error>;
		/// Whether this binding serializes (UDS/IPC) or is zero-serialization (native).
		fn is_zero_serialization(&self) -> bool;
	}
}

// ---------------------------------------------------------------------------
// broker / replay / redaction / observability interfaces
// ---------------------------------------------------------------------------
pub mod broker {
	use super::CorrelationId;
	use super::frame::GjcFrame;

	/// Correlates request/result/cancel for extension-UI, workflow-gate, host-tool,
	/// and host-URI flows. Correlation ownership is authz-checked before reply.
	pub trait Broker {
		type Error;
		fn open(&self, frame: &GjcFrame) -> Result<CorrelationId, Self::Error>;
		fn resolve(&self, correlation: &CorrelationId, result: GjcFrame) -> Result<(), Self::Error>;
	}
}

pub mod replay {
	use super::frame::GjcFrame;
	use super::{Seq, SessionId};

	/// Bounded per-session replay ring. Semantic frames are never dropped; resume is
	/// from a `seq` cursor; redaction is applied before replayed frames are enqueued.
	pub trait ReplayStore {
		type Error;
		fn append(&self, frame: &GjcFrame) -> Result<(), Self::Error>;
		fn replay_from(&self, session: &SessionId, cursor: Seq)
		-> Result<Vec<GjcFrame>, Self::Error>;
	}
}

pub mod redaction {
	use super::authz::RedactionPolicy;
	use super::frame::GjcFrame;

	/// Applies the daemon-side redaction policy immediately before replay and live
	/// fanout. Asks remain answerable (their prompt/options are never redacted).
	pub trait Redactor {
		fn redact(&self, frame: GjcFrame, policy: RedactionPolicy) -> GjcFrame;
	}
}

pub mod observability {
	use super::authz::Scope;
	use super::{CorrelationId, FrameId, SessionId};
	use serde::{Deserialize, Serialize};

	/// Structured fields emitted on every authz/scheduling/fanout decision. Never
	/// includes bearer tokens or redacted content.
	#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
	#[serde(rename_all = "camelCase")]
	pub struct ObservabilityFields {
		pub connection_id: String,
		pub principal: String,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub grant_id: Option<String>,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub scope: Option<Scope>,
		pub frame_id: FrameId,
		pub session_id: SessionId,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub correlation_id: Option<CorrelationId>,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub deny_reason: Option<String>,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub redaction_decision: Option<String>,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub replay_cursor: Option<u64>,
		#[serde(skip_serializing_if = "Option::is_none")]
		pub queue_lag: Option<usize>,
	}
}

// ---------------------------------------------------------------------------
// inventory: load + validate the generated runtime_io_inventory
// ---------------------------------------------------------------------------
pub mod inventory {
	use serde::{Deserialize, Serialize};

	/// One inventory section (commands, `agent_events`, `frame_types`, notification_*).
	#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
	pub struct InventorySection {
		pub name: String,
		pub source: String,
		#[serde(rename = "derivedAtRuntime")]
		pub derived_at_runtime: bool,
		pub count: usize,
		pub items: Vec<String>,
	}

	/// The generated `docs/rpc-sdk/runtime-io-inventory.json`. Phase 5 conformance
	/// asserts fixture coverage equals this inventory exactly over both transports.
	#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
	#[serde(rename_all = "camelCase")]
	pub struct RuntimeIoInventory {
		pub schema_version: u32,
		pub kind: String,
		pub protocol_version: u32,
		pub sections: Vec<InventorySection>,
		pub total_items: usize,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn protocol_version_is_v1() {
		assert_eq!(PROTOCOL_VERSION, 1);
	}

	#[test]
	fn frame_roundtrips_json() {
		let f = frame::GjcFrame {
			protocol_version: PROTOCOL_VERSION,
			frame_id: FrameId("f_1".into()),
			session_id: SessionId("s_1".into()),
			seq: Seq(1),
			direction: Direction::ServerToClient,
			kind: frame::FrameKind::Event,
			r#type: "message_update".into(),
			correlation_id: None,
			replay: false,
			capability_scope: Some(authz::Scope::Subscribe),
			payload: serde_json::json!({"ok": true}),
		};
		let s = serde_json::to_string(&f).expect("serialize");
		let back: frame::GjcFrame = serde_json::from_str(&s).expect("deserialize");
		assert_eq!(f, back);
	}

	#[test]
	fn grant_record_roundtrips_json() {
		let g = authz::GrantRecord {
			version: 1,
			grant_id: "g_1".into(),
			principal_binding: authz::Principal::Unix { uid: 501, gid: 20, pid: Some(1) },
			bearer_hash: None,
			issued_at: "2026-01-01T00:00:00Z".into(),
			expires_at: "2026-01-02T00:00:00Z".into(),
			renewable_until: "2026-01-03T00:00:00Z".into(),
			revoked_at: None,
			issuer: "cli".into(),
			purpose: "test".into(),
			sessions: vec!["s_1".into()],
			scopes: vec![authz::Scope::Subscribe, authz::Scope::Read],
			redaction_policy: authz::RedactionPolicy::Redacted,
			limits: authz::GrantLimits::default(),
			audit: authz::GrantAudit::default(),
		};
		let s = serde_json::to_string(&g).expect("serialize");
		let back: authz::GrantRecord = serde_json::from_str(&s).expect("deserialize");
		assert_eq!(g, back);
		// The persisted shape must use the documented camelCase field name.
		assert!(s.contains("\"principalBinding\""));
	}
}
