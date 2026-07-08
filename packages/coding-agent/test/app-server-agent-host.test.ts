import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AgentSessionHost, type AppServerEventEmitter } from "../src/modes/app-server/agent-session-host";
import type { AgentSessionEvent } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { AsyncJobManager } from "../src/async";
import { CronTool, resetCronRegistryForTests } from "../src/tools/cron";

class FakeSession {
	readonly sessionId = "thr_fake_session";
	readonly events: Array<(event: AgentSessionEvent) => void> = [];
	readonly jobChangeListeners: Array<() => void> = [];
	jobSnapshot: any = {
		running: [
			{
				id: "j1",
				type: "bash",
				status: "running",
				label: "watch",
				startTime: "2026-01-01T00:00:00.000Z",
				metadata: { monitor: true, kind: "log", description: "tail server log" },
			},
		],
		recent: [
			{
				id: "t1",
				type: "task",
				status: "completed",
				label: "task job",
				metadata: {
					subagent: { id: "0-ExecSlice", agent: "executor", description: "bounded fix slice" },
					outputRef: "artifact-ref-1",
				},
			},
		],
	};
	jobsObserver = {
		onChange: (listener: () => void): (() => void) => {
			this.jobChangeListeners.push(listener);
			return () => {
				const index = this.jobChangeListeners.indexOf(listener);
				if (index !== -1) this.jobChangeListeners.splice(index, 1);
			};
		},
	};
	prompts: Array<{ text: string; options: unknown }> = [];
	state = { status: "idle", todos: [{ id: "t1", content: "ship", status: "pending" }] };
	messages: unknown[] = [];
	models: unknown[] = [];
	compactions: unknown[] = [];
	todos: unknown[] = [];
	execCalls: Array<{ command: string; options: unknown }> = [];
	abortCount = 0;
	retryCount = 0;
	disposeCount = 0;
	goalState: unknown = { enabled: true, goal: { objective: "Ship G008", status: "active", tokensUsed: 123 } };
	modelRegistry = {
		getAll: () => [
			{ provider: "anthropic", id: "claude-opus", name: "Claude Opus" },
			{ provider: "openai", id: "gpt-4.1", name: "GPT 4.1" },
		],
	};
	settingsRoles: Record<string, string> = {};
	settingsValues: Record<string, unknown> = { modelRoles: this.settingsRoles, "task.agentModelOverrides": {}, "modelProfile.default": undefined };
	activeModelProfile: string | undefined;
	getActiveModelProfile = () => this.activeModelProfile;
	setActiveModelProfile = (profile: string | undefined) => {
		this.activeModelProfile = profile;
	};
	settings = {
		get: (key: string) => this.settingsValues[key],
		set: (key: string, value: unknown) => {
			this.settingsValues[key] = value;
		},
		setModelRole: (role: string, selector: string) => {
			this.settingsRoles[role] = selector;
		},
		clearOverride: () => {},
		override: (key: string, value: unknown) => {
			this.settingsValues[`override:${key}`] = value;
		},
		flush: async () => {},
	};
	sessionManager = {
		labels: [] as Array<{ entryId: string; label: string | undefined }>,
		leafId: "leaf",
		getEntries: () => [
			{
				type: "compaction",
				id: "c1",
				summary: "safe sk-12345678901234567890",
				tokensBefore: 42,
				timestamp: "2026-01-01T00:03:00.000Z",
			},
		],
		getLeafId: () => this.sessionManager.leafId,
		appendLabelChange: (entryId: string, label: string | undefined) => {
			this.sessionManager.labels.push({ entryId, label });
		},
		getTree: () => [
			{
				entry: {
					id: "root",
					parentId: null,
					type: "message",
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "root message" },
				},
				label: "Root label",
				children: [
					{
						entry: {
							id: "leaf",
							parentId: "root",
							type: "custom",
							timestamp: "2026-01-01T00:01:00.000Z",
							customType: "x",
						},
						children: [],
					},
					{
						entry: {
							id: "side",
							parentId: "root",
							type: "message",
							timestamp: "2026-01-01T00:02:00.000Z",
							message: { role: "assistant", content: "s".repeat(140) },
						},
						children: [],
					},
				],
			},
		],
	};

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.events.push(listener);
		return () => {
			const index = this.events.indexOf(listener);
			if (index !== -1) this.events.splice(index, 1);
		};
	}
	fireJobChange(): void {
		for (const listener of this.jobChangeListeners) listener();
	}


	async prompt(text: string, options?: unknown): Promise<void> {
		this.prompts.push({ text, options });
	}

	async steer(): Promise<void> {}
	async retry(): Promise<boolean> {
		this.retryCount += 1;
		return true;
	}
	async abort(): Promise<void> {
		this.abortCount += 1;
	}
	async executeBash(command: string, _onChunk?: unknown, options?: unknown): Promise<unknown> {
		this.execCalls.push({ command, options });
		return { exitCode: 0 };
	}
	async setModel(model: unknown, role?: unknown, options?: unknown): Promise<void> {
		this.models.push({ model, role, options });
	}
	async compact(customInstructions?: unknown): Promise<unknown> {
		this.compactions.push(customInstructions);
		return { ok: true };
	}
	async setTodos(todos: unknown): Promise<void> {
		this.todos.push(todos);
	}
	async navigateTree(entryId: string): Promise<{ cancelled: boolean }> {
		this.sessionManager.leafId = entryId;
		return { cancelled: false };
	}

	async branch(entryId: string): Promise<{ cancelled: boolean }> {
		this.sessionManager.leafId = entryId;
		return { cancelled: false };
	}

	async buildForkContextSeed(): Promise<any> {
		return {
			messages: [{ role: "user", content: "source context" }],
			agentMessages: [{ role: "user", content: "source context" }],
			metadata: {
				sourceSessionId: this.sessionId,
				parentMessageCount: 1,
				includedMessages: 1,
				skippedMessages: 0,
				approximateTokens: 2,
				maxMessages: 500,
				maxTokens: 200000,
				skippedReasons: {},
			},
			cacheIdentity: this.sessionId,
		};
	}
	async dispose(): Promise<void> {
		this.disposeCount += 1;
	}
	getSessionStats(): unknown {
		return {
			tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 5, total: 26 },
			perModel: [{ provider: "openai", modelId: "gpt", input: 11, output: 7, cost: 0.2 }],
			totalCost: 0.2,
			cost: 99,
		};
	}
	getAsyncJobSnapshot(): unknown {
		return this.jobSnapshot;
	}
	getAgentId(): string {
		return "0-Test";
	}
	getContextUsage(): unknown {
		return { tokens: 20, contextWindow: 100, percent: 20 };
	}
	getGoalModeState(): unknown {
		return this.goalState;
	}
}

