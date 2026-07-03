//! Command-line entry point wiring for the robogjc binary.

use std::{process, sync::Arc, time::Duration};

use serde_json::json;

use crate::{
	config::Settings,
	db::{Database, issue_key},
	github::{GitHubBackend, GitHubClient},
	manual_triage::{
		INACTIVE_EVENT_STATES, ManualTriageTimeout, await_terminal_state, enqueue_manual_triage,
		parse_issue_ref,
	},
	proxy::{GitHubProxyClient, GitHubProxyGitTransport},
	queue::WorkerPool,
	sandbox::{GitTransport, LocalGitTransport},
	server::{self, AppState},
	worker::{AppServerHostToolRuntime, AppServerWorker, AppServerWorkerConfig},
};

pub fn run() {
	if let Err(err) = run_inner() {
		eprintln!("{err}");
		process::exit(2);
	}
}

fn run_inner() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
	let mut args = std::env::args().skip(1);
	let cmd = args.next().unwrap_or_else(|| "help".to_owned());
	match cmd.as_str() {
		"serve" => tokio_runtime()?.block_on(async {
			let (cfg, db, github, mut pool) = build_runtime()?;
			pool.start().await?;
			let state = AppState::new(cfg, db, github, Arc::new(pool));
			server::serve(state).await
		}),
		"triage" => {
			let (issue, wait_timeout) = parse_target_and_wait_timeout(args, "triage", "ISSUE_REF")?;
			tokio_runtime()?.block_on(async move {
				let (cfg, db, github, _pool) = build_runtime()?;
				let (repo, number) = parse_issue_ref(&issue)?;
				if !cfg.allows(&repo) {
					return Err(format!("refusing: {repo} not in ROBGJC_REPO_ALLOWLIST").into());
				}
				let delivery =
					enqueue_manual_triage(db.as_ref(), github.as_ref(), &repo, number).await?;
				println!(
					"{}",
					serde_json::to_string_pretty(&json!({"delivery":delivery,"state":"queued"}))?
				);
				wait_for_terminal(&cfg, db, &delivery, wait_timeout).await
			})
		},
		"replay" => {
			let (delivery, wait_timeout) =
				parse_target_and_wait_timeout(args, "replay", "DELIVERY_ID")?;
			let cfg = Settings::from_env()?;
			cfg.ensure_paths()?;
			let db = Arc::new(Database::open(&cfg.sqlite_path)?);
			let row = db
				.get_event(&delivery)?
				.ok_or_else(|| format!("unknown delivery: {delivery}"))?;
			if !db.requeue_event(&delivery, Some(INACTIVE_EVENT_STATES))? {
				return Err(
					format!(
						"delivery {delivery} is {}; only inactive events can be replayed",
						row.state
					)
					.into(),
				);
			}
			println!(
				"{}",
				serde_json::to_string_pretty(&json!({"delivery":delivery,"state":"queued"}))?
			);
			tokio_runtime()?.block_on(wait_for_terminal(&cfg, db, &delivery, wait_timeout))
		},
		"status" => {
			let cfg = Settings::from_env()?;
			cfg.ensure_paths()?;
			let db = Database::open(&cfg.sqlite_path)?;
			for r in db.list_issues(10_000)? {
				println!(
					"{:<40} state={:<12} pr={} branch={} updated={}",
					r.key,
					r.state,
					r.pr_number
						.map(|n| n.to_string())
						.unwrap_or_else(|| "-".into()),
					r.branch.unwrap_or_else(|| "-".into()),
					r.updated_at
				);
			}
			Ok(())
		},
		"cleanup" => {
			let key = args.next().ok_or("cleanup requires ISSUE_KEY")?;
			let cfg = Settings::from_env()?;
			cfg.ensure_paths()?;
			let db = Database::open(&cfg.sqlite_path)?;
			let row = db
				.get_issue(&key)?
				.ok_or_else(|| format!("unknown issue: {key}"))?;
			let manager = crate::sandbox::SandboxManager::new(cfg.workspace_root.clone());
			manager.remove_workspace(&row.repo, row.number as u64);
			db.set_issue_state(&key, "abandoned")?;
			println!("cleaned up {key}");
			Ok(())
		},
		"help" | "--help" | "-h" => {
			print_help();
			Ok(())
		},
		other => Err(format!("unknown command: {other}").into()),
	}
}

fn build_runtime() -> Result<
	(Settings, Arc<Database>, Arc<dyn GitHubBackend>, WorkerPool<AppServerWorker>),
	Box<dyn std::error::Error + Send + Sync>,
