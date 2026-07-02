use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{
	error::{AppServerError, Result},
	ids::{ThreadId, TurnId},
};

#[derive(Debug, Clone, PartialEq)]
pub struct HostToolDescriptor {
	pub name:            String,
	pub description:     String,
	pub input_schema:    Value,
	pub result_policy:   Option<Value>,
	pub redaction_hints: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HostToolResult {
	pub ok:     bool,
	pub result: Option<Value>,
	pub error:  Option<Value>,
}

pub struct PendingHostToolCall {
	pub thread_id:  ThreadId,
	pub generation: crate::ids::BackendGeneration,
	pub turn_id:    TurnId,
	pub tool:       String,
	pub progress:   Arc<Mutex<Vec<Value>>>,
	pub tx:         oneshot::Sender<HostToolResult>,
}

#[derive(Default)]
pub struct HostToolRegistry {
	descriptors: HashMap<String, HostToolDescriptor>,
}

impl HostToolRegistry {
	pub fn replace(&mut self, descriptors: Vec<HostToolDescriptor>) {
		self.descriptors = descriptors
			.into_iter()
			.map(|descriptor| (descriptor.name.clone(), descriptor))
			.collect();
	}

	pub fn contains(&self, name: &str) -> bool {
		self.descriptors.contains_key(name)
	}

	pub fn names(&self) -> Vec<String> {
		let mut names = self.descriptors.keys().cloned().collect::<Vec<_>>();
		names.sort();
		names
	}
}

pub fn parse_set_params(
	method: &str,
	params: Option<&Value>,
) -> Result<(ThreadId, Vec<HostToolDescriptor>)> {
	crate::field_policy::enforce(method, params, &["threadId", "tools"])?;
	let obj = params
		.and_then(Value::as_object)
		.ok_or_else(|| AppServerError::invalid_params("params must be an object"))?;
	let thread_id = obj
		.get("threadId")
		.and_then(Value::as_str)
		.map(|s| ThreadId(s.to_string()))
		.ok_or_else(|| AppServerError::invalid_params("missing threadId"))?;
	let tools = obj
		.get("tools")
		.and_then(Value::as_array)
		.ok_or_else(|| AppServerError::invalid_params("tools must be an array"))?;
	let mut names = HashSet::new();
	let mut descriptors = Vec::with_capacity(tools.len());
	for tool in tools {
		let tool_obj = tool
			.as_object()
			.ok_or_else(|| AppServerError::invalid_params("tool descriptor must be an object"))?;
		for key in tool_obj.keys() {
			if !matches!(
				key.as_str(),
				"name" | "description" | "inputSchema" | "resultPolicy" | "redactionHints"
			) {
				return Err(AppServerError::invalid_params(format!("unknown field: {key}")));
			}
		}
		let name = tool_obj
			.get("name")
			.and_then(Value::as_str)
			.filter(|s| !s.is_empty())
			.map(ToOwned::to_owned)
			.ok_or_else(|| AppServerError::invalid_params("tool.name must be a non-empty string"))?;
		if !names.insert(name.clone()) {
			return Err(AppServerError::invalid_params(format!("duplicate tool: {name}")));
		}
		let description = tool_obj
			.get("description")
			.and_then(Value::as_str)
			.map(ToOwned::to_owned)
			.ok_or_else(|| AppServerError::invalid_params("tool.description must be a string"))?;
		let input_schema = tool_obj
			.get("inputSchema")
			.cloned()
			.ok_or_else(|| AppServerError::invalid_params("tool.inputSchema is required"))?;
		if !input_schema.is_object() {
			return Err(AppServerError::invalid_params("tool.inputSchema must be an object"));
		}
		descriptors.push(HostToolDescriptor {
			name,
			description,
			input_schema,
			result_policy: tool_obj.get("resultPolicy").cloned(),
			redaction_hints: tool_obj.get("redactionHints").cloned(),
		});
	}
	Ok((thread_id, descriptors))
}

pub fn parse_result_params(
	method: &str,
	params: Option<&Value>,
) -> Result<(ThreadId, String, HostToolResult)> {
	crate::field_policy::enforce(method, params, &["threadId", "callId", "ok", "result", "error"])?;
	let obj = params
		.and_then(Value::as_object)
		.ok_or_else(|| AppServerError::invalid_params("params must be an object"))?;
	let thread_id = obj
		.get("threadId")
		.and_then(Value::as_str)
		.map(|s| ThreadId(s.to_string()))
		.ok_or_else(|| AppServerError::invalid_params("missing threadId"))?;
	let call_id = obj
		.get("callId")
		.and_then(Value::as_str)
		.filter(|s| !s.is_empty())
		.map(ToOwned::to_owned)
		.ok_or_else(|| AppServerError::invalid_params("callId must be a non-empty string"))?;
	let ok = obj
		.get("ok")
		.and_then(Value::as_bool)
		.ok_or_else(|| AppServerError::invalid_params("ok must be a boolean"))?;
	let has_result = obj.contains_key("result");
	let has_error = obj.contains_key("error");
	if ok {
		if !has_result {
			return Err(AppServerError::invalid_params("ok:true requires result"));
		}
		if has_error {
			return Err(AppServerError::invalid_params("ok:true forbids error"));
		}
	} else {
		if has_result {
			return Err(AppServerError::invalid_params("ok:false forbids result"));
		}
		let error = obj
			.get("error")
			.and_then(Value::as_object)
			.ok_or_else(|| AppServerError::invalid_params("ok:false requires error object"))?;
		if !error.get("message").is_some_and(Value::is_string) {
			return Err(AppServerError::invalid_params("error.message must be a string"));
		}
	}
	Ok((thread_id, call_id, HostToolResult {
		ok,
		result: obj.get("result").cloned(),
		error: obj.get("error").cloned(),
	}))
}

pub fn parse_update_params(
	method: &str,
	params: Option<&Value>,
) -> Result<(ThreadId, String, Value)> {
	crate::field_policy::enforce(method, params, &["threadId", "callId", "payload"])?;
	let obj = params
		.and_then(Value::as_object)
		.ok_or_else(|| AppServerError::invalid_params("params must be an object"))?;
	let thread_id = obj
		.get("threadId")
		.and_then(Value::as_str)
		.map(|s| ThreadId(s.to_string()))
		.ok_or_else(|| AppServerError::invalid_params("missing threadId"))?;
	let call_id = obj
		.get("callId")
		.and_then(Value::as_str)
		.filter(|s| !s.is_empty())
		.map(ToOwned::to_owned)
		.ok_or_else(|| AppServerError::invalid_params("callId must be a non-empty string"))?;
	let payload = obj
		.get("payload")
		.cloned()
		.ok_or_else(|| AppServerError::invalid_params("missing payload"))?;
	Ok((thread_id, call_id, payload))
}
