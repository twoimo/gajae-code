//! Method-specific app-server wire DTOs for GUI consumers.
//!
//! These types mirror the shapes that `server.rs` consumes/produces and that
//! `event_map.rs` emits today. Backend-owned payloads intentionally remain
//! `serde_json::Value` where the app-server passes them through unchanged.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
	identity::ThreadStatus,
	ids::{BackendGeneration, ItemId, ThreadId, TurnId},
};

/// Empty object result used by `gjc/todos/set`, `gjc/hostTools/*`,
/// `thread/delete`, and `thread/archive`; see `server.rs` handlers returning
/// `json!({})`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
pub struct EmptyResult {}

/// Request id accepted by JSON-RPC requests; see `jsonrpc.rs::RequestId`.
pub type RequestId = crate::jsonrpc::RequestId;

/// Error object returned in JSON-RPC error responses; see
/// `error.rs::AppServerError`.
pub type Error = crate::error::AppServerError;

/// `initialize` params are currently ignored/lenient; see
/// `server.rs::handle_initialize`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InitializeParams {}

/// `initialize` result emitted by `server.rs::handle_initialize`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
	pub user_agent:      String,
	pub platform_os:     String,
	pub platform_family: String,
}

/// Client `initialized` notification params; `server.rs::dispatch` only checks
/// the method.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InitializedParams {}

/// `thread/start` params are forwarded unchanged to
/// `BackendFactory::create_thread`; see `server.rs::handle_thread_start`.
pub type ThreadStartParams = Value;

/// `thread/resume` params require `threadId` and otherwise pass through to the
/// backend; see `server.rs::handle_thread_resume`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeParams {
	pub thread_id: ThreadId,
	#[serde(flatten)]
	pub extra:     serde_json::Map<String, Value>,
}

/// `thread/fork` params are forwarded unchanged to
/// `BackendFactory::fork_thread`; see `server.rs::handle_thread_fork`.
pub type ThreadForkParams = Value;

/// `thread/read`, `thread/delete`, and `thread/archive` params; see
/// `server.rs::extract_thread_id` call sites.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdParams {
	pub thread_id: ThreadId,
}

/// Thread object returned by start/resume/fork/read; see `server.rs::register`,
/// `thread_response`, and `handle_thread_read`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
	pub id:             String,
	pub status:         ThreadStatus,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub generation:     Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub turns:          Option<Vec<Value>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub forked_from_id: Option<String>,
}

/// `thread/start` and `thread/fork` result; see
/// `server.rs::handle_thread_start`/`handle_thread_fork`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ThreadResult {
	pub thread: ThreadSummary,
}

/// `thread/resume` result; see `server.rs::handle_thread_resume`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ThreadResumeResult {
	pub thread:  ThreadSummary,
	pub resumed: bool,
}

/// `thread/read` result; see `server.rs::handle_thread_read`.
pub type ThreadReadParams = ThreadIdParams;
/// `thread/read` result; see `server.rs::handle_thread_read`.
pub type ThreadReadResult = ThreadResult;

/// `thread/loaded/list` params are unused; see `server.rs::dispatch_method`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ThreadLoadedListParams {}

/// `thread/loaded/list` result; see `server.rs::dispatch_method`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ThreadLoadedListResult {
	pub data: Vec<String>,
}

/// `turn/start` params require `threadId`, optionally `expectedTurnId`, and are
/// then forwarded to `AgentBackend::prompt`; see
/// `server.rs::handle_turn_start`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
	pub thread_id:        ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expected_turn_id: Option<TurnId>,
	#[serde(flatten)]
	pub extra:            serde_json::Map<String, Value>,
}

/// `turn/start` result; see `server.rs::handle_turn_start`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TurnStartResult {
	pub turn: TurnSummary,
}

/// Turn object returned by `turn/start`; see `server.rs::handle_turn_start`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TurnSummary {
	pub id:     String,
	pub status: String,
}

/// `turn/steer` params require `threadId`, optionally `expectedTurnId`, and are
/// forwarded to `AgentBackend::steer`; see `server.rs::handle_turn_steer`.
pub type TurnSteerParams = TurnStartParams;

