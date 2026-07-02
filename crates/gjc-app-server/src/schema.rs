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
    defs.insert("Request".into(), def::<crate::jsonrpc::Request>());
    defs.insert("Response".into(), def::<crate::jsonrpc::Response>());
    defs.insert("Notification".into(), def::<crate::jsonrpc::Notification>());
    defs.insert("ClientNotification".into(), def::<crate::jsonrpc::ClientNotification>());
    defs.insert("RequestId".into(), def::<crate::jsonrpc::RequestId>());
    defs.insert("AppServerError".into(), def::<crate::error::AppServerError>());
    defs.insert("ThreadIdentity".into(), def::<crate::identity::ThreadIdentity>());
    defs.insert("ThreadStatus".into(), def::<crate::identity::ThreadStatus>());
    defs.insert("SessionMetadata".into(), def::<crate::identity::SessionMetadata>());
    defs.insert("ItemState".into(), def::<crate::item_state::ItemState>());
    defs.insert("TurnState".into(), def::<crate::item_state::TurnState>());
    defs.insert("TerminalCause".into(), def::<crate::item_state::TerminalCause>());

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
        for key in ["Request", "Response", "Notification", "RequestId", "AppServerError", "ItemState", "TurnState"] {
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
        let props = req["properties"].as_object().expect("Request has properties");
        assert!(props.contains_key("method"));
        assert!(props.contains_key("id"));
    }
}
