//! Prompt template loading and rendering for robogjc personas.

use std::{
	collections::BTreeMap,
	path::{Path, PathBuf},
};

#[derive(Debug, Clone, Default)]
pub struct RepoInfo {
	pub full_name:      String,
	pub default_branch: String,
	pub clone_url:      String,
	pub private:        bool,
}
#[derive(Debug, Clone, Default)]
pub struct IssueInfo {
	pub repo:            String,
	pub number:          u64,
	pub title:           String,
	pub body:            String,
	pub state:           String,
	pub author:          String,
	pub labels:          Vec<String>,
	pub is_pull_request: bool,
}
#[derive(Debug, Clone, Default)]
pub struct Workspace {
	pub branch:      String,
	pub session_dir: String,
	pub context_dir: String,
	pub repo_dir:    String,
}
#[derive(Debug, Clone, Default)]
pub struct CommentInfo {
	pub id:         u64,
	pub author:     String,
	pub body:       String,
	pub created_at: String,
}
#[derive(Debug, Clone, Default)]
pub struct DirectiveInfo {
	pub body:   String,
	pub author: String,
	pub thread: Vec<ThreadMessage>,
}
#[derive(Debug, Clone, Default)]
pub struct ThreadMessage {
	pub kind:       String,
	pub author:     String,
	pub body:       String,
	pub created_at: String,
	pub path:       Option<String>,
	pub line:       Option<u64>,
	pub state:      Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DirtyState {
	pub uncommitted: bool,
	pub unpushed:    bool,
	pub summary:     String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoPhase {
	pub name:  String,
	pub tasks: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PromptAssets {
	root: PathBuf,
}

impl Default for PromptAssets {
	fn default() -> Self {
		Self { root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("prompts") }
	}
}
impl PromptAssets {
	pub fn new(root: impl Into<PathBuf>) -> Self {
		Self { root: root.into() }
	}

	pub fn path(&self) -> &Path {
		&self.root
	}

	pub fn load(&self, name: &str) -> std::io::Result<String> {
		std::fs::read_to_string(self.root.join(name))
	}

	pub fn load_toml(&self, name: &str) -> Result<toml::Value, String> {
		let text = self.load(name).map_err(|e| e.to_string())?;
		let table: toml::Table = toml::from_str(&text).map_err(|e| e.to_string())?;
		Ok(toml::Value::Table(table))
	}
}

fn lookup(path: &str, scope: &BTreeMap<String, String>) -> String {
	scope.get(path).cloned().unwrap_or_default()
}

pub fn render(template: &str, scope: &BTreeMap<String, String>) -> String {
	let mut out = String::with_capacity(template.len());
	let mut rest = template;
	while let Some(start) = rest.find("{{") {
		let (before, after_start) = rest.split_at(start);
		out.push_str(before);
		if let Some(end) = after_start.find("}}") {
			let key = after_start[2..end].trim();
			if key
				.chars()
				.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
			{
				out.push_str(&lookup(key, scope));
			} else {
				out.push_str(&after_start[..end + 2]);
			}
			rest = &after_start[end + 2..];
		} else {
			out.push_str(after_start);
			return out;
		}
	}
	out.push_str(rest);
	out
}

fn base_scope(
	repo: &RepoInfo,
	issue: &IssueInfo,
	workspace: &Workspace,
) -> BTreeMap<String, String> {
	BTreeMap::from([
		("repo.full_name".to_owned(), repo.full_name.clone()),
		("repo.default_branch".to_owned(), repo.default_branch.clone()),
		("repo.clone_url".to_owned(), repo.clone_url.clone()),
		("repo.private".to_owned(), repo.private.to_string()),
		("issue.repo".to_owned(), issue.repo.clone()),
		("issue.number".to_owned(), issue.number.to_string()),
		("issue.title".to_owned(), issue.title.clone()),
		("issue.body".to_owned(), issue.body.clone()),
		("issue.state".to_owned(), issue.state.clone()),
		("issue.author".to_owned(), issue.author.clone()),
		("issue.labels".to_owned(), issue.labels.join(", ")),
		("workspace.branch".to_owned(), workspace.branch.clone()),
		("workspace.session_dir".to_owned(), workspace.session_dir.clone()),
		("workspace.context_dir".to_owned(), workspace.context_dir.clone()),
		("workspace.repo_dir".to_owned(), workspace.repo_dir.clone()),
	])
}

pub fn render_thread(messages: &[ThreadMessage]) -> String {
	if messages.is_empty() {
		return "(no prior conversation)".to_owned();
	}
	let mut parts = Vec::new();
	for m in messages {
		let kind = if m.kind.is_empty() {
			"comment"
		} else {
			&m.kind
		};
		let author = if m.author.is_empty() {
			"unknown"
		} else {
			&m.author
		};
		let mut header = match kind {
			"issue_body" => format!("### @{author} — issue body"),
			"pr_body" => format!("### @{author} — PR body"),
			"review_comment" => {
				let path = m.path.clone().unwrap_or_default();
				let line = m.line.map(|n| format!(":L{n}")).unwrap_or_default();
				format!("### @{author} — review comment on `{path}`{line}")
			},
			"review" => {
				format!("### @{author} — review ({})", m.state.as_deref().unwrap_or("COMMENTED"))
			},
			_ => format!("### @{author} — comment"),
		};
		if !m.created_at.is_empty() {
			use std::fmt::Write as _;
			let _ = write!(header, " *({})*", m.created_at);
		}
		parts.push(header);
		parts.push(String::new());
		parts.push(m.body.trim_end().to_owned());
		parts.push(String::new());
	}
	parts.join("\n").trim_end().to_owned()
}

fn inbound_scope(issue: &IssueInfo, pr_number: Option<u64>) -> (String, String) {
	pr_number.map_or_else(
		|| ("issue".to_owned(), issue.number.to_string()),
		|n| ("PR".to_owned(), n.to_string()),
	)
}
fn origin_scope(issue: &IssueInfo) -> String {
	if issue.is_pull_request {
		"originating issue unknown; handling this PR directly".to_owned()
	} else {
		format!("originating issue #{}", issue.number)
	}
}

pub fn render_named(name: &str, scope: &BTreeMap<String, String>) -> std::io::Result<String> {
	Ok(render(&PromptAssets::default().load(name)?, scope))
}
pub fn render_named_with_assets(
	assets: &PromptAssets,
	name: &str,
	scope: &BTreeMap<String, String>,
) -> std::io::Result<String> {
	Ok(render(&assets.load(name)?, scope))
}

pub fn system_append(
	repo: &RepoInfo,
	issue: &IssueInfo,
	workspace: &Workspace,
) -> std::io::Result<String> {
	render_named("system_append.md", &base_scope(repo, issue, workspace))
}
pub fn kickoff(
	repo: &RepoInfo,
	issue: &IssueInfo,
	workspace: &Workspace,
) -> std::io::Result<String> {
	render_named("kickoff_issue.md", &base_scope(repo, issue, workspace))
}
pub fn completion_reminder(
	repo: &RepoInfo,
	issue: &IssueInfo,
	workspace: &Workspace,
) -> std::io::Result<String> {
	render_named("completion_reminder.md", &base_scope(repo, issue, workspace))
}
pub fn dirty_state_reminder(
	repo: &RepoInfo,
	issue: &IssueInfo,
	workspace: &Workspace,
	dirty: &DirtyState,
) -> std::io::Result<String> {
	let mut scope = base_scope(repo, issue, workspace);
	scope.insert("dirty.uncommitted".to_owned(), dirty.uncommitted.to_string());
	scope.insert("dirty.unpushed".to_owned(), dirty.unpushed.to_string());
	scope.insert("dirty.summary".to_owned(), dirty.summary.clone());
	render_named("dirty_state_reminder.md", &scope)
}
pub fn resume_triage(
	repo: &RepoInfo,
	issue: &IssueInfo,
	workspace: &Workspace,
) -> std::io::Result<String> {
	render_named("resume_triage.md", &base_scope(repo, issue, workspace))
}
pub fn kickoff_directive(
	repo: &RepoInfo,
	issue: &IssueInfo,
	workspace: &Workspace,
	directive: &DirectiveInfo,
) -> std::io::Result<String> {
	let mut scope = base_scope(repo, issue, workspace);
	scope.insert("directive.body".to_owned(), directive.body.clone());
	scope.insert("directive.author".to_owned(), directive.author.clone());
	scope.insert("thread".to_owned(), render_thread(&directive.thread));
	render_named("kickoff_directive.md", &scope)
}
pub fn followup_comment(
	repo: &RepoInfo,
	issue: &IssueInfo,
	comment: &CommentInfo,
	workspace: &Workspace,
	pr_status: &str,
	pr_number: Option<u64>,
	thread: &[ThreadMessage],
) -> std::io::Result<String> {
	let mut scope = base_scope(repo, issue, workspace);
	let (kind, number) = inbound_scope(issue, pr_number);
	scope.extend(BTreeMap::from([
		("comment.author".to_owned(), comment.author.clone()),
		("comment.body".to_owned(), comment.body.clone()),
		("comment.created_at".to_owned(), comment.created_at.clone()),
		("thread".to_owned(), render_thread(thread)),
		("state.pr_status".to_owned(), pr_status.to_owned()),
		("inbound.kind".to_owned(), kind),
		("inbound.number".to_owned(), number),
		("origin.description".to_owned(), origin_scope(issue)),
	]));
	render_named("followup_comment.md", &scope)
}
pub fn directive(
	repo: &RepoInfo,
	issue: &IssueInfo,
	comment: &CommentInfo,
	workspace: &Workspace,
	directive: &DirectiveInfo,
	pr_status: &str,
	pr_number: Option<u64>,
) -> std::io::Result<String> {
	let mut scope = base_scope(repo, issue, workspace);
	let (kind, number) = inbound_scope(issue, pr_number);
	scope.extend(BTreeMap::from([
		("comment.author".to_owned(), comment.author.clone()),
		("comment.body".to_owned(), comment.body.clone()),
		("comment.created_at".to_owned(), comment.created_at.clone()),
		("directive.body".to_owned(), directive.body.clone()),
		("directive.author".to_owned(), directive.author.clone()),
		("thread".to_owned(), render_thread(&directive.thread)),
		("state.pr_status".to_owned(), pr_status.to_owned()),
		("inbound.kind".to_owned(), kind),
		("inbound.number".to_owned(), number),
		("origin.description".to_owned(), origin_scope(issue)),
	]));
	render_named("directive.md", &scope)
}
pub fn followup_review(
	repo: &RepoInfo,
	workspace: &Workspace,
	pr_number: u64,
	comment_author: &str,
	comment_body: &str,
	comment_path: &str,
	comment_line_range: &str,
) -> std::io::Result<String> {
	let scope = BTreeMap::from([
		("repo.full_name".to_owned(), repo.full_name.clone()),
		("repo.default_branch".to_owned(), repo.default_branch.clone()),
		("repo.clone_url".to_owned(), repo.clone_url.clone()),
		("repo.private".to_owned(), repo.private.to_string()),
		("workspace.branch".to_owned(), workspace.branch.clone()),
		("workspace.session_dir".to_owned(), workspace.session_dir.clone()),
		("workspace.context_dir".to_owned(), workspace.context_dir.clone()),
		("workspace.repo_dir".to_owned(), workspace.repo_dir.clone()),
		("pr.number".to_owned(), pr_number.to_string()),
		("comment.author".to_owned(), comment_author.to_owned()),
		("comment.body".to_owned(), comment_body.to_owned()),
		("comment.path".to_owned(), comment_path.to_owned()),
		("comment.line_range".to_owned(), comment_line_range.to_owned()),
	]);
	render_named("followup_review.md", &scope)
}

pub fn unable_to_reproduce_comment(diagnosis: &str, info_needed: &str) -> std::io::Result<String> {
	let scope = BTreeMap::from([
		("diagnosis".to_owned(), diagnosis.to_owned()),
		("info_needed".to_owned(), info_needed.to_owned()),
	]);
	render_named("unable_to_reproduce_comment.md", &scope)
}

pub fn finalized_issue_comment() -> std::io::Result<String> {
	Ok(PromptAssets::default()
		.load("finalized_issue_comment.md")?
		.trim()
		.to_owned())
}
pub fn finalized_pr_comment() -> std::io::Result<String> {
	Ok(PromptAssets::default()
		.load("finalized_pr_comment.md")?
		.trim()
		.to_owned())
}
pub const fn bare_mention_reply() -> &'static str {
	"What would you like me to do?"
}
pub fn question_autoclose_suffix(hours: f64) -> std::io::Result<String> {
	let rendered = if hours.fract() == 0.0 {
		format!("{}", hours as i64)
	} else {
		format!("{hours}")
	};
	let scope = BTreeMap::from([("hours".to_owned(), rendered)]);
	Ok(render_named("question_autoclose_suffix.md", &scope)?
		.trim_end()
		.to_owned())
}

fn toml_table<'a>(value: &'a toml::Value, context: &str) -> Result<&'a toml::Table, String> {
	value
		.as_table()
		.ok_or_else(|| format!("{context} must be a table"))
}
fn toml_nonempty_str(value: Option<&toml::Value>, context: &str) -> Result<String, String> {
	let Some(s) = value.and_then(toml::Value::as_str) else {
		return Err(format!("{context} must be a non-empty string"));
	};
	if s.trim().is_empty() {
		Err(format!("{context} must be a non-empty string"))
	} else {
		Ok(s.to_owned())
	}
}
fn todo_phases_with_assets(
	assets: &PromptAssets,
	task_kind: &str,
) -> Result<Vec<TodoPhase>, String> {
	let value = assets.load_toml("todo_phases.toml")?;
	let Some(raw_phases) = value.get(task_kind) else {
		return Ok(Vec::new());
	};
	let phases = raw_phases
		.as_array()
		.ok_or_else(|| format!("todo_phases.toml[{task_kind:?}] must be a list of phases"))?;
	let mut out = Vec::with_capacity(phases.len());
	for (phase_index, raw_phase) in phases.iter().enumerate() {
		let context = format!("todo_phases.toml[{task_kind:?}][{phase_index}]");
		let phase = toml_table(raw_phase, &context)?;
		let name = toml_nonempty_str(phase.get("name"), &format!("{context}.name"))?;
		let raw_tasks = phase
			.get("tasks")
			.and_then(toml::Value::as_array)
			.ok_or_else(|| format!("{context}.tasks must be a non-empty list"))?;
		if raw_tasks.is_empty() {
			return Err(format!("{context}.tasks must be a non-empty list"));
		}
		let mut tasks = Vec::with_capacity(raw_tasks.len());
		for (task_index, task) in raw_tasks.iter().enumerate() {
			tasks.push(toml_nonempty_str(Some(task), &format!("{context}.tasks[{task_index}]"))?);
		}
		out.push(TodoPhase { name, tasks });
	}
	Ok(out)
}