/// `turn/steer` result; see `server.rs::handle_turn_steer`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResult {
	pub turn_id: TurnId,
}

/// `gjc/retry` params; strict fields enforced in `server.rs::handle_gjc_retry`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcRetryParams {
	pub thread_id: ThreadId,
}

/// `gjc/retry` result; `turnId` mirrors the turn/start family.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcRetryResult {
	pub turn_id: TurnId,
}
/// `turn/interrupt` params; see `server.rs::handle_turn_interrupt`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
	pub thread_id: ThreadId,
	pub turn_id:   TurnId,
}

/// `turn/interrupt` result; see `server.rs::handle_turn_interrupt`.
pub type TurnInterruptResult = EmptyResult;

/// `gjc/state/read` params; strict fields enforced in
/// `server.rs::handle_gjc_state_read`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcStateReadParams {
	pub thread_id: ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include:   Option<Value>,
}

/// `gjc/state/read` result is backend-owned state JSON; see
/// `server.rs::handle_gjc_state_read`.
pub type GjcStateReadResult = Value;

/// `gjc/context/read` params; strict fields enforced in
/// `server.rs::handle_gjc_context_read`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcContextReadParams {
	pub thread_id: ThreadId,
}

/// Token-safe usage counters returned by `gjc/context/read`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcContextTokens {
	pub input:       u64,
	pub output:      u64,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_read:  Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_write: Option<u64>,
	pub total:       u64,
}

/// `gjc/context/read` result; token-safe numeric context usage only.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcContextReadResult {
	pub tokens:         GjcContextTokens,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub context_window: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub percent_used:   Option<f64>,
	pub source:         String,
	pub freshness:      GjcContextFreshness,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum GjcContextFreshness {
	Live,
	PostTurn,
}

/// `gjc/goal/read` params; strict fields enforced in
/// `server.rs::handle_gjc_goal_read`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcGoalReadParams {
	pub thread_id: ThreadId,
}

/// Read-only active goal-mode snapshot from `AgentSession` goal state.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcGoalReadResult {
	pub active:      bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub objective:   Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status:      Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tokens_used: Option<u64>,
}
/// Shared strict thread-only params for read-only gjc execution-state methods.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcThreadReadParams {
	pub thread_id: ThreadId,
}

