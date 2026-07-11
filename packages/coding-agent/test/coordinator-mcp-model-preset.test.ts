import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { type ModelProfileDefinition, mergeModelProfiles } from "../src/config/model-profiles";
import {
	type CoordinatorModelProfileLoader,
	loadCoordinatorModelProfiles,
	resolveCoordinatorMpreset,
} from "../src/coordinator-mcp/model-preset";
import { buildCoordinatorSessionCommand, createCoordinatorMcpServer } from "../src/coordinator-mcp/server";

const builtinLoader: CoordinatorModelProfileLoader = () => mergeModelProfiles();

function loaderWithCustom(...names: string[]): CoordinatorModelProfileLoader {
	return () => {
		const profiles = mergeModelProfiles();
		for (const name of names) {
			profiles.set(name, {
				name,
				requiredProviders: [],
				modelMapping: { default: "custom/model" },
				source: "user",
			} satisfies ModelProfileDefinition);
		}
		return profiles;
	};
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-coord-mpreset-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

interface CapturedStart {
	inputs: Array<{ cwd: string; mpreset?: string | null }>;
}

function capturingServer(
	root: string,
	stateRoot: string,
	options: { resolveModelProfiles?: CoordinatorModelProfileLoader } = {},
): { server: ReturnType<typeof createCoordinatorMcpServer>; captured: CapturedStart } {
	const captured: CapturedStart = { inputs: [] };
	let counter = 0;
	const server = createCoordinatorMcpServer({
		env: {
			GJC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
			GJC_COORDINATOR_MCP_MUTATIONS: "sessions",
			GJC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
			GJC_COORDINATOR_MCP_PROFILE: "mpreset-suite",
			GJC_COORDINATOR_MCP_REPO: "repo-a",
		},
		services: {
			resolveModelProfiles: options.resolveModelProfiles ?? builtinLoader,
			startSession: input => {
				captured.inputs.push({ cwd: input.cwd, mpreset: input.mpreset });
				return { name: `mpreset-session-${++counter}`, cwd: input.cwd, createdAt: "now" };
			},
		},
	});
	return { server, captured };
}

describe("resolveCoordinatorMpreset", () => {
	it("treats absent, null, and blank values as a no-op selection", async () => {
		for (const raw of [undefined, null, "", "   "]) {
			await expect(resolveCoordinatorMpreset(raw, builtinLoader)).resolves.toEqual({ ok: true, mpreset: null });
		}
	});

	it("accepts and trims a known built-in profile", async () => {
		await expect(resolveCoordinatorMpreset("codex-eco", builtinLoader)).resolves.toEqual({
			ok: true,
			mpreset: "codex-eco",
		});
		await expect(resolveCoordinatorMpreset("  codex-medium  ", builtinLoader)).resolves.toEqual({
			ok: true,
			mpreset: "codex-medium",
		});
	});

	it("accepts a merged custom profile so custom presets remain selectable", async () => {
		await expect(resolveCoordinatorMpreset("myteam", loaderWithCustom("myteam"))).resolves.toEqual({
			ok: true,
			mpreset: "myteam",
		});
	});

	it("rejects unknown names with the sorted available-profile listing", async () => {
		const resolution = await resolveCoordinatorMpreset("totally-unknown", builtinLoader);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("expected rejection");
		expect(resolution.reason).toBe("unknown_model_profile");
		expect(resolution.mpreset).toBe("totally-unknown");
		expect(resolution.available_profiles).toContain("codex-eco");
		expect(resolution.available_profiles).toEqual(
			[...resolution.available_profiles].sort((a, b) => a.localeCompare(b)),
		);
	});

	it("rejects non-string arguments without trusting them as a profile", async () => {
		const resolution = await resolveCoordinatorMpreset(42, builtinLoader);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("expected rejection");
		expect(resolution.reason).toBe("unknown_model_profile");
	});

	it("bounds the echoed unknown name to avoid unbounded reflection", async () => {
		const resolution = await resolveCoordinatorMpreset("x".repeat(500), builtinLoader);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("expected rejection");
		expect(resolution.mpreset.length).toBeLessThanOrEqual(128);
	});
});

describe("buildCoordinatorSessionCommand", () => {
	it("returns the base command unchanged when no profile is selected", () => {
		expect(buildCoordinatorSessionCommand("gjc --worktree", null)).toBe("gjc --worktree");
		expect(buildCoordinatorSessionCommand("gjc --worktree", undefined)).toBe("gjc --worktree");
		expect(buildCoordinatorSessionCommand("gjc --worktree", "")).toBe("gjc --worktree");
	});

	it("appends an authoritative --mpreset flag for a selected profile", () => {
		expect(buildCoordinatorSessionCommand("gjc --worktree", "codex-eco")).toBe(
			"gjc --worktree --mpreset 'codex-eco'",
		);
	});

	it("shell-quotes the profile name as defense against injection", () => {
		expect(buildCoordinatorSessionCommand("gjc", "a'b; rm -rf /")).toBe("gjc --mpreset 'a'\\''b; rm -rf /'");
	});
});

describe("loadCoordinatorModelProfiles", () => {
	const originalAgentDir = getAgentDir();

	afterEach(() => {
		setAgentDir(originalAgentDir);
	});

	it("exposes built-in profiles when no models config exists on disk", async () => {
		await withTempRoot(async root => {
			setAgentDir(root);
			const profiles = await loadCoordinatorModelProfiles();
			expect(profiles.has("codex-eco")).toBe(true);
			expect(profiles.has("codex-medium")).toBe(true);
		});
	});

	it("merges a custom profile defined in the shared models config", async () => {
		await withTempRoot(async root => {
			setAgentDir(root);
			await fs.writeFile(
				path.join(root, "models.yml"),
				[
					"profiles:",
					"  coordinator-custom:",
					"    required_providers:",
					"      - openai-codex",
					"    model_mapping:",
					"      default: openai-codex/gpt-5.6-terra:high",
					"",
				].join("\n"),
				"utf8",
			);
			const profiles = await loadCoordinatorModelProfiles();
			expect(profiles.has("coordinator-custom")).toBe(true);
			expect(profiles.has("codex-eco")).toBe(true);
		});
	});
});

describe("coordinator mpreset selection contract", () => {
	it("threads a fresh-session profile into startup and exposes it in status", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server, captured } = capturingServer(root, stateRoot);
			const started = await server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				mpreset: "codex-eco",
				allow_mutation: true,
			});
			expect(started).toMatchObject({ ok: true, session: { mpreset: "codex-eco" } });
			expect(captured.inputs).toEqual([{ cwd: root, mpreset: "codex-eco" }]);

			const sessionId = (started.session as { session_id: string }).session_id;
			const status = await server.callTool("gjc_coordinator_read_status", { session_id: sessionId });
			expect(status).toMatchObject({ ok: true, session: { mpreset: "codex-eco" } });
		});
	});

	it("rejects an unknown profile before starting and lists available profiles", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server, captured } = capturingServer(root, stateRoot);
			const rejected = await server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				mpreset: "no-such-profile",
				allow_mutation: true,
			});
			expect(rejected.ok).toBe(false);
			expect(rejected.reason).toBe("unknown_model_profile");
			expect(rejected.mpreset).toBe("no-such-profile");
			expect(rejected.available_profiles as string[]).toContain("codex-eco");
			expect(captured.inputs).toEqual([]);
		});
	});

	it("preserves current behavior when mpreset is omitted", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server, captured } = capturingServer(root, stateRoot);
			const started = await server.callTool("gjc_coordinator_start_session", { cwd: root, allow_mutation: true });
			expect(started.ok).toBe(true);
			expect(started.session as Record<string, unknown>).not.toHaveProperty("mpreset");
			expect(captured.inputs).toEqual([{ cwd: root, mpreset: null }]);
		});
	});

	it("accepts a custom profile resolved through the merged registry", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server, captured } = capturingServer(root, stateRoot, {
				resolveModelProfiles: loaderWithCustom("coordinator-custom"),
			});
			const started = await server.callTool("gjc_coordinator_start_session", {
				cwd: root,
				mpreset: "coordinator-custom",
				allow_mutation: true,
			});
			expect(started).toMatchObject({ ok: true, session: { mpreset: "coordinator-custom" } });
			expect(captured.inputs).toEqual([{ cwd: root, mpreset: "coordinator-custom" }]);
		});
	});

	it("threads a fresh delegate-session profile through startup", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server, captured } = capturingServer(root, stateRoot);
			const delegated = await server.callTool("gjc_delegate_plan", {
				cwd: root,
				task: "Draft the plan under codex-eco.",
				mpreset: "codex-eco",
				allow_mutation: true,
			});
			expect(delegated).toMatchObject({ ok: true, workflow: "plan", session: { mpreset: "codex-eco" } });
			expect(captured.inputs).toEqual([{ cwd: root, mpreset: "codex-eco" }]);
		});
	});

	it("rejects a conflicting profile when reusing a session started under a different profile", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server } = capturingServer(root, stateRoot);
			const first = await server.callTool("gjc_delegate_plan", {
				cwd: root,
				task: "First task under codex-eco.",
				mpreset: "codex-eco",
				allow_mutation: true,
			});
			const sessionId = (first.session as { session_id: string }).session_id;
			const conflict = await server.callTool("gjc_delegate_plan", {
				cwd: root,
				task: "Second task wants a different profile.",
				session_id: sessionId,
				mpreset: "codex-medium",
				force: true,
				allow_mutation: true,
			});
			expect(conflict).toMatchObject({
				ok: false,
				reason: "mpreset_conflict",
				session_id: sessionId,
				session_mpreset: "codex-eco",
				requested_mpreset: "codex-medium",
			});
		});
	});

	it("rejects a profile request when reusing a session that started without one", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server } = capturingServer(root, stateRoot);
			const first = await server.callTool("gjc_delegate_plan", {
				cwd: root,
				task: "First task without a profile.",
				allow_mutation: true,
			});
			const sessionId = (first.session as { session_id: string }).session_id;
			const conflict = await server.callTool("gjc_delegate_plan", {
				cwd: root,
				task: "Now a profile is requested.",
				session_id: sessionId,
				mpreset: "codex-eco",
				force: true,
				allow_mutation: true,
			});
			expect(conflict).toMatchObject({
				ok: false,
				reason: "mpreset_conflict",
				session_mpreset: null,
				requested_mpreset: "codex-eco",
			});
		});
	});

	it("allows reusing a session with the same profile it already runs", async () => {
		await withTempRoot(async root => {
			const stateRoot = path.join(root, ".state");
			const { server } = capturingServer(root, stateRoot);
			const first = await server.callTool("gjc_delegate_plan", {
				cwd: root,
				task: "First task under codex-eco.",
				mpreset: "codex-eco",
				allow_mutation: true,
			});
			const sessionId = (first.session as { session_id: string }).session_id;
			const reused = await server.callTool("gjc_delegate_plan", {
				cwd: root,
				task: "Same profile, reuse the session.",
				session_id: sessionId,
				mpreset: "codex-eco",
				force: true,
				allow_mutation: true,
			});
			expect(reused.ok).toBe(true);
			expect(reused.reason).toBeUndefined();
		});
	});
});
