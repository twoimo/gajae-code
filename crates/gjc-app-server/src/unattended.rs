//! Unattended run controller for app-server pre-side-effect enforcement.

use std::{
	collections::BTreeSet,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
	error::{AppServerError, Result, codes},
	ids::ThreadId,
};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcUnattendedBudget {
	pub max_tokens: u64,
	pub max_tool_calls: u64,
	pub max_wall_time_ms: u64,
	pub max_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct RpcUnattendedDeclaration {
	pub actor: String,
	pub budget: RpcUnattendedBudget,
	pub scopes: Vec<String>,
	pub action_allowlist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct RpcUnattendedAccepted {
	pub run_id: String,
	pub actor: String,
	pub budget: RpcUnattendedBudget,
	pub scopes: Vec<String>,
	pub action_allowlist: Vec<String>,
	pub accepted_at: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct RpcUnattendedRefused {
	pub code: String,
	pub message: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct RpcBudgetExceeded {
	pub code: String,
	pub metric: String,
	pub limit: f64,
	pub observed: f64,
	pub phase: String,
	pub run_id: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub session_id: Option<String>,
	pub abort_status: String,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct RpcScopeDenied {
	pub code: String,
	pub scope: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub command: Option<String>,
	pub run_id: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub session_id: Option<String>,
	pub pre_side_effect: bool,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct RpcActionDenied {
	pub code: String,
	pub action: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub command: Option<String>,
	pub run_id: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub session_id: Option<String>,
	pub pre_side_effect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct UnattendedNegotiateParams {
	#[serde(rename = "threadId")]
	pub thread_id: String,
	pub declaration: RpcUnattendedDeclaration,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageSnapshot {
	#[serde(default)]
	pub tokens: u64,
	#[serde(default)]
	pub cost_usd: f64,
}

#[derive(Debug, Clone)]
pub struct PreflightOutcome {
	pub charged: bool,
}

#[derive(Debug, Clone)]
struct ActiveRun {
	accepted: RpcUnattendedAccepted,
	scopes: BTreeSet<String>,
	actions: BTreeSet<String>,
	started: Instant,
	reserved_tool_calls: u64,
	observed_tokens: u64,
	observed_cost_usd: f64,
	abort_started: bool,
}

#[derive(Debug, Default)]
pub struct UnattendedController {
	run: Option<ActiveRun>,
	audit: Vec<Value>,
}

const VALID_SCOPES: &[&str] = &[
	"command.prompt",
	"command.control",
	"command.bash",
	"command.export",
	"command.session",
	"command.model",
	"command.message_read",
	"command.host_tools",
	"command.host_uri",
	"command.admin",
];

const VALID_ACTIONS: &[&str] = &[
	"command.prompt",
	"command.control",
	"command.bash",
	"command.export",
	"command.session",
	"command.model",
	"command.message_read",
	"command.host_tools",
	"command.host_uri",
	"command.admin",
	"bash.readonly",
	"bash.mutating",
	"bash.destructive",
	"git.force_push",
	"file.delete",
	"file.write",
	"host_tool.invoke",
	"host_uri.read",
	"host_uri.write",
	"auth.login",
];

impl UnattendedController {
	pub fn negotiate(
		&mut self,
		thread_id: &ThreadId,
		declaration: RpcUnattendedDeclaration,
	) -> Result<RpcUnattendedAccepted> {
		validate_declaration(&declaration)?;
		let scopes = declaration.scopes.iter().cloned().collect::<BTreeSet<_>>();
		let actions = declaration
			.action_allowlist
			.iter()
			.cloned()
			.collect::<BTreeSet<_>>();
		let accepted = RpcUnattendedAccepted {
			run_id: format!("unattended_{}_{}", short(&thread_id.0), epoch_millis()),
			actor: declaration.actor,
			budget: declaration.budget,
			scopes: scopes.iter().cloned().collect(),
			action_allowlist: actions.iter().cloned().collect(),
			accepted_at: epoch_millis().to_string(),
		};
		self.audit.push(serde_json::json!({"event":"unattended_negotiated","run_id":accepted.run_id,"actor":accepted.actor}));
		self.run = Some(ActiveRun {
			accepted: accepted.clone(),
			scopes,
			actions,
			started: Instant::now(),
			reserved_tool_calls: 0,
			observed_tokens: 0,
			observed_cost_usd: 0.0,
			abort_started: false,
		});
		Ok(accepted)
	}

	pub fn audit(&self) -> Vec<Value> {
		self.audit.clone()
	}

	pub fn preflight(
		&mut self,
		thread_id: &ThreadId,
		method: &str,
		params: Option<&Value>,
	) -> Result<Option<PreflightOutcome>> {
		let Some(run) = self.run.as_mut() else {
			return Ok(None);
		};
		let Some(policy) = policy_for(method, params) else {
			return Ok(Some(PreflightOutcome { charged: false }));
		};
		if run.abort_started {
			return Err(refused("unattended_aborted", "unattended run is aborted"));
		}
		if let Some(err) =
			budget_breach(run, "wall_time", run.started.elapsed().as_millis() as f64, "preflight")
		{
			self.audit.push(serde_json::json!({"event":"budget_exceeded","run_id":run.accepted.run_id,"metric":"wall_time"}));
			return Err(err);
		}
		if !run.scopes.contains(policy.scope) {
			let data = RpcScopeDenied {
				code: "scope_denied".into(),
				scope: policy.scope.into(),
				command: Some(method.into()),
				run_id: run.accepted.run_id.clone(),
				session_id: Some(thread_id.0.clone()),
				pre_side_effect: true,
			};
			self.audit.push(serde_json::json!({"event":"scope_denied","run_id":run.accepted.run_id,"scope":policy.scope,"command":method}));
			return Err(
				AppServerError::new(codes::INVALID_REQUEST, "scope_denied")
					.with_data(serde_json::to_value(data).unwrap()),
			);
		}
		for action in policy.actions {
			if !run.actions.contains(action) {
				let data = RpcActionDenied {
					code: "action_denied".into(),
					action: action.into(),
					command: Some(method.into()),
					run_id: run.accepted.run_id.clone(),
					session_id: Some(thread_id.0.clone()),
					pre_side_effect: true,
				};
				self.audit.push(serde_json::json!({"event":"action_denied","run_id":run.accepted.run_id,"action":action,"command":method}));
				return Err(
					AppServerError::new(codes::INVALID_REQUEST, "action_denied")
						.with_data(serde_json::to_value(data).unwrap()),
				);
			}
		}
		if policy.charge_tool_call {
			let next = run.reserved_tool_calls + 1;
			if next > run.accepted.budget.max_tool_calls {
				let err = budget_error(
					run,
					"tool_calls",
					run.accepted.budget.max_tool_calls as f64,
					next as f64,
					"reserve",
					"aborting",
				);
				run.abort_started = true;
				self.audit.push(serde_json::json!({"event":"budget_exceeded","run_id":run.accepted.run_id,"metric":"tool_calls"}));
				return Err(err);
			}
			run.reserved_tool_calls = next;
		}
		Ok(Some(PreflightOutcome { charged: policy.charge_tool_call }))
	}

	pub fn reconcile(&mut self, usage: Option<UsageSnapshot>) -> Result<()> {
		let Some(run) = self.run.as_mut() else {
			return Ok(());
		};
		if let Some(usage) = usage {
			run.observed_tokens = usage.tokens;
			run.observed_cost_usd = usage.cost_usd;
		}
		if let Some(err) = budget_breach(run, "tokens", run.observed_tokens as f64, "reconcile") {
			self.audit.push(
				serde_json::json!({"event":"budget_exceeded","run_id":run.accepted.run_id,"metric":"tokens"}),
			);
			return Err(err);
		}
		if let Some(err) = budget_breach(run, "cost", run.observed_cost_usd, "reconcile") {
			self.audit.push(
				serde_json::json!({"event":"budget_exceeded","run_id":run.accepted.run_id,"metric":"cost"}),
			);
			return Err(err);
		}
		Ok(())
	}

	pub fn mark_abort_settled(&mut self) {
		if let Some(run) = self.run.as_mut() {
			run.abort_started = true;
			self
				.audit
				.push(serde_json::json!({"event":"abort_settled","run_id":run.accepted.run_id}));
		}
	}
}

struct MethodPolicy<'a> {
	scope: &'a str,
	actions: Vec<&'a str>,
	charge_tool_call: bool,
}

fn policy_for<'a>(method: &str, params: Option<&'a Value>) -> Option<MethodPolicy<'a>> {
	match method {
		"turn/start" => Some(MethodPolicy {
			scope: "command.prompt",
			actions: vec!["command.prompt"],
			charge_tool_call: true,
		}),
		"turn/steer" | "turn/interrupt" => Some(MethodPolicy {
			scope: "command.control",
			actions: vec!["command.control"],
			charge_tool_call: true,
		}),
		"command/exec" | "thread/shellCommand" => Some(MethodPolicy {
			scope: "command.bash",
			actions: vec!["command.bash", classify_bash(params)],
			charge_tool_call: true,
		}),
		"gjc/hostTools/set" | "gjc/hostTools/result" | "gjc/hostTools/update" => Some(MethodPolicy {
			scope: "command.host_tools",
			actions: vec!["command.host_tools"],
			charge_tool_call: true,
		}),
		"gjc/hostUriSchemes/set" | "gjc/hostUris/result" => Some(MethodPolicy {
			scope: "command.host_uri",
			actions: vec!["command.host_uri"],
			charge_tool_call: true,
		}),
		"gjc/hostUris/read" => Some(MethodPolicy {
			scope: "command.host_uri",
			actions: vec!["host_uri.read"],
			charge_tool_call: true,
		}),
		"gjc/hostUris/write" => Some(MethodPolicy {
			scope: "command.host_uri",
			actions: vec!["host_uri.write"],
			charge_tool_call: true,
		}),
		"gjc/workflowGate/respond" => Some(MethodPolicy {
			scope: "command.control",
			actions: vec!["command.control"],
			charge_tool_call: true,
		}),
		"gjc/model/set" => Some(MethodPolicy {
			scope: "command.model",
			actions: vec!["command.model"],
			charge_tool_call: true,
		}),
		"gjc/todos/set" | "gjc/compact" | "thread/delete" | "thread/archive" => Some(MethodPolicy {
			scope: "command.session",
			actions: vec!["command.session"],
			charge_tool_call: true,
		}),
		_ => None,
	}
}

fn classify_bash(params: Option<&Value>) -> &'static str {
	let command = params
		.and_then(extract_command)
		.unwrap_or_default()
		.to_ascii_lowercase();
	let destructive = ["rm -rf", "sudo rm", "mkfs", "dd if=", "git push --force", "git push -f"];
	if destructive.iter().any(|needle| command.contains(needle)) {
		return "bash.destructive";
	}
	let mutating = [
		"rm ",
		"mv ",
		"cp ",
		"mkdir",
		"touch ",
		"chmod",
		"chown",
		"git commit",
		"git push",
		"npm install",
		"bun add",
		"cargo add",
	];
	if mutating.iter().any(|needle| command.contains(needle)) {
		return "bash.mutating";
	}
	"bash.readonly"
}

fn extract_command(value: &Value) -> Option<String> {
	if let Some(s) = value.as_str() {
		return Some(s.to_string());
	}
	if let Some(arr) = value.as_array() {
		return Some(
			arr.iter()
				.filter_map(|v| v.as_str())
				.collect::<Vec<_>>()
				.join(" "),
		);
	}
	let command = value.get("command")?;
	extract_command(command)
}

fn validate_declaration(decl: &RpcUnattendedDeclaration) -> Result<()> {
	if decl.actor.trim().is_empty() {
		return Err(refused("invalid_unattended_declaration", "actor is required"));
	}
	let b = &decl.budget;
	if b.max_tokens == 0
		|| b.max_tool_calls == 0
		|| b.max_wall_time_ms == 0
		|| b.max_cost_usd <= 0.0
		|| !b.max_cost_usd.is_finite()
	{
		return Err(refused(
			"incomplete_budget",
			"budget must include positive token, tool-call, wall-time, and cost limits",
		));
	}
	if decl.scopes.is_empty() || decl.action_allowlist.is_empty() {
		return Err(refused(
			"invalid_unattended_declaration",
			"scopes and action_allowlist are required",
		));
	}
	for scope in &decl.scopes {
		if !VALID_SCOPES.contains(&scope.as_str()) {
			return Err(refused("invalid_unattended_declaration", format!("unknown scope: {scope}")));
		}
	}
	for action in &decl.action_allowlist {
		if !VALID_ACTIONS.contains(&action.as_str()) {
			return Err(refused(
				"invalid_unattended_declaration",
				format!("unknown action: {action}"),
			));
		}
	}
	Ok(())
}

fn refused(code: &str, message: impl Into<String>) -> AppServerError {
	let data = RpcUnattendedRefused { code: code.into(), message: message.into() };
	AppServerError::new(codes::INVALID_REQUEST, code).with_data(serde_json::to_value(data).unwrap())
}

pub fn negotiation_refusal(code: &str, message: impl Into<String>) -> AppServerError {
	refused(code, message)
}

fn budget_breach(
	run: &mut ActiveRun,
	metric: &str,
	observed: f64,
	phase: &str,
) -> Option<AppServerError> {
	let limit = match metric {
		"tokens" => run.accepted.budget.max_tokens as f64,
		"tool_calls" => run.accepted.budget.max_tool_calls as f64,
		"wall_time" => run.accepted.budget.max_wall_time_ms as f64,
		"cost" => run.accepted.budget.max_cost_usd,
		_ => return None,
	};
	if observed > limit {
		run.abort_started = true;
		Some(budget_error(run, metric, limit, observed, phase, "aborting"))
	} else {
		None
	}
}

fn budget_error(
	run: &ActiveRun,
	metric: &str,
	limit: f64,
	observed: f64,
	phase: &str,
	abort_status: &str,
) -> AppServerError {
	let data = RpcBudgetExceeded {
		code: "budget_exceeded".into(),
		metric: metric.into(),
		limit,
		observed,
		phase: phase.into(),
		run_id: run.accepted.run_id.clone(),
		session_id: None,
		abort_status: abort_status.into(),
	};
	AppServerError::new(codes::INVALID_REQUEST, "budget_exceeded")
		.with_data(serde_json::to_value(data).unwrap())
}

fn short(input: &str) -> String {
	let s: String = input
		.chars()
		.filter(|c| c.is_ascii_alphanumeric())
		.collect();
	let tail: String = s.chars().rev().take(8).collect();
	tail.chars().rev().collect::<String>()
}

fn epoch_millis() -> u128 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or(Duration::ZERO)
		.as_millis()
}
