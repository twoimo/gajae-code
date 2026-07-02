//! Error types and JSON-RPC error codes for the app-server.

use serde::{Deserialize, Serialize};

/// Standard JSON-RPC 2.0 error codes plus the app-server overload code.
pub mod codes {
	/// Invalid JSON was received by the server.
	pub const PARSE_ERROR: i32 = -32700;
	/// The JSON sent is not a valid Request object.
	pub const INVALID_REQUEST: i32 = -32600;
	/// The method does not exist / is not available.
	pub const METHOD_NOT_FOUND: i32 = -32601;
	/// Invalid method parameter(s). Used for gjc/* strict unknown-field
	/// rejection and for codex-core required-field / type errors.
	pub const INVALID_PARAMS: i32 = -32602;
	/// Internal JSON-RPC error.
	pub const INTERNAL_ERROR: i32 = -32603;
	/// App-server backpressure: request ingress is saturated. Clients should
	/// retry with exponential backoff + jitter. Mirrors codex app-server.
	pub const SERVER_OVERLOADED: i32 = -32001;
	/// The connection has not completed the `initialize`/`initialized`
	/// handshake yet.
	pub const NOT_INITIALIZED: i32 = -32002;
	/// A referenced thread or turn does not exist.
	pub const NOT_FOUND: i32 = -32003;
	/// A request conflicts with current state (e.g. `expectedTurnId` mismatch,
	/// archive with an active turn).
	pub const CONFLICT: i32 = -32004;
}

/// A structured error that maps directly onto a JSON-RPC error object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AppServerError {
	pub code: i32,
	pub message: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub data: Option<serde_json::Value>,
}

impl AppServerError {
	#[must_use]
	pub fn new(code: i32, message: impl Into<String>) -> Self {
		Self { code, message: message.into(), data: None }
	}

	#[must_use]
	pub fn with_data(mut self, data: serde_json::Value) -> Self {
		self.data = Some(data);
		self
	}

	#[must_use]
	pub fn overloaded() -> Self {
		Self::new(codes::SERVER_OVERLOADED, "Server overloaded; retry later.")
	}

	#[must_use]
	pub fn not_initialized() -> Self {
		Self::new(codes::NOT_INITIALIZED, "Not initialized")
	}

	#[must_use]
	pub fn method_not_found(method: &str) -> Self {
		Self::new(codes::METHOD_NOT_FOUND, format!("Method not found: {method}"))
	}

	#[must_use]
	pub fn invalid_params(message: impl Into<String>) -> Self {
		Self::new(codes::INVALID_PARAMS, message)
	}

	#[must_use]
	pub fn not_found(message: impl Into<String>) -> Self {
		Self::new(codes::NOT_FOUND, message)
	}

	#[must_use]
	pub fn conflict(message: impl Into<String>) -> Self {
		Self::new(codes::CONFLICT, message)
	}
}

impl std::fmt::Display for AppServerError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "app-server error {}: {}", self.code, self.message)
	}
}

impl std::error::Error for AppServerError {}

pub type Result<T> = std::result::Result<T, AppServerError>;

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn overloaded_uses_codex_code_and_message() {
		let e = AppServerError::overloaded();
		assert_eq!(e.code, codes::SERVER_OVERLOADED);
		assert_eq!(e.message, "Server overloaded; retry later.");
	}

	#[test]
	fn serializes_without_data_when_absent() {
		let e = AppServerError::invalid_params("bad");
		let json = serde_json::to_value(&e).unwrap();
		assert_eq!(json, serde_json::json!({"code": -32602, "message": "bad"}));
	}
}
