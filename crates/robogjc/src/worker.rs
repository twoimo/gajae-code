//! App-server backed issue-processing worker orchestration.

use std::{
	collections::BTreeMap,
	fs,
	path::PathBuf,
	sync::{Arc, RwLock},
	time::Duration,
};

use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
	app_server_client::{
		AppServerClient, AppServerNotification, AppServerTransport, HostToolSpec,
		Result as ClientResult, StdioTransport,
	},
	db::{Database, EventRow},
	github::{GitHubBackend, IssueInfo as GhIssueInfo, RepoInfo as GhRepoInfo},
	host_tools,
	natives_cache::{self, NativesCache},
	persona,
	queue::{TaskContext, TaskFuture, TaskWorker},
	sandbox::{GitTransport, Workspace},
};

pub type HostToolDispatcher =
	Arc<dyn Fn(&str, Value) -> std::result::Result<host_tools::ToolResult, String> + Send + Sync>;
type HostToolRuntimeFactory = Arc<dyn Fn(&EventRow) -> AppServerHostToolRuntime + Send + Sync>;

#[derive(Clone)]
pub struct AppServerHostToolRuntime {
	pub db: Arc<Database>,
	pub github: Arc<dyn GitHubBackend>,
	pub git_transport: Arc<dyn GitTransport>,
	pub settings: Option<crate::config::Settings>,
	pub author_name: String,
	pub author_email: String,
}

#[derive(Clone)]
pub struct AppServerWorkerConfig {
	pub command: Vec<String>,
	pub cwd: Option<PathBuf>,
	pub env: BTreeMap<String, String>,
	pub session_id: String,
	pub session_dir: PathBuf,
	pub model_provider: Option<String>,
	pub model_id: String,
	pub thinking: String,
	pub hard_timeout: Duration,
	pub max_reminders: usize,
	pub natives_cache_root: Option<PathBuf>,
	/// Test override for host tools. Production stdio wiring must supply either a runtime or runtime factory instead.
	pub host_tool_dispatcher: Option<HostToolDispatcher>,
	/// Runtime used to build real host-tool bindings for production app-server workers.
	pub host_tool_runtime: Option<AppServerHostToolRuntime>,
	/// Late-bound runtime used when per-event workspace data is required to build host-tool bindings.
	pub host_tool_runtime_factory: Option<HostToolRuntimeFactory>,
}

