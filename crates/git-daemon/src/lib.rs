//! Autonomous per-repo git daemon — deterministic domain core.
//!
//! This crate is built in slices. The first, safety-critical layer is pure and
//! dependency-light so it can be unit-tested without a `SQLite` build, a network,
//! or a live forge:
//!
//! - [`keys`] constructs the idempotency / work-intent / single-flight lock keys
//!   that guarantee "one work item and at most one daemon PR per actionable
//!   item" across webhook + poll ingestion (the concurrency guard once budgets
//!   and self-revision caps are disabled, per D3/D4).
//! - [`state_machine`] defines the work-item lifecycle and the legal transitions
//!   the ingestion dispatcher and work orchestrator are allowed to make.
//!
//! Later slices add the forge abstraction, the hardened `rusqlite` operational
//! store, the gjc-rpc/bridge runner, and the `SHA`-bound merge gate.

pub mod config;
pub mod dispatcher;
pub mod escalation;
pub mod forge;
pub mod forge_adapter;
pub mod github_auth;
pub mod github_forge;
pub mod hindsight_client;
pub mod keys;
pub mod lifecycle;
pub mod merge_gate;
pub mod memory;
pub mod observability;
pub mod poll;
pub mod orchestrator;
pub mod runner;
pub mod secrets;
pub mod scheduler;
pub mod serve;
pub mod spend_ledger;
pub mod state_machine;
pub mod store;
pub mod rpc_runner;
pub mod rpc_framing;
pub mod rpc_socket;
pub mod webhook_handler;
pub mod socket_runner;
pub mod reqwest_transport;
pub mod webhook;

pub use config::{ConfigError, GitDaemonConfig, MemoryMode, MergePolicy, PollConfig, WebhookTopology};
pub use forge::{ForgeEvent, normalize_github};
pub use forge_adapter::{FakeForge, ForgeAdapter, ForgeError, ForgePr, MergeRequest};
pub use github_auth::{app_jwt_claims, app_jwt_signing_input, base64url_nopad};
pub use github_forge::{GithubForge, HttpRequest, HttpResponse, HttpTransport};
pub use hindsight_client::{HindsightRpcClient, RecalledMemory, parse_recall, recall_command, reflect_command, retain_command};
pub use rpc_runner::{RunReduction, StreamEvent, reduce_run_events};
pub use reqwest_transport::ReqwestTransport;
pub use rpc_framing::{decode_frames, decode_line, encode_frame};
pub use rpc_socket::RpcClient;
pub use webhook_handler::{WebhookHandleError, handle_github_webhook};
pub use socket_runner::{SocketWorkRunner, parse_stream_event, start_run_command};
pub use scheduler::{available_slots, can_start, pick_next};
pub use serve::{run_tick, serve_forever, serve_pass};
pub use dispatcher::{IngestOutcome, ingest};
pub use escalation::{ACK_REACTION, EscalationReason, escalation_comment};
pub use keys::{DedupKey, ItemKind, ItemRef, LockKey, WorkIntentKey};
pub use lifecycle::{DaemonStatus, OwnershipRecord, TakeoverDecision, decide_takeover};
pub use merge_gate::{DenyReason, GateDecision, GateInputs, evaluate as evaluate_merge_gate};
pub use memory::{DirectiveSource, TrustBand, authoritative_directive, effective_trust};
pub use observability::{KpiSnapshot, StatusReport};
pub use poll::{advance_watermark, needs_processing, poll_state_token};
pub use orchestrator::{DriveOutcome, RunResult, WorkRunner, drive_to_merge};
pub use runner::{StreamProgress, StreamTracker, unbounded_negotiation};
pub use secrets::{ResolvedSecret, SecretCandidate, SecretError, SecretKind, SecretRequest, SecretSource, resolve_secret};
pub use state_machine::{TransitionError, WorkItemState};
pub use spend_ledger::{DayRollup, SpendLedger, UsageObservation};
pub use store::{GitDaemonStateStore, LockGuard, StoreError};
pub use webhook::{WebhookError, sign_github, verify_github_signature};