class FakeAuthStorage {
	#providers = new Set<string>();
	constructor(providers: string[] = []) {
		for (const provider of providers) this.#providers.add(provider);
	}
	list(): string[] {
		return [...this.#providers];
	}
	hasAuth(provider: string): boolean {
		return this.#providers.has(provider);
	}
	hasOAuth(provider: string): boolean {
		return this.#providers.has(provider);
	}
	async remove(provider: string): Promise<void> {
		this.#providers.delete(provider);
	}
}

describe("AgentSessionHost", () => {
	it("creates a session-backed thread and subscribes to events", async () => {
		const sessions: FakeSession[] = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => {
				const session = new FakeSession();
				sessions.push(session);
				return { session };
			},
		});

		const created = await host.createThread({ cwd: "/tmp/work" });

		expect(created.threadId).toBe("thr_fake_session");
		expect(created.sessionMetadata).toEqual({ cwd: "/tmp/work", sessionId: "thr_fake_session" });
		expect(sessions).toHaveLength(1);
		expect(sessions[0].events).toHaveLength(1);
	});

	it("maps app-server session metadata into createAgentSession options and returns it", async () => {
		const session = new FakeSession();
		let capturedOptions: any;
		const host = new AgentSessionHost({
			sessionFactory: async options => {
				capturedOptions = options;
				return { session };
			},
		});
		const created = await host.createThread({
			cwd: "/repo",
			sessionId: "provider-session",
			sessionDir: "/sessions/one",
			systemPromptAppend: "extra system",
			model: { provider: "anthropic", modelId: "claude" },
			thinking: { level: "high" },
			todos: [{ text: "ship" }],
		});

		expect(capturedOptions.cwd).toBe("/repo");
		expect(capturedOptions.providerSessionId).toBe("provider-session");
		expect(capturedOptions.model).toBeUndefined();
		expect(capturedOptions.modelPattern).toBe("anthropic/claude");
		expect(capturedOptions.thinkingLevel).toBe("high");
		expect(capturedOptions.systemPrompt(["base"])).toEqual(["base", "extra system"]);
		expect(created).toEqual({
			threadId: "thr_fake_session",
			resumed: false,
			sessionMetadata: {
				cwd: "/repo",
				sessionId: "thr_fake_session",
				sessionDir: "/sessions/one",
				systemPromptAppend: "extra system",
				model: { provider: "anthropic", modelId: "claude" },
				thinking: { level: "high" },
				todos: [{ text: "ship" }],
			},
		});
	});