impl Default for AppServerWorkerConfig {
	fn default() -> Self {
		Self {
			command: vec!["gjc".into(), "app-server".into()],
			cwd: None,
			env: BTreeMap::new(),
			session_id: "robogjc".into(),
			session_dir: PathBuf::from(".gjc/robogjc"),
			model_provider: None,
			model_id: "default".into(),
			thinking: "high".into(),
			hard_timeout: Duration::from_secs(1800),
			max_reminders: 2,
			natives_cache_root: None,
			host_tool_dispatcher: None,
			host_tool_runtime: None,
			host_tool_runtime_factory: None,
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerOutcome {
	pub thread_id: String,
	pub turn_id: Option<String>,
	pub reminders_sent: usize,
	pub interrupted: bool,
	pub natives_cache_captured: bool,
}

pub struct AppServerWorker<T: AppServerTransport = StdioTransport> {
	config: AppServerWorkerConfig,
	client: Option<AppServerClient<T>>,
}

impl AppServerWorker<StdioTransport> {
	pub fn new(
		mut config: AppServerWorkerConfig,
		host_tool_runtime: AppServerHostToolRuntime,
	) -> Self {
		config.host_tool_runtime = Some(host_tool_runtime);
		Self { config, client: None }
	}

	pub fn new_with_runtime_factory<F>(mut config: AppServerWorkerConfig, factory: F) -> Self
	where
		F: Fn(&EventRow) -> AppServerHostToolRuntime + Send + Sync + 'static,
	{
		config.host_tool_runtime_factory = Some(Arc::new(factory));
		Self { config, client: None }
	}
	async fn stdio_client(&self) -> ClientResult<AppServerClient<StdioTransport>> {
		AppServerClient::spawn(&self.config.command, self.config.cwd.clone(), self.config.env.clone())
			.await
	}
}

impl<T: AppServerTransport> AppServerWorker<T> {
	pub fn with_client(config: AppServerWorkerConfig, client: AppServerClient<T>) -> Self {
		Self { config, client: Some(client) }
	}

	pub fn host_tool_dispatcher<G, GT>(
		bindings: host_tools::ToolBindings<G, GT>,
	) -> HostToolDispatcher
	where
		G: crate::github::GitHubBackend + ?Sized + 'static,
		GT: crate::sandbox::GitTransport + ?Sized + 'static,
	{
		let bindings = Arc::new(bindings);
		Arc::new(move |name, args| {
			host_tools::build(Some(bindings.as_ref()))
				.into_iter()
				.find(|tool| tool.descriptor.name == name)
				.map(|tool| tool.call(bindings.as_ref(), args))
				.ok_or_else(|| format!("unknown host tool: {name}"))
		})
	}

	pub async fn run_app_server_task(
		&self,
		row: EventRow,
		ctx: TaskContext,
	) -> ClientResult<WorkerOutcome> {
		let client = self
			.client
			.clone()
			.ok_or("injected app-server client is required for generic worker")?;
		run_with_client(&self.config, client, row, ctx).await
	}
}

impl AppServerWorker<StdioTransport> {
	fn ensure_stdio_host_tool_bindings(&self) -> ClientResult<()> {
		if self.config.host_tool_dispatcher.is_none()
			&& self.config.host_tool_runtime.is_none()
			&& self.config.host_tool_runtime_factory.is_none()
		{
			return Err("production app-server worker requires host_tool_runtime, host_tool_runtime_factory, or host_tool_dispatcher before advertising host tools".into());
		}
		Ok(())
	}

	pub async fn run_stdio_app_server_task(
		&self,
		row: EventRow,
		ctx: TaskContext,
	) -> ClientResult<WorkerOutcome> {
		self.ensure_stdio_host_tool_bindings()?;
		let client = self.stdio_client().await?;
		run_with_client(&self.config, client, row, ctx).await
	}
}

impl TaskWorker for AppServerWorker<StdioTransport> {
	fn run_task<'a>(&'a self, row: EventRow, ctx: TaskContext) -> TaskFuture<'a> {
		Box::pin(async move {
			self.run_stdio_app_server_task(row, ctx).await?;
			Ok(())
		})
	}
}

async fn run_with_client<T: AppServerTransport>(
	config: &AppServerWorkerConfig,
	client: AppServerClient<T>,
	row: EventRow,
	ctx: TaskContext,
) -> ClientResult<WorkerOutcome> {
	client.initialize(json!({})).await?;
	client.notify_initialized().await?;
	let task_kind = row
		.payload
		.get("task_kind")
		.and_then(Value::as_str)
		.unwrap_or(&row.event_type);
	let todos = todos_for(task_kind);
	let metadata = thread_metadata(config, &row, todos.clone());
	let existing_thread = load_thread_id(config).or_else(|| {
		row.payload
			.get("threadId")
			.and_then(Value::as_str)
			.map(str::to_owned)
	});
	let resumed = existing_thread
		.as_deref()
		.map(|thread_id| client.resume_thread(thread_id, metadata.clone()));
	let (thread, did_resume) = if let Some(resume) = resumed {
		match resume.await {
			Ok(resume) if resume.resumed => (resume.thread, true),
			Ok(_) | Err(_) => (client.start_thread(metadata.clone()).await?, false),
		}
	} else {
		(client.start_thread(metadata.clone()).await?, false)
	};
	persist_thread_id(config, &thread.id)?;
	client.set_host_tools(&thread.id, host_tool_specs()).await?;
	let known_todos = merge_known_todos(config, &thread.id, todos.clone());
	if !known_todos.as_array().is_some_and(Vec::is_empty) {
		client.set_todos(&thread.id, known_todos.clone()).await?;
		persist_known_todos(config, &thread.id, &known_todos)?;
	}
	let prompt = build_prompt(config, &row, task_kind, did_resume);
	let turn = client
		.start_turn(
			&thread.id,
			&prompt,
			json!({"eventDeliveryId": row.delivery_id, "eventType": row.event_type}),
		)
		.await?;
	let mut reminders_sent = 0usize;
	let mut interrupted = false;
	let deadline = Instant::now() + config.hard_timeout;
	let mut terminal_status: Option<String> = None;
	let abort_controller = host_tools::AbortController::new();

	let mut successful_terminal_tools: std::collections::BTreeSet<String> =
		std::collections::BTreeSet::new();
	if let Some(turn_id) = turn.id.clone() {
		let interrupt_client = client.clone();
		let interrupt_thread = thread.id.clone();
		let delivery_id = row.delivery_id.clone();
		ctx.cancellations.arm(delivery_id.clone(), move || {
			tokio::spawn(async move {
				let _ = interrupt_client
					.interrupt(&interrupt_thread, &turn_id)
					.await;
			});
		});
	}
	while terminal_status.is_none() {
		if Instant::now() >= deadline || ctx.cancellations.is_cancelled(&row.delivery_id) {
			if let Some(turn_id) = turn.id.as_deref() {
				client.interrupt(&thread.id, turn_id).await?;
				interrupted = true;
			}
			break;
		}
		let note = tokio::time::timeout(Duration::from_millis(50), client.next_notification()).await;
		match note {
			Ok(Ok(Some(AppServerNotification::TurnCompleted(params)))) => {
				terminal_status = Some(turn_status(&params)?);
			},
			Ok(Ok(Some(AppServerNotification::HostToolCall {
				thread_id,
				call_id,
				tool,
				args,
				..
			}))) => {
				let result =
					dispatch_host_tool(config, &row, &ctx, &abort_controller, &tool, args).await;
				match result {
					Ok(value) => {
						if matches!(
							tool.as_str(),
							"gh_open_pr" | "mark_unable_to_reproduce" | "abort_task"
						) {
							successful_terminal_tools.insert(tool.clone());
						}
						client
							.send_host_tool_result(&thread_id, &call_id, true, value)
							.await?;
					},
					Err(message) => {
						client
							.send_host_tool_result(&thread_id, &call_id, false, json!({"message":message}))
							.await?;
					},
				}
			},
			Ok(Ok(Some(AppServerNotification::HostToolCancel { .. }))) => {
				abort_controller.signal("app-server host tool cancellation");
			},
			Ok(Ok(Some(_))) => {},
			Ok(Ok(None)) => {
				return Err("app-server notification stream closed before turn/completed".into());
			},
			Ok(Err(e)) => return Err(e),
			Err(_) => {},
		}
	}
	while !interrupted
		&& reminders_sent < config.max_reminders
		&& needs_post_turn_reminder(config, task_kind, &row, &successful_terminal_tools)
	{
		client
			.steer(
				&thread.id,
				&completion_reminder(config, &row, ctx.slot_uid),
				json!({"reason":"completion_reminder"}),
			)
			.await?;
		reminders_sent += 1;
		terminal_status = Some(
			drain_reminder_turn(
				config,
				&client,
				&row,
				&ctx,
				&abort_controller,
				&mut successful_terminal_tools,
				"during reminder",
			)
			.await?,
		);
	}
	if !interrupted && reminders_sent < config.max_reminders {
		if let Some(reminder) = dirty_state_reminder(config, &row, ctx.slot_uid) {
			client
				.steer(&thread.id, &reminder, json!({"reason":"dirty_state_reminder"}))
				.await?;
			reminders_sent += 1;
			terminal_status = Some(
				drain_reminder_turn(
					config,
					&client,
					&row,
					&ctx,
					&abort_controller,
					&mut successful_terminal_tools,
					"during dirty-state reminder",
				)
				.await?,
			);
		}
	}
	ctx.cancellations.disarm(&row.delivery_id);
	let natives_cache_captured = terminal_status.as_deref() == Some("completed")
		&& !interrupted
		&& capture_natives_cache(config, &row).unwrap_or(false);
	client.close().await?;
	Ok(WorkerOutcome {
		thread_id: thread.id,
		turn_id: turn.id,
		reminders_sent,
		interrupted,
		natives_cache_captured,
	})
}

fn thread_metadata(config: &AppServerWorkerConfig, row: &EventRow, todos: Value) -> Value {
	let mut model = json!({"modelId": config.model_id});
	if let Some(provider) = &config.model_provider {
		model
			.as_object_mut()
			.unwrap()
			.insert("provider".into(), provider.clone().into());
	}
	json!({
		"cwd": config.cwd.as_ref().map(|p| p.display().to_string()),
		"sessionId": config.session_id,
		"sessionDir": config.session_dir.display().to_string(),
		"systemPromptAppend": "robogjc app-server worker",
		"model": model,
		"thinking": config.thinking,
		"todos": todos,
		"eventDeliveryId": row.delivery_id,
		"issueKey": row.issue_key,
	})
}

fn todos_for(task_kind: &str) -> Value {
	match persona::seed_phases(task_kind) {
		Ok(phases) => Value::Array(
			phases
				.into_iter()
				.map(|p| json!({"name": p.name, "tasks": p.tasks}))
				.collect(),
		),
		Err(_) => json!([]),
	}
}

fn host_tool_specs() -> Vec<HostToolSpec> {
	host_tools::descriptors()
		.into_iter()
		.map(|d| HostToolSpec {
			name: d.name,
			description: d.description,
			input_schema: d.input_schema,
			result_policy: d.result_policy,
			redaction_hints: d.redaction_hints,
		})
		.collect()
}

async fn dispatch_host_tool(
	config: &AppServerWorkerConfig,
	row: &EventRow,
	ctx: &TaskContext,
	abort: &host_tools::AbortController,
	tool: &str,
	args: Value,
) -> std::result::Result<Value, String> {
	let dispatcher = config
		.host_tool_dispatcher
		.clone()
		.or_else(|| build_runtime_host_tool_dispatcher(config, row, ctx, abort.clone()).ok())
		.ok_or_else(|| "host tool bindings are not configured; production app-server worker wiring must supply host_tool_runtime, host_tool_runtime_factory, or host_tool_dispatcher".to_owned())?;
	let result = dispatcher(tool, args)?;
	if result.ok {
		if tool == "abort_task" {
			abort.signal(&result.text);
		}
		Ok(json!({"text": result.text}))
	} else {
		Err(result.text)
	}
}

async fn drain_reminder_turn<T: AppServerTransport>(
	config: &AppServerWorkerConfig,
	client: &AppServerClient<T>,
	row: &EventRow,
	ctx: &TaskContext,
	abort_controller: &host_tools::AbortController,
	successful_terminal_tools: &mut std::collections::BTreeSet<String>,
	closed_context: &str,
) -> ClientResult<String> {
	loop {
		match client.next_notification().await? {
			Some(AppServerNotification::TurnCompleted(params)) => return turn_status(&params),
			Some(AppServerNotification::HostToolCall { thread_id, call_id, tool, args, .. }) => {
				let result = dispatch_host_tool(config, row, ctx, abort_controller, &tool, args).await;
				match result {
					Ok(value) => {
						if matches!(
							tool.as_str(),
							"gh_open_pr" | "mark_unable_to_reproduce" | "abort_task"
						) {
							successful_terminal_tools.insert(tool.clone());
						}
						client
							.send_host_tool_result(&thread_id, &call_id, true, value)
							.await?;
					},
					Err(message) => {
						client
							.send_host_tool_result(&thread_id, &call_id, false, json!({"message":message}))
							.await?;
					},
				}
			},
			Some(AppServerNotification::HostToolCancel { .. }) => {
				abort_controller.signal("app-server host tool cancellation");
			},
			Some(_) => {},
			None => {
				return Err(format!("app-server notification stream closed {closed_context}").into());
			},
		}
	}
}

fn build_runtime_host_tool_dispatcher(
	config: &AppServerWorkerConfig,
	row: &EventRow,
	ctx: &TaskContext,
	abort: host_tools::AbortController,
) -> std::result::Result<HostToolDispatcher, String> {
	let runtime = config
		.host_tool_runtime
		.clone()
		.or_else(|| {
			config
				.host_tool_runtime_factory
				.as_ref()
				.map(|factory| factory(row))
		})
		.ok_or_else(|| "host tool runtime is not configured".to_owned())?;
	let repo = repo_info(row);
	let issue = issue_info(row);
	let workspace = runtime_workspace(config, row, &repo, &issue)?;
	let bindings = host_tools::ToolBindings {
		db: runtime.db,
		github: runtime.github,
		git_transport: runtime.git_transport,
		repo: GhRepoInfo {
			full_name: repo.full_name,
			default_branch: repo.default_branch,
			clone_url: repo.clone_url,
			private: repo.private,
		},
		issue: GhIssueInfo {
			repo: issue.repo,
			number: issue.number as i64,
			title: issue.title,
			body: issue.body,
			state: issue.state,
			author: issue.author,
			labels: issue.labels,
			is_pull_request: issue.is_pull_request,
		},
		workspace_branch: Arc::new(RwLock::new(workspace.branch.clone())),
		workspace,
		author_name: runtime.author_name,
		author_email: runtime.author_email,
		settings: runtime.settings,
		inbound_thread_number: row
			.issue_key
			.as_deref()
			.and_then(|k| k.rsplit('#').next())
			.and_then(|n| n.parse().ok()),
		inbound_is_pr: row.payload.get("pull_request").is_some(),
		slot_uid: ctx.slot_uid,
		abort: Some(abort),
	};
	Ok(AppServerWorker::<StdioTransport>::host_tool_dispatcher(bindings))
}

fn runtime_workspace(
	config: &AppServerWorkerConfig,
	row: &EventRow,
	repo: &persona::RepoInfo,
	issue: &persona::IssueInfo,
) -> std::result::Result<Workspace, String> {
	let repo_dir = config
		.cwd
		.clone()
		.or_else(|| {
			row.payload
				.pointer("/workspace/repo_dir")
				.and_then(Value::as_str)
				.map(PathBuf::from)
		})
		.ok_or_else(|| "host tool runtime requires a workspace repo_dir".to_owned())?;
	let root = row
		.payload
		.pointer("/workspace/root")
		.and_then(Value::as_str)
		.map(PathBuf::from)
		.unwrap_or_else(|| {
			repo_dir
				.parent()
				.map(PathBuf::from)
				.unwrap_or_else(|| repo_dir.clone())
		});
	let session_dir = config.session_dir.clone();
	let context_dir = row
		.payload
		.pointer("/workspace/context_dir")
		.and_then(Value::as_str)
		.map(PathBuf::from)
		.unwrap_or_else(|| session_dir.join("context"));
	let artifacts_dir = row
		.payload
		.pointer("/workspace/artifacts_dir")
		.and_then(Value::as_str)
		.map(PathBuf::from)
		.unwrap_or_else(|| context_dir.join("artifacts"));
	let branch = row
		.payload
		.pointer("/workspace/branch")
		.and_then(Value::as_str)
		.filter(|s| !s.is_empty())
		.unwrap_or("farm/runtime/app-server")
		.to_owned();
	Ok(Workspace {
		root,
		repo_dir,
		session_dir,
		context_dir,
		artifacts_dir,
		branch,
		repo_full_name: repo.full_name.clone(),
		issue_number: issue.number,
	})
}

fn build_prompt(
	config: &AppServerWorkerConfig,
	row: &EventRow,
	task_kind: &str,
	did_resume: bool,
) -> String {
	if let Some(prompt) = row.payload.get("prompt").and_then(Value::as_str) {
		return prompt.to_owned();
	}
	let repo = repo_info(row);
	let issue = issue_info(row);
	let workspace = workspace_info(config, row);
	match task_kind {
		"handle_comment" if directive_info(row).is_some() => {
			directive_comment_prompt(&repo, &issue, &workspace, row).unwrap_or_else(default_prompt)
		},
		"handle_comment" => {
			comment_prompt(&repo, &issue, &workspace, row).unwrap_or_else(default_prompt)
		},
		"handle_review" | "handle_pr_conversation" => {
			review_prompt(&repo, &workspace, row).unwrap_or_else(default_prompt)
		},
		"triage_issue" if did_resume => {
			persona::resume_triage(&repo, &issue, &workspace).unwrap_or_else(|_| default_prompt())
		},
		"triage_issue" if directive_info(row).is_some() => {
			persona::kickoff_directive(&repo, &issue, &workspace, &directive_info(row).unwrap())
				.unwrap_or_else(|_| default_prompt())
		},
		"triage_issue" => {
			persona::kickoff(&repo, &issue, &workspace).unwrap_or_else(|_| default_prompt())
		},
		_ => default_prompt(),
	}
}

fn default_prompt() -> String {
	"Run the assigned robogjc task.".to_owned()
}

fn repo_info(row: &EventRow) -> persona::RepoInfo {
	let repo = row
		.repo
		.clone()
		.or_else(|| {
			row.payload
				.pointer("/repository/full_name")
				.and_then(Value::as_str)
				.map(str::to_owned)
		})
		.unwrap_or_default();
	persona::RepoInfo {
		full_name: repo.clone(),
		default_branch: str_path(&row.payload, &["repository", "default_branch"]),
		clone_url: str_path(&row.payload, &["repository", "clone_url"]),
		private: row
			.payload
			.pointer("/repository/private")
			.and_then(Value::as_bool)
			.unwrap_or(false),
	}
}

fn issue_info(row: &EventRow) -> persona::IssueInfo {
	let issue = row
		.payload
		.get("issue")
		.or_else(|| row.payload.get("pull_request"))
		.unwrap_or(&Value::Null);
	persona::IssueInfo {
		repo: row.repo.clone().unwrap_or_default(),
		number: issue
			.get("number")
			.and_then(Value::as_u64)
			.unwrap_or_else(|| {
				row.issue_key
					.as_deref()
					.and_then(|k| k.rsplit('#').next())
					.and_then(|n| n.parse().ok())
					.unwrap_or(0)
			}),
		title: str_path(issue, &["title"]),
		body: str_path(issue, &["body"]),
		state: str_path(issue, &["state"]),
		author: str_path(issue, &["user", "login"]),
		labels: issue
			.get("labels")
			.and_then(Value::as_array)
			.map(|labels| {
				labels
					.iter()
					.filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_owned))
					.collect()
			})
			.unwrap_or_default(),
		is_pull_request: issue.get("pull_request").is_some()
			|| row.payload.get("pull_request").is_some(),
	}
}

