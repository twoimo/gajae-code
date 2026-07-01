//! Live-surface integration test for the GitHub forge over the real `reqwest`
//! transport. Skipped unless `GIT_DAEMON_GITHUB_TOKEN` + `GIT_DAEMON_REPO` are
//! set, so normal `cargo test` stays offline/hermetic. Run explicitly for the
//! G007 live-surface verification:
//!
//! ```sh
//! GIT_DAEMON_GITHUB_TOKEN=$(gh auth token) GIT_DAEMON_REPO=owner/repo \
//!   cargo test -p git-daemon --test live_forge -- --nocapture
//! ```

use git_daemon::github_forge::GithubForge;
use git_daemon::reqwest_transport::ReqwestTransport;

#[tokio::test]
async fn live_list_open_issues_over_reqwest() {
	let (Ok(token), Ok(repo)) =
		(std::env::var("GIT_DAEMON_GITHUB_TOKEN"), std::env::var("GIT_DAEMON_REPO"))
	else {
		eprintln!("SKIP live_list_open_issues_over_reqwest: set GIT_DAEMON_GITHUB_TOKEN + GIT_DAEMON_REPO");
		return;
	};
	let transport = ReqwestTransport::new().expect("build reqwest transport");
	let forge = GithubForge::new(transport, token, &repo);
	let issues = git_daemon::forge_adapter::ForgeAdapter::list_open_issues(&forge)
		.await
		.expect("live list_open_issues");
	println!("LIVE reqwest: {repo} has {} open issue(s)", issues.len());
	for i in issues.iter().take(8) {
		println!("  - {} state={} updated_at={}", i.node_id, i.state, i.updated_at);
	}
}
