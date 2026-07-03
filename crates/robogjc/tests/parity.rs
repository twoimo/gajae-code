use std::{collections::HashSet, fs, path::Path, process::Command};

use robogjc::{
	db::{Database, issue_key},
	github, host_tools, proxy, redaction,
};
use serde_json::{Value, json};

const REPORT_PATH: &str = "../../artifacts/robogjc/qa/g010-parity-report.json";

fn fixture(path: &str) -> String {
	fs::read_to_string(
		Path::new(env!("CARGO_MANIFEST_DIR"))
			.join("tests/fixtures")
			.join(path),
	)
	.unwrap()
}

fn fixture_json(path: &str) -> Value {
	serde_json::from_str(&fixture(path)).unwrap()
}

fn hs(values: &[&str]) -> HashSet<String> {
	values.iter().map(|s| s.to_string()).collect()
}

fn decision_json(d: &github::RouteDecision) -> Value {
	json!({
		"should_queue": d.should_queue(),
		"task": d.task,
		"repo": d.repo,
		"issue_key": d.issue_key,
		"reason": d.reason,
		"submitter": d.submitter,
		"association": d.association,
		"directive": d.directive,
		"directive_body": d.directive_body,
		"directive_author": d.directive_author,
		"directive_pragmas": d.directive_pragmas,
	})
}

fn route_case(name: &str, event_type: &str) -> (usize, Vec<Value>) {
	let payload = fixture_json(&format!("phase3/{name}.payload.json"));
	let expected = fixture_json(&format!("phase3/{name}.expected.json"));
	let resolver = |_: &str, _: i64| Some("octo/widget#42".to_string());
	let got = decision_json(&github::route(
		event_type,
		&payload,
		&hs(&["octo/widget"]),
		"robogjc-bot",
		&hs(&["can1357"]),
		&hs(&["gjc-reviewer"]),
		Some(&resolver),
	));
	(1, diff_values(name, &expected, &got))
}

fn diff_values(case: &str, expected: &Value, got: &Value) -> Vec<Value> {
	if expected == got {
		Vec::new()
	} else {
		vec![json!({"case": case, "expected": expected, "got": got})]
	}
}

fn normalize_descriptor_value(value: &Value) -> Value {
	match value {
		Value::Object(map) => {
			let mut out = serde_json::Map::new();
			for (key, child) in map {
				if key == "required" && child.as_array().is_some_and(|a| a.is_empty()) {
					continue;
				}
				out.insert(key.clone(), normalize_descriptor_value(child));
			}
			Value::Object(out)
		},
		Value::Array(items) => Value::Array(items.iter().map(normalize_descriptor_value).collect()),
		_ => value.clone(),
	}
}

fn descriptor_diffs(case: &str, expected: &Value, got: &Value) -> Vec<Value> {
	diff_values(case, &normalize_descriptor_value(expected), &normalize_descriptor_value(got))
}

fn surface(name: &str, compared_via: &str, cases: usize, diffs: Vec<Value>) -> Value {
	json!({"name": name, "comparedVia": compared_via, "cases": cases, "diffs": diffs})
}

fn report_provenance() -> Value {
	let git_commit = Command::new("git")
		.args(["rev-parse", "--short", "HEAD"])
		.output()
		.ok()
		.filter(|out| out.status.success())
		.map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
		.filter(|s| !s.is_empty())
		.unwrap_or_else(|| "unknown".to_owned());
	let generated_at = Command::new("date")
		.args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
		.output()
		.ok()
		.filter(|out| out.status.success())
		.map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
		.filter(|s| !s.is_empty())
		.unwrap_or_else(|| "unknown".to_owned());
	json!({
		"generatedBy": "crates/robogjc/tests/parity.rs",
		"pythonInterpreter": "/tmp/robogjc-uv/bin/python",
		"gitCommit": git_commit,
		"generatedAt": generated_at,
	})
}

