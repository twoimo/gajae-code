//! Helpers for the token-free `gjc/notifications/*` app-server channel.
//!
//! Notification frames are opaque JSON owned by the TypeScript notifications
//! extension. The Rust core only routes inbound calls to the host and wraps
//! outbound frames as JSON-RPC notifications.

use crate::jsonrpc::Notification;

use async_trait::async_trait;

use crate::error::{AppServerError, Result};

pub const METHOD_PREFIX: &str = "gjc/notifications/";
pub const EVENT_METHOD: &str = "gjc/notifications/event";
pub const CALL_KIND_PREFIX: &str = "notifications.";
pub const SUBSCRIBE_METHOD: &str = "gjc/notifications/subscribe";

#[must_use]
pub fn is_notifications_method(method: &str) -> bool {
	method.starts_with(METHOD_PREFIX)
}

#[must_use]
pub fn call_kind(method: &str) -> Option<String> {
	method
		.strip_prefix(METHOD_PREFIX)
		.map(|suffix| format!("{CALL_KIND_PREFIX}{suffix}"))
}

#[must_use]
pub fn event(frame: serde_json::Value) -> Notification {
	Notification { method: EVENT_METHOD.to_string(), params: Some(frame) }
}

#[async_trait]
pub trait NotificationHost: Send + Sync {
	async fn notification_call(
		&self,
		kind: &str,
		params: serde_json::Value,
	) -> Result<serde_json::Value>;
}

pub struct NoopNotificationHost;

#[async_trait]
impl NotificationHost for NoopNotificationHost {
	async fn notification_call(
		&self,
		kind: &str,
		_params: serde_json::Value,
	) -> Result<serde_json::Value> {
		Err(AppServerError::method_not_found(kind))
	}
}
