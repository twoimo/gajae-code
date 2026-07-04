//! Rust-derived JSON Schema for the app-server wire protocol (Phase 0A gate).
//!
//! The Rust protocol types are the single source of truth. This module emits a
//! JSON Schema bundle for the typed wire surface; the `gjc-app-server-schema`
//! binary writes/checks `schemas/app-server.schema.json`, wired into the repo's
//! `generate-schemas` / `check:schemas` gate so schema drift fails CI.
//!
//! As protocol DTOs are added in later phases (initialize/thread/turn/item
//! payloads), they are added to [`schema_bundle`] and the committed artifact
//! grows with them.

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
	insert_def!("ServerNotificationEnvelope", crate::protocol::ServerNotificationEnvelope);
	insert_def!("RpcWorkflowGate", crate::workflow_gate::RpcWorkflowGate);
	insert_def!("RpcWorkflowGateResponse", crate::workflow_gate::RpcWorkflowGateResponse);
	insert_def!("RpcWorkflowGateResolution", crate::workflow_gate::RpcWorkflowGateResolution);
	insert_def!("RpcWorkflowGateValidationError", crate::workflow_gate::RpcWorkflowGateValidationError);
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

	serde_json::json!({
		 "$schema": "https://json-schema.org/draft/2020-12/schema",
		 "title": "gjc-app-server wire protocol",
		 "description": "Rust-derived JSON Schema for the codex-compatible app-server wire surface.",
		 "definitions": serde_json::Value::Object(defs),
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
}
