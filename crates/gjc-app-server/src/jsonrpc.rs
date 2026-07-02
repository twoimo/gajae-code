//! JSON-RPC 2.0 envelopes, with the `"jsonrpc":"2.0"` header omitted on the
//! wire to match codex app-server framing.
//!
//! A single inbound line is either a [`Request`] (has `id` + `method`) or a
//! client notification (has `method`, no `id`). Outbound frames are a
//! [`Response`] (has `id` + `result`/`error`) or a server [`Notification`]
//! (has `method`, no `id`). The `RequestId` is opaque: JSON-RPC permits string
//! or number ids, so we preserve the raw value.

use serde::{Deserialize, Serialize};

/// Opaque JSON-RPC request id (string or number), preserved verbatim so
/// responses echo the exact client id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
	Number(i64),
	String(String),
}

/// An inbound request: `{ "id", "method", "params"? }`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Request {
	pub id:     RequestId,
	pub method: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub params: Option<serde_json::Value>,
}

/// An inbound client notification (no id): `{ "method", "params"? }`.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ClientNotification {
	pub method: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub params: Option<serde_json::Value>,
}

/// An outbound server notification (no id).
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Notification {
	pub method: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub params: Option<serde_json::Value>,
}

impl Notification {
	#[must_use]
	pub fn new(method: impl Into<String>, params: serde_json::Value) -> Self {
		Self { method: method.into(), params: Some(params) }
	}
}

/// An outbound response: exactly one of `result`/`error` is present.
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct Response {
	pub id:     RequestId,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result: Option<serde_json::Value>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error:  Option<crate::error::AppServerError>,
}

impl Response {
	#[must_use]
	pub const fn ok(id: RequestId, result: serde_json::Value) -> Self {
		Self { id, result: Some(result), error: None }
	}

	#[must_use]
	pub const fn err(id: RequestId, error: crate::error::AppServerError) -> Self {
		Self { id, result: None, error: Some(error) }
	}
}

/// A single parsed inbound frame.
#[derive(Debug, Clone)]
pub enum Inbound {
	Request(Request),
	Notification(ClientNotification),
}

/// Parse one newline-delimited JSON frame into a request or notification.
/// Presence of `id` distinguishes a request from a notification.
pub fn parse_inbound(line: &str) -> crate::error::Result<Inbound> {
	let value: serde_json::Value = serde_json::from_str(line).map_err(|e| {
		crate::error::AppServerError::new(crate::error::codes::PARSE_ERROR, e.to_string())
	})?;
	let obj = value.as_object().ok_or_else(|| {
		crate::error::AppServerError::new(
			crate::error::codes::INVALID_REQUEST,
			"frame is not an object",
		)
	})?;
	if obj.contains_key("id") {
		let req: Request = serde_json::from_value(value).map_err(|e| {
			crate::error::AppServerError::new(crate::error::codes::INVALID_REQUEST, e.to_string())
		})?;
		Ok(Inbound::Request(req))
	} else {
		let note: ClientNotification = serde_json::from_value(value).map_err(|e| {
			crate::error::AppServerError::new(crate::error::codes::INVALID_REQUEST, e.to_string())
		})?;
		Ok(Inbound::Notification(note))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_request_with_numeric_id() {
		let f = parse_inbound(r#"{"id":0,"method":"initialize","params":{}}"#).unwrap();
		match f {
			Inbound::Request(r) => {
				assert_eq!(r.id, RequestId::Number(0));
				assert_eq!(r.method, "initialize");
			},
			Inbound::Notification(_) => panic!("expected request"),
		}
	}

	#[test]
	fn parses_notification_without_id() {
		let f = parse_inbound(r#"{"method":"initialized"}"#).unwrap();
		assert!(matches!(f, Inbound::Notification(n) if n.method == "initialized"));
	}

	#[test]
	fn response_omits_jsonrpc_header_and_null_fields() {
		let r = Response::ok(RequestId::Number(1), serde_json::json!({"ok": true}));
		let json = serde_json::to_value(&r).unwrap();
		assert_eq!(json, serde_json::json!({"id": 1, "result": {"ok": true}}));
		assert!(json.get("jsonrpc").is_none());
		assert!(json.get("error").is_none());
	}

	#[test]
	fn invalid_json_is_parse_error() {
		let e = parse_inbound("{not json").unwrap_err();
		assert_eq!(e.code, crate::error::codes::PARSE_ERROR);
	}
}
