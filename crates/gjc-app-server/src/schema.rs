//! Rust-derived JSON Schema for the app-server wire protocol (Phase 0A gate).
//!
//! The Rust protocol types and dispatch method catalog are the single source of
//! truth. This module emits a JSON Schema bundle for the typed wire surface;
//! the `gjc-app-server-schema` binary writes/checks
//! `schemas/app-server.schema.json`, wired into the repo's `generate-schemas` /
//! `check:schemas` gate so schema drift fails CI.
//!
//! As protocol DTOs are added, they are added to [`schema_bundle`] and the
//! committed artifact grows with them.

use schemars::schema_for;

fn def<T: schemars::JsonSchema>() -> serde_json::Value {
	serde_json::to_value(schema_for!(T)).expect("schema serializes")
}

/// The full JSON Schema bundle for the currently-typed wire surface.
#[must_use]
pub fn schema_bundle() -> serde_json::Value {
	let mut defs = serde_json::Map::new();
	macro_rules! insert_def {
		($name:literal, $ty:ty) => {
			defs.insert($name.into(), def::<$ty>());
		};
	}
	macro_rules! method {
		($method:literal, $params:expr, $result:expr, $gui_wrapper:literal) => {
			serde_json::json!({
				"method": $method,
				"paramsDef": $params,
				"resultDef": $result,
				"guiWrapper": $gui_wrapper,
			})
		};
	}
	insert_def!("Request", crate::jsonrpc::Request);
	insert_def!("Response", crate::jsonrpc::Response);
	insert_def!("Notification", crate::jsonrpc::Notification);
	insert_def!("ClientNotification", crate::jsonrpc::ClientNotification);
	insert_def!("RequestId", crate::jsonrpc::RequestId);
	insert_def!("AppServerError", crate::error::AppServerError);
	insert_def!("ThreadIdentity", crate::identity::ThreadIdentity);
	insert_def!("ThreadStatus", crate::identity::ThreadStatus);
	insert_def!("SessionMetadata", crate::identity::SessionMetadata);
	insert_def!("ItemState", crate::item_state::ItemState);
	insert_def!("TurnState", crate::item_state::TurnState);
	insert_def!("TerminalCause", crate::item_state::TerminalCause);
	insert_def!("EmptyResult", crate::protocol::EmptyResult);
	insert_def!("InitializeParams", crate::protocol::InitializeParams);
	insert_def!("InitializeResult", crate::protocol::InitializeResult);
	insert_def!("InitializedParams", crate::protocol::InitializedParams);
	insert_def!("ThreadStartParams", crate::protocol::ThreadStartParams);
	insert_def!("ThreadResumeParams", crate::protocol::ThreadResumeParams);
	insert_def!("ThreadForkParams", crate::protocol::ThreadForkParams);
	insert_def!("ThreadIdParams", crate::protocol::ThreadIdParams);
	insert_def!("ThreadSummary", crate::protocol::ThreadSummary);
	insert_def!("ThreadResult", crate::protocol::ThreadResult);
	insert_def!("ThreadResumeResult", crate::protocol::ThreadResumeResult);
	insert_def!("ThreadReadParams", crate::protocol::ThreadReadParams);
	insert_def!("ThreadReadResult", crate::protocol::ThreadReadResult);
	insert_def!("ThreadLoadedListParams", crate::protocol::ThreadLoadedListParams);
	insert_def!("ThreadLoadedListResult", crate::protocol::ThreadLoadedListResult);
	insert_def!("TurnStartParams", crate::protocol::TurnStartParams);
	insert_def!("TurnStartResult", crate::protocol::TurnStartResult);
	insert_def!("TurnSummary", crate::protocol::TurnSummary);
	insert_def!("TurnSteerParams", crate::protocol::TurnSteerParams);
	insert_def!("TurnSteerResult", crate::protocol::TurnSteerResult);
	insert_def!("TurnInterruptParams", crate::protocol::TurnInterruptParams);
	insert_def!("TurnInterruptResult", crate::protocol::TurnInterruptResult);
	insert_def!("GjcStateReadParams", crate::protocol::GjcStateReadParams);
	insert_def!("GjcStateReadResult", crate::protocol::GjcStateReadResult);
	insert_def!("GjcToolsListParams", crate::protocol::GjcToolsListParams);
	insert_def!("ToolDescriptor", crate::protocol::ToolDescriptor);
	insert_def!("GjcToolsListResult", crate::protocol::GjcToolsListResult);
	insert_def!("GjcCommandsListParams", crate::protocol::GjcCommandsListParams);
	insert_def!("CommandDescriptor", crate::protocol::CommandDescriptor);
	insert_def!("GjcCommandsListResult", crate::protocol::GjcCommandsListResult);
	insert_def!("GjcSkillsListParams", crate::protocol::GjcSkillsListParams);
	insert_def!("SkillDescriptor", crate::protocol::SkillDescriptor);
	insert_def!("GjcSkillsListResult", crate::protocol::GjcSkillsListResult);
	insert_def!("GjcExtensionsListParams", crate::protocol::GjcExtensionsListParams);
	insert_def!("ExtensionDescriptor", crate::protocol::ExtensionDescriptor);
	insert_def!("GjcExtensionsListResult", crate::protocol::GjcExtensionsListResult);
	insert_def!("GjcExtensionsInspectParams", crate::protocol::GjcExtensionsInspectParams);
	insert_def!("GjcExtensionsInspectResult", crate::protocol::GjcExtensionsInspectResult);
	insert_def!("GjcPluginsListParams", crate::protocol::GjcPluginsListParams);
	insert_def!("PluginDescriptor", crate::protocol::PluginDescriptor);
	insert_def!("GjcPluginsListResult", crate::protocol::GjcPluginsListResult);
	insert_def!("PluginInspection", crate::protocol::PluginInspection);
	insert_def!("GjcPluginsInspectParams", crate::protocol::GjcPluginsInspectParams);
	insert_def!("GjcPluginsInspectResult", crate::protocol::GjcPluginsInspectResult);
	insert_def!("GjcMessagesGetParams", crate::protocol::GjcMessagesGetParams);
	insert_def!("GjcMessagesGetResult", crate::protocol::GjcMessagesGetResult);
	insert_def!("GjcModelSetParams", crate::protocol::GjcModelSetParams);
	insert_def!("GjcModelSetResult", crate::protocol::GjcModelSetResult);
	insert_def!("GjcTodosSetParams", crate::protocol::GjcTodosSetParams);
	insert_def!("GjcTodosSetResult", crate::protocol::GjcTodosSetResult);
	insert_def!("GjcCompactParams", crate::protocol::GjcCompactParams);
	insert_def!("GjcCompactResult", crate::protocol::GjcCompactResult);
	insert_def!("HostToolDescriptor", crate::protocol::HostToolDescriptor);
	insert_def!("GjcHostToolsSetParams", crate::protocol::GjcHostToolsSetParams);
	insert_def!("GjcHostToolsSetResult", crate::protocol::GjcHostToolsSetResult);
	insert_def!("GjcHostToolsResultParams", crate::protocol::GjcHostToolsResultParams);
	insert_def!("GjcHostToolsResultResult", crate::protocol::GjcHostToolsResultResult);
	insert_def!("GjcHostToolsUpdateParams", crate::protocol::GjcHostToolsUpdateParams);
	insert_def!("GjcHostToolsUpdateResult", crate::protocol::GjcHostToolsUpdateResult);
	insert_def!("HostToolsCallParams", crate::protocol::HostToolsCallParams);
	insert_def!("HostToolsCancelParams", crate::protocol::HostToolsCancelParams);
	insert_def!("ThreadEventBase", crate::protocol::ThreadEventBase);
	insert_def!("TurnStartedParams", crate::protocol::TurnStartedParams);
	insert_def!("TurnCompletedParams", crate::protocol::TurnCompletedParams);
	insert_def!("ItemStartedParams", crate::protocol::ItemStartedParams);
	insert_def!("ItemAgentMessageDeltaParams", crate::protocol::ItemAgentMessageDeltaParams);
	insert_def!("ItemCompletedParams", crate::protocol::ItemCompletedParams);
	insert_def!("GjcEventParams", crate::protocol::GjcEventParams);
	insert_def!("JobsChangedParams", crate::protocol::JobsChangedParams);
	insert_def!("ServerNotificationEnvelope", crate::protocol::ServerNotificationEnvelope);
	insert_def!("RpcWorkflowGate", crate::workflow_gate::RpcWorkflowGate);
	insert_def!("RpcWorkflowStage", crate::workflow_gate::RpcWorkflowStage);
	insert_def!("RpcWorkflowGateKind", crate::workflow_gate::RpcWorkflowGateKind);
	insert_def!("RpcWorkflowGateOption", crate::workflow_gate::RpcWorkflowGateOption);
	insert_def!("RpcWorkflowGateContext", crate::workflow_gate::RpcWorkflowGateContext);
	insert_def!("SchemaValidationIssue", crate::workflow_gate::SchemaValidationIssue);
	insert_def!("RpcWorkflowGateResponse", crate::workflow_gate::RpcWorkflowGateResponse);
	insert_def!("RpcWorkflowGateResolution", crate::workflow_gate::RpcWorkflowGateResolution);
	insert_def!(
		"RpcWorkflowGateValidationError",
		crate::workflow_gate::RpcWorkflowGateValidationError
	);
	insert_def!("WorkflowGateListParams", crate::workflow_gate::WorkflowGateListParams);
	insert_def!("WorkflowGateListResult", crate::workflow_gate::WorkflowGateListResult);
	insert_def!("WorkflowGateRespondParams", crate::workflow_gate::WorkflowGateRespondParams);
	insert_def!("WorkflowGateOpenedParams", crate::workflow_gate::WorkflowGateOpenedParams);
	insert_def!("RpcUnattendedBudget", crate::unattended::RpcUnattendedBudget);
	insert_def!("RpcUnattendedDeclaration", crate::unattended::RpcUnattendedDeclaration);
	insert_def!("RpcUnattendedAccepted", crate::unattended::RpcUnattendedAccepted);
	insert_def!("RpcBudgetExceeded", crate::unattended::RpcBudgetExceeded);
	insert_def!("RpcScopeDenied", crate::unattended::RpcScopeDenied);
	insert_def!("RpcActionDenied", crate::unattended::RpcActionDenied);
	insert_def!("RpcUnattendedRefused", crate::unattended::RpcUnattendedRefused);
	insert_def!("UnattendedNegotiateParams", crate::unattended::UnattendedNegotiateParams);
	insert_def!("HostUriSchemeDefinition", crate::host_uris::HostUriSchemeDefinition);
	insert_def!("HostUriSchemesSetParams", crate::host_uris::HostUriSchemesSetParams);
	insert_def!("HostUriSchemesSetResult", crate::host_uris::HostUriSchemesSetResult);
	insert_def!("HostUriOperation", crate::host_uris::HostUriOperation);
	insert_def!("HostUriRequestParams", crate::host_uris::HostUriRequestParams);
	insert_def!("HostUriCancelParams", crate::host_uris::HostUriCancelParams);
	insert_def!("HostUriResultParams", crate::host_uris::HostUriResultParams);
	insert_def!("HostUriResource", crate::host_uris::HostUriResource);

	insert_def!("GjcSessionListParams", crate::protocol::GjcSessionListParams);
	insert_def!("GjcSessionScope", crate::protocol::GjcSessionScope);
	insert_def!("SessionIndexEntry", crate::protocol::SessionIndexEntry);
	insert_def!("GjcSessionListResult", crate::protocol::GjcSessionListResult);
	insert_def!("GjcSessionSearchParams", crate::protocol::GjcSessionSearchParams);
	insert_def!("GjcSessionSearchResult", crate::protocol::GjcSessionSearchResult);
	insert_def!("GjcSessionRenameParams", crate::protocol::GjcSessionRenameParams);
	insert_def!("GjcSessionRenameResult", crate::protocol::GjcSessionRenameResult);
	insert_def!("GjcSessionOpenParams", crate::protocol::GjcSessionOpenParams);
	insert_def!("GjcSessionOpenResult", crate::protocol::GjcSessionOpenResult);
	insert_def!("GjcSessionDeleteParams", crate::protocol::GjcSessionDeleteParams);
	insert_def!("GjcSessionDeleteResult", crate::protocol::GjcSessionDeleteResult);
	insert_def!("GjcSessionNavigateParams", crate::protocol::GjcSessionNavigateParams);
	insert_def!("GjcSessionNavigateResult", crate::protocol::GjcSessionNavigateResult);
	insert_def!("GjcSessionMoveParams", crate::protocol::GjcSessionMoveParams);
	insert_def!("GjcSessionMoveDryRunResult", crate::protocol::GjcSessionMoveDryRunResult);
	insert_def!("GjcSessionMoveMovedResult", crate::protocol::GjcSessionMoveMovedResult);
	insert_def!("GjcSessionMoveResult", crate::protocol::GjcSessionMoveResult);
	insert_def!("GjcSessionLabelParams", crate::protocol::GjcSessionLabelParams);
	insert_def!("GjcSessionLabelResult", crate::protocol::GjcSessionLabelResult);
	insert_def!("GjcSessionExportFormat", crate::protocol::GjcSessionExportFormat);
	insert_def!("GjcSessionExportParams", crate::protocol::GjcSessionExportParams);
	insert_def!("GjcSessionExportProvenance", crate::protocol::GjcSessionExportProvenance);
	insert_def!("GjcSessionExportResult", crate::protocol::GjcSessionExportResult);
	insert_def!("GjcSessionTreeParams", crate::protocol::GjcSessionTreeParams);
	insert_def!("SessionTreeNodeDto", crate::protocol::SessionTreeNodeDto);
	insert_def!("GjcSessionTreeResult", crate::protocol::GjcSessionTreeResult);
	insert_def!("GjcContextReadParams", crate::protocol::GjcContextReadParams);
	insert_def!("GjcContextReadResult", crate::protocol::GjcContextReadResult);
	insert_def!("GjcContextTokens", crate::protocol::GjcContextTokens);
	insert_def!("GjcContextFreshness", crate::protocol::GjcContextFreshness);
	insert_def!("GjcGoalReadParams", crate::protocol::GjcGoalReadParams);
	insert_def!("GjcGoalReadResult", crate::protocol::GjcGoalReadResult);
	insert_def!("GjcRetryParams", crate::protocol::GjcRetryParams);
	insert_def!("GjcRetryResult", crate::protocol::GjcRetryResult);
	insert_def!("GjcThreadReadParams", crate::protocol::GjcThreadReadParams);
	insert_def!("GjcModelCatalogEntry", crate::protocol::GjcModelCatalogEntry);
	insert_def!("GjcModelCatalogResult", crate::protocol::GjcModelCatalogResult);
	insert_def!("GjcProviderAuthKind", crate::protocol::GjcProviderAuthKind);
	insert_def!("GjcProviderListEntry", crate::protocol::GjcProviderListEntry);
	insert_def!("GjcProviderListParams", crate::protocol::GjcProviderListParams);
	insert_def!("GjcProviderListResult", crate::protocol::GjcProviderListResult);
	insert_def!("GjcAuthState", crate::protocol::GjcAuthState);
	insert_def!("GjcAuthMethod", crate::protocol::GjcAuthMethod);
	insert_def!("GjcAuthStatusEntry", crate::protocol::GjcAuthStatusEntry);
	insert_def!("GjcAuthStatusParams", crate::protocol::GjcAuthStatusParams);
	insert_def!("GjcAuthStatusResult", crate::protocol::GjcAuthStatusResult);
	insert_def!("GjcAuthLogoutParams", crate::protocol::GjcAuthLogoutParams);
	insert_def!("GjcAuthLogoutResult", crate::protocol::GjcAuthLogoutResult);
	insert_def!("GjcProviderAddParams", crate::protocol::GjcProviderAddParams);
	insert_def!("GjcProviderAddResult", crate::protocol::GjcProviderAddResult);
	insert_def!("GjcAuthLoginFlowState", crate::protocol::GjcAuthLoginFlowState);
	insert_def!("GjcAuthLoginStartParams", crate::protocol::GjcAuthLoginStartParams);
	insert_def!("GjcAuthLoginStartResult", crate::protocol::GjcAuthLoginStartResult);
	insert_def!("GjcAuthLoginPollParams", crate::protocol::GjcAuthLoginPollParams);
	insert_def!("GjcAuthLoginPollResult", crate::protocol::GjcAuthLoginPollResult);
	insert_def!("GjcAuthLoginCompleteParams", crate::protocol::GjcAuthLoginCompleteParams);
	insert_def!("GjcAuthLoginCompleteResult", crate::protocol::GjcAuthLoginCompleteResult);
	insert_def!("GjcAuthLoginCancelParams", crate::protocol::GjcAuthLoginCancelParams);
	insert_def!("GjcAuthLoginCancelResult", crate::protocol::GjcAuthLoginCancelResult);
	insert_def!("GjcThinkingReadResult", crate::protocol::GjcThinkingReadResult);
	insert_def!("GjcThinkingSetParams", crate::protocol::GjcThinkingSetParams);
	insert_def!("GjcThinkingSetResult", crate::protocol::GjcThinkingSetResult);
	insert_def!("GjcFastReadResult", crate::protocol::GjcFastReadResult);
	insert_def!("GjcFastSetParams", crate::protocol::GjcFastSetParams);
	insert_def!("GjcFastSetResult", crate::protocol::GjcFastSetResult);
	insert_def!("GjcSettingsSchemaParams", crate::protocol::GjcSettingsSchemaParams);
	insert_def!("GjcSettingsSchemaResult", crate::protocol::GjcSettingsSchemaResult);
	insert_def!("GjcSettingDescriptor", crate::protocol::GjcSettingDescriptor);
	insert_def!("GjcSettingsReadParams", crate::protocol::GjcSettingsReadParams);
	insert_def!("GjcSettingsReadResult", crate::protocol::GjcSettingsReadResult);
	insert_def!("GjcSettingsUpdateParams", crate::protocol::GjcSettingsUpdateParams);
	insert_def!("GjcSettingsUpdateResult", crate::protocol::GjcSettingsUpdateResult);
	insert_def!("GjcAppearanceSemanticPreview", crate::protocol::GjcAppearanceSemanticPreview);
	insert_def!("GjcAppearanceThemeEntry", crate::protocol::GjcAppearanceThemeEntry);
	insert_def!("GjcAppearanceThemeKind", crate::protocol::GjcAppearanceThemeKind);
	insert_def!("GjcAppearanceThemesListParams", crate::protocol::GjcAppearanceThemesListParams);
	insert_def!("GjcAppearanceThemesListResult", crate::protocol::GjcAppearanceThemesListResult);
	insert_def!("GjcAppearanceReadParams", crate::protocol::GjcAppearanceReadParams);
	insert_def!("GjcAppearanceReadResult", crate::protocol::GjcAppearanceReadResult);
	insert_def!("GjcAppearanceSetParams", crate::protocol::GjcAppearanceSetParams);
	insert_def!("GjcAppearanceSetResult", crate::protocol::GjcAppearanceSetResult);
	insert_def!("GjcTodosReadResult", crate::protocol::GjcTodosReadResult);
	insert_def!("GjcTodoItem", crate::protocol::GjcTodoItem);
	insert_def!("GjcUsageReadResult", crate::protocol::GjcUsageReadResult);
	insert_def!("GjcModelUsage", crate::protocol::GjcModelUsage);
	insert_def!("GjcJobsListResult", crate::protocol::GjcJobsListResult);
	insert_def!("GjcJobEntry", crate::protocol::GjcJobEntry);
	insert_def!("GjcAgentsListResult", crate::protocol::GjcAgentsListResult);
	insert_def!("GjcAgentEntry", crate::protocol::GjcAgentEntry);
	insert_def!("GjcMonitorsListResult", crate::protocol::GjcMonitorsListResult);
	insert_def!("GjcMonitorEntry", crate::protocol::GjcMonitorEntry);
	insert_def!("GjcCronEntry", crate::protocol::GjcCronEntry);
	insert_def!("GjcCompactSummaryResult", crate::protocol::GjcCompactSummaryResult);
	insert_def!("GjcCompactSummaryEntry", crate::protocol::GjcCompactSummaryEntry);
	insert_def!("GjcExtensionsSetEnabledParams", crate::protocol::GjcExtensionsSetEnabledParams);
	insert_def!("GjcExtensionsSetEnabledResult", crate::protocol::GjcExtensionsSetEnabledResult);
	insert_def!("GjcSkillsSetEnabledParams", crate::protocol::GjcSkillsSetEnabledParams);
	insert_def!("GjcSkillsSetEnabledResult", crate::protocol::GjcSkillsSetEnabledResult);
	insert_def!("GjcPluginsSetEnabledParams", crate::protocol::GjcPluginsSetEnabledParams);
	insert_def!("GjcPluginsSetEnabledResult", crate::protocol::GjcPluginsSetEnabledResult);
	insert_def!("GjcPluginsSetFeatureParams", crate::protocol::GjcPluginsSetFeatureParams);
	insert_def!("GjcPluginsSetFeatureResult", crate::protocol::GjcPluginsSetFeatureResult);
	insert_def!("GjcPluginsSetSettingParams", crate::protocol::GjcPluginsSetSettingParams);
	insert_def!("GjcPluginsSetSettingResult", crate::protocol::GjcPluginsSetSettingResult);
	insert_def!("GjcModelAssignParams", crate::protocol::GjcModelAssignParams);
	insert_def!("GjcModelAssignResult", crate::protocol::GjcModelAssignResult);
	let method_catalog = vec![
		method!("initialize", Some("InitializeParams"), Some("InitializeResult"), true),
		method!("thread/start", Some("ThreadStartParams"), Some("ThreadResult"), true),
		method!("thread/resume", Some("ThreadResumeParams"), Some("ThreadResumeResult"), true),
		method!("thread/fork", Some("ThreadForkParams"), Some("ThreadResult"), true),
		method!("thread/delete", Some("ThreadIdParams"), Some("EmptyResult"), true),
		method!("thread/archive", Some("ThreadIdParams"), Some("EmptyResult"), true),
		method!("thread/read", Some("ThreadReadParams"), Some("ThreadReadResult"), true),
		method!(
			"thread/loaded/list",
			Some("ThreadLoadedListParams"),
			Some("ThreadLoadedListResult"),
			true
		),
		method!("turn/start", Some("TurnStartParams"), Some("TurnStartResult"), true),
		method!("turn/steer", Some("TurnSteerParams"), Some("TurnSteerResult"), true),
		method!("turn/interrupt", Some("TurnInterruptParams"), Some("TurnInterruptResult"), true),
		method!("gjc/retry", Some("GjcRetryParams"), Some("GjcRetryResult"), true),
		method!("command/exec", None::<&str>, None::<&str>, false),
		method!("thread/shellCommand", None::<&str>, None::<&str>, false),
		method!("gjc/state/read", Some("GjcStateReadParams"), Some("GjcStateReadResult"), true),
		method!("gjc/context/read", Some("GjcContextReadParams"), Some("GjcContextReadResult"), true),
		method!("gjc/goal/read", Some("GjcGoalReadParams"), Some("GjcGoalReadResult"), true),
		method!(
			"gjc/model/catalog",
			Some("GjcThreadReadParams"),
			Some("GjcModelCatalogResult"),
			true
		),
		method!(
			"gjc/thinking/read",
			Some("GjcThreadReadParams"),
			Some("GjcThinkingReadResult"),
			true
		),
		method!("gjc/thinking/set", Some("GjcThinkingSetParams"), Some("GjcThinkingSetResult"), true),
		method!("gjc/fast/read", Some("GjcThreadReadParams"), Some("GjcFastReadResult"), true),
		method!("gjc/fast/set", Some("GjcFastSetParams"), Some("GjcFastSetResult"), true),
		method!(
			"gjc/settings/schema",
			Some("GjcSettingsSchemaParams"),
			Some("GjcSettingsSchemaResult"),
			true
		),
		method!(
			"gjc/settings/read",
			Some("GjcSettingsReadParams"),
			Some("GjcSettingsReadResult"),
			true
		),
		method!(
			"gjc/settings/update",
			Some("GjcSettingsUpdateParams"),
			Some("GjcSettingsUpdateResult"),
			true
		),
		method!(
			"gjc/appearance/themes/list",
			Some("GjcAppearanceThemesListParams"),
			Some("GjcAppearanceThemesListResult"),
			true
		),
		method!(
			"gjc/appearance/read",
			Some("GjcAppearanceReadParams"),
			Some("GjcAppearanceReadResult"),
			true
		),
		method!(
			"gjc/appearance/set",
			Some("GjcAppearanceSetParams"),
			Some("GjcAppearanceSetResult"),
			true
		),
		method!(
			"gjc/provider/list",
			Some("GjcProviderListParams"),
			Some("GjcProviderListResult"),
			true
		),
		method!("gjc/auth/status", Some("GjcAuthStatusParams"), Some("GjcAuthStatusResult"), true),
		method!("gjc/auth/logout", Some("GjcAuthLogoutParams"), Some("GjcAuthLogoutResult"), true),
		method!("gjc/provider/add", Some("GjcProviderAddParams"), Some("GjcProviderAddResult"), true),
		method!(
			"gjc/auth/login/start",
			Some("GjcAuthLoginStartParams"),
			Some("GjcAuthLoginStartResult"),
			true
		),
		method!(
			"gjc/auth/login/poll",
			Some("GjcAuthLoginPollParams"),
			Some("GjcAuthLoginPollResult"),
			true
		),
		method!(
			"gjc/auth/login/complete",
			Some("GjcAuthLoginCompleteParams"),
			Some("GjcAuthLoginCompleteResult"),
			true
		),
		method!(
			"gjc/auth/login/cancel",
			Some("GjcAuthLoginCancelParams"),
			Some("GjcAuthLoginCancelResult"),
			true
		),
		method!("gjc/todos/read", Some("GjcThreadReadParams"), Some("GjcTodosReadResult"), true),
		method!("gjc/usage/read", Some("GjcThreadReadParams"), Some("GjcUsageReadResult"), true),
		method!("gjc/jobs/list", Some("GjcThreadReadParams"), Some("GjcJobsListResult"), true),
		method!("gjc/agents/list", Some("GjcThreadReadParams"), Some("GjcAgentsListResult"), true),
		method!(
			"gjc/monitors/list",
			Some("GjcThreadReadParams"),
			Some("GjcMonitorsListResult"),
			true
		),
		method!(
			"gjc/compact/summary",
			Some("GjcThreadReadParams"),
			Some("GjcCompactSummaryResult"),
			true
		),
		method!("gjc/session/list", Some("GjcSessionListParams"), Some("GjcSessionListResult"), true),
		method!(
			"gjc/session/search",
			Some("GjcSessionSearchParams"),
			Some("GjcSessionSearchResult"),
			true
		),
		method!(
			"gjc/session/rename",
			Some("GjcSessionRenameParams"),
			Some("GjcSessionRenameResult"),
			true
		),
		method!("gjc/session/open", Some("GjcSessionOpenParams"), Some("GjcSessionOpenResult"), true),
		method!(
			"gjc/session/delete",
			Some("GjcSessionDeleteParams"),
			Some("GjcSessionDeleteResult"),
			true
		),
		method!(
			"gjc/session/export",
			Some("GjcSessionExportParams"),
			Some("GjcSessionExportResult"),
			true
		),
		method!("gjc/session/tree", Some("GjcSessionTreeParams"), Some("GjcSessionTreeResult"), true),
		method!(
			"gjc/session/navigate",
			Some("GjcSessionNavigateParams"),
			Some("GjcSessionNavigateResult"),
			true
		),
		method!("gjc/session/move", Some("GjcSessionMoveParams"), Some("GjcSessionMoveResult"), true),
		method!(
			"gjc/session/label",
			Some("GjcSessionLabelParams"),
			Some("GjcSessionLabelResult"),
			true
		),
		method!("gjc/tools/list", Some("GjcToolsListParams"), Some("GjcToolsListResult"), true),
		method!(
			"gjc/commands/list",
			Some("GjcCommandsListParams"),
			Some("GjcCommandsListResult"),
			true
		),
		method!("gjc/skills/list", Some("GjcSkillsListParams"), Some("GjcSkillsListResult"), true),
		method!(
			"gjc/skills/setEnabled",
			Some("GjcSkillsSetEnabledParams"),
			Some("GjcSkillsSetEnabledResult"),
			true
		),
		method!(
			"gjc/extensions/list",
			Some("GjcExtensionsListParams"),
			Some("GjcExtensionsListResult"),
			true
		),
		method!(
			"gjc/extensions/inspect",
			Some("GjcExtensionsInspectParams"),
			Some("GjcExtensionsInspectResult"),
			true
		),
		method!(
			"gjc/extensions/setEnabled",
			Some("GjcExtensionsSetEnabledParams"),
			Some("GjcExtensionsSetEnabledResult"),
			true
		),
		method!("gjc/plugins/list", Some("GjcPluginsListParams"), Some("GjcPluginsListResult"), true),
		method!(
			"gjc/plugins/inspect",
			Some("GjcPluginsInspectParams"),
			Some("GjcPluginsInspectResult"),
			true
		),
		method!(
			"gjc/plugins/setEnabled",
			Some("GjcPluginsSetEnabledParams"),
			Some("GjcPluginsSetEnabledResult"),
			true
		),
		method!(
			"gjc/plugins/setFeature",
			Some("GjcPluginsSetFeatureParams"),
			Some("GjcPluginsSetFeatureResult"),
			true
		),
		method!(
			"gjc/plugins/setSetting",
			Some("GjcPluginsSetSettingParams"),
			Some("GjcPluginsSetSettingResult"),
			true
		),
		method!("gjc/messages/get", Some("GjcMessagesGetParams"), Some("GjcMessagesGetResult"), true),
		method!("gjc/model/set", Some("GjcModelSetParams"), Some("GjcModelSetResult"), true),
		method!("gjc/model/assign", Some("GjcModelAssignParams"), Some("GjcModelAssignResult"), true),
		method!("gjc/todos/set", Some("GjcTodosSetParams"), Some("GjcTodosSetResult"), true),
		method!("gjc/compact", Some("GjcCompactParams"), Some("GjcCompactResult"), true),
		method!(
			"gjc/hostTools/set",
			Some("GjcHostToolsSetParams"),
			Some("GjcHostToolsSetResult"),
			true
		),
		method!(
			"gjc/hostTools/result",
			Some("GjcHostToolsResultParams"),
			Some("GjcHostToolsResultResult"),
			true
		),
		method!(
			"gjc/hostTools/update",
			Some("GjcHostToolsUpdateParams"),
			Some("GjcHostToolsUpdateResult"),
			true
		),
		method!(
			"gjc/hostUriSchemes/set",
			Some("HostUriSchemesSetParams"),
			Some("HostUriSchemesSetResult"),
			true
		),
		method!("gjc/hostUris/result", Some("HostUriResultParams"), Some("EmptyResult"), true),
		method!(
			"gjc/workflowGate/list",
			Some("WorkflowGateListParams"),
			Some("WorkflowGateListResult"),
			true
		),
		method!(
			"gjc/workflowGate/respond",
			Some("WorkflowGateRespondParams"),
			Some("RpcWorkflowGateResolution"),
			true
		),
		method!("gjc/unattended/negotiate", Some("UnattendedNegotiateParams"), None::<&str>, false),
		method!("gjc/unattended/audit", None::<&str>, None::<&str>, false),
	];

	serde_json::json!({
		 "$schema": "https://json-schema.org/draft/2020-12/schema",
		 "title": "gjc-app-server wire protocol",
		 "description": "Rust-derived JSON Schema for the codex-compatible app-server wire surface.",
		 "definitions": serde_json::Value::Object(defs),
		 "methodCatalog": method_catalog,
	})
}

