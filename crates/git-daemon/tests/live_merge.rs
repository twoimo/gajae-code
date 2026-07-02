//! Live-surface test of the daemon's forge-side merge pipeline against REAL
//! GitHub: find the daemon-authored branch, open a PR, read live gate signals,
//! evaluate the SHA-bound merge gate, and MERGE — the exact forge operations
//! `orchestrator::drive_to_merge` performs after a run, exercised
//! deterministically (no engine/LLM). Skipped unless the env is set:
//!
//! ```sh
//! GIT_DAEMON_GITHUB_TOKEN=$(gh auth token) GIT_DAEMON_REPO=owner/repo \
//!   GIT_DAEMON_DEV_BRANCHES=git-daemon-e2e \
//!   cargo test -p git-daemon --test live_merge -- --nocapture
//! ```

use git_daemon::{
	config::MergePolicy,
	forge_adapter::ForgeAdapter,
	github_forge::GithubForge,
	merge_gate::{GateInputs, evaluate},
	reqwest_transport::ReqwestTransport,
};

#[tokio::test]
async fn live_daemon_opens_and_merges_pr() {
	let (Ok(token), Ok(repo), Ok(base)) = (
		std::env::var("GIT_DAEMON_GITHUB_TOKEN"),
		std::env::var("GIT_DAEMON_REPO"),
		std::env::var("GIT_DAEMON_DEV_BRANCHES"),
	) else {
		eprintln!(
			"SKIP live_daemon_opens_and_merges_pr: set GIT_DAEMON_GITHUB_TOKEN + GIT_DAEMON_REPO + \
			 GIT_DAEMON_DEV_BRANCHES"
		);
		return;
	};
	let forge = GithubForge::new(ReqwestTransport::new().expect("transport"), token, &repo);
	let policy = MergePolicy {
		protected_branches:   vec!["main".into(), "master".into(), "dev".into()],
		allowed_dev_branches: vec![base.clone()],
	};

	// 1. Find the daemon head branch bound to a work key (GIT_DAEMON_WORK_KEY, or
	// a default). A prior run must have pushed EXACTLY work_branch_ref(work_key).
	let work_key = std::env::var("GIT_DAEMON_WORK_KEY").unwrap_or_else(|_| "wk".to_owned());
	let Some(head) = ForgeAdapter::find_work_branch(&forge, &work_key)
		.await
		.expect("find_work_branch")
	else {
		eprintln!(
			"SKIP: no branch {} on origin for work_key {work_key}",
			git_daemon::keys::work_branch_ref(&work_key)
		);
		return;
	};
	println!("LIVE merge: found work branch {head}");

	// 2. Daemon opens the PR (find_work_pr None -> create_pr path).
	let pr = if let Some(pr) = ForgeAdapter::find_work_pr(&forge, &work_key)
		.await
		.expect("find_work_pr")
	{
		println!("LIVE merge: existing PR #{}", pr.number);
		pr
	} else {
		let pr = ForgeAdapter::create_pr(
			&forge,
			&head,
			&base,
			"git-daemon: live e2e merge",
			"Autonomous merge of the agent-authored fix.",
		)
		.await
		.expect("create_pr");
		println!("LIVE merge: opened PR #{} {} -> {}", pr.number, head, base);
		pr
	};
	let pr_ref = pr.number.to_string();

	// 3. SHA-bound refetch + live gate signals + protection.
	let live = ForgeAdapter::get_pr(&forge, &pr_ref).await.expect("get_pr");
	let protection = ForgeAdapter::get_branch_protection(&forge, &live.base_branch).await;
	let protection_known = protection.is_ok();
	let base_is_protected = protection.unwrap_or(false);
	let signals = ForgeAdapter::fetch_merge_signals(&forge, &pr_ref, &live.head_sha)
		.await
		.expect("fetch_merge_signals");
	println!(
		"LIVE merge: signals ci={} reviews={} budget={} scope={} protection_known={}",
		signals.ci_green,
		signals.reviews_resolved,
		signals.diff_within_budget,
		signals.diff_in_scope,
		protection_known
	);

	let inputs = GateInputs {
		queued_head_sha: &pr.head_sha,
		current_head_sha: &live.head_sha,
		queued_base_branch: &pr.base_branch,
		base_branch: &live.base_branch,
		branch_protection_known: protection_known,
		base_is_protected,
		ci_green: signals.ci_green,
		ultragoal_pass: true, // the fix is the agent's real resolution
		reviews_resolved: signals.reviews_resolved,
		diff_within_budget: signals.diff_within_budget,
		diff_in_scope: signals.diff_in_scope,
	};
	let decision = evaluate(&inputs, &policy);
	println!("LIVE merge: gate allow={} reason={:?}", decision.allow, decision.reason);
	assert!(decision.may_merge(), "gate must allow the merge to the scratch dev branch");

	// 4. SHA-bound merge.
	let merge_sha = ForgeAdapter::merge_pr(&forge, &git_daemon::forge_adapter::MergeRequest {
		pr_id:             pr_ref,
		expected_head_sha: decision.head_sha,
	})
	.await
	.expect("merge_pr");
	println!("LIVE merge: MERGED, merge commit {merge_sha}");
	assert!(!merge_sha.is_empty());
}