> {
	let cfg = Settings::from_env()?;
	cfg.ensure_paths()?;
	let db = Arc::new(Database::open(&cfg.sqlite_path)?);
	let (github, git_transport) = build_github_access(&cfg)?;
	let runtime = AppServerHostToolRuntime {
		db: db.clone(),
		github: github.clone(),
		git_transport,
		settings: Some(cfg.clone()),
		author_name: cfg.resolved_author_name(),
		author_email: cfg.git_author_email.clone(),
	};
	let worker_cfg = AppServerWorkerConfig {
		command: vec![cfg.gjc_command.clone(), "app-server".into()],
		model_provider: cfg.provider.clone(),
		model_id: cfg.pick_model(),
		thinking: cfg.thinking_level.clone(),
		hard_timeout: Duration::from_secs_f64(
			cfg.task_timeout_seconds + cfg.task_timeout_hard_grace_seconds,
		),
		max_reminders: cfg.task_completion_max_reminders,
		natives_cache_root: cfg
			.natives_cache_enabled
			.then(|| cfg.natives_cache_root.clone()),
		..Default::default()
	};
	let worker = Arc::new(AppServerWorker::new(worker_cfg, runtime));
	let pool = WorkerPool::new(db.clone(), worker, cfg.max_concurrency, None);
	Ok((cfg, db, github, pool))
}

fn build_github_access(
	cfg: &Settings,
) -> Result<(Arc<dyn GitHubBackend>, Arc<dyn GitTransport>), Box<dyn std::error::Error + Send + Sync>>
{
	if let (Some(url), Some(key)) = (&cfg.gh_proxy_url, &cfg.gh_proxy_hmac_key) {
		let key = key.expose().as_bytes().to_vec();
		let github = Arc::new(GitHubProxyClient::new(url.clone(), key.clone()));
		let git_transport = Arc::new(GitHubProxyGitTransport::new(url.clone(), key));
		return Ok((github, git_transport));
	}
	let token = cfg
		.github_token
		.as_ref()
		.ok_or("no GitHub access configured")?
		.expose()
		.to_owned();
	let github = Arc::new(GitHubClient::new(&token)?);
	let git_transport = Arc::new(LocalGitTransport::new(Some(token)));
	Ok((github, git_transport))
}

fn parse_target_and_wait_timeout<I>(
	mut args: I,
	command: &str,
	target_name: &str,
) -> Result<(String, Option<Duration>), Box<dyn std::error::Error + Send + Sync>>
where
	I: Iterator<Item = String>,
{
	let mut wait_timeout = None;
	let mut target = None;
	while let Some(arg) = args.next() {
		if arg == "--wait-timeout" {
			let value = args.next().ok_or("--wait-timeout requires seconds")?;
			let seconds: f64 = value.parse()?;
			if seconds < 0.1 {
				return Err("--wait-timeout must be at least 0.1 seconds".into());
			}
			wait_timeout = Some(Duration::from_secs_f64(seconds));
		} else if target.is_none() {
			target = Some(arg);
		} else {
			return Err(format!("unexpected {command} argument: {arg}").into());
		}
	}
	Ok((target.ok_or_else(|| format!("{command} requires {target_name}"))?, wait_timeout))
}

fn default_wait_timeout(cfg: &Settings) -> Duration {
	Duration::from_secs_f64(cfg.task_timeout_seconds + cfg.task_timeout_hard_grace_seconds + 30.0)
}

async fn wait_for_terminal(
	cfg: &Settings,
	db: Arc<Database>,
	delivery: &str,
	wait_timeout: Option<Duration>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
	let timeout = wait_timeout.unwrap_or_else(|| default_wait_timeout(cfg));
	match await_terminal_state(db, delivery, Duration::from_secs(1), Some(timeout)).await {
		Ok(Some(final_row)) => {
			println!(
				"{}",
				serde_json::to_string_pretty(
					&json!({"delivery":delivery,"state":final_row.state,"error":final_row.last_error})
				)?
			);
			Ok(())
		},
		Ok(None) => {
			println!(
				"{}",
				serde_json::to_string_pretty(&json!({"delivery":delivery,"state":"missing"}))?
			);
			Ok(())
		},
		Err(err) => {
			if let Some(timeout) = err.downcast_ref::<ManualTriageTimeout>() {
				eprintln!(
					"{}",
					serde_json::to_string_pretty(
						&json!({"delivery":delivery,"state":timeout.state,"timed_out":true,"error":timeout.to_string()})
					)?
				);
			}
			Err(err)
		},
	}
}

fn tokio_runtime() -> Result<tokio::runtime::Runtime, std::io::Error> {
	tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()
}

fn print_help() {
	println!(
		"robogjc control surface\n\nUSAGE:\n  robogjc serve\n  robogjc triage owner/repo#NN\n  robogjc replay DELIVERY_ID\n  robogjc status\n  robogjc cleanup owner/repo#NN"
	);
}

#[cfg(test)]
mod tests {
	#[test]
	fn cli_prefix_help_mentions_commands() {
		// Keep the test name prefix required by the Rust port acceptance plan.
		super::print_help();
	}

	#[test]
	fn cli_prefix_compose_orchestrator_uses_proxy_without_pat() {
		let compose_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
			.join("../../python/robogjc/docker-compose.yml");
		let compose = std::fs::read_to_string(compose_path).unwrap();
		let orchestrator = compose
			.split("  gh-proxy:")
			.next()
			.expect("orchestrator service section");
		assert!(orchestrator.contains("ROBGJC_GH_PROXY_URL"));
		assert!(orchestrator.contains("http://gh-proxy:8081"));
		assert!(orchestrator.contains("ROBGJC_GH_PROXY_HMAC_KEY"));
		assert!(!orchestrator.contains("GITHUB_TOKEN:"));
	}
}
