//! Workflow-gate broker for the app-server wire surface.

use std::{
	collections::{BTreeMap, HashMap},
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
	error::{AppServerError, Result, codes},
	ids::ThreadId,
};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RpcWorkflowStage {
	#[serde(rename = "deep-interview")]
	DeepInterview,
	Ralplan,
	Ultragoal,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RpcWorkflowGateKind {
	Question,
	Approval,
	Execution,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcWorkflowGateOption {
	pub value:       Value,
	pub label:       String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, schemars::JsonSchema)]
pub struct RpcWorkflowGateContext {
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:         Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub plan:          Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub source:        Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt:        Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub summary:       Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub stage_state:   Option<BTreeMap<String, Value>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub artifact_refs: Option<Vec<BTreeMap<String, Value>>>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub language:      Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcWorkflowGate {
	#[serde(rename = "type")]
	pub frame_type:  String,
	pub gate_id:     String,
	pub stage:       RpcWorkflowStage,
	pub kind:        RpcWorkflowGateKind,
	pub schema:      Value,
	pub schema_hash: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub options:     Option<Vec<RpcWorkflowGateOption>>,
	pub context:     RpcWorkflowGateContext,
	pub created_at:  String,
	pub required:    bool,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct OpenWorkflowGateInput {
	pub stage:   RpcWorkflowStage,
	pub kind:    RpcWorkflowGateKind,
	pub schema:  Value,
	#[serde(default)]
	pub options: Option<Vec<RpcWorkflowGateOption>>,
	#[serde(default)]
	pub context: RpcWorkflowGateContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcWorkflowGateResponse {
	pub gate_id:         String,
	pub answer:          Value,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcWorkflowGateResolution {
	pub gate_id:     String,
	pub status:      String,
	pub answer_hash: String,
	pub resolved_at: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error:       Option<RpcWorkflowGateValidationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcWorkflowGateValidationError {
	pub code:        String,
	pub gate_id:     String,
	pub schema_hash: String,
	pub errors:      Vec<SchemaValidationIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct SchemaValidationIssue {
	pub path:     String,
	pub keyword:  String,
	pub message:  String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub expected: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct WorkflowGateListParams {
	#[serde(rename = "threadId")]
	pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct WorkflowGateListResult {
	pub gates: Vec<RpcWorkflowGate>,
}

#[derive(Debug, Clone, Deserialize, schemars::JsonSchema)]
pub struct WorkflowGateRespondParams {
	#[serde(rename = "threadId")]
	pub thread_id:       String,
	pub gate_id:         String,
	pub answer:          Value,
	#[serde(default)]
	pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct WorkflowGateOpenedParams {
	#[serde(rename = "threadId")]
	pub thread_id:  String,
	pub generation: u64,
	#[serde(flatten)]
	pub gate:       RpcWorkflowGate,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct BrokerErrorData {
	pub code:    String,
	pub gate_id: String,
}

#[derive(Clone, Default)]
pub struct WorkflowGateBroker {
	inner: Arc<Mutex<WorkflowGateState>>,
}

#[derive(Default)]
struct WorkflowGateState {
	seq:     HashMap<String, u64>,
	records: HashMap<String, GateRecord>,
	audit:   Vec<Value>,
}

struct GateRecord {
	gate:            RpcWorkflowGate,
	status:          GateStatus,
	idempotency_key: Option<String>,
	response_hash:   Option<String>,
	resolution:      Option<RpcWorkflowGateResolution>,
	answer:          Option<Value>,
	advanced:        bool,
	tx:              Option<tokio::sync::oneshot::Sender<Value>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum GateStatus {
	Pending,
	Accepted,
}

impl WorkflowGateBroker {
	pub fn open(
		&self,
		thread_id: &ThreadId,
		input: OpenWorkflowGateInput,
	) -> Result<(RpcWorkflowGate, tokio::sync::oneshot::Receiver<Value>)> {
		assert_supported_schema(&input.schema)?;
		let mut state = self.inner.lock();
		let stage = serde_json::to_string(&input.stage)
			.unwrap_or_else(|_| "\"workflow\"".to_string())
			.trim_matches('"')
			.to_string();
		let seq = state
			.seq
			.entry(stage.clone())
			.and_modify(|n| *n += 1)
			.or_insert(1);
		let short = run_short(&thread_id.0);
		let gate_id = format!("wg_{short}_{stage}_{:06}", *seq);
		let gate = RpcWorkflowGate {
			frame_type:  "workflow_gate".to_string(),
			gate_id:     gate_id.clone(),
			stage:       input.stage,
			kind:        input.kind,
			schema_hash: sha256_hex(canonical_json(&input.schema).as_bytes()),
			schema:      input.schema,
			options:     input.options,
			context:     input.context,
			created_at:  now_string(),
			required:    true,
		};
		let (tx, rx) = tokio::sync::oneshot::channel();
		state.records.insert(gate_id.clone(), GateRecord {
			gate:            gate.clone(),
			status:          GateStatus::Pending,
			idempotency_key: None,
			response_hash:   None,
			resolution:      None,
			answer:          None,
			advanced:        false,
			tx:              Some(tx),
		});
		state.audit.push(
			serde_json::json!({"event":"gate_emitted","gate_id":gate_id,"stage":stage,"kind":gate.kind}),
		);
		Ok((gate, rx))
	}

	pub fn list_pending(&self) -> Vec<RpcWorkflowGate> {
		self
			.inner
			.lock()
			.records
			.values()
			.filter(|r| r.status == GateStatus::Pending)
			.map(|r| r.gate.clone())
			.collect()
	}

	pub fn resolve(&self, response: RpcWorkflowGateResponse) -> Result<RpcWorkflowGateResolution> {
		let mut state = self.inner.lock();
		let Some(record) = state.records.get_mut(&response.gate_id) else {
			state.audit.push(
				serde_json::json!({"event":"gate_response_unknown_gate","gate_id":response.gate_id}),
			);
			return Err(broker_error("unknown_gate", &response.gate_id));
		};
		let response_hash = sha256_hex(
			canonical_json(
				&serde_json::json!({"gate_id": response.gate_id, "answer": response.answer}),
			)
			.as_bytes(),
		);
		if record.status == GateStatus::Accepted {
			let same_key = record.idempotency_key == response.idempotency_key;
			let same_body = record.response_hash.as_deref() == Some(response_hash.as_str());
			if response.idempotency_key.is_some() && same_key && same_body {
				let resolution = record
					.resolution
					.clone()
					.expect("accepted gate has resolution");
				state.audit.push(
					serde_json::json!({"event":"gate_response_idempotent_replay","gate_id":response.gate_id}),
				);
				return Ok(resolution);
			}
			let code = if response.idempotency_key.is_some() && same_key {
				"idempotency_conflict"
			} else {
				"already_resolved"
			};
			state.audit.push(
				serde_json::json!({"event":format!("gate_response_{code}"),"gate_id":response.gate_id}),
			);
			return Err(broker_error(code, &response.gate_id));
		}
		let answer_hash = sha256_hex(canonical_json(&response.answer).as_bytes());
		let schema_hash = record.gate.schema_hash.clone();
		let errors = validate_value(&record.gate.schema, &response.answer, "#");
		if !errors.is_empty() {
			let resolution = RpcWorkflowGateResolution {
				gate_id:     response.gate_id.clone(),
				status:      "rejected".to_string(),
				answer_hash: answer_hash.clone(),
				resolved_at: now_string(),
				error:       Some(RpcWorkflowGateValidationError {
					code: "invalid_workflow_gate_answer".to_string(),
					gate_id: response.gate_id.clone(),
					schema_hash,
					errors,
				}),
			};
			state.audit.push(serde_json::json!({"event":"gate_response_rejected","gate_id":response.gate_id,"answer_hash":answer_hash}));
			return Ok(resolution);
		}
		let resolution = RpcWorkflowGateResolution {
			gate_id:     response.gate_id.clone(),
			status:      "accepted".to_string(),
			answer_hash: answer_hash.clone(),
			resolved_at: now_string(),
			error:       None,
		};
		record.status = GateStatus::Accepted;
		record.idempotency_key = response.idempotency_key;
		record.response_hash = Some(response_hash);
		record.answer = Some(response.answer.clone());
		record.resolution = Some(resolution.clone());
		record.advanced = true;
		if let Some(tx) = record.tx.take() {
			let _ = tx.send(response.answer);
		}
		state.audit.push(serde_json::json!({"event":"gate_response_accepted","gate_id":response.gate_id,"answer_hash":answer_hash}));
		Ok(resolution)
	}

	pub fn reject_pending_for_unattended_abort(&self, run_id: &str) {
		let mut state = self.inner.lock();
		let pending = state
			.records
			.iter()
			.filter(|(_, r)| r.status == GateStatus::Pending)
			.map(|(id, _)| id.clone())
			.collect::<Vec<_>>();
		for gate_id in pending {
			if let Some(record) = state.records.get_mut(&gate_id) {
				if let Some(tx) = record.tx.take() {
					let _ = tx.send(serde_json::json!({
						"code": "budget_exceeded",
						"run_id": run_id,
						"gate_id": gate_id,
					}));
				}
				state.audit.push(serde_json::json!({"event":"gate_rejected_by_unattended_abort","gate_id":gate_id,"run_id":run_id}));
			}
		}
	}

	pub fn recover(&self) -> Vec<String> {
		let mut state = self.inner.lock();
		let mut recovered = Vec::new();
		let ids: Vec<String> = state
			.records
			.iter()
			.filter(|(_, r)| r.status == GateStatus::Accepted && !r.advanced)
			.map(|(id, _)| id.clone())
			.collect();
		for id in ids {
			if let Some(record) = state.records.get_mut(&id) {
				record.advanced = true;
				recovered.push(id.clone());
				state
					.audit
					.push(serde_json::json!({"event":"gate_advance_recovered","gate_id":id}));
			}
		}
		recovered
	}
}

fn broker_error(code: &str, gate_id: &str) -> AppServerError {
	let status = match code {
		"unknown_gate" => codes::NOT_FOUND,
		_ => codes::CONFLICT,
	};
	AppServerError::new(status, code).with_data(serde_json::json!(BrokerErrorData {
		code:    code.to_string(),
		gate_id: gate_id.to_string(),
	}))
}

fn run_short(input: &str) -> String {
	let s: String = input
		.chars()
		.filter(|c| c.is_ascii_alphanumeric())
		.collect();
	let tail: String = s.chars().rev().take(8).collect();
	let out: String = tail.chars().rev().collect();
	if out.is_empty() {
		"run".to_string()
	} else {
		out
	}
}

fn now_string() -> String {
	format!(
		"{}",
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis()
	)
}

fn sha256_hex(bytes: &[u8]) -> String {
	let mut hasher = Sha256::new();
	hasher.update(bytes);
	format!("{:x}", hasher.finalize())
}

fn canonical_json(value: &Value) -> String {
	match value {
		Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
			serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
		},
		Value::Array(items) => format!(
			"[{}]",
			items
				.iter()
				.map(canonical_json)
				.collect::<Vec<_>>()
				.join(",")
		),
		Value::Object(map) => {
			let mut pairs = map.iter().collect::<Vec<_>>();
			pairs.sort_by(|a, b| a.0.cmp(b.0));
			format!(
				"{{{}}}",
				pairs
					.into_iter()
					.map(|(k, v)| format!(
						"{}:{}",
						serde_json::to_string(k).unwrap_or_default(),
						canonical_json(v)
					))
					.collect::<Vec<_>>()
					.join(",")
			)
		},
	}
}

fn assert_supported_schema(schema: &Value) -> Result<()> {
	walk_schema(schema, 0, "#")
}

#[allow(
	clippy::collapsible_if,
	reason = "schema validator branches mirror the legacy TypeScript implementation"
)]
fn walk_schema(schema: &Value, depth: usize, path: &str) -> Result<()> {
	if depth > 16 {
		return Err(AppServerError::invalid_params(format!(
			"schema nesting exceeds depth 16 at {path}"
		)));
	}
	let Some(obj) = schema.as_object() else {
		return Err(AppServerError::invalid_params(format!(
			"schema node at {path} must be an object"
		)));
	};
	let supported = [
		"type",
		"enum",
		"const",
		"properties",
		"required",
		"additionalProperties",
		"items",
		"minLength",
		"maxLength",
		"minItems",
		"maxItems",
		"uniqueItems",
		"minimum",
		"maximum",
		"title",
		"description",
		"oneOf",
		"anyOf",
	];
	for key in obj.keys() {
		if !supported.contains(&key.as_str()) {
			return Err(AppServerError::invalid_params(format!(
				"unsupported keyword \"{key}\" at {path}"
			)));
		}
	}
	if let Some(Value::String(t)) = obj.get("type") {
		if !["string", "number", "integer", "boolean", "object", "array", "null"]
			.contains(&t.as_str())
		{
			return Err(AppServerError::invalid_params(format!("unsupported type \"{t}\" at {path}")));
		}
	}
	if let Some(props) = obj.get("properties") {
		let Some(props) = props.as_object() else {
			return Err(AppServerError::invalid_params(format!(
				"properties at {path} must be an object"
			)));
		};
		for (k, v) in props {
			walk_schema(v, depth + 1, &format!("{path}/properties/{k}"))?;
		}
	}
	if let Some(ap) = obj.get("additionalProperties") {
		if !ap.is_boolean() {
			walk_schema(ap, depth + 1, &format!("{path}/additionalProperties"))?;
		}
	}
	if let Some(items) = obj.get("items") {
		walk_schema(items, depth + 1, &format!("{path}/items"))?;
	}
	for key in ["oneOf", "anyOf"] {
		if let Some(Value::Array(branches)) = obj.get(key) {
			for (i, branch) in branches.iter().enumerate() {
				walk_schema(branch, depth + 1, &format!("{path}/{key}/{i}"))?;
			}
		}
	}
	Ok(())
}

fn validate_value(schema: &Value, value: &Value, path: &str) -> Vec<SchemaValidationIssue> {
	let mut errors = Vec::new();
	validate_value_into(schema, value, path, &mut errors);
	errors
}

#[allow(
	clippy::collapsible_if,
	reason = "schema validator branches mirror the legacy TypeScript implementation"
)]
fn validate_value_into(
	schema: &Value,
	value: &Value,
	path: &str,
	errors: &mut Vec<SchemaValidationIssue>,
) {
	let Some(obj) = schema.as_object() else {
		return;
	};
	if let Some(Value::String(t)) = obj.get("type") {
		if !type_matches(t, value) {
			errors.push(issue(path, "type", format!("expected {t}"), Some(Value::String(t.clone()))));
			return;
		}
	}
	if let Some(c) = obj.get("const") {
		if canonical_json(value) != canonical_json(c) {
			errors.push(issue(path, "const", "value does not equal const", Some(c.clone())));
		}
	}
	if let Some(Value::Array(en)) = obj.get("enum") {
		if !en
			.iter()
			.any(|v| canonical_json(v) == canonical_json(value))
		{
			errors.push(issue(path, "enum", "value not in enum", Some(Value::Array(en.clone()))));
		}
	}
	if let Some(s) = value.as_str() {
		if let Some(n) = obj.get("minLength").and_then(Value::as_u64) {
			if s.chars().count() < n as usize {
				errors.push(issue(
					path,
					"minLength",
					format!("shorter than {n}"),
					Some(Value::from(n)),
				));
			}
		}
		if let Some(n) = obj.get("maxLength").and_then(Value::as_u64) {
			if s.chars().count() > n as usize {
				errors.push(issue(path, "maxLength", format!("longer than {n}"), Some(Value::from(n))));
			}
		}
	}
	if let Some(n) = value.as_f64() {
		if let Some(min) = obj.get("minimum").and_then(Value::as_f64) {
			if n < min {
				errors.push(issue(
					path,
					"minimum",
					format!("less than {min}"),
					obj.get("minimum").cloned(),
				));
			}
		}
		if let Some(max) = obj.get("maximum").and_then(Value::as_f64) {
			if n > max {
				errors.push(issue(
					path,
					"maximum",
					format!("greater than {max}"),
					obj.get("maximum").cloned(),
				));
			}
		}
	}
	if let Some(map) = value.as_object() {
		if let Some(Value::Array(required)) = obj.get("required") {
			for req in required.iter().filter_map(Value::as_str) {
				if !map.contains_key(req) {
					errors.push(issue(
						&format!("{path}/{req}"),
						"required",
						"missing required property",
						None,
					));
				}
			}
		}
		let props = obj.get("properties").and_then(Value::as_object);
		for (k, v) in map {
			if let Some(sub) = props.and_then(|p| p.get(k)) {
				validate_value_into(sub, v, &format!("{path}/{k}"), errors);
			} else if obj.get("additionalProperties") == Some(&Value::Bool(false)) {
				errors.push(issue(
					&format!("{path}/{k}"),
					"additionalProperties",
					"unexpected property",
					None,
				));
			} else if let Some(ap) = obj.get("additionalProperties").filter(|v| v.is_object()) {
				validate_value_into(ap, v, &format!("{path}/{k}"), errors);
			}
		}
	}
	if let Some(arr) = value.as_array() {
		if let Some(n) = obj.get("minItems").and_then(Value::as_u64) {
			if arr.len() < n as usize {
				errors.push(issue(
					path,
					"minItems",
					format!("fewer than {n} items"),
					Some(Value::from(n)),
				));
			}
		}
		if let Some(n) = obj.get("maxItems").and_then(Value::as_u64) {
			if arr.len() > n as usize {
				errors.push(issue(
					path,
					"maxItems",
					format!("more than {n} items"),
					Some(Value::from(n)),
				));
			}
		}
		if obj.get("uniqueItems") == Some(&Value::Bool(true)) {
			let mut seen = std::collections::HashSet::new();
			for item in arr {
				if !seen.insert(canonical_json(item)) {
					errors.push(issue(path, "uniqueItems", "array items must be unique", None));
					break;
				}
			}
		}
		if let Some(items) = obj.get("items") {
			for (i, item) in arr.iter().enumerate() {
				validate_value_into(items, item, &format!("{path}/{i}"), errors);
			}
		}
	}
	for combiner in ["oneOf", "anyOf"] {
		if let Some(Value::Array(branches)) = obj.get(combiner) {
			let count = branches
				.iter()
				.filter(|b| validate_value(b, value, path).is_empty())
				.count();
			let ok = if combiner == "oneOf" {
				count == 1
			} else {
				count >= 1
			};
			if !ok {
				errors.push(issue(path, combiner, format!("value did not satisfy {combiner}"), None));
			}
		}
	}
}

fn type_matches(t: &str, value: &Value) -> bool {
	match t {
		"string" => value.is_string(),
		"number" => value.as_f64().is_some(),
		"integer" => value.as_i64().is_some() || value.as_u64().is_some(),
		"boolean" => value.is_boolean(),
		"object" => value.is_object(),
		"array" => value.is_array(),
		"null" => value.is_null(),
		_ => false,
	}
}

fn issue(
	path: &str,
	keyword: &str,
	message: impl Into<String>,
	expected: Option<Value>,
) -> SchemaValidationIssue {
	SchemaValidationIssue {
		path: path.to_string(),
		keyword: keyword.to_string(),
		message: message.into(),
		expected,
	}
}
