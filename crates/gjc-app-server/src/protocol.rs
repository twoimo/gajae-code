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
	pub user_agent: String,
	pub platform_os: String,
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
	pub extra: serde_json::Map<String, Value>,
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
	pub id: String,
	pub status: ThreadStatus,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub generation: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub turns: Option<Vec<Value>>,
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
	pub thread: ThreadSummary,
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
	pub thread_id: ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expected_turn_id: Option<TurnId>,
	#[serde(flatten)]
	pub extra: serde_json::Map<String, Value>,
}

/// `turn/start` result; see `server.rs::handle_turn_start`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TurnStartResult {
	pub turn: TurnSummary,
}

/// Turn object returned by `turn/start`; see `server.rs::handle_turn_start`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct TurnSummary {
	pub id: String,
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

/// `turn/interrupt` params; see `server.rs::handle_turn_interrupt`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
	pub thread_id: ThreadId,
	pub turn_id: TurnId,
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
	pub include: Option<Value>,
}

/// `gjc/state/read` result is backend-owned state JSON; see
/// `server.rs::handle_gjc_state_read`.
pub type GjcStateReadResult = Value;

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
	pub name: String,
	pub active: bool,
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
	pub thread_id: ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Command descriptor returned by `gjc/commands/list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommandDescriptor {
	pub name: String,
	pub source: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
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
	pub thread_id: ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Skill descriptor returned by `gjc/skills/list`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillDescriptor {
	pub name: String,
	pub source: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub enabled: Option<bool>,
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
	pub thread_id: ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Extension descriptor returned by `gjc/extensions/list` and inspect.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDescriptor {
	pub id: String,
	pub name: String,
	pub kind: String,
	pub source: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status: Option<String>,
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
	pub thread_id: ThreadId,
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
	pub thread_id: ThreadId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_disabled: Option<bool>,
}

/// Plugin descriptor returned by `gjc/plugins/list` and inspect.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
	pub id: String,
	pub name: String,
	pub kind: String,
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
	pub thread_id: ThreadId,
	pub plugin_id: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_settings: Option<bool>,
}

/// Plugin inspection returned by `gjc/plugins/inspect`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInspection {
	pub plugin: PluginDescriptor,
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
	pub provider: String,
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
	pub phases: Value,
}

/// `gjc/todos/set` result; see `server.rs::handle_gjc_todos_set`.
pub type GjcTodosSetResult = EmptyResult;

/// `gjc/compact` params; strict fields enforced in
/// `server.rs::handle_gjc_compact`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcCompactParams {
	pub thread_id: ThreadId,
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
	pub name: String,
	pub description: String,
	pub input_schema: Value,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result_policy: Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub redaction_hints: Option<Value>,
}

/// `gjc/hostTools/set` params; strict fields enforced in
/// `host_tools.rs::parse_set_params`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcHostToolsSetParams {
	pub thread_id: ThreadId,
	pub tools: Vec<HostToolDescriptor>,
}

/// `gjc/hostTools/set` result; see `server.rs::handle_host_tools_set`.
pub type GjcHostToolsSetResult = EmptyResult;

/// `gjc/hostTools/result` params and backend result shape; see
/// `host_tools.rs::parse_result_params`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcHostToolsResultParams {
	pub thread_id: ThreadId,
	pub call_id: String,
	pub ok: bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result: Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error: Option<Value>,
}

/// `gjc/hostTools/result` result; see `server.rs::handle_host_tools_result`.
pub type GjcHostToolsResultResult = EmptyResult;

/// `gjc/hostTools/update` params; strict fields enforced in
/// `host_tools.rs::parse_update_params`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcHostToolsUpdateParams {
	pub thread_id: ThreadId,
	pub call_id: String,
	pub payload: Value,
}

/// `gjc/hostTools/update` result; see `server.rs::handle_host_tools_update`.
pub type GjcHostToolsUpdateResult = EmptyResult;

/// `gjc/hostTools/call` notification params emitted by
/// `server.rs::host_tool_call`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostToolsCallParams {
	pub thread_id: ThreadId,
	pub generation: BackendGeneration,
	pub turn_id: TurnId,
	pub call_id: String,
	pub tool: String,
	pub args: Value,
}

/// `gjc/hostTools/cancel` notification params emitted by
/// `server.rs::cancel_host_tool_calls_for_*`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostToolsCancelParams {
	pub thread_id: ThreadId,
	pub generation: BackendGeneration,
	pub turn_id: TurnId,
	pub call_id: String,
}

/// Common thread-scoped notification fields inserted by
/// `event_map.rs::ThreadStream::note`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventBase {
	pub thread_id: ThreadId,
	pub seq: u64,
}

/// `turn/started` notification params emitted by
/// `event_map.rs::begin_turn`/`on_event`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartedParams {
	pub thread_id: ThreadId,
	pub seq: u64,
	pub turn_id: TurnId,
}

/// `turn/completed` notification params emitted by
/// `event_map.rs::flush_terminal`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletedParams {
	pub thread_id: ThreadId,
	pub seq: u64,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub turn_id: Option<String>,
	pub status: String,
}

/// `item/started` notification params emitted by `event_map.rs::on_event` for
/// messages, reasoning, compaction, and tools.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemStartedParams {
	pub thread_id: ThreadId,
	pub seq: u64,
	pub item_id: ItemId,
	pub item_type: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub content: Option<Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tool_name: Option<String>,
}

/// `item/agentMessage/delta` notification params emitted by
/// `event_map.rs::on_event` for text deltas.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemAgentMessageDeltaParams {
	pub thread_id: ThreadId,
	pub seq: u64,
	pub item_id: ItemId,
	pub delta: String,
}

/// `item/completed` notification params emitted by
/// `event_map.rs::complete_message_item` and tool completion mapping.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemCompletedParams {
	pub thread_id: ThreadId,
	pub seq: u64,
	pub item_id: ItemId,
	pub item_type: String,
}

/// `gjc/event` notification params emitted after every backend event by
/// `event_map.rs::raw`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GjcEventParams {
	pub thread_id: ThreadId,
	pub seq: u64,
	pub event_type: String,
	pub event: Value,
}

/// Method-specific server notification envelopes for GUI-consumed events; see
/// `event_map.rs`, host-tool, host-URI, and workflow-gate notification emitters in `server.rs`.
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
