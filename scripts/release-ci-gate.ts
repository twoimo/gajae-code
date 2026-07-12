#!/usr/bin/env bun

export interface RequiredJobGroup {
	group: string;
	selector: { exact?: string; prefix?: string };
	minCount: number;
	allSuccess: boolean;
}
export interface ReleasePolicy {
	version: number;
	trustedWorkflows: Array<{ id: string; path: string; events: string[]; refs: string[] }>;
	requiredJobs: Array<string | RequiredJobGroup>;
	requiredConclusions: string[];
	rerunPolicy: "latest-attempt-only";
	supersessionPolicy: "latest-run-per-workflow";
	nameCollisionPolicy: "reject";
	trustedSource: { repositoryOwnerMatches: boolean; headRepositoryMatches: boolean };
}
export interface EvidenceRun {
	id: number;
	workflowDatabaseId: number;
	attempt: number;
	runAttempt: number;
	status: string;
	conclusion: string | null;
	headSha: string;
	workflowId: string;
	workflowPath: string;
	event: string;
	headRef: string;
	repositoryOwnerMatches: boolean;
	headRepositoryMatches: boolean;
	createdAt: string;
	jobs: Array<{ name: string; status: string; conclusion: string | null }>;
}
export interface ReleaseEvidence { headSha: string; collectedAt: string; valid: boolean; invalidReason?: string; runs: EvidenceRun[] }

function isTrustedRun(policy: ReleasePolicy, run: EvidenceRun): boolean {
	const workflow = policy.trustedWorkflows.find(candidate => candidate.id === run.workflowId && candidate.path === run.workflowPath);
	return Boolean(workflow && workflow.events.includes(run.event) && workflow.refs.includes(run.headRef));
}

function requiredJobMatches(required: string | RequiredJobGroup, name: string): boolean {
	if (typeof required === "string") return name === required;
	if (required.selector.exact !== undefined && name === required.selector.exact) return true;
	if (required.selector.prefix === undefined) return false;
	// Matrix children render as `name (var1, var2)`. Require the full
	// `prefix...)` shape so suffixed lookalikes cannot satisfy the group.
	return name.startsWith(required.selector.prefix) && name.endsWith(")") && !name.slice(required.selector.prefix.length, -1).includes(")");
}

export function evaluateReleaseGate(policy: ReleasePolicy, evidence: ReleaseEvidence, expectedSha: string): string[] {
	const errors: string[] = [];
	if (evidence.headSha !== expectedSha) return [`Evidence SHA ${evidence.headSha} does not match release SHA ${expectedSha}`];
	if (evidence.valid !== true) errors.push(`Evidence freshness is invalid${evidence.invalidReason ? `: ${evidence.invalidReason}` : ""}`);
	for (const run of evidence.runs) {
		if (!Number.isFinite(run.workflowDatabaseId) || !Number.isFinite(run.runAttempt) || !run.status || !("conclusion" in run)) {
			errors.push(`Run ${run.id} is missing freshness fields`);
		} else if (run.workflowDatabaseId !== run.id || run.runAttempt !== run.attempt) {
			errors.push(`Run ${run.id} has inconsistent freshness fields`);
		}
		const sameWorkflowIdentity = policy.trustedWorkflows.some(workflow => workflow.id === run.workflowId);
		if (sameWorkflowIdentity && !isTrustedRun(policy, run)) errors.push(`Run ${run.id} conflicts with trusted workflow ${run.workflowId}`);
	}
	const trusted = evidence.runs.filter(run => isTrustedRun(policy, run));
	for (const run of trusted) {
		if (run.headSha !== expectedSha) errors.push(`Run ${run.id} has stale SHA ${run.headSha}`);
		if (policy.trustedSource.repositoryOwnerMatches && !run.repositoryOwnerMatches) errors.push(`Run ${run.id} has an untrusted repository owner`);
		if (policy.trustedSource.headRepositoryMatches && !run.headRepositoryMatches) errors.push(`Run ${run.id} has an untrusted head repository`);
		if (run.status !== "completed" || !run.conclusion || !policy.requiredConclusions.includes(run.conclusion)) errors.push(`Run ${run.id} concluded ${run.conclusion ?? run.status}`);
	}
	for (const workflow of policy.trustedWorkflows) {
		const candidates = trusted.filter(run => run.workflowId === workflow.id && run.workflowPath === workflow.path && run.headSha === expectedSha);
		if (candidates.length === 0) { errors.push(`Missing trusted workflow ${workflow.id}`); continue; }
		const latestCreated = candidates.map(run => run.createdAt).sort().at(-1);
		const latestRuns = candidates.filter(run => run.createdAt === latestCreated);
		if (latestRuns.length !== 1) { errors.push(`Ambiguous superseding runs for workflow ${workflow.id}`); continue; }
		const run = latestRuns[0];
		const maxAttempt = Math.max(...candidates.filter(candidate => candidate.id === run.id).map(candidate => candidate.attempt));
		if (run.attempt !== maxAttempt) errors.push(`Run ${run.id} is not the latest attempt`);
		const names = new Set<string>();
		for (const job of run.jobs) {
			if (names.has(job.name)) errors.push(`Job name collision: ${job.name}`);
			names.add(job.name);
		}
		for (const required of policy.requiredJobs) {
			const jobs = run.jobs.filter(job => requiredJobMatches(required, job.name));
			const label = typeof required === "string" ? required : required.group;
			const minimum = typeof required === "string" ? 1 : required.minCount;
			if (jobs.length < minimum) { errors.push(`Missing required job ${label}`); continue; }
			if (typeof required === "string" && jobs.length !== 1) { errors.push(`Job name collision: ${label}`); continue; }
			if (typeof required !== "string" && !required.allSuccess) continue;
			for (const job of jobs) {
				if (job.status !== "completed" || !job.conclusion || !policy.requiredConclusions.includes(job.conclusion)) errors.push(`Required job ${job.name} concluded ${job.conclusion ?? job.status}`);
			}
		}
	}
	return [...new Set(errors)];
}

if (import.meta.main) {
	const shaIndex = process.argv.indexOf("--sha");
	const evidenceIndex = process.argv.indexOf("--evidence");
	const policyIndex = process.argv.indexOf("--policy");
	const sha = shaIndex >= 0 ? process.argv[shaIndex + 1] : "";
	const evidencePath = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : "";
	const canonicalPolicyPath = "scripts/release-required-checks-policy.json";
	const unsafeFixturePolicy = process.argv.includes("--unsafe-fixture-policy");
	if (policyIndex >= 0 && !unsafeFixturePolicy) throw new Error("--policy is restricted to fixtures; pass --unsafe-fixture-policy for test-only evaluation");
	const policyPath = policyIndex >= 0 ? process.argv[policyIndex + 1] : canonicalPolicyPath;
	if (!sha || !evidencePath) throw new Error("Usage: release-ci-gate.ts --sha <sha> --evidence <path> [--unsafe-fixture-policy --policy <fixture>]");
	const policy = await Bun.file(policyPath).json() as ReleasePolicy;
	const evidence = await Bun.file(evidencePath).json() as ReleaseEvidence;
	const errors = evaluateReleaseGate(policy, evidence, sha);
	if (unsafeFixturePolicy) {
		// Fixture mode never emits the production success marker and never
		// exits 0, so its output cannot be mistaken for a real gate pass.
		console.error(`FIXTURE-ONLY evaluation (non-authoritative): ${errors.length ? errors.join("\n") : "no gate errors"}`);
		process.exit(2);
	}
	if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
	console.log(`Trusted release checks passed for ${sha}.`);
}