/// Canonical, stable serialization used for the committed artifact and the
/// drift check (tab-indented, trailing newline, matching the repo's
/// `stableJson`).
#[must_use]
pub fn schema_bundle_string() -> String {
	let value = schema_bundle();
	format!("{}\n", serde_json::to_string_pretty(&value).expect("schema serializes"))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bundle_has_expected_definitions() {
		let bundle = schema_bundle();
		let defs = bundle["definitions"].as_object().unwrap();
		for key in [
			"Request",
			"Response",
			"Notification",
			"RequestId",
			"AppServerError",
			"ItemState",
			"TurnState",
			"InitializeResult",
			"ThreadResult",
			"TurnStartParams",
			"GjcStateReadParams",
			"GjcToolsListResult",
			"GjcCommandsListResult",
			"GjcHostToolsSetParams",
			"HostToolsCallParams",
			"ServerNotificationEnvelope",
		] {
			assert!(defs.contains_key(key), "missing schema def: {key}");
		}
	}

	#[test]
	fn bundle_is_deterministic() {
		assert_eq!(schema_bundle_string(), schema_bundle_string());
	}

	#[test]
	fn request_schema_describes_method_field() {
		let bundle = schema_bundle();
		let req = &bundle["definitions"]["Request"];
		// schemars emits properties for the Request struct.
		let props = req["properties"]
			.as_object()
			.expect("Request has properties");
		assert!(props.contains_key("method"));
		assert!(props.contains_key("id"));
	}

	#[test]
	fn notification_envelope_serializes_new_wire_methods() {
		let request = crate::protocol::ServerNotificationEnvelope::HostUriRequest(
			crate::host_uris::HostUriRequestParams {
				thread_id: "thread-1".into(),
				generation: 1,
				request_id: "request-1".into(),
				operation: crate::host_uris::HostUriOperation::Read,
				turn_id: "turn-1".into(),
				url: "file:///tmp/a".into(),
				content: None,
			},
		);
		let cancel = crate::protocol::ServerNotificationEnvelope::HostUriCancel(
			crate::host_uris::HostUriCancelParams {
				thread_id: "thread-1".into(),
				generation: 1,
				turn_id: Some("turn-1".into()),
				request_id: "request-1".into(),
			},
		);
		let opened = crate::protocol::ServerNotificationEnvelope::WorkflowGateOpened(Box::new(
			crate::workflow_gate::WorkflowGateOpenedParams {
				thread_id: "thread-1".into(),
				generation: 1,
				gate: crate::workflow_gate::RpcWorkflowGate {
					frame_type: "workflow-gate".into(),
					gate_id: "gate-1".into(),
					stage: crate::workflow_gate::RpcWorkflowStage::Ralplan,
					kind: crate::workflow_gate::RpcWorkflowGateKind::Approval,
					schema: serde_json::json!({ "type": "boolean" }),
					schema_hash: "hash".into(),
					options: None,
					context: crate::workflow_gate::RpcWorkflowGateContext::default(),
					created_at: "2026-07-04T00:00:00Z".into(),
					required: true,
				},
			},
		));
		let jobs_changed = crate::protocol::ServerNotificationEnvelope::JobsChanged(
			crate::protocol::JobsChangedParams {
				thread_id: "thread-1".into(),
				generation: Some(1),
				kind: "job".into(),
				id: "job-1".into(),
				status: "running".into(),
				description: Some("Build".into()),
			},
		);

		for (value, method) in [
			(request, "gjc/hostUris/request"),
			(cancel, "gjc/hostUris/cancel"),
			(opened, "gjc/workflowGate/opened"),
			(jobs_changed, "gjc/jobs/changed"),
		] {
			let serialized = serde_json::to_value(value).unwrap();
			assert_eq!(serialized["method"], method);
			let round_tripped: crate::protocol::ServerNotificationEnvelope =
				serde_json::from_value(serialized).unwrap();
			assert_eq!(serde_json::to_value(round_tripped).unwrap()["method"], method);
		}
	}

	#[test]
	fn method_catalog_matches_dispatch_surface() {
		let bundle = schema_bundle();
		let catalog = bundle["methodCatalog"].as_array().unwrap();
		let expected = [
			("initialize", true),
			("thread/start", true),
			("thread/resume", true),
			("thread/fork", true),
			("thread/delete", true),
			("thread/archive", true),
			("thread/read", true),
			("thread/loaded/list", true),
			("turn/start", true),
			("turn/steer", true),
			("turn/interrupt", true),
			("gjc/retry", true),
			("command/exec", false),
			("thread/shellCommand", false),
			("gjc/state/read", true),
			("gjc/context/read", true),
			("gjc/goal/read", true),
			("gjc/model/catalog", true),
			("gjc/thinking/read", true),
			("gjc/thinking/set", true),
			("gjc/fast/read", true),
			("gjc/fast/set", true),
			("gjc/settings/schema", true),
			("gjc/settings/read", true),
			("gjc/settings/update", true),
			("gjc/appearance/themes/list", true),
			("gjc/appearance/read", true),
			("gjc/appearance/set", true),
			("gjc/provider/list", true),
			("gjc/auth/status", true),
			("gjc/auth/logout", true),
			("gjc/provider/add", true),
			("gjc/auth/login/start", true),
			("gjc/auth/login/poll", true),
			("gjc/auth/login/complete", true),
			("gjc/auth/login/cancel", true),
			("gjc/todos/read", true),
			("gjc/usage/read", true),
			("gjc/jobs/list", true),
			("gjc/agents/list", true),
			("gjc/monitors/list", true),
			("gjc/compact/summary", true),
			("gjc/session/list", true),
			("gjc/session/search", true),
			("gjc/session/rename", true),
			("gjc/session/open", true),
			("gjc/session/delete", true),
			("gjc/session/export", true),
			("gjc/session/tree", true),
			("gjc/session/navigate", true),
			("gjc/session/move", true),
			("gjc/session/label", true),
			("gjc/tools/list", true),
			("gjc/commands/list", true),
			("gjc/skills/list", true),
			("gjc/skills/setEnabled", true),
			("gjc/extensions/list", true),
			("gjc/extensions/inspect", true),
			("gjc/extensions/setEnabled", true),
			("gjc/plugins/list", true),
			("gjc/plugins/inspect", true),
			("gjc/plugins/setEnabled", true),
			("gjc/plugins/setFeature", true),
			("gjc/plugins/setSetting", true),
			("gjc/messages/get", true),
			("gjc/model/set", true),
			("gjc/model/assign", true),
			("gjc/todos/set", true),
			("gjc/compact", true),
			("gjc/hostTools/set", true),
			("gjc/hostTools/result", true),
			("gjc/hostTools/update", true),
			("gjc/hostUriSchemes/set", true),
			("gjc/hostUris/result", true),
			("gjc/workflowGate/list", true),
			("gjc/workflowGate/respond", true),
			("gjc/unattended/negotiate", false),
			("gjc/unattended/audit", false),
		];

		assert_eq!(catalog.len(), expected.len());
		let mut seen = std::collections::BTreeSet::new();
		for (entry, (method, gui_wrapper)) in catalog.iter().zip(expected) {
			assert!(seen.insert(entry["method"].as_str().unwrap()));
			assert_eq!(entry["method"], method);
			assert_eq!(entry["guiWrapper"], gui_wrapper);
		}
	}
}
