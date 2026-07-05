use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::{
	error::{AppServerError, Result},
	ids::{BackendGeneration, ThreadId, TurnId},
};

const RESERVED_SCHEMES: &[&str] =
	&["gjc", "agent", "artifact", "memory", "local", "rule", "issue", "pr"];
const VALID_CONTENT_TYPES: &[&str] = &["text/markdown", "application/json", "text/plain"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct HostUriSchemeDefinition {
	pub scheme: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
	#[serde(default)]
	pub writable: bool,
	#[serde(default)]
	pub immutable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct HostUriSchemesSetParams {
	#[serde(rename = "threadId")]
	pub thread_id: String,
	pub schemes: Vec<HostUriSchemeDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct HostUriSchemesSetResult {
	pub schemes: Vec<HostUriSchemeDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HostUriOperation {
	Read,
	Write,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct HostUriRequestParams {
	#[serde(rename = "threadId")]
	pub thread_id: String,
	pub generation: u64,
	#[serde(rename = "turnId")]
	pub turn_id: String,
	#[serde(rename = "requestId")]
	pub request_id: String,
	pub operation: HostUriOperation,
	pub url: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct HostUriCancelParams {
	#[serde(rename = "threadId")]
	pub thread_id: String,
	pub generation: u64,
	#[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
	pub turn_id: Option<String>,
	#[serde(rename = "requestId")]
	pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct HostUriResultParams {
	#[serde(rename = "threadId")]
	pub thread_id: String,
	#[serde(rename = "requestId")]
	pub request_id: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub content: Option<String>,
	#[serde(rename = "contentType", skip_serializing_if = "Option::is_none")]
	pub content_type: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub notes: Option<Vec<String>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub immutable: Option<bool>,
	#[serde(rename = "isError", default)]
	pub is_error: bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct HostUriResource {
	pub url: String,
	pub content: String,
	#[serde(rename = "contentType")]
	pub content_type: String,
	pub size: usize,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub notes: Option<Vec<String>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub immutable: Option<bool>,
}

pub struct PendingHostUriRequest {
	pub thread_id: ThreadId,
	pub generation: BackendGeneration,
	pub turn_id: TurnId,
	pub tx: oneshot::Sender<HostUriResultParams>,
}

#[derive(Default)]
pub struct HostUriRegistry {
	definitions: HashMap<String, HostUriSchemeDefinition>,
}

impl HostUriRegistry {
	pub fn replace(&mut self, definitions: Vec<HostUriSchemeDefinition>) {
		self.definitions = definitions
			.into_iter()
			.map(|d| (d.scheme.clone(), d))
			.collect();
	}

	pub fn definitions(&self) -> Vec<HostUriSchemeDefinition> {
		let mut defs = self.definitions.values().cloned().collect::<Vec<_>>();
		defs.sort_by(|a, b| a.scheme.cmp(&b.scheme));
		defs
	}

	pub fn get(&self, scheme: &str) -> Option<HostUriSchemeDefinition> {
		self.definitions.get(scheme).cloned()
	}
}

pub fn parse_set_params(
	method: &str,
	params: Option<&serde_json::Value>,
) -> Result<(ThreadId, Vec<HostUriSchemeDefinition>)> {
	crate::field_policy::enforce(method, params, &["threadId", "schemes"])?;
	let parsed: HostUriSchemesSetParams =
		serde_json::from_value(params.cloned().unwrap_or_default())
			.map_err(|err| AppServerError::invalid_params(err.to_string()))?;
	let mut seen = HashSet::new();
	let mut definitions = Vec::with_capacity(parsed.schemes.len());
	for raw in parsed.schemes {
		let scheme = raw.scheme.trim().to_ascii_lowercase();
		if scheme.is_empty() {
			return Err(AppServerError::invalid_params("Host URI scheme must be a non-empty string"));
		}
		if !is_valid_scheme(&scheme) {
			return Err(AppServerError::invalid_params(format!(
				"Host URI scheme contains invalid characters: {}",
				raw.scheme
			)));
		}
		if RESERVED_SCHEMES.contains(&scheme.as_str()) {
			return Err(AppServerError::invalid_params(format!(
				"Host URI scheme is reserved: {scheme}"
			)));
		}
		if !seen.insert(scheme.clone()) {
			return Err(AppServerError::invalid_params(format!(
				"duplicate Host URI scheme: {scheme}"
			)));
		}
		definitions.push(HostUriSchemeDefinition {
			scheme,
			description: raw.description.filter(|s| !s.is_empty()),
			writable: raw.writable,
			immutable: raw.immutable,
		});
	}
	Ok((ThreadId(parsed.thread_id), definitions))
}

pub fn parse_result_params(
	method: &str,
	params: Option<&serde_json::Value>,
) -> Result<(ThreadId, String, HostUriResultParams)> {
	crate::field_policy::enforce(
		method,
		params,
		&[
			"threadId",
			"requestId",
			"content",
			"contentType",
			"notes",
			"immutable",
			"isError",
			"error",
		],
	)?;
	let parsed: HostUriResultParams = serde_json::from_value(params.cloned().unwrap_or_default())
		.map_err(|err| AppServerError::invalid_params(err.to_string()))?;
	if parsed.request_id.trim().is_empty() {
		return Err(AppServerError::invalid_params("requestId must be a non-empty string"));
	}
	if let Some(content_type) = parsed.content_type.as_deref()
		&& !VALID_CONTENT_TYPES.contains(&content_type)
	{
		return Err(AppServerError::invalid_params(format!("invalid contentType: {content_type}")));
	}
	if parsed.is_error {
		if parsed.error.as_deref().unwrap_or("").is_empty()
			&& parsed.content.as_deref().unwrap_or("").is_empty()
		{
			return Err(AppServerError::invalid_params("isError requires error or content"));
		}
	} else if parsed.error.is_some() {
		return Err(AppServerError::invalid_params("error requires isError:true"));
	}
	Ok((ThreadId(parsed.thread_id.clone()), parsed.request_id.clone(), parsed))
}

pub fn resource_from_result(
	url: &str,
	definition: &HostUriSchemeDefinition,
	result: HostUriResultParams,
) -> Result<HostUriResource> {
	if result.is_error {
		return Err(AppServerError::new(
			crate::error::codes::INTERNAL_ERROR,
			result
				.error
				.or(result.content)
				.unwrap_or_else(|| format!("Host URI read failed for {url}")),
		));
	}
	let content = result.content.unwrap_or_default();
	let size = content.len();
	Ok(HostUriResource {
		url: url.to_string(),
		content,
		content_type: result
			.content_type
			.unwrap_or_else(|| "text/plain".to_string()),
		size,
		notes: result.notes.filter(|notes| !notes.is_empty()),
		immutable: Some(result.immutable.unwrap_or(definition.immutable)),
	})
}

fn is_valid_scheme(scheme: &str) -> bool {
	let mut chars = scheme.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	first.is_ascii_lowercase()
		&& chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'))
}

pub type PendingHostUriMap = Arc<Mutex<Vec<String>>>;