	it("returns an explicit resume fallback diagnostic when true SDK resume is unavailable", async () => {
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session: new FakeSession() }) });
		const created = await host.resumeThread({ cwd: "/repo", sessionId: "existing", sessionDir: "/sessions/one" });

		expect(created.resumed).toBe(false);
		expect(created.sessionMetadata).toMatchObject({
			cwd: "/repo",
			sessionId: "thr_fake_session",
			sessionDir: "/sessions/one",
			resumed: false,
		});
	});

	it("routes prompt backend calls and returns a turn id", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		const result = await host.backendCall(created.threadId, "prompt", { text: "hello", options: { foo: true } });

		expect(session.prompts).toEqual([{ text: "hello", options: { foo: true } }]);
		expect(result).toEqual({ turnId: "thr_fake_session:1" });
	});

	it("routes retry backend calls through AgentSession.retry", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		const result = await host.backendCall(created.threadId, "retry", null);

		expect(session.retryCount).toBe(1);
		expect(result).toEqual({ turnId: "thr_fake_session:1" });
	});

	it("maps readGoal to active goal-mode state", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		const result = await host.backendCall(created.threadId, "readGoal", null);

		expect(result).toEqual({ active: true, objective: "Ship G008", status: "active", tokensUsed: 123 });
	});

	it("scrubs and truncates goal objective in readGoal DTO", async () => {
		const session = new FakeSession();
		session.goalState = {
			enabled: true,
			goal: { objective: `prefix sk-abcdefgh12345678 ${"x".repeat(3000)}`, status: "active" },
		};
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		const result = (await host.backendCall(created.threadId, "readGoal", null)) as { objective?: string };

		expect(result.objective).toContain("[REDACTED]");
		expect(result.objective).not.toContain("sk-abcdefgh12345678");
		expect(result.objective?.length).toBeLessThanOrEqual(2000);
	});

	it("maps readContext to token-safe session stats", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		const result = await host.backendCall(created.threadId, "readContext", null);

		expect(result).toEqual({
			tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 5, total: 26 },
			contextWindow: 100,
			percentUsed: 20,
			source: "AgentSession.getSessionStats",
			freshness: "live",
		});
		expect(JSON.stringify(result)).not.toContain("cost");
	});
	it("clamps percentUsed to 100 for out-of-range context percent", async () => {
		const session = new FakeSession();
		session.getContextUsage = () => ({ tokens: 20, contextWindow: 100, percent: 250 });
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		const result = (await host.backendCall(created.threadId, "readContext", null)) as { percentUsed?: number };

		expect(result.percentUsed).toBe(100);
	});

	it("maps session list/search and tree read models", async () => {
		const originalList = SessionManager.list;
		const originalListAll = SessionManager.listAll;
		try {
			const modified = new Date("2026-01-01T00:00:00.000Z");
			const long = "hello ".repeat(50);
			(SessionManager as any).list = async () => [
				{
					id: "s1",
					title: "Alpha",
					firstMessage: long,
					cwd: "/repo",
					path: "/repo/s1.jsonl",
					modified,
					messageCount: 3,
					size: 1,
					created: modified,
					allMessagesText: "",
				},
				{
					id: "s2",
					title: "Beta",
					firstMessage: "other",
					cwd: "/repo",
					path: "/repo/s2.jsonl",
					modified,
					messageCount: 1,
					size: 1,
					created: modified,
					allMessagesText: "",
				},
			];
			(SessionManager as any).listAll = async () => [
				{
					id: "s3",
					title: "Gamma",
					firstMessage: "global",
					cwd: "/else",
					path: "/else/s3.jsonl",
					modified,
					messageCount: 4,
					size: 1,
					created: modified,
					allMessagesText: "",
				},
			];
			const session = new FakeSession();
			const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
			const created = await host.createThread({});

			const listed = await host.sessionList({ limit: 1 });
			expect((listed as any).total).toBe(2);
			expect((listed as any).sessions[0]).toMatchObject({
				id: "s1",
				cwd: "/repo",
				path: "/repo/s1.jsonl",
				modifiedAt: "2026-01-01T00:00:00.000Z",
				entryCount: 3,
			});
			expect((listed as any).sessions[0].firstMessage).toHaveLength(200);
			const all = await host.sessionList({ scope: "all" });
			expect((all as any).sessions[0].id).toBe("s3");
			const searched = await host.sessionSearch({ query: "alp" });
			expect((searched as any).sessions.map((entry: any) => entry.id)).toEqual(["s1"]);

			const tree = (await host.backendCall(created.threadId, "sessionTree", null)) as any;
			expect(tree.activeLeafId).toBe("leaf");
			expect(tree.nodes[0].label).toBe("Root label");
			expect(tree.nodes[0].active).toBe(true);
			expect(tree.nodes[0].children[0].active).toBe(true);
			expect(tree.nodes[0].children[1].active).toBe(false);
			expect(tree.nodes[0].children[1].preview).toHaveLength(120);
		} finally {
			(SessionManager as any).list = originalList;
			(SessionManager as any).listAll = originalListAll;
		}
	});

	it("maps execution-state read models", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		expect(await host.backendCall(created.threadId, "readTodos", null)).toEqual({
			todos: [{ id: "t1", content: "ship", status: "pending" }],
		});
		expect(await host.backendCall(created.threadId, "readUsage", null)).toMatchObject({
			perModel: [{ modelId: "gpt", input: 11, output: 7, cost: 0.2 }],
			totalCost: 0.2,
			freshness: "live",
		});
		expect(await host.backendCall(created.threadId, "listJobs", null)).toMatchObject({
			jobs: [
				{ id: "j1", type: "bash", status: "running" },
				{ id: "t1", type: "task", status: "completed" },
			],
		});
		expect(await host.backendCall(created.threadId, "listAgents", null)).toEqual({
			agents: [
				{
					id: "0-ExecSlice",
					agentType: "executor",
					description: "bounded fix slice",
					status: "completed",
					outputRef: "artifact-ref-1",
				},
			],
		});
		expect(await host.backendCall(created.threadId, "listMonitors", null)).toMatchObject({
			monitors: [{ id: "j1", kind: "log", description: "tail server log", status: "running" }],
		});
		const compact = (await host.backendCall(created.threadId, "compactSummary", null)) as any;
		expect(compact.summaries[0].summary).toContain("[REDACTED]");
	});

	it("catalogs builtin, file, skill, and extension slash commands with classifications and extension state depth", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "gjc-app-host-catalog-"));
		try {
			await mkdir(path.join(dir, ".gjc", "skills", "ship"), { recursive: true });
			await writeFile(
				path.join(dir, ".gjc", "skills", "ship", "SKILL.md"),
				"---\ndescription: Ship safely\n---\n# Ship\n",
			);
			await mkdir(path.join(dir, ".gjc", "commands"), { recursive: true });
			await writeFile(
				path.join(dir, ".gjc", "commands", "deploy.md"),
				"---\ndescription: Deploy command\n---\nDeploy prompt\n",
			);
			const session = new FakeSession();
			const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) as any });
			const created = await host.createThread({ cwd: dir });

			const commandResult = (await host.backendCall(created.threadId, "getState", { commands: true })) as any;
			const findCommand = (name: string, source: string) =>
				commandResult.commands.find((command: any) => command.name === name && command.source === source);
			expect(findCommand("/help", "builtin")).toMatchObject({ classification: "prompt-display-only" });
			expect(findCommand("/ssh", "builtin")).toMatchObject({ classification: "excluded-terminal-only" });
			expect(findCommand("/login", "builtin")).toMatchObject({ classification: "in-scope-new" });
			expect(findCommand("/move", "builtin")).toMatchObject({ classification: "in-scope-new" });
			expect(findCommand("/deploy", "file")).toMatchObject({ classification: "in-scope-new" });
			expect(findCommand("/skill:ship", "skill")).toMatchObject({ classification: "in-scope-new" });
			expect(findCommand("/deploy", "extension")).toMatchObject({ classification: "in-scope-new" });
			expect(commandResult.commands.every((command: any) => typeof command.classification === "string")).toBe(true);

			const extensionResult = (await host.backendCall(created.threadId, "getState", { extensions: true })) as any;
			const skillExtension = extensionResult.extensions.find((extension: any) => extension.id === "skill:ship");
			expect(skillExtension).toMatchObject({
				kind: "skill",
				state: "active",
				status: "active",
				provider: "native",
			});
			expect(Object.prototype.hasOwnProperty.call(skillExtension, "disabledReason")).toBe(true);
			expect(Object.prototype.hasOwnProperty.call(skillExtension, "shadowedBy")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("emits jobs_changed when job observer reports status transitions", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session }),
			emit: (...args) => emitted.push(args),
		});
		await host.createThread({});
		session.jobSnapshot = {
			running: [
				{ id: "j2", type: "bash", status: "running", label: "build", metadata: {} },
				{ id: "m2", type: "bash", status: "running", label: "tail", metadata: { monitor: true } },
				{
					id: "a2",
					type: "task",
					status: "running",
					label: "agent",
					metadata: { subagent: { id: "1-Agent", agent: "executor", description: "agent slice" } },
				},
			],
			recent: [],
		};
		session.fireJobChange();
		session.jobSnapshot = {
			running: [],
			recent: [
				{ id: "j2", type: "bash", status: "completed", label: "build", metadata: {} },
				{ id: "m2", type: "bash", status: "failed", label: "tail", metadata: { monitor: true } },
				{
					id: "a2",
					type: "task",
					status: "cancelled",
					label: "agent",
					metadata: { subagent: { id: "1-Agent", agent: "executor", description: "agent slice" } },
				},
			],
		};
		session.fireJobChange();
		expect(emitted).toEqual([
			["thr_fake_session", 1, "jobs_changed", { kind: "job", id: "j2", status: "running", description: "build" }],
			["thr_fake_session", 1, "jobs_changed", { kind: "monitor", id: "m2", status: "running", description: "tail" }],
			["thr_fake_session", 1, "jobs_changed", { kind: "agent", id: "a2", status: "running", description: "agent slice" }],
			["thr_fake_session", 1, "jobs_changed", { kind: "job", id: "j2", status: "completed", description: "build" }],
			["thr_fake_session", 1, "jobs_changed", { kind: "monitor", id: "m2", status: "failed", description: "tail" }],
			["thr_fake_session", 1, "jobs_changed", { kind: "agent", id: "a2", status: "cancelled", description: "agent slice" }],
		]);
	});

	it("does not emit duplicate job changes for unchanged snapshots and keeps same job ids isolated by thread", async () => {
		const a = new FakeSession();
		(a as any).sessionId = "thr_a";
		const b = new FakeSession();
		(b as any).sessionId = "thr_b";
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const sessions = [a, b];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session: sessions.shift()! }),
			emit: (...args) => emitted.push(args),
		});
		await host.createThread({});
		await host.createThread({});

		a.jobSnapshot = { running: [{ id: "shared", type: "bash", status: "running", label: "A", metadata: {} }], recent: [] };
		b.jobSnapshot = { running: [{ id: "shared", type: "bash", status: "running", label: "B", metadata: {} }], recent: [] };
		a.fireJobChange();
		b.fireJobChange();
		b.fireJobChange();
		a.jobSnapshot = { running: [], recent: [{ id: "shared", type: "bash", status: "completed", label: "A", metadata: {} }] };
		a.fireJobChange();

		expect(emitted).toEqual([
			["thr_a", 1, "jobs_changed", { kind: "job", id: "shared", status: "running", description: "A" }],
			["thr_b", 1, "jobs_changed", { kind: "job", id: "shared", status: "running", description: "B" }],
			["thr_a", 1, "jobs_changed", { kind: "job", id: "shared", status: "completed", description: "A" }],
		]);
	});

	it("emits jobs_changed when cron snapshots change", async () => {
		const session = new FakeSession();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		AsyncJobManager.setInstance(manager);
		resetCronRegistryForTests();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		try {
			const host = new AgentSessionHost({ sessionFactory: async () => ({ session }), emit: (...args) => emitted.push(args) });
			await host.createThread({});
			await new CronTool(session as any).execute("cron-1", {
				op: "create",
				cron_expression: "* * * * *",
				prompt: "check logs",
				recurring: true,
			});
			expect(emitted).toContainEqual([
				"thr_fake_session",
				1,
				"jobs_changed",
				{ kind: "monitor", id: "crons", status: "changed" },
			]);
		} finally {
			resetCronRegistryForTests();
			AsyncJobManager.resetForTests();
		}
	});

	it("emits each rapid job terminal transition once", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }), emit: (...args) => emitted.push(args) });
		await host.createThread({});
		session.jobSnapshot = { running: [{ id: "j-fast", type: "bash", status: "running", label: "fast", metadata: {} }], recent: [] };
		session.fireJobChange();
		session.jobSnapshot = { running: [], recent: [{ id: "j-fast", type: "bash", status: "completed", label: "fast", metadata: {} }] };
		session.fireJobChange();
		session.jobSnapshot = { running: [], recent: [{ id: "j-fast", type: "bash", status: "failed", label: "fast", metadata: {} }] };
		session.fireJobChange();

		expect(emitted.map(event => event[3])).toEqual([
			{ kind: "job", id: "j-fast", status: "running", description: "fast" },
			{ kind: "job", id: "j-fast", status: "completed", description: "fast" },
			{ kind: "job", id: "j-fast", status: "failed", description: "fast" },
		]);
	});

	it("unsubscribes job observers on dispose", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }), emit: (...args) => emitted.push(args) });
		const created = await host.createThread({});
		expect(session.jobChangeListeners).toHaveLength(1);
		await host.backendCall(created.threadId, "dispose", {});
		expect(session.jobChangeListeners).toHaveLength(0);
		session.jobSnapshot = { running: [{ id: "late", type: "bash", status: "running", label: "late", metadata: {} }], recent: [] };
		session.fireJobChange();
		expect(emitted).toEqual([]);
	});

	it("maps monitor cron snapshots and bounded output tails from retained async job output", async () => {
		const session = new FakeSession();
		const manager = new AsyncJobManager({ onJobComplete: () => undefined });
		AsyncJobManager.setInstance(manager);
		const jobId = manager.register(
			"bash",
			"monitor with output",
			() => new Promise(() => undefined),
			{ id: "m1", ownerId: "0-Test", metadata: { monitor: true, kind: "log" } },
		);
		manager.appendOutput(jobId, `${"x".repeat(4100)}sk-12345678901234567890 Bearer secret-token api_key=secret-value`);
		session.jobSnapshot = {
			running: [
				{
					id: "m1",
					type: "bash",
					status: "running",
					label: "monitor with output",
					metadata: { monitor: true, kind: "log" },
					outputTail: "stale snapshot output must not be used",
				},
				{ id: "m2", type: "bash", status: "running", label: "monitor without output", metadata: { monitor: true } },
			],
			recent: [],
			crons: [
				{
					id: "cron1",
					humanSchedule: "every minute",
					cronExpression: "* * * * *",
					prompt: "run sk-12345678901234567890",
					recurring: true,
					nextFireAt: "2026-01-01T00:01:00.000Z",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		};
		try {
			const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
			const created = await host.createThread({});
			const model = (await host.backendCall(created.threadId, "listMonitors", null)) as any;
			expect(model.crons).toEqual([
				{
					id: "cron1",
					humanSchedule: "every minute",
					cronExpression: "* * * * *",
					prompt: "run [REDACTED]",
					recurring: true,
					nextFireAt: "2026-01-01T00:01:00.000Z",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			]);
			expect(model.monitors[0].outputTail).toHaveLength(4000);
			expect(model.monitors[0].outputTail).toContain("[REDACTED]");
			expect(model.monitors[0].outputTail).not.toContain("stale snapshot output");
			expect(model.monitors[0].outputTail).not.toContain("sk-12345678901234567890");
			expect(model.monitors[0].outputTail).not.toContain("secret-token");
			expect(model.monitors[0].outputTail).not.toContain("api_key=secret-value");
			expect(model.monitors[1].outputTail).toBeUndefined();
		} finally {
			AsyncJobManager.resetForTests();
		}
	});

	it("forwards subscribed session events through the configured emitter", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session }),
			emit: (...args) => emitted.push(args),
		});
		await host.createThread({});

		session.events[0]({ type: "agent_start" } as AgentSessionEvent);

		expect(emitted).toEqual([["thr_fake_session", 1, "agent_start", { type: "agent_start" }]]);
	});

	it("updates event generation from backend call context", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session }),
			emit: (...args) => emitted.push(args),
		});
		const created = await host.createThread({});

		await host.backendCall(created.threadId, "prompt", { text: "after resume" }, 2);
		session.events[0]({ type: "agent_start" } as AgentSessionEvent);

		expect(emitted).toEqual([["thr_fake_session", 2, "agent_start", { type: "agent_start" }]]);
	});

	it("caps pending events and clears the buffer on dispose before generation sync", async () => {
		const sessions: FakeSession[] = [];
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const debugLines: string[] = [];
		const originalDebug = console.debug;
		console.debug = (...args: unknown[]) => debugLines.push(args.map(String).join(" "));
		try {
			const host = new AgentSessionHost({
				sessionFactory: async () => {
					const session = new FakeSession();
					sessions.push(session);
					return { session };
				},
				emit: (...args) => emitted.push(args),
			});
			const first = await host.createThread({});
			const reopened = await host.createThread({});
			expect(reopened.threadId).toBe(first.threadId);

			for (let i = 0; i < 513; i += 1) {
				sessions[1]?.events[0]?.({ type: `pending_${i}` } as AgentSessionEvent);
			}
			expect(emitted).toHaveLength(0);
			await host.backendCall(reopened.threadId, "getState", {}, 2);
			expect(emitted).toHaveLength(512);
			expect(emitted[0]?.[2]).toBe("pending_1");
			expect(emitted[511]?.[2]).toBe("pending_512");
			expect(debugLines.some(line => line.includes('"droppedEvents":1'))).toBe(true);

			const disposed = await host.createThread({});
			sessions[2]?.events[0]?.({ type: "pending_before_dispose" } as AgentSessionEvent);
			expect(emitted.some(event => event[2] === "pending_before_dispose")).toBe(false);
			await host.backendCall(disposed.threadId, "dispose", {});
			expect(sessions[2]?.disposeCount).toBe(1);
			expect(emitted.some(event => event[2] === "pending_before_dispose")).toBe(false);
		} finally {
			console.debug = originalDebug;
		}
	});

	it("buffers job changes during generation-zero reattach and clears them on dispose", async () => {
		const sessions: FakeSession[] = [];
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => {
				const session = new FakeSession();
				sessions.push(session);
				return { session };
			},
			emit: (...args) => emitted.push(args),
		});
		await host.createThread({});
		const reopened = await host.createThread({});
		sessions[1]!.jobSnapshot = { running: [{ id: "during-reattach", type: "bash", status: "running", label: "tail", metadata: { monitor: true } }], recent: [] };
		sessions[1]!.fireJobChange();
		expect(emitted).toEqual([]);
		await host.backendCall(reopened.threadId, "getState", {}, 7);
		expect(emitted).toEqual([
			["thr_fake_session", 7, "jobs_changed", { kind: "monitor", id: "during-reattach", status: "running", description: "tail" }],
		]);

		const disposed = await host.createThread({});
		sessions[2]!.jobSnapshot = { running: [{ id: "discarded", type: "bash", status: "running", label: "drop", metadata: {} }], recent: [] };
		sessions[2]!.fireJobChange();
		await host.backendCall(disposed.threadId, "dispose", {});
		expect(emitted.some(event => (event[3] as any).id === "discarded")).toBe(false);
	});

	it("routes Rust backend payload shapes to session methods", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});
		const phases = [{ title: "phase 1", items: [{ text: "ship", done: false }] }];

		await host.backendCall(created.threadId, "setModel", { provider: "anthropic", modelId: "claude-opus" });
		await host.backendCall(created.threadId, "compact", { customInstructions: "keep the API contract" });
		await host.backendCall(created.threadId, "setTodos", phases);

		expect(session.models).toEqual([{ model: { provider: "anthropic", modelId: "claude-opus" }, role: undefined, options: undefined }]);
		expect(session.compactions).toEqual(["keep the API contract"]);
		expect(session.todos).toEqual([phases]);
	});

	it("assigns model roles with TUI-compatible target semantics", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		expect(await host.backendCall(created.threadId, "modelAssign", { role: "executor", provider: "openai", modelId: "gpt-4.1" })).toEqual({ ok: true, role: "executor", modelId: "gpt-4.1" });
		expect(session.models).toEqual([]);
		expect(session.settingsRoles.executor).toBeUndefined();
		expect(session.settingsValues["task.agentModelOverrides"]).toEqual({ executor: "openai/gpt-4.1" });

		expect(await host.backendCall(created.threadId, "modelAssign", { role: "architect", provider: "openai", modelId: "gpt-4.1", thinkingLevel: "high" })).toEqual({ ok: true, role: "architect", modelId: "gpt-4.1" });
		expect(session.models).toEqual([]);
		expect(session.settingsValues["task.agentModelOverrides"]).toEqual({ executor: "openai/gpt-4.1", architect: "openai/gpt-4.1:high" });

		session.activeModelProfile = "profile-a";
		session.settingsValues["modelProfile.default"] = "profile-a";
		expect(await host.backendCall(created.threadId, "modelAssign", { role: "default", provider: "anthropic", modelId: "claude-opus", thinkingLevel: "high" })).toEqual({ ok: true, role: "default", modelId: "claude-opus" });
		expect(session.models).toEqual([{ model: { provider: "anthropic", id: "claude-opus", name: "Claude Opus" }, role: "default", options: { selector: "anthropic/claude-opus", thinkingLevel: "high" } }]);
		expect(session.settingsValues.modelRoles).toEqual({ default: "anthropic/claude-opus:high" });
		expect(session.activeModelProfile).toBeUndefined();

		await expect(host.backendCall(created.threadId, "modelAssign", { role: "smol", provider: "openai", modelId: "gpt-4.1" })).rejects.toThrow("unsupported model assignment role: smol");
		await expect(host.backendCall(created.threadId, "modelAssign", { role: "default", provider: "missing", modelId: "none" })).rejects.toThrow("unknown model: missing/none");
		expect(JSON.stringify(session.settingsRoles)).not.toContain("undefined");
	});

	it("keeps compatibility fallbacks for legacy backend payload shapes", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});
		const todos = [{ text: "legacy" }];

		await host.backendCall(created.threadId, "setModel", { provider: "openai", model: "gpt-4.1" });
		await host.backendCall(created.threadId, "compact", { instructions: "legacy compact" });
		await host.backendCall(created.threadId, "setTodos", { todos });

		expect(session.models).toEqual([{ model: { provider: "openai", modelId: "gpt-4.1" }, role: undefined, options: undefined }]);
		expect(session.compactions).toEqual(["legacy compact"]);
		expect(session.todos).toEqual([todos]);
	});

	it("accepts exec command payloads as bare strings and string arrays", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		await host.backendCall(created.threadId, "exec", "echo bare");
		await host.backendCall(created.threadId, "exec", ["printf", "%s", "array"]);
		await host.backendCall(created.threadId, "exec", {
			command: "echo object",
			options: { excludeFromContext: true },
		});
		await host.backendCall(created.threadId, "exec", {
			command: ["node", "-e", "console.log(1)"],
			cwd: "/tmp/work",
			timeoutMs: 123,
		});

		expect(session.execCalls).toEqual([
			{ command: "echo bare", options: undefined },
			{ command: "printf %s array", options: undefined },
			{ command: "echo object", options: { excludeFromContext: true } },
			{ command: "node -e console.log(1)", options: { cwd: "/tmp/work", timeoutMs: 123 } },
		]);
	});

	it("does not bump event generation after abort", async () => {
		const session = new FakeSession();
		const emitted: Array<Parameters<AppServerEventEmitter>> = [];
		const host = new AgentSessionHost({
			sessionFactory: async () => ({ session }),
			emit: (...args) => emitted.push(args),
		});
		const created = await host.createThread({});

		await host.backendCall(created.threadId, "abort", {});
		session.events[0]({ type: "agent_stop" } as unknown as AgentSessionEvent);

		expect(session.abortCount).toBe(1);
		expect(emitted).toEqual([["thr_fake_session", 1, "agent_stop", { type: "agent_stop" }]]);
	});

	it("uses lazy connection auth storage for provider list, status, and logout without a session", async () => {
		const storage = new FakeAuthStorage(["anthropic"]) as any;
		let constructed = 0;
		const host = new AgentSessionHost({
			authStorageFactory: async () => {
				constructed += 1;
				return storage;
			},
		});

		const listed = (await host.providerList()) as any;
		expect(constructed).toBe(1);
		expect(listed.providers.find((provider: any) => provider.id === "anthropic")).toMatchObject({
			authKind: "oauth",
			authenticated: true,
		});

		const before = (await host.authStatus()) as any;
		expect(before.providers.find((provider: any) => provider.providerId === "anthropic")).toMatchObject({
			state: "authenticated",
			method: "oauth",
		});

		expect(await host.authLogout({ providerId: "anthropic" })).toEqual({
			providerId: "anthropic",
			authenticated: false,
		});
		const after = (await host.authStatus()) as any;
		expect(after.providers.find((provider: any) => provider.providerId === "anthropic")).toMatchObject({
			state: "unauthenticated",
		});
		expect(JSON.stringify({ listed, before, after })).not.toMatch(
			/sk-test|fake-access|fake-refresh|credential-secret/i,
		);
		expect(constructed).toBe(1);
	});

	it("reports oauth capability for unauthenticated OAuth providers", async () => {
		const host = new AgentSessionHost({ authStorageFactory: async () => new FakeAuthStorage([]) as any });

		const listed = (await host.providerList()) as any;

		expect(listed.providers.find((provider: any) => provider.id === "anthropic")).toMatchObject({
			authKind: "oauth",
			authenticated: false,
		});
	});

	it("persists settings updates through the session settings owner", async () => {
		const configRoot = await mkdtemp(path.join(tmpdir(), "gjc-config-"));
		const agentDir = path.join(configRoot, "agent");
		const configPath = path.join(agentDir, "config.yml");
		await mkdir(agentDir, { recursive: true });
		await writeFile(configPath, "autoResume: false\n");
		try {
			const session = new FakeSession() as FakeSession & { settings: unknown };
			let autoResume = false;
			session.settings = {
				get: (key: string) => (key === "autoResume" ? autoResume : undefined),
				set: (key: string, value: never) => {
					if (key !== "autoResume") throw new Error(`unexpected key ${key}`);
					autoResume = Boolean(value);
				},
				flush: async () => {
					await writeFile(configPath, `autoResume: ${autoResume}\n`);
				},
			};
			const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
			await host.createThread({});

			expect(await readFile(configPath, "utf8")).toContain("autoResume: false");
			expect(await host.settingsUpdate({ key: "autoResume", value: true })).toEqual({
				values: { autoResume: true },
			});
			expect(await readFile(configPath, "utf8")).toContain("autoResume: true");
		} finally {
			await rm(configRoot, { recursive: true, force: true });
		}
	});

	it("passes registered host tools as custom tools that delegate through the native bridge", async () => {
		const session = new FakeSession();
		let capturedOptions: any;
		const bridge = {
			hostToolNames: () => ["host_echo"],
			activeTurnId: (threadId: string) => {
				expect(threadId).toBe("thr_fake_session");
				return "turn-real";
			},
			callHostTool: async (threadId: string, turnId: string, tool: string, argsJson: string) => {
				expect(threadId).toBe("thr_fake_session");
				expect(turnId).toBe("turn-real");
				expect(tool).toBe("host_echo");
				expect(JSON.parse(argsJson)).toEqual({ value: 7 });
				return JSON.stringify({ ok: true });
			},
		};
		const host = new AgentSessionHost({
			appServer: bridge,
			sessionFactory: async options => {
				capturedOptions = options;
				return { session };
			},
		});

		await host.createThread({
			hostTools: [{ name: "host_echo", description: "Echo", inputSchema: { type: "object" } }],
		});
		const tool = capturedOptions.customTools[0];
		const result = await tool.execute("call_1", { value: 7 }, undefined as never, undefined as never);

		expect(tool.name).toBe("host_echo");
		expect(result).toEqual({
			content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
			details: { ok: true },
		});
	});
	it("opens a persisted session through the sessionManager seam and marks it resumed", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "gjc-open-"));
		const sessionPath = path.join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "open-session", timestamp: new Date().toISOString(), cwd: dir };
		const user = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "persisted hello" },
		};
		await writeFile(sessionPath, `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`);
		let openedManager: SessionManager | undefined;
		const host = new AgentSessionHost({
			sessionFactory: async options => {
				openedManager = options.sessionManager;
				const session = new FakeSession();
				(session as any).sessionId = options.sessionManager?.getSessionId() ?? session.sessionId;
				session.messages = options.sessionManager?.getEntriesForExport?.() ?? [];
				return { session };
			},
		});

		const opened = await host.sessionOpen({ sessionPath });
		const messages = await host.backendCall(opened.threadId, "getMessages", {});

		expect(opened.resumed).toBe(true);
		expect(opened.sessionMetadata?.cwd).toBe(dir);
		expect(openedManager?.getCwd()).toBe(dir);
		expect(JSON.stringify(messages)).toContain("persisted hello");
	});

	it("re-opening the same session replaces the old subscription and uses backend-assigned generation", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "gjc-open-dupe-"));
		const sessionPath = path.join(dir, "session.jsonl");
		const header = { type: "session", version: 3, id: "dupe-session", timestamp: new Date().toISOString(), cwd: dir };
		await writeFile(sessionPath, `${JSON.stringify(header)}\n`);
		const sessions: FakeSession[] = [];
		const events: unknown[] = [];
		const host = new AgentSessionHost({
			emit: ((...args: unknown[]) => events.push(args)) as AppServerEventEmitter,
			sessionFactory: async options => {
				const session = new FakeSession();
				(session as any).sessionId = options.sessionManager?.getSessionId() ?? session.sessionId;
				sessions.push(session);
				return { session };
			},
		});

		const opened1 = await host.sessionOpen({ sessionPath });
		const opened2 = await host.sessionOpen({ sessionPath });
		expect(opened2.threadId).toBe(opened1.threadId);
		expect(opened2.sessionMetadata?.generation).toBeUndefined();
		sessions[0]?.events[0]?.({ type: "stale" } as AgentSessionEvent);
		sessions[1]?.events[0]?.({ type: "fresh" } as AgentSessionEvent);
		expect(events).toHaveLength(0);
		await host.backendCall(opened2.threadId, "getState", {}, 2);
		expect(events.filter(event => (event as unknown[])[2] === "stale")).toHaveLength(0);
		expect(events.some(event => (event as unknown[])[1] === 2 && (event as unknown[])[2] === "fresh")).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});

	it("forks from a live source thread and records ancestry in metadata", async () => {
		let count = 0;
		const capturedOptions: any[] = [];
		const host = new AgentSessionHost({
			sessionFactory: async options => {
				capturedOptions.push(options);
				const session = new FakeSession();
				(session as any).sessionId = `thr_${++count}`;
				return { session };
			},
		});
		const source = await host.createThread({ cwd: "/tmp/source" });
		const fork = await host.forkThread({ threadId: source.threadId, entryId: "root" });

		expect(fork.threadId).toBe("thr_2");
		expect(fork.sessionMetadata?.forkedFromId).toBe(source.threadId);
		expect(fork.sessionMetadata?.cwd).toBe("/tmp/source");
		expect(capturedOptions[1]?.forkContextSeed?.messages?.[0]?.content).toBe("source context");
	});

	it("rejects fork source references that cannot be seeded", async () => {
		const source = new FakeSession();
		(source as any).buildForkContextSeed = undefined;
		(source as any).branch = undefined;
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session: source }) });
		const created = await host.createThread({});
		await expect(host.forkThread({ threadId: "missing" })).rejects.toThrow("unknown fork source thread: missing");
		await expect(host.forkThread({ threadId: created.threadId })).rejects.toThrow("fork context seeding unsupported");
	});

	it("deletes a session file and artifacts directory and reports missing files", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "gjc-delete-cwd-"));
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "delete me", timestamp: Date.now() });
		await manager.flush();
		const sessionPath = manager.getSessionFile();
		if (!sessionPath) throw new Error("missing session file");
		await writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", version: 3, id: manager.getSessionId(), timestamp: new Date().toISOString(), cwd })}\n`,
		);
		const artifactsDir = path.join(path.dirname(sessionPath), path.basename(sessionPath, ".jsonl"));
		await mkdir(artifactsDir, { recursive: true });
		await writeFile(path.join(artifactsDir, "artifact.txt"), "artifact");
		await manager.close();
		const host = new AgentSessionHost();

		expect(await host.sessionDelete({ sessionPath })).toEqual({ ok: true });
		await expect(readFile(sessionPath, "utf8")).rejects.toThrow();
		await expect(readFile(path.join(artifactsDir, "artifact.txt"), "utf8")).rejects.toThrow();
		await expect(host.sessionDelete({ sessionPath })).rejects.toThrow("session file not found");
		await rm(cwd, { recursive: true, force: true });
	});

	it("plans and returns session moves using the real target cwd mapping", async () => {
		const sourceCwd = await mkdtemp(path.join(tmpdir(), "gjc-move-source-"));
		const targetCwd = await mkdtemp(path.join(tmpdir(), "gjc-move-target-"));
		const manager = SessionManager.create(sourceCwd);
		try {
			manager.appendMessage({ role: "user", content: "move me", timestamp: Date.now() });
			await manager.flush();
			const sourceSessionFile = manager.getSessionFile();
			if (!sourceSessionFile) throw new Error("missing session file");
			const session = Object.assign(new FakeSession(), {
				sessionId: manager.getSessionId(),
				sessionManager: manager,
			});
			const host = new AgentSessionHost({ sessionFactory: async () => ({ session: session as any }) });
			const created = await host.createThread({ cwd: sourceCwd });
			const expectedTarget = path.join(
				SessionManager.getDefaultSessionDir(targetCwd),
				path.basename(sourceSessionFile),
			);

			const dryRun = (await host.backendCall(created.threadId, "sessionMove", { targetCwd, dryRun: true })) as any;
			expect(dryRun.targetSessionFile).toBe(expectedTarget);

			const moved = (await host.backendCall(created.threadId, "sessionMove", { targetCwd })) as any;
			expect(moved).toEqual({ dryRun: false, movedTo: targetCwd, sessionPath: expectedTarget });
			expect(manager.getCwd()).toBe(targetCwd);
		} finally {
			await manager.close();
			await rm(sourceCwd, { recursive: true, force: true });
			await rm(targetCwd, { recursive: true, force: true });
		}
	});

	it("navigates and labels session tree entries through backend calls", async () => {
		const session = new FakeSession();
		const host = new AgentSessionHost({ sessionFactory: async () => ({ session }) });
		const created = await host.createThread({});

		expect(await host.backendCall(created.threadId, "sessionNavigate", { entryId: "side", summarize: true })).toEqual(
			{ ok: true, activeLeafId: "side" },
		);
		expect(await host.backendCall(created.threadId, "sessionLabel", { entryId: "side", label: "Important" })).toEqual(
			{ ok: true },
		);
		expect(session.sessionManager.labels).toEqual([{ entryId: "side", label: "Important" }]);
		await expect(
			host.backendCall(created.threadId, "sessionLabel", { entryId: "side", label: "x".repeat(201) }),
		).rejects.toThrow("label");
	});
	it("lists and fuzzy-searches sessions scoped by cwd, path, and deep message text", async () => {
		const cwdA = await mkdtemp(path.join(tmpdir(), "gjc-search-a-"));
		const cwdB = await mkdtemp(path.join(tmpdir(), "gjc-search-b-"));
		const managerA = SessionManager.create(cwdA);
		const managerB = SessionManager.create(cwdB);
		try {
			managerA.appendMessage({ role: "user", content: "first visible", timestamp: Date.now() });
			managerA.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "deep zanzibar needle content" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				timestamp: Date.now(),
			} as any);
			managerB.appendMessage({ role: "user", content: "other cwd message", timestamp: Date.now() });
			managerB.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "other reply" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
				timestamp: Date.now(),
			} as any);
			await managerA.flush();
			await managerB.flush();

			const host = new AgentSessionHost();
			const listedA = (await host.sessionList({ cwd: cwdA })) as {
				total: number;
				sessions: Array<{ cwd: string; path: string }>;
			};
			const listedB = (await host.sessionList({ cwd: cwdB })) as { total: number; sessions: Array<{ cwd: string }> };
			const deep = (await host.sessionSearch({ cwd: cwdA, query: "znb ndle" })) as {
				total: number;
				sessions: Array<{ path: string }>;
			};
			const byPath = (await host.sessionSearch({
				cwd: cwdA,
				query: path.basename(managerA.getSessionFile() ?? ""),
			})) as { total: number };

			expect(listedA.total).toBe(1);
			expect(listedA.sessions[0]?.cwd).toBe(cwdA);
			expect(listedB.total).toBe(1);
			expect(listedB.sessions[0]?.cwd).toBe(cwdB);
			expect(deep.total).toBe(1);
			expect(deep.sessions[0]?.path).toBe(managerA.getSessionFile());
			expect(byPath.total).toBe(1);
		} finally {
			await managerA.close();
			await managerB.close();
			await rm(cwdA, { recursive: true, force: true });
			await rm(cwdB, { recursive: true, force: true });
		}
	});

	it("redacts OAuth login secrets across start, poll, complete, cancel, and audit lines", async () => {
		const leaks = ["tok_g004_secret", "verifier_g004_secret", "code_g004_secret", "fingerprint_g004_secret"];
		const auditLines: string[] = [];
		const info = spyOn(console, "info").mockImplementation((line?: unknown) => {
			auditLines.push(String(line));
		});
		try {
			const storage = {
				login: async (_providerId: string, callbacks: any) => {
					callbacks.onAuth({ authUrl: "https://login.example/authorize?fingerprint=fingerprint_g004_secret", instructions: "Open browser fingerprint=fingerprint_g004_secret token=tok_g004_secret" });
					const redirect = await callbacks.onManualCodeInput();
					expect(String(redirect)).toContain("code_g004_secret");
				},
			};
			const host = new AgentSessionHost({ authStorageFactory: async () => storage as any });
			const start = (await host.authLoginStart({ providerId: "anthropic" })) as any;
			const poll = (await host.authLoginPoll({ flowId: start.flowId })) as any;
			const complete = (await host.authLoginComplete({ flowId: start.flowId, redirectUrl: "http://localhost/callback?code=code_g004_secret&state=verifier_g004_secret" })) as any;
			await new Promise(resolve => setTimeout(resolve, 0));
			const finalPoll = (await host.authLoginPoll({ flowId: start.flowId })) as any;
			const serialized = JSON.stringify({ start, poll, complete, finalPoll, auditLines });
			for (const leak of leaks) expect(serialized).not.toContain(leak);
			expect(finalPoll.state).toBe("authenticated");

			const secretStorage = {
				login: async (_providerId: string, callbacks: any) => {
					await callbacks.onPrompt("Enter token tok_g004_secret", { secret: true });
				},
			};
			const secretHost = new AgentSessionHost({ authStorageFactory: async () => secretStorage as any });
			const secretStart = (await secretHost.authLoginStart({ providerId: "anthropic" })) as any;
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(await secretHost.authLoginPoll({ flowId: secretStart.flowId })).toEqual({ state: "unsupported" });

			const cancelStorage = {
				login: async (_providerId: string, callbacks: any) => {
					callbacks.onAuth({ authUrl: "https://login.example/authorize" });
					await new Promise((_resolve, reject) => callbacks.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
				},
			};
			const cancelHost = new AgentSessionHost({ authStorageFactory: async () => cancelStorage as any });
			const cancelStart = (await cancelHost.authLoginStart({ providerId: "anthropic" })) as any;
			expect(await cancelHost.authLoginCancel({ flowId: cancelStart.flowId })).toEqual({ state: "cancelled" });
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(await cancelHost.authLoginPoll({ flowId: cancelStart.flowId })).toEqual({ state: "cancelled" });
		} finally {
			info.mockRestore();
		}
	});

	it("waits for delayed OAuth auth URL before resolving start", async () => {
		const storage = {
			login: async (_providerId: string, callbacks: any) => {
				await new Promise(resolve => setTimeout(resolve, 10));
				callbacks.onAuth({ authUrl: "https://login.example/authorize?fingerprint=delayed_fingerprint_secret" });
			},
		};
		const host = new AgentSessionHost({ authStorageFactory: async () => storage as any });

		const start = (await host.authLoginStart({ providerId: "anthropic" })) as any;

		expect(start.state).toBe("pending-browser");
		expect(start.authUrl).toBe("https://login.example/authorize?fingerprint=[REDACTED]");
		expect(JSON.stringify(start)).not.toContain("delayed_fingerprint_secret");
	});

	it("rejects raw provider apiKey before storing or dereferencing it", async () => {
		const host = new AgentSessionHost();
		await expect(host.providerAdd({ preset: "openai", apiKey: "sk-g004-raw" })).rejects.toThrow("raw API keys");
	});

	it("rejects unknown extension and skill ids instead of mutating disabledExtensions", async () => {
		const host = new AgentSessionHost();
		await expect(host.extensionsSetEnabled({ extensionId: "missing.g004", enabled: false })).rejects.toThrow();
		await expect(host.skillsSetEnabled({ skillId: "missing-g004", enabled: false })).rejects.toThrow();
	});
});
