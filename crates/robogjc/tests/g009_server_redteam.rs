use std::{
	fs,
	net::SocketAddr,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use axum::Router;
use hmac::{Hmac, Mac};
use http::StatusCode;
use robogjc::{
	config::{SecretString, Settings},
	db::Database,
	github::GitHubClient,
	queue::WorkerPool,
	sandbox::LocalGitTransport,
	server::{self, AppState},
	worker::{AppServerHostToolRuntime, AppServerWorker, AppServerWorkerConfig},
};
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::net::TcpListener;

type HmacSha256 = Hmac<Sha256>;

fn test_settings(tmp: &Path) -> Settings {
	Settings {
		github_token: Some(SecretString::new("ghp_G009_PAT_MUST_NOT_LEAK")),
		github_webhook_secret: SecretString::new("g009-webhook-secret"),
		bot_login: "robogjc-bot".into(),
		git_author_name: Some("bot".into()),
		git_author_email: "bot@example.com".into(),
		repo_allowlist_raw: "octo/widget".into(),
		gh_proxy_url: None,
		gh_proxy_hmac_key: None,
		gh_proxy_bind_host: "0.0.0.0".into(),
		gh_proxy_bind_port: 8081,
		gh_proxy_max_body_bytes: 1048576,
		gh_proxy_git_timeout_seconds: 60.0,
		model: "model".into(),
		provider: None,
		thinking_level: "high".into(),
		max_concurrency: 1,
		task_timeout_seconds: 1.0,
		task_timeout_hard_grace_seconds: 1.0,
		request_timeout_seconds: 1.0,
		task_completion_max_reminders: 1,
		gjc_command: "gjc".into(),
		shutdown_drain_timeout_seconds: 0.1,
		shutdown_kill_timeout_seconds: 0.1,
		workspace_root: tmp.join("work"),
		sqlite_path: tmp.join("db.sqlite"),
		log_dir: tmp.join("logs"),
		bind_host: "127.0.0.1".into(),
		bind_port: 0,
		replay_token: Some(SecretString::new("G009_REPLAY_TOKEN_MUST_NOT_LEAK")),
		rate_limit_window_seconds: 3600.0,
		rate_limit_default: 100,
		rate_limit_contributor: 100,
		rate_limit_unlimited_raw: "".into(),
		maintainer_logins_raw: "maint".into(),
		reviewer_bots_raw: "reviewbot".into(),
		question_autoclose_enabled: false,
		question_autoclose_hours: 4.0,
		question_autoclose_scan_seconds: 60.0,
		natives_cache_enabled: false,
		natives_cache_root: tmp.join("cache"),
		natives_cache_max_entries_per_repo: 8,
		natives_cache_max_bytes: 1,
		natives_cache_gc_interval_seconds: 3600.0,
	}
}

fn build_state(tmp: &Path) -> (AppState, Arc<Database>) {
	let cfg = test_settings(tmp);
	cfg.ensure_paths().unwrap();
	let db = Arc::new(Database::open(&cfg.sqlite_path).unwrap());
	let github = Arc::new(
		GitHubClient::with_base_url("ghp_G009_PAT_MUST_NOT_LEAK", "http://127.0.0.1:9").unwrap(),
	);
	let runtime = AppServerHostToolRuntime {
		db: db.clone(),
		github: github.clone(),
		git_transport: Arc::new(LocalGitTransport::default()),
		settings: Some(cfg.clone()),
		author_name: "bot".into(),
		author_email: cfg.git_author_email.clone(),
	};
	let worker = Arc::new(AppServerWorker::new(
		AppServerWorkerConfig { hard_timeout: Duration::from_millis(10), ..Default::default() },
		runtime,
	));
	let pool = Arc::new(WorkerPool::new(db.clone(), worker, 1, None));
	(AppState::new(cfg, db.clone(), github, pool), db)
}

async fn spawn_live(app: Router) -> SocketAddr {
	let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let addr = listener.local_addr().unwrap();
	tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
	addr
}

fn signature(body: &[u8]) -> String {
	let mut mac = HmacSha256::new_from_slice(b"g009-webhook-secret").unwrap();
	mac.update(body);
	let bytes = mac.finalize().into_bytes();
	format!("sha256={}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn issue_comment_body() -> Vec<u8> {
	serde_json::to_vec(&json!({
        "action":"created",
        "repository":{"full_name":"octo/widget"},
        "comment":{"user":{"login":"alice","type":"User"},"body":"please help","author_association":"CONTRIBUTOR"},
        "issue":{"number":4}
    })).unwrap()
}

async fn webhook(
	client: &reqwest::Client,
	base: &str,
	delivery: &str,
	event: &str,
	body: Vec<u8>,
	sig: Option<String>,
) -> reqwest::Response {
	let mut req = client
		.post(format!("{base}/webhook/github"))
		.header("x-github-event", event)
		.header("x-github-delivery", delivery)
		.header("content-type", "application/json")
		.body(body);
	if let Some(sig) = sig {
		req = req.header("x-hub-signature-256", sig);
	}
	req.send().await.unwrap()
}

fn no_secret(text: &str) -> bool {
	!text.contains("G009_REPLAY_TOKEN_MUST_NOT_LEAK") && !text.contains("ghp_G009_PAT_MUST_NOT_LEAK")
}

#[tokio::test]
async fn g009_live_server_security_redteam_receipt() {
	let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let repo_root = manifest_dir
		.parent()
		.unwrap()
		.parent()
		.unwrap()
		.to_path_buf();
	let artifact_dir = repo_root.join("artifacts/robogjc/qa");
	fs::create_dir_all(&artifact_dir).unwrap();
	let artifact_path = artifact_dir.join("g009-server-redteam-report.json");

	let tmp = tempfile::tempdir().unwrap();
	let (state, db) = build_state(tmp.path());
	fs::write(state.settings.log_dir.join("robogjc.log.jsonl"), "{not json}\n{\"msg\":\"ok\"}\n")
		.unwrap();
	let addr = spawn_live(server::create_app(state.clone())).await;
	let base = format!("http://{addr}");
	let client = reqwest::Client::new();
	let mut cases = Vec::new();
	let mut leak_text = String::new();

	let body = issue_comment_body();
	for (name, sig, expected) in [
		("webhook missing HMAC rejected", None, StatusCode::UNAUTHORIZED),
		("webhook bad HMAC rejected", Some("sha256=00".to_string()), StatusCode::UNAUTHORIZED),
		(
			"webhook stale/replayed-body HMAC rejected",
			Some(signature(br#"{\"old\":true}"#)),
			StatusCode::UNAUTHORIZED,
		),
	] {
		let r = webhook(&client, &base, "bad-delivery", "issue_comment", body.clone(), sig).await;
		let status = r.status();
		let text = r.text().await.unwrap();
		leak_text.push_str(&text);
		cases.push(json!({"name":name,"status":status.as_u16(),"passed":status == expected,"secretFree":no_secret(&text)}));
	}

	let r =
		webhook(&client, &base, "delivery-1", "issue_comment", body.clone(), Some(signature(&body)))
			.await;
	let status = r.status();
	let text = r.text().await.unwrap();
	leak_text.push_str(&text);
	cases.push(json!({"name":"valid signed webhook accepted","status":status.as_u16(),"passed":status == StatusCode::ACCEPTED,"secretFree":no_secret(&text)}));

	let before = db.list_events(100).unwrap().len();
	let r =
		webhook(&client, &base, "delivery-1", "issue_comment", body.clone(), Some(signature(&body)))
			.await;
	let after = db.list_events(100).unwrap().len();
	cases.push(json!({"name":"duplicate delivery deduped","status":r.status().as_u16(),"eventsBefore":before,"eventsAfter":after,"passed":before == 1 && after == 1}));

	for (name, path, body, method) in [
		(
			"manual trigger missing token",
			"/api/trigger",
			json!({"mode":"retry","delivery_id":"delivery-1"}),
			"post",
		),
		(
			"manual trigger wrong token",
			"/api/trigger",
			json!({"mode":"retry","delivery_id":"delivery-1"}),
			"post-wrong",
		),
		("replay missing token", "/replay?delivery_id=delivery-1", json!({}), "post"),
		("cancel missing token", "/api/cancel", json!({"delivery_id":"delivery-1"}), "post"),
		("cancel wrong token", "/api/cancel", json!({"delivery_id":"delivery-1"}), "post-wrong"),
	] {
		let mut req = client.post(format!("{base}{path}")).json(&body);
		if method == "post-wrong" {
			req = req.header("x-robogjc-replay-token", "wrong");
		}
		let r = req.send().await.unwrap();
		let status = r.status();
		let text = r.text().await.unwrap();
		leak_text.push_str(&text);
		cases.push(json!({"name":name,"status":status.as_u16(),"passed":status == StatusCode::UNAUTHORIZED,"secretFree":no_secret(&text)}));
	}

	let r = client.get(format!("{base}/")).send().await.unwrap();
	let html = r.text().await.unwrap();
	cases.push(json!({"name":"dashboard index sentinel substitution hides replay token","passed":html.contains("replayEnabled") && no_secret(&html)}));

	let malformed = b"{".to_vec();
	let r = webhook(
		&client,
		&base,
		"malformed",
		"issue_comment",
		malformed.clone(),
		Some(signature(&malformed)),
	)
	.await;
	let text = r.text().await.unwrap();
	leak_text.push_str(&text);
	cases.push(json!({"name":"malformed webhook JSON rejected","status":400,"passed":text.contains("invalid json"),"secretFree":no_secret(&text)}));

	let huge = vec![b'a'; 2_200_000];
	let r =
		webhook(&client, &base, "oversize", "issue_comment", huge.clone(), Some(signature(&huge)))
			.await;
	let status = r.status();
	let text = r.text().await.unwrap_or_default();
	leak_text.push_str(&text);
	cases.push(json!({"name":"oversize webhook body rejected before enqueue","status":status.as_u16(),"passed":status == StatusCode::PAYLOAD_TOO_LARGE,"secretFree":no_secret(&text)}));

	let unknown =
		serde_json::to_vec(&json!({"action":"created","repository":{"full_name":"octo/widget"}}))
			.unwrap();
	let before = db.list_events(100).unwrap().len();
	let r = webhook(
		&client,
		&base,
		"unknown-event",
		"deployment",
		unknown.clone(),
		Some(signature(&unknown)),
	)
	.await;
	let after_rows = db.list_events(100).unwrap();
	cases.push(json!({"name":"unsupported event acknowledged without queued work","status":r.status().as_u16(),"eventsBefore":before,"eventsAfter":after_rows.len(),"storedState":after_rows.iter().find(|e| e.delivery_id == "unknown-event").map(|e| e.state.clone()),"passed":r.status() == StatusCode::ACCEPTED && after_rows.iter().any(|e| e.delivery_id == "unknown-event" && e.state == "skipped")}));

	for path in ["/healthz", "/readyz"] {
		let r = client.get(format!("{base}{path}")).send().await.unwrap();
		let status = r.status();
		let v: Value = r.json().await.unwrap();
		cases.push(json!({"name":format!("{path} semantics"),"status":status.as_u16(),"body":v,"passed":status == StatusCode::OK && v["status"].as_str().is_some()}));
	}

	let r = client
		.get(format!("{base}/api/logs?limit=5"))
		.send()
		.await
		.unwrap();
	let logs: Value = r.json().await.unwrap();
	cases.push(json!({"name":"log endpoint recovers raw malformed lines","passed":logs["entries"].as_array().unwrap().iter().any(|e| e["level"] == "RAW")}));
	let r = client
		.get(format!("{base}/static/%2e%2e/%2e%2e/Cargo.toml"))
		.send()
		.await
		.unwrap();
	cases.push(json!({"name":"static path traversal denied","status":r.status().as_u16(),"passed":r.status() == StatusCode::NOT_FOUND || r.status() == StatusCode::BAD_REQUEST}));

	let logs_text = client
		.get(format!("{base}/api/logs?limit=20"))
		.send()
		.await
		.unwrap()
		.text()
		.await
		.unwrap();
	leak_text.push_str(&logs_text);
	cases.push(json!({"name":"PAT/replay token absent from error bodies and log endpoint","passed":no_secret(&leak_text)}));

	let passed = cases.iter().filter(|c| c["passed"] == true).count();
	let failed = cases.len() - passed;
	let report = json!({
		 "schemaVersion":1,
		 "kind":"black-box-api-receipt",
		 "cases":cases,
		 "commands":[{"cmd":["cargo","test","-p","robogjc","--test","g009_server_redteam","--","--nocapture"],"purpose":"live 127.0.0.1:0 axum security-route red team"}],
		 "summary":{"passed":passed,"failed":failed,"pythonComparison":"not_run: Python server fixture was not required to find Rust security-route regressions in these black-box cases"}
	});
	fs::write(&artifact_path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
	assert_eq!(failed, 0, "red-team failures: {}", serde_json::to_string_pretty(&report).unwrap());
}