fn workspace_info(config: &AppServerWorkerConfig, row: &EventRow) -> persona::Workspace {
	persona::Workspace {
		branch: str_path(&row.payload, &["workspace", "branch"]),
		session_dir: config.session_dir.display().to_string(),
		context_dir: str_path(&row.payload, &["workspace", "context_dir"]),
		repo_dir: config
			.cwd
			.as_ref()
			.map(|p| p.display().to_string())
			.unwrap_or_else(|| str_path(&row.payload, &["workspace", "repo_dir"])),
	}
}

fn comment_prompt(
	repo: &persona::RepoInfo,
	issue: &persona::IssueInfo,
	workspace: &persona::Workspace,
	row: &EventRow,
) -> Option<String> {
	let comment = row.payload.get("comment")?;
	let info = persona::CommentInfo {
		id: comment.get("id").and_then(Value::as_u64).unwrap_or(0),
		author: str_path(comment, &["user", "login"]),
		body: str_path(comment, &["body"]),
		created_at: str_path(comment, &["created_at"]),
	};
	let thread = thread_messages(&row.payload);
	persona::followup_comment(
		repo,
		issue,
		&info,
		workspace,
		row.payload
			.get("pr_status")
			.and_then(Value::as_str)
			.unwrap_or("unknown"),
		row.payload.get("pr_number").and_then(Value::as_u64),
		&thread,
	)
	.ok()
}

