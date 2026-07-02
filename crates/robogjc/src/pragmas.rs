//! Slash-command pragma parsing for maintainer directives.

pub type ThinkingLevel = &'static str;

fn valid_key(key: &str) -> bool {
	let mut chars = key.chars();
	match chars.next() {
		Some(c) if c.is_ascii_alphabetic() => {},
		_ => return false,
	}
	chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn parse_command_line(line: &str) -> Option<Vec<(String, String)>> {
	let stripped = line.trim();
	if stripped.is_empty() || !stripped.starts_with('/') {
		return None;
	}
	let tokens: Vec<&str> = stripped.split_whitespace().collect();
	let mut pairs = Vec::new();
	let mut i = 0;
	while i < tokens.len() {
		let tok = tokens[i];
		if !tok.starts_with('/') || tok.len() < 2 {
			return None;
		}
		if let Some(eq) = tok.find('=') {
			let key = &tok[1..eq];
			let value = &tok[eq + 1..];
			if !valid_key(key) || value.is_empty() {
				return None;
			}
			pairs.push((key.to_ascii_lowercase(), value.to_owned()));
			i += 1;
			continue;
		}
		let key = &tok[1..];
		if !valid_key(key) {
			return None;
		}
		if i + 1 >= tokens.len() || tokens[i + 1].starts_with('/') {
			return None;
		}
		pairs.push((key.to_ascii_lowercase(), tokens[i + 1].to_owned()));
		i += 2;
	}
	if pairs.is_empty() { None } else { Some(pairs) }
}

pub fn parse_pragmas(body: &str) -> (String, Vec<(String, String)>) {
	if body.is_empty() {
		return (String::new(), Vec::new());
	}
	let mut found = Vec::new();
	let mut kept = String::new();
	for segment in body.split_inclusive('\n') {
		let bare = segment.trim_end_matches(['\r', '\n']);
		if let Some(commands) = parse_command_line(bare) {
			found.extend(commands);
		} else {
			kept.push_str(segment);
		}
	}
	if !body.ends_with('\n') {
		// split_inclusive already yielded the final unterminated segment.
	}
	let cleaned = kept.trim_matches(['\r', '\n']).to_owned();
	(cleaned, found)
}

pub fn pragma_value(pragmas: &[(String, String)], key: &str) -> Option<String> {
	let target = key.to_ascii_lowercase();
	pragmas
		.iter()
		.filter(|(k, _)| k == &target)
		.map(|(_, v)| v.clone())
		.last()
}

pub fn resolve_model_alias(alias: &str, pool: &[String]) -> Option<String> {
	let needle = alias.trim().to_ascii_lowercase();
	if needle.is_empty() {
		return None;
	}
	let mut exact = None;
	let mut partial = None;
	for model in pool {
		let lower = model.to_ascii_lowercase();
		if lower == needle {
			return Some(model.clone());
		}
		if exact.is_none() && lower.rsplit('/').next() == Some(needle.as_str()) {
			exact = Some(model.clone());
		}
		if partial.is_none() && lower.contains(&needle) {
			partial = Some(model.clone());
		}
	}
	exact.or(partial)
}

pub fn resolve_thinking_level(value: &str) -> Option<ThinkingLevel> {
	match value.trim().to_ascii_lowercase().as_str() {
		"off" | "none" | "no" => Some("off"),
		"lo" | "low" => Some("low"),
		"med" | "medium" => Some("medium"),
		"hi" | "high" => Some("high"),
		"xhi" | "xhigh" => Some("xhigh"),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	fn p(v: &[(&str, &str)]) -> Vec<(String, String)> {
		v.iter()
			.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
			.collect()
	}
	#[test]
	fn parse_single_inline_command() {
		let (c, ps) = parse_pragmas("/model gpt\nfix the off-by-one in foo()");
		assert_eq!(c, "fix the off-by-one in foo()");
		assert_eq!(ps, p(&[("model", "gpt")]));
	}
	#[test]
	fn parse_multiple_commands_on_one_line() {
		let (c, ps) = parse_pragmas("/model gpt /thinking low\nrun");
		assert_eq!(c, "run");
		assert_eq!(ps, p(&[("model", "gpt"), ("thinking", "low")]));
	}
	#[test]
	fn parse_stacked_commands() {
		let (c, ps) = parse_pragmas("/model gpt\n/thinking low\nrun");
		assert_eq!(c, "run");
		assert_eq!(ps, p(&[("model", "gpt"), ("thinking", "low")]));
	}
	#[test]
	fn parse_equals_form() {
		let (c, ps) = parse_pragmas("/model=gpt /thinking=low\nrun");
		assert_eq!(c, "run");
		assert_eq!(ps, p(&[("model", "gpt"), ("thinking", "low")]));
	}
	#[test]
	fn parse_indented_command_line() {
		let (c, ps) = parse_pragmas("   /model gpt\nrun");
		assert_eq!(c, "run");
		assert_eq!(ps, p(&[("model", "gpt")]));
	}
	#[test]
	fn mixed_line_is_not_consumed() {
		let (c, ps) = parse_pragmas("/model gpt fix the bug");
		assert_eq!(c, "/model gpt fix the bug");
		assert!(ps.is_empty());
	}
	#[test]
	fn path_references_are_not_consumed() {
		let (c, ps) = parse_pragmas("/src/foo.py:42 is the offender\n/model gpt\nfix it");
		assert_eq!(c, "/src/foo.py:42 is the offender\nfix it");
		assert_eq!(ps, p(&[("model", "gpt")]));
	}
	#[test]
	fn command_without_value_is_not_consumed() {
		let (c, ps) = parse_pragmas("/model\nrun");
		assert_eq!(c, "/model\nrun");
		assert!(ps.is_empty());
	}
	#[test]
	fn dangling_command_aborts_whole_line() {
		let (c, ps) = parse_pragmas("/model gpt /thinking\nrun");
		assert_eq!(c, "/model gpt /thinking\nrun");
		assert!(ps.is_empty());
	}
	#[test]
	fn preserves_interior_blank_lines_after_strip() {
		let (c, ps) = parse_pragmas("/model gpt\n\nbody one\n\nbody two");
		assert_eq!(c, "body one\n\nbody two");
		assert_eq!(ps, p(&[("model", "gpt")]));
	}
	#[test]
	fn empty_body() {
		let (c, ps) = parse_pragmas("");
		assert_eq!(c, "");
		assert!(ps.is_empty());
	}
	#[test]
	fn key_case_normalized_value_preserved() {
		let (c, ps) = parse_pragmas("/MODEL GPT-5.5\nrun");
		assert_eq!(c, "run");
		assert_eq!(ps, p(&[("model", "GPT-5.5")]));
	}
	#[test]
	fn pragma_value_last_wins() {
		assert_eq!(
			pragma_value(&p(&[("model", "a"), ("model", "b")]), "model").as_deref(),
			Some("b")
		);
		assert_eq!(pragma_value(&p(&[("model", "a")]), "MODEL").as_deref(), Some("a"));
		assert!(pragma_value(&[], "model").is_none());
	}
	#[test]
	fn differential_pragma_edge_cases_match_python() {
		let (cleaned, pragmas) = parse_pragmas("/model first\n/model second\nbody");
		assert_eq!(cleaned, "body");
		assert_eq!(pragmas, p(&[("model", "first"), ("model", "second")]));
		assert_eq!(pragma_value(&pragmas, "model").as_deref(), Some("second"));

		let (cleaned, pragmas) = parse_pragmas("/model first /thinking\n/thinking low\nbody");
		assert_eq!(cleaned, "/model first /thinking\nbody");
		assert_eq!(pragmas, p(&[("thinking", "low")]));

		let (cleaned, pragmas) = parse_pragmas("/model gpt\n/thinking high\n");
		assert_eq!(cleaned, "");
		assert_eq!(pragmas, p(&[("model", "gpt"), ("thinking", "high")]));

		let (cleaned, pragmas) = parse_pragmas(" \t /model\tgpt\r\nbody\n");
		assert_eq!(cleaned, "body");
		assert_eq!(pragmas, p(&[("model", "gpt")]));
	}
	#[test]
	fn resolve_model_alias_precedence() {
		let pool = p(&[]);
		drop(pool);
		let pool = vec![
			"anthropic/claude-sonnet-4-6".to_owned(),
			"openai/gpt-5.5".to_owned(),
			"openai/gpt-5.5-mini".to_owned(),
		];
		assert_eq!(resolve_model_alias("gpt-5.5", &pool).as_deref(), Some("openai/gpt-5.5"));
		assert_eq!(resolve_model_alias("gpt", &pool).as_deref(), Some("openai/gpt-5.5"));
		assert_eq!(
			resolve_model_alias("claude", &pool).as_deref(),
			Some("anthropic/claude-sonnet-4-6")
		);
	}
	#[test]
	fn resolve_model_alias_full_id() {
		let pool = vec!["openai/gpt-5.5".to_owned(), "anthropic/claude-sonnet-4-6".to_owned()];
		assert_eq!(resolve_model_alias("openai/gpt-5.5", &pool).as_deref(), Some("openai/gpt-5.5"));
	}
	#[test]
	fn resolve_model_alias_no_match() {
		let pool = vec!["anthropic/claude-sonnet-4-6".to_owned()];
		assert!(resolve_model_alias("gpt", &pool).is_none());
		assert!(resolve_model_alias("", &pool).is_none());
	}
	#[test]
	fn resolve_thinking_level_aliases() {
		for (input, expected) in [
			("off", "off"),
			("none", "off"),
			("no", "off"),
			("lo", "low"),
			("low", "low"),
			("med", "medium"),
			("medium", "medium"),
			("hi", "high"),
			("high", "high"),
			("xhi", "xhigh"),
			("xhigh", "xhigh"),
		] {
			assert_eq!(resolve_thinking_level(input), Some(expected));
		}
	}
	#[test]
	fn resolve_thinking_level_case_insensitive() {
		assert_eq!(resolve_thinking_level("HIGH"), Some("high"));
		assert_eq!(resolve_thinking_level("  Hi  "), Some("high"));
		assert_eq!(resolve_thinking_level("XHi"), Some("xhigh"));
	}
	#[test]
	fn resolve_thinking_level_rejects_unknown() {
		assert!(resolve_thinking_level("ultra").is_none());
		assert!(resolve_thinking_level("").is_none());
		assert!(resolve_thinking_level("minimal").is_none());
	}
}