/// Token-safe model catalog entry for `gjc/model/catalog`; credentials and URLs
/// are intentionally absent.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcModelCatalogEntry {
	pub provider:       String,
	pub model_id:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name:           Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub context_window: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reasoning:      Option<bool>,
	pub available:      bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcModelCatalogResult {
	pub models:          Vec<GjcModelCatalogEntry>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub active_provider: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub active_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub enum GjcProviderAuthKind {
	#[serde(rename = "oauth")]
	OAuth,
	#[serde(rename = "api-key-env")]
	ApiKeyEnv,
	#[serde(rename = "none")]
	None,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcProviderListEntry {
	pub id:            String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name:          Option<String>,
	pub auth_kind:     GjcProviderAuthKind,
	pub authenticated: bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub env_var:       Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcProviderListParams {}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcProviderListResult {
	pub providers: Vec<GjcProviderListEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcProviderAddParams {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub preset:        Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub compatibility: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub provider_id:   Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub base_url:      Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub api_key_env:   Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub models:        Option<Vec<String>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub force:         Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcProviderAddResult {
	pub ok:          bool,
	pub provider_id: String,
	pub models:      Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum GjcAuthLoginFlowState {
	Idle,
	PendingBrowser,
	NeedsInput,
	Authenticated,
	Failed,
	Cancelled,
	Unsupported,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAuthLoginStartParams {
	pub provider_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAuthLoginStartResult {
	pub flow_id:      String,
	pub state:        GjcAuthLoginFlowState,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub auth_url:     Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub instructions: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAuthLoginPollParams {
	pub flow_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAuthLoginPollResult {
	pub state:          GjcAuthLoginFlowState,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt_message: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAuthLoginCompleteParams {
	pub flow_id:      String,
	pub redirect_url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAuthLoginCompleteResult {
	pub state: GjcAuthLoginFlowState,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAuthLoginCancelParams {
	pub flow_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAuthLoginCancelResult {
	pub state: GjcAuthLoginFlowState,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub enum GjcAuthState {
	#[serde(rename = "authenticated")]
	Authenticated,
	#[serde(rename = "unauthenticated")]
	Unauthenticated,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub enum GjcAuthMethod {
	#[serde(rename = "oauth")]
	OAuth,
	#[serde(rename = "env")]
	Env,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAuthStatusEntry {
	pub provider_id: String,
	pub state:       GjcAuthState,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub method:      Option<GjcAuthMethod>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAuthStatusParams {}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcAuthStatusResult {
	pub providers: Vec<GjcAuthStatusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAuthLogoutParams {
	pub provider_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAuthLogoutResult {
	pub provider_id:   String,
	pub authenticated: bool,
}

pub type GjcThinkingReadParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcThinkingReadResult {
	pub level:  String,
	pub levels: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcThinkingSetParams {
	pub thread_id: ThreadId,
	pub level:     String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcThinkingSetResult {
	pub level: String,
}

pub type GjcFastReadParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcFastReadResult {
	pub enabled:        bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub affected_roles: Option<Vec<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcFastSetParams {
	pub thread_id: ThreadId,
	pub enabled:   bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcFastSetResult {
	pub enabled:        bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub affected_roles: Option<Vec<String>>,
}

/// Safe settings schema descriptor for a hard-coded UI/behavior allowlist only:
///
/// theme.dark, theme.light, notifications.terminalBell,
/// notifications.bellOnComplete, notifications.bellOnApproval,
/// notifications.bellOnAsk, autoResume.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSettingDescriptor {
	pub key:         String,
	pub r#type:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub label:       Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none", rename = "enum")]
	pub enum_values: Option<Vec<String>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub default:     Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSettingsSchemaParams {}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcSettingsSchemaResult {
	pub settings: Vec<GjcSettingDescriptor>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSettingsReadParams {}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcSettingsReadResult {
	pub values: std::collections::BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSettingsUpdateParams {
	pub key:   String,
	pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcSettingsUpdateResult {
	pub values: std::collections::BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAppearanceSemanticPreview {
	pub bg:          String,
	pub bg_elevated: String,
	pub surface:     String,
	pub border:      String,
	pub text:        String,
	pub text_muted:  String,
	pub accent:      String,
	pub success:     String,
	pub warning:     String,
	pub danger:      String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAppearanceThemeEntry {
	pub id:               String,
	pub kind:             GjcAppearanceThemeKind,
	pub semantic_preview: GjcAppearanceSemanticPreview,
	pub builtin:          bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub enum GjcAppearanceThemeKind {
	#[serde(rename = "dark")]
	Dark,
	#[serde(rename = "light")]
	Light,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAppearanceThemesListParams {}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcAppearanceThemesListResult {
	pub themes: Vec<GjcAppearanceThemeEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAppearanceReadParams {}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAppearanceReadResult {
	pub dark:             String,
	pub light:            String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub symbol_preset:    Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub color_blind_mode: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcAppearanceSetParams {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub dark:             Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub light:            Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub symbol_preset:    Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub color_blind_mode: Option<bool>,
}
pub type GjcAppearanceSetResult = GjcAppearanceReadResult;

pub type GjcTodosReadParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcTodoItem {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub id:      Option<String>,
	pub content: String,
	pub status:  String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcTodosReadResult {
	pub todos: Vec<GjcTodoItem>,
}

pub type GjcUsageReadParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcModelUsage {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub provider:    Option<String>,
	pub model_id:    String,
	pub input:       u64,
	pub output:      u64,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_read:  Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_write: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cost:        Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcUsageReadResult {
	pub per_model:  Vec<GjcModelUsage>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub total_cost: Option<f64>,
	pub source:     String,
	pub freshness:  GjcContextFreshness,
}

pub type GjcJobsListParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcJobEntry {
	pub id:          String,
	pub r#type:      String,
	pub status:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub started_at:  Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub ended_at:    Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcJobsListResult {
	pub jobs: Vec<GjcJobEntry>,
}

pub type GjcAgentsListParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcAgentEntry {
	pub id:          String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub agent_type:  Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	pub status:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub output_ref:  Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcAgentsListResult {
	pub agents: Vec<GjcAgentEntry>,
}

pub type GjcMonitorsListParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcMonitorEntry {
	pub id:          String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub kind:        Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	pub status:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub started_at:  Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub output_tail: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcCronEntry {
	pub id:              String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub human_schedule:  Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cron_expression: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt:          Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub recurring:       Option<bool>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub next_fire_at:    Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub created_at:      Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcMonitorsListResult {
	pub monitors: Vec<GjcMonitorEntry>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub crons:    Option<Vec<GjcCronEntry>>,
}

pub type GjcCompactSummaryParams = GjcThreadReadParams;
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcCompactSummaryEntry {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub id:            Option<String>,
	pub summary:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tokens_before: Option<u64>,
	pub timestamp:     String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct GjcCompactSummaryResult {
	pub summaries: Vec<GjcCompactSummaryEntry>,
}

/// `gjc/session/list` params; strict fields enforced in
/// `server.rs::handle_gjc_session_list`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionListParams {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub scope:  Option<GjcSessionScope>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub limit:  Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub offset: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cwd:    Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GjcSessionScope {
	Cwd,
	All,
}

/// Token-safe session index row returned by `gjc/session/list` and
///
/// `gjc/session/search`. Path fields are local absolute filesystem paths for
/// the local-only desktop surface and are not exposed over network transports;
/// title/firstMessage are truncated by the host to 200 characters.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionIndexEntry {
	pub id:            String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:         Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub first_message: Option<String>,
	pub cwd:           String,
	pub path:          String,
	pub modified_at:   String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub entry_count:   Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionListResult {
	pub sessions: Vec<SessionIndexEntry>,
	pub total:    u64,
}

/// `gjc/session/search` params; strict fields enforced in
/// `server.rs::handle_gjc_session_search`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionSearchParams {
	pub query: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub scope: Option<GjcSessionScope>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub limit: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cwd:   Option<String>,
}

pub type GjcSessionSearchResult = GjcSessionListResult;

/// `gjc/session/rename` params; strict fields enforced in
/// `server.rs::handle_gjc_session_rename`.
///
/// `sessionPath` is a local absolute `.jsonl` path for the desktop-only
/// surface; the host traversal-checks and verifies the regular file before
/// opening it.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionRenameParams {
	pub session_path: String,
	pub title:        String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionRenameResult {
	pub ok:    bool,
	pub title: String,
}

/// `gjc/session/open` params; strict fields enforced in
/// `server.rs::handle_gjc_session_open`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionOpenParams {
	pub session_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionOpenResult {
	pub thread_id:        String,
	pub session_metadata: serde_json::Value,
	pub generation:       BackendGeneration,
	pub resumed:          bool,
}

/// `gjc/session/delete` params; strict fields enforced in
/// `server.rs::handle_gjc_session_delete`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionDeleteParams {
	pub session_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionDeleteResult {
	pub ok: bool,
}

/// `gjc/session/navigate` params; strict fields enforced in
/// `server.rs::handle_gjc_session_navigate`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionNavigateParams {
	pub thread_id: ThreadId,
	pub entry_id:  String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub summarize: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionNavigateResult {
	pub ok:             bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub active_leaf_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionMoveParams {
	pub thread_id:  ThreadId,
	pub target_cwd: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub dry_run:    Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionMoveDryRunResult {
	pub dry_run:             bool,
	pub source_session_file: String,
	pub target_session_file: String,
	pub artifacts_dirs:      Vec<String>,
	pub cross_device:        bool,
	pub conflicts:           Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionMoveMovedResult {
	pub dry_run:      bool,
	pub moved_to:     String,
	pub session_path: String,
}
pub type GjcSessionMoveResult = Value;

/// `gjc/session/label` params; strict fields enforced in
/// `server.rs::handle_gjc_session_label`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionLabelParams {
	pub thread_id: ThreadId,
	pub entry_id:  String,
	pub label:     String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionLabelResult {
	pub ok: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GjcSessionExportFormat {
	Markdown,
	Json,
}

/// `gjc/session/export` params; strict fields enforced in
/// `server.rs::handle_gjc_session_export`.
///
/// `sessionPath` is a local absolute `.jsonl` path for the desktop-only
/// surface; the host traversal-checks and verifies the regular file before
/// opening it. Redaction defaults to true.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionExportParams {
	pub session_path: String,
	pub format:       GjcSessionExportFormat,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub redact:       Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionExportProvenance {
	pub exported_at: String,
	pub session_id:  String,
	pub source_path: String,
	pub redacted:    bool,
	pub tool:        String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionExportResult {
	pub content:    String,
	pub format:     GjcSessionExportFormat,
	pub provenance: GjcSessionExportProvenance,
}

/// `gjc/session/tree` params; strict fields enforced in
/// `server.rs::handle_gjc_session_tree`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSessionTreeParams {
	pub thread_id: ThreadId,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionTreeNodeDto {
	pub id:        String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub parent_id: Option<String>,
	pub r#type:    String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub label:     Option<String>,
	pub preview:   String,
	pub timestamp: String,
	pub active:    bool,
	pub children:  Vec<Self>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSessionTreeResult {
	pub nodes:          Vec<SessionTreeNodeDto>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub active_leaf_id: Option<String>,
}
/// `gjc/tools/list` params; strict fields enforced in
/// `server.rs::handle_gjc_tools_list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcToolsListParams {
	pub thread_id: ThreadId,
}

/// Tool descriptor returned by `gjc/tools/list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
	pub name:        String,
	pub active:      bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
}

/// `gjc/tools/list` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcToolsListResult {
	pub tools: Vec<ToolDescriptor>,
}

/// `gjc/commands/list` params; strict fields enforced in
/// `server.rs::handle_gjc_commands_list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcCommandsListParams {
	pub thread_id:        ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Command descriptor returned by `gjc/commands/list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandDescriptor {
	pub name:           String,
	pub source:         String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description:    Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub classification: Option<String>,
}

/// `gjc/commands/list` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcCommandsListResult {
	pub commands: Vec<CommandDescriptor>,
}

/// `gjc/skills/list` params; strict fields enforced in
/// `server.rs::handle_gjc_skills_list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSkillsListParams {
	pub thread_id:        ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Skill descriptor returned by `gjc/skills/list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
	pub name:        String,
	pub source:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub enabled:     Option<bool>,
}

/// `gjc/skills/list` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSkillsListResult {
	pub skills: Vec<SkillDescriptor>,
}

/// `gjc/extensions/list` params; strict fields enforced in
/// `server.rs::handle_gjc_extensions_list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcExtensionsListParams {
	pub thread_id:        ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Extension descriptor returned by `gjc/extensions/list` and inspect.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDescriptor {
	pub id:              String,
	pub name:            String,
	pub kind:            String,
	pub source:          String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status:          Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub state:           Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub disabled_reason: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub shadowed_by:     Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub provider:        Option<String>,
}

/// `gjc/extensions/list` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcExtensionsListResult {
	pub extensions: Vec<ExtensionDescriptor>,
}

/// `gjc/extensions/inspect` params; strict fields enforced in
/// `server.rs::handle_gjc_extensions_inspect`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcExtensionsInspectParams {
	pub thread_id:    ThreadId,
	pub extension_id: String,
}

/// `gjc/extensions/inspect` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcExtensionsInspectResult {
	pub extension: Option<ExtensionDescriptor>,
}

/// `gjc/plugins/list` params; strict fields enforced in
/// `server.rs::handle_gjc_plugins_list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcPluginsListParams {
	pub thread_id:        ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Plugin descriptor returned by `gjc/plugins/list` and inspect.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
	pub id:     String,
	pub name:   String,
	pub kind:   String,
	pub source: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status: Option<String>,
}

/// `gjc/plugins/list` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcPluginsListResult {
	pub plugins: Vec<PluginDescriptor>,
}

/// `gjc/plugins/inspect` params; strict fields enforced in
/// `server.rs::handle_gjc_plugins_inspect`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcPluginsInspectParams {
	pub thread_id:        ThreadId,
	pub plugin_id:        String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_settings: Option<bool>,
}

/// Plugin inspection returned by `gjc/plugins/inspect`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInspection {
	pub plugin:   PluginDescriptor,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub settings: Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub manifest: Option<Value>,
}

/// `gjc/plugins/inspect` result.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcPluginsInspectResult {
	pub plugin: Option<PluginInspection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcExtensionsSetEnabledParams {
	pub extension_id: String,
	pub enabled:      bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcExtensionsSetEnabledResult {
	pub ok:      bool,
	pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcSkillsSetEnabledParams {
	pub skill_id: String,
	pub enabled:  bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcSkillsSetEnabledResult {
	pub ok:      bool,
	pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcPluginsSetEnabledParams {
	pub plugin_id: String,
	pub enabled:   bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcPluginsSetEnabledResult {
	pub ok:      bool,
	pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcPluginsSetFeatureParams {
	pub plugin_id: String,
	pub feature:   String,
	pub enabled:   bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcPluginsSetFeatureResult {
	pub ok: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcPluginsSetSettingParams {
	pub plugin_id: String,
	pub key:       String,
	pub value:     Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcPluginsSetSettingResult {
	pub ok: bool,
}

/// `gjc/messages/get` params; strict fields enforced in
/// `server.rs::handle_gjc_messages_get`.
pub type GjcMessagesGetParams = ThreadIdParams;
/// `gjc/messages/get` result is backend-owned messages JSON; see
/// `server.rs::handle_gjc_messages_get`.
pub type GjcMessagesGetResult = Value;

/// `gjc/model/set` params; strict fields enforced in
/// `server.rs::handle_gjc_model_set`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcModelSetParams {
	pub thread_id: ThreadId,
	pub provider:  String,
	pub model_id:  String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GjcModelAssignParams {
	pub thread_id:      ThreadId,
	pub role:           String,
	pub provider:       String,
	pub model_id:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub thinking_level: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcModelAssignResult {
	pub ok:       bool,
	pub role:     String,
	pub model_id: String,
}
/// `gjc/model/set` result is backend-owned model state JSON; see
/// `server.rs::handle_gjc_model_set`.
pub type GjcModelSetResult = Value;

/// `gjc/todos/set` params; strict fields enforced in
/// `server.rs::handle_gjc_todos_set`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcTodosSetParams {
	pub thread_id: ThreadId,
	pub phases:    Value,
}

/// `gjc/todos/set` result; see `server.rs::handle_gjc_todos_set`.
pub type GjcTodosSetResult = EmptyResult;

/// `gjc/compact` params; strict fields enforced in
/// `server.rs::handle_gjc_compact`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcCompactParams {
	pub thread_id:           ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub custom_instructions: Option<String>,
}

/// `gjc/compact` result is backend-owned compact result JSON; see
/// `server.rs::handle_gjc_compact`.
pub type GjcCompactResult = Value;

/// Host tool descriptor consumed by `gjc/hostTools/set`; see
/// `host_tools.rs::parse_set_params`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostToolDescriptor {
	pub name:            String,
	pub description:     String,
	pub input_schema:    Value,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result_policy:   Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub redaction_hints: Option<Value>,
}

/// `gjc/hostTools/set` params; strict fields enforced in
/// `host_tools.rs::parse_set_params`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcHostToolsSetParams {
	pub thread_id: ThreadId,
	pub tools:     Vec<HostToolDescriptor>,
}

/// `gjc/hostTools/set` result; see `server.rs::handle_host_tools_set`.
pub type GjcHostToolsSetResult = EmptyResult;

/// `gjc/hostTools/result` params and backend result shape; see
/// `host_tools.rs::parse_result_params`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcHostToolsResultParams {
	pub thread_id: ThreadId,
	pub call_id:   String,
	pub ok:        bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result:    Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error:     Option<Value>,
}

/// `gjc/hostTools/result` result; see `server.rs::handle_host_tools_result`.
pub type GjcHostToolsResultResult = EmptyResult;

/// `gjc/hostTools/update` params; strict fields enforced in
/// `host_tools.rs::parse_update_params`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcHostToolsUpdateParams {
	pub thread_id: ThreadId,
	pub call_id:   String,
	pub payload:   Value,
}

/// `gjc/hostTools/update` result; see `server.rs::handle_host_tools_update`.
pub type GjcHostToolsUpdateResult = EmptyResult;

/// `gjc/hostTools/call` notification params emitted by
/// `server.rs::host_tool_call`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostToolsCallParams {
	pub thread_id:  ThreadId,
	pub generation: BackendGeneration,
	pub turn_id:    TurnId,
	pub call_id:    String,
	pub tool:       String,
	pub args:       Value,
}

/// `gjc/hostTools/cancel` notification params emitted by
/// `server.rs::cancel_host_tool_calls_for_*`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostToolsCancelParams {
	pub thread_id:  ThreadId,
	pub generation: BackendGeneration,
	pub turn_id:    TurnId,
	pub call_id:    String,
}

/// Common thread-scoped notification fields inserted by
/// `event_map.rs::ThreadStream::note`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventBase {
	pub thread_id: ThreadId,
	pub seq:       u64,
}

/// `turn/started` notification params emitted by
/// `event_map.rs::begin_turn`/`on_event`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedParams {
	pub thread_id: ThreadId,
	pub seq:       u64,
	pub turn_id:   TurnId,
}

/// `turn/completed` notification params emitted by
/// `event_map.rs::flush_terminal`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedParams {
	pub thread_id: ThreadId,
	pub seq:       u64,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub turn_id:   Option<String>,
	pub status:    String,
}

/// `item/started` notification params emitted by `event_map.rs::on_event` for
/// messages, reasoning, compaction, and tools.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemStartedParams {
	pub thread_id: ThreadId,
	pub seq:       u64,
	pub item_id:   ItemId,
	pub item_type: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub content:   Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tool_name: Option<String>,
}

/// `item/agentMessage/delta` notification params emitted by
/// `event_map.rs::on_event` for text deltas.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemAgentMessageDeltaParams {
	pub thread_id: ThreadId,
	pub seq:       u64,
	pub item_id:   ItemId,
	pub delta:     String,
}

/// `item/completed` notification params emitted by
/// `event_map.rs::complete_message_item` and tool completion mapping.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemCompletedParams {
	pub thread_id: ThreadId,
	pub seq:       u64,
	pub item_id:   ItemId,
	pub item_type: String,
}

/// `gjc/event` notification params emitted after every backend event by
/// `event_map.rs::raw`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcEventParams {
	pub thread_id:  ThreadId,
	pub seq:        u64,
	pub event_type: String,
	pub event:      Value,
}

/// `gjc/jobs/changed` notification params emitted when backend job, monitor,
/// or agent execution state changes.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobsChangedParams {
	pub thread_id:   String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub generation:  Option<u64>,
	pub kind:        String,
	pub id:          String,
	pub status:      String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
}

/// Method-specific server notification envelopes for GUI-consumed events; see
/// `event_map.rs`, host-tool, host-URI, and workflow-gate notification emitters
/// in `server.rs`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "method", content = "params")]
pub enum ServerNotificationEnvelope {
	#[serde(rename = "turn/started")]
	TurnStarted(TurnStartedParams),
	#[serde(rename = "turn/completed")]
	TurnCompleted(TurnCompletedParams),
	#[serde(rename = "item/started")]
	ItemStarted(ItemStartedParams),
	#[serde(rename = "item/agentMessage/delta")]
	ItemAgentMessageDelta(ItemAgentMessageDeltaParams),
	#[serde(rename = "item/completed")]
	ItemCompleted(ItemCompletedParams),
	#[serde(rename = "gjc/event")]
	GjcEvent(GjcEventParams),
	#[serde(rename = "gjc/jobs/changed")]
	JobsChanged(JobsChangedParams),
	#[serde(rename = "gjc/hostTools/call")]
	HostToolsCall(HostToolsCallParams),
	#[serde(rename = "gjc/hostTools/cancel")]
	HostToolsCancel(HostToolsCancelParams),
	#[serde(rename = "gjc/hostUris/request")]
	HostUriRequest(crate::host_uris::HostUriRequestParams),
	#[serde(rename = "gjc/hostUris/cancel")]
	HostUriCancel(crate::host_uris::HostUriCancelParams),
	#[serde(rename = "gjc/workflowGate/opened")]
	WorkflowGateOpened(Box<crate::workflow_gate::WorkflowGateOpenedParams>),
}
