//! Live forge verification against a real GitHub repo (G007, poll-only path).
//!
//! Gated by `GIT_DAEMON_LIVE_TEST=1` so `cargo test` stays offline by default.
//! Reads `GIT_DAEMON_GITHUB_TOKEN` (e.g. `gh auth token`), `GIT_DAEMON_REPO`
//! (owner/repo), and `GIT_DAEMON_LIVE_PR` (an open PR number targeting `dev`).
//!
//! Exercises the reqwest transport + `GithubForge` against real GitHub:
//! - `get_pr` parses live PR state,
//! - `get_branch_protection` is readable (gate would not fail closed),
//! - a wrong `expected_head_sha` merge fails closed with `ShaMismatch`,
//! - the correct `expected_head_sha` merge succeeds (SHA-bound merge to `dev`),
//! - `post_comment` posts to the PR thread.

use git_daemon::{
	forge_adapter::{ForgeAdapter, ForgeError, MergeRequest},
	github_forge::GithubForge,
	reqwest_transport::ReqwestTransport,
};

fn opt(key: &str) -> Option<String> {
	std::env::var(key).ok().filter(|v| !v.is_empty())
}

#[tokio::test]
async fn live_forge_transport_and_sha_bound_merge() {
	if opt("GIT_DAEMON_LIVE_TEST").as_deref() != Some("1") {
		eprintln!("live_forge: skipped (set GIT_DAEMON_LIVE_TEST=1 to run)");
		return;
	}
	let token = opt("GIT_DAEMON_GITHUB_TOKEN").expect("GIT_DAEMON_GITHUB_TOKEN");
	let repo = opt("GIT_DAEMON_REPO").expect("GIT_DAEMON_REPO");
	let pr = opt("GIT_DAEMON_LIVE_PR").expect("GIT_DAEMON_LIVE_PR");

	let forge = GithubForge::new(ReqwestTransport::new().expect("reqwest client"), token, repo);

	// 1. Live read: parse the real PR state via the reqwest transport.
	let live = forge.get_pr(&pr).await.expect("get_pr against live GitHub");
	assert_eq!(live.base_branch, "dev", "test PR must target dev");
	assert!(!live.head_sha.is_empty(), "live head sha must be present");
	eprintln!("live_forge: get_pr ok — head={} base={}", live.head_sha, live.base_branch);

	// 2. Branch protection must be readable (Ok(_)); the gate only fails closed
	//    when it CANNOT be read.
	let protection = forge.get_branch_protection("dev").await;
	assert!(protection.is_ok(), "branch protection must be readable, got {protection:?}");
	eprintln!("live_forge: get_branch_protection(dev) = {protection:?}");

	// 3. Fail closed: a wrong expected head SHA must be rejected by GitHub (409)
	//    and mapped to ShaMismatch — the daemon never merges a moved head.
	let wrong = forge
		.merge_pr(&MergeRequest {
			pr_id:             pr.clone(),
			expected_head_sha: "0000000000000000000000000000000000000000".to_owned(),
		})
		.await;
	assert!(
		matches!(wrong, Err(ForgeError::ShaMismatch)),
		"wrong SHA must fail closed, got {wrong:?}"
	);
	eprintln!("live_forge: wrong-SHA merge correctly denied (ShaMismatch)");

	// 4. SHA-bound merge with the correct expected head merges to dev.
	let merged = forge
		.merge_pr(&MergeRequest {
			pr_id:             pr.clone(),
			expected_head_sha: live.head_sha.clone(),
		})
		.await;
	assert!(merged.is_ok(), "expected-head merge to dev should succeed, got {merged:?}");
	eprintln!("live_forge: SHA-bound merge to dev ok — merge_sha={}", merged.unwrap());

	// 5. Comment surface.
	forge
		.post_comment(&pr, "git-daemon live verification: SHA-bound merge gate exercised ✔")
		.await
		.expect("post_comment");
	eprintln!("live_forge: post_comment ok");
}
