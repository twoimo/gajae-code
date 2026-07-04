//! # gjc-app-server
//!
//! Protocol/runtime core for gjc's codex-compatible JSON-RPC 2.0 app-server.
//!
//! This crate is the pure, independently-testable core. The N-API wrapper and
//! transport wiring live in `crates/pi-natives` (`app_server.rs`), embedded
//! in-process in the Bun runtime, mirroring the `gjc-notifications` rlib +
//! pi-natives split. The core drives the current TypeScript `AgentSession`
//! through an `AgentBackend` trait (see the plan's seam), swappable for a
//! native Rust `AgentSession` after the 1:1 coding-agent port.
//!
//! ## Design invariants (Phase 0A gates)
//! - **Concurrency:** full concurrent running turns across threads is a hard
//!   requirement. There is no single-active-turn fallback; unsafe process
//!   globals are resolved by scoping or non-blocking-safe serialization, or
//!   escalated as blockers (see `docs/phase0-isolation-audit.md`).
//! - **Identity:** Rust owns an immutable [`ids::ThreadId`]; TS session
//!   metadata is mutable; every backend attachment bumps
//!   [`ids::BackendGeneration`] and every event is checked via
//!   [`identity::ThreadIdentity::accepts_event`].
//! - **Field policy:** codex-core methods are lenient (ignore unknown fields);
//!   `gjc/*` extension methods are strict (reject unknown fields).
//! - **Framing:** JSON-RPC 2.0 with the `"jsonrpc"` header omitted on the wire.

pub mod backend;
pub mod discovery;
pub mod error;
pub mod event_map;
pub mod field_policy;
pub mod host_tools;
pub mod identity;
pub mod ids;
pub mod item_state;
pub mod jsonrpc;
pub mod notifications;
pub mod protocol;
pub mod scheduler;
pub mod schema;
pub mod server;
pub mod transport_ws;

pub use backend::{
	AgentBackend, BackendCallContext, BackendEvent, BackendFactory, BackendHandleInfo,
};
pub use discovery::{DiscoveryRecord, discovery_path};
pub use error::{AppServerError, Result};
pub use field_policy::{FieldPolicy, enforce, policy_for};
pub use identity::{SessionMetadata, ThreadIdentity, ThreadStatus};
pub use ids::{BackendGeneration, ConnectionId, ItemId, ThreadId, TurnId};
pub use item_state::{ItemState, SeqCounter, TerminalCause, TerminalLatch, TurnState};
pub use jsonrpc::{ClientNotification, Inbound, Notification, Request, RequestId, Response};
pub use notifications::{
	CALL_KIND_PREFIX, EVENT_METHOD as NOTIFICATIONS_EVENT_METHOD,
	METHOD_PREFIX as NOTIFICATIONS_METHOD_PREFIX,
};
pub use scheduler::{Admission, Lane, classify};
pub use server::{AppServer, AppServerConfig};