fn directive_comment_prompt(
	repo: &persona::RepoInfo,
	issue: &persona::IssueInfo,
	workspace: &persona::Workspace,
	row: &EventRow,
) -> Option<String> {
	let comment = row.payload.get("comment")?;
	let info = persona::CommentInfo {
		id: comment.get("id").and_then(Value::as_u64).unwrap_or(0),
		author: str_path(comment, &["user", "login"]),
		body: str_path(comment, &["body"]),
		created_at: str_path(comment, &["created_at"]),
	};
	persona::directive(
		repo,
		issue,
		&info,
		workspace,
		&directive_info(row)?,
		row.payload
			.get("pr_status")
			.and_then(Value::as_str)
			.unwrap_or("unknown"),
		row.payload.get("pr_number").and_then(Value::as_u64),
	)
	.ok()
}

fn review_prompt(
	repo: &persona::RepoInfo,
	workspace: &persona::Workspace,
	row: &EventRow,
) -> Option<String> {
	let comment = row
		.payload
		.get("comment")
		.or_else(|| row.payload.get("review"))?;
	let start = comment
		.get("start_line")
		.and_then(Value::as_i64)
		.or_else(|| comment.get("line").and_then(Value::as_i64));
	let end = comment
		.get("line")
		.and_then(Value::as_i64)
		.or_else(|| comment.get("original_line").and_then(Value::as_i64));
	let line_range = match (start, end) {
		(Some(s), Some(e)) if s != e => format!(":L{s}-L{e}"),
		(_, Some(e)) => format!(":L{e}"),
		_ => String::new(),
	};
	persona::followup_review(
		repo,
		workspace,
		row.payload
			.get("pull_request")
			.and_then(|p| p.get("number"))
			.and_then(Value::as_u64)
			.unwrap_or(0),
		&str_path(comment, &["user", "login"]),
		&str_path(comment, &["body"]),
		&str_path(comment, &["path"]),
		&line_range,
	)
	.ok()
}

fn thread_messages(payload: &Value) -> Vec<persona::ThreadMessage> {
	payload
		.get("thread")
		.and_then(Value::as_array)
		.map(|items| {
			items
				.iter()
				.map(|m| persona::ThreadMessage {
					kind: str_path(m, &["kind"]),
					author: str_path(m, &["author"]),
					body: str_path(m, &["body"]),
					created_at: str_path(m, &["created_at"]),
					path: m.get("path").and_then(Value::as_str).map(str::to_owned),
					line: m.get("line").and_then(Value::as_u64),
					state: m.get("state").and_then(Value::as_str).map(str::to_owned),
				})
				.collect()
		})
		.unwrap_or_default()
}