fn write_report(surfaces: Vec<Value>) {
	let total_cases = surfaces
		.iter()
		.filter_map(|s| s["cases"].as_u64())
		.sum::<u64>();
	let unexplained_diffs = surfaces
		.iter()
		.filter_map(|s| s["diffs"].as_array())
		.map(|d| d.len() as u64)
		.sum::<u64>();
	let report = json!({
		"schemaVersion": 1,
		"kind": "package-consumer-report",
		"surfaces": surfaces,
		"provenance": report_provenance(),
		"summary": {"totalCases": total_cases, "unexplainedDiffs": unexplained_diffs},
	});
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(REPORT_PATH);
	fs::create_dir_all(path.parent().unwrap()).unwrap();
	fs::write(path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
	assert_eq!(unexplained_diffs, 0, "parity report contains unexplained diffs: {report:#}");
}

fn sqlite_snapshot(path: &Path) -> Value {
	let conn = rusqlite::Connection::open(path).unwrap();
	let events: Vec<Value> = {
		let mut st = conn.prepare("SELECT delivery_id,event_type,repo,issue_key,payload_json,state,attempts,last_error,model FROM events ORDER BY delivery_id").unwrap();
		st.query_map([], |r| {
			Ok(json!({
				"delivery_id": r.get::<_, String>(0)?,
				"event_type": r.get::<_, String>(1)?,
				"repo": r.get::<_, Option<String>>(2)?,
				"issue_key": r.get::<_, Option<String>>(3)?,
				"payload": serde_json::from_str::<Value>(&r.get::<_, String>(4)?).unwrap(),
				"state": r.get::<_, String>(5)?,
				"attempts": r.get::<_, i64>(6)?,
				"last_error": r.get::<_, Option<String>>(7)?,
				"model": r.get::<_, Option<String>>(8)?,
			}))
		})
		.unwrap()
		.map(Result::unwrap)
		.collect()
	};
	let issues: Vec<Value> = {
		let mut st = conn.prepare("SELECT key,repo,number,branch,session_dir,pr_number,state,classification FROM issues ORDER BY key").unwrap();
		st.query_map([], |r| Ok(json!({
			"key": r.get::<_, String>(0)?, "repo": r.get::<_, String>(1)?, "number": r.get::<_, i64>(2)?,
			"branch": r.get::<_, Option<String>>(3)?, "session_dir": r.get::<_, Option<String>>(4)?, "pr_number": r.get::<_, Option<i64>>(5)?,
			"state": r.get::<_, String>(6)?, "classification": r.get::<_, Option<String>>(7)?,
		}))).unwrap().map(Result::unwrap).collect()
	};
	let tool_calls: Vec<Value> = {
		let mut st = conn
			.prepare("SELECT issue_key,tool,args_json,result_json,error FROM tool_calls ORDER BY id")
			.unwrap();
		st.query_map([], |r| {
			Ok(json!({
				"issue_key": r.get::<_, String>(0)?, "tool": r.get::<_, String>(1)?,
				"args": serde_json::from_str::<Value>(&r.get::<_, String>(2)?).unwrap(),
				"result": r.get::<_, Option<String>>(3)?.map(|s| serde_json::from_str::<Value>(&s).unwrap()),
				"error": r.get::<_, Option<String>>(4)?,
			}))
		})
		.unwrap()
		.map(Result::unwrap)
		.collect()
	};
	let submissions: i64 = conn
		.query_row("SELECT COUNT(*) FROM submissions", [], |r| r.get(0))
		.unwrap();
	let closures: Vec<Value> = {
		let mut st = conn.prepare("SELECT issue_key,repo,number,comment_id,issue_author,close_at,state,cancel_reason FROM pending_closures ORDER BY issue_key").unwrap();
		st.query_map([], |r| Ok(json!({
			"issue_key": r.get::<_, String>(0)?, "repo": r.get::<_, String>(1)?, "number": r.get::<_, i64>(2)?,
			"comment_id": r.get::<_, i64>(3)?, "issue_author": r.get::<_, String>(4)?, "close_at": r.get::<_, String>(5)?,
			"state": r.get::<_, String>(6)?, "cancel_reason": r.get::<_, Option<String>>(7)?,
		}))).unwrap().map(Result::unwrap).collect()
	};
	json!({"events": events, "issues": issues, "tool_calls": tool_calls, "submissions": submissions, "pending_closures": closures})
}

fn seed_rust_db(path: &Path) {
	let db = Database::open(path).unwrap();
	db.record_event(
		"fixture-queued",
		"issues",
		Some("octo/widget"),
		Some(&issue_key("octo/widget", 101)),
		&json!({"action":"opened","issue":{"number":101}}),
		"queued",
		None,
	)
	.unwrap();
	db.record_event(
		"fixture-running",
		"issue_comment",
		Some("octo/widget"),
		Some(&issue_key("octo/widget", 102)),
		&json!({"action":"created","comment":{"id":202}}),
		"queued",
		None,
	)
	.unwrap();
	db.claim_next_event().unwrap();
	db.record_event(
		"fixture-done",
		"issues",
		Some("octo/widget"),
		Some(&issue_key("octo/widget", 103)),
		&json!({"action":"closed"}),
		"done",
		None,
	)
	.unwrap();
	db.record_event(
		"fixture-failed",
		"issues",
		Some("octo/widget"),
		Some(&issue_key("octo/widget", 104)),
		&json!({"action":"opened"}),
		"failed",
		Some("fixture failure"),
	)
	.unwrap();
	db.record_event(
		"fixture-skipped",
		"issues",
		Some("octo/widget"),
		Some(&issue_key("octo/widget", 105)),
		&json!({"action":"labeled"}),
		"skipped",
		Some("issues.labeled ignored"),
	)
	.unwrap();
	db.set_event_model("fixture-running", "fixture-model")
		.unwrap();
	db.upsert_issue(
		&issue_key("octo/widget", 101),
		"octo/widget",
		101,
		"opened",
		Some("farm/fixture/issue-101"),
		Some("/tmp/fixture-session"),
		Some(501),
	)
	.unwrap();
	db.set_issue_classification(&issue_key("octo/widget", 101), "bug")
		.unwrap();
	db.upsert_issue(&issue_key("octo/widget", 202), "octo/widget", 202, "new", None, None, None)
		.unwrap();
	db.set_issue_classification(&issue_key("octo/widget", 202), "question")
		.unwrap();
	db.log_tool_call(
		&issue_key("octo/widget", 101),
		"gh_post_comment",
		&json!({"body":"hello"}),
		Some(&json!({"comment_id":9001})),
		None,
	)
	.unwrap();
	db.log_tool_call(
		&issue_key("octo/widget", 101),
		"set_issue_labels",
		&json!({"labels":["bug"]}),
		None,
		Some("fixture tool error"),
	)
	.unwrap();
	db.record_submission("fixture-submission-a", "Alice", Some("octo/widget"))
		.unwrap();
	db.record_submission("fixture-submission-b", "bob", Some("octo/widget"))
		.unwrap();
	db.admit_submission(
		"fixture-submission-c",
		"Charlie",
		Some("octo/widget"),
		"2000-01-01T00:00:00.000000Z",
		Some(10),
	)
	.unwrap();
	db.upsert_pending_closure(
		&issue_key("octo/widget", 303),
		"octo/widget",
		303,
		7001,
		"Alice",
		"2030-01-01T00:00:00.000000Z",
	)
	.unwrap();
	db.upsert_pending_closure(
		&issue_key("octo/widget", 304),
		"octo/widget",
		304,
		7002,
		"Bob",
		"2000-01-01T00:00:00.000000Z",
	)
	.unwrap();
	db.claim_due_closures("2026-05-15T00:00:00.000000Z", 1)
		.unwrap();
	db.upsert_pending_closure(
		&issue_key("octo/widget", 305),
		"octo/widget",
		305,
		7003,
		"Carol",
		"2000-01-01T00:00:00.000000Z",
	)
	.unwrap();
	db.claim_due_closures("2026-05-15T00:00:00.000000Z", 1)
		.unwrap();
	db.finalize_closure(&issue_key("octo/widget", 305), "closed", None)
		.unwrap();
	db.upsert_pending_closure(
		&issue_key("octo/widget", 306),
		"octo/widget",
		306,
		7004,
		"Dana",
		"2030-01-01T00:00:00.000000Z",
	)
	.unwrap();
	db.cancel_pending_closure(&issue_key("octo/widget", 306), "user_replied")
		.unwrap();
}

#[test]
fn parity_fixture_only_surfaces_emit_report() {
	let mut surfaces = Vec::new();

	let hmac = fixture_json("phase1/hmac-vectors.json");
	let mut hmac_diffs = Vec::new();
	for c in hmac["cases"].as_array().unwrap() {
		let got = proxy::sign(
			c["method"].as_str().unwrap(),
			c["path"].as_str().unwrap(),
			c["body"].as_str().unwrap().as_bytes(),
			c["key"].as_str().unwrap().as_bytes(),
			c["timestamp"].as_str().unwrap(),
		);
		hmac_diffs.extend(diff_values(
			c["name"].as_str().unwrap(),
			&c["expected_signature"],
			&Value::String(got),
		));
	}
	surfaces.push(surface(
		"hmac-sign-vectors",
		"rust proxy::sign vs phase1 Python-generated fixture",
		hmac["cases"].as_array().unwrap().len(),
		hmac_diffs,
	));

	let redaction = fixture_json("phase1/redaction-vectors.json");
	let mut redaction_diffs = Vec::new();
	for c in redaction["cases"].as_array().unwrap() {
		let got = redaction::redact_credentials(c["input"].as_str());
		redaction_diffs.extend(diff_values(
			c["name"].as_str().unwrap(),
			&c["expected"],
			&Value::String(got),
		));
	}
	surfaces.push(surface(
		"credential-redaction",
		"rust redaction vs phase1 Python-generated fixture",
		redaction["cases"].as_array().unwrap().len(),
		redaction_diffs,
	));

	let mut route_diffs = Vec::new();
	let mut route_cases = 0;
	for (name, event_type) in [
		("route-issue-opened", "issues"),
		("route-comment", "issue_comment"),
		("route-pr-conversation", "issue_comment"),
		("route-review-comment", "pull_request_review_comment"),
		("route-pr-merged", "pull_request"),
	] {
		let (cases, diffs) = route_case(name, event_type);
		route_cases += cases;
		route_diffs.extend(diffs);
	}
	surfaces.push(surface(
		"webhook-event-routing",
		"rust github::route vs phase3 expected route fixtures",
		route_cases,
		route_diffs,
	));

	let got_descriptors = serde_json::to_value(host_tools::descriptors()).unwrap();
	let expected_descriptors = fixture_json("phase5/host-tool-descriptors.snapshot.json");
	surfaces.push(surface(
		"host-tool-descriptor-schemas",
		"rust descriptors vs phase5 Python-era snapshot",
		expected_descriptors.as_array().unwrap().len(),
		descriptor_diffs("host-tool-descriptors", &expected_descriptors, &got_descriptors),
	));

	let mut worker_diffs = Vec::new();
	let mut worker_cases = 0;
	for name in ["start", "resume", "host-tool", "steer", "interrupt", "terminal-race"] {
		let text = fixture(&format!("phase7/{name}.ndjson"));
		let frames: Vec<Value> = text
			.lines()
			.map(|line| serde_json::from_str(line).unwrap())
			.collect();
		worker_cases += frames.len();
		if frames.is_empty() {
			worker_diffs.push(json!({"case": name, "error": "empty transcript"}));
		}
	}
	surfaces.push(surface(
		"app-server-worker-transcripts",
		"phase7 replay transcript JSON framing validation",
		worker_cases,
		worker_diffs,
	));

	write_report(surfaces);
}

#[test]
#[ignore = "set ROBGJC_PARITY=1 to compare against /tmp/robogjc-uv/bin/python oracles"]
fn parity_python_oracles() {
	assert_eq!(
		std::env::var("ROBGJC_PARITY").as_deref(),
		Ok("1"),
		"ROBGJC_PARITY=1 is required for Python oracle parity"
	);
	let py = Path::new("/tmp/robogjc-uv/bin/python");
	assert!(py.exists(), "missing Python oracle interpreter at {}", py.display());
	let tmp = tempfile::tempdir().unwrap();
	let mut surfaces = Vec::new();

	let route_script = r#"
import json, sys
from pathlib import Path
import robogjc.github_events as ge
root=Path(sys.argv[1])
out=[]
for name,event_type in [('route-issue-opened','issues'),('route-comment','issue_comment'),('route-pr-conversation','issue_comment'),('route-review-comment','pull_request_review_comment'),('route-pr-merged','pull_request')]:
    payload=json.loads((root/f'{name}.payload.json').read_text())
    d=ge.route(event_type, payload, allowlist=frozenset(['octo/widget']), bot_login='robogjc-bot', maintainers=frozenset(['can1357']), reviewer_bots=frozenset(['gjc-reviewer']), resolve_issue_from_pr=lambda repo,n: 'octo/widget#42')
    out.append({'name':name,'decision':{'should_queue': d.should_queue, 'task': d.task, 'repo': d.repo, 'issue_key': d.issue_key, 'reason': d.reason, 'submitter': d.submitter, 'association': d.association, 'directive': d.directive, 'directive_body': d.directive_body, 'directive_author': d.directive_author, 'directive_pragmas': [list(p) for p in d.directive_pragmas]}})
print(json.dumps(out, sort_keys=True))
"#;
	let route_out = Command::new(py)
		.arg("-c")
		.arg(route_script)
		.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase3"))
		.output()
		.unwrap();
	assert!(route_out.status.success(), "{}", String::from_utf8_lossy(&route_out.stderr));
	let py_routes: Vec<Value> = serde_json::from_slice(&route_out.stdout).unwrap();
	let mut route_diffs = Vec::new();
	for py_case in &py_routes {
		let name = py_case["name"].as_str().unwrap();
		let event_type = match name {
			"route-issue-opened" => "issues",
			"route-review-comment" => "pull_request_review_comment",
			"route-pr-merged" => "pull_request",
			_ => "issue_comment",
		};
		let payload = fixture_json(&format!("phase3/{name}.payload.json"));
		let resolver = |_: &str, _: i64| Some("octo/widget#42".to_string());
		let got = decision_json(&github::route(
			event_type,
			&payload,
			&hs(&["octo/widget"]),
			"robogjc-bot",
			&hs(&["can1357"]),
			&hs(&["gjc-reviewer"]),
			Some(&resolver),
		));
		route_diffs.extend(diff_values(name, &py_case["decision"], &got));
	}
	surfaces.push(surface(
		"webhook-event-routing",
		"rust github::route vs python robogjc.github_events.route",
		py_routes.len(),
		route_diffs,
	));

	let phase1_script = r#"
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from robogjc.proxy_hmac import sign, verify
from robogjc.git_ops import redact_credentials
h=json.loads(Path(sys.argv[1]).read_text())
r=json.loads(Path(sys.argv[2]).read_text())
print(json.dumps({'hmac':[{'name':c['name'],'signature':sign(method=c['method'], path=c['path'], body=c['body'].encode(), key=c['key'].encode(), timestamp=c['timestamp'])[1], 'verify_valid':verify(method=c['method'], path=c['path'], body=c['body'].encode(), timestamp=c['timestamp'], signature=c['expected_signature'], key=c['key'].encode(), now=int(c['timestamp']))[0], 'verify_tampered':verify(method=c['method'], path=c['path'], body=(c['body'] + 'tamper').encode(), timestamp=c['timestamp'], signature=c['expected_signature'], key=c['key'].encode(), now=int(c['timestamp']))[0], 'verify_expired':verify(method=c['method'], path=c['path'], body=c['body'].encode(), timestamp=c['timestamp'], signature=c['expected_signature'], key=c['key'].encode(), now=int(c['timestamp']) + 31)[0]} for c in h['cases']], 'redaction':[{'name':c['name'],'redacted':redact_credentials(c['input'])} for c in r['cases']]}, sort_keys=True))
"#;
	let phase1_out = Command::new(py)
		.arg("-c")
		.arg(phase1_script)
		.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase1/hmac-vectors.json"))
		.arg(
			Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase1/redaction-vectors.json"),
		)
		.output()
		.unwrap();
	assert!(phase1_out.status.success(), "{}", String::from_utf8_lossy(&phase1_out.stderr));
	let py_phase1: Value = serde_json::from_slice(&phase1_out.stdout).unwrap();
	let mut hmac_diffs = Vec::new();
	for c in py_phase1["hmac"].as_array().unwrap() {
		let all = fixture_json("phase1/hmac-vectors.json");
		let f = all["cases"]
			.as_array()
			.unwrap()
			.iter()
			.find(|x| x["name"] == c["name"])
			.unwrap();
		let got = proxy::sign(
			f["method"].as_str().unwrap(),
			f["path"].as_str().unwrap(),
			f["body"].as_str().unwrap().as_bytes(),
			f["key"].as_str().unwrap().as_bytes(),
			f["timestamp"].as_str().unwrap(),
		);
		hmac_diffs.extend(diff_values(
			&format!("{}:sign", c["name"].as_str().unwrap()),
			&c["signature"],
			&Value::String(got),
		));
		let now = f["timestamp"].as_str().unwrap().parse::<i64>().unwrap();
		let valid = proxy::verify(
			f["method"].as_str().unwrap(),
			f["path"].as_str().unwrap(),
			f["body"].as_str().unwrap().as_bytes(),
			Some(f["timestamp"].as_str().unwrap()),
			Some(f["expected_signature"].as_str().unwrap()),
			f["key"].as_str().unwrap().as_bytes(),
			now,
			proxy::DEFAULT_SKEW_SECONDS,
		)
		.ok;
		hmac_diffs.extend(diff_values(
			&format!("{}:verify-valid", c["name"].as_str().unwrap()),
			&c["verify_valid"],
			&Value::Bool(valid),
		));
		let tampered_body = format!("{}tamper", f["body"].as_str().unwrap());
		let tampered = proxy::verify(
			f["method"].as_str().unwrap(),
			f["path"].as_str().unwrap(),
			tampered_body.as_bytes(),
			Some(f["timestamp"].as_str().unwrap()),
			Some(f["expected_signature"].as_str().unwrap()),
			f["key"].as_str().unwrap().as_bytes(),
			now,
			proxy::DEFAULT_SKEW_SECONDS,
		)
		.ok;
		hmac_diffs.extend(diff_values(
			&format!("{}:verify-tampered", c["name"].as_str().unwrap()),
			&c["verify_tampered"],
			&Value::Bool(tampered),
		));
		let expired = proxy::verify(
			f["method"].as_str().unwrap(),
			f["path"].as_str().unwrap(),
			f["body"].as_str().unwrap().as_bytes(),
			Some(f["timestamp"].as_str().unwrap()),
			Some(f["expected_signature"].as_str().unwrap()),
			f["key"].as_str().unwrap().as_bytes(),
			now + proxy::DEFAULT_SKEW_SECONDS + 1,
			proxy::DEFAULT_SKEW_SECONDS,
		)
		.ok;
		hmac_diffs.extend(diff_values(
			&format!("{}:verify-expired", c["name"].as_str().unwrap()),
			&c["verify_expired"],
			&Value::Bool(expired),
		));
	}
	surfaces.push(surface(
		"hmac-sign-verify-vectors",
		"rust proxy::sign/verify vs python proxy_hmac sign/verify",
		py_phase1["hmac"].as_array().unwrap().len() * 4,
		hmac_diffs,
	));
	let mut redaction_diffs = Vec::new();
	for c in py_phase1["redaction"].as_array().unwrap() {
		let all = fixture_json("phase1/redaction-vectors.json");
		let f = all["cases"]
			.as_array()
			.unwrap()
			.iter()
			.find(|x| x["name"] == c["name"])
			.unwrap();
		redaction_diffs.extend(diff_values(
			c["name"].as_str().unwrap(),
			&c["redacted"],
			&Value::String(redaction::redact_credentials(f["input"].as_str())),
		));
	}
	surfaces.push(surface(
		"credential-redaction",
		"rust redaction vs python robogjc.git_ops.redact_credentials",
		py_phase1["redaction"].as_array().unwrap().len(),
		redaction_diffs,
	));

	let rust_db = tmp.path().join("rust.sqlite");
	seed_rust_db(&rust_db);
	let py_db = tmp.path().join("python.sqlite");
	let seed = Command::new(py)
		.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase2/seed_python_era.py"))
		.arg(&py_db)
		.output()
		.unwrap();
	assert!(seed.status.success(), "{}", String::from_utf8_lossy(&seed.stderr));
	surfaces.push(surface(
		"db-row-shapes",
		"rust seeded sqlite rows vs python seed_python_era.py rows",
		1,
		diff_values("phase2-seed-round-trip", &sqlite_snapshot(&py_db), &sqlite_snapshot(&rust_db)),
	));

	let host_script = r#"
import json, robogjc.host_tools as ht
def strip_desc(v):
    if isinstance(v, dict):
        return {k: strip_desc(x) for k,x in v.items() if k != 'description'}
    if isinstance(v, list):
        return [strip_desc(x) for x in v]
    return v
print(json.dumps([{'name':t.name,'description':t.description,'inputSchema':strip_desc(t.parameters),'resultPolicy':{'type':'text','redactCredentials':True},'redactionHints':{'credentials':True}} for t in ht.build(None)], sort_keys=True))
"#;
	let host_out = Command::new(py)
		.arg("-c")
		.arg(host_script)
		.output()
		.unwrap();
	assert!(host_out.status.success(), "{}", String::from_utf8_lossy(&host_out.stderr));
	let py_host: Value = serde_json::from_slice(&host_out.stdout).unwrap();
	surfaces.push(surface(
		"host-tool-descriptor-schemas",
		"rust host_tools::descriptors vs python robogjc.host_tools.build",
		py_host.as_array().unwrap().len(),
		descriptor_diffs(
			"host-tool-descriptors",
			&py_host,
			&serde_json::to_value(host_tools::descriptors()).unwrap(),
		),
	));

	let mut worker_diffs = Vec::new();
	let mut worker_cases = 0;
	for name in ["start", "resume", "host-tool", "steer", "interrupt", "terminal-race"] {
		let text = fixture(&format!("phase7/{name}.ndjson"));
		let frames: Vec<Value> = text
			.lines()
			.map(|line| serde_json::from_str(line).unwrap())
			.collect();
		worker_cases += frames.len();
		let has_terminal = frames
			.iter()
			.any(|f| matches!(f["method"].as_str(), Some("turn/completed" | "turn/interrupt")));
		if !has_terminal {
			worker_diffs.push(json!({"case": name, "error": "missing terminal turn frame"}));
		}
	}
	surfaces.push(surface("app-server-worker-transcripts", "phase7 transcript fixtures shared by Rust replay harness; Python app-server worker oracle not exposed as a stable subprocess API", worker_cases, worker_diffs));

	write_report(surfaces);
}
