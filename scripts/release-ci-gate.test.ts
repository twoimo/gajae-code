import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateReleaseGate, type ReleaseEvidence, type ReleasePolicy } from "./release-ci-gate";
import { collectReleaseEvidence } from "./collect-release-check-evidence";

const sha = "a".repeat(40);
const policy: ReleasePolicy = {
	version: 2, trustedWorkflows: [{ id: "CI", path: ".github/workflows/ci.yml", events: ["push"], refs: ["refs/heads/main"] }],
	requiredJobs: ["check", "test"], requiredConclusions: ["success"], rerunPolicy: "latest-attempt-only",
	supersessionPolicy: "latest-run-per-workflow", nameCollisionPolicy: "reject",
	trustedSource: { repositoryOwnerMatches: true, headRepositoryMatches: true },
};
function evidence(overrides: Partial<ReleaseEvidence["runs"][number]> = {}): ReleaseEvidence {
	return { headSha: sha, collectedAt: "2026-07-10T00:00:00Z", valid: true, runs: [{
		id: 1, workflowDatabaseId: 1, attempt: 1, runAttempt: 1, status: "completed", conclusion: "success",
		headSha: sha, workflowId: "CI", workflowPath: ".github/workflows/ci.yml", event: "push", headRef: "refs/heads/main",
		repositoryOwnerMatches: true, headRepositoryMatches: true, createdAt: "2026-07-10T00:00:00Z",
		jobs: [{ name: "check", status: "completed", conclusion: "success" }, { name: "test", status: "completed", conclusion: "success" }], ...overrides,
	}] };
}

describe("exact-SHA release CI gate", () => {
	test("accepts latest trusted successful exact-SHA evidence", () => expect(evaluateReleaseGate(policy, evidence(), sha)).toEqual([]));
	test("rejects skipped required jobs", () => expect(evaluateReleaseGate(policy, evidence({ jobs: [{ name: "check", status: "completed", conclusion: "skipped" }, { name: "test", status: "completed", conclusion: "success" }] }), sha).join(" ")).toContain("skipped"));
	test("rejects failed required jobs", () => expect(evaluateReleaseGate(policy, evidence({ jobs: [{ name: "check", status: "completed", conclusion: "failure" }, { name: "test", status: "completed", conclusion: "success" }] }), sha).join(" ")).toContain("failure"));
	test("rejects stale evidence SHA", () => expect(evaluateReleaseGate(policy, evidence(), "b".repeat(40))[0]).toContain("does not match"));
	test("rejects a stale rerun attempt", () => { const value = evidence(); value.runs.push({ ...value.runs[0], attempt: 2, runAttempt: 2, createdAt: "2026-07-09T00:00:00Z" }); expect(evaluateReleaseGate(policy, value, sha).join(" ")).toContain("latest attempt"); });
	test("rejects job name collisions", () => { const value = evidence(); value.runs[0].jobs.push({ name: "check", status: "completed", conclusion: "success" }); expect(evaluateReleaseGate(policy, value, sha).join(" ")).toContain("collision"); });
	test("rejects an untrusted source", () => expect(evaluateReleaseGate(policy, evidence({ headRepositoryMatches: false }), sha).join(" ")).toContain("untrusted"));
	test("rejects invalid and legacy evidence without freshness fields", () => {
		const invalid = evidence(); invalid.valid = false; invalid.invalidReason = "run changed during collection";
		expect(evaluateReleaseGate(policy, invalid, sha).join(" ")).toContain("freshness is invalid");
		const legacy = evidence(); delete (legacy.runs[0] as Partial<ReleaseEvidence["runs"][number]>).runAttempt;
		expect(evaluateReleaseGate(policy, legacy, sha).join(" ")).toContain("missing freshness fields");
	});
	test("rejects a same-name workflow run from an untrusted path", () => {
		const value = evidence(); value.runs.push({ ...value.runs[0], id: 2, workflowDatabaseId: 2, workflowPath: ".github/workflows/spoof.yml" });
		expect(evaluateReleaseGate(policy, value, sha).join(" ")).toContain("conflicts with trusted workflow CI");
	});
});

describe("API-shaped matrix job policy", () => {
	const apiPolicy: ReleasePolicy = {
		...policy,
		requiredJobs: ["check", { group: "native_linux", selector: { exact: "native_linux", prefix: "native_linux (" }, minCount: 1, allSuccess: true }, "test", "windows_smoke", "install_methods"],
	};
	const jobs = [
		{ name: "check", status: "completed", conclusion: "success" },
		{ name: "native_linux (baseline, true)", status: "completed", conclusion: "success" },
		{ name: "native_linux (modern)", status: "completed", conclusion: "success" },
		{ name: "test", status: "completed", conclusion: "success" },
		{ name: "windows_smoke", status: "completed", conclusion: "success" },
		{ name: "install_methods", status: "completed", conclusion: "success" },
	];
	test("accepts realistic successful matrix children without an aggregate parent", () => expect(evaluateReleaseGate(apiPolicy, evidence({ jobs }), sha)).toEqual([]));
	test("fails when any selected matrix child fails", () => {
		const failed = jobs.map(job => job.name === "native_linux (modern)" ? { ...job, conclusion: "failure" } : job);
		expect(evaluateReleaseGate(apiPolicy, evidence({ jobs: failed }), sha).join(" ")).toContain("native_linux (modern) concluded failure");
	});
	test("rejects malformed matrix child names with trailing suffixes", () => {
		const malformed = jobs.map(job =>
			job.name === "native_linux (modern)" ? { ...job, name: "native_linux (baseline, true) extra" } : job,
		);
		expect(evaluateReleaseGate(apiPolicy, evidence({ jobs: malformed }), sha)).toEqual([]);
		const onlyMalformed = jobs.filter(job => !job.name.startsWith("native_linux")).concat([
			{ name: "native_linux (baseline, true) extra", status: "completed", conclusion: "success" },
		]);
		expect(evaluateReleaseGate(apiPolicy, evidence({ jobs: onlyMalformed }), sha).join(" ")).toContain(
			"Missing required job native_linux",
		);
	});
});