fn str_path(value: &Value, path: &[&str]) -> String {
	let mut current = value;
	for key in path {
		current = current.get(*key).unwrap_or(&Value::Null);
	}
	current.as_str().unwrap_or_default().to_owned()
}
fn directive_info(row: &EventRow) -> Option<persona::DirectiveInfo> {
	let raw = row.payload.get("_robogjc_directive")?.as_object()?;
	let body = raw.get("body")?.as_str()?.trim();
	let author = raw.get("author")?.as_str()?.trim();
	if body.is_empty() || author.is_empty() {
		return None;
	}
	Some(persona::DirectiveInfo {
		body: body.to_owned(),
		author: author.to_owned(),
		thread: thread_messages(&row.payload),
	})
}

fn thread_state_path(config: &AppServerWorkerConfig) -> PathBuf {
	config.session_dir.join("app-server-thread.json")
}

fn load_thread_state(config: &AppServerWorkerConfig) -> Value {
	fs::read_to_string(thread_state_path(config))
		.ok()
		.and_then(|text| serde_json::from_str::<Value>(&text).ok())
		.unwrap_or_else(|| json!({}))
}

fn load_thread_id(config: &AppServerWorkerConfig) -> Option<String> {
	load_thread_state(config)
		.get("thread_id")
		.and_then(Value::as_str)
		.map(str::to_owned)
}

fn persist_thread_id(config: &AppServerWorkerConfig, thread_id: &str) -> ClientResult<()> {
	let mut state = load_thread_state(config);
	state
		.as_object_mut()
		.ok_or("thread state must be object")?
		.insert("thread_id".into(), thread_id.into());
	persist_thread_state(config, &state)
}

fn merge_known_todos(config: &AppServerWorkerConfig, thread_id: &str, seed: Value) -> Value {
	let mut phases = load_thread_state(config)
		.get("todo_ledgers")
		.and_then(|v| v.get(thread_id))
		.cloned()
		.unwrap_or_else(|| json!([]));
	let Some(existing) = phases.as_array_mut() else {
		return seed;
	};
	let Some(seed_phases) = seed.as_array() else {
		return phases;
	};
	for phase in seed_phases {
		let name = phase
			.get("name")
			.and_then(Value::as_str)
			.unwrap_or_default();
		if !existing
			.iter()
			.any(|p| p.get("name").and_then(Value::as_str) == Some(name))
		{
			existing.push(phase.clone());
		}
	}
	phases
}

fn persist_known_todos(
	config: &AppServerWorkerConfig,
	thread_id: &str,
	phases: &Value,
) -> ClientResult<()> {
	let mut state = load_thread_state(config);
	let obj = state.as_object_mut().ok_or("thread state must be object")?;
	let ledgers = obj.entry("todo_ledgers").or_insert_with(|| json!({}));
	ledgers
		.as_object_mut()
		.ok_or("todo ledgers must be object")?
		.insert(thread_id.to_owned(), phases.clone());
	persist_thread_state(config, &state)
}

fn persist_thread_state(config: &AppServerWorkerConfig, state: &Value) -> ClientResult<()> {
	let path = thread_state_path(config);
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let tmp = path.with_extension("tmp");
	fs::write(&tmp, serde_json::to_vec(state)?)?;
	fs::rename(tmp, path)?;
	Ok(())
}

fn turn_status(params: &Value) -> ClientResult<String> {
	params
		.get("status")
		.and_then(Value::as_str)
		.map(str::to_owned)
		.ok_or_else(|| "turn/completed missing explicit status".into())
}

fn dirty_state_reminder(
	config: &AppServerWorkerConfig,
	row: &EventRow,
	slot_uid: Option<u32>,
) -> Option<String> {
	let repo = repo_info(row);
	let issue = issue_info(row);
	let workspace = workspace_info(config, row);
	let repo_dir = config.cwd.as_ref()?;
	let dirty = crate::git_ops::inspect_dirty_state(
		repo_dir,
		slot_uid,
		None,
		&crate::git_ops::RealCommandRunner,
	);
	if !dirty.is_dirty() {
		return None;
	}
	let dirty = persona::DirtyState {
		uncommitted: dirty.uncommitted > 0,
		unpushed: dirty.unpushed > 0,
		summary: dirty.summary,
	};
	persona::dirty_state_reminder(&repo, &issue, &workspace, &dirty).ok()
}

fn completion_reminder(
	config: &AppServerWorkerConfig,
	row: &EventRow,
	slot_uid: Option<u32>,
) -> String {
	let repo = repo_info(row);
	let issue = issue_info(row);
	let workspace = workspace_info(config, row);
	if let Some(prompt) = dirty_state_reminder(config, row, slot_uid) {
		return prompt;
	}
	persona::completion_reminder(&repo, &issue, &workspace)
		.unwrap_or_else(|_| "Finish the task or call an appropriate terminal host tool.".to_owned())
}

fn needs_post_turn_reminder(
	_config: &AppServerWorkerConfig,
	task_kind: &str,
	row: &EventRow,
	successful_terminal_tools: &std::collections::BTreeSet<String>,
) -> bool {
	if task_kind != "triage_issue" {
		return false;
	}
	let classification = row
		.payload
		.get("classification")
		.and_then(Value::as_str)
		.or_else(|| {
			row.payload
				.get("issue")
				.and_then(|i| i.get("classification"))
				.and_then(Value::as_str)
		});
	if !matches!(classification, Some("bug" | "documentation")) {
		return false;
	}
	!["gh_open_pr", "mark_unable_to_reproduce", "abort_task"]
		.iter()
		.any(|tool| successful_terminal_tools.contains(*tool))
}

