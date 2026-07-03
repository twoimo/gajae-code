use std::{
	collections::HashSet,
	fmt::Write as _,
	net::SocketAddr,
	sync::{Arc, Mutex},
};

use axum::{
	Router,
	body::Bytes,
	extract::State,
	http::{Method, StatusCode, Uri},
	response::{IntoResponse, Response},
	routing::any,
};
use hmac::Mac;
use robogjc::github::{
	GitHubBackend, GitHubClient, OpenPullRequest, extract_mention, is_maintainer, rate_limit_cap,
	route, verify_signature,
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

type IssueResolver = dyn Fn(&str, i64) -> Option<String>;
type RouteCase<'a> =
	(&'a str, &'a str, Value, HashSet<String>, HashSet<String>, Option<&'a IssueResolver>);
type MockCall = (Method, String, Value);
type MockHeaders = Vec<(String, String)>;
type MockResponse = (StatusCode, Value, MockHeaders);
fn hs(values: &[&str]) -> HashSet<String> {
	values.iter().map(|s| s.to_string()).collect()
}
fn allow() -> HashSet<String> {
	hs(&["octo/widget"])
}
const fn bot() -> &'static str {
	"robogjc-bot"
}
fn base(action: &str, obj: Value) -> Value {
	let mut v = json!({"action": action, "repository": {"full_name": "octo/widget"}});
	v.as_object_mut()
		.unwrap()
		.extend(obj.as_object().unwrap().clone());
	v
}
fn decision_json(d: &robogjc::github::RouteDecision) -> Value {
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
fn fixture_payload(name: &str) -> Value {
	let payload_path =
		format!("{}/tests/fixtures/phase3/{name}.payload.json", env!("CARGO_MANIFEST_DIR"));
	serde_json::from_str(&std::fs::read_to_string(payload_path).unwrap()).unwrap()
}

fn assert_fixture(name: &str, got: Value) {
	let path = format!("fixtures/phase3/{name}.expected.json");
	let expected: Value = serde_json::from_str(include_str!(concat!(
		env!("CARGO_MANIFEST_DIR"),
		"/tests/fixtures/phase3/route-issue-opened.expected.json"
	)))
	.unwrap();
	if name == "route-issue-opened" {
		assert_eq!(got, expected);
		return;
	}
	let raw =
		std::fs::read_to_string(format!("{}/tests/{path}", env!("CARGO_MANIFEST_DIR"))).unwrap();
	assert_eq!(got, serde_json::from_str::<Value>(&raw).unwrap(), "{name}");
}

#[test]
fn github_backend_trait_covers_python_protocol() {
	fn assert_backend<T: GitHubBackend>() {}
	assert_backend::<GitHubClient>();
}

#[test]
fn python_github_events_signature_mention_maintainer_and_rate_limit_cases() {
	let body = br#"{"x":1}"#;
	let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(b"shh").unwrap();
	hmac::Mac::update(&mut mac, body);
	let sig = mac
		.finalize()
		.into_bytes()
		.iter()
		.fold(String::new(), |mut out, b| {
			let _ = write!(out, "{b:02x}");
			out
		});
	assert!(verify_signature("shh", body, Some(&format!("sha256={sig}"))));
	assert!(!verify_signature("shh", b"{}", None));
	assert!(!verify_signature("shh", b"{}", Some("")));
	assert!(!verify_signature("shh", b"{}", Some("md5=deadbeef")));
	assert!(!verify_signature("wrong", body, Some(&format!("sha256={sig}"))));

	assert_eq!(
		extract_mention(Some("hey @robogjc-bot please look"), bot()).as_deref(),
		Some("hey please look")
	);
	assert_eq!(extract_mention(Some("@robogjc-bot do X"), bot()).as_deref(), Some("do X"));
	assert_eq!(extract_mention(Some("hello there"), bot()), None);
	assert_eq!(extract_mention(None, bot()), None);
	assert_eq!(extract_mention(Some(""), bot()), None);
	assert_eq!(extract_mention(Some("yo @ROBOGJC-BOT"), bot()).as_deref(), Some("yo"));
	assert_eq!(extract_mention(Some("@robogjc-bot-helper hi"), bot()), None);
	assert_eq!(
		extract_mention(Some("@robogjc-bot one, then @robogjc-bot two"), bot()).as_deref(),
		Some("one, then two")
	);

	assert!(is_maintainer(Some("can1357"), None, &hs(&["can1357"])));
	assert!(is_maintainer(Some("Can1357"), Some("NONE"), &hs(&["can1357"])));
	for assoc in ["OWNER", "MEMBER", "COLLABORATOR"] {
		assert!(is_maintainer(Some("anyone"), Some(assoc), &hs(&[])));
	}
	assert!(!is_maintainer(Some("alice"), Some("CONTRIBUTOR"), &hs(&[])));
	assert!(!is_maintainer(Some("alice"), None, &hs(&[])));
	assert!(is_maintainer(None, Some("OWNER"), &hs(&[])));

	assert_eq!(rate_limit_cap("can1357", Some("NONE"), &hs(&["can1357"]), 3, 10), None);
	assert_eq!(rate_limit_cap("Can1357", None, &hs(&["can1357"]), 3, 10), None);
	for assoc in ["OWNER", "MEMBER", "COLLABORATOR"] {
		assert_eq!(rate_limit_cap("stranger", Some(assoc), &hs(&[]), 3, 10), None);
	}
	assert_eq!(rate_limit_cap("alice", Some("CONTRIBUTOR"), &hs(&[]), 3, 10), Some(10));
	for assoc in [None, Some("NONE"), Some("FIRST_TIME_CONTRIBUTOR"), Some("FIRST_TIMER")] {
		assert_eq!(rate_limit_cap("alice", assoc, &hs(&[]), 3, 10), Some(3));
	}
}

#[test]
fn python_github_events_route_cases_match_fixtures() {
	let cases: Vec<RouteCase<'_>> = vec![
		(
			"route-issue-opened",
			"issues",
			base(
				"opened",
				json!({"issue":{"number":4,"user":{"login":"alice"},"author_association":"FIRST_TIME_CONTRIBUTOR"}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-disallowed-repo",
			"issues",
			json!({"action":"opened","issue":{"number":1},"repository":{"full_name":"other/repo"}}),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-self-comment",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":bot()},"body":"hi"},"issue":{"number":4}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-bot-suffix-comment",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"github-actions[bot]","type":"Bot"},"body":"ci ran"},"issue":{"number":4}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-user-type-bot",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"renovate","type":"Bot"},"body":"deps"},"issue":{"number":4}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-comment",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"alice"},"body":"hi"},"issue":{"number":4}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-pr-conversation",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"alice"},"body":"looks good"},"issue":{"number":9,"pull_request":{"url":"x"}}}),
			),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-pr-conversation-fallback",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"alice"},"body":"hi"},"issue":{"number":9,"pull_request":{"url":"x"}}}),
			),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| None),
		),
		(
			"route-review-comment",
			"pull_request_review_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"alice"},"body":"nit"},"pull_request":{"number":9,"user":{"login":bot()}}}),
			),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-review-comment-not-ours",
			"pull_request_review_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"alice"},"body":"nit"},"pull_request":{"number":9,"user":{"login":"someone-else"}}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-review-comment-fallback",
			"pull_request_review_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"alice"},"body":"nit"},"pull_request":{"number":9,"user":{"login":bot()}}}),
			),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| None),
		),
		(
			"route-pr-merged",
			"pull_request",
			base("closed", json!({"pull_request":{"number":9,"user":{"login":bot()},"merged":true}})),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-pr-merged-fallback",
			"pull_request",
			base("closed", json!({"pull_request":{"number":9,"user":{"login":bot()},"merged":true}})),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| None),
		),
		(
			"route-pr-closed-unmerged",
			"pull_request",
			base("closed", json!({"pull_request":{"number":9,"user":{"login":bot()},"merged":false}})),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-skips-pr-issues-event",
			"issues",
			base("opened", json!({"issue":{"number":4,"pull_request":{"url":"x"}}})),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-comment-association",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"bob"},"body":"hi","author_association":"CONTRIBUTOR"},"issue":{"number":4}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-owner-directive",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"can1357"},"author_association":"OWNER","body":"@robogjc-bot please refactor X"},"issue":{"number":9}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-maintainer-list-directive",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"can1357"},"body":"@robogjc-bot do it"},"issue":{"number":9}}),
			),
			hs(&["can1357"]),
			hs(&[]),
			None,
		),
		(
			"route-random-mention-no-directive",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"stranger"},"author_association":"NONE","body":"@robogjc-bot please refactor X"},"issue":{"number":9}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-maintainer-without-mention",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"can1357"},"author_association":"OWNER","body":"looks good to me"},"issue":{"number":9}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-pr-conversation-directive",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"can1357"},"author_association":"OWNER","body":"@robogjc-bot change the indentation in foo.py"},"issue":{"number":50,"pull_request":{"url":"x"}}}),
			),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-review-comment-directive",
			"pull_request_review_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"can1357"},"author_association":"OWNER","body":"@robogjc-bot use a generator here"},"pull_request":{"number":50,"user":{"login":bot()}}}),
			),
			hs(&[]),
			hs(&[]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-reviewer-bot-comment",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"chatgpt-codex-connector[bot]","type":"Bot"},"body":"Found two issues in the diff: ..."},"issue":{"number":9,"pull_request":{"url":"x"}}}),
			),
			hs(&[]),
			hs(&["chatgpt-codex-connector"]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-reviewer-bot-review-comment",
			"pull_request_review_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"chatgpt-codex-connector[bot]","type":"Bot"},"body":"This branch leaks memory."},"pull_request":{"number":50,"user":{"login":bot()}}}),
			),
			hs(&[]),
			hs(&["chatgpt-codex-connector"]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-random-bot-skipped",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"renovate","type":"Bot"},"body":"deps"},"issue":{"number":9}}),
			),
			hs(&[]),
			hs(&["chatgpt-codex-connector"]),
			None,
		),
		(
			"route-reviewer-bot-case",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"ChatGPT-Codex-Connector","type":"Bot"},"body":"feedback"},"issue":{"number":9,"pull_request":{"url":"x"}}}),
			),
			hs(&[]),
			hs(&["chatgpt-codex-connector"]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-maintainer-pragmas",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"can1357"},"author_association":"OWNER","body":"@robogjc-bot /model gpt /thinking low\nrefactor X"},"issue":{"number":9}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
		(
			"route-reviewer-bot-pragmas",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"chatgpt-codex-connector","type":"Bot"},"body":"/model claude\nLeak in foo()"},"issue":{"number":9,"pull_request":{"url":"x"}}}),
			),
			hs(&[]),
			hs(&["chatgpt-codex-connector"]),
			Some(&|_, _| Some("octo/widget#42".to_string())),
		),
		(
			"route-non-directive-no-pragmas",
			"issue_comment",
			base(
				"created",
				json!({"comment":{"user":{"login":"stranger"},"author_association":"NONE","body":"/model gpt\nhello"},"issue":{"number":9}}),
			),
			hs(&[]),
			hs(&[]),
			None,
		),
	];
	for (name, event, _inline_payload, maintainers, reviewer_bots, resolver) in cases {
		let payload = fixture_payload(name);
		let d = route(event, &payload, &allow(), bot(), &maintainers, &reviewer_bots, resolver);
		assert_fixture(name, decision_json(&d));
	}
}

