//! Unknown-field policy (Phase 0A gate).
//!
//! Codex-core methods are **lenient**: unknown/unsupported fields are ignored to
//! maximize codex-client interop. `gjc/*` extension methods are **strict**:
//! unknown fields are rejected with `-32602 invalid params`. This keeps GJC
//! automation deterministic and schema-driven while tolerating forward-compat
//! fields (environments, selectedCapabilityRoots, realtime, plugin fields, …)
//! that codex clients send but gjc does not implement.

use crate::error::AppServerError;

/// The validation posture for a method's params.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldPolicy {
	/// Ignore unknown fields (codex-core methods).
	LenientCodexCore,
	/// Reject unknown fields (gjc/* extension methods).
	StrictGjcExtension,
}

/// The policy for a method is decided purely by namespace: `gjc/*` (and the
/// `gjc.`-dotted management variants) are strict; everything else in the pinned
/// codex-core surface is lenient.
#[must_use]
pub fn policy_for(method: &str) -> FieldPolicy {
	if method.starts_with("gjc/") || method.starts_with("gjc.") {
		FieldPolicy::StrictGjcExtension
	} else {
		FieldPolicy::LenientCodexCore
	}
}

/// Validate a params object's keys against the set of fields the method knows.
///
/// - `LenientCodexCore`: always Ok (unknown keys ignored by the deserializer).
/// - `StrictGjcExtension`: Err(`invalid_params`) listing the first unknown key.
///
/// `params` may be `None` (no params) or a non-object value; non-object params
/// are only rejected for strict methods that expected an object, which the
/// per-method decoder handles. Here we only police unknown keys of an object.
pub fn enforce(
	method: &str,
	params: Option<&serde_json::Value>,
	known_fields: &[&str],
) -> crate::error::Result<()> {
	if policy_for(method) == FieldPolicy::LenientCodexCore {
		return Ok(());
	}
	let Some(serde_json::Value::Object(map)) = params else {
		return Ok(());
	};
	for key in map.keys() {
		if !known_fields.contains(&key.as_str()) {
			return Err(AppServerError::invalid_params(format!(
				"unknown field `{key}` for strict method `{method}`"
			)));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::error::codes;

	#[test]
	fn codex_core_methods_are_lenient() {
		assert_eq!(policy_for("thread/start"), FieldPolicy::LenientCodexCore);
		assert_eq!(policy_for("turn/start"), FieldPolicy::LenientCodexCore);
		assert_eq!(policy_for("command/exec"), FieldPolicy::LenientCodexCore);
		assert_eq!(policy_for("initialize"), FieldPolicy::LenientCodexCore);
	}

	#[test]
	fn gjc_methods_are_strict() {
		assert_eq!(policy_for("gjc/model/set"), FieldPolicy::StrictGjcExtension);
		assert_eq!(policy_for("gjc.compact"), FieldPolicy::StrictGjcExtension);
	}

	#[test]
	fn lenient_ignores_unknown_codex_fields() {
		// Codex client sends environments/selectedCapabilityRoots gjc lacks.
		let params = serde_json::json!({
			 "cwd": "/p", "model": "gpt", "environments": [], "selectedCapabilityRoots": []
		});
		assert!(enforce("turn/start", Some(&params), &["cwd", "model"]).is_ok());
	}

	#[test]
	fn strict_rejects_unknown_gjc_fields() {
		let params = serde_json::json!({ "provider": "anthropic", "modelId": "x", "bogus": 1 });
		let e = enforce("gjc/model/set", Some(&params), &["provider", "modelId"]).unwrap_err();
		assert_eq!(e.code, codes::INVALID_PARAMS);
		assert!(e.message.contains("bogus"));
	}

	#[test]
	fn strict_accepts_known_gjc_fields() {
		let params = serde_json::json!({ "provider": "anthropic", "modelId": "x" });
		assert!(enforce("gjc/model/set", Some(&params), &["provider", "modelId"]).is_ok());
	}
}
