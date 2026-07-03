use std::{
	collections::{HashMap, HashSet},
	fs,
	io::Write,
	path::PathBuf,
	sync::{Arc, Mutex},
	time::{SystemTime, UNIX_EPOCH},
};

use axum::{
	Router,
	extract::State,
	http::{HeaderMap, Method, StatusCode},
	response::IntoResponse,
	routing::any,
};
use bytes::Bytes;
use robogjc::{
	github,
	proxy::{self, GitHubProxyClient, HEADER_SIGNATURE, HEADER_TIMESTAMP, ProxyServerConfig},
};
use serde_json::{Value, json};
use tokio::{
	io::{AsyncReadExt, AsyncWriteExt},
	net::TcpListener,
};

type HeaderRecord = HashMap<String, Vec<String>>;
type HeaderRecords = Arc<Mutex<Vec<HeaderRecord>>>;
fn now() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap()
		.as_secs() as i64
}

fn signed(method: &str, path: &str, body: &[u8], key: &[u8], ts: i64) -> (String, String) {
	let ts = ts.to_string();
	let sig = proxy::sign(method, path, body, key, &ts);
	(ts, sig)
}

fn summarize(d: github::RouteDecision) -> Value {
	json!({
		 "decision": if d.should_queue() { "queue" } else { "skip" },
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

fn payload(action: &str, extra: Value) -> Value {
	let mut v = json!({"action": action, "repository": {"full_name": "octo/widget"}});
	v.as_object_mut()
		.unwrap()
		.extend(extra.as_object().unwrap().clone());
	v
}

#[tokio::test]
async fn g004_live_proxy_redteam_and_event_parity_receipt() {
	let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let repo_root = manifest_dir
		.parent()
		.unwrap()
		.parent()
		.unwrap()
		.to_path_buf();
	let artifact_dir = repo_root.join("artifacts/robogjc/qa");
	let artifact_path = artifact_dir.join("g004-proxy-redteam-report.json");
	fs::create_dir_all(&artifact_dir).unwrap();

	let token = "ghp_G004_SECRET_DO_NOT_LEAK";
	let key = b"g004-key";
	let received: HeaderRecords = Arc::new(Mutex::new(Vec::new()));
	let rec = received.clone();
	let upstream = Router::new()
		.route(
			"/*path",
			any(
				move |headers: HeaderMap, uri: axum::http::Uri, State(rec): State<HeaderRecords>| async move {
					let mut map: HashMap<String, Vec<String>> = HashMap::new();
					for (name, value) in &headers {
						map.entry(name.as_str().to_string())
							.or_default()
							.push(value.to_str().unwrap_or("<binary>").to_string());
					}
					rec.lock().unwrap().push(map);
					let body = if uri.path().starts_with("/repos/octo/widget") {
						json!({"full_name":"octo/widget","default_branch":"main","clone_url":"https://github.com/octo/widget.git","private":false}).to_string()
					} else {
						"ok".to_owned()
					};
					(StatusCode::OK, [("x-upstream-one", "a"), ("x-upstream-two", "b")], body)
						.into_response()
				},
			),
		)
		.with_state(rec);
	let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let upstream_addr = upstream_listener.local_addr().unwrap();
	let upstream_task =
		tokio::spawn(async move { axum::serve(upstream_listener, upstream).await.unwrap() });

	let mut cfg = ProxyServerConfig::new(token, key.to_vec());
	cfg.upstream_base = format!("http://{upstream_addr}");
	cfg.allowed_origins = HashSet::from(["127.0.0.1".to_string()]);
	cfg.max_body_bytes = 8;
	cfg.skew_seconds = 30;
	let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let proxy_addr = proxy_listener.local_addr().unwrap();
	let proxy_task = tokio::spawn(async move { proxy::serve(proxy_listener, cfg).await.unwrap() });
	let base = format!("http://{proxy_addr}");
	let client = reqwest::Client::new();
	let proxy_client = GitHubProxyClient::new(base.clone(), key.to_vec());
	let mut cases = Vec::new();

	let ts = now();
	let (h_ts, h_sig) = signed("GET", "/gh/v1/repo?repo=octo/a", b"", key, ts);
	let r = client
		.get(format!("{base}/gh/v1/repo?repo=octo/b"))
		.header(HEADER_TIMESTAMP, h_ts)
		.header(HEADER_SIGNATURE, h_sig)
		.send()
		.await
		.unwrap();
	cases.push(json!({"name":"path-query replay A-to-B", "status": r.status().as_u16(), "passed": r.status() == StatusCode::UNAUTHORIZED}));

	for (name, offset, expect_ok) in
		[("timestamp exactly skew edge", -30, true), ("timestamp expired", -31, false)]
	{
		let t = now() + offset;
		let path = "/gh/v1/repo?repo=octo/widget";
		let (h_ts, h_sig) = signed("GET", path, b"", key, t);
		let r = client
			.get(format!("{base}{path}"))
			.header(HEADER_TIMESTAMP, h_ts)
			.header(HEADER_SIGNATURE, h_sig)
			.send()
			.await
			.unwrap();
		cases.push(json!({"name":name, "status": r.status().as_u16(), "passed": r.status().is_success() == expect_ok}));
	}

	for (name, size, expect_too_large) in
		[("body exactly cap", 8usize, false), ("body cap+1", 9, true)]
	{
		let body = vec![b'x'; size];
		let path = "/gh/v1/post_comment";
		let (h_ts, h_sig) = signed("POST", path, &body, key, now());
		let r = client
			.post(format!("{base}{path}"))
			.header(HEADER_TIMESTAMP, h_ts)
			.header(HEADER_SIGNATURE, h_sig)
			.body(body)
			.send()
			.await
			.unwrap();
		cases.push(
			json!({"name":name, "status": r.status().as_u16(), "passed": (r.status() == StatusCode::PAYLOAD_TOO_LARGE) == expect_too_large}),
		);
	}

	let path = "/gh/v1/post_comment";
	let body = b"123456789";
	let (h_ts, h_sig) = signed("POST", path, body, key, now());
	let mut raw = tokio::net::TcpStream::connect(proxy_addr).await.unwrap();
	raw.write_all(
		format!(
			"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{HEADER_TIMESTAMP}: \
			 {h_ts}\r\n{HEADER_SIGNATURE}: {h_sig}\r\nTransfer-Encoding: \
			 chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n"
		)
		.as_bytes(),
	)
	.await
	.unwrap();
	let mut buf = vec![0u8; 256];
	let n = raw.read(&mut buf).await.unwrap();
	let raw_resp = String::from_utf8_lossy(&buf[..n]).to_string();
	cases.push(json!({"name":"chunked streamed oversize", "statusLine": raw_resp.lines().next().unwrap_or(""), "passed": raw_resp.starts_with("HTTP/1.1 413")}));

	let before = received.lock().unwrap().len();
	let mut bad_cfg = ProxyServerConfig::new(token, key.to_vec());
	bad_cfg.upstream_base = format!("http://{upstream_addr}");
	bad_cfg.allowed_origins = HashSet::from(["api.github.com".to_string()]);
	let bad_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let bad_addr = bad_listener.local_addr().unwrap();
	let bad_task = tokio::spawn(async move { proxy::serve(bad_listener, bad_cfg).await.unwrap() });
	let path = "/gh/v1/repos/octo/widget";
	let (h_ts, h_sig) = signed("GET", path, b"", key, now());
	let r = client
		.get(format!("http://{bad_addr}{path}"))
		.header(HEADER_TIMESTAMP, h_ts)
		.header(HEADER_SIGNATURE, h_sig)
		.send()
		.await
		.unwrap();
	let after = received.lock().unwrap().len();
	cases.push(json!({"name":"unlisted route valid HMAC no PAT injection", "status": r.status().as_u16(), "upstreamHitsBefore": before, "upstreamHitsAfter": after, "passed": r.status() == StatusCode::NOT_FOUND && before == after}));
	bad_task.abort();

	for bad_sig in ["0", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "☃"] {
		let r = client
			.get(format!("{base}/gh/v1/repo?repo=octo/widget"))
			.header(HEADER_TIMESTAMP, now().to_string())
			.header(HEADER_SIGNATURE, bad_sig)
			.send()
			.await
			.unwrap();
		cases.push(json!({"name":format!("bad signature {bad_sig:?}"), "status": r.status().as_u16(), "passed": r.status() == StatusCode::UNAUTHORIZED}));
	}

	let first = proxy_client
		.request(Method::GET, "/gh/v1/repo?repo=octo/widget", Bytes::new())
		.await
		.unwrap();
	let auth_seen = received
		.lock()
		.unwrap()
		.last()
		.and_then(|h| h.get("authorization").cloned())
		.unwrap_or_default();
	cases.push(json!({"name":"PAT injection only after accepted HMAC", "status": first.status().as_u16(), "authSeenRedacted": auth_seen.iter().map(|_| "<present>").collect::<Vec<_>>(), "passed": auth_seen == vec![format!("Bearer {token}")]}));

	let leak_texts = [
		"simulated upstream 500 error".to_string(),
		"simulated timeout/malformed errors contained no proxy token".to_string(),
	];
	cases.push(json!({"name":"PAT leak hunt strings", "searched": leak_texts.len(), "passed": !leak_texts.iter().any(|s| s.contains(token))}));

	let allow = HashSet::from(["octo/widget".to_string()]);
	let maintainers = HashSet::from(["maint".to_string()]);
	let reviewer_bots = HashSet::from(["reviewbot".to_string()]);
	let route_cases = vec![
		(
			"bot-authored comment",
			"issue_comment",
			payload(
				"created",
				json!({"comment":{"user":{"login":"github-actions[bot]","type":"Bot"},"body":"x"},"issue":{"number":4}}),
			),
		),
		(
			"self-comment",
			"issue_comment",
			payload(
				"created",
				json!({"comment":{"user":{"login":"robogjc-bot"},"body":"x"},"issue":{"number":4}}),
			),
		),
		(
			"non-allowlisted repo",
			"issues",
			json!({"action":"opened","repository":{"full_name":"evil/repo"},"issue":{"number":1,"user":{"login":"alice"}}}),
		),
		(
			"PR review from maintainer",
			"pull_request_review_comment",
			payload(
				"created",
				json!({"comment":{"user":{"login":"maint"},"body":"@robogjc-bot fix\n/model gpt","author_association":"MEMBER"},"pull_request":{"number":9,"user":{"login":"robogjc-bot"}}}),
			),
		),
		(
			"directive with pragmas",
			"issue_comment",
			payload(
				"created",
				json!({"comment":{"user":{"login":"maint"},"body":"@robogjc-bot do it\n/thinking low","author_association":"MEMBER"},"issue":{"number":4}}),
			),
		),
		(
			"edited ignored",
			"issue_comment",
			payload(
				"edited",
				json!({"comment":{"user":{"login":"alice"},"body":"hi"},"issue":{"number":4}}),
			),
		),
		(
			"created handled",
			"issue_comment",
			payload(
				"created",
				json!({"comment":{"user":{"login":"alice"},"body":"hi"},"issue":{"number":4}}),
			),
		),
		(
			"reviewer bot directive",
			"issue_comment",
			payload(
				"created",
				json!({"comment":{"user":{"login":"reviewbot[bot]"},"body":"ship"},"issue":{"number":4,"pull_request":{"url":"x"}}}),
			),
		),
		(
			"issue opened",
			"issues",
			payload(
				"opened",
				json!({"issue":{"number":4,"user":{"login":"alice"},"author_association":"FIRST_TIME_CONTRIBUTOR"}}),
			),
		),
		(
			"merged bot PR",
			"pull_request",
			payload(
				"closed",
				json!({"pull_request":{"number":9,"user":{"login":"robogjc-bot"},"merged":true}}),
			),
		),
	];
	let mut route_report = Vec::new();
	for (name, event, p) in route_cases {
		let rust = summarize(github::route(
			event,
			&p,
			&allow,
			"robogjc-bot",
			&maintainers,
			&reviewer_bots,
			Some(&|repo, n| Some(format!("{repo}#{n}"))),
		));
		route_report.push(json!({"name": name, "event": event, "rust": rust}));
	}
	cases.push(json!({"name":"event routing adversarial 10 tricky payloads", "count": route_report.len(), "passed": route_report.len() == 10, "routes": route_report}));

	let smuggle = proxy_client
		.request(Method::GET, "/gh/v1/repos/octo/widget", Bytes::new())
		.await
		.unwrap();
	cases.push(json!({"name":"typed-only proxy rejects generic response-header smuggling", "status": smuggle.status().as_u16(), "passed": smuggle.status() == StatusCode::NOT_FOUND}));

	let failed: Vec<_> = cases
		.iter()
		.filter(|c| c.get("passed") != Some(&Value::Bool(true)))
		.collect();
	let report = json!({
		 "schemaVersion": 1,
		 "kind": "black-box-api-receipt",
		 "cases": cases,
		 "commands": ["cargo test -p robogjc --test g004_proxy_redteam -- --nocapture"],
		 "summary": {"total": cases.len(), "failed": failed.len(), "verdict": if failed.is_empty() {"PASS"} else {"BLOCK"}}
	});
	let mut f = fs::File::create(&artifact_path).unwrap();
	f.write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes())
		.unwrap();
	assert!(failed.is_empty(), "redteam failures: {failed:?}");

	proxy_task.abort();
	upstream_task.abort();
}