fn capture_natives_cache(config: &AppServerWorkerConfig, row: &EventRow) -> std::io::Result<bool> {
	let (Some(root), Some(repo_dir), Some(repo)) =
		(&config.natives_cache_root, &config.cwd, row.repo.as_deref())
	else {
		return Ok(false);
	};
	let native_dir = repo_dir.join("packages/natives/native");
	let key = natives_cache::compute_key(repo_dir, None)?;
	Ok(NativesCache::new(root)?
		.capture(repo, &key, &native_dir, Some(&repo_dir.display().to_string()), None)?
		.is_some())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::app_server_client::TransportFuture;
	use crate::{github::GitHubClient, sandbox::LocalGitTransport};
	use std::sync::{Arc, Mutex};

	#[derive(Clone, Default)]
	struct FakeTransport {
		frames: Arc<Mutex<Vec<Value>>>,
		notes: Arc<Mutex<Vec<Value>>>,
	}
	impl FakeTransport {
		fn with_notes(notes: Vec<Value>) -> Self {
			Self { frames: Arc::new(Mutex::new(Vec::new())), notes: Arc::new(Mutex::new(notes)) }
		}
	}
	impl AppServerTransport for FakeTransport {
		fn send<'a>(&'a self, frame: Value) -> TransportFuture<'a, Value> {
			Box::pin(async move {
				self.frames.lock().unwrap().push(frame.clone());
				Ok(match frame["method"].as_str().unwrap() {
					"thread/start" => json!({"result":{"thread":{"id":"thread-start","generation":0}}}),
					"thread/resume" => {
						json!({"result":{"thread":{"id":frame["params"]["threadId"].as_str().unwrap(),"generation":1},"resumed":true}})
					},
					"turn/start" => json!({"result":{"turn":{"id":"turn-1"}}}),
					_ => json!({"result":{}}),
				})
			})
		}
		fn next_notification<'a>(&'a self) -> TransportFuture<'a, Option<Value>> {
			Box::pin(async move {
				let note = { self.notes.lock().unwrap().pop() };
				if note.is_some() {
					Ok(note)
				} else {
					std::future::pending::<ClientResult<Option<Value>>>().await
				}
			})
		}
		fn close<'a>(&'a self) -> TransportFuture<'a, ()> {
			Box::pin(async { Ok(()) })
		}
	}

	fn row(payload: Value) -> EventRow {
		EventRow {
			delivery_id: "d1".into(),
			event_type: "triage_issue".into(),
			repo: Some("o/r".into()),
			issue_key: Some("o/r#1".into()),
			payload,
			received_at: "now".into(),
			state: "queued".into(),
			attempts: 0,
			last_error: None,
		}
	}
	fn ctx() -> TaskContext {
		TaskContext { slot_uid: None, cancellations: Default::default() }
	}
	fn fake_dispatcher() -> HostToolDispatcher {
		Arc::new(|name, args| {
			if name == "abort_task" {
				Ok(host_tools::ToolResult {
					ok: true,
					text: args
						.get("reason")
						.and_then(Value::as_str)
						.unwrap_or("aborted")
						.to_owned(),
				})
			} else {
				Err(format!("unknown host tool: {name}"))
			}
		})
	}
	fn completed() -> Value {
		json!({"method":"turn/completed","params":{"status":"completed"}})
	}

	#[tokio::test]
	async fn worker_app_server_starts_thread_and_registers_host_tools() {
		let tmp = tempfile::tempdir().unwrap();
		let fake = FakeTransport::with_notes(vec![completed()]);
		let seen = fake.clone();
		let client = AppServerClient::new(fake);
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				hard_timeout: Duration::from_secs(1),
				session_dir: tmp.path().join("s"),
				..Default::default()
			},
			client,
		);
		let out = worker
			.run_app_server_task(row(json!({"prompt":"go"})), ctx())
			.await
			.unwrap();
		assert_eq!(out.thread_id, "thread-start");
		assert!(!out.natives_cache_captured);
		let frames = seen.frames.lock().unwrap();
		assert_eq!(
			frames
				.iter()
				.filter(|f| f["method"] == "initialize")
				.count(),
			1
		);
		assert!(frames.iter().any(|f| f["method"] == "gjc/hostTools/set"));
	}

	#[tokio::test]
	async fn worker_resume_uses_existing_thread_metadata() {
		let tmp = tempfile::tempdir().unwrap();
		let fake = FakeTransport::with_notes(vec![completed()]);
		let seen = fake.clone();
		let client = AppServerClient::new(fake);
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig { session_dir: tmp.path().join("s"), ..Default::default() },
			client,
		);
		let out = worker
			.run_app_server_task(row(json!({"threadId":"thread-old"})), ctx())
			.await
			.unwrap();
		assert_eq!(out.thread_id, "thread-old");
		assert!(
			seen
				.frames
				.lock()
				.unwrap()
				.iter()
				.any(|f| f["method"] == "thread/resume")
		);
	}

	#[tokio::test]
	async fn worker_late_arm_cancel_interrupts_tracked_turn_id() {
		let fake = FakeTransport::with_notes(Vec::new());
		let seen = fake.clone();
		let registry = crate::cancellation::CancellationRegistry::default();
		let client = AppServerClient::new(fake);
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				hard_timeout: Duration::from_secs(5),
				max_reminders: 0,
				..Default::default()
			},
			client,
		);
		let task_ctx = TaskContext { slot_uid: None, cancellations: registry.clone() };
		let handle = tokio::spawn(async move {
			worker
				.run_app_server_task(row(json!({})), task_ctx)
				.await
				.unwrap()
		});
		tokio::time::sleep(Duration::from_millis(50)).await;
		assert!(registry.cancel("d1"));
		let out = handle.await.unwrap();
		assert!(out.interrupted);
		assert!(
			seen
				.frames
				.lock()
				.unwrap()
				.iter()
				.any(|f| f["method"] == "turn/interrupt" && f["params"]["turnId"] == "turn-1")
		);
	}

	#[tokio::test]
	async fn worker_reminders_steer_before_timeout() {
		let fake = FakeTransport::with_notes(vec![completed(), completed()]);
		let client = AppServerClient::new(fake);
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				hard_timeout: Duration::from_millis(80),
				max_reminders: 1,
				..Default::default()
			},
			client,
		);
		let out = worker
			.run_app_server_task(row(json!({"classification":"bug"})), ctx())
			.await
			.unwrap();
		assert_eq!(out.reminders_sent, 1);
	}

	#[tokio::test]
	async fn worker_reminder_turn_dispatches_host_tool_before_completion() {
		let tmp = tempfile::tempdir().unwrap();
		let fake = FakeTransport::with_notes(vec![
			completed(),
			json!({"method":"gjc/hostTools/call","params":{"threadId":"thread-start","generation":0,"turnId":"turn-2","callId":"call-2","tool":"abort_task","args":{"reason":"reminder abort"}}}),
			completed(),
		]);
		let seen = fake.clone();
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				host_tool_dispatcher: Some(fake_dispatcher()),
				hard_timeout: Duration::from_millis(80),
				max_reminders: 1,
				session_dir: tmp.path().join("s"),
				..Default::default()
			},
			AppServerClient::new(fake),
		);
		let out = worker
			.run_app_server_task(row(json!({"classification":"bug"})), ctx())
			.await
			.unwrap();
		assert_eq!(out.reminders_sent, 1);
		assert!(
			seen
				.frames
				.lock()
				.unwrap()
				.iter()
				.any(|f| f["method"] == "gjc/hostTools/result"
					&& f["params"]["callId"] == "call-2"
					&& f["params"]["result"] == json!({"text":"reminder abort"}))
		);
	}

	#[tokio::test]
	async fn worker_app_server_dispatches_host_tool_call() {
		let fake = FakeTransport::with_notes(vec![
			completed(),
			json!({"method":"gjc/hostTools/call","params":{"threadId":"thread-start","generation":0,"turnId":"turn-1","callId":"call-1","tool":"abort_task","args":{"reason":"x"}}}),
		]);
		let seen = fake.clone();
		let client = AppServerClient::new(fake);
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				host_tool_dispatcher: Some(fake_dispatcher()),
				..Default::default()
			},
			client,
		);
		let out = worker
			.run_app_server_task(row(json!({})), ctx())
			.await
			.unwrap();
		assert!(!out.natives_cache_captured);
		assert!(
			seen
				.frames
				.lock()
				.unwrap()
				.iter()
				.any(|f| f["method"] == "gjc/hostTools/result"
					&& f["params"]["result"] == json!({"text":"x"}))
		);
	}

	#[tokio::test]
	async fn worker_default_runtime_dispatches_real_abort_tool_side_effect() {
		let tmp = tempfile::tempdir().unwrap();
		let repo = tmp.path().join("repo");
		std::fs::create_dir_all(&repo).unwrap();
		let db = Arc::new(Database::open(tmp.path().join("robogjc.sqlite")).unwrap());
		db.upsert_issue("o/r#1", "o/r", 1, "open", None, None, None)
			.unwrap();
		let fake = FakeTransport::with_notes(vec![
			completed(),
			json!({"method":"gjc/hostTools/call","params":{"threadId":"thread-start","generation":0,"turnId":"turn-1","callId":"call-1","tool":"abort_task","args":{"reason":"stop now"}}}),
		]);
		let seen = fake.clone();
		let runtime = AppServerHostToolRuntime {
			db: db.clone(),
			github: Arc::new(GitHubClient::with_base_url("token", "http://127.0.0.1:9").unwrap()),
			git_transport: Arc::new(LocalGitTransport::default()),
			settings: None,
			author_name: "bot".into(),
			author_email: "bot@example.invalid".into(),
		};
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				cwd: Some(repo),
				session_dir: tmp.path().join("s"),
				host_tool_runtime: Some(runtime),
				..Default::default()
			},
			AppServerClient::new(fake),
		);
		worker
			.run_app_server_task(row(json!({})), ctx())
			.await
			.unwrap();
		assert_eq!(db.get_issue("o/r#1").unwrap().unwrap().state, "abandoned");
		assert!(
			seen
				.frames
				.lock()
				.unwrap()
				.iter()
				.any(|f| f["method"] == "gjc/hostTools/result"
					&& f["params"]["result"] == json!({"text":"aborted"}))
		);
	}

	#[tokio::test]
	async fn worker_runtime_factory_dispatches_real_abort_tool_side_effect() {
		let tmp = tempfile::tempdir().unwrap();
		let repo = tmp.path().join("repo");
		std::fs::create_dir_all(&repo).unwrap();
		let db = Arc::new(Database::open(tmp.path().join("factory.sqlite")).unwrap());
		db.upsert_issue("o/r#1", "o/r", 1, "open", None, None, None)
			.unwrap();
		let fake = FakeTransport::with_notes(vec![
			completed(),
			json!({"method":"gjc/hostTools/call","params":{"threadId":"thread-start","generation":0,"turnId":"turn-1","callId":"call-1","tool":"abort_task","args":{"reason":"factory stop"}}}),
		]);
		let seen = fake.clone();
		let db_for_factory = db.clone();
		let config = AppServerWorkerConfig {
			cwd: Some(repo),
			session_dir: tmp.path().join("s"),
			host_tool_runtime_factory: Some(Arc::new(move |_row| AppServerHostToolRuntime {
				db: db_for_factory.clone(),
				github: Arc::new(GitHubClient::with_base_url("token", "http://127.0.0.1:9").unwrap()),
				git_transport: Arc::new(LocalGitTransport::default()),
				settings: None,
				author_name: "bot".into(),
				author_email: "bot@example.invalid".into(),
			})),
			..Default::default()
		};
		let worker = AppServerWorker::with_client(config, AppServerClient::new(fake));
		worker
			.run_app_server_task(row(json!({})), ctx())
			.await
			.unwrap();
		assert_eq!(db.get_issue("o/r#1").unwrap().unwrap().state, "abandoned");
		assert!(
			seen
				.frames
				.lock()
				.unwrap()
				.iter()
				.any(|f| f["method"] == "gjc/hostTools/result"
					&& f["params"]["result"] == json!({"text":"aborted"}))
		);
	}

	#[tokio::test]
	async fn worker_preserves_todo_ledger_across_followup_resume() {
		let tmp = tempfile::tempdir().unwrap();
		let config =
			AppServerWorkerConfig { session_dir: tmp.path().join("s"), ..Default::default() };
		persist_thread_id(&config, "thread-old").unwrap();
		persist_known_todos(&config, "thread-old", &json!([{"name":"existing","tasks":["keep me"]}]))
			.unwrap();
		let fake = FakeTransport::with_notes(vec![completed()]);
		let seen = fake.clone();
		let worker = AppServerWorker::with_client(config, AppServerClient::new(fake));
		worker
			.run_app_server_task(
				row(json!({"task_kind":"handle_comment","threadId":"thread-old"})),
				ctx(),
			)
			.await
			.unwrap();
		let frames = seen.frames.lock().unwrap();
		let set = frames
			.iter()
			.find(|f| f["method"] == "gjc/todos/set")
			.unwrap();
		let names: Vec<_> = set["params"]["phases"]
			.as_array()
			.unwrap()
			.iter()
			.filter_map(|p| p["name"].as_str())
			.collect();
		assert!(names.contains(&"existing"));
		assert!(names.len() > 1);
	}

	#[tokio::test]
	async fn worker_rejects_statusless_turn_completed() {
		let fake = FakeTransport::with_notes(vec![json!({"method":"turn/completed","params":{}})]);
		let tmp = tempfile::tempdir().unwrap();
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				max_reminders: 0,
				session_dir: tmp.path().join("s"),
				..Default::default()
			},
			AppServerClient::new(fake),
		);
		let err = worker
			.run_app_server_task(row(json!({})), ctx())
			.await
			.unwrap_err()
			.to_string();
		assert!(err.contains("missing explicit status"));
	}

	#[tokio::test]
	async fn worker_sends_dirty_reminder_for_non_triage_followup() {
		let tmp = tempfile::tempdir().unwrap();
		let repo = tmp.path().join("repo");
		std::fs::create_dir_all(&repo).unwrap();
		std::process::Command::new("git")
			.args(["init"])
			.current_dir(&repo)
			.status()
			.unwrap();
		std::process::Command::new("git")
			.args(["config", "user.email", "a@b.c"])
			.current_dir(&repo)
			.status()
			.unwrap();
		std::process::Command::new("git")
			.args(["config", "user.name", "a"])
			.current_dir(&repo)
			.status()
			.unwrap();
		std::fs::write(repo.join("dirty.txt"), "dirty").unwrap();
		let fake = FakeTransport::with_notes(vec![completed(), completed()]);
		let seen = fake.clone();
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig { cwd: Some(repo), max_reminders: 1, ..Default::default() },
			AppServerClient::new(fake),
		);
		let out = worker
			.run_app_server_task(row(json!({"task_kind":"handle_comment"})), ctx())
			.await
			.unwrap();
		assert_eq!(out.reminders_sent, 1);
		assert!(
			seen
				.frames
				.lock()
				.unwrap()
				.iter()
				.any(|f| f["method"] == "turn/steer" && f["params"]["reason"] == "dirty_state_reminder")
		);
	}

	#[tokio::test]
	async fn worker_success_only_natives_capture_uses_temp_cache_dir() {
		let tmp = tempfile::tempdir().unwrap();
		let repo = tmp.path().join("repo");
		std::fs::create_dir_all(repo.join("packages/natives/native")).unwrap();
		std::fs::write(repo.join("Cargo.toml"), "[workspace]\n").unwrap();
		std::fs::write(repo.join("Cargo.lock"), "").unwrap();
		std::fs::write(repo.join("packages/natives/native/pi_natives.test.node"), "node").unwrap();
		std::fs::write(repo.join("packages/natives/native/index.d.ts"), "dts").unwrap();
		std::fs::write(repo.join("packages/natives/native/index.js"), "js").unwrap();
		std::fs::write(repo.join("packages/natives/native/embedded-addon.js"), "addon").unwrap();
		std::process::Command::new("git")
			.args(["init"])
			.current_dir(&repo)
			.status()
			.unwrap();
		std::process::Command::new("git")
			.args(["config", "user.email", "a@b.c"])
			.current_dir(&repo)
			.status()
			.unwrap();
		std::process::Command::new("git")
			.args(["config", "user.name", "a"])
			.current_dir(&repo)
			.status()
			.unwrap();
		std::process::Command::new("git")
			.args(["add", "."])
			.current_dir(&repo)
			.status()
			.unwrap();
		std::process::Command::new("git")
			.args(["commit", "-m", "init"])
			.current_dir(&repo)
			.status()
			.unwrap();
		let cache = tmp.path().join("cache");
		let ok = FakeTransport::with_notes(vec![completed()]);
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				cwd: Some(repo.clone()),
				natives_cache_root: Some(cache.clone()),
				max_reminders: 0,
				..Default::default()
			},
			AppServerClient::new(ok),
		);
		assert!(
			worker
				.run_app_server_task(row(json!({})), ctx())
				.await
				.unwrap()
				.natives_cache_captured
		);
		let fail = FakeTransport::with_notes(Vec::new());
		let worker = AppServerWorker::with_client(
			AppServerWorkerConfig {
				cwd: Some(repo),
				natives_cache_root: Some(cache),
				hard_timeout: Duration::from_millis(1),
				max_reminders: 0,
				..Default::default()
			},
			AppServerClient::new(fail),
		);
		assert!(
			!worker
				.run_app_server_task(row(json!({})), ctx())
				.await
				.unwrap()
				.natives_cache_captured
		);
	}

	#[tokio::test]
	async fn phase7_ndjson_fixtures_replay_against_injectable_transport() {
		for (name, text) in [
			("start", include_str!("../tests/fixtures/phase7/start.ndjson")),
			("resume", include_str!("../tests/fixtures/phase7/resume.ndjson")),
			("host-tool", include_str!("../tests/fixtures/phase7/host-tool.ndjson")),
			("steer", include_str!("../tests/fixtures/phase7/steer.ndjson")),
			("interrupt", include_str!("../tests/fixtures/phase7/interrupt.ndjson")),
			("terminal-race", include_str!("../tests/fixtures/phase7/terminal-race.ndjson")),
		] {
			let frames = replay_fixture(name, text).await;
			let expected = expected_outbound(text);
			assert_ordered_subset(name, &expected, &frames);
		}
	}

	async fn replay_fixture(name: &str, text: &str) -> Vec<Value> {
		let notes: Vec<Value> = text
			.lines()
			.filter_map(|line| serde_json::from_str::<Value>(line).ok())
			.filter(|f| is_inbound_note(f))
			.rev()
			.collect();
		let fake = FakeTransport::with_notes(notes);
		let seen = fake.clone();
		let client = AppServerClient::new(fake);
		let tmp = tempfile::tempdir().unwrap();
		let mut config =
			AppServerWorkerConfig { session_dir: tmp.path().join("s"), ..Default::default() };
		let mut payload = json!({});
		match name {
			"start" => {
				config.cwd = Some(PathBuf::from("/repo"));
				config.session_id = "s1".into();
			},
			"resume" => {
				config.cwd = Some(PathBuf::from("/repo"));
				config.session_id = "s1".into();
				payload = json!({"threadId":"thread-old","prompt":"resume"});
			},
			"steer" => {
				config.hard_timeout = Duration::from_millis(80);
				config.max_reminders = 1;
				payload = json!({"classification":"bug"});
			},
			"interrupt" => {
				config.hard_timeout = Duration::from_millis(1);
				config.max_reminders = 0;
			},
			"terminal-race" => {
				payload = json!({"prompt":"long task"});
			},
			"host-tool" => {
				config.host_tool_dispatcher = Some(fake_dispatcher());
			},
			_ => {},
		}
		let worker = AppServerWorker::with_client(config, client);
		let _ = worker
			.run_app_server_task(row(payload), ctx())
			.await
			.unwrap();
		seen.frames.lock().unwrap().clone()
	}

	fn is_inbound_note(frame: &Value) -> bool {
		matches!(
			frame.get("method").and_then(Value::as_str),
			Some("turn/completed" | "gjc/hostTools/call" | "gjc/hostTools/cancel")
		)
	}

	fn expected_outbound(text: &str) -> Vec<Value> {
		text
			.lines()
			.filter_map(|line| serde_json::from_str::<Value>(line).ok())
			.filter(|f| !is_inbound_note(f))
			.collect()
	}

	fn assert_ordered_subset(name: &str, expected: &[Value], actual: &[Value]) {
		let mut pos = 0usize;
		for expected_frame in expected {
			let found = actual[pos..]
				.iter()
				.position(|actual_frame| frame_contains(actual_frame, expected_frame));
			let Some(offset) = found else {
				panic!("{name}: expected frame not replayed: {expected_frame}; actual: {actual:?}");
			};
			pos += offset + 1;
		}
	}

	fn frame_contains(actual: &Value, expected: &Value) -> bool {
		match (actual, expected) {
			(Value::Object(a), Value::Object(e)) => e.iter().all(|(key, value)| {
				a.get(key)
					.is_some_and(|actual_value| frame_contains(actual_value, value))
			}),
			(Value::Array(a), Value::Array(e)) => e.iter().enumerate().all(|(i, value)| {
				a.get(i)
					.is_some_and(|actual_value| frame_contains(actual_value, value))
			}),
			_ => actual == expected,
		}
	}
}