pub fn seed_phases(task_kind: &str) -> Result<Vec<TodoPhase>, String> {
	todo_phases_with_assets(&PromptAssets::default(), task_kind)
}
fn host_tool_entry(tool_name: &str) -> Result<toml::Table, String> {
	let value = PromptAssets::default().load_toml("host_tools.toml")?;
	Ok(toml_table(
		value
			.get(tool_name)
			.ok_or_else(|| format!("host_tools.toml[{tool_name:?}] missing"))?,
		&format!("host_tools.toml[{tool_name:?}]"),
	)?
	.clone())
}
pub fn host_tool_description(tool_name: &str) -> Result<String, String> {
	let entry = host_tool_entry(tool_name)?;
	toml_nonempty_str(
		entry.get("description"),
		&format!("host_tools.toml[{tool_name:?}].description"),
	)
}
pub fn host_tool_parameter_description(
	tool_name: &str,
	parameter_name: &str,
) -> Result<String, String> {
	let entry = host_tool_entry(tool_name)?;
	let params = toml_table(
		entry
			.get("parameters")
			.ok_or_else(|| format!("host_tools.toml[{tool_name:?}].parameters missing"))?,
		&format!("host_tools.toml[{tool_name:?}].parameters"),
	)?;
	toml_nonempty_str(
		params.get(parameter_name),
		&format!("host_tools.toml[{tool_name:?}].parameters[{parameter_name:?}]"),
	)
}
pub fn classify_next_step(primary: &str) -> Result<String, String> {
	let entry = host_tool_entry("classify_issue")?;
	let steps = toml_table(
		entry
			.get("next_steps")
			.ok_or_else(|| "host_tools.toml['classify_issue'].next_steps missing".to_owned())?,
		"host_tools.toml['classify_issue'].next_steps",
	)?;
	toml_nonempty_str(
		steps.get(primary),
		&format!("host_tools.toml['classify_issue'].next_steps[{primary:?}]"),
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	fn repo() -> RepoInfo {
		RepoInfo {
			full_name: "octo/widget".into(),
			default_branch: "main".into(),
			..Default::default()
		}
	}
	fn issue() -> IssueInfo {
		IssueInfo {
			repo: "octo/widget".into(),
			number: 1080,
			title: "broken thing".into(),
			body: "the body text".into(),
			state: "open".into(),
			author: "alice".into(),
			..Default::default()
		}
	}
	fn ws() -> Workspace {
		Workspace {
			branch:      "farm/abc/test".into(),
			session_dir: "/tmp/session".into(),
			context_dir: "/tmp/ctx".into(),
			repo_dir:    "/tmp/repo".into(),
		}
	}
	fn comment(body: &str) -> CommentInfo {
		CommentInfo {
			id:         1,
			author:     "can1357".into(),
			body:       body.into(),
			created_at: "2026-05-14T20:00:00Z".into(),
		}
	}
	#[test]
	fn render_thread_empty_yields_placeholder() {
		assert!(render_thread(&[]).starts_with("(no prior"));
	}
	#[test]
	fn render_thread_orders_kinds_with_appropriate_headers() {
		let thread = vec![
			ThreadMessage {
				kind: "issue_body".into(),
				author: "alice".into(),
				body: "orig report".into(),
				..Default::default()
			},
			ThreadMessage {
				kind: "comment".into(),
				author: "bob".into(),
				body: "me too".into(),
				created_at: "2026-05-01T10:00:00Z".into(),
				..Default::default()
			},
			ThreadMessage {
				kind: "review_comment".into(),
				author: "codex".into(),
				body: "leak here".into(),
				created_at: "2026-05-02T10:00:00Z".into(),
				path: Some("src/foo.py".into()),
				line: Some(42),
				..Default::default()
			},
			ThreadMessage {
				kind: "review".into(),
				author: "codex".into(),
				body: "two issues".into(),
				created_at: "2026-05-02T10:01:00Z".into(),
				state: Some("CHANGES_REQUESTED".into()),
				..Default::default()
			},
		];
		let out = render_thread(&thread);
		assert!(out.contains("### @alice — issue body"));
		assert!(out.contains("### @bob — comment *(2026-05-01T10:00:00Z)*"));
		assert!(out.contains("### @codex — review comment on `src/foo.py`:L42"));
		assert!(out.contains("### @codex — review (CHANGES_REQUESTED)"));
	}
	#[test]
	fn directive_prompt_embeds_thread_and_directive_body() {
		let thread = vec![ThreadMessage {
			kind: "comment".into(),
			author: "alice".into(),
			body: "follow up please".into(),
			created_at: "2026-05-01T10:00:00Z".into(),
			..Default::default()
		}];
		let d = DirectiveInfo { body: "apply fix Y".into(), author: "can1357".into(), thread };
		let out = directive(
			&repo(),
			&issue(),
			&comment("@robogjc please fix"),
			&ws(),
			&d,
			"PR #1080 is open",
			None,
		)
		.unwrap();
		assert!(out.contains("Directive on octo/widget#1080"));
		assert!(out.contains("@can1357"));
		assert!(out.contains("apply fix Y"));
		assert!(out.contains("follow up please"));
		assert!(out.contains("PR #1080 is open"));
	}
	#[test]
	fn followup_comment_prompt_embeds_thread_context() {
		let thread = vec![
			ThreadMessage {
				kind: "pr_body".into(),
				author: "robogjc".into(),
				body: "PR body".into(),
				..Default::default()
			},
			ThreadMessage {
				kind: "comment".into(),
				author: "can1357".into(),
				body: "prior request".into(),
				created_at: "2026-05-01T10:00:00Z".into(),
				..Default::default()
			},
		];
		let out = followup_comment(
			&repo(),
			&issue(),
			&comment("current request"),
			&ws(),
			"PR #1080 is open",
			Some(1080),
			&thread,
		)
		.unwrap();
		assert!(out.contains("Prior conversation"));
		assert!(out.contains("PR body"));
		assert!(out.contains("prior request"));
		assert!(out.contains("current request"));
	}
	#[test]
	fn kickoff_directive_prompt_embeds_thread_and_classify_instruction() {
		let thread = vec![ThreadMessage {
			kind: "issue_body".into(),
			author: "alice".into(),
			body: "failing on macos".into(),
			..Default::default()
		}];
		let d = DirectiveInfo { body: "reproduce + fix".into(), author: "can1357".into(), thread };
		let out = kickoff_directive(&repo(), &issue(), &ws(), &d).unwrap();
		assert!(out.contains("Maintainer directive on octo/widget#1080"));
		assert!(out.contains("failing on macos"));
		assert!(out.contains("reproduce + fix"));
		assert!(out.contains("Classify first"));
	}
	#[test]
	fn resume_triage_renders_branch_and_issue() {
		let out = resume_triage(&repo(), &issue(), &ws()).unwrap();
		assert!(out.contains("farm/abc/test"));
		assert!(out.contains("octo/widget#1080"));
		assert!(out.contains("broken thing"));
		assert!(out.contains("fetch_issue_thread"));
	}
	#[test]
	fn full_prompt_surface_renders_core_branches() {
		let repo = repo();
		let issue = issue();
		let ws = ws();
		assert!(
			system_append(&repo, &issue, &ws)
				.unwrap()
				.contains("octo/widget")
		);
		assert!(
			kickoff(&repo, &issue, &ws)
				.unwrap()
				.contains("broken thing")
		);
		assert!(
			completion_reminder(&repo, &issue, &ws)
				.unwrap()
				.contains("terminal")
		);
		let dirty =
			DirtyState { uncommitted: true, unpushed: true, summary: "M file.rs".into() };
		assert!(
			dirty_state_reminder(&repo, &issue, &ws, &dirty)
				.unwrap()
				.contains("M file.rs")
		);
		assert!(
			followup_review(&repo, &ws, 123, "reviewer", "please fix", "src/lib.rs", "L4-L8")
				.unwrap()
				.contains("src/lib.rs")
		);
		assert!(
			unable_to_reproduce_comment("no repro", "logs")
				.unwrap()
				.contains("no repro")
		);
		assert!(!finalized_issue_comment().unwrap().is_empty());
		assert!(!finalized_pr_comment().unwrap().is_empty());
		assert_eq!(bare_mention_reply(), "What would you like me to do?");
		assert!(question_autoclose_suffix(4.0).unwrap().contains('4'));
	}

	#[test]
	fn host_tool_toml_lookups_are_validated() {
		assert!(
			host_tool_description("classify_issue")
				.unwrap()
				.contains("Classify")
		);
		assert!(
			host_tool_parameter_description("classify_issue", "primary")
				.unwrap()
				.contains("primary")
		);
		assert!(classify_next_step("bug").unwrap().contains("reproduce"));
		assert!(host_tool_description("missing_tool").is_err());
	}
	#[test]
	fn seed_phases_loads_todo_phase_contracts() {
		let triage = seed_phases("triage_issue").unwrap();
		assert_eq!(triage[0].name, "Classify");
		assert!(
			triage[0]
				.tasks
				.iter()
				.any(|task| task.contains("classify_issue"))
		);
		assert_eq!(triage[1].name, "Respond");
		let comment = seed_phases("handle_comment").unwrap();
		assert_eq!(comment[0].name, "Follow up");
		let review = seed_phases("handle_review").unwrap();
		assert_eq!(review[0].name, "Review response");
		assert!(seed_phases("unknown_kind").unwrap().is_empty());
	}

	#[test]
	fn seed_phases_rejects_malformed_toml_shapes() {
		let dir = std::env::temp_dir().join(format!("robogjc-persona-test-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		std::fs::write(dir.join("todo_phases.toml"), "triage_issue = \"bad\"\n").unwrap();
		let assets = PromptAssets::new(&dir);
		assert!(
			todo_phases_with_assets(&assets, "triage_issue")
				.unwrap_err()
				.contains("must be a list of phases")
		);
		std::fs::write(
			dir.join("todo_phases.toml"),
			"[[triage_issue]]\nname = \"Classify\"\ntasks = []\n",
		)
		.unwrap();
		assert!(
			todo_phases_with_assets(&assets, "triage_issue")
				.unwrap_err()
				.contains("must be a non-empty list")
		);
		std::fs::write(
			dir.join("todo_phases.toml"),
			"[[triage_issue]]\nname = \" \"\ntasks = [\"Read\"]\n",
		)
		.unwrap();
		assert!(
			todo_phases_with_assets(&assets, "triage_issue")
				.unwrap_err()
				.contains("name must be a non-empty string")
		);
		let _ = std::fs::remove_dir_all(&dir);
	}
}