#[derive(Clone)]
struct MockState {
	calls:     Arc<Mutex<Vec<MockCall>>>,
	responses: Arc<Mutex<Vec<MockResponse>>>,
}
async fn mock_handler(
	State(state): State<MockState>,
	method: Method,
	uri: Uri,
	body: Bytes,
) -> Response {
	let path = uri
		.path_and_query()
		.map_or_else(|| uri.path(), |pq| pq.as_str())
		.to_string();
	let body_json = if body.is_empty() {
		Value::Null
	} else {
		serde_json::from_slice(&body).unwrap()
	};
	state.calls.lock().unwrap().push((method, path, body_json));
	let (status, json, headers) = state.responses.lock().unwrap().remove(0);
	let mut resp = (status, axum::Json(json)).into_response();
	for (k, v) in headers {
		resp
			.headers_mut()
			.insert(k.parse::<axum::http::HeaderName>().unwrap(), v.parse().unwrap());
	}
	resp
}
async fn mock_client(responses: Vec<MockResponse>) -> (GitHubClient, Arc<Mutex<Vec<MockCall>>>) {
	let state = MockState {
		calls:     Arc::new(Mutex::new(Vec::new())),
		responses: Arc::new(Mutex::new(responses)),
	};
	let calls = state.calls.clone();
	let app = Router::new()
		.route("/*path", any(mock_handler))
		.with_state(state);
	let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
	let addr: SocketAddr = listener.local_addr().unwrap();
	tokio::spawn(async move {
		let _ = axum::serve(listener, app).await;
	});
	(GitHubClient::with_base_url("tok", format!("http://{addr}")).unwrap(), calls)
}