describe("canonical policy integrity", () => {
	test("rejects arbitrary --policy unless explicitly marked fixture-only", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-gate-"));
		try {
			const evidencePath = path.join(root, "evidence.json");
			const policyPath = path.join(root, "policy.json");
			await Bun.write(evidencePath, JSON.stringify(evidence()));
			await Bun.write(policyPath, JSON.stringify(policy));
			const proc = Bun.spawn(["bun", path.join(import.meta.dir, "release-ci-gate.ts"), "--sha", sha, "--evidence", evidencePath, "--policy", policyPath], { stdout: "pipe", stderr: "pipe" });
			const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			expect(code).not.toBe(0);
			expect(stderr).toContain("restricted to fixtures");
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
	test("fixture-only mode never emits the production success marker or exit 0", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-gate-fixture-"));
		try {
			const evidencePath = path.join(root, "evidence.json");
			const policyPath = path.join(root, "policy.json");
			await Bun.write(evidencePath, JSON.stringify(evidence()));
			const tampered = { ...policy, requiredJobs: ["check"] };
			await Bun.write(policyPath, JSON.stringify(tampered));
			const proc = Bun.spawn(
				["bun", path.join(import.meta.dir, "release-ci-gate.ts"), "--sha", sha, "--evidence", evidencePath, "--unsafe-fixture-policy", "--policy", policyPath],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [code, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(code).toBe(2);
			expect(stdout).not.toContain("Trusted release checks passed");
			expect(stderr).toContain("FIXTURE-ONLY");
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
});

describe("evidence collection freshness", () => {
	const rawRun = {
		id: 42, run_attempt: 3, status: "completed", conclusion: "success", head_sha: sha, name: "CI",
		path: "/repos/Yeachan-Heo/gajae-code/contents/.github/workflows/ci.yml", event: "push", head_branch: "main",
		repository: { owner: { login: "Yeachan-Heo" } }, head_repository: { full_name: "Yeachan-Heo/gajae-code" }, created_at: "2026-07-10T00:00:00Z",
	};
	const jobs = { jobs: [{ name: "check", status: "completed", conclusion: "success" }, { name: "test", status: "completed", conclusion: "success" }] };
	test("records API run freshness fields after a stable post-job refetch", async () => {
		const responses: unknown[] = [{ workflow_runs: [rawRun] }, jobs, rawRun];
		const result = await collectReleaseEvidence(sha, "Yeachan-Heo/gajae-code", async () => responses.shift());
		expect(result.valid).toBe(true);
		expect(result.runs[0]).toMatchObject({ workflowDatabaseId: 42, runAttempt: 3, status: "completed", conclusion: "success" });
	});
	test("marks evidence invalid when a run changes during collection", async () => {
		const responses: unknown[] = [{ workflow_runs: [rawRun] }, jobs, { ...rawRun, run_attempt: 4, status: "in_progress", conclusion: null }];
		const result = await collectReleaseEvidence(sha, "Yeachan-Heo/gajae-code", async () => responses.shift());
		expect(result.valid).toBe(false);
		expect(result.invalidReason).toContain("changed during collection");
	});
	test("accepts trusted CI evidence alongside the current Release Tag dispatch run", async () => {
		const releaseRun = {
			...rawRun, id: 43, name: "Release Tag", event: "workflow_dispatch",
			path: "/repos/Yeachan-Heo/gajae-code/contents/.github/workflows/release-tag.yml",
		};
		const responses: unknown[] = [
			{ workflow_runs: [rawRun, releaseRun] }, jobs, rawRun,
			{ jobs: [{ name: "gated_release_tag", status: "in_progress", conclusion: null }] }, releaseRun,
		];
		const result = await collectReleaseEvidence(sha, "Yeachan-Heo/gajae-code", async () => responses.shift());
		expect(evaluateReleaseGate(policy, result, sha)).toEqual([]);
	});
	test("collector-shaped spoofed CI-identity dispatch still hard-conflicts", async () => {
		const spoofedRun = {
			...rawRun, id: 44, event: "workflow_dispatch",
			path: "/repos/Yeachan-Heo/gajae-code/contents/.github/workflows/release-tag.yml",
		};
		const responses: unknown[] = [
			{ workflow_runs: [rawRun, spoofedRun] }, jobs, rawRun,
			{ jobs: [{ name: "gated_release_tag", status: "completed", conclusion: "success" }] }, spoofedRun,
		];
		const result = await collectReleaseEvidence(sha, "Yeachan-Heo/gajae-code", async () => responses.shift());
		expect(evaluateReleaseGate(policy, result, sha).join(" ")).toContain("conflicts with trusted workflow CI");
	});
});
