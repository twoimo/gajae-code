#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EvidenceRun, ReleaseEvidence } from "./release-ci-gate";

async function ghJson(args: string[]): Promise<unknown> {
	const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
	return JSON.parse(stdout);
}

export async function collectReleaseEvidence(
	headSha: string,
	repository: string,
	fetchJson: (args: string[]) => Promise<unknown> = ghJson,
): Promise<ReleaseEvidence> {
	const response = await fetchJson(["api", `repos/${repository}/actions/runs?head_sha=${headSha}&per_page=100`]) as { workflow_runs: Array<Record<string, unknown>> };
	const [owner] = repository.split("/");
	const runs: EvidenceRun[] = [];
	let invalidReason: string | undefined;
	for (const raw of response.workflow_runs) {
		if (raw.head_sha !== headSha) continue;
		const workflowDatabaseId = Number(raw.id);
		const runAttempt = Number(raw.run_attempt);
		const status = String(raw.status);
		const conclusion = raw.conclusion == null ? null : String(raw.conclusion);
		const jobsResponse = await fetchJson(["api", `repos/${repository}/actions/runs/${workflowDatabaseId}/attempts/${runAttempt}/jobs?per_page=100`]) as { jobs: Array<Record<string, unknown>> };
		const refreshed = await fetchJson(["api", `repos/${repository}/actions/runs/${workflowDatabaseId}`]) as Record<string, unknown>;
		const refreshedAttempt = Number(refreshed.run_attempt);
		const refreshedStatus = String(refreshed.status);
		const refreshedConclusion = refreshed.conclusion == null ? null : String(refreshed.conclusion);
		if (refreshedAttempt !== runAttempt || refreshedStatus !== status || refreshedConclusion !== conclusion) {
			invalidReason = `Run ${workflowDatabaseId} changed during collection (${runAttempt}/${status}/${conclusion ?? "null"} -> ${refreshedAttempt}/${refreshedStatus}/${refreshedConclusion ?? "null"})`;
		}
		const headRepo = (raw.head_repository as { full_name?: string } | null)?.full_name;
		runs.push({
			id: workflowDatabaseId, workflowDatabaseId, attempt: runAttempt, runAttempt, status, conclusion,
			headSha: String(raw.head_sha), workflowId: String(raw.name), workflowPath: String(raw.path).replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""),
			event: String(raw.event), headRef: `refs/heads/${String(raw.head_branch)}`,
			repositoryOwnerMatches: (raw.repository as { owner?: { login?: string } } | null)?.owner?.login === owner,
			headRepositoryMatches: headRepo === repository, createdAt: String(raw.created_at),
			jobs: jobsResponse.jobs.map(job => ({ name: String(job.name), status: String(job.status), conclusion: job.conclusion == null ? null : String(job.conclusion) })),
		});
	}
	return { headSha, collectedAt: new Date().toISOString(), valid: invalidReason === undefined, invalidReason, runs };
}

if (import.meta.main) {
	const shaIndex = process.argv.indexOf("--sha");
	const repoIndex = process.argv.indexOf("--repo");
	const sha = shaIndex >= 0 ? process.argv[shaIndex + 1] : "";
	const repository = repoIndex >= 0 ? process.argv[repoIndex + 1] : Bun.env.GITHUB_REPOSITORY ?? "Yeachan-Heo/gajae-code";
	if (!sha) throw new Error("Usage: collect-release-check-evidence.ts --sha <sha> [--repo owner/name]");
	const evidence = await collectReleaseEvidence(sha, repository);
	const output = path.join("artifacts", `release-check-evidence-${sha}.json`);
	await fs.mkdir(path.dirname(output), { recursive: true });
	await Bun.write(output, `${JSON.stringify(evidence, null, "\t")}\n`);
	if (!evidence.valid) {
		console.error(`${output}: ${evidence.invalidReason}`);
		process.exit(1);
	}
	console.log(output);
}