#[tokio::test]
async fn python_github_client_rest_cases_against_local_mock_server() {
	let repo_payload = json!({"full_name":"new/repo","default_branch":"main","clone_url":"https://github.com/new/repo.git","private":false});
	let (client, _) =
		mock_client(vec![(StatusCode::NOT_FOUND, json!({"message":"Not Found"}), vec![])]).await;
	let err = client.get_repo("o/r").await.unwrap_err();
	assert_eq!(err.status, 404);
	assert!(err.to_string().contains("Not Found"));

	let (client, _) = mock_client(vec![(
		StatusCode::FORBIDDEN,
		json!({"message":"rate limited"}),
		vec![("retry-after".into(), "42".into())],
	)])
	.await;
	let err = client.get_repo("o/r").await.unwrap_err();
	assert_eq!(err.retry_after, Some(42.0));

	let (client, _) = mock_client(vec![
		(StatusCode::MOVED_PERMANENTLY, Value::Null, vec![(
			"location".into(),
			"/repositories/12345".into(),
		)]),
		(StatusCode::GONE, json!({"message":"Gone"}), vec![]),
	])
	.await;
	let err = client.get_repo("old-owner/old-repo").await.unwrap_err();
	assert!(matches!(err.status, 301 | 410));

	let (client, calls) = mock_client(vec![
		(StatusCode::MOVED_PERMANENTLY, Value::Null, vec![(
			"location".into(),
			"/repos/new/repo".into(),
		)]),
		(StatusCode::OK, repo_payload.clone(), vec![]),
	])
	.await;
	assert_eq!(client.get_repo("old/repo").await.unwrap().full_name, "new/repo");
	assert_eq!(calls.lock().unwrap()[0].1, "/repos/old/repo");
	assert_eq!(calls.lock().unwrap()[1].1, "/repos/new/repo");

	let (client, _) = mock_client(vec![(StatusCode::OK, json!({"number":9,"html_url":"https://github.com/octo/widget/pull/9","head":{"ref":"farm/abc12345/fix","repo":{"full_name":"octo/widget"}},"base":{"ref":"main"},"state":"open","user":{"login":"robogjc-bot"}}), vec![])]).await;
	let pr = client.get_pull_request("octo/widget", 9).await.unwrap();
	assert_eq!(pr.head_ref, "farm/abc12345/fix");
	assert_eq!(pr.head_repo, "octo/widget");
	assert_eq!(pr.author, "robogjc-bot");

	let (client, _) = mock_client(vec![(StatusCode::NO_CONTENT, Value::Null, vec![])]).await;
	client
		.add_assignees("o/r", 1, &["alice".to_string()])
		.await
		.unwrap();

	let timeline = json!([
		 {"event":"connected","source":{"issue":{"number":100,"state":"open","pull_request":{"url":"..."}}}},
		 {"event":"connected","source":{"issue":{"number":200,"state":"open","pull_request":{"url":"..."}}}},
		 {"event":"disconnected","source":{"issue":{"number":200,"state":"open","pull_request":{"url":"..."}}}},
		 {"event":"connected","source":{"issue":{"number":300,"state":"closed","pull_request":{"url":"..."}}}},
		 {"event":"cross-referenced","source":{"issue":{"number":400,"state":"open","pull_request":{"url":"..."}}}},
		 {"event":"connected","source":{"issue":{"number":500,"state":"open"}}},
		 {"event":"labeled","label":{"name":"bug"}}
	]);
	let (client, calls) = mock_client(vec![(StatusCode::OK, timeline, vec![])]).await;
	assert_eq!(
		client
			.list_closing_pull_requests("octo/widget", 42)
			.await
			.unwrap(),
		vec![100]
	);
	assert_eq!(calls.lock().unwrap()[0].1, "/repos/octo/widget/issues/42/timeline?per_page=100");

	let (client, _) = mock_client(vec![(StatusCode::OK, json!([]), vec![])]).await;
	assert!(
		client
			.list_closing_pull_requests("octo/widget", 7)
			.await
			.unwrap()
			.is_empty()
	);

	let (client, calls) = mock_client(vec![(StatusCode::OK, json!([{"content":"-1","user":{"login":"Alice","type":"User"}},{"content":"-1","user":{"login":"rando","type":"User"}}]), vec![])]).await;
	let reactions = client
		.list_comment_reactions("octo/widget", 999)
		.await
		.unwrap();
	assert_eq!(
		calls.lock().unwrap()[0].1,
		"/repos/octo/widget/issues/comments/999/reactions?content=-1&per_page=100"
	);
	assert_eq!(
		reactions
			.iter()
			.map(|r| r.user_login.as_str())
			.collect::<Vec<_>>(),
		vec!["Alice", "rando"]
	);
	assert!(reactions.iter().all(|r| r.content == "-1"));

	let (client, calls) = mock_client(vec![(StatusCode::OK, json!({}), vec![])]).await;
	client
		.close_issue("octo/widget", 42, "completed")
		.await
		.unwrap();
	let (method, path, body) = calls.lock().unwrap()[0].clone();
	assert_eq!(method, Method::PATCH);
	assert_eq!(path, "/repos/octo/widget/issues/42");
	assert_eq!(body, json!({"state":"closed","state_reason":"completed"}));

	let (client, _) =
		mock_client(vec![(StatusCode::NOT_FOUND, json!({"message":"Not Found"}), vec![])]).await;
	assert_eq!(
		client
			.close_issue("octo/widget", 42, "completed")
			.await
			.unwrap_err()
			.status,
		404
	);

	let (backend, _) = mock_client(vec![(StatusCode::OK, repo_payload, vec![])]).await;
	assert_eq!(
		GitHubBackend::get_repo(&backend, "new/repo")
			.await
			.unwrap()
			.full_name,
		"new/repo"
	);
	let (backend, calls) = mock_client(vec![(
		StatusCode::OK,
		json!({"number":1,"html_url":"u","head":{"ref":"h"},"base":{"ref":"b"}}),
		vec![],
	)])
	.await;
	let req = OpenPullRequest {
		repo:                  "octo/widget",
		head:                  "h",
		base:                  "b",
		title:                 "t",
		body:                  "body",
		draft:                 false,
		maintainer_can_modify: true,
	};
	let _ = GitHubBackend::open_pull_request(&backend, req)
		.await
		.unwrap();
	assert_eq!(calls.lock().unwrap()[0].1, "/repos/octo/widget/pulls");
}
